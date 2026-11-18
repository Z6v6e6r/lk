import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as contract from '../lib/splitBookingPaymentAttempt.mjs';
const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_cleanup_write_ack.js', import.meta.url), 'utf8');
const run = new Function('msg', '__splitBookingPaymentAttempt', source);
function fixture() {
  const p = { tenantKey: 'tenant', gameId: 'game', clientId: 'actor', bookingId: 'booking',
    transactionId: 'tx', amountMinor: 120000, sourceRevision: 4, transactionState: 'UNPAID_CLOSED',
    bookingState: 'CANCELLED', headKey: 'booking-payment-head:' + JSON.stringify(['tenant', 'actor', ['EVENT', 'exercise']]) };
  p.receiptKey = 'split-booking-payment-closure:' + JSON.stringify(['tenant', 'game', 'actor', 'booking', 'tx']);
  const game = { id: 'game', tenantKey: 'tenant', revision: 5, status: 'CREATED',
    updatedAt: '2035-01-01T12:15:00Z', payment: { paid: false }, participants: [],
    metadata: { splitPayment: { payments: [{ bookingId: 'booking', transactionId: 'tx', clientId: 'actor',
      status: 'EXPIRED', paymentAttemptClosure: p }] } } };
  const ctx = { gameId: 'game', tenantKey: 'tenant', expectedNextRevision: 5,
    expectedUpdatedAt: game.updatedAt, expectedStatus: 'CREATED', expectedPaid: false,
    step: 'write_ack', paymentAttemptHeadClosures: [p] };
  return { p, game, ctx, receipt: { _id: p.receiptKey, kind: 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1', proposal: p } };
}
test('canonical game CAS and readback precede receipt lookup and head closure; lost head ACK reads only', () => {
  const { ctx, game, p, receipt } = fixture();
  let msg = { _splitCleanupWriteAck: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } };
  let out = run(msg, contract); assert.equal(out[0], msg); assert.equal(ctx.step, 'readback');
  msg.payload = [game]; out = run(msg, contract); assert.equal(out[4], msg); assert.equal(ctx.step, 'payment_head_receipt_read');
  assert.deepEqual(msg.payload, { _id: p.receiptKey });
  msg.payload = [receipt]; out = run(msg, contract); assert.equal(out[5], msg);
  assert.equal(msg.payload[1].$set.phase, 'CLOSED'); assert.equal(ctx.step, 'payment_head_write_ack');
  msg.error = { message: 'synthetic lost ACK' }; msg.payload = undefined;
  out = run(msg, contract); assert.equal(out[4], msg); assert.deepEqual(msg.payload, { _id: p.headKey });
  msg.payload = [{ _id: p.headKey, phase: 'CLOSED', actorClientId: 'actor', closure: { ...p, rosterRevision: 5 } }];
  out = run(msg, contract); assert.equal(out[1].payload.ok, true); assert.equal(out[1].statusCode, 200);
});
test('failed canonical CAS never closes a head', () => {
  const { ctx } = fixture(); const msg = { _splitCleanupWriteAck: ctx, payload: { acknowledged: true, matchedCount: 0 } };
  const out = run(msg, contract); assert.equal(out[3], msg); assert.equal(out[4], undefined); assert.equal(out[5], undefined);
});
for (const mutation of ['missing receipt', 'forged receipt', 'actor still on roster', 'wrong revision', 'wrong amount']) {
  test('head closure fails closed: ' + mutation, () => {
    const { ctx, game, receipt } = fixture(); ctx.step = 'payment_head_receipt_read'; ctx.paymentHeadCanonicalRecord = game;
    let payload = [receipt];
    if (mutation === 'missing receipt') payload = [];
    if (mutation === 'forged receipt') payload = [{ ...receipt, kind: 'client-metadata' }];
    if (mutation === 'actor still on roster') game.participants = [{ id: 'actor' }];
    if (mutation === 'wrong revision') game.revision = 4;
    if (mutation === 'wrong amount') payload = [{ ...receipt, proposal: { ...receipt.proposal, amountMinor: 1 } }];
    const msg = { _splitCleanupWriteAck: ctx, payload };
    const out = run(msg, contract); assert.equal(out[3], msg); assert.equal(out[5], undefined);
  });
}
