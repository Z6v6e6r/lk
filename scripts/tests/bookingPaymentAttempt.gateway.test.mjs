import test from 'node:test';
import assert from 'node:assert/strict';
import { hubGatewaySource } from '../lib/eventPaymentSources.mjs';
import { paymentAttemptBinding } from '../lib/bookingPaymentAttempt.mjs';

const source = hubGatewaySource();
const prefix = `
const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
const managedActionForTarget=c=>c.managedAction;
const OUTPUT_FINAL=4,OUTPUT_MONGO_FIND=1,OUTPUT_MONGO_INSERT=2;
const emit=output=>({output,msg});
const finishPending=(ctx,message,details)=>{msg.statusCode=202;msg.payload={message,details};return emit(4);};
const finishError=(ctx,status,message,details)=>{msg.statusCode=status;msg.payload={message,details};return emit(4);};
const finishConfirmed=(ctx,id)=>{msg.statusCode=200;msg.payload={state:'CONFIRMED',bookingId:id,exerciseId:ctx.exerciseId};};
const lk1MongoMatched=v=>v?.matchedCount||0;
const prepareMongoUpdate=(ctx,step,q,u)=>{ctx.step=step;msg.payload=[q,u];return emit(3);};
const PREPARED_LEASE_MS=30000;
const ctx=msg._subscriptionBooking;
`;
const run = new Function('msg', prefix + source + '\nreturn {fresh:ctx.step==="lk1_profile_continue",msg};');
const helpers = new Function('msg', prefix + source.split('// HUB_STEPS')[0]
  + '\nreturn {lk1Finish,lk1ClaimPaymentHead,lk1Fingerprint};');
