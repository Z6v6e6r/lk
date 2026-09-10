import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const GROUP_BOOKING_ROUTER_ID = 'lk_subscription_booking_router_20260804';
export const GROUP_BOOKING_ROUTER_PREIMAGE = '9b91e7d22eae3c7447d7066269bf1395f7ceca303bc182d1d1da641b6168c2d0';
const sha = value => createHash('sha256').update(value).digest('hex');
const helpers = fs.readFileSync(new URL('./nodered_group_booking_confirmation_nodes/helpers.js', import.meta.url), 'utf8');
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Group booking confirmation anchor drift');
  return source.replace(before, after);
}
export function patchGroupBookingConfirmation(source) {
  if (sha(source) !== GROUP_BOOKING_ROUTER_PREIMAGE) throw new Error('Group booking confirmation preimage drift');
  let result = once(source, 'const prepareHttp = (ctx, step, method, url, payload, headers = {}) => {',
    helpers + '\nconst prepareHttp = (ctx, step, method, url, payload, headers = {}) => {');
  result = once(result, '  ctx.step = step;\n  msg._subscriptionBooking = ctx;\n  if (ctx.lk1 || ctx.lk1BeforeCreate',
    '  delete ctx.lk1GroupConfirmationRead;\n'
    + '  if (lk1GroupMoneyBooking(ctx) && step === "confirmation_bookings" && method === "GET"\n'
    + '    && url === `${VIVA_API_BASE}/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`\n'
    + '    && headers.Authorization === ctx.authHeader) {\n'
    + '    ctx.lk1GroupConfirmationRead = { url, actorClientId: ctx.actorClientId,\n'
    + '      operationId: ctx.operationId, operationKey: ctx.operationKey, authHeader: ctx.authHeader };\n'
    + '  }\n  ctx.step = step;\n  msg._subscriptionBooking = ctx;\n  if (ctx.lk1 || ctx.lk1BeforeCreate');
  result = once(result, 'const adminVersion = ctx.caller === "split" ? "v1" : "v2";',
    'const adminVersion = ctx.caller === "split" || (lk1GroupMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";');
  result = once(result, 'if (ctx.step === "confirmation_bookings") {\nif (ctx.lk1) {',
    'if (ctx.step === "confirmation_bookings") {\nif (ctx.lk1) {\n'
    + '    const groupMoney = lk1GroupMoneyBooking(ctx);\n'
    + '    if (groupMoney && !lk1GroupSelfReadback(ctx)) return lk1Stop(ctx, "LK1_BOOKING_READBACK_UNVERIFIED");');
  result = once(result, '      && normalizeId(bookingClientId(booking)) === normalizeId(ctx.actorClientId)\n      && (ctx.lk1.decision.subscriptionVisitCount === 1',
    '      && (groupMoney ? lk1GroupOwnerMatches(booking, ctx.actorClientId)\n'
    + '        : normalizeId(bookingClientId(booking)) === normalizeId(ctx.actorClientId))\n'
    + '      && (!groupMoney || lk1GroupUnpaidOnPlace(booking))\n      && (ctx.lk1.decision.subscriptionVisitCount === 1');
  return result;
}
export function composeGroupBookingConfirmationArtifacts(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(flow) || new Set(flow.map(row => row?.id)).size !== flow.length) throw new Error('Invalid group booking source');
  const candidate = structuredClone(flow);
  const router = candidate.find(row => row.id === GROUP_BOOKING_ROUTER_ID);
  if (router?.type !== 'function') throw new Error('Missing group booking router');
  router.func = patchGroupBookingConfirmation(router.func);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: GROUP_BOOKING_ROUTER_ID, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
