import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as contract from '../lib/splitBookingPaymentAttempt.mjs';
import * as nativePaymentContract from '../lib/bookingPaymentAttempt.mjs';
import { createBookingPaymentCancellationProtocol } from '../lib/bookingPaymentCancellation.mjs';
import { fixture as cancellationProtocolFixture, at as cancellationAt, cfg as cancellationConfig } from './fixtures/bookingPaymentCancellationFixtures.mjs';
import { hasDeterministicSubscriptionDecision } from '../../src/utils/subscriptionDecisionContract.ts';

const now = Date.parse('2026-11-20T10:00:00.000Z');
const source = name => fs.readFileSync(new URL('../nodered_games_nodes/fn_split_' + name + '.js', import.meta.url), 'utf8');
function run(name, msg, at = now, nativeContract = nativePaymentContract, globals = {}) {
  const context = vm.createContext({ msg, __splitBookingPaymentAttempt: contract, bookingPaymentLifecycle: nativeContract,
    global: { get: key => globals[key], set: () => {} }, env: { get: () => undefined },
    node: { warn: () => {} }, Date: class extends Date { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } } });
  const out = vm.runInContext('(function(){' + source(name) + '\n})()', context, { timeout: 1500 });
  return { out, msg };
}
const plain = x => JSON.parse(JSON.stringify(x));
function fixture() {
  const payment = { clientId: 'actor', bookingId: 'booking', transactionId: 'transaction',
    productId: 'product', amountMinor: 120000, paymentRef: 'pay-fixture', operationId: 'ordinary-fixture',
    status: 'PAYMENT_PENDING', paymentUrl: 'https://pay.vivacrm.ru/fixture', createdAt: '2026-11-20T09:50:00Z' };
  const transaction = { id: 'transaction', client: { id: 'actor' }, exerciseId: 'exercise', toPay: 120000,
    status: 'UNPAID', currency: 'RUB', createDate: payment.createdAt, paymentDueDate: '2026-11-20T10:15:00Z',
    products: [{ id: 'product', paymentBookingIds: ['booking'] }],
    cardPaymentInfo: { status: 'NEW', paymentUrl: payment.paymentUrl } };
  const booking = { id: 'booking', client: { id: 'actor' }, exerciseId: 'exercise',
    isCancelled: false, paymentType: 'ON_PLACE' };
  return { payment, transaction, booking };
}
function receiptFor(proposal) {
  proposal.receiptKey = 'split-booking-payment-closure:' + JSON.stringify([
    proposal.tenantKey, proposal.gameId, proposal.clientId, proposal.bookingId, proposal.transactionId]);
  return { _id: proposal.receiptKey, kind: 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1', proposal };
}
const expected = () => ({ transactionId: 'transaction', clientId: 'actor', bookingId: 'booking',
  exerciseId: 'exercise', amountMinor: 120000, productId: 'product' });
function cleanupCtx(leg = 'EXPIRE') {
  return { step: 'check_timeout_transaction', nativePaymentOwnerChecked: true, mode: 'PARTICIPANT_TIMEOUT', token: 'synthetic',
    gameId: 'game', sourceTenantKey: 'tenant', sourceRevision: 1, paymentExerciseId: 'exercise',
    currentBookingId: 'booking', currentClientId: 'actor', bookingQueue: [], bookingResults: [], trace: [],
    currentTimedOutPayment: { transactionId: 'transaction', paymentRef: 'pay-fixture', bookingIds: ['booking'], clientId: 'actor', amountMinor: 120000 },
    closeIntent: contract.splitAttemptCloseIntent({ gameId: 'game', sourceTenantKey: 'tenant',
      currentBookingId: 'booking', currentClientId: 'actor', currentTimedOutPayment: { transactionId: 'transaction' } }, leg) };
}
test('same trusted checkout is returned before 15m, never extended by a retry', () => {
  const { payment, transaction, booking } = fixture();
  const result = contract.splitAttemptResume(payment, transaction, booking, 'actor', 'exercise', now);
  assert.equal(result.state, 'PAYMENT_REQUIRED'); assert.equal(result.paymentUrl, payment.paymentUrl);
  assert.equal(result.window.expiresAt, '2026-11-20T10:05:00.000Z');
  assert.equal(contract.splitAttemptResume(payment, transaction, booking, 'actor', 'exercise', now + 5 * 60000).state, 'CLOSING');
  assert.equal(contract.splitAttemptResume(payment, transaction, booking, 'other', 'exercise', now).state, 'CLOSING');
});
test('unpaid is open, card-expired is closed, contradictory and offline money are held', () => {
  const { transaction, payment, booking } = fixture();
  assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'OPEN');
  transaction.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' };
  assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'CLOSED');
  transaction.paymentStatus = 'PAID'; assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'UNKNOWN');
  delete transaction.paymentStatus;
  transaction.paymentLegs = [{ source: 'CARD_ONLINE', amountKopecks: 120000, status: 'PAID' }];
  assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'UNKNOWN');
  transaction.paymentLegs = [{ source: 'CARD_ONLINE', amountKopecks: 120000 }];
  assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'CLOSED');
  transaction.status = 'PAID';
  assert.equal(contract.splitAttemptTransaction(transaction, expected()), 'PAID');
  transaction.status = 'UNPAID'; transaction.cardPaymentInfo = { status: 'NEW', paymentUrl: payment.paymentUrl };
  booking.amountDue = { paidKopecks: 1 };
  assert.equal(contract.splitAttemptResume(payment, transaction, booking, 'actor', 'exercise', now).state, 'CLOSING');
});
test('cleanup requests a majority durable intent before any expire POST', () => {
  const ctx = cleanupCtx(); const { transaction } = fixture();
  const { out, msg } = run('cleanup_router', { _splitCleanupCtx: ctx, payload: transaction, statusCode: 200 });
  assert.ok(out[6]); assert.ok(!out[0]);
  assert.equal(msg._splitCleanupCtx.step, 'split_close_intent_written');
  assert.equal(msg.payload[1].$setOnInsert.binding.leg, 'EXPIRE');
  assert.deepEqual(plain(msg.payload[2]), { upsert: true, writeConcern: { w: 'majority', j: true } });
});
test('only inserted intent winner can expire, after another transaction readback', () => {
  const ctx = cleanupCtx(); ctx.step = 'split_close_intent_written';
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: { acknowledged: true, upsertedCount: 1 }, statusCode: 200 });
  assert.ok(r.out[0]); assert.equal(r.msg.method, 'GET'); assert.equal(ctx.step, 'split_close_transaction_recheck');
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: fixture().transaction, statusCode: 200 });
  assert.equal(r.msg.method, 'POST'); assert.match(r.msg.url, /\/transactions\/transaction\/expire$/);
});
test('existing or unknown expiry intent reconciles without repeating provider POST', () => {
  const ctx = cleanupCtx(); ctx.step = 'split_close_intent_written';
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: { acknowledged: true, upsertedCount: 0, matchedCount: 1 }, statusCode: 200 });
  assert.ok(r.out[7]); assert.ok(!r.out[0]);
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: [ctx.closeIntent], statusCode: 200 });
  assert.equal(r.msg.method, 'GET'); assert.equal(ctx.step, 'check_timeout_transaction_after_expire');
  const replay = run('cleanup_router', { _splitCleanupCtx: ctx, payload: fixture().transaction, statusCode: 200 });
  assert.ok(!replay.out[0], 'still-open bill cannot dispatch expiry again or cancel booking');
});
test('PAID arriving after durable expiry intent takes payment recovery, never cancellation', () => {
  const ctx = cleanupCtx(); ctx.step = 'split_close_transaction_recheck';
  const transaction = fixture().transaction; transaction.status = 'PAID';
  const r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: transaction, statusCode: 200 });
  assert.ok(!r.out[0]); assert.ok(r.out[4]); assert.equal(ctx.step, 'payment_claim_write');
});
test('a bare unpaid transaction does not enter booking cancellation', () => {
  const ctx = cleanupCtx(); ctx.step = 'check_timeout_transaction_after_expire';
  const r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: fixture().transaction, statusCode: 200 });
  assert.ok(!r.out[0]); assert.equal(ctx.bookingResults[0].ok, false);
});
test('fresh authenticated actor owns the durable head, body actor cannot impersonate', () => {
  const ctx = { action: 'join', step: 'ordinary_attempt_profile', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', clientId: 'attacker', clientPhone: '79990000000', exerciseId: 'exercise' };
  const r = run('router', { _splitCtx: ctx, payload: { id: 'actor', phone: '79990000000' }, statusCode: 200 });
  assert.equal(r.msg.statusCode, 403); assert.ok(!r.out[0]); assert.ok(!r.out[5]);
});
test('ordinary head insertion winner proceeds; another tab only reads the same owner', () => {
  const ctx = { action: 'join', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', clientId: 'actor', clientPhone: '79990000000',
    ordinaryHeadKey: contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor'),
    exerciseId: 'exercise', studioId: 'studio', roomId: 'room' };
  let r = run('router', { _splitCtx: ctx, payload: [], statusCode: 200 });
  assert.ok(r.out[6]); assert.equal(r.msg.payload[1].$setOnInsert.phase, 'UPSTREAM_INTENT');
  const head = plain(ctx.ordinaryHead);
  assert.match(head.claimToken, /^claim:/);
  // Another tab with the same client operationId lost the insert: it holds its own token.
  const other = { action: 'join', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: ctx.ordinaryHeadKey, exerciseId: 'exercise' };
  r = run('router', { _splitCtx: other, payload: [], statusCode: 200 });
  r = run('router', { _splitCtx: other, payload: { acknowledged: true, upsertedCount: 0, matchedCount: 1, modifiedCount: 0 }, statusCode: 200 });
  assert.ok(r.out[5]); assert.ok(!r.out[0]);
  assert.notEqual(other.ordinaryClaimToken, head.claimToken);
  r = run('router', { _splitCtx: other, payload: [head], statusCode: 200 });
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
  assert.notEqual(other.ordinaryHeadOwned, true);
});
test('our own lost insert ACK is recognised only by our server claim token and resumes ownership', () => {
  const key = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const ctx = { action: 'join', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key, exerciseId: 'exercise' };
  run('router', { _splitCtx: ctx, payload: [], statusCode: 200 });
  const stored = plain(ctx.ordinaryHead);
  run('router', { _splitCtx: ctx, error: 'lost', payload: null, statusCode: 503 });
  assert.equal(ctx.step, 'ordinary_attempt_head_found');
  const own = run('router', { _splitCtx: ctx, payload: [stored], statusCode: 200 });
  // Ownership resumed: this minimal ctx then refuses before any write and retires
  // exactly its own head by claim token, which only an owner can do.
  assert.notEqual(own.msg.payload?.state, 'PENDING_CONFIRMATION');
  assert.ok(own.out[6]); assert.equal(own.msg.payload[0].claimToken, stored.claimToken);
  assert.equal(own.msg.payload[1].$set.phase, 'PREWRITE_FAILED');
  for (const forged of [{ ...stored, claimToken: 'claim:other' }, { ...stored, claimToken: undefined }, { ...stored, payment: { bookingId: 'b' } }]) {
    const c = { ...ctx, step: 'ordinary_attempt_head_found', ordinaryHeadOwned: undefined };
    const r = run('router', { _splitCtx: c, payload: [plain(forged)], statusCode: 200 });
    assert.notEqual(c.ordinaryHeadOwned, true); assert.equal(r.msg.statusCode, 202);
  }
});
test('resume after deadline returns stable locator without old payment URL', () => {
  const f = fixture();
  const ctx = { action: 'join', step: 'ordinary_attempt_transaction', paymentMode: 'one_time',
    operationId: 'new-click', trustedPaymentActor: 'actor', exerciseId: 'exercise',
    ordinaryResumePayment: f.payment, ordinaryResumeBooking: f.booking };
  const r = run('router', { _splitCtx: ctx, payload: f.transaction, statusCode: 200 }, now + 5 * 60000);
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
  assert.equal(r.msg.payload.transactionId, 'transaction');
});
test('canonical roster readback is mandatory before a closed head allows new generation', () => {
  const proposal = { headKey: 'booking-payment-head:fixture', tenantKey: 'tenant', gameId: 'game',
    sourceRevision: 3, clientId: 'actor', bookingId: 'booking', transactionId: 'transaction', amountMinor: 120000,
    transactionState: 'UNPAID_CLOSED', bookingState: 'CANCELLED' };
  const game = { id: 'game', tenantKey: 'tenant', revision: 4, updatedAt: '2026-11-20T10:06:00Z', participants: [],
    metadata: { splitPayment: { payments: [{ clientId: 'actor', bookingId: 'booking', transactionId: 'transaction', status: 'EXPIRED', paymentAttemptClosure: proposal }] } } };
  const receipt = receiptFor(proposal);
  assert.equal(contract.splitAttemptHeadClosure(proposal, game, receipt)[1].$set.phase, 'CLOSED');
  game.revision = 3; assert.equal(contract.splitAttemptHeadClosure(proposal, game, receipt), null);
  game.revision = 4; game.participants.push({ id: 'actor' });
  assert.equal(contract.splitAttemptHeadClosure(proposal, game, receipt), null);
});
test('cancellation intent is distinct, winner rechecks closed bill before exactly one NONE command', () => {
  const ctx = cleanupCtx('CANCEL'); ctx.step = 'split_close_intent_written';
  ctx.currentTransactionUnpaidVerified = true; ctx.currentTimeoutBookingChecked = true;
  ctx.currentCancelRequest = { method: 'PUT', path: '/clients/actor/bookings/booking/cancel',
    payload: { refundMethod: 'NONE', cancelExercise: false }, scope: 'admin', refundMethod: 'NONE' };
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: { acknowledged: true, upsertedCount: 1 }, statusCode: 200 });
  assert.equal(r.msg.method, 'GET');
  const transaction = fixture().transaction;
  transaction.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' };
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: transaction, statusCode: 200 });
  assert.equal(r.msg.method, 'PUT'); assert.equal(r.msg.payload.refundMethod, 'NONE');
  assert.equal(ctx.step, 'cancel_booking');
});
test('unknown cancellation ACK only verifies the old booking and never repeats PUT', () => {
  const ctx = cleanupCtx('CANCEL'); ctx.step = 'split_close_intent_written';
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, error: true, payload: null, statusCode: 503 });
  assert.ok(r.out[7]); assert.ok(!r.out[0]);
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: [ctx.closeIntent], statusCode: 200 });
  assert.equal(r.msg.method, 'GET'); assert.match(r.msg.url, /\/clients\/actor\/bookings\/booking$/);
  assert.equal(ctx.step, 'verify_booking_cancelled');
});
test('closed head offers a new identity; only explicit next generation can claim it', () => {
  const key = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const previous = { _id: key, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'iSkq6G', actorClientId: 'actor',
    phase: 'CLOSED', operationId: 'ordinary-fixture', rootOperationId: 'ordinary-fixture', generation: 0 };
  const ctx = { action: 'join', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key };
  let r = run('router', { _splitCtx: ctx, payload: [previous], statusCode: 200 });
  assert.equal(r.msg.statusCode, 409); assert.equal(r.msg.payload.details.nextOperationId, 'ordinary-fixture:rejoin:1');
  ctx.operationId = 'ordinary-fixture:rejoin:1';
  r = run('router', { _splitCtx: ctx, payload: [previous], statusCode: 200 });
  assert.ok(r.out[6]); assert.equal(r.msg.payload[1].$push.history.operationId, 'ordinary-fixture');
  assert.equal(r.msg.payload[1].$set.phase, 'UPSTREAM_INTENT');
  assert.deepEqual(plain(r.msg.payload[0].$expr.$eq[1].$literal), previous);
});
test('create checkout URL cannot be returned until exact durable head bind ACK', () => {
  const ctx = { action: 'create', step: 'ordinary_attempt_checkout_saved', paymentMode: 'one_time',
    trustedPaymentActor: 'actor', ordinaryHeadKey: 'booking-payment-head:fixture',
    operationId: 'ordinary-fixture', ordinaryResponse: { paymentUrl: 'https://pay.vivacrm.ru/fixture',
      bookingId: 'booking', transactionId: 'transaction', expiresAt: '2026-11-20T10:05:00Z' } };
  let r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 }, statusCode: 200 });
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
  r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 }, now + 5 * 60000);
  assert.ok(r.out[5]); assert.ok(!r.out[1]);
  r = run('router', { _splitCtx: ctx, payload: [{ _id: ctx.ordinaryHeadKey,
    kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'iSkq6G', actorClientId: 'actor',
    phase: 'PAYMENT_REQUIRED', payment: { bookingId: 'booking', transactionId: 'transaction' } }], statusCode: 200 }, now + 5 * 60000);
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
  assert.equal(r.out[2].payload.paymentUrl, 'https://pay.vivacrm.ru/fixture', 'closed-window locator is preserved for canonical cleanup');
});
test('standard create time window produces stable actor-scoped head independent of request operation', () => {
  // Exact field shape emitted by fn_split_create_prepare, including midnight rollover.
  const ctx = { action: 'create', studioId: 'studio', roomId: 'room', date: '2026-11-20',
    fromTime: '23:00', toTime: '00:30', timeFrom: '2026-11-20T23:00:00+03:00', timeTo: '2026-11-21T00:30:00+03:00' };
  const key = contract.splitAttemptHeadKey(ctx, 'actor');
  assert.ok(key); assert.ok(key.includes('2026-11-20T20:00:00.000Z')); assert.ok(key.includes('90'));
  assert.equal(contract.splitAttemptHeadKey({ ...ctx, operationId: 'second-click' }, 'actor'), key);
  assert.notEqual(contract.splitAttemptHeadKey(ctx, 'other'), key);
  const r = run('router', { _splitCtx: { ...ctx, step: 'ordinary_attempt_head_found',
    paymentMode: 'one_time', operationId: 'ordinary-create-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key },
    payload: [], statusCode: 200 });
  assert.ok(r.out[6]); assert.equal(r.msg.payload[1].$setOnInsert.actorClientId, 'actor');
});
test('verified paid attempt returns typed PAID without a checkout link or new write', () => {
  const f = fixture(); f.transaction.status = 'PAID';
  const r = run('router', { _splitCtx: { action: 'join', step: 'ordinary_attempt_transaction',
    paymentMode: 'one_time', trustedPaymentActor: 'actor', exerciseId: 'exercise',
    ordinaryResumePayment: f.payment, ordinaryResumeBooking: f.booking }, payload: f.transaction, statusCode: 200 });
  assert.equal(r.msg.payload.paymentAttemptState, 'PAID'); assert.equal(r.msg.payload.paymentUrl, null);
  assert.ok(!r.out[2]); assert.ok(!r.out[6]);
});
test('lost head finalizer is recoverable from canonical persisted expiration receipt only', () => {
  const f = fixture(), key = 'booking-payment-head:fixture';
  const proposal = { headKey: key, tenantKey: 'tenant', gameId: 'game', sourceRevision: 1,
    clientId: 'actor', bookingId: 'booking', transactionId: 'transaction', amountMinor: 120000,
    transactionState: 'UNPAID_CLOSED', bookingState: 'CANCELLED' };
  const ctx = { action: 'join', step: 'ordinary_attempt_game_readback', paymentMode: 'one_time',
    trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryHead: { payment: f.payment } };
  const game = { id: 'game', tenantKey: 'tenant', revision: 2, updatedAt: '2026-11-20T10:06:00Z', participants: [],
    metadata: { splitPayment: { payments: [{ ...f.payment, status: 'EXPIRED', paymentAttemptClosure: proposal }] } } };
  const receipt = receiptFor(proposal);
  let r = run('router', { _splitCtx: ctx, payload: [game], statusCode: 200 });
  assert.ok(r.out[5]); assert.ok(!r.out[6]);
  r = run('router', { _splitCtx: ctx, payload: [receipt], statusCode: 200 });
  assert.ok(r.out[6]); assert.equal(r.msg.payload[1].$set.phase, 'CLOSED');
  assert.ok(!r.out[0], 'persisted truthful receipt avoids any provider replay');
  game.metadata.splitPayment.payments[0].status = 'PAYMENT_PENDING';
  const pendingCtx = { ...ctx, step: 'ordinary_attempt_game_readback' };
  run('router', { _splitCtx: pendingCtx, payload: [game], statusCode: 200 });
  r = run('router', { _splitCtx: pendingCtx, payload: [receipt], statusCode: 200 });
  assert.equal(r.msg.payload.paymentAttemptState, 'CLOSING'); assert.ok(!r.out[6]);
  game.metadata.splitPayment.payments[0].status = 'EXPIRED';
  const forgedCtx = { ...ctx, step: 'ordinary_attempt_game_readback' };
  run('router', { _splitCtx: forgedCtx, payload: [game], statusCode: 200 });
  r = run('router', { _splitCtx: forgedCtx, payload: [], statusCode: 200 });
  assert.equal(r.msg.payload.paymentAttemptState, 'CLOSING'); assert.ok(!r.out[6], 'client-patchable metadata cannot forge a server receipt');
});
test('both server prepare paths ignore client deadline extensions', () => {
  const body = { date: '2026-11-20', fromTime: '16:00', toTime: '17:30', roomId: 'room', studioId: 'studio',
    clientPhone: '79990000000', clientId: 'actor', paymentMode: 'one_time', paymentRef: 'ordinary-fixture',
    paymentDeadlineMinutes: 180, deadlineAt: '2027-11-20T10:00:00Z' };
  const created = run('create_prepare', { payload: body, req: { headers: { authorization: 'Bearer synthetic' }, query: {} } });
  assert.equal(created.msg._splitCtx.deadlineAt, '2026-11-20T10:15:00.000Z');
  assert.ok(contract.splitAttemptHeadKey(created.msg._splitCtx, 'actor'));
  const game = { id: 'game', settings: { payMode: 'split' }, participants: [],
    booking: { date: '2026-11-20', timeFrom: '16:00', timeTo: '17:30', roomId: 'room', studioId: 'studio', exerciseId: 'exercise' },
    metadata: { splitPayment: { enabled: true, payments: [], shareAmount: 1000 } } };
  const joined = run('join_prepare', { payload: [game], _splitJoinBody: body, _splitJoinGameId: 'game',
    req: { headers: { authorization: 'Bearer synthetic' }, query: {} } });
  assert.equal(joined.msg._splitCtx.deadlineAt, '2026-11-20T10:15:00.000Z');
});
test('retired LEFT attempt is selected after 15m without changing original leave history', () => {
  const f = fixture();
  const payment = { ...f.payment, status: 'LEFT', cancelReason: 'PLAYER_LEFT', leftAt: '2026-11-20T09:52:00Z',
    paymentAttemptHeadKey: 'booking-payment-head:fixture' };
  const game = { id: 'game', tenantKey: 'tenant', revision: 1, status: 'PAID',
    settings: { payMode: 'split' }, participants: [{ id: 'other' }], waitlist: [],
    metadata: { splitPayment: { enabled: true, exerciseId: 'exercise', payments: [payment] },
      leaveEvents: [{ playerId: 'actor', reason: 'PLAYER_LEFT', leftAt: payment.leftAt }] } };
  const r = run('cleanup_prepare', { payload: [game], _splitCleanupRequest: {
    nowTs: now + 5 * 60000, nowIso: '2026-11-20T10:05:00Z' } });
  const task = r.msg.payload[0];
  assert.equal(task.timedOutPayments[0].paymentAttemptHeadKey, payment.paymentAttemptHeadKey);
  assert.deepEqual(plain(task.nextSplitPayments[0]), payment);
  assert.deepEqual(plain(task.nextParticipants), game.participants);
  assert.deepEqual(plain(task.nextLeaveEvents), game.metadata.leaveEvents);
  game.metadata.splitPayment.payments[0].nativePaymentAttemptClosure = { operationKey: 'native-operation' };
  const completed = run('cleanup_prepare', { payload: [game], _splitCleanupRequest: {
    nowTs: now + 5 * 60000, nowIso: '2026-11-20T10:05:00Z' } });
  assert.equal(completed.msg.payload.processed, 0, 'completed native canonical cleanup is not rescheduled');
});
test('server closure receipt is majority persisted before canonical roster write or head release', () => {
  const ctx = cleanupCtx(); ctx.step = 'split_close_final_transaction';
  ctx.currentTransactionUnpaidVerified = true; ctx.currentTimedOutPayment.paymentAttemptHeadKey = 'booking-payment-head:fixture';
  ctx.pendingBookingSuccess = { bookingId: 'booking', clientId: 'actor', statusCode: 200, alreadyCancelled: true };
  ctx.nextParticipants = []; ctx.nextWaitlist = []; ctx.nextLeaveEvents = [];
  ctx.nextSplitPayments = [{ ...fixture().payment, status: 'LEFT', cancelReason: 'PLAYER_LEFT' }];
  const transaction = fixture().transaction; transaction.cardPaymentInfo = { status: 'REJECTED', declineOutcome: 'EXPIRED' };
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: transaction, statusCode: 200 });
  assert.ok(r.out[6]); assert.ok(!r.out[1]); assert.equal(ctx.step, 'split_close_receipt_written');
  const receipt = plain(r.msg.payload[1].$setOnInsert);
  assert.equal(receipt.kind, 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1');
  assert.deepEqual(plain(r.msg.payload[2].writeConcern), { w: 'majority', j: true });
  r = run('cleanup_router', { _splitCleanupCtx: ctx, error: true, payload: null, statusCode: 503 });
  assert.ok(r.out[7]); assert.ok(!r.out[0]);
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: [receipt], statusCode: 200 });
  assert.ok(r.out[1]);
  const row = r.out[1].payload.$set['metadata.splitPayment.payments'][0];
  assert.equal(row.status, 'LEFT'); assert.equal(row.cancelReason, 'PLAYER_LEFT');
  assert.deepEqual(plain(row.paymentAttemptClosure), receipt.proposal);
  assert.deepEqual(plain(r.out[1]._splitCleanupWriteAck.paymentAttemptHeadClosures), [receipt.proposal]);
});
test('normal JOIN durably binds pending finance into existing game without roster authority', () => {
  const f = fixture();
  const ctx = { action: 'join', ordinaryHeadKey: 'booking-payment-head:fixture', step: 'ordinary_attempt_pending_game_found', paymentMode: 'one_time',
    gameId: 'game', exerciseId: 'exercise', trustedPaymentActor: 'actor', operationId: f.payment.operationId,
    ordinaryResponse: { ...f.payment, toPayMinor: 120000, paymentAttemptState: 'PAYMENT_REQUIRED',
      paymentAttemptHeadKey: 'booking-payment-head:fixture', paymentAttemptCreatedAt: f.payment.createdAt,
      expiresAt: '2026-11-20T10:05:00Z' } };
  const game = { _id: 'game-object', id: 'game', tenantKey: 'iSkq6G', revision: 2, status: 'PAID',
    booking: { exerciseId: 'exercise' }, participants: [{ id: 'other' }], waitlist: [{ id: 'waiting' }],
    metadata: { splitPayment: { enabled: true, payments: [] } } };
  let r = run('router', { _splitCtx: ctx, payload: [game], statusCode: 200 });
  assert.ok(r.out[8]); assert.ok(!r.out[1], 'no checkout exposed before server pending row');
  const [query, change, options] = plain(r.msg.payload);
  assert.deepEqual(query.$expr.$eq[1].$literal, game);
  assert.deepEqual(Object.keys(change.$set).sort(), ['metadata.splitPayment.payments', 'updatedAt']);
  assert.deepEqual(change.$inc, { revision: 1 });
  assert.deepEqual(options.writeConcern, { w: 'majority', j: true });
  const persisted = { ...game, revision: 3, metadata: { splitPayment: { ...game.metadata.splitPayment,
    payments: change.$set['metadata.splitPayment.payments'] } } };
  r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 });
  assert.ok(r.out[7]); assert.ok(!r.out[1]);
  r = run('router', { _splitCtx: ctx, payload: [persisted], statusCode: 200 });
  assert.ok(r.out[5]); assert.ok(!r.out[1], 'fresh cancellation marker is checked after pending-row persistence');
  r = run('router', { _splitCtx: ctx, payload: [{ _id: ctx.ordinaryHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1',
    actorClientId: 'actor', tenantKey: 'iSkq6G', phase: 'PAYMENT_REQUIRED', payment: f.payment }], statusCode: 200 });
  assert.equal(r.msg.statusCode, 201); assert.equal(r.msg.payload.paymentUrl, f.payment.paymentUrl);
  assert.deepEqual(persisted.participants, game.participants); assert.deepEqual(persisted.waitlist, game.waitlist);
});
test('normal JOIN financial CAS conflict is bounded and becomes explicit REVIEW without new charges', () => {
  const ctx = { action: 'join', step: 'ordinary_attempt_pending_game_saved', gameId: 'game', exerciseId: 'exercise',
    operationId: 'ordinary-fixture', ordinaryPendingGameRetries: 2,
    ordinaryResponse: { transactionId: 'transaction', bookingId: 'booking' } };
  const r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 }, statusCode: 200 });
  assert.equal(r.msg.statusCode, 503); assert.equal(r.msg.payload.paymentAttemptState, 'REVIEW');
  assert.equal(r.msg.payload.paymentUrl, null); assert.ok(!r.out[0]); assert.ok(!r.out[8]);
});
test('expired ordinary CREATE without canonical game surfaces REVIEW with original locators', () => {
  const f = fixture();
  const ctx = { action: 'create', step: 'ordinary_attempt_transaction', paymentMode: 'one_time',
    ordinaryGameMissing: true, exerciseId: 'exercise', trustedPaymentActor: 'actor',
    ordinaryResumePayment: f.payment, ordinaryResumeBooking: f.booking };
  const r = run('router', { _splitCtx: ctx, payload: f.transaction, statusCode: 200 }, now + 5 * 60000);
  assert.equal(r.msg.statusCode, 503); assert.equal(r.msg.payload.paymentAttemptState, 'REVIEW');
  assert.equal(r.msg.payload.paymentUrl, null); assert.equal(r.msg.payload.transactionId, 'transaction');
  assert.equal(r.msg.payload.operationId, f.payment.operationId); assert.ok(!r.out[0]);
});
test('native and ordinary routes share actor+event and normalized CREATE identity', () => {
  assert.equal(contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor'),
    'booking-payment-head:' + JSON.stringify(['iSkq6G', 'actor', ['EVENT', 'exercise']]));
  assert.equal(contract.splitAttemptHeadKey({ action: 'create', studioId: 'studio', roomId: 'room',
    timeFrom: '2026-11-20T19:00:00+03:00', timeTo: '2026-11-20T20:30:00+03:00', durationMinutes: 90 }, 'actor'),
    'booking-payment-head:' + JSON.stringify(['iSkq6G', 'actor', ['CREATE', 'studio', 'room', '2026-11-20T16:00:00.000Z', 90]]));
});
test('ordinary cannot bypass an active native head with another payment mode or operation id', () => {
  const key = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const head = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation' };
  const ctx = { action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_head_found',
    paymentMode: 'one_time', operationId: 'new-random-payment', trustedPaymentActor: 'actor', ordinaryHeadKey: key };
  let r = run('router', { _splitCtx: ctx, payload: [head], statusCode: 200 });
  assert.ok(r.out[5]); assert.deepEqual(plain(r.msg.payload), { _id: 'native-key' });
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'CONFIRMED' };
  r = run('router', { _splitCtx: ctx, payload: [owner], statusCode: 200 }, now, { nativeReleased: () => false });
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null); assert.ok(!r.out[6]);
});
test('verified native release permits only a CAS transfer for exact actor/target and a fresh operation', () => {
  const key = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const head = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation' };
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'RELEASED', verifiedNativeReceipt: true };
  const ctx = { action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_native_owner_found',
    paymentMode: 'one_time', operationId: 'fresh-random-payment', trustedPaymentActor: 'actor',
    ordinaryHeadKey: key, ordinaryNativeHead: head };
  const nativeContract = { nativeReleased: op => op.state === 'RELEASED' && op.verifiedNativeReceipt === true };
  let r = run('router', { _splitCtx: ctx, payload: [owner], statusCode: 200 }, now, nativeContract);
  assert.ok(r.out[6]); assert.deepEqual(plain(r.msg.payload[0].$expr.$eq[1].$literal), head);
  assert.equal(r.msg.payload[1].$push.history.ownerOperationKey, 'native-key');
  const foreign = { ...owner, actorClientId: 'other' };
  r = run('router', { _splitCtx: { ...ctx, step: 'ordinary_attempt_native_owner_found' }, payload: [foreign], statusCode: 200 }, now, nativeContract);
  assert.equal(r.msg.statusCode, 202); assert.ok(!r.out[6]);
  r = run('router', { _splitCtx: { ...ctx, operationId: owner.operationId, step: 'ordinary_attempt_native_owner_found' },
    payload: [owner], statusCode: 200 }, now, nativeContract);
  assert.equal(r.msg.statusCode, 202); assert.ok(!r.out[6]);
});
test('CLOSED ordinary head accepts a distinct explicit random click and never replays a retired id', () => {
  const key = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const head = { _id: key, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'iSkq6G', actorClientId: 'actor',
    phase: 'CLOSED', operationId: 'current-payment', rootOperationId: 'first-payment', generation: 2,
    cancelRequestedAt: new Date(now).toISOString(), cancelRequestedBy: 'actor', cancelRequestKey: 'cancel-request',
    history: [{ operationId: 'first-payment' }, { operationId: 'second-payment' }] };
  for (const id of ['first-payment', 'second-payment', 'current-payment']) {
    const r = run('router', { _splitCtx: { action: 'join', exerciseId: 'exercise', paymentMode: 'one_time',
      trustedPaymentActor: 'actor', ordinaryHeadKey: key, operationId: id, step: 'ordinary_attempt_head_found' },
      payload: [head], statusCode: 200 });
    assert.equal(r.msg.statusCode, 409); assert.ok(!r.out[6]);
  }
  const r = run('router', { _splitCtx: { action: 'join', exerciseId: 'exercise', paymentMode: 'one_time',
    trustedPaymentActor: 'actor', ordinaryHeadKey: key, operationId: 'brand-new-random-ref', step: 'ordinary_attempt_head_found' },
    payload: [head], statusCode: 200 });
  assert.ok(r.out[6]); assert.equal(r.msg.payload[1].$set.operationId, 'brand-new-random-ref');
  assert.equal(r.msg.payload[1].$set.generation, 3); assert.equal(r.msg.payload[1].$push.history.operationId, head.operationId);
  assert.equal(r.msg.payload[1].$unset.cancelRequestedAt, '');
  assert.equal(r.msg.payload[1].$unset.cancelRequestedBy, ''); assert.equal(r.msg.payload[1].$unset.cancelRequestKey, '');
  assert.equal(r.msg.payload[1].$push.history.cancelRequestKey, head.cancelRequestKey, 'original cancellation remains audited');
});
test('UNPAID -> durable CANCEL intent -> PAID -> exact claim preserves canonical paid recovery', () => {
  const ctx = cleanupCtx('CANCEL'); ctx.step = 'split_close_transaction_recheck';
  ctx.currentTransactionUnpaidVerified = true; ctx.currentTimeoutBookingChecked = true;
  ctx.currentTimedOutPayment.paymentAttemptHeadKey = 'booking-payment-head:fixture';
  ctx.nextParticipants = []; ctx.nextWaitlist = []; ctx.nextLeaveEvents = [];
  ctx.nextSplitPayments = [{ ...fixture().payment, status: 'EXPIRED' }];
  const tx = fixture().transaction; tx.status = 'PAID';
  let r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: tx, statusCode: 200 });
  assert.ok(r.out[4]); assert.ok(!r.out[0]);
  const claim = { ...plain(r.out[4].payload[0]), ...plain(r.out[4].payload[1].$setOnInsert) };
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: { acknowledged: true, upsertedCount: 1 }, statusCode: 200 });
  assert.ok(r.out[5]);
  r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: [claim], statusCode: 200 });
  assert.equal(ctx.currentTransactionUnpaidVerified, false);
  assert.ok(r.out[1]); assert.ok(!r.out[0]); assert.ok(!r.out[6]);
  assert.equal(r.out[1].payload.$set['metadata.splitPayment.payments'][0].status, 'PAID');
  assert.equal(ctx.blockLocalMutation, undefined);
  assert.ok(!ctx.paymentAttemptHeadClosures?.length);
});
test('a later provider creation alias cannot extend the saved attempt deadline', () => {
  const f = fixture();
  f.payment.paymentAttemptCreatedAt = '2026-11-20T09:50:00Z';
  f.transaction.createDate = '2026-11-20T09:59:00Z';
  f.transaction.createdAt = '2026-11-20T09:58:00Z';
  const window = contract.splitAttemptWindow(f.payment, f.transaction);
  assert.equal(window.createdAt, '2026-11-20T09:50:00.000Z');
  assert.equal(window.expiresAt, '2026-11-20T10:05:00.000Z');
  assert.equal(contract.splitAttemptResume(f.payment, f.transaction, f.booking, 'actor', 'exercise', now + 5 * 60000).state, 'CLOSING');
});
function ownerFencedTask() {
  return { mode: 'PARTICIPANT_TIMEOUT', tenantKey: 'tenant', gameId: 'game', revision: 1,
    expectedRevision: 1, expectedUpdatedAt: '2026-11-20T09:00:00Z', paymentPaid: true,
    paymentExerciseId: 'exercise', bookingIds: ['booking'], bookingTargets: [{ bookingId: 'booking', clientId: 'actor' }],
    nextParticipants: [], nextWaitlist: [], nextLeaveEvents: [],
    nextSplitPayments: [{ ...fixture().payment, status: 'EXPIRED' }],
    timedOutPayments: [{ transactionId: 'transaction', clientId: 'actor', bookingIds: ['booking'],
      paymentRef: 'pay-fixture', amountMinor: 120000 }] };
}
function startOwnerFencedTask() {
  return run('cleanup_router', { payload: ownerFencedTask() }, now, nativePaymentContract,
    { vivacrm_access_token: 'synthetic', vivacrm_token_expires_at: now + 60000 });
}
function nativeOwner(released = false) {
  const o = { _id: 'lk1-product:' + JSON.stringify(['tenant', 'actor', 'native-attempt']), operationId: 'native-attempt',
    tenantKey: 'tenant', actorClientId: 'actor', clientSubscriptionId: 'subscription', category: 'open_game',
    state: released ? 'RELEASED' : 'CONFIRMED', bookingId: 'booking', upstreamBookingId: 'booking', exerciseId: 'exercise',
    lk1: { fingerprint: 'native-fingerprint', target: { eventId: 'exercise', category: 'GAME' },
      decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 120000 } },
      transactionId: 'transaction', checkout: { transactionId: 'transaction', toPayMinor: 120000 },
      transactionIntent: { bookingId: 'booking', actorClientId: 'actor', chargeMinor: 120000 },
      paymentAttempt: { phase: released ? 'CLOSED' : 'EXPIRE_INTENT', closedAt: '2026-11-20T10:00:00Z' } } };
  if (released) o.lk1.paymentAttemptRelease = { schemaVersion: 1, binding: nativePaymentContract.paymentAttemptBinding(o),
    verifiedAt: o.lk1.paymentAttempt.closedAt, transactionState: 'UNPAID_CLOSED', bookingState: 'CANCELLED',
    creditState: 'NOT_CONSUMED', creditProof: null };
  return o;
}
test('actual timeout entry queries native ownership before even reading ordinary finance', () => {
  const r = startOwnerFencedTask();
  assert.ok(r.out[7]); assert.ok(!r.out[0]); assert.equal(r.msg.limit, 2);
  assert.deepEqual(plain(r.msg.payload), { tenantKey: 'tenant', actorClientId: 'actor', bookingId: 'booking',
    category: 'open_game' });
  assert.equal(r.msg._splitCleanupCtx.step, 'split_timeout_native_owner_found');
  const ordinary = run('cleanup_router', { ...r.out[7], payload: [], statusCode: 200 });
  assert.equal(ordinary.msg.method, 'GET'); assert.match(ordinary.msg.url, /transactions\/transaction$/);
  assert.equal(ordinary.msg._splitCleanupCtx.nativePaymentOwnerChecked, true);
});
test('active, PAID, ambiguous, unavailable or foreign native ownership forbids every cleanup provider command', () => {
  for (const variant of ['active', 'paid', 'ambiguous', 'unavailable', 'foreign', 'wrongAmount']) {
    const initial = startOwnerFencedTask(), owner = nativeOwner();
    if (variant === 'paid') owner.lk1.paymentAttempt.phase = 'PAID';
    if (variant === 'foreign') owner.actorClientId = 'other';
    if (variant === 'wrongAmount') owner.lk1.checkout.toPayMinor++;
    const r = run('cleanup_router', { ...initial.out[7], statusCode: 200, error: variant === 'unavailable',
      payload: variant === 'ambiguous' ? [owner, owner] : [owner] });
    assert.ok(!r.out[0], variant); assert.ok(!r.out[1], variant); assert.ok(!r.out[6], variant);
    assert.equal(r.msg._splitCleanupCtx?.upstreamMutationsAttempted || 0, 0, variant);
  }
});
test('native full release proof authorizes canonical roster persistence only, not finance or ordinary head release', () => {
  const initial = startOwnerFencedTask(), owner = nativeOwner(true);
  assert.equal(nativePaymentContract.paymentAttemptReleased(owner), true);
  const r = run('cleanup_router', { ...initial.out[7], statusCode: 200, payload: [owner] });
  assert.ok(r.out[1]); assert.ok(!r.out[0]); assert.ok(!r.out[6]); assert.ok(!r.out[7]);
  const financial = r.out[1].payload.$set['metadata.splitPayment.payments'][0];
  assert.equal(financial.status, 'EXPIRED'); assert.equal(financial.nativePaymentAttemptClosure.operationKey, owner._id);
  assert.equal(financial.paymentAttemptClosure, undefined);
  assert.deepEqual(plain(r.out[1]._splitCleanupWriteAck.paymentAttemptHeadClosures), []);
});
test('restored old timeout continuation must query native owner before dispatching any intent', () => {
  const ctx = cleanupCtx(); delete ctx.nativePaymentOwnerChecked;
  const r = run('cleanup_router', { _splitCleanupCtx: ctx, payload: fixture().transaction, statusCode: 200 });
  assert.ok(r.out[7]); assert.ok(!r.out[0]); assert.ok(!r.out[6]);
  assert.equal(ctx.step, 'split_timeout_native_owner_found');
});
test('restored intent ACK cannot dispatch expiry/cancellation before a native owner read', () => {
  for (const leg of ['EXPIRE', 'CANCEL']) {
    const ctx = cleanupCtx(leg); delete ctx.nativePaymentOwnerChecked;
    ctx.step = 'split_close_transaction_recheck';
    const initial = run('cleanup_router', { _splitCleanupCtx: ctx, payload: fixture().transaction, statusCode: 200 });
    assert.ok(initial.out[7]); assert.ok(!initial.out[0]); assert.ok(!initial.out[6]);
    const blocked = run('cleanup_router', { ...initial.out[7], payload: [nativeOwner()], statusCode: 200 });
    assert.ok(!blocked.out[0]); assert.ok(!blocked.out[1]); assert.ok(!blocked.out[6]);
  }
});
test('a stale game transaction locator cannot hide native ownership of the same booking', () => {
  const task = ownerFencedTask(); task.timedOutPayments[0].transactionId = 'older-transaction';
  const initial = run('cleanup_router', { payload: task }, now, nativePaymentContract,
    { vivacrm_access_token: 'synthetic', vivacrm_token_expires_at: now + 60000 });
  assert.ok(initial.out[7]); assert.equal(initial.msg.payload['lk1.checkout.transactionId'], undefined);
  const r = run('cleanup_router', { ...initial.out[7], statusCode: 200, payload: [nativeOwner()] });
  assert.ok(!r.out[0]); assert.ok(!r.out[1]); assert.ok(!r.out[6]);
});
test('late old-attempt cleanup preserves a player owned by a fresh PAID or pending generation', () => {
  for (const freshStatus of ['PAYMENT_PENDING', 'PAID']) for (const bucket of ['participants', 'waitlist']) {
    const old = { ...fixture().payment, createdAt: '2026-11-20T09:40:00Z',
      paymentAttemptHeadKey: 'booking-payment-head:fixture', deadlineAt: '2026-11-20T09:55:00Z' };
    const fresh = { ...old, bookingId: 'new-booking', transactionId: 'new-transaction', paymentRef: 'new-explicit-click',
      createdAt: '2026-11-20T09:59:00Z', deadlineAt: '2026-11-20T10:14:00Z', status: freshStatus };
    const player = { id: 'actor', bookingId: fresh.bookingId };
    const game = { id: 'game', tenantKey: 'tenant', revision: 2, status: 'PAID', payment: { paid: true },
      settings: { payMode: 'split' }, participants: [{ id: 'other' }], waitlist: [],
      metadata: { splitPayment: { enabled: true, exerciseId: 'exercise', payments: [old, fresh] }, leaveEvents: [] } };
    game[bucket].push(player);
    const r = run('cleanup_prepare', { payload: [game], _splitCleanupRequest: { nowTs: now, nowIso: new Date(now).toISOString() } });
    const task = r.msg.payload[0];
    assert.deepEqual(plain(task.nextParticipants), game.participants, freshStatus + ':' + bucket);
    assert.deepEqual(plain(task.nextWaitlist), game.waitlist, freshStatus + ':' + bucket);
    assert.deepEqual(plain(task.nextLeaveEvents), [], 'no AUTO_PAYMENT_TIMEOUT leave for the fresh generation');
    assert.equal(task.nextSplitPayments[0].status, 'EXPIRED');
    assert.equal(task.nextSplitPayments[1].status, freshStatus);
    assert.equal(task.nextSplitPayments[1].bookingId, fresh.bookingId);
  }
});

