import crypto from 'node:crypto';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const replace = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error(`Paid join source anchor drift: ${before.slice(0, 70)}`);
  return source.replace(before, after);
};
export function patchPaidBenefitUsage(source) {
  let out = replace(source, '  const coveredBookings = new Set();',
    '  const coveredBookings = new Set();\n  const benefitBookings = new Set();');
  out = replace(out, 'operation.tenantKey !== ctx.tenantKey || operation.serviceDate !== ctx.serviceDate',
    'operation.tenantKey !== ctx.tenantKey || !isValidDateKey(operation.serviceDate)');
  out = replace(out, '    if (["FAILED", "RELEASED"].includes(operation.state)) continue;',
    '    if (["FAILED", "RELEASED"].includes(operation.state)) continue;\n'
    + '    if (operation.bookingId) benefitBookings.add(normalizeId(operation.bookingId));\n'
    + '    if (operation.serviceDate !== ctx.serviceDate) continue;');
  return replace(out, '    normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId));',
    '    normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)\n'
    + '    || benefitBookings.has(normalizeId(bookingId(booking))));');
}
export function patchPaidJoinGateway(source) {
  let out = patchPaidBenefitUsage(source);
  out = replace(out, 'if (ctx.lk1 && ctx.lk1.decision.subscriptionVisitCount === 0) {',
    'if (ctx.lk1 && (ctx.lk1.decision.subscriptionVisitCount === 0\n    || (ctx.managedAction === "JOIN_GAME" && ctx.lk1.decision.benefit.finalPriceMinor > 0))) {');
  out = replace(out, 'if (ctx.caller === "split" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {',
    'if (ctx.caller === "split" && payload.paymentType === "SUBSCRIPTION" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {');
  out = replace(out, '&& (ctx.lk1.decision.subscriptionVisitCount === 1\n',
    '&& (ctx.lk1.decision.subscriptionVisitCount === 1\n        && (ctx.managedAction !== "JOIN_GAME" || ctx.lk1.decision.benefit.finalPriceMinor === 0)\n');
  out = replace(out, ': !isSubscriptionBooking(booking)));',
    ': !isSubscriptionBooking(booking)\n          && String(booking.paymentType || booking.paymentMethod || "").trim().toUpperCase() === "ON_PLACE"));');
  return replace(out, 'actorClientId: ctx.actorClientId, serviceDate: ctx.serviceDate,\n      "lk1.rule.productId"',
    'actorClientId: ctx.actorClientId,\n      "lk1.rule.productId"');
}
export function patchPaidJoinPreview(source) {
  let out = patchPaidBenefitUsage(source);
  out = replace(out, 'return {isObj,unwrapRecord,', 'return {isObj,isValidDateKey,unwrapRecord,');
  out = replace(out, 'const { isObj, normalizeId, isInactiveBooking,', 'const { isObj, isValidDateKey, normalizeId, isInactiveBooking,');
  return replace(out, "serviceDate: ctx.target.startsAt.slice(0, 10), 'lk1.rule.productId':", "'lk1.rule.productId':");
}
const targets = [
  ['lk_subscription_booking_router_20260804', '8848722f61f84e1792d2cdd69d8204be61ae66fe35c1af1d2bc7d8774f84636a', patchPaidJoinGateway],
  ['lk_subscription_price_preview_20260908_router', 'b66401e010790cb6b9a016f603f9867123920f5ef93806536f606ef622a39472', patchPaidJoinPreview],
];
// Local artifacts only. No transport, activation, operation repair or provider I/O.
export function composeSubscriptionPaidJoinArtifacts(liveBytes, deploymentId) {
  const candidate = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(candidate) || candidate.some(row => !row || typeof row.id !== 'string')
    || new Set(candidate.map(row => row.id)).size !== candidate.length) throw new Error('Invalid paid join source flow');
  for (const [id, before, transform] of targets) {
    const node = candidate.find(row => row.id === id);
    if (node?.type !== 'function' || sha(node.func || '') !== before) throw new Error(`Paid join preimage drift: ${id}`);
    node.func = transform(node.func);
    new Function('msg', 'node', 'env', 'global', node.func);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: targets.map(([id]) => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
