import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classifyLk1Transaction, classifyLk1Booking, eligibleLk1UnpaidOperation,
  reconcileLk1UnpaidBooking, createLk1VivaCancellationProvider,
  buildLk1UnpaidScanQuery } from '../lib/lk1UnpaidBookingCancellation.mjs';
import { createLk1VivaServiceToken } from '../lib/lk1VivaServiceToken.mjs';
import { createLk1LiveGatewayGuard, lk1VivaBinding } from '../lib/lk1LiveGatewayGuard.mjs';
import { openLk1UnpaidScanCursor, scanLk1UnpaidPage } from '../lib/lk1UnpaidScanCursor.mjs';

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
    createDate: '2099-01-01T11:30:00.000Z',
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
  const withoutAction = structuredClone(op);
  delete withoutAction.action;
  assert.equal(eligibleLk1UnpaidOperation(withoutAction, cohort, instant).reason, 'ELIGIBLE');
  for (const mutate of [
    row => { row.action = 'BOOK_TOURNAMENT'; },
    row => { row.managedAction = 'BOOK_TOURNAMENT'; },
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
  assert.equal(buildLk1UnpaidScanQuery({ tenantKey: 'fixture', cohortFrom: cohort,
    phase: 'INTENT' })['lk1.unpaidCancellation.phase'], 'INTENT');
  assert.deepEqual(buildLk1UnpaidScanQuery({ tenantKey: 'fixture', cohortFrom: cohort,
    phase: 'UNCLAIMED' })['lk1.unpaidCancellation'], { $exists: false });
});

test('scan cursors persist across restarts and reject cohort changes', async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-unpaid-cursor-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'cursor.json');
  const config = { file, tenantKey: 'fixture', cohortFrom: cohort };
  const first = await openLk1UnpaidScanCursor(config);
  assert.equal(first.afterId('UNCLAIMED'), null);
  await first.advance('UNCLAIMED', 'lk1-product:later-page');
  await first.advance('INTENT', 'lk1-product:pending-intent');
  const restarted = await openLk1UnpaidScanCursor(config);
  assert.equal(restarted.afterId('UNCLAIMED'), 'lk1-product:later-page');
  assert.equal(restarted.afterId('INTENT'), 'lk1-product:pending-intent');
  await assert.rejects(openLk1UnpaidScanCursor({ ...config,
    cohortFrom: '2099-01-02T00:00:00.000Z' }), /SCAN_CURSOR_COHORT_DRIFT/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644);
  await assert.rejects(openLk1UnpaidScanCursor(config), /SCAN_CURSOR_FILE_UNSAFE/);
});

test('scanner restart in the middle of a page resumes without skipping a row', async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-unpaid-page-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const config = { file: path.join(folder, 'cursor.json'), tenantKey: 'fixture', cohortFrom: cohort };
  const rows = ['a', 'b', 'c'].map(id => ({ _id: `lk1-product:${id}` }));
  const visited = [];
  let stopped = false;
  const loadRows = (afterId, limit) => rows.filter(row => !afterId || row._id > afterId).slice(0, limit);
  const first = await openLk1UnpaidScanCursor(config);
  await scanLk1UnpaidPage({ phase: 'UNCLAIMED', limit: 3, cursor: first, loadRows,
    shouldStop: () => stopped, visit: async row => { visited.push(row._id);
      if (row._id === 'lk1-product:b') stopped = true; } });
  assert.equal(first.afterId('UNCLAIMED'), 'lk1-product:a');
  stopped = false;
  const restarted = await openLk1UnpaidScanCursor(config);
  await scanLk1UnpaidPage({ phase: 'UNCLAIMED', limit: 3, cursor: restarted, loadRows,
    shouldStop: () => stopped, visit: async row => { visited.push(row._id); } });
  assert.deepEqual(visited, ['lk1-product:a', 'lk1-product:b', 'lk1-product:b', 'lk1-product:c']);
  assert.equal(restarted.afterId('UNCLAIMED'), null);
});

