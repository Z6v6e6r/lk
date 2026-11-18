// Preparation only: preserve the historical canonical router and patch exactly
// two installed function bodies. No imports, deployments or provider writes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const CAPACITY_SOURCE_SHA256 = 'f3779b5fd0660d41a899aa33d07145506438e1780aeb4a0d3b5fa42b2d31ce22';
export const CAPACITY_TARGETS = Object.freeze({
  router: { id: 'lk_subscription_booking_router_20260804', outputs: 8,
    sha256: '9b5f519fa349e7f8aa4e2ea651e458108da11a18f5e4225a2f4296db528b2a4e' },
  finalizer: { id: 'lk_subscription_booking_finalize_20260804', outputs: 2,
    sha256: 'a29b461f4538676c8ce147de456388355c3649e604f2d5b1a623d0f62adaf1d7' },
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function readCapacitySnippets() {
  const source = fs.readFileSync(new URL('./nodered_lk1_hub_nodes/capacity_refusal.txt', import.meta.url), 'utf8');
  return Object.fromEntries([...source.matchAll(/\/\/ CAPACITY_([A-Z]+)\n([\s\S]*?)(?=\n\/\/ CAPACITY_|$)/g)]
    .map(([, name, body]) => [name, `${body.trimEnd()}\n`]));
}
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Capacity anchor missing or repeated: ${before.split('\n')[0]}`);
  return source.replace(before, after);
}
export function patchTournamentCapacityRouter(source, snippets = readCapacitySnippets()) {
  if (source.includes('const lk1CapacityBinding =')) throw new Error('Capacity router already patched');
  let out = replaceOnce(source, 'const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {',
    `${snippets.HELPERS}\nconst prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {`);
  const query = '  return prepareMongoUpdate(ctx, "operation_fail", {\n    _id: ctx.operationKey,\n    operationId: ctx.operationId,\n';
  out = replaceOnce(out, query, query + snippets.QUERY);
  const create = 'if (ctx.step === "booking_create") {\n';
  out = replaceOnce(out, create, `${create}  delete ctx.lk1CapacityRefusal;\n`);
  const refusal = '      return prepareFailedUpdate(\n        ctx,\n        statusCode,\n        rawMessage || "Viva отклонила создание записи",\n        toStr(msg.payload?.code),\n      );';
  out = replaceOnce(out, refusal, snippets.BOOKING + refusal);
  const failure = 'if (ctx.step === "operation_fail") {\n';
  out = replaceOnce(out, failure, failure + snippets.FAILURE);
  new Function('msg', 'global', 'node', 'flow', 'env', out);
  return out;
}
export function patchTournamentCapacityFinalizer(source, snippets = readCapacitySnippets()) {
  if (source.includes('const capacity = ctx.lk1CapacityRefusal;')) throw new Error('Capacity finalizer already patched');
  const anchor = 'if (ctx?.lk1) {\n';
  const out = replaceOnce(source, anchor, anchor + snippets.FINALIZE);
  new Function('msg', 'global', out);
  return out;
}
export function composeTournamentCapacityArtifacts(liveBytes, options = {}) {
  const expected = options.expectedSourceSha256 ?? CAPACITY_SOURCE_SHA256;
  if (hash(liveBytes) !== expected) throw new Error('Capacity whole-flow preimage drift');
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid flow identity');
  const targets = options.targets ?? CAPACITY_TARGETS;
  const snippets = options.snippets ?? readCapacitySnippets();
  for (const [name, target] of Object.entries(targets)) {
    const node = flow.find(n => n.id === target.id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true
      || node.outputs !== target.outputs || node.wires?.length !== node.outputs
      || typeof node.func !== 'string' || hash(node.func) !== target.sha256) throw new Error(`Capacity ${name} preimage drift`);
    node.func = name === 'router' ? patchTournamentCapacityRouter(node.func, snippets)
      : patchTournamentCapacityFinalizer(node.func, snippets);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'tournament-capacity-refusal',
    allowedChanges: Object.values(targets).map(t => ({ id: t.id, fields: ['func'] })),
    allowedAdditionIds: [] });
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
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.existsSync(file)
      || fs.lstatSync(path.dirname(file)).isSymbolicLink()
      || fs.realpathSync(path.dirname(file)) !== path.dirname(file)
      || file.startsWith(`${repo}/`) || file.startsWith(`${verified.workspace}/`)
      || (fs.statSync(path.dirname(file)).mode & 0o777) !== 0o700) throw new Error('New private external output required');
  }
  if (outputs[0] === outputs[1]) throw new Error('Distinct outputs required');
  const bytes = fs.readFileSync(verified.sourcePath);
  if (hash(bytes) !== verified.sourceSha256) throw new Error('Verified source changed');
  const built = composeTournamentCapacityArtifacts(bytes);
  fs.writeFileSync(outputs[0], built.candidateBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(outputs[1], `${JSON.stringify(built.contract, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    changedNodeCount: 2, addedNodeCount: 0, deploymentPerformed: false }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
