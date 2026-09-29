import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLk1Transaction, classifyLk1Booking, eligibleLk1UnpaidOperation,
  reconcileLk1UnpaidBooking, createLk1VivaCancellationProvider,
  buildLk1UnpaidScanQuery } from '../lib/lk1UnpaidBookingCancellation.mjs';

const instant = '2099-01-01T12:01:00.000Z';
const cohort = '2099-01-01T00:00:00.000Z';
const fixture = () => {
  const op = { tenantKey: 'fixture', actorClientId: 'actor', operationId: 'fixture-operation',
    action: 'BOOK_GROUP_TRAINING', category: 'group_training', clientSubscriptionId: 'subscription',
    exerciseId: 'exercise', bookingId: 'booking', upstreamBookingId: 'booking', state: 'CONFIRMED',
    createdAt: '2099-01-01T11:00:00.000Z', updatedAt: '2099-01-01T11:01:00.000Z',
    lk1: { fingerprint: 'fixture-fingerprint', transactionId: 'transaction',
      transactionAttemptedAt: '2099-01-01T11:01:00.000Z',
      target: { eventId: 'exercise', category: 'GROUP_TRAINING', stationId: 'station', startsAt: '2099-01-01T13:00:00.000Z' },
      decision: { subscriptionVisitCount: 0, benefit: { kind: 'PERCENT_DISCOUNT', finalPriceMinor: 275000 } },
      transactionIntent: { productId: 'service', bookingId: 'booking', actorClientId: 'actor',
        studioId: 'station', chargeMinor: 275000, discountMinor: 275000 },
      checkout: { transactionId: 'transaction', toPayMinor: 275000, paymentUrl: 'https://pay.example.test/fixture' } } };
  op._id = `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`;
  const transaction = { id: 'transaction', status: 'UNPAID', toPay: 275000,
    paymentDueDate: '2099-01-01T11:58:00.000Z', cardPaymentInfo: { status: 'NEW' } };
  const booking = { id: 'booking', clientId: 'actor', exerciseId: 'exercise',
    paymentType: 'ON_PLACE', isCancelled: false };
  return { op, transaction, booking };
};

function fakeStore(initial) {
  const row = structuredClone(initial), calls = [];
  return { row, calls, async updateOne(query, update, options) {
    calls.push({ query, update, options });
    if (query._id !== row._id || query.state !== row.state || query.bookingId !== row.bookingId
      || query['lk1.checkout.transactionId'] !== row.lk1.checkout.transactionId
      || (Object.hasOwn(query, 'updatedAt') && query.updatedAt !== row.updatedAt)
      || (query['lk1.unpaidCancellation']?.$exists === false && row.lk1.unpaidCancellation)
      || (query['lk1.unpaidCancellation.phase'] && query['lk1.unpaidCancellation.phase'] !== row.lk1.unpaidCancellation?.phase)
      || (query['lk1.unpaidCancellation.attemptedAt'] && query['lk1.unpaidCancellation.attemptedAt'] !== row.lk1.unpaidCancellation?.attemptedAt)) {
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }
    for (const [path, value] of Object.entries(update.$set)) {
      const keys = path.split('.'); let target = row;
      for (const key of keys.slice(0, -1)) target = target[key] ||= {};
      target[keys.at(-1)] = structuredClone(value);
    }
    return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  } };
}

function fakeProvider(seed) {
  const state = structuredClone(seed), calls = [];
  return { state, calls,
    async readTransaction() { calls.push('transaction'); return structuredClone(state.transaction); },
    async readBooking() { calls.push('booking'); return structuredClone(state.booking); },
    async readCancelOptions() { calls.push('options'); return { bookingId: 'booking',
      cancellationOptions: { cancellationOnly: { available: state.cancelAvailable !== false } } }; },
    async cancelBooking() { calls.push('cancel'); if (state.cancelSucceeds !== false) state.booking.isCancelled = true;
      return { status: state.cancelSucceeds === false ? 503 : 200 }; },
  };
}

const run = (op, store, provider, mode = 'ENFORCE_NEW') => reconcileLk1UnpaidBooking({
  op, operations: store, provider, cohortFrom: cohort, mode, now: () => instant });

test('only a post-cutoff LK1 money event with no visit debit is eligible', () => {
  const { op } = fixture();
  assert.equal(eligibleLk1UnpaidOperation(op, cohort, instant).reason, 'ELIGIBLE');
  for (const mutate of [
    row => { row.createdAt = '2098-12-31T23:59:59.999Z'; },
    row => { row.lk1.decision.subscriptionVisitCount = 1; },
    row => { delete row.lk1.checkout; },
    row => { row.lk1.transactionIntent.bookingId = 'other'; },
    row => { row.category = 'open_game'; },
    row => { row.lk1.target.startsAt = '2099-01-01T12:00:00.000Z'; },
  ]) {
    const changed = structuredClone(op); mutate(changed);
    assert.notEqual(eligibleLk1UnpaidOperation(changed, cohort, instant).reason, 'ELIGIBLE');
  }
});