function cancellationFixture() {
  const f = fixture();
  f.payment.paymentAttemptHeadKey = contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
  const other = { ...f.payment, clientId: 'other', bookingId: 'other-booking', transactionId: 'other-transaction',
    paymentRef: 'other-ref', operationId: 'other-operation', createdAt: '2026-11-20T09:00:00Z' };
  const game = { _id: 'game-object', id: 'game', tenantKey: 'iSkq6G', revision: 2, status: 'PAID',
    settings: { payMode: 'split' }, participants: [{ id: 'actor' }, { id: 'other' }], waitlist: [],
    metadata: { splitPayment: { enabled: true, exerciseId: 'exercise', payments: [f.payment, other] }, leaveEvents: [] } };
  const request = { intent: 'cancel_payment', actorClientId: 'actor', tenantKey: 'iSkq6G', gameId: 'game',
    nowTs: now, nowIso: new Date(now).toISOString(), force: false, dryRun: false, limit: 1,
    paymentCancellation: { authorized: true, headKey: f.payment.paymentAttemptHeadKey, operationId: f.payment.operationId,
      bookingId: 'booking', transactionId: 'transaction', actorClientId: 'actor', requestedAt: new Date(now).toISOString() } };
  return { ...f, game, request };
}
test('explicit authenticated cancellation selects exactly its own checkout before 15m and never cancels the game', () => {
  for (let click = 0; click < 2; click++) {
    const f = cancellationFixture();
    const r = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
    assert.ok(r.out[0]); const tasks = r.msg.payload;
    assert.equal(tasks.length, 1); const task = tasks[0];
    assert.equal(task.mode, 'PARTICIPANT_TIMEOUT'); assert.equal(task.exerciseId, null);
    assert.deepEqual(plain(task.bookingIds), ['booking']);
    assert.equal(task.nextSplitPayments[0].status, 'EXPIRED');
    assert.equal(task.nextSplitPayments[0].cancelReason, 'USER_PAYMENT_CANCELLED');
    assert.deepEqual(plain(task.nextSplitPayments[1]), f.game.metadata.splitPayment.payments[1]);
    assert.deepEqual(plain(task.nextParticipants), [{ id: 'other' }]);
    assert.equal(task.nextLeaveEvents[0].reason, 'USER_PAYMENT_CANCELLED');
  }
});
test('early cancellation rejects untrusted, paid, duplicate, cross-actor and mismatched tuples without a task', () => {
  const mutations = [
    f => { delete f.request.paymentCancellation; },
    f => { f.request.paymentCancellation.authorized = false; },
    f => { delete f.request.actorClientId; },
    f => { f.request.paymentCancellation.actorClientId = 'other'; },
    f => { f.request.paymentCancellation.transactionId = 'different'; },
    f => { f.request.paymentCancellation.operationId = 'different'; },
    f => { f.request.paymentCancellation.headKey = 'other-head'; },
    f => { f.game.metadata.splitPayment.payments[0].status = 'PAID'; },
    f => { f.game.metadata.splitPayment.payments.push({ ...f.payment }); },
    f => { f.game.metadata.splitPayment.payments[0].bookingIds = ['booking', 'other-booking']; },
    f => { f.request.force = true; },
    f => { f.game.tenantKey = 'other'; },
  ];
  for (const mutate of mutations) {
    const f = cancellationFixture(); mutate(f);
    const r = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
    assert.equal(r.msg.statusCode, 403); assert.ok(!r.out[0]);
    assert.equal(r.msg.payload.code, 'SPLIT_PAYMENT_CANCEL_BINDING_INVALID');
  }
});
test('cancel marker hides an old metadata checkout after fresh profile and on current-head entry', () => {
  const f = cancellationFixture();
  const head = { _id: f.payment.paymentAttemptHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1',
    actorClientId: 'actor', tenantKey: 'iSkq6G', phase: 'PAYMENT_REQUIRED', payment: f.payment,
    operationId: f.payment.operationId, cancelRequestedAt: new Date(now).toISOString() };
  const ctx = { action: 'join', step: 'ordinary_attempt_profile', paymentMode: 'one_time',
    operationId: 'new-click', clientId: 'actor', clientPhone: '79990000000', exerciseId: 'exercise',
    existingSplitPayments: [f.payment] };
  let r = run('router', { _splitCtx: ctx, payload: { id: 'actor', phone: '79990000000' }, statusCode: 200 });
  assert.ok(r.out[5]); assert.ok(!r.out[0], 'metadata checkout cannot bypass fresh head read');
  r = run('router', { _splitCtx: ctx, payload: [head], statusCode: 200 });
  assert.ok(r.out[0]); assert.equal(r.msg.method, 'GET', 'a concurrent PAID result may still be read');
  r = run('router', { _splitCtx: { ...ctx, step: 'ordinary_attempt_head_found' }, payload: [head], statusCode: 200 });
  assert.ok(r.out[7]); assert.ok(!r.out[0], 'closure-receipt recovery is still allowed without exposing a URL');
  r = run('router', { _splitCtx: r.msg._splitCtx, payload: [f.game], statusCode: 200 });
  assert.ok(r.out[0]); assert.equal(r.msg.method, 'GET');
});
test('final checkout exposure rechecks cancellation committed while provider or game reads ran', () => {
  const f = cancellationFixture();
  for (const cancel of [false, true]) {
    const ctx = { action: 'create', step: 'ordinary_attempt_transaction', paymentMode: 'one_time',
      trustedPaymentActor: 'actor', ordinaryHeadKey: f.payment.paymentAttemptHeadKey,
      exerciseId: 'exercise', ordinaryResumePayment: f.payment, ordinaryResumeBooking: f.booking };
    let r = run('router', { _splitCtx: ctx, payload: f.transaction, statusCode: 200 });
    assert.ok(r.out[5]); assert.ok(!r.out[1]);
    const head = { _id: ctx.ordinaryHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'iSkq6G',
      actorClientId: 'actor', phase: 'PAYMENT_REQUIRED', payment: f.payment,
      ...(cancel ? { cancelRequestedAt: new Date(now).toISOString() } : {}) };
    r = run('router', { _splitCtx: ctx, payload: [head], statusCode: 200 });
    assert.equal(r.msg.statusCode, cancel ? 202 : 200);
    assert.equal(r.msg.payload.paymentUrl, cancel ? null : f.payment.paymentUrl);
    assert.ok(!r.out[0]); assert.ok(!r.out[6]);
  }
});

