import fs from 'node:fs';
import { visitLifecycleRuntimeSource, visitConfirmationSource } from './lib/subscriptionVisitRuntimeSource.mjs';
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
// Conservative HTTPS DNS authority, standard TLS port only; no userinfo,
// authority escapes, control bytes or backslashes. Works in Node-RED's VM.
export function isNodeRedHttpsCheckout(paymentUrl) {
  return typeof paymentUrl === 'string' && paymentUrl.length <= 4096
    && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::443)?(?:[/?#][^\s\\]*)?$/i.test(paymentUrl)
    && !Array.from(paymentUrl).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127);
}
export function patchPaidJoinGateway(source) {
  let out = patchPaidBenefitUsage(source);
  // Node-RED Function does not expose the WHATWG URL global.
  out = replace(out,
    '  let safeUrl = false;\n  try { const url = new URL(paymentUrl); safeUrl = url.protocol === "https:" && !url.username && !url.password; } catch (_) { /* fail closed */ }',
    '  const safeUrl = isNodeRedHttpsCheckout(paymentUrl);');
  out = replace(out,
    '      let safeUrl = false;\n      try {\n        if (typeof checkout?.paymentUrl === "string" && checkout.paymentUrl.trim()) {\n          const url = new URL(checkout.paymentUrl);\n          safeUrl = url.protocol === "https:" && !url.username && !url.password;\n        }\n      } catch (_) { /* hold */ }',
    '      const safeUrl = isNodeRedHttpsCheckout(checkout?.paymentUrl);');
  out = replace(out, 'if (ctx.lk1 && ctx.lk1.decision.subscriptionVisitCount === 0) {',
    'if (ctx.lk1 && (ctx.lk1.decision.subscriptionVisitCount === 0\n    || (ctx.managedAction === "JOIN_GAME" && ctx.lk1.decision.benefit.finalPriceMinor > 0))) {');
  out = replace(out, 'if (ctx.caller === "split" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {',
    'if (ctx.caller === "split" && payload.paymentType === "SUBSCRIPTION" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {');
  out = replace(out, '&& (ctx.lk1.decision.subscriptionVisitCount === 1\n',
    '&& (ctx.lk1.decision.subscriptionVisitCount === 1\n        && (ctx.managedAction !== "JOIN_GAME" || ctx.lk1.decision.benefit.finalPriceMinor === 0)\n');
  out = replace(out, ': !isSubscriptionBooking(booking)));',
    ': !isSubscriptionBooking(booking)\n          && String(booking.paymentType || booking.paymentMethod || "").trim().toUpperCase() === "ON_PLACE"));');
  out = replace(out, 'actorClientId: ctx.actorClientId, serviceDate: ctx.serviceDate,\n      "lk1.rule.productId"',
    'actorClientId: ctx.actorClientId,\n      "lk1.rule.productId"');
  out = replace(out, 'return prepareConfirmedUpdate(ctx, matches[0]);',
    'return lk1NeedsVisitJob(ctx) ? prepareVisitConfirmedUpdate(ctx, matches[0]) : prepareConfirmedUpdate(ctx, matches[0]);');
  out = replace(out, 'const lk1Checkout = (ctx) => {',
    'const lk1Checkout = (ctx) => {\n  if (lk1NeedsVisitJob(ctx) && !ctx.lk1.visitJob) return lk1Stop(ctx, "LK1_VISIT_JOB_MISSING");');
  return isNodeRedHttpsCheckout.toString() + '\n' + visitLifecycleRuntimeSource() + visitConfirmationSource() + out;
}
export function patchPaidJoinPreview(source) {
  let out = patchPaidBenefitUsage(source);
  out = replace(out, 'return {isObj,unwrapRecord,', 'return {isObj,isValidDateKey,unwrapRecord,');
  out = replace(out, 'const { isObj, normalizeId, isInactiveBooking,', 'const { isObj, isValidDateKey, normalizeId, isInactiveBooking,');
  return replace(out, "serviceDate: ctx.target.startsAt.slice(0, 10), 'lk1.rule.productId':", "'lk1.rule.productId':");
}
const targets = [
  ['lk_split_leave_daily_limit_find_build_20260811', '8d84a1b05c644180284114a92388f4671a60e0c2a7806c0c02c281dd43b272bd', () => fs.readFileSync(new URL('./nodered_games_nodes/fn_split_leave_daily_limit_find.js', import.meta.url), 'utf8')],
  ['lk_split_leave_daily_limit_route_20260811', 'ad8a0f1c49a9085ddb64ee042d13c879a75e189a2003c71024b2d0a1d422065a', () => visitLifecycleRuntimeSource() + fs.readFileSync(new URL('./nodered_games_nodes/fn_split_leave_daily_limit_route.js', import.meta.url), 'utf8')],
  ['lk_split_leave_daily_limit_ack_20260811', '7e5abe293062a71cba10795c3579760a4976f9199d0dd617c57be7d246c20e98', () => fs.readFileSync(new URL('./nodered_games_nodes/fn_split_leave_daily_limit_ack.js', import.meta.url), 'utf8')],
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