test('scan cutoff is normalized to UTC before the Mongo string comparison', () => {
  const query = buildLk1UnpaidScanQuery({ tenantKey: 'fixture', cohortFrom: '2099-01-01T15:00:00+03:00' });
  assert.equal(query.createdAt.$gte, '2099-01-01T12:00:00.000Z');
  assert.throws(() => buildLk1UnpaidScanQuery({ tenantKey: 'fixture', cohortFrom: '2099-02-30T12:00:00Z' }),
    /COHORT_OR_TENANT_INVALID/);
});

test('transaction requires exact UNPAID, due date, amount and supplied aliases', () => {
  const { op, transaction } = fixture();
  assert.equal(classifyLk1Transaction(op, transaction, instant).reason, 'DUE');
  for (const change of [{ status: 'PAID' }, { status: 'WAITING' }, { status: 'PARTIALLY_PAID' },
    { paymentDueDate: undefined }, { paymentDueDate: '2099-01-01T12:00:30.000Z' },
    { paymentDueDate: '2099-02-30T11:58:00.000Z' },
    { clientId: 'other' }, { bookingIds: ['other'] }, { exerciseId: 'other' },
    { toPay: 1 }, { id: 'other' },
    { paymentDate: '2099-01-01T12:00:00.000Z' }, { currency: 'USD' },
    { cardPaymentInfo: { status: 'PAID' } }, { cardPaymentStatus: { status: 'PARTIALLY_PAID' } },
    { paidAmountMinor: 100 }, { cardPaymentInfo: { status: 'NEW', paidAmountMinor: 100 } }]) {
    assert.notEqual(classifyLk1Transaction(op, { ...transaction, ...change }, instant).reason, 'DUE');
  }
});

test('booking requires exact owner, exercise, ON_PLACE carrier and explicit cancellation proof', () => {
  const { op, booking } = fixture();
  assert.equal(classifyLk1Booking(op, booking).reason, 'ACTIVE');
  assert.equal(classifyLk1Booking(op, { ...booking, isCancelled: true }).reason, 'CANCELLED');
  for (const change of [{ clientId: 'other' }, { exerciseId: 'other' }, { id: 'other' },
    { paymentType: 'SUBSCRIPTION' }, { isCancelled: null },
    { isCancelled: false, status: 'CANCELLED' }, { transactionStatus: 'PAID' },
    { pendingPayments: [{}] }, { paidAt: '2099-01-01T12:00:00.000Z' }]) {
    assert.notEqual(classifyLk1Booking(op, { ...booking, ...change }).reason, 'ACTIVE');
  }
});

test('shadow performs fresh readbacks without Viva or Mongo mutation', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  assert.deepEqual(await run(seed.op, store, provider, 'SHADOW'), { state: 'ELIGIBLE' });
  assert.deepEqual(provider.calls, ['transaction', 'booking', 'options']);
  assert.equal(store.calls.length, 0);
});

test('expired UNPAID cancels once with durable intent and releases only after readback', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  assert.deepEqual(await run(seed.op, store, provider), { state: 'CANCELLED' });
  assert.equal(provider.calls.filter(call => call === 'cancel').length, 1);
  assert.equal(store.calls.length, 2);
  assert.equal(store.calls[0].update.$set['lk1.unpaidCancellation'].phase, 'INTENT');
  assert.deepEqual(store.calls[0].options, { writeConcern: { w: 'majority', j: true } });
  assert.equal(store.row.state, 'RELEASED');
  assert.equal(store.row.releaseReason, 'LK1_UNPAID_CHECKOUT_EXPIRED');
  assert.equal((await run(store.row, store, provider)).state, 'SKIPPED');
});

test('paid, unknown deadline, missing cancel-only and CAS loss never cancel', async () => {
  for (const change of [seed => { seed.transaction.status = 'PAID'; },
    seed => { delete seed.transaction.paymentDueDate; },
    seed => { seed.cancelAvailable = false; }]) {
    const seed = fixture(); change(seed);
    const store = fakeStore(seed.op), provider = fakeProvider(seed);
    assert.equal((await run(seed.op, store, provider)).state, 'SKIPPED');
    assert.equal(provider.calls.includes('cancel'), false);
    assert.equal(store.calls.length, 0);
  }
  const seed = fixture(), provider = fakeProvider(seed);
  const lost = { async updateOne() { return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; } };
  assert.deepEqual(await run(seed.op, lost, provider), { state: 'RETRY_STORE' });
  assert.equal(provider.calls.includes('cancel'), false);
});