test('cancellation marker permits exact read-only PAID reconciliation but never reopens an unpaid URL', () => {
  for (const paid of [false, true]) {
    const f = cancellationFixture();
    const head = { _id: f.payment.paymentAttemptHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1',
      actorClientId: 'actor', tenantKey: 'iSkq6G', phase: 'PAYMENT_REQUIRED', payment: f.payment,
      cancelRequestedAt: new Date(now).toISOString() };
    const ctx = { action: 'join', step: 'ordinary_attempt_resume_head_found', trustedPaymentActor: 'actor',
      ordinaryHeadKey: head._id, exerciseId: 'exercise', ordinaryResumePayment: f.payment };
    let r = run('router', { _splitCtx: ctx, payload: [head], statusCode: 200 });
    assert.ok(r.out[0]); assert.equal(r.msg.method, 'GET'); assert.match(r.msg.url, /bookings\/booking$/);
    r = run('router', { _splitCtx: ctx, payload: f.booking, statusCode: 200 });
    assert.ok(r.out[0]); assert.equal(r.msg.method, 'GET'); assert.match(r.msg.url, /transactions\/transaction$/);
    if (paid) f.transaction.status = 'PAID';
    r = run('router', { _splitCtx: ctx, payload: f.transaction, statusCode: 200 });
    assert.equal(r.msg.statusCode, paid ? 200 : 202);
    assert.equal(r.msg.payload.paymentAttemptState, paid ? 'PAID' : 'CLOSING');
    assert.equal(r.msg.payload.paymentUrl, null); assert.ok(!r.out[0]); assert.ok(!r.out[6]); assert.ok(!r.out[8]);
  }
});

