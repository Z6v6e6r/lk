import fs from 'node:fs';
import crypto from 'node:crypto';
import { isNodeRedHttpsCheckout } from './patch_nodered_subscription_paid_join.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const REJOIN_GATEWAY_ID = 'lk_subscription_booking_router_20260804';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const oldIngressHashes = new Set([
  '247c8cb5a6dfcda80b232c79024329c33be15e2ef9336c6a526ab2747e922eb5',
  // Installed expired-pending recovery is retained byte for byte.
  'f35da0f5234934d9f7b865cf04375b842c6cfd756b3ac37c1fec8f347f50953c',
]);
const start = 'if (ctx.step === "lk1_ingress_operation_find")';
const end = 'if (ctx.step === "lk1_money_owned_subscriptions")';
function section(source, from, to) {
  if (source.split(from).length !== 2 || source.split(to).length !== 2) throw new Error('Rejoin source anchor drift');
  const begin = source.indexOf(from);
  const finish = source.indexOf(to);
  if (finish <= begin) throw new Error('Rejoin section order drift');
  return source.slice(begin, finish);
}
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Rejoin source anchor drift');
  return source.replace(before, after);
}
export function patchSubscriptionRejoinGateway(source) {
  const oldIngress = section(source, start, end);
  if (!oldIngressHashes.has(sha(oldIngress)) || source.includes('// REJOIN_HELPERS_START')) {
    throw new Error('Rejoin ingress preimage drift');
  }
  const snippet = fs.readFileSync(new URL('./nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const helpers = section(snippet, '// REJOIN_HELPERS_START', '// REJOIN_HELPERS_END');
  const freshBranch = section(snippet, '    const previousId = lk1RejoinPreviousId(ctx.operationId);', '    delete ctx.lk1IngressReplay;');
  const releasedBranch = section(snippet, '    if (operation.state === "RELEASED" && ctx.caller', '    if (operation.state !== "CONFIRMED"');
  const predecessorStep = section(snippet, 'if (ctx.step === "lk1_rejoin_predecessor_find")', end);
  let out = replaceOnce(source, '  if (!operation && msg.payload.length === 0) {',
    '  if (!operation && msg.payload.length === 0) {\n' + freshBranch.trimEnd());
  // Insert after identity validation, ahead of the existing recovery branch.
  const replayBoundary = source.includes('    if (lk1ExpiredUnboundClaim(operation, Date.now())) {')
    ? '    if (lk1ExpiredUnboundClaim(operation, Date.now())) {'
    : '    if (operation.state !== "CONFIRMED" || typeof operation.bookingId !== "string" || !operation.bookingId.trim()';
  out = replaceOnce(out, replayBoundary, releasedBranch + replayBoundary);
  out = replaceOnce(out, end, predecessorStep + end);
  out = replaceOnce(out, 'const lk1Checkout = (ctx) => {', `${helpers}// REJOIN_HELPERS_END\n\nconst lk1Checkout = (ctx) => {`);
  out = replaceOnce(out, 'delete ctx.lk1IngressReplay;\nconst split = msg._splitCtx;',
    'delete ctx.lk1IngressReplay;\ndelete ctx.lk1Rejoin;\nconst split = msg._splitCtx;');
  out = replaceOnce(out, '    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),',
    '    state: "PREPARED", attempts: 0, lk1: JSON.parse(JSON.stringify(ctx.lk1)),\n'
    + '    ...(ctx.lk1Rejoin ? { rejoinPredecessor: ctx.lk1Rejoin } : {}),');
  out = replaceOnce(out,
    '  msg.payload = [query, update, ctx.lk1 ? { writeConcern: { w: "majority", j: true } } : {}];',
    '  msg.payload = [lk1FenceOperationUpdate(ctx, step, query), update, ctx.lk1 ? { writeConcern: { w: "majority", j: true } } : {}];');
  if (out.includes('new URL(paymentUrl)')) {
    out = replaceOnce(out,
      '  let safeUrl = false;\n  try { const url = new URL(paymentUrl); safeUrl = url.protocol === "https:" && !url.username && !url.password; } catch (_) { /* fail closed */ }',
      '  const safeUrl = isNodeRedHttpsCheckout(paymentUrl);');
    out = replaceOnce(out,
      '      let safeUrl = false;\n      try {\n        if (typeof checkout?.paymentUrl === "string" && checkout.paymentUrl.trim()) {\n          const url = new URL(checkout.paymentUrl);\n          safeUrl = url.protocol === "https:" && !url.username && !url.password;\n        }\n      } catch (_) { /* hold */ }',
      '      const safeUrl = isNodeRedHttpsCheckout(checkout?.paymentUrl);');
    out = isNodeRedHttpsCheckout.toString() + '\n' + out;
  }
  new Function('msg', 'node', 'global', 'env', out);
  return out;
}

// Local composition only; preserves every other node and every non-body field.
export function composeSubscriptionRejoinArtifacts(liveBytes, deploymentId) {
  const source = JSON.parse(Buffer.from(liveBytes).toString());
  if (!Array.isArray(source) || new Set(source.map(node => node.id)).size !== source.length) throw new Error('Invalid flow identity');
  const candidate = structuredClone(source);
  const gateway = candidate.find(node => node.id === REJOIN_GATEWAY_ID);
  if (gateway?.type !== 'function' || typeof gateway.func !== 'string') throw new Error('Missing subscription gateway');
  gateway.func = patchSubscriptionRejoinGateway(gateway.func);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({
    liveBytes: Buffer.from(liveBytes), candidateBytes, deploymentId,
    allowedChanges: [{ id: REJOIN_GATEWAY_ID, fields: ['func'] }],
  });
  validateReviewedFlowContract({ liveBytes: Buffer.from(liveBytes), candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