test('transaction requires exact UNPAID, due date, amount and supplied aliases', () => {
  const { op, transaction } = fixture();
  assert.equal(classifyLk1Transaction(op, transaction, instant).reason, 'DUE');
  assert.equal(classifyLk1Transaction(op, {
    ...transaction, paymentDueDate: '2099-01-01T14:58:00.274625208+03:00',
  }, instant).reason, 'DUE');
  for (const change of [{ status: 'PAID' }, { status: 'WAITING' }, { status: 'PARTIALLY_PAID' },
    { paymentDueDate: undefined }, { createDate: undefined },
    { createdAt: '2099-01-01T11:29:00.000Z' },
    { paymentDueDate: '2099-01-01T12:00:30.000Z' },
    { paymentDueDate: '2099-02-30T11:58:00.000Z' },
    { clientId: 'other' }, { bookingIds: ['other'] }, { exerciseId: 'other' },
    { toPay: 1 }, { id: 'other' },
    { paymentDate: '2099-01-01T12:00:00.000Z' }, { currency: 'USD' },
    { cardPaymentInfo: { status: 'PAID' } }, { cardPaymentStatus: { status: 'PARTIALLY_PAID' } },
    { paidAmountMinor: 100 }, { cardPaymentInfo: { status: 'NEW', paidAmountMinor: 100 } }]) {
    assert.notEqual(classifyLk1Transaction(op, { ...transaction, ...change }, instant).reason, 'DUE');
  }
});

test('UNPAID is not due while its 25-minute payment link may still work', () => {
  const { op, transaction } = fixture();
  const shortProviderDue = { ...transaction, createDate: '2099-01-01T11:40:00.000Z' };
  assert.equal(classifyLk1Transaction(op, shortProviderDue, instant).reason, 'NOT_DUE');
  assert.equal(classifyLk1Transaction(op, shortProviderDue, '2099-01-01T12:05:59.999Z').reason, 'NOT_DUE');
  assert.equal(classifyLk1Transaction(op, shortProviderDue, '2099-01-01T12:06:00.000Z').reason, 'DUE');
  assert.equal(classifyLk1Transaction(op, { ...shortProviderDue,
    createDate: '2099-01-01T11:58:01.000Z' }, instant).reason, 'DEADLINE_INVALID');
  assert.equal(classifyLk1Transaction(op, { ...transaction,
    paymentDueDate: '2099-01-01T12:00:30.000Z' }, instant).reason, 'NOT_DUE');
  assert.equal(classifyLk1Transaction(op, { ...transaction,
    paymentDueDate: '2099-01-01T12:00:30.000Z' }, '2099-01-01T12:01:30.000Z').reason, 'DUE');
  const nanoZone = { ...transaction, createDate: '2099-01-01T14:30:00.123456789+03:00',
    paymentDueDate: '2099-01-01T14:55:00.000000000+03:00' };
  assert.equal(classifyLk1Transaction(op, nanoZone, '2099-01-01T11:56:00.122Z').reason, 'NOT_DUE');
  assert.equal(classifyLk1Transaction(op, nanoZone, '2099-01-01T11:56:00.123Z').reason, 'DUE');
});

