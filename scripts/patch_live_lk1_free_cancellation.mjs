import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const deltas = JSON.parse(fs.readFileSync(new URL('./lib/lk1FreeCancellationSourceDeltas.json', import.meta.url)));
const seatDeltas = JSON.parse(fs.readFileSync(new URL('./lib/cancellationSyncGatewayDeltas.json', import.meta.url)));
const restoreSeatSource = (source, file) => [...(seatDeltas[file] || [])].reverse().reduce((s, [before, after]) =>
  s.split(after).length === 2 ? s.replace(after, () => before) : s, source);
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
export const FREE_CANCEL_SOURCE = '3ecdd6693008e25d9965a3cc2efa7f960bd794194ad3966774fbe422f5544624';
export const FREE_CANCEL_TARGETS = {
  router: { id: 'lk_subscription_booking_router_20260804', outputs: 8, sha256: 'f42593bd94867ea4db8a84c84f07752bd45af9e6231924d381d7b2e12c8617e2' },
  prepare: { id: 'lk_subscription_booking_prepare_20260804', outputs: 2, sha256: 'b1484bf25b4e962cad20b795d0734773ad25692b3883d1a120637f6a4697b295' },
  finalize: { id: 'lk_subscription_booking_finalize_20260804', outputs: 2, sha256: 'ec13fb66eadd2488947bb71cdba05cce98250b374d359cc74bf1083f1531b322' },
};
export const FREE_CANCEL_FINALIZE = `if (ctx?.step === "lk1_free_cancel_booking_gate" && responseStatus === 409
  && payload.details?.code === "LK1_FREE_CANCEL_RETURN_PENDING") return [null, msg];
`;
export function freeReplace(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Free cancellation source anchor drift');
  return source.replace(before, () => after);
}
export function restorePreFreeCancellationSource(source, relative) {
  source = restoreSeatSource(source, `scripts/${relative}`);
  const list = deltas[`scripts/${relative}`] || [];
  return [...list].reverse().reduce((value, [before, after]) => {
    return value.split(after).length === 2 ? value.replace(after, () => before) : value;
  }, source);
}
export function historicalCancelledSuccessorSource(source) {
  source = restoreSeatSource(source, 'scripts/nodered_lk1_hub_nodes/cancelled_successor.js');
  const [before, after] = deltas['scripts/nodered_lk1_hub_nodes/gateway.js'][1];
  return source === after ? before : source;
}
export function applyFreeCancellationOwnedSource(source, file) {
  for (const [before, after] of deltas[file] || []) source = freeReplace(source, before, after);
  return source;
}
// Dispatch must follow every daily-visit helper initializer it may call.
export function moveFreeCancellationStepsAfterDailyHelpers(source) {
  const steps = read('./nodered_lk1_hub_nodes/free_cancel.js').split('// FREE_CANCEL_STEPS\n')[1].trim();
  const anchor = 'if (ctx.step === "lk1_daily_visit_claim") {';
  let out = freeReplace(source, steps, '');
  if (out.indexOf('const lk1DailyVisitReject =') < 0
    || out.indexOf('const lk1DailyVisitReject =') > out.indexOf(anchor)) {
    throw Error('Free cancellation daily helper order drift');
  }
  return freeReplace(out, anchor, steps + '\n\n' + anchor);
}
export function patchFreeCancellationRouter(source) {
  let out = source;
  const [helpers, steps] = read('./nodered_lk1_hub_nodes/free_cancel.js').split('// FREE_CANCEL_STEPS\n');
  const protocol = read('./lib/lk1FreeCancellation.mjs').replace(/^export /gm, '');
  out = freeReplace(out, 'const ctx = isObj(msg._subscriptionBooking)', protocol + '\n' + helpers + '\nconst ctx = isObj(msg._subscriptionBooking)');
  out = freeReplace(out, 'const LK1_EXPIRED_PENDING_RECONCILE =', steps + '\nconst LK1_EXPIRED_PENDING_RECONCILE =');
  for (const [file, entries] of Object.entries(deltas)) {
    if (!['scripts/nodered_lk1_hub_nodes/gateway.js', 'scripts/nodered_lk1_hub_nodes/gateway_hooks.js',
      'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
      'scripts/nodered_lk1_hub_nodes/daily_visit_guard.js'].includes(file)) continue;
    for (const [index, [before, after]] of entries.entries()) {
      if (file.endsWith('/gateway.js') && index === 0) continue;
      if (file.endsWith('/gateway_hooks.js') && index === 1) continue;
      out = freeReplace(out, before, after);
    }
  }
  out = freeReplace(out, 'if (ctx.step === "lk1_profile_continue") {',
    'if (ctx.step === "lk1_profile_continue") {\n  if (ctx.action === "cancel-free") return lk1FreeStart(ctx);');
  return moveFreeCancellationStepsAfterDailyHelpers(out);
}
export function composeFreeCancellation(liveBytes, options = {}) {
  if (hash(liveBytes) !== (options.sourceSha ?? FREE_CANCEL_SOURCE)) throw Error('Free cancellation whole-flow drift');
  const flow = JSON.parse(liveBytes), targets = options.targets ?? FREE_CANCEL_TARGETS;
  if (!Array.isArray(flow) || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('Flow identity invalid');
  for (const [kind, t] of Object.entries(targets)) {
    const n = flow.find(n => n.id === t.id);
    if (n?.type !== 'function' || n.outputs !== t.outputs || n.d || n.disabled || hash(n.func) !== t.sha256) throw Error('Free cancellation node preimage drift');
    if (kind === 'router') n.func = patchFreeCancellationRouter(n.func);
    else if (kind === 'prepare') for (const [before, after] of deltas['scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js']) n.func = freeReplace(n.func, before, after);
    else if (kind === 'finalize') n.func = freeReplace(n.func,
      'if (ctx?.lk1IngressReplay === true) {', FREE_CANCEL_FINALIZE + 'if (ctx?.lk1IngressReplay === true) {');
    new Function('msg', 'node', 'global', 'env', 'flow', n.func);
  }
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'free-visit-cancellation',
    allowedChanges: Object.values(targets).map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, candidateSha256: hash(candidateBytes),
    gatewaySha256: hash(flow.find(n => n.id === targets.router.id).func) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const [workspace, output, contractPath] = process.argv.slice(2);
    const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
    const verified = verifyWorkspace(workspace, { quiet: true });
    for (const name of [output, contractPath]) {
      if (!name || !path.isAbsolute(name) || path.resolve(name) !== name || fs.existsSync(name)
        || fs.realpathSync(path.dirname(name)) !== path.dirname(name)
        || (fs.statSync(path.dirname(name)).mode & 0o777) !== 0o700
        || name.startsWith(`${verified.workspace}/`) || name.startsWith(fs.realpathSync(new URL('..', import.meta.url)) + '/')) throw Error('Private external new output required');
    }
    if (output === contractPath) throw Error('Distinct outputs required');
    const built = composeFreeCancellation(fs.readFileSync(verified.sourcePath));
    fs.writeFileSync(output, built.candidateBytes, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(contractPath, JSON.stringify(built.contract, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ candidateSha256: built.candidateSha256, gatewaySha256: built.gatewaySha256 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
