import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import * as contract from '../lib/splitBookingPaymentAttempt.mjs';
import * as nativePaymentContract from '../lib/bookingPaymentAttempt.mjs';

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
  r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, upsertedCount: 0, matchedCount: 1, modifiedCount: 0 }, statusCode: 200 });
  assert.ok(r.out[5]); assert.ok(!r.out[0]);
  r = run('router', { _splitCtx: ctx, payload: [head], statusCode: 200 });
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
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
    operationId: 'ordinary-fixture', ordinaryResponse: { paymentUrl: 'https://pay.vivacrm.ru/fixture',
      bookingId: 'booking', transactionId: 'transaction', expiresAt: '2026-11-20T10:05:00Z' } };
  let r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 }, statusCode: 200 });
  assert.equal(r.msg.statusCode, 202); assert.equal(r.msg.payload.paymentUrl, null);
  r = run('router', { _splitCtx: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 }, statusCode: 200 }, now + 5 * 60000);
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
  const ctx = { action: 'join', step: 'ordinary_attempt_pending_game_found', paymentMode: 'one_time',
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