test('booking requires exact owner, exercise, ON_PLACE carrier and explicit cancellation proof', () => {
  const { op, booking } = fixture();
  assert.equal(classifyLk1Booking(op, booking).reason, 'ACTIVE');
  assert.equal(classifyLk1Booking(op, { ...booking, isCancelled: true }).reason, 'CANCELLED');
  const scoped = { ...booking, __lk1ScopedExerciseId: op.exerciseId };
  delete scoped.exerciseId;
  assert.equal(classifyLk1Booking(op, scoped).reason, 'ACTIVE');
  assert.equal(classifyLk1Booking(op, { ...scoped, __lk1ScopedExerciseId: 'other' }).reason,
    'BOOKING_BINDING_INVALID');
  assert.equal(classifyLk1Booking(op, { ...scoped, exerciseId: 'other' }).reason,
    'BOOKING_BINDING_INVALID');
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

test('a later provider deadline on the second read stops before Viva cancellation', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  let reads = 0;
  provider.readTransaction = async () => {
    reads += 1;
    return { ...seed.transaction,
      paymentDueDate: reads === 1 ? seed.transaction.paymentDueDate : '2099-01-01T12:00:30.000Z' };
  };
  assert.deepEqual(await run(seed.op, store, provider), { state: 'REVIEW', reason: 'NOT_DUE' });
  assert.equal(provider.calls.includes('cancel'), false);
  assert.equal(store.row.lk1.unpaidCancellation.phase, 'REVIEW');
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

test('stop after the durable intent prevents Viva PUT and keeps recovery evidence', async () => {
  const seed = fixture(), store = fakeStore(seed.op), provider = fakeProvider(seed);
  let stopped = false;
  const originalProbe = provider.readCancelOptions;
  let probes = 0;
  provider.readCancelOptions = async () => {
    const result = await originalProbe();
    if (++probes === 2) stopped = true;
    return result;
  };
  const result = await reconcileLk1UnpaidBooking({ op: seed.op, operations: store,
    provider, cohortFrom: cohort, mode: 'ENFORCE_NEW', now: () => instant,
    shouldStop: () => stopped });
  assert.deepEqual(result, { state: 'STOPPED_AFTER_INTENT' });
  assert.equal(provider.calls.includes('cancel'), false);
  assert.equal(store.row.lk1.unpaidCancellation.phase, 'INTENT');
});

test('runtime change during provider reads leaves no premature write or repeat PUT', async () => {
  const seed = fixture();
  for (const boundary of ['before-intent', 'after-intent', 'after-put']) {
    const store = fakeStore(seed.op), provider = fakeProvider(seed);
    let stopped = false;
    if (boundary === 'before-intent') {
      const read = provider.readTransaction;
      provider.readTransaction = async () => { const result = await read(); stopped = true; return result; };
    } else if (boundary === 'after-intent') {
      const read = provider.readTransaction;
      let count = 0;
      provider.readTransaction = async () => { const result = await read();
        if (++count === 2) stopped = true; return result; };
    } else {
      const cancel = provider.cancelBooking;
      provider.cancelBooking = async () => { const result = await cancel(); stopped = true; return result; };
    }
    const result = await reconcileLk1UnpaidBooking({ op: seed.op, operations: store,
      provider, cohortFrom: cohort, mode: 'ENFORCE_NEW', now: () => instant,
      shouldStop: () => stopped });
    assert.equal(result.state, boundary === 'before-intent' ? 'STOPPED' : 'STOPPED_AFTER_INTENT');
    assert.equal(store.calls.length, boundary === 'before-intent' ? 0 : 1);
    assert.equal(provider.calls.filter(call => call === 'cancel').length, boundary === 'after-put' ? 1 : 0);
    if (boundary === 'after-put') {
      stopped = false;
      assert.equal((await run(store.row, store, provider)).state, 'CANCELLED');
      assert.equal(provider.calls.filter(call => call === 'cancel').length, 1);
    }
  }
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
  let stopped = false, writes = 0;
  const guarded = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/',
    token: async () => { stopped = true; return 'fixture-token'; },
    fetchImpl: async () => { writes += 1; throw new Error('PUT must not start'); } });
  assert.deepEqual(await guarded.cancelBooking(seed.op, () => stopped), { status: 0, stopped: true });
  assert.equal(writes, 0);
});

test('provider readback uses complete inclusive exercise pages and exact booking', async () => {
  const seed = fixture(), paths = [];
  const provider = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/', token: async () => 'fixture-token',
    fetchImpl: async url => { paths.push(String(url)); return { status: 200, json: async () => ({
      content: [seed.booking], last: true, totalElements: 1,
    }) }; } });
  assert.deepEqual(await provider.readBooking(seed.op), { ...seed.booking, __lk1ScopedExerciseId: seed.op.exerciseId });
  assert.match(paths[0], /\/api\/v1\/exercises\/exercise\/bookings\?showCancelled=true&page=0&size=200$/);
  const incomplete = createLk1VivaCancellationProvider({ baseUrl: 'http://127.0.0.1/', token: async () => 'fixture-token',
    fetchImpl: async () => ({ status: 200, json: async () => ({ content: [seed.booking], last: false }) }) });
  await assert.rejects(incomplete.readBooking(seed.op), /BOOKING_PAGE_INCOMPLETE/);
});

