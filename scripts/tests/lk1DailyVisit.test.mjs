import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { patchDailyVisitUsage, patchDailyVisitEvaluator, patchDailyVisitGateway,
  composeDailyVisitArtifacts } from '../patch_live_lk1_daily_visit.mjs';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const evaluator = patchDailyVisitEvaluator(read('../nodered_lk1_hub_nodes/evaluator.js'));
const guard = read('../nodered_lk1_hub_nodes/daily_visit_guard.js');
const product = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const rule = { productId: product, maxActiveBookings: 8, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const day = '2026-11-08';
const categoryOf = category => ({ GAME: 'open_game', GROUP_TRAINING: 'group_training', TOURNAMENT: 'tournament' })[category];
const operation = (category, changes = {}) => ({ _id: 'operation-old', tenantKey: 'fixture', actorClientId: 'actor',
  clientSubscriptionId: 'subscription-a', serviceDate: day, category: categoryOf(category), state: 'CONFIRMED',
  bookingId: 'booking-old', lk1: { rule, target: { category, directionId: 2680 },
    decision: { subscriptionVisitCount: 1,
      ...(category === 'GAME' ? { gameMinutes: { localDate: day, freeMinutes: 60 } } : {}) } }, ...changes });

function usage(category, operations = [], bookings = [], changes = {}) {
  const patched = patchDailyVisitUsage(gateway);
  const start = patched.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const end = patched.indexOf('if (ctx.step === "lk1_policy_decision") {', start);
  const ctx = { step: 'lk1_usage_operations', tenantKey: 'fixture', actorClientId: 'actor',
    clientSubscriptionId: 'subscription-a', serviceDate: day, category: categoryOf(category),
    managedAction: { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING', TOURNAMENT: 'BOOK_TOURNAMENT' }[category],
    lk1: { rule, bookings, activeBookings: bookings,
      target: { resolutionSource: 'SERVER', category, directionId: 2680, durationMinutes: 60,
        startsAt: '2026-11-08T09:00:00Z', basePriceMinor: 100000, priceSource: 'VIVA_EXISTING_TARIFF', currency: 'RUB' } },
    lk1ProductIdentity: { subscription: { visitsLeft: 20 } }, ...changes };
  const msg = { payload: operations };
  const helpers = {
    ctx, msg, isObj: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    isValidDateKey: value => /^\d{4}-\d{2}-\d{2}$/.test(value), normalizeId: value => typeof value === 'string' ? value.toLowerCase() : null,
    isInactiveBooking: b => b.cancelled === true, eventDate: b => b.date, bookingId: b => b.id,
    bookingSubscriptionId: b => b.clientSubscriptionId, eventDurationMinutes: b => b.durationMinutes,
    resolveCategory: b => b.category, exerciseDirectionId: b => b.directionId,
    lk1OperationCategory: o => o.category,
    LK1_FREE_FIRST_EVENT_PRODUCTS: { [product]: ['group_training', 'tournament'] },
    LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES: {}, lk1Fields: Object.keys(rule).filter(k => k !== 'productId'),
    lk1Stop: (_ctx, code) => { msg.errorCode = code; }, emit: () => msg, OUTPUT_MANAGED_POLICY: 6,
  };
  new Function(...Object.keys(helpers), patched.slice(start, end))(...Object.values(helpers));
  assert.equal(msg.errorCode, undefined);
  return msg._managedSubscriptionPolicyInput;
}
function decide(input) {
  const out = new Function('msg', evaluator)({ _managedSubscriptionPolicyInput: input });
  return (out[0] || out[1])._managedSubscriptionPolicyDecision;
}

test('one visit across every ordered pair of categories; later events keep discounts', () => {
  for (const first of ['GAME', 'GROUP_TRAINING', 'TOURNAMENT']) {
    for (const second of ['GAME', 'GROUP_TRAINING', 'TOURNAMENT']) {
      const initial = decide(usage(first));
      assert.equal(initial.eligible, true);
      assert.equal(initial.subscriptionVisitCount, 1, first);
      const nextInput = usage(second, [operation(first)]);
      assert.equal(nextInput.usage.usedOrReservedVisitsToday, 1);
      const next = decide(nextInput);
      assert.equal(next.eligible, true);
      assert.equal(next.subscriptionVisitCount, 0, `${first} -> ${second}`);
      assert.equal(next.benefit.finalPriceMinor, second === 'GAME' ? 70000 : 50000);
      if (second === 'GAME') assert.equal(next.gameMinutes.freeMinutes, 0);
    }
  }
});
test('only same-subscription same-day nonterminal reservations consume the visit', () => {
  for (const state of ['PREPARED', 'PENDING_CONFIRMATION', 'CONFIRMED']) {
    assert.equal(usage('GAME', [operation('GROUP_TRAINING', { state })]).usage.usedOrReservedVisitsToday, 1);
  }
  for (const changes of [{ state: 'FAILED' }, { state: 'RELEASED' },
    { clientSubscriptionId: 'subscription-b' }, { serviceDate: '2026-11-09' }]) {
    assert.equal(decide(usage('GAME', [operation('GROUP_TRAINING', changes)])).subscriptionVisitCount, 1);
  }
  const paid = operation('GROUP_TRAINING'); paid.lk1.decision.subscriptionVisitCount = 0;
  assert.equal(decide(usage('GAME', [paid])).subscriptionVisitCount, 1);
});
test('provider-only subscription bookings count once and cancelled bookings do not count', () => {
  const booking = { id: 'booking-old', clientSubscriptionId: 'subscription-a', paymentType: 'SUBSCRIPTION',
    date: day, category: 'group_training', durationMinutes: 60 };
  assert.equal(usage('GAME', [], [booking]).usage.usedOrReservedVisitsToday, 1);
  assert.equal(usage('GAME', [operation('GROUP_TRAINING')], [booking]).usage.usedOrReservedVisitsToday, 1);
  assert.equal(usage('GAME', [], [{ ...booking, cancelled: true }]).usage.usedOrReservedVisitsToday, 0);
  // An un-reconciled operation remains reserved; absence/cancellation in Viva is
  // not evidence that a debit was returned. No historical data is rewritten.
  assert.equal(usage('GAME', [operation('GROUP_TRAINING')], [{ ...booking, cancelled: true }])
    .usage.usedOrReservedVisitsToday, 1);
});
test('missing/corrupt usage fails closed, and the day is Moscow calendar time', () => {
  for (const value of [undefined, -1, 0.5, '0', null]) {
    const input = usage('GAME'); input.usage.usedOrReservedVisitsToday = value;
    assert.equal(decide(input).eligible, false);
  }
  const input = usage('GAME'); input.target.startsAt = '2026-11-07T21:30:00Z';
  assert.equal(decide(input).eligible, true, '00:30 Moscow belongs to Nov 8');
  input.usage.dailyBucketLocalDate = '2026-11-07';
  assert.equal(decide(input).eligible, false);
});
test('all special visit-capable evaluator branches respect the common day', () => {
  for (const [category, directionId] of [['GAME', 6180], ['GROUP_TRAINING', 6233]]) {
    const input = usage(category);
    input.lk1ProductBinding.policyProductId = input.lk1ProductBinding.ownedProductId = '14692232-12be-4218-9fa1-2d5b79b62035';
    input.target.directionId = directionId; input.target.hourlyCourtPriceMinor = 600000;
    input.usage.usedOrReservedVisitsToday = 1;
    const d = decide(input);
    assert.equal(d.eligible, true);
    assert.equal(d.subscriptionVisitCount, 0);
    assert.equal(d.gameMinutes?.freeMinutes || d.courtMinutes?.freeMinutes || 0, 0);
  }
});

const context = (operationId, changes = {}) => ({ tenantKey: 'fixture', actorClientId: 'actor',
  clientSubscriptionId: 'subscription-a', serviceDate: day, operationId, operationKey: `op:${operationId}`,
  lk1: { dailyVisitPolicyVersion: 1, decision: { subscriptionVisitCount: 1 } }, ...changes });
function guardStep(ctx, payload, error) {
  const msg = { payload, error, _subscriptionBooking: ctx };
  const helpers = { ctx, msg, isValidDateKey: v => /^\d{4}-\d{2}-\d{2}$/.test(v),
    normalizeId: value => typeof value === 'string' ? value.trim().toLowerCase() : null,
    lk1Stop: (_ctx, code) => ({ type: 'pending', code }),
    emit: type => ({ type, payload: msg.payload, step: ctx.step }), OUTPUT_MONGO_UPDATE: 'mongoUpdate',
    preparePreaccept: () => ({ type: 'preaccept' }), prepareBookingCreate: () => ({ type: 'booking' }),
    prepareMongoUpdate: (_ctx, step, query, update) => { ctx.step = step; return { type: 'update', step, query, update }; },
    lk1Find: (_ctx, step, query) => { ctx.step = step; return { type: 'find', step, query }; },
    lk1MongoInserted: (p, id) => p?.acknowledged === true && p.insertedId === id,
    lk1MongoMatched: p => p?.acknowledged === true ? p.matchedCount : null,
    lk1ReplayIdentityMatches: (_ctx, op) => op.operationId === ctx.operationId && op.actorClientId === ctx.actorClientId,
    finishError: (_ctx, status, message, details) => ({ type: 'error', status, ...details }),
  };
  return new Function(...Object.keys(helpers), guard + '\nreturn lk1DailyVisitAcquire(ctx);')(...Object.values(helpers));
}
test('concurrent categories upsert one durable key; loser never reaches provider', () => {
  const first = context('first'), second = context('second');
  const a = guardStep(first), b = guardStep(second);
  assert.equal(a.type, 'mongoUpdate');
  assert.deepEqual(a.payload[0], b.payload[0]);
  assert.deepEqual(a.payload[2], { upsert: true, writeConcern: { w: 'majority', j: true } });
  const db = new Map();
  for (const [ctx, action] of [[first, a], [second, b]]) {
    const [query, update] = action.payload;
    if (!db.has(query._id)) db.set(query._id, { ...query, ...update.$setOnInsert });
    assert.equal(guardStep(ctx, { acknowledged: true }).type, 'find');
  }
  const stored = [...db.values()][0];
  assert.equal(guardStep(first, [stored]).type, 'preaccept');
  assert.equal(guardStep(second, [stored]).type, 'find');
  const owner = { ...operation('GAME', { state: 'PENDING_CONFIRMATION' }), _id: first.operationKey, operationId: first.operationId };
  const refused = guardStep(second, [owner]);
  assert.equal(refused.type, 'update'); assert.equal(refused.update.$set.state, 'FAILED');
  const response = guardStep(second, { acknowledged: true, matchedCount: 1, modifiedCount: 1 });
  assert.equal(response.status, 409); assert.equal(response.code, 'LK1_DAILY_VISIT_CHANGED');
  assert.equal(second.lk1DailyVisitOwned, undefined);
});
const claimRow = action => ({ ...action.payload[0], ...action.payload[1].$setOnInsert });
test('lost acknowledgements and same-owner replay read the durable guard', () => {
  const ctx = context('first'), inserted = claimRow(guardStep(ctx));
  assert.equal(guardStep(ctx, null, { code: 'NETWORK' }).type, 'find');
  assert.equal(guardStep(ctx, [inserted]).type, 'preaccept');
  const other = context('other', { serviceDate: '2026-11-09' });
  assert.notEqual(guardStep(other).payload[0]._id, inserted._id);
  const sibling = context('other', { clientSubscriptionId: 'subscription-b' });
  assert.notEqual(guardStep(sibling).payload[0]._id, inserted._id);
  const sameInstance = context('case-variant', { clientSubscriptionId: 'SUBSCRIPTION-A' });
  assert.equal(guardStep(sameInstance).payload[0]._id, inserted._id);
});
test('guard never expires; only proved terminal cancellation allows durable fenced takeover', () => {
  for (const state of ['PREPARED', 'PENDING_CONFIRMATION', 'CONFIRMED', 'FAILED', 'RELEASED']) {
    const ctx = context('new'), old = context('old'), claimed = claimRow(guardStep(old));
    guardStep(ctx); guardStep(ctx, {}); guardStep(ctx, [claimed]);
    const owner = { ...operation('GAME', { state }), _id: old.operationKey, operationId: old.operationId,
      ...(state === 'RELEASED' ? { releaseSource: 'GAME_LEAVE', releaseOperationId: 'fixture-leave',
        releasedAt: '2026-11-07T12:00:00Z', releaseBookingId: 'booking-old',
        releasedBookingIds: ['booking-old'] } : {}) };
    const result = guardStep(ctx, [owner]);
    assert.equal(result.step, state === 'RELEASED' ? 'lk1_daily_visit_takeover' : 'lk1_daily_visit_conflict_saved');
    if (state === 'RELEASED') {
      assert.equal(result.payload[0].ownerOperationKey, old.operationKey);
      assert.deepEqual(result.payload[2], { writeConcern: { w: 'majority', j: true } });
      assert.equal(guardStep(ctx, { acknowledged: true, matchedCount: 0, modifiedCount: 0 }).type, 'find');
    }
  }
});
test('pre-fix free decisions cannot acquire a new guard or reach a second debit', () => {
  const ctx = context('old-prepared'); delete ctx.lk1.dailyVisitPolicyVersion;
  const blocked = guardStep(ctx);
  assert.equal(blocked.step, 'lk1_daily_visit_conflict_saved');
  assert.equal(blocked.query.state, 'PREPARED');
  assert.deepEqual(blocked.query.upstreamAttemptedAt, { $exists: false });
  assert.equal(ctx.lk1DailyVisitOwned, undefined);
  assert.equal(guardStep(ctx, { acknowledged: true, matchedCount: 1, modifiedCount: 1 }).status, 409);
  // Old pending/provider-ambiguous records fail the CAS and remain pending.
  ctx.step = 'lk1_daily_visit_conflict_saved';
  assert.equal(guardStep(ctx, { acknowledged: true, matchedCount: 0, modifiedCount: 0 }).type, 'pending');
});
test('a pending new-generation booking resumes only after reading its owned guard', () => {
  const ctx = context('resume', { lk1DailyVisitContinuation: 'booking' });
  const row = claimRow(guardStep(ctx)); guardStep(ctx, {});
  assert.equal(guardStep(ctx, [row]).type, 'booking');
});
test('drift and repeated patching are refused; frozen generation does not accept arbitrary flow', () => {
  assert.throws(() => patchDailyVisitUsage(patchDailyVisitUsage(gateway)), /drift/);
  assert.throws(() => patchDailyVisitEvaluator(evaluator), /drift/);
  assert.throws(() => patchDailyVisitGateway('unreviewed source'), /drift/);
  assert.throws(() => composeDailyVisitArtifacts(Buffer.from('[]')), /preimage drift/);
});

// Never publish the private live flow as a fixture. This optional local check
// executes the complete frozen gateway and its actual Mongo output positions.
const liveFixture = process.env.LK1_DAILY_VISIT_FLOW;
test('frozen full gateway: Mongo route, old replay, fresh retry CAS and quote safety', {
  skip: !liveFixture && 'private frozen flow absent; set LK1_DAILY_VISIT_FLOW for local composition proof',
}, () => {
  const source = fs.readFileSync(liveFixture);
  const built = composeDailyVisitArtifacts(source);
  const flow = JSON.parse(built.candidateBytes);
  const gatewayNode = flow.find(n => n.id === 'lk_subscription_booking_router_20260804');
  const execute = new Function('msg', 'node', 'global', 'env', 'context', 'flow', 'RED', gatewayNode.func);
  const run = (ctx, payload, extra = {}) => {
    const msg = { _subscriptionBooking: ctx, payload, ...extra };
    const outputs = execute(msg, { send() {}, warn() {}, error() {}, status() {}, log() {} },
      { get: () => undefined }, { get: () => undefined }, {}, {}, {});
    return { msg, outputs };
  };
  const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  const current = context('first', { step: 'operation_insert', caller: 'http', action: 'book' });
  let result = run(current, { acknowledged: true, insertedId: current.operationKey });
  assert.equal(current.step, 'lk1_daily_visit_claim');
  assert.ok(result.outputs[3]);
  const updateNode = flow.find(n => n.id === gatewayNode.wires[3][0]);
  assert.equal(updateNode.operation, 'updateOne');
  assert.ok(updateNode.wires[0].includes(gatewayNode.id));
  const held = claimRow({ payload: result.msg.payload });
  run(current, ack); assert.equal(current.step, 'lk1_daily_visit_read');
  result = run(current, [held]); assert.equal(current.step, 'operation_preaccept');
  assert.ok(result.outputs[3]);
  assert.equal(result.msg.payload[0].state, 'PREPARED');

  // A pre-fix saved free decision is refused before a provider can see it.
  const old = context('old', { step: 'operation_insert', caller: 'http', action: 'book' });
  delete old.lk1.dailyVisitPolicyVersion;
  result = run(old, { acknowledged: true, insertedId: old.operationKey });
  assert.equal(old.step, 'lk1_daily_visit_conflict_saved');
  result = run(old, ack); assert.equal(result.msg.statusCode, 409);

  const input = usage('GROUP_TRAINING', [operation('GAME')]);
  const paid = decide(input);
  const target = { ...input.target, eventId: 'fixture-event', stationId: 'fixture-studio', priceProductId: 'fixture-tariff' };
  const replay = context('replay', { step: 'lk1_operation_find', caller: 'http', action: 'book',
    category: 'group_training', exerciseId: target.eventId, studioId: target.stationId,
    managedAction: 'BOOK_GROUP_TRAINING', lk1: { rule, target } });
  replay.operationKey = `lk1-product:${JSON.stringify([replay.tenantKey, replay.actorClientId, replay.operationId])}`;
  const savedQuote = { rule, target, decision: { eligible: true, subscriptionVisitCount: 1,
    benefit: { kind: 'FREE_ENTITLEMENT', finalPriceMinor: 0 } } };
  savedQuote.fingerprint = JSON.stringify({ tenantKey: replay.tenantKey, actorClientId: replay.actorClientId,
    clientSubscriptionId: replay.clientSubscriptionId, action: replay.managedAction, rule, target });
  replay.lk1.fingerprint = savedQuote.fingerprint;
  const saved = { _id: replay.operationKey, tenantKey: replay.tenantKey, actorClientId: replay.actorClientId,
    clientSubscriptionId: replay.clientSubscriptionId, operationId: replay.operationId, exerciseId: target.eventId,
    lk1: savedQuote, state: 'PREPARED', category: 'group_training', serviceDate: day };
  result = run(replay, [saved]);
  assert.equal(replay.step, 'lk1_daily_visit_conflict_saved', 'actual old PREPARED replay is fenced');
  saved.state = 'FAILED'; saved.failure = { rawCode: 'LK1_DAILY_VISIT_CHANGED' };
  replay.step = 'lk1_operation_find';
  result = run(replay, [saved]);
  assert.equal(replay.step, 'active_bookings', 'same-ID retry starts fresh provider usage reads');
  assert.equal(replay.lk1DailyVisitRetry.fingerprint, savedQuote.fingerprint);
  const retry = context('retry', { step: 'lk1_policy_decision', caller: 'http', action: 'book',
    category: 'group_training', exerciseId: target.eventId, studioId: target.stationId,
    managedAction: 'BOOK_GROUP_TRAINING', lk1: { rule, target },
    lk1DailyVisitRetry: { fingerprint: 'old-fingerprint' },
    expectedGroupDiscount: { basePriceMinor: target.basePriceMinor, amountMinor: 0,
      discountPercent: 100, productId: target.priceProductId, startsAt: target.startsAt, durationMinutes: 60 } });
  result = run(retry, null, { _managedSubscriptionPolicyDecision: paid });
  assert.equal(result.msg.statusCode, 409, 'stale free quote never silently creates paid booking');
  retry.expectedGroupDiscount.amountMinor = 50000; retry.expectedGroupDiscount.discountPercent = 50;
  result = run(retry, null, { _managedSubscriptionPolicyDecision: paid });
  assert.equal(retry.step, 'lk1_daily_visit_retry_saved');
  assert.ok(result.outputs[3]);
  assert.equal(result.msg.payload[0]['failure.rawCode'], 'LK1_DAILY_VISIT_CHANGED');
  assert.equal(result.msg.payload[1].$set.lk1.decision.subscriptionVisitCount, 0);
  assert.equal(result.msg.payload[1].$set.lk1.dailyVisitPolicyVersion, 1);
  run(retry, ack); assert.equal(retry.step, 'operation_preaccept');
});