function nativeEarlyCancellation() {
  const f = cancellationFixture(), owner = nativeOwner(true);
  f.game.tenantKey = 'tenant'; f.request.tenantKey = 'tenant';
  delete f.payment.operationId; delete f.payment.paymentAttemptHeadKey;
  f.request.paymentCancellation = { authorized: true, nativeRelease: true, nativeOperationKey: owner._id,
    operationId: owner.operationId, bookingId: owner.bookingId, transactionId: owner.lk1.checkout.transactionId,
    actorClientId: owner.actorClientId, requestedAt: new Date(now).toISOString() };
  return { ...f, owner };
}
test('native early release finalizes the exact headless canonical row before15m without service or financial HTTP', () => {
  const f = nativeEarlyCancellation();
  const prepared = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
  assert.ok(prepared.out[0]); const task = prepared.msg.payload[0];
  assert.equal(task.nativePaymentCancelOnly, true); assert.equal(task.nativePaymentOperationKey, f.owner._id);
  assert.equal(task.exerciseId, null); assert.equal(task.timedOutPayments[0].paymentAttemptHeadKey, null);
  assert.deepEqual(plain(task.bookingIds), ['booking']);
  const lookup = run('cleanup_router', { payload: task });
  assert.ok(lookup.out[7]); assert.ok(!lookup.out[0], 'even service token/login is unnecessary for roster-only finalization');
  const done = run('cleanup_router', { ...lookup.out[7], payload: [f.owner], statusCode: 200 });
  assert.ok(done.out[1]); assert.ok(!done.out[0]); assert.ok(!done.out[6]);
  const fields = done.out[1].payload.$set;
  assert.equal(fields['metadata.splitPayment.payments'][0].status, 'EXPIRED');
  assert.equal(fields['metadata.splitPayment.payments'][0].nativePaymentAttemptClosure.operationKey, f.owner._id);
  assert.equal(fields['metadata.splitPayment.payments'][0].paymentAttemptClosure, undefined);
  assert.deepEqual(plain(fields.participants), [{ id: 'other' }]);
  assert.deepEqual(plain(done.out[1]._splitCleanupWriteAck.paymentAttemptHeadClosures), []);
});
test('native-only early roster finalization cannot fall back to ordinary finance or trust a release hint', () => {
  for (const variant of ['absent', 'active', 'paid', 'ambiguous', 'wrong-key', 'busy-job', 'bad-proof']) {
    const f = nativeEarlyCancellation();
    const prepared = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
    const lookup = run('cleanup_router', { payload: prepared.msg.payload[0] });
    if (variant === 'active') f.owner.state = 'CONFIRMED';
    if (variant === 'paid') f.owner.lk1.paymentAttempt.phase = 'PAID';
    if (variant === 'wrong-key') lookup.msg._splitCleanupCtx.nativePaymentOperationKey += ':different';
    if (variant === 'busy-job') f.owner.lk1.paymentAttempt.resourceJobKey = 'incomplete-job';
    if (variant === 'bad-proof') f.owner.lk1.paymentAttemptRelease.transactionState = 'UNKNOWN';
    const done = run('cleanup_router', { ...lookup.out[7], payload: variant === 'absent' ? []
      : variant === 'ambiguous' ? [f.owner, f.owner] : [f.owner], statusCode: 200 });
    assert.ok(!done.out[0], variant); assert.ok(!done.out[1], variant); assert.ok(!done.out[6], variant);
    assert.equal(done.msg._splitCleanupCtx.upstreamMutationsAttempted, 0, variant);
  }
});
test('native early cancellation descriptor cannot spoof operation ownership or discard a different row operation', () => {
  for (const mutate of [f => { f.request.paymentCancellation.nativeOperationKey += ':foreign'; },
    f => { f.payment.operationId = 'other-native-operation'; },
    f => { f.request.paymentCancellation.actorClientId = 'other'; }]) {
    const f = nativeEarlyCancellation(); mutate(f);
    const r = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
    assert.equal(r.msg.statusCode, 403); assert.ok(!r.out[0]);
  }
});

