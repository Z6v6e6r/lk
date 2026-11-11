import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const CANCELLED_ALLOWANCE_SOURCE_SHA256 = '9260954f988dd396c0b22f3dbe792a2b45e5244c2e07c9485cca76b555a80fc6';
export const CANCELLED_ALLOWANCE_TARGETS = Object.freeze({
  booking: { id: 'lk_subscription_booking_router_20260804', outputs: 8,
    sha256: 'bca5774dc55b6a0d4eb271496a0c14b8b5aea2c80d7c1f94a67eb3771f3bbd89' },
  preview: { id: 'lk_subscription_price_preview_20260908_router', outputs: 6,
    sha256: 'cceb3193dad3f762225966282f8dcbdbb2607c146342ca994471af7accef34cf' },
});
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(new URL(`./nodered_lk1_hub_nodes/${name}.js`, import.meta.url), 'utf8');
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Cancelled allowance anchor drift');
  return source.replace(before, () => after);
}
export function patchCancelledAllowanceUsage(source) {
  const start = source.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const policyEnd = source.indexOf('if (ctx.step === "lk1_policy_decision") {', start);
  const end = policyEnd >= 0 ? policyEnd : source.indexOf('\n\n  };\n// Dedicated advisory graph.', start);
  if (start < 0 || end < 0) throw new Error('Cancelled allowance usage boundaries missing');
  let usage = source.slice(start, end);
  usage = replaceOnce(usage, '  let used = 0;', read('cancelled_allowance') + '\n  let used = 0;');
  usage = replaceOnce(usage, '    // AUDIT_BINDING_END',
    '    // AUDIT_BINDING_END\n    if (lk1CancelledZeroVisitOperation(operation)) continue;');
  usage = replaceOnce(usage, '  delete ctx.lk1.bookings;',
    '  delete ctx.lk1.cancellationSnapshot;\n  delete ctx.lk1.bookings;');
  return source.slice(0, start) + usage + source.slice(end);
}
export function patchCancelledAllowanceBooking(source) {
  let out = patchCancelledAllowanceUsage(source);
  out = replaceOnce(out, '    ctx.lk1.bookings = bookings;',
    '    ctx.lk1.cancellationSnapshot = { observedAt: ctx.bookingsObservedAt,\n'
    + '      active: extractItems(activeBookingsPayload), history: extractItems(msg.payload) };\n'
    + '    ctx.lk1.bookings = bookings;');
  out = replaceOnce(out, 'if (ctx.step === "lk1_ingress_operation_find") {',
    read('cancelled_successor') + '\nif (ctx.step === "lk1_ingress_operation_find") {');
  out = replaceOnce(out, '  if (!operation && msg.payload.length === 0) {',
    '  if (!operation && msg.payload.length === 0) {\n'
    + '    const httpPreviousId = lk1HttpRejoinPrevious(ctx.operationId);\n'
    + '    if (httpPreviousId && lk1HttpRejoinRequest(ctx)) return lk1Find(ctx, "lk1_http_rejoin_predecessor_find", {\n'
    + '      _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, httpPreviousId])}` });');
  const anchor = '    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {';
  out = replaceOnce(out, anchor,
    '    if (operation.state === "RELEASED" && lk1HttpRejoinRequest(ctx)) {\n'
    + '      if (!lk1SafeCancelledUnpaidSuccessor(operation)) return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");\n'
    + '      const identity = lk1HttpRejoinIdentity(ctx.operationId);\n'
    + '      return finishError(ctx, 409, "Предыдущая запись отменена. Обновите варианты и запишитесь снова.", {\n'
    + '        code: "SUBSCRIPTION_BOOKING_RELEASED", operationId: ctx.operationId,\n'
    + '        nextOperationId: `${identity.base}:rejoin:${identity.generation + 1}` });\n'
    + '    }\n' + anchor);
  return out;
}
export function patchCancelledAllowancePreview(source) {
  let out = patchCancelledAllowanceUsage(source);
  out = replaceOnce(out, '    ctx.activePayload = msg.payload;',
    '    ctx.activePayload = msg.payload;\n    ctx.activeObservedAt = new Date().toISOString();');
  out = replaceOnce(out, '  ctx.bookings = canonical.mergeBookings(ctx.activePayload, msg.payload);',
    '  ctx.cancellationSnapshot = { observedAt: ctx.activeObservedAt,\n'
    + '    active: canonical.extractItems(ctx.activePayload), history: canonical.extractItems(msg.payload) };\n'
    + '  ctx.bookings = canonical.mergeBookings(ctx.activePayload, msg.payload);');
  out = replaceOnce(out, 'lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,',
    'lk1: { rule: configured.rule, bookings: ctx.bookings, activeBookings: ctx.activeBookings,\n'
    + '      cancellationSnapshot: ctx.cancellationSnapshot,');
  return out;
}
export function composeCancelledAllowanceArtifacts(liveBytes, options = {}) {
  if (hash(liveBytes) !== (options.expectedSourceSha256 ?? CANCELLED_ALLOWANCE_SOURCE_SHA256)) throw new Error('Cancelled allowance whole-flow preimage drift');
  const flow = JSON.parse(liveBytes), targets = options.targets ?? CANCELLED_ALLOWANCE_TARGETS;
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw new Error('Invalid flow identity');
  for (const [kind, target] of Object.entries(targets)) {
    const node = flow.find(n => n.id === target.id);
    if (node?.type !== 'function' || node.d === true || node.disabled === true || node.outputs !== target.outputs
      || node.wires?.length !== node.outputs || hash(node.func) !== target.sha256) throw new Error('Cancelled allowance node preimage drift');
    node.func = kind === 'booking' ? patchCancelledAllowanceBooking(node.func) : patchCancelledAllowancePreview(node.func);
    new Function('msg', 'node', 'global', 'env', 'flow', node.func);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'cancelled-day-allowance',
    allowedChanges: Object.values(targets).map(t => ({ id: t.id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, sourceSha256: hash(liveBytes), candidateSha256: hash(candidateBytes),
    gatewaySha256: hash(flow.find(n => n.id === targets.booking.id).func), changedNodeCount: 2, addedNodeCount: 0 };
}
async function main() {
  const [workspace, output, contractPath] = process.argv.slice(2);
  if (!workspace || !output || !contractPath || process.argv.length !== 5) throw new Error('Usage: WORKSPACE NEW_PRIVATE_CANDIDATE NEW_PRIVATE_CONTRACT');
  const { verifyWorkspace } = await import('./verify_nodered_source_origin.mjs');
  const verified = verifyWorkspace(workspace, { quiet: true });
  for (const file of [output, contractPath]) {
    const parent = path.dirname(file);
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.existsSync(file)
      || fs.realpathSync(parent) !== parent || (fs.statSync(parent).mode & 0o777) !== 0o700
      || file.startsWith(`${fs.realpathSync(new URL('..', import.meta.url))}/`)
      || file.startsWith(`${verified.workspace}/`)) throw new Error('New private external output required');
  }
  if (output === contractPath) throw new Error('Distinct outputs required');
  const built = composeCancelledAllowanceArtifacts(fs.readFileSync(verified.sourcePath));
  fs.writeFileSync(output, built.candidateBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(contractPath, `${JSON.stringify(built.contract, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    gatewaySha256: built.gatewaySha256, changedNodeCount: 2, addedNodeCount: 0 }));
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch(error => {
  console.error(error.message); process.exitCode = 1;
});