function fixture(id = 'lk-split-join-fixture', action = 'JOIN_GAME') {
  const ctx = { caller: 'split', managedAction: action, tenantKey: 'fixture', actorClientId: 'actor',
    clientSubscriptionId: 'subscription', exerciseId: 'exercise', operationId: id,
    operationKey: `lk1-product:${JSON.stringify(['fixture', 'actor', id])}`, confirmedBookingId: 'booking',
    step: 'lk1_ingress_operation_find', lk1IngressReplay: true, category: 'open_game' };
  ctx.lk1 = { rule: { productId: 'plan' }, purchaseDate: '2099-01-01',
    target: { eventId: 'exercise', category: 'GAME', stationId: 'station', roomId: 'room', startsAt: '2099-01-01T14:00:00Z', durationMinutes: 60 },
    decision: { eligible: true, subscriptionVisitCount: 0, benefit: { finalPriceMinor: 100000 } },
    transactionAttemptedAt: '2099-01-01T12:00:00Z', transactionId: 'transaction',
    checkout: { transactionId: 'transaction', paymentUrl: 'https://pay.example.test/fixture', toPayMinor: 100000,
      lifecycleVersion: 1, createdAt: '2099-01-01T12:00:00Z', expiresAt: '2099-01-01T12:15:00Z' },
    transactionIntent: { bookingId: 'booking', actorClientId: 'actor', studioId: 'station', chargeMinor: 100000 } };
  const msg = { _subscriptionBooking: ctx };
  ctx.lk1.fingerprint = helpers(msg).lk1Fingerprint(ctx, ctx.lk1);
  return { ctx, msg };
}
class Clock extends Date { static now() { return Date.parse('2099-01-01T12:14:59Z'); } }
function finish(ctx, now = Clock.now()) {
  const msg = { _subscriptionBooking: ctx };
  new Function('msg', 'Date', prefix + source.split('// HUB_STEPS')[0] + '\nreturn lk1Finish(ctx);')(
    msg, class extends Date { static now() { return now; } });
  return msg;
}
test('gateway replays exactly the same active checkout and stops link presentation at15:00', () => {
  const { ctx } = fixture();
  const active = finish(ctx), expired = finish(ctx, Date.parse('2099-01-01T12:15:00Z'));
  assert.equal(active.payload.paymentUrl, ctx.lk1.checkout.paymentUrl);
  assert.equal(active.payload.paymentExpiresAt, '2099-01-01T12:15:00.000Z');
  assert.equal(expired.statusCode, 202); assert.equal(expired.payload.paymentUrl, null);
  assert.equal(expired.payload.paymentAttemptState, 'CLOSING');
});
test('durable closing journal blocks link even before timer; PAID receipt confirms without URL', () => {
  const { ctx } = fixture(); ctx.lk1.paymentAttempt = { phase: 'CANCEL_INTENT' };
  assert.equal(finish(ctx).payload.paymentUrl, null);
  ctx.lk1.paymentAttempt = { phase: 'PAID' };
  const paid = finish(ctx, Date.parse('2099-01-01T13:00:00Z'));
  assert.equal(paid.statusCode, 200); assert.equal(paid.payload.paid, true);
  assert.equal(paid.payload.toPayMinor, 100000); assert.equal(paid.payload.paymentUrl, null);
  assert.equal(paid.payload.paymentAttemptState, 'PAID');
});
test('durable actor-target head fences changed subscription and price from another attempt', () => {
  const { ctx, msg } = fixture(); ctx.lk1.paymentLifecycleVersion = 1;
  const lookup = helpers(msg).lk1ClaimPaymentHead(ctx);
  assert.equal(lookup.output, 1);
  const key = ctx.lk1PaymentHeadKey;
  const created = run({ _subscriptionBooking: ctx, payload: [] });
  assert.equal(created.output, 2);
  const head = created.msg.payload[0];
  assert.equal(head._id, key);
  const { ctx: other } = fixture('lk-split-join-other');
  other.clientSubscriptionId = 'other-subscription'; other.lk1.paymentLifecycleVersion = 1;
  const otherMsg = { _subscriptionBooking: other }; helpers(otherMsg).lk1ClaimPaymentHead(other);
  assert.equal(other.lk1PaymentHeadKey, key);
  const ownerRead = run({ _subscriptionBooking: other, payload: [head] });
  assert.equal(ownerRead.output, 1);
  const owner = { _id: ctx.operationKey, operationId: ctx.operationId, tenantKey: ctx.tenantKey,
    actorClientId: ctx.actorClientId, state: 'CONFIRMED', lk1: ctx.lk1 };
  const refused = run({ _subscriptionBooking: other, payload: [owner] });
  assert.equal(refused.output, 4); assert.equal(refused.msg.statusCode, 202);
  assert.equal(refused.msg.payload.details.code, 'PAYMENT_ATTEMPT_ACTIVE');
});
test('head transfer requires exact terminal owner proof and full-preimage CAS', () => {
  const { ctx: ownerCtx } = fixture();
  const owner = { ...ownerCtx, _id: ownerCtx.operationKey, bookingId: 'booking', state: 'RELEASED' };
  owner.lk1.paymentAttempt = { phase: 'CLOSED', closedAt: '2099-01-01T12:15:00Z' };
  owner.lk1.paymentAttemptRelease = { schemaVersion: 1, binding: paymentAttemptBinding(owner),
    bookingState: 'CANCELLED', transactionState: 'UNPAID_CLOSED', creditState: 'NOT_CONSUMED', creditProof: null,
    verifiedAt: owner.lk1.paymentAttempt.closedAt };
  const { ctx } = fixture('lk-split-join-next');
  const head = { _id: 'head', ownerOperationKey: owner._id, ownerOperationId: owner.operationId };
  ctx.step = 'lk1_payment_head_owner'; ctx.lk1PaymentHead = head;
  const out = run({ _subscriptionBooking: ctx, payload: [owner] });
  assert.equal(out.output, 3);
  assert.deepEqual(out.msg.payload[0].$expr.$eq[1].$literal, head);
  assert.equal(out.msg.payload[1].$set.ownerOperationKey, ctx.operationKey);
  assert.deepEqual(out.msg.payload[1].$push.history, head);
  ctx.step = 'lk1_payment_head_transferred';
  const loser = run({ _subscriptionBooking: ctx, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 } });
  assert.equal(loser.output, 4); assert.equal(loser.msg.statusCode, 202);
});