test('native early canonical finalization preserves a fresh generation belonging to the same actor', () => {
  for (const freshStatus of ['PAYMENT_PENDING', 'PAID']) {
    const f = nativeEarlyCancellation();
    f.game.metadata.splitPayment.payments.push({ ...f.payment, bookingId: 'new-booking', transactionId: 'new-transaction',
      paymentRef: 'fresh-generation', operationId: 'new-operation', status: freshStatus });
    const prepared = run('cleanup_prepare', { payload: [f.game], _splitCleanupRequest: f.request });
    const task = prepared.msg.payload[0];
    assert.deepEqual(plain(task.nextParticipants), f.game.participants);
    assert.deepEqual(plain(task.nextLeaveEvents), []);
    const lookup = run('cleanup_router', { payload: task });
    const done = run('cleanup_router', { ...lookup.out[7], payload: [f.owner], statusCode: 200 });
    assert.ok(done.out[1]); assert.ok(!done.out[0]);
    const fields = done.out[1].payload.$set;
    assert.deepEqual(plain(fields.participants), f.game.participants);
    assert.equal(fields['metadata.splitPayment.payments'][2].status, freshStatus);
    assert.equal(fields['metadata.splitPayment.payments'][0].status, 'EXPIRED');
  }
});

test('actual cancellation controller descriptor drives native early canonical finalization without any provider write', () => {
  const f = cancellationProtocolFixture(), op = f.op;
  op.state = 'RELEASED'; op.lk1.paymentAttempt = { phase: 'CLOSED', closedAt: new Date(cancellationAt).toISOString() };
  op.lk1.paymentAttemptRelease = { schemaVersion: 1, binding: nativePaymentContract.paymentAttemptBinding(op),
    bookingState: 'CANCELLED', transactionState: 'UNPAID_CLOSED', creditState: 'NOT_CONSUMED', creditProof: null,
    verifiedAt: op.lk1.paymentAttempt.closedAt };
  const row = f.game.metadata.splitPayment.payments[0]; delete row.operationId; delete row.paymentAttemptHeadKey;
  f.game.waitlist = [{ id: 'actor' }];
  const controller = createBookingPaymentCancellationProtocol(nativePaymentContract);
  let effect = controller.begin(f.input, { ...cancellationConfig, method: 'POST' }, cancellationAt);
  effect = controller.step(effect.state, { status: 200, body: { id: 'actor' } }, cancellationAt);
  effect = controller.step(effect.state, { status: 200, body: [op] }, cancellationAt);
  assert.equal(effect.effect.kind, 'find'); assert.equal(effect.effect.collection, 'games');
  effect = controller.step(effect.state, { status: 200, body: [f.game] }, cancellationAt);
  assert.equal(effect.effect.kind, 'cleanup'); assert.equal(effect.effect.request.paymentCancellation.nativeRelease, true);
  assert.equal(effect.effect.request.paymentCancellation.nativeOperationKey, op._id);
  const prepared = run('cleanup_prepare', { payload: [effect.effect.game], _splitCleanupRequest: effect.effect.request }, cancellationAt);
  assert.ok(prepared.out[0]); const task = prepared.msg.payload[0]; assert.equal(task.nativePaymentCancelOnly, true);
  const lookup = run('cleanup_router', { payload: task }, cancellationAt);
  assert.ok(lookup.out[7]); assert.ok(!lookup.out[0]);
  const done = run('cleanup_router', { ...lookup.out[7], statusCode: 200, payload: [op] }, cancellationAt);
  assert.ok(done.out[1]); assert.ok(!done.out[0]); assert.ok(!done.out[6]);
  const fields = done.out[1].payload.$set;
  assert.equal(fields['metadata.splitPayment.payments'][0].status, 'EXPIRED');
  assert.equal(fields['metadata.splitPayment.payments'][0].nativePaymentAttemptClosure.operationKey, op._id);
  assert.deepEqual(plain(fields.waitlist), []);
});