test('ambiguous cancel remains for review and never repeats the PUT', async () => {
  const seed = fixture(); seed.cancelSucceeds = false;
  const store = fakeStore(seed.op), provider = fakeProvider(seed);
  assert.deepEqual(await run(seed.op, store, provider), { state: 'REVIEW', reason: 'CANCEL_OUTCOME_UNKNOWN' });
  assert.equal(store.row.state, 'CONFIRMED');
  assert.equal(store.row.lk1.unpaidCancellation.phase, 'REVIEW');
  assert.equal(provider.calls.filter(call => call === 'cancel').length, 1);
  assert.equal((await run(store.row, store, provider)).state, 'SKIPPED');
});

test('payment arriving on the second read stops before Viva cancellation', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  let reads = 0;
  provider.readTransaction = async () => {
    reads += 1;
    return { ...seed.transaction, status: reads === 1 ? 'UNPAID' : 'PAID' };
  };
  assert.deepEqual(await run(seed.op, store, provider), { state: 'REVIEW', reason: 'PAID' });
  assert.equal(provider.calls.includes('cancel'), false);
  assert.equal(store.row.state, 'CONFIRMED');
});

test('loss of cancellation-only option after intent stops before Viva cancellation', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  let probes = 0;
  provider.readCancelOptions = async () => ({ bookingId: 'booking',
    cancellationOptions: { cancellationOnly: { available: ++probes === 1 } } });
  assert.deepEqual(await run(seed.op, store, provider), {
    state: 'REVIEW', reason: 'CANCELLATION_ONLY_UNAVAILABLE' });
  assert.equal(provider.calls.includes('cancel'), false);
  assert.equal(store.row.state, 'CONFIRMED');
});

test('service start during preflight stops before Viva cancellation', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  let current = instant;
  const originalProbe = provider.readCancelOptions;
  provider.readCancelOptions = async () => {
    const options = await originalProbe();
    current = '2099-01-01T13:00:00.000Z';
    return options;
  };
  const result = await reconcileLk1UnpaidBooking({ op: seed.op, operations: store,
    provider, cohortFrom: cohort, mode: 'ENFORCE_NEW', now: () => current });
  assert.deepEqual(result, { state: 'REVIEW', reason: 'SERVICE_STARTED' });
  assert.equal(provider.calls.includes('cancel'), false);
});

test('restart after accepted Viva cancel releases from exact provider readback without a new PUT', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  store.row.lk1.unpaidCancellation = { phase: 'INTENT', attemptedAt: '2099-01-01T12:00:00.000Z' };
  store.row.lk1.target.startsAt = '2099-01-01T11:00:00.000Z';
  provider.state.booking.isCancelled = true;
  assert.deepEqual(await run(store.row, store, provider), { state: 'CANCELLED' });
  assert.equal(provider.calls.includes('cancel'), false);
  assert.equal(store.row.state, 'RELEASED');
});

test('provider sends only scoped NONE cancellation and rejects unexpected origin', async () => {
  const seed = fixture(), calls = [];
  const provider = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/', token: async () => 'fixture-token',
    fetchImpl: async (url, options) => { calls.push({ url: String(url), options });
      return { status: 200, json: async () => ({ bookingId: 'booking',
        cancellationOptions: { cancellationOnly: { available: true } } }) }; } });
  await provider.cancelBooking(seed.op);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'PUT');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/clients/actor/bookings/booking/cancel');
  assert.deepEqual(JSON.parse(calls[0].options.body), { refundMethod: 'NONE', cancelExercise: false });
  assert.throws(() => createLk1VivaCancellationProvider({ baseUrl: 'https://example.test/', token: async () => 'x' }), /VIVA_ORIGIN_INVALID/);
});

test('provider readback uses complete inclusive exercise pages and exact booking', async () => {
  const seed = fixture(), paths = [];
  const provider = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/', token: async () => 'fixture-token',
    fetchImpl: async url => { paths.push(String(url)); return { status: 200, json: async () => ({
      content: [seed.booking], last: true, totalElements: 1,
    }) }; } });
  assert.deepEqual(await provider.readBooking(seed.op), seed.booking);
  assert.match(paths[0], /\/api\/v1\/exercises\/exercise\/bookings\?showCancelled=true&page=0&size=200$/);
  const incomplete = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/', token: async () => 'fixture-token',
    fetchImpl: async () => ({ status: 200, json: async () => ({ content: [seed.booking], last: false }) }) });
  await assert.rejects(incomplete.readBooking(seed.op), /BOOKING_PAGE_INCOMPLETE/);
});
