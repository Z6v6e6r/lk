// Preparation only. Preserve the installed owner, historical pins and every graph edge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertHubOutputPath } from './patch_live_lk1_hub.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const FRIENDSHIP_SPECIAL_SOURCE_SHA256 = '3d454ddace61985d4a1d6d92790fcfd25aa7ac8f26911c145c50bd83394e8383';
export const FRIENDSHIP_SPECIAL_TARGETS = Object.freeze({
  gateway: { id: 'lk_subscription_booking_router_20260804', outputs: 8,
    sha256: '933afa01e4fdf075bd5234e5db4b45b6cfae664ab953df2c30a681b7ce156e3c' },
  preview: { id: 'lk_subscription_price_preview_20260908_router', outputs: 6,
    sha256: 'dc6be3085e41e86ad675c221c51ba3b8a1373062cb4a5f75adf5948ce73c9b95' },
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Friendship special anchor drift');
  return source.replace(before, () => after);
}
export function patchFriendshipSpecialCoverage(source) {
  return replaceOnce(source,
    '"6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze([5278]),',
    '"6b98e7e3-5bd3-4e94-9dc3-7723ea52513e": Object.freeze([5278, 5280]),');
}
// Exact installed residency handler, prior to per-instance failure isolation.
const OLD_RESIDENCY_HELPERS = `const residencyPreviewTarget = exercise => ({resolutionSource:'SERVER',category:eventRoute?eventCategory:'GAME',
  stationId:ctx.target.stationId,externalEventTypeId:canonical.managedExternalEventTypeId(exercise),
  startsAt:new Date(ctx.target.startsAt).toISOString(),durationMinutes:ctx.target.durationMinutes});
if (ctx.step==='residency_context') {
  const pending=ctx.residencyPending;
  const config=residencyTransportConfig(key=>residencySetting(key,k=>global.get(k),k=>typeof env!=='undefined'?env.get(k):undefined),'preview');
  if (!config || !pending || msg.error || msg.statusCode!==200 || msg.method!=='POST'
    || msg.url!==config.url || msg.responseUrl!==config.url) return stop('RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE');
  try {validateResidencyBookingContext(msg.payload,pending.id,Date.now(),pending.target,pending.action);}
  catch {return stop('RESIDENCY_BOOKING_CONTEXT_INVALID');}
  ctx.residencyContexts=ctx.residencyContexts || {};
  ctx.residencyContexts[pending.id]=msg.payload;
  ctx.pending.unshift(pending.id);
  delete ctx.residencyPending;
  ctx.step='next';
}
`;
export function patchInstalledResidencyPreview(source) {
  const [helpers, branch] = fs.readFileSync(new URL('./nodered_residency_booking_nodes/preview.js', import.meta.url), 'utf8')
    .split('// RESIDENCY_PREVIEW_BRANCH');
  if (!helpers || !branch) throw new Error('Residency preview source invalid');
  let out = replaceOnce(source, OLD_RESIDENCY_HELPERS, '');
  const errorGuard = "if (msg.error) return stop('PRICE_PREVIEW_READ_FAILED');";
  out = replaceOnce(out, errorGuard, helpers + '\n' + errorGuard);
  // Use the same owned-instance branch as fresh source composition.
  const branchStart = "if (productId.toLowerCase()===RESIDENCY_PRODUCT_ID) {";
  const branchEnd = "  if (!eventRoute && ['availableStudios', 'availableTypes', 'availableDirections'].some";
  const start = out.indexOf(branchStart), end = out.indexOf(branchEnd, start);
  if (start < 0 || end < 0 || out.indexOf(branchStart, start + 1) >= 0) throw new Error('Residency preview branch drift');
  out = out.slice(0, start) + branch.trimStart() + '\n' + out.slice(end);
  new Function('msg', 'node', 'global', 'env', out);
  return out;
}
export function composeFriendshipSpecialArtifacts(liveBytes, options = {}) {
  if (hash(liveBytes) !== (options.expectedSourceSha256 ?? FRIENDSHIP_SPECIAL_SOURCE_SHA256)) throw new Error('Friendship special whole-flow preimage drift');
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid flow identity');
  const targets = options.targets ?? FRIENDSHIP_SPECIAL_TARGETS;
  for (const [kind, target] of Object.entries(targets)) {
    const node = flow.find(n => n.id === target.id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true || node.outputs !== target.outputs
      || node.wires?.length !== node.outputs || hash(node.func) !== target.sha256) throw new Error('Friendship special node preimage drift');
    node.func = patchFriendshipSpecialCoverage(node.func);
    if (kind === 'preview') node.func = patchInstalledResidencyPreview(node.func);
    new Function('msg', 'node', 'global', 'env', 'flow', node.func);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'friendship-special-residency-preview',
    allowedChanges: Object.values(targets).map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, sourceSha256: hash(liveBytes), candidateSha256: hash(candidateBytes),
    nodeCount: flow.length, changedNodeCount: 2, addedNodeCount: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--workspace' || args[2] !== '--output' || args[4] !== '--contract') {
    throw new Error('Usage: --workspace ABS_PRIVATE_LIVE_WORKSPACE --output ABS_NEW_CANDIDATE --contract ABS_NEW_CONTRACT');
  }
  const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
  const verified = verifyWorkspace(args[1], { quiet: true });
  const outputs = [args[3], args[5]];
  const repo = fs.realpathSync(new URL('..', import.meta.url));
  for (const file of outputs) {
    assertHubOutputPath(file);
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.existsSync(file)
      || fs.lstatSync(path.dirname(file)).isSymbolicLink()
      || fs.realpathSync(path.dirname(file)) !== path.dirname(file)
      || file.startsWith(`${repo}/`) || file.startsWith(`${verified.workspace}/`)
      || (fs.statSync(path.dirname(file)).mode & 0o777) !== 0o700) throw new Error('New private external output required');
  }
  if (outputs[0] === outputs[1]) throw new Error('Distinct outputs required');
  const bytes = fs.readFileSync(verified.sourcePath);
  if (hash(bytes) !== verified.sourceSha256) throw new Error('Verified source changed');
  const built = composeFriendshipSpecialArtifacts(bytes);
  fs.writeFileSync(outputs[0], built.candidateBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(outputs[1], `${JSON.stringify(built.contract, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    changedNodeCount: 2, addedNodeCount: 0, deploymentPerformed: false }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