// Review fixes: pre-write head release, clean native refusal, replay contract, earliest deadline.
const joinKey = () => contract.splitAttemptHeadKey({ action: 'join', exerciseId: 'exercise' }, 'actor');
function ownedPrewriteCtx(extra = {}) {
  const key = joinKey();
  return { action: 'join', step: 'managed_create_preflight_complete', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryHeadOwned: true,
    ordinaryClaimToken: 'claim:fixture',
    ordinaryHead: { _id: key, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
      operationId: 'ordinary-fixture', rootOperationId: 'ordinary-fixture', generation: 0, claimToken: 'claim:fixture', phase: 'UPSTREAM_INTENT',
      createdAt: '2026-11-20T09:59:00.000Z', updatedAt: '2026-11-20T09:59:00.000Z' }, ...extra };
}
test('a refusal before any provider write durably releases only its own UPSTREAM_INTENT head, then answers', () => {
  const ctx = ownedPrewriteCtx();
  let r = run('router', { _splitCtx: ctx, payload: null, statusCode: 200 });
  assert.ok(r.out[6]); assert.ok(!r.out[0]); assert.ok(!r.out[1]);
  const [filter, update, options] = plain(r.msg.payload);
  assert.deepEqual(filter, { _id: ctx.ordinaryHeadKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor',
    tenantKey: 'iSkq6G', operationId: 'ordinary-fixture', generation: 0, claimToken: 'claim:fixture',
    phase: 'UPSTREAM_INTENT', payment: { $exists: false } });
  assert.equal(update.$set.phase, 'PREWRITE_FAILED');
  assert.equal(update.$set.prewriteFailure.code, 'MANAGED_SUBSCRIPTION_PREFLIGHT_CONTEXT_INVALID');
  assert.deepEqual(options.writeConcern, { w: 'majority', j: true });
  for (const ack of [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }, null]) {
    const c = plain(ctx);
    r = run('router', { _splitCtx: c, payload: ack, error: ack ? undefined : 'lost', statusCode: 200 });
    assert.equal(r.msg.statusCode, 409, 'original refusal is returned whatever the ACK');
    assert.equal(r.msg.payload.details.code, 'MANAGED_SUBSCRIPTION_PREFLIGHT_CONTEXT_INVALID'); assert.ok(!r.out[6]);
  }
});
test('a request that dispatched any provider write, or does not own the head, never releases it', () => {
  for (const extra of [{ ordinaryProviderWriteAt: '2026-11-20T09:59:30.000Z' }, { ordinaryHeadOwned: false },
    { operationId: 'other-operation' }]) {
    const r = run('router', { _splitCtx: ownedPrewriteCtx(extra), payload: null, statusCode: 200 });
    assert.equal(r.msg.statusCode, 409); assert.ok(!r.out[6]);
  }
  // The request builder sets the provider write marker for every non-GET call.
  const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_split_router.js', import.meta.url), 'utf8');
  assert.match(source, /if \(method !== "GET" && ctx && !ctx\.ordinaryProviderWriteAt\) ctx\.ordinaryProviderWriteAt = /);
});
test('a PREWRITE_FAILED head is reclaimed by exact CAS, even by the refused operation identity', () => {
  const key = joinKey();
  const previous = { _id: key, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: 'iSkq6G', actorClientId: 'actor',
    phase: 'PREWRITE_FAILED', operationId: 'ordinary-fixture', rootOperationId: 'ordinary-fixture', generation: 0,
    prewriteFailure: { statusCode: 503, code: null, failedAt: '2026-11-20T09:59:01.000Z' } };
  const ctx = { action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
    operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key };
  let r = run('router', { _splitCtx: ctx, payload: [previous], statusCode: 200 });
  assert.ok(r.out[6]); assert.deepEqual(plain(r.msg.payload[0].$expr.$eq[1].$literal), previous);
  assert.equal(r.msg.payload[1].$set.phase, 'UPSTREAM_INTENT'); assert.equal(r.msg.payload[1].$set.generation, 1);
  assert.equal(r.msg.payload[1].$unset.prewriteFailure, '');
  assert.equal(r.msg.payload[1].$push.history.prewriteFailure.statusCode, 503);
  for (const forged of [{ ...previous, payment: { bookingId: 'booking' } }, { ...previous, closure: {} }, { ...previous, generation: 999 }]) {
    r = run('router', { _splitCtx: { ...ctx, step: 'ordinary_attempt_head_found' }, payload: [forged], statusCode: 200 });
    assert.equal(r.msg.statusCode, 202); assert.ok(!r.out[6]);
  }
});
test('a native subscription owner refused by an explicit provider 4xx permits only the guarded one-time transfer', () => {
  const key = joinKey();
  const head = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation' };
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'FAILED', attempts: 1, upstreamAttemptedAt: '2026-11-20T09:58:00Z',
    failedAt: '2026-11-20T09:58:01Z', failure: { statusCode: 422 } };
  const ctx = () => ({ action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_native_owner_found',
    paymentMode: 'one_time', operationId: 'fresh-one-time', trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryNativeHead: head });
  const notReleased = { nativeReleased: () => false };
  let r = run('router', { _splitCtx: ctx(), payload: [owner], statusCode: 200 }, now, notReleased);
  assert.ok(r.out[6]); assert.deepEqual(plain(r.msg.payload[0].$expr.$eq[1].$literal), head);
  for (const unsafe of [{ failure: { statusCode: 503 } }, { failure: null }, { bookingId: 'booking' }, { upstreamBookingId: 'b' },
    { acceptedAt: 'x' }, { lk1: { transactionId: 'transaction' } }, { lk1: { checkout: {} } }, { lk1: { bookingAttemptedAt: 'x' } },
    { attempts: 5 }, { failedAt: null }, { state: 'CONFIRMED' }]) {
    r = run('router', { _splitCtx: ctx(), payload: [{ ...owner, ...unsafe }], statusCode: 200 }, now, notReleased);
    assert.equal(r.msg.statusCode, 202, JSON.stringify(unsafe)); assert.ok(!r.out[6]);
  }
});
test('replayed checkout and verified PAID results satisfy the client decision validator', () => {
  const toClient = raw => ({ selectedPaymentMode: raw.selectedPaymentMode, toPayMinor: raw.toPayMinor, toPay: raw.toPayMinor / 100,
    paymentRef: raw.paymentRef, operationId: raw.operationId, transactionId: raw.transactionId, exerciseId: raw.exerciseId,
    gameId: raw.gameId, bookingId: raw.bookingId, paymentUrl: raw.paymentUrl, settlementState: raw.settlementState, raw });
  const expectedJoin = { action: 'join', paymentRef: 'pay-fixture', operationId: 'ordinary-fixture', gameId: 'game' };
  const open = fixture();
  const resumeCtx = f => ({ action: 'join', step: 'ordinary_attempt_transaction', paymentMode: 'one_time', trustedPaymentActor: 'actor',
    exerciseId: 'exercise', gameId: 'game', ordinaryResumePayment: f.payment, ordinaryResumeBooking: f.booking });
  const ctx = resumeCtx(open);
  run('router', { _splitCtx: ctx, payload: open.transaction, statusCode: 200 });
  const replay = plain(ctx.ordinaryResponse);
  assert.equal(replay.settlementState, 'PAYMENT_REQUIRED'); assert.equal(replay.mode, 'join');
  assert.equal(replay.selectedPaymentMode, 'one_time');
  assert.equal(hasDeterministicSubscriptionDecision(toClient(replay), 'one_time', expectedJoin), true);
  assert.equal(hasDeterministicSubscriptionDecision(toClient({ ...replay, mode: undefined }), 'one_time', expectedJoin), false,
    'the previous replay shape is the rejected RESPONSE_CONTRACT_INVALID case');
  const paid = fixture(); paid.transaction.status = 'PAID';
  const r = run('router', { _splitCtx: resumeCtx(paid), payload: paid.transaction, statusCode: 200 });
  assert.equal(r.msg.payload.paymentAttemptState, 'PAID');
  assert.equal(hasDeterministicSubscriptionDecision(toClient(plain(r.msg.payload)), 'one_time', expectedJoin), true);
});
test('the earliest verified deadline wins: transaction readback and persisted expiry only shorten the window', () => {
  const created = '2026-11-20T09:50:00Z';
  assert.equal(contract.splitAttemptWindow(null, { createDate: created }, undefined,
    { createDate: created, paymentDueDate: '2026-11-20T09:55:00Z' }).expiresAt, '2026-11-20T09:55:00.000Z');
  assert.equal(contract.splitAttemptWindow(null, { createDate: created, paymentDueDate: '2026-11-20T09:57:00Z' }, undefined,
    { paymentDueDate: '2026-11-20T10:30:00Z' }).expiresAt, '2026-11-20T09:57:00.000Z');
  const f = fixture();
  f.payment.expiresAt = '2026-11-20T09:55:00Z'; f.payment.deadlineAt = '2026-11-20T09:55:00Z';
  delete f.transaction.paymentDueDate;
  assert.equal(contract.splitAttemptWindow(f.payment, f.transaction).expiresAt, '2026-11-20T09:55:00.000Z');
  const resumed = contract.splitAttemptResume(f.payment, f.transaction, f.booking, 'actor', 'exercise', now);
  assert.equal(resumed.state, 'CLOSING', 'a readback without paymentDueDate cannot reopen an expired checkout');
  assert.equal(resumed.window.expiresAt, '2026-11-20T09:55:00.000Z');
});

