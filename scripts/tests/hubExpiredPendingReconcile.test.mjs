// Offline harness for the HUB expired-pending retry path. The handler source is sliced
// from the reviewed gateway fragment and executed with stubs, so the decision logic and the
// exact durable commands are covered without a live flow fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const hub = gateway.slice(gateway.indexOf('// HUB_STEPS'));
const block = (from, to) => hub.slice(hub.indexOf(from), hub.indexOf(to));
const helpers = block('const LK1_EXPIRED_PENDING_RECONCILE', 'if (ctx.step === "lk1_ingress_operation_find") {');
const reconcile = block('if (ctx.step === LK1_EXPIRED_PENDING_RECONCILE) {', 'if (ctx.step === LK1_EXPIRED_PENDING_RELEASE) {');
const release = block('if (ctx.step === LK1_EXPIRED_PENDING_RELEASE) {', 'if (ctx.step === "lk1_money_owned_subscriptions") {');

const isObj = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeId = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
const respond = (value) => (Array.isArray(value) ? value : isObj(value) && Array.isArray(value.content) ? value.content : []);
const baseDeps = {
  isObj,
  toStr,
  normalizeId,
  isHttpOk: (status) => Number(status) >= 200 && Number(status) < 300,
  hasCompleteBookingList: (value) => Array.isArray(value) || isObj(value),
  extractItems: respond,
  bookingClientId: (booking) => toStr(booking?.clientId ?? booking?.client?.id),
  bookingSubscriptionId: (booking) => toStr(booking?.clientSubscriptionId ?? booking?.subscriptionId ?? booking?.clientSubId),
  bookingExerciseId: (booking) => toStr(booking?.exercise?.id ?? booking?.exerciseId),
  isInactiveBooking: (booking) => booking?.isCancelled === true || /CANCEL|DECLIN|FAIL|EXPIRE|REFUND/i.test(String(booking?.status || '')),
  bookingId: (booking) => toStr(booking?.id ?? booking?.bookingId),
};
const build = () => {
  const calls = [];
  const deps = {
    ...baseDeps,
    prepareAdminGet: (ctx, step, path) => { calls.push({ fn: 'prepareAdminGet', step, path }); return 'ADMIN_GET'; },
    prepareUserGet: (ctx, step, path) => { calls.push({ fn: 'prepareUserGet', step, path }); return 'USER_GET'; },
    prepareMongoUpdate: (ctx, step, query, update) => { calls.push({ fn: 'prepareMongoUpdate', step, query, update }); return 'MONGO_UPDATE'; },
    mongoMatched: (value) => value?.matchedCount ?? 0,
    finishPending: (ctx, message, details) => { calls.push({ fn: 'finishPending', message, details }); return 'PENDING'; },
    lk1Stop: (ctx, code) => { calls.push({ fn: 'lk1Stop', code }); return 'STOP'; },
  };
  const api = new Function('deps', `
    const { isObj, toStr, normalizeId, isHttpOk, hasCompleteBookingList, extractItems, bookingClientId,
      bookingSubscriptionId, bookingExerciseId, isInactiveBooking, bookingId, prepareAdminGet,
      prepareUserGet, prepareMongoUpdate, mongoMatched, finishPending, lk1Stop } = deps;
    ${helpers}
    return {
      lk1ExpiredUnboundClaim,
      lk1ReplayMayFinishBoundBooking,
      run: (ctx, msg) => {
        ${reconcile}
        ${release}
      },
    };
  `)(deps);
  return { calls, api };
};

const ACTOR = 'fixture-actor-0001';
const SUB = 'fixture-subscription-0001';
const EXERCISE = 'fixture-exercise-0001';
const PAST = '2026-09-12T07:00:00.000Z';
const NOW = '2026-09-12T08:00:00.000Z';