test('service token refreshes before expiry, accepts rotation and rejects unsafe config', async () => {
  let current = 0, requests = 0;
  let config = { tokenUrl: 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token',
    clientId: 'service', username: 'user', password: 'first' };
  const token = createLk1VivaServiceToken({ readConfig: async () => config, now: () => current,
    fetchImpl: async (url, options) => {
      assert.equal(url, config.tokenUrl);
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('password'), config.password);
      requests += 1;
      return { status: 200, json: async () => ({ access_token: `token-${requests}`, expires_in: 300 }) };
    } });
  assert.equal(await token(), 'token-1');
  assert.equal(await token(), 'token-1');
  assert.equal(requests, 1);
  config = { ...config, password: 'rotated' };
  current = 271_000;
  assert.equal(await token(), 'token-2');
  assert.equal(requests, 2);
  token.invalidate();
  assert.equal(await token(), 'token-3');
  config = { ...config, tokenUrl: 'https://example.test/token' };
  current = 542_000;
  await assert.rejects(token(), /VIVA_TOKEN_CONFIG_INVALID/);
  assert.equal(requests, 3);
});

test('service token accepts Viva seven-day TTL but refreshes its cache within fifteen minutes', async () => {
  let current = 0, requests = 0;
  const token = createLk1VivaServiceToken({ now: () => current,
    readConfig: async () => ({ tokenUrl: 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token',
      clientId: 'service', username: 'user', password: 'password' }),
    fetchImpl: async () => ({ status: 200, json: async () => ({ access_token: `token-${++requests}`,
      expires_in: 604800 }) }) });
  assert.equal(await token(), 'token-1');
  current = 869_000;
  assert.equal(await token(), 'token-1');
  current = 871_000;
  assert.equal(await token(), 'token-2');
});