// Fence for the FAILED-native transfer: the gateway can restart a FAILED attempt
// (lk1ReclaimableAttempt) after reading its still-native head.
function fencedTransfer() {
  const key = joinKey();
  const head = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation', createdAt: '2026-11-20T09:57:00Z' };
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'FAILED', attempts: 1, upstreamAttemptedAt: '2026-11-20T09:58:00Z',
    failedAt: '2026-11-20T09:58:01Z', failure: { statusCode: 422 }, lk1: { target: { eventId: 'exercise' } } };
  const ctx = { action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_native_owner_found',
    paymentMode: 'one_time', operationId: 'fresh-one-time', trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryNativeHead: head };
  const notReleased = { nativeReleased: () => false };
  const claim = run('router', { _splitCtx: ctx, payload: [plain(owner)], statusCode: 200 }, now, notReleased);
  assert.ok(claim.out[6]); assert.ok(ctx.ordinaryNativeFence);
  const won = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 }, now, notReleased);
  return { key, head, owner, ctx, won, notReleased };
}
test('FAILED-native transfer re-reads the exact owner before it may own the head or reach the provider', () => {
  const { owner, ctx, won, notReleased } = fencedTransfer();
  assert.ok(won.out[5]); assert.deepEqual(plain(won.msg.payload), { _id: 'native-key' });
  assert.notEqual(ctx.ordinaryHeadOwned, true, 'no ownership, so no pre-write retirement, before the fence');
  // Unchanged owner (field order is irrelevant) releases the fence.
  const reordered = Object.fromEntries(Object.entries(plain(owner)).reverse());
  const r = run('router', { _splitCtx: ctx, payload: [reordered], statusCode: 200 }, now, notReleased);
  assert.equal(ctx.ordinaryNativeFence, undefined);
  assert.ok(ctx.step !== 'ordinary_attempt_native_fence_restored');
  assert.ok(!(r.out[6] && r.msg.payload?.[1]?.$pop), 'the head is not handed back');
});
test('a gateway restart racing the transfer hands the head back exactly and answers pending', () => {
  for (const changed of [o => ({ ...o, state: 'PREPARED', attempts: 2, reclaimedAt: '2026-11-20T09:59:30Z' }), () => null, 'error']) {
    const { key, head, owner, ctx, notReleased } = fencedTransfer();
    const claimed = plain(ctx.ordinaryHead);
    const message = changed === 'error' ? { _splitCtx: ctx, error: 'unavailable', payload: null, statusCode: 503 }
      : { _splitCtx: ctx, payload: changed(plain(owner)) ? [changed(plain(owner))] : [], statusCode: 200 };
    let r = run('router', message, now, notReleased);
    assert.ok(r.out[6]); assert.notEqual(ctx.ordinaryHeadOwned, true);
    const [filter, update, options] = plain(r.msg.payload);
    assert.deepEqual(filter, { _id: key, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', operationId: 'fresh-one-time',
      generation: claimed.generation, claimToken: claimed.claimToken, phase: 'UPSTREAM_INTENT', payment: { $exists: false } });
    assert.deepEqual(update.$set, Object.fromEntries(Object.entries(head).filter(([k]) => k !== '_id')));
    for (const k of ['operationId', 'rootOperationId', 'generation', 'claimToken', 'phase', 'updatedAt']) assert.equal(update.$unset[k], '', k);
    assert.deepEqual(update.$pop, { history: 1 }); assert.deepEqual(options.writeConcern, { w: 'majority', j: true });
    // Applying the restore to the stored transfer result reproduces the native head.
    const stored = { ...claimed, history: [head] }; delete stored.history[0].history;
    for (const k of Object.keys(update.$unset)) delete stored[k];
    Object.assign(stored, update.$set); stored.history.pop();
    assert.deepEqual({ ...stored, history: undefined }, { ...head, history: undefined });
    for (const ack of [{ acknowledged: true, matchedCount: 1, modifiedCount: 1 }, null]) {
      r = run('router', { _splitCtx: { ...ctx }, payload: ack, error: ack ? undefined : 'lost', statusCode: 200 }, now, notReleased);
      assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null); assert.ok(!r.out[0]); assert.ok(!r.out[6]);
    }
  }
});
test('a lost transfer ACK is resolved by reading our own head, then the same owner fence', () => {
  const key = joinKey();
  const { ctx, notReleased } = (() => {
    const f = fencedTransfer(); return f; })();
  const generation = ctx.ordinaryNativeFence.generation;
  ctx.step = 'ordinary_attempt_head_found';
  const stored = { ...plain(ctx.ordinaryHead), history: [{ kind: 'BOOKING_PAYMENT_HEAD_V1' }] };
  const r = run('router', { _splitCtx: ctx, payload: [stored], statusCode: 200 }, now, notReleased);
  assert.equal(ctx.step, 'ordinary_attempt_native_fence_read'); assert.ok(r.out[5]);
  assert.equal(ctx.ordinaryNativeFence.generation, generation); assert.equal(stored._id, key);
  // A head with any other identity drops the fence and stays on the ordinary rules.
  const other = { ...stored, operationId: 'someone-else' };
  ctx.step = 'ordinary_attempt_head_found';
  const o = run('router', { _splitCtx: ctx, payload: [other], statusCode: 200 }, now, notReleased);
  assert.equal(o.msg.statusCode, 202); assert.equal(ctx.ordinaryNativeFence, undefined);
});
test('a terminal native release keeps the direct transfer without an owner fence', () => {
  const key = joinKey();
  const head = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation' };
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'RELEASED' };
  const ctx = { action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_native_owner_found', paymentMode: 'one_time',
    operationId: 'fresh-one-time', trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryNativeHead: head };
  const released = { nativeReleased: op => op.state === 'RELEASED' };
  run('router', { _splitCtx: ctx, payload: [owner], statusCode: 200 }, now, released);
  assert.equal(ctx.ordinaryNativeFence, undefined);
  run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 }, now, released);
  assert.notEqual(ctx.step, 'ordinary_attempt_native_fence_read');
});
test('the clean-refusal rule is never wider than the gateway reclaim rule, and is strictly narrower where ambiguous', () => {
  const g = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const start = g.indexOf('const lk1ReclaimIsRecord');
  const end = g.indexOf('\n};', g.indexOf('const lk1ReclaimableAttempt')) + 3;
  assert.ok(start > 0 && end > start);
  const gateway = new Function(g.slice(start, end) + '\nreturn lk1ReclaimableAttempt;')();
  const base = { state: 'FAILED', attempts: 1, upstreamAttemptedAt: 't', failedAt: 't', failure: { statusCode: 422 } };
  const variants = [{}, { attempts: 4 }, { attempts: 5 }, { attempts: '9' }, { failure: { statusCode: 400 } }, { failure: { statusCode: 499 } },
    { failure: { statusCode: 500 } }, { failure: { statusCode: '409' } }, { failure: { statusCode: 409.5 } }, { failure: null }, { failure: [] },
    { failedAt: '' }, { upstreamAttemptedAt: null }, { upstreamAttemptedAt: 5 }, { bookingId: 'b' }, { bookingId: 0 }, { bookingId: ' ' },
    { upstreamBookingId: 'b' }, { acceptedAt: 'x' }, { correlationId: 'c' }, { lk1: { createAttemptedAt: 'x' } },
    { lk1: { bookingAttemptedAt: 'x' } }, { lk1: { transactionAttemptedAt: 'x' } }, { lk1: { transactionId: 7 } },
    { lk1: { transactionIntent: {} } }, { lk1: { checkout: {} } }, { lk1: { visitJob: {} } }, { lk1: { checkout: [] } }, { lk1: 'x' },
    { state: 'PREPARED' }, { state: 'PREPARED', upstreamAttemptedAt: null }, { state: 'CONFIRMED' }, { state: 'RELEASED' }];
  const narrower = [{ failure: { statusCode: 408 } }, { failure: { statusCode: 409 } }, { failure: { statusCode: 429 } },
    { failure: { statusCode: 451 } }, { transactionId: 'transaction' }, { managedEntitlementOperationId: 'entitlement' },
    { managedJoinV2: true }, { managedJoinV2: { id: 'x' } }, { lk1: { unpaidCancellation: { at: 'x' } } },
    { lk1: { freeCancellationReturn: { at: 'x' } } }, { lk1: { paymentAttempt: { state: 'X' } } },
    { state: 'PREPARED', upstreamAttemptedAt: null },
    // Canonical untouched-refusal fields (lk1DailyGuardRepair): legacy-LK2 and managed lines own these.
    { lk2LegacyJoin: true }, { managedSubscriptionInstanceId: 'instance' }, { activationState: 'PENDING' }];
  // 408/409/429/451 stay ambiguous exactly as booking_create keeps them (fn_subscription_booking_router.js).
  for (const v of [...variants, ...narrower]) {
    const op = { ...base, ...v };
    if (contract.splitAttemptNativeCleanRefusal(op)) assert.equal(gateway(op), true, 'wider than gateway: ' + JSON.stringify(v));
  }
  for (const v of narrower) assert.equal(contract.splitAttemptNativeCleanRefusal({ ...base, ...v }), false, JSON.stringify(v));
  for (const status of contract.SPLIT_NATIVE_CLEAN_REFUSAL_STATUSES) {
    assert.equal(contract.splitAttemptNativeCleanRefusal({ ...base, failure: { statusCode: status } }), true, String(status));
  }
});