const claim = (extra = {}) => ({
  _id: 'lk1-product:["fixture","fixture-actor-0001","fixture-operation"]',
  operationId: 'fixture-operation',
  tenantKey: 'fixture',
  actorClientId: ACTOR,
  clientSubscriptionId: SUB,
  exerciseId: EXERCISE,
  state: 'PENDING_CONFIRMATION',
  pendingUntil: PAST,
  lk1: { decision: { benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1 } },
  ...extra,
});
const booking = (extra = {}) => ({
  id: 'fixture-booking-0001', clientId: ACTOR, clientSubscriptionId: SUB, exerciseId: EXERCISE, status: 'ACTIVE', ...extra,
});

test('only an expired, never-bound, non-create claim enters the bounded retry', () => {
  const { api } = build();
  assert.equal(api.lk1ExpiredUnboundClaim(claim(), Date.parse(NOW)), true);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ pendingUntil: '2026-09-12T09:00:00.000Z' }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ pendingUntil: null }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ bookingId: 'b1' }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ upstreamBookingId: 'b1' }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ lk1: { createAttemptedAt: PAST } }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ lk1: { bookingAttemptedAt: PAST } }), Date.parse(NOW)), false);
  assert.equal(api.lk1ExpiredUnboundClaim(claim({ state: 'CONFIRMED' }), Date.parse(NOW)), false);
});

test('a replay may finish a bound booking only when no new money leg is required', () => {
  const { api } = build();
  assert.equal(api.lk1ReplayMayFinishBoundBooking(claim()), true);
  assert.equal(api.lk1ReplayMayFinishBoundBooking(claim({ lk1: { decision: { benefit: { finalPriceMinor: 1400 } } } })), false);
  assert.equal(api.lk1ReplayMayFinishBoundBooking(claim({ lk1: { decision: { benefit: { finalPriceMinor: 1400 } }, checkout: { toPayMinor: 1400 } } })), true);
  assert.equal(api.lk1ReplayMayFinishBoundBooking(claim({ lk1: { decision: { benefit: { finalPriceMinor: 1400 } }, transactionId: 't1' } })), true);
  assert.equal(api.lk1ReplayMayFinishBoundBooking(claim({ lk1: { decision: {} } })), false);
});

test('a claim without any provider booking is released through the observed window', () => {
  const { api, calls } = build();
  const ctx = { tenantKey: 'fixture', lk1ExpiredPendingOperation: claim(), step: 'lk1_ingress_expired_pending', statusCode: 200 };
  const msg = { statusCode: 200, payload: { content: [{ id: 'other', clientId: 'fixture-actor-0002', clientSubscriptionId: SUB }] } };
  api.run(ctx, msg);
  const write = calls.find((call) => call.fn === 'prepareMongoUpdate');
  assert.equal(write.step, 'lk1_expired_pending_release');
  assert.deepEqual(write.query, {
    _id: claim()._id,
    operationId: 'fixture-operation',
    state: 'PENDING_CONFIRMATION',
    pendingUntil: PAST,
    $and: [
      { $or: [{ bookingId: { $exists: false } }, { bookingId: null }, { bookingId: '' }] },
      { $or: [{ upstreamBookingId: { $exists: false } }, { upstreamBookingId: null }, { upstreamBookingId: '' }] },
    ],
  });
  assert.equal(write.update.$set.state, 'RELEASED');
  assert.equal(write.update.$set.reconciliation.source, 'hub_expired_pending_viva_readback');
  assert.equal(write.update.$set.reconciliation.observedPendingUntil, PAST);
  assert.deepEqual(write.update.$unset, { pendingUntil: '', leaseUntil: '' });
  assert.equal(calls.some((call) => call.fn === 'prepareUserGet' || call.code === 'LK1_STOP'), false);
});

