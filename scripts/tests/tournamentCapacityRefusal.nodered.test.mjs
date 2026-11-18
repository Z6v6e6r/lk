import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { patchTournamentCapacityRouter } from '../patch_live_tournament_capacity_refusal.mjs';

const router = new Function('msg', 'global', patchTournamentCapacityRouter(fs.readFileSync(
  'scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js', 'utf8')));
const finalizer = new Function('msg', 'global', `
  const ctx = msg._subscriptionBooking, payload = msg.payload;
  const responseStatus = Number(msg.statusCode) || 0;
  ${fs.readFileSync('scripts/nodered_lk1_hub_nodes/finalize.js', 'utf8')}
  return [null, msg];
`);
const context = () => ({ caller: 'http', action: 'book', step: 'booking_create',
  managedAction: 'BOOK_TOURNAMENT', category: 'tournament', tenantKey: 'fixture',
  operationKey: 'fixture-operation-key', operationId: 'fixture-operation',
  actorClientId: 'fixture-actor', clientSubscriptionId: 'fixture-subscription',
  exerciseId: 'fixture-event', lk1: { fingerprint: 'fixture-fingerprint',
    target: { eventId: 'fixture-event', category: 'TOURNAMENT' } } });
const ack = () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1,
  upsertedCount: 0, upsertedId: null });
function runtime() {
  const values = new Map();
  return { values, get: key => values.get(key), set: (key, value) => values.set(key, value) };
}
function refuse(ctx = context(), overrides = {}) {
  const msg = { _subscriptionBooking: ctx, statusCode: 409,
    payload: { code: 'CONFLICT', message: 'Нет свободных мест' }, ...overrides };
  router(msg, runtime());
  return msg;
}
function persist(msg, result = ack(), error) {
  msg.payload = result;
  msg.error = error;
  router(msg, runtime());
  return msg;
}

test('capacity refusal is fenced, durably acknowledged and preserved; roster epoch advances', () => {
  const msg = refuse();
  assert.equal(msg._subscriptionBooking.step, 'operation_fail');
  const [query, update] = msg.payload;
  assert.deepEqual(query.$and, [{ state: 'PENDING_CONFIRMATION' }]);
  assert.equal(query['lk1.fingerprint'], 'fixture-fingerprint');
  for (const key of ['acceptedAt', 'correlationId', 'bookingId', 'upstreamBookingId']) {
    assert.deepEqual(query[key], { $in: [null, ''] });
  }
  for (const key of ['createAttemptedAt', 'bookingAttemptedAt', 'transactionAttemptedAt',
    'transactionId', 'transactionIntent', 'checkout', 'visitJob', 'unpaidCancellation']) {
    assert.deepEqual(query[`lk1.${key}`], { $exists: false });
  }
  assert.equal(update.$set.state, 'FAILED');
  persist(msg);
  assert.equal(msg.statusCode, 409);
  assert.equal(msg.payload.details.code, 'CAPACITY_FULL');
  const global = runtime();
  finalizer(msg, global);
  assert.equal(msg.statusCode, 409);
  assert.equal(msg.payload.error, 'Нет свободных мест');
  assert.deepEqual(global.get('lkTournamentParticipantEpochV1'), { 'fixture-event': 1 });
});

test('missing, malformed, zero or failed persistence acknowledgement stays pending', () => {
  for (const [result, error] of [[{}, null], [ack(), new Error('store unavailable')],
    [{ ...ack(), acknowledged: false }, null], [{ ...ack(), matchedCount: 0, modifiedCount: 0 }, null],
    [{ ...ack(), modifiedCount: 0 }, null]]) {
    const msg = persist(refuse(), result, error);
    finalizer(msg, runtime());
    assert.equal(msg.statusCode, 202);
    assert.equal(msg.payload.state, 'PENDING_CONFIRMATION');
  }
});

test('binding drift between the provider refusal and acknowledgement stays pending', () => {
  for (const field of ['operationId', 'operationKey', 'actorClientId', 'clientSubscriptionId', 'exerciseId']) {
    const msg = refuse();
    msg._subscriptionBooking[field] = 'different';
    persist(msg);
    finalizer(msg, runtime());
    assert.equal(msg.statusCode, 202, field);
  }
});

test('generic conflicts, timeouts, throttling, transport failures and 5xx never prove capacity', () => {
  for (const overrides of [
    { payload: { code: 'CONFLICT', message: 'Другая причина' } },
    { payload: { code: 'OTHER', message: 'Нет свободных мест' } },
    { error: new Error('transport failure') },
    ...[408, 429, 500, 503].map(statusCode => ({ statusCode })),
  ]) {
    const msg = refuse(context(), overrides);
    assert.equal(msg._subscriptionBooking.lk1CapacityRefusal, undefined);
    if (msg._subscriptionBooking.step === 'operation_fail') persist(msg);
    finalizer(msg, runtime());
    assert.equal(msg.statusCode, 202);
  }
});

test('accepted, entitlement, create, payment and visit evidence disables the terminal capacity path', () => {
  for (const field of ['confirmedBookingId', 'immediateBookingId', 'correlationId', 'acceptedAt',
    'bookingId', 'upstreamBookingId', 'precreatedEntitlementReserved', 'managedEntitlementOperationId',
    'lk1BeforeCreate']) {
    const ctx = context();
    ctx[field] = 'present';
    const msg = refuse(ctx);
    assert.equal(msg._subscriptionBooking.lk1CapacityRefusal, undefined, field);
  }
  for (const field of ['createAttemptedAt', 'bookingAttemptedAt', 'transactionAttemptedAt',
    'transactionId', 'transactionIntent', 'checkout', 'visitJob', 'unpaidCancellation']) {
    const ctx = context();
    ctx.lk1[field] = 'present';
    const msg = refuse(ctx);
    assert.equal(msg._subscriptionBooking.lk1CapacityRefusal, undefined, field);
  }
});

test('a public CAPACITY_FULL payload without the bound persisted proof stays pending', () => {
  for (const marker of [undefined, { persisted: true, binding: 'forged' }]) {
    const ctx = context();
    ctx.step = 'operation_fail';
    ctx.lk1CapacityRefusal = marker;
    const global = runtime();
    const msg = { _subscriptionBooking: ctx, statusCode: 409,
      payload: { error: 'Нет свободных мест', details: { code: 'CAPACITY_FULL' } } };
    finalizer(msg, global);
    assert.equal(msg.statusCode, 202);
    assert.equal(global.values.size, 0);
  }
});