// Review F1: ownership is a server claim token, so a duplicate request with the
// same client operationId/paymentRef and the same generation can never own the head.
const matchesFilter = (filter, doc) => Object.entries(filter).every(([k, v]) =>
  v && typeof v === 'object' && '$exists' in v ? (doc[k] !== undefined) === v.$exists : JSON.stringify(doc[k]) === JSON.stringify(v));
test('duplicate requests with one operationId: exactly one reaches the provider, the loser cannot fence, restore or retire', () => {
  const key = joinKey();
  const nativeHead = { _id: key, kind: 'BOOKING_PAYMENT_HEAD_V1', actorClientId: 'actor', tenantKey: 'iSkq6G',
    ownerOperationKey: 'native-key', ownerOperationId: 'native-operation' };
  const owner = { _id: 'native-key', operationId: 'native-operation', actorClientId: 'actor', tenantKey: 'iSkq6G',
    exerciseId: 'exercise', state: 'FAILED', attempts: 1, upstreamAttemptedAt: '2026-11-20T09:58:00Z',
    failedAt: '2026-11-20T09:58:01Z', failure: { statusCode: 422 } };
  const notReleased = { nativeReleased: () => false };
  const start = () => ({ action: 'join', exerciseId: 'exercise', step: 'ordinary_attempt_native_owner_found',
    paymentMode: 'one_time', operationId: 'same-payment-ref', trustedPaymentActor: 'actor', ordinaryHeadKey: key, ordinaryNativeHead: nativeHead });
  const A = start(), B = start();
  run('router', { _splitCtx: A, payload: [plain(owner)], statusCode: 200 }, now, notReleased);
  run('router', { _splitCtx: B, payload: [plain(owner)], statusCode: 200 }, now, notReleased);
  assert.equal(A.ordinaryHead.generation, B.ordinaryHead.generation, 'same generation: only the token differs');
  assert.notEqual(A.ordinaryClaimToken, B.ordinaryClaimToken);
  const liveA = { ...plain(A.ordinaryHead), history: [nativeHead] };
  // A wins the transfer CAS; B loses and reads A's live head.
  run('router', { _splitCtx: A, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 }, now, notReleased);
  let r = run('router', { _splitCtx: B, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 }, statusCode: 200 }, now, notReleased);
  assert.ok(r.out[5]);
  r = run('router', { _splitCtx: B, payload: [plain(liveA)], statusCode: 200 }, now, notReleased);
  assert.equal(r.msg.statusCode, 202); assert.ok(!r.out[6]); assert.ok(!r.out[0]);
  assert.notEqual(B.ordinaryHeadOwned, true); assert.notEqual(B.step, 'ordinary_attempt_native_fence_read');
  // A passes its fence and owns the head.
  run('router', { _splitCtx: A, payload: [plain(owner)], statusCode: 200 }, now, notReleased);
  assert.equal(A.ordinaryHeadOwned === true || A.step === 'ordinary_attempt_prewrite_released', true);
  // Even a forced B restore or retire could not match A's live head.
  const forcedB = { ...B, ordinaryHead: plain(B.ordinaryHead), ordinaryNativeFence: { owner, head: nativeHead, generation: B.ordinaryHead.generation },
    step: 'ordinary_attempt_native_fence_read' };
  const neverHitsLiveA = (res, label) => assert.ok(!res.out[6] || !matchesFilter(plain(res.msg.payload[0]), liveA), label);
  // B now holds A's head as read: the token guard refuses before any filter is built.
  r = run('router', { _splitCtx: forcedB, payload: [], statusCode: 200 }, now, notReleased);
  neverHitsLiveA(r, 'restore never touches the live head'); assert.ok(!r.out[6]);
  // Even with B's own claimed head object, the claim-token filter misses A's head.
  const forcedOwnB = { ...forcedB, ordinaryHead: { ...plain(liveA), claimToken: B.ordinaryClaimToken }, step: 'ordinary_attempt_native_fence_read' };
  r = run('router', { _splitCtx: forcedOwnB, payload: [], statusCode: 200 }, now, notReleased);
  assert.ok(r.out[6]); neverHitsLiveA(r, 'restore filter misses the live head');
  for (const head of [plain(liveA), { ...plain(liveA), claimToken: B.ordinaryClaimToken }]) {
    const retiringB = { ...ownedPrewriteCtx(), operationId: 'same-payment-ref', ordinaryHeadKey: key,
      ordinaryClaimToken: B.ordinaryClaimToken, ordinaryHead: head };
    r = run('router', { _splitCtx: retiringB, payload: null, statusCode: 200 });
    neverHitsLiveA(r, 'retire never touches the live head');
  }
  // A's own commands match its live head.
  const retiringA = { ...ownedPrewriteCtx(), operationId: 'same-payment-ref', ordinaryHeadKey: key,
    ordinaryClaimToken: A.ordinaryClaimToken, ordinaryHead: { ...plain(A.ordinaryHead) } };
  r = run('router', { _splitCtx: retiringA, payload: null, statusCode: 200 });
  assert.equal(matchesFilter(plain(r.msg.payload[0]), liveA), true);
});
test('restore matches only our untouched claim: every other head writer changes a filtered field', () => {
  const { ctx, notReleased } = fencedTransfer();
  const ours = { ...plain(ctx.ordinaryHead), history: [{ kind: 'BOOKING_PAYMENT_HEAD_V1' }] };
  const r = run('router', { _splitCtx: ctx, payload: [], statusCode: 200 }, now, notReleased);
  const filter = plain(r.msg.payload[0]);
  assert.equal(matchesFilter(filter, ours), true);
  const writers = {
    anotherClaim: { ...ours, claimToken: 'claim:other', generation: ours.generation + 1, history: [...ours.history, { x: 1 }] },
    checkoutSaved: { ...ours, phase: 'PAYMENT_REQUIRED', payment: { bookingId: 'b' } },
    prewriteRetired: { ...ours, phase: 'PREWRITE_FAILED' },
    gatewayTransfer: { ...ours, kind: 'BOOKING_PAYMENT_HEAD_V1', phase: undefined, history: [...ours.history, { y: 1 }] },
    closure: { ...ours, phase: 'CLOSED' },
  };
  for (const [name, doc] of Object.entries(writers)) assert.equal(matchesFilter(filter, doc), false, name);
});

test('claim tokens use the sandbox crypto from global context when present, else a unique fallback', async () => {
  const { webcrypto } = await import('node:crypto');
  const claim = globals => {
    const key = joinKey();
    const ctx = { action: 'join', step: 'ordinary_attempt_head_found', paymentMode: 'one_time',
      operationId: 'ordinary-fixture', trustedPaymentActor: 'actor', ordinaryHeadKey: key, exerciseId: 'exercise' };
    run('router', { _splitCtx: ctx, payload: [], statusCode: 200 }, now, nativePaymentContract, globals);
    return ctx.ordinaryClaimToken;
  };
  assert.match(claim({ crypto: webcrypto }), /^claim:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  const fallback = new Set(Array.from({ length: 200 }, () => claim({})));
  assert.equal(fallback.size, 200);
  for (const token of fallback) assert.match(token, /^claim:[0-9a-z]+:[0-9a-z]+:[0-9a-z]+:[0-9a-z]+$/);
  const throwing = new Proxy({}, { get() { throw new Error('context store unavailable'); } });
  assert.match(claim(throwing), /^claim:/);
});