test('a provider booking of the actor and subscription is bound, never re-created', () => {
  const { api, calls } = build();
  const ctx = { tenantKey: 'fixture', lk1ExpiredPendingOperation: claim(), step: 'lk1_ingress_expired_pending', statusCode: 200 };
  api.run(ctx, { statusCode: 200, payload: { content: [booking()] } });
  const read = calls.find((call) => call.fn === 'prepareUserGet');
  assert.equal(read.step, 'confirmation_bookings');
  assert.match(read.path, /end-user\/api\/v2\/fixture\/bookings/);
  assert.equal(ctx.immediateBookingId, 'fixture-booking-0001');
  assert.equal(ctx.confirmedBookingId, null);
  assert.equal(ctx.exerciseId, EXERCISE);
  assert.equal(calls.some((call) => call.fn === 'prepareMongoUpdate'), false);
});

test('a provider row without a resolvable subscription keeps the claim for the manual path', () => {
  const { api, calls } = build();
  const ctx = { tenantKey: 'fixture', lk1ExpiredPendingOperation: claim(), step: 'lk1_ingress_expired_pending', statusCode: 200 };
  api.run(ctx, { statusCode: 200, payload: { content: [booking({ clientSubscriptionId: null, subscriptionId: null })] } });
  assert.equal(calls.at(-1).code, 'LK1_EXPIRED_PENDING_SUBSCRIPTION_UNRESOLVED');
  assert.equal(calls.some((call) => call.fn === 'prepareMongoUpdate' || call.fn === 'prepareUserGet'), false);
});

test('a cancelled or foreign booking never binds the claim', () => {
  for (const rows of [[booking({ status: 'CANCELLED' })], [booking({ clientId: 'fixture-actor-0002' })], [booking({ clientSubscriptionId: 'fixture-subscription-0002' })]]) {
    const { api, calls } = build();
    const ctx = { tenantKey: 'fixture', lk1ExpiredPendingOperation: claim(), step: 'lk1_ingress_expired_pending', statusCode: 200 };
    api.run(ctx, { statusCode: 200, payload: { content: rows } });
    assert.equal(calls.at(-1).step, 'lk1_expired_pending_release', JSON.stringify(rows));
  }
});

test('an unreadable, unproven or identity-less readback keeps the claim pending', () => {
  const cases = [
    [{ statusCode: 500, payload: { content: [] } }, 'LK1_EXPIRED_PENDING_RECONCILIATION_UNAVAILABLE'],
    [{ statusCode: 200, payload: null }, 'LK1_EXPIRED_PENDING_RECONCILIATION_UNAVAILABLE'],
    [{ statusCode: 200, payload: { content: [] } }, null],
  ];
  for (const [msg, code] of cases) {
    const { api, calls } = build();
    const ctx = { tenantKey: 'fixture', lk1ExpiredPendingOperation: claim(), step: 'lk1_ingress_expired_pending', statusCode: 200 };
    api.run(ctx, msg);
    if (code) assert.equal(calls.at(-1).code, code);
    assert.equal(calls.some((call) => call.fn === 'prepareUserGet'), false);
  }
  const { api, calls } = build();
  const broken = claim({ actorClientId: null });
  api.run({ tenantKey: 'fixture', lk1ExpiredPendingOperation: broken, step: 'lk1_ingress_expired_pending' }, { statusCode: 200, payload: { content: [] } });
  assert.equal(calls.at(-1).code, 'LK1_EXPIRED_PENDING_IDENTITY_UNRESOLVED');
});

test('the release answer is a retry hint, and a lost race keeps the claim', () => {
  const { api, calls } = build();
  const ctx = { tenantKey: 'fixture', operationId: 'fixture-operation', exerciseId: EXERCISE, step: 'lk1_expired_pending_release' };
  api.run(ctx, { payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1 } });
  assert.equal(calls.at(-1).fn, 'finishPending');
  assert.equal(calls.at(-1).details.code, 'LK1_EXPIRED_PENDING_RELEASED');

  const conflicted = build();
  conflicted.api.run({ step: 'lk1_expired_pending_release' }, { payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0 } });
  assert.equal(conflicted.calls.at(-1).code, 'LK1_EXPIRED_PENDING_RELEASE_CONFLICT');
});