test('native head uses the ordinary actor/target key across payment modes', () => {
  const { ctx, msg } = fixture(); ctx.lk1.paymentLifecycleVersion = 1;
  ctx.tenantKey = 'iSkq6G'; helpers(msg).lk1ClaimPaymentHead(ctx);
  assert.equal(ctx.lk1PaymentHeadKey, 'booking-payment-head:' + JSON.stringify(['iSkq6G', 'actor', ['EVENT', 'exercise']]));
  ctx.managedAction = 'CREATE_GAME'; ctx.lk1.target.startsAt = '2099-01-01T17:00:00+03:00';
  helpers(msg).lk1ClaimPaymentHead(ctx);
  assert.equal(ctx.lk1PaymentHeadKey, 'booking-payment-head:' + JSON.stringify([
    'iSkq6G', 'actor', ['CREATE', 'station', 'room', '2099-01-01T14:00:00.000Z', 60]]));
});
test('switching from one-time to subscription cannot bypass an active ordinary head', () => {
  const { ctx, msg } = fixture(); ctx.lk1.paymentLifecycleVersion = 1;
  helpers(msg).lk1ClaimPaymentHead(ctx);
  const head = { _id: ctx.lk1PaymentHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1',
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, phase: 'PAYMENT_REQUIRED' };
  const result = run({ _subscriptionBooking: ctx, payload: [head] });
  assert.equal(result.output, 4); assert.equal(result.msg.statusCode, 202);
  assert.equal(result.msg.payload.details.code, 'PAYMENT_ATTEMPT_ACTIVE');
});
test('ordinary to native transfer requires both closed head and server-only receipt, then full CAS', () => {
  const { ctx, msg } = fixture(); ctx.lk1.paymentLifecycleVersion = 1;
  helpers(msg).lk1ClaimPaymentHead(ctx);
  const proposal = { tenantKey: ctx.tenantKey, gameId: 'game', clientId: ctx.actorClientId,
    bookingId: 'booking', transactionId: 'transaction', amountMinor: 100000,
    headKey: ctx.lk1PaymentHeadKey, transactionState: 'UNPAID_CLOSED', bookingState: 'CANCELLED', sourceRevision: 4 };
  proposal.receiptKey = 'split-booking-payment-closure:' + JSON.stringify([
    proposal.tenantKey, proposal.gameId, proposal.clientId, proposal.bookingId, proposal.transactionId]);
  const head = { _id: ctx.lk1PaymentHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1',
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, phase: 'CLOSED',
    payment: { bookingId: 'booking', transactionId: 'transaction', amountMinor: 100000 },
    closure: { ...proposal, rosterRevision: 5 } };
  const read = run({ _subscriptionBooking: ctx, payload: [head] });
  assert.equal(read.output, 1); assert.deepEqual(read.msg.payload, { _id: proposal.receiptKey });
  const receipt = { _id: proposal.receiptKey, kind: 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1', proposal };
  const transfer = run({ _subscriptionBooking: ctx, payload: [receipt] });
  assert.equal(transfer.output, 3);
  assert.deepEqual(transfer.msg.payload[0].$expr.$eq[1].$literal, head);
  assert.equal(transfer.msg.payload[1].$set.kind, 'BOOKING_PAYMENT_HEAD_V1');
  ctx.step = 'lk1_payment_head_ordinary_receipt';
  const forged = run({ _subscriptionBooking: ctx, payload: [{ ...receipt, proposal: { ...proposal, amountMinor: 1 } }] });
  assert.equal(forged.msg.statusCode, 202); assert.equal(forged.output, 4);
});