test('ENFORCE guard pins flow, Viva binding and runtime route across PM2 restarts', async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk1-unpaid-guard-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const flowPath = path.join(folder, 'flows.json');
  const adminTokenFile = path.join(folder, 'admin.token');
  fs.writeFileSync(adminTokenFile, 'fixture-admin-1234', { mode: 0o600 });
  const functionBody = 'fixture gateway';
  const expectedGatewaySha = crypto.createHash('sha256').update(functionBody).digest('hex');
  const writeFlow = body => {
    fs.writeFileSync(flowPath, JSON.stringify([{
      id: 'lk_subscription_booking_router_20260804', type: 'function', func: body,
    }]));
    fs.utimesSync(flowPath, new Date(0), new Date(0));
  };
  let process = { name: 'node-red', pid: 123, pm2_env: {
    status: 'online', pm_uptime: 1000, restart_time: 1,
    VIVA_SERVICE_TOKEN_URL: 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token',
    VIVA_SERVICE_CLIENT_ID: 'fixture', VIVA_SERVICE_USERNAME: 'fixture-user',
    VIVA_SERVICE_PASSWORD: 'fixture-password',
  } };
  writeFlow(functionBody);
  const expectedFlowSha = crypto.createHash('sha256').update(fs.readFileSync(flowPath)).digest('hex');
  const expectedBindingSha = lk1VivaBinding(process).sha256;
  let activeFlow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
  const create = (readinessStatus = 401, fetchOverride) =>
    createLk1LiveGatewayGuard({ flowPath, processes: () => [process], expectedGatewaySha,
      expectedFlowSha, expectedBindingSha, adminTokenFile,
      fetchImpl: fetchOverride || (async (url, options) => url.endsWith('/flows')
        ? { status: options.headers.Authorization === 'Bearer fixture-admin-1234' ? 200 : 401,
          json: async () => ({ rev: 'fixture-revision', flows: structuredClone(activeFlow) }) }
        : { status: readinessStatus,
          json: async () => ({ details: { code: 'SUBSCRIPTION_BOOKING_AUTH_REQUIRED' } }) }) });
  const guard = await create();
  assert.equal(guard.check(), 'HEALTHY');
  writeFlow('removed guard');
  assert.equal(guard.check(), 'DRIFT');
  await assert.rejects(create(), /LIVE_GATEWAY_DRIFT/);
  writeFlow(functionBody);
  assert.equal(guard.check(), 'HEALTHY');
  fs.utimesSync(flowPath, new Date(2000), new Date(2000));
  assert.equal(guard.check(), 'DRIFT');
  writeFlow(functionBody);
  process = { ...process, pid: 456, pm2_env: { ...process.pm2_env, restart_time: 2 } };
  assert.equal(guard.check(), 'RESTART_PENDING');
  assert.equal((await create()).check(), 'HEALTHY');
  process = { ...process, pid: 123, pm2_env: { ...process.pm2_env, restart_time: 1,
    status: 'offline' } };
  assert.equal(guard.check(), 'RESTART_PENDING');
  await assert.rejects(create(), /LIVE_GATEWAY_RESTART_PENDING/);
  process = { ...process, pm2_env: { ...process.pm2_env, status: 'online',
    VIVA_SERVICE_PASSWORD: 'rotated' } };
  assert.equal(guard.check(), 'DRIFT');
  await assert.rejects(create(), /LIVE_GATEWAY_DRIFT/);
  process = { ...process, pm2_env: { ...process.pm2_env,
    VIVA_SERVICE_PASSWORD: 'fixture-password' } };
  process = { ...process, pm2_env: { ...process.pm2_env,
    pm_uptime: Date.now() - 1000 } };
  await assert.rejects(create(), /LIVE_GATEWAY_RESTART_PENDING/);
  process = { ...process, pm2_env: { ...process.pm2_env,
    pm_uptime: 1000 } };
  await assert.rejects(create(401, async () => { throw new Error('connection refused'); }),
    /LIVE_GATEWAY_ACTIVE_FLOW_UNVERIFIED/);
  await assert.rejects(create(401, async url => url.endsWith('/flows')
    ? { status: 200, json: async () => ({ rev: 'fixture-revision', flows: structuredClone(activeFlow) }) }
    : Promise.reject(new Error('route unavailable'))), /LIVE_GATEWAY_ROUTE_UNVERIFIED/);
  await assert.rejects(create(404),
    /LIVE_GATEWAY_ROUTE_UNVERIFIED/);
  activeFlow = [{ ...activeFlow[0], func: 'stale gateway' }];
  await assert.rejects(create(), /LIVE_GATEWAY_ACTIVE_FLOW_UNVERIFIED/);
  fs.chmodSync(adminTokenFile, 0o644);
  await assert.rejects(create(), /LIVE_GATEWAY_ADMIN_AUTH_UNAVAILABLE/);
});

test('production launcher rejects a CLI mode override before reading live state', () => {
  const launcher = fileURLToPath(new URL('../launch_lk1_unpaid_booking_cancellation.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [launcher, '--run', '--mode', 'ENFORCE_NEW'], {
    encoding: 'utf8', env: { ...process.env, LK1_UNPAID_CANCEL_MODE: 'OFF' }, timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /LAUNCH_ARGUMENT_OVERRIDE_FORBIDDEN/);
});
