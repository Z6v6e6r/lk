// Offline only: two function bodies, preserving every other node/field/order.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
export const legacySha = value => crypto.createHash('sha256').update(value).digest('hex');
export const LEGACY_IDS = ['lk_subscription_booking_router_20260804', 'lk_subscription_booking_finalize_20260804'];
export const LEGACY_PINS = ['8d87efe8dc5c2f5a854c6d5e77d1fb11d4352e082e9d42733d0ea95c72441d85',
  '72817815b42fce78746f3b2b3067ae999f3930ad8ad61b4e06e1aae8cf115df0'];
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw Error('LEGACY_CANCELLATION_ANCHOR_DRIFT');
  return source.replace(before, () => after);
};
export function legacyRouterEdits() {
  const module = read('./lib/lk1LegacyCancellation.mjs').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  const helper = read('./nodered_lk1_hub_nodes/legacy_cancelled_visit.js');
  return [
    ['const lk1DailyVisitKey =', module + '\n' + helper + '\nconst lk1DailyVisitKey ='],
    ['  const released = (returnedNative || existingGameLeave)',
      '  const returnedLegacy = lk1LegacyVerified(ctx, owner);\n  const released = (returnedNative || returnedLegacy || existingGameLeave)'],
    ['  return finishError(ctx, 409, "Дневное посещение уже занято. Обновите стоимость записи.", {',
      '  ctx.lk1DailyVisitRefusal = JSON.stringify([ctx.operationKey, ctx.operationId, ctx.actorClientId, ctx.clientSubscriptionId, ctx.exerciseId, ctx.lk1.fingerprint]);\n  return finishError(ctx, 409, "Дневное посещение уже занято. Обновите стоимость записи.", {'],
    ['&& typeof lk1FreeReturnedOperation === \"function\" && lk1FreeReturnedOperation(operation)\n    && (!previous',
      '&& typeof lk1FreeReturnedOperation === \"function\" && (lk1FreeReturnedOperation(operation) || lk1LegacyVerified(ctx, operation))\n    && (!previous'],
    ['previous.lk1.cancelledAllowanceRelease?.proofId || previous.lk1.freeCancellationReturn?.jobKey,',
      'previous.lk1.cancelledAllowanceRelease?.proofId || previous.lk1.freeCancellationReturn?.jobKey\n      || (lk1LegacyVerified(ctx, previous) ? `legacy-readback:${previous.operationId}` : null),'],
  ];
}
export function legacyFinalizerEdits() {
  return [['if (ctx?.lk1IngressReplay === true) {',
    read('./nodered_lk1_hub_nodes/daily_visit_refusal.js') + '\nif (ctx?.lk1IngressReplay === true) {']];
}
export const applyLegacyEdits = (source, edits) => edits.reduce((s, [a, b]) => replace(s, a, b), source);
export function composeLegacyCancellationRecovery(liveBytes, options) {
  if (!/^[a-f0-9]{64}$/.test(options?.expectedSourceSha256 || '')
    || legacySha(liveBytes) !== options.expectedSourceSha256) throw Error('LEGACY_CANCELLATION_SOURCE_DRIFT');
  const source = JSON.parse(liveBytes);
  if (!Array.isArray(source) || new Set(source.map(n => n.id)).size !== source.length) throw Error('LEGACY_CANCELLATION_GRAPH_INVALID');
  const candidate = structuredClone(source), edits = [legacyRouterEdits(), legacyFinalizerEdits()];
  const pins = options.pins || LEGACY_PINS;
  for (let i = 0; i < LEGACY_IDS.length; i++) {
    const n = candidate.find(n => n.id === LEGACY_IDS[i]);
    const tab = candidate.find(t => t.id === n?.z);
    if (n?.type !== 'function' || n.d || n.disabled || tab?.type !== 'tab' || tab.disabled
      || n.outputs !== (i === 0 ? 8 : 2) || legacySha(n.func) !== pins[i]) throw Error('LEGACY_CANCELLATION_NODE_DRIFT');
    n.func = applyLegacyEdits(n.func, edits[i]);
    new Function('msg', 'node', 'global', 'env', 'flow', n.func);
    const inverse = edits[i].slice().reverse().map(([a, b]) => [b, a]);
    if (applyLegacyEdits(n.func, inverse) !== source.find(x => x.id === n.id).func) throw Error('LEGACY_CANCELLATION_INVERSE_INVALID');
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'legacy-cancellation-recovery',
    allowedChanges: LEGACY_IDS.map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, changedNodes: LEGACY_IDS, candidateSha256: legacySha(candidateBytes) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const verified = verifyWorkspace(process.argv[2], { quiet: true });
    const built = composeLegacyCancellationRecovery(fs.readFileSync(verified.sourcePath), { expectedSourceSha256: process.argv[3] });
    fs.writeFileSync(path.join(verified.workspace, 'legacy-cancellation-candidate.json'), built.candidateBytes, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(verified.workspace, 'legacy-cancellation-contract.json'), JSON.stringify(built.contract, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ changedNodes: built.changedNodes, candidateSha256: built.candidateSha256, deploymentPerformed: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
