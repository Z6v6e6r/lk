import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { PLAN_RULES_LIMIT_8 } from '../lib/lk1ActiveBookingLimit.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { RA_PRODUCT_ID, buildRaTwoHoursPlanRules, buildRaTwoHoursSourceDeltas,
  applyRaTwoHoursSourceDeltas, revertRaTwoHoursSourceDeltas } from '../lib/lk1RaTwoHours.mjs';

// Synthetic IDs only. No product is registered in canonical runtime sources.
const PRODUCT = '00000000-0000-4000-8000-000000000120';
const OTHER = '00000000-0000-4000-8000-000000000121';
const options = { productId: PRODUCT };
const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const booking = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const pro = read('../lib/proTrainingExclusion.mjs');
const evaluator = read('../nodered_lk1_hub_nodes/evaluator.js');
const { rule, forward, reverse } = buildRaTwoHoursPlanRules(options);
const deltas = buildRaTwoHoursSourceDeltas(options);
const nextBooking = applyRaTwoHoursSourceDeltas(booking, deltas.planStore);
const nextGateway = applyRaTwoHoursSourceDeltas(gateway, deltas.freeFirst);
const nextPro = applyRaTwoHoursSourceDeltas(pro, deltas.proDiscount);

function writeGlobal(transition, prior) {
  let value = structuredClone(prior), writes = 0;
  const global = { get: () => value, set: (_key, next) => { value = structuredClone(next); writes += 1; } };
  new Function('global', transition.initialize)(global);
  return { value, writes };
}

test('no product ID, malformed IDs and existing products cannot generate a rule', () => {
  for (const productId of [undefined, '', 'pending', OTHER.toUpperCase().replace('000121', 'ABCDEF'),
    ` ${PRODUCT}`, RA_PRODUCT_ID, 'db7a5250-7369-4f43-8ac5-9111be24bc74',
    'dfa72adf-233b-4285-8d69-e5eab4234fbe', '37ab3713-4431-4815-96ba-d7ece76a9241']) {
    assert.throws(() => buildRaTwoHoursPlanRules({ productId }));
    assert.throws(() => buildRaTwoHoursSourceDeltas({ productId }));
  }
});

test('only the reviewed limit-eight predecessor is accepted for preparation', () => {
  for (const expectedPrior of [null, {}, JSON.stringify(PLAN_RULES_LIMIT_8),
    { ...PLAN_RULES_LIMIT_8, rules: PLAN_RULES_LIMIT_8.rules.slice(1) },
    { ...PLAN_RULES_LIMIT_8, rules: [...PLAN_RULES_LIMIT_8.rules, { ...rule, productId: OTHER }] },
    { ...PLAN_RULES_LIMIT_8, rules: PLAN_RULES_LIMIT_8.rules.map(r => ({ ...r, maxActiveBookings: 6 })) }]) {
    assert.throws(() => buildRaTwoHoursPlanRules({ productId: PRODUCT, expectedPrior }), /prior drift/);
  }
});

test('new rule inherits RA and leaves all nine existing rules unchanged', () => {
  const base = PLAN_RULES_LIMIT_8.rules.find(r => r.productId === RA_PRODUCT_ID);
  assert.deepEqual(rule, { ...base, productId: PRODUCT, planKey: 'ra_two_hours', freeGameMinutesPerDay: 120 });
  assert.deepEqual(forward.desired.rules.slice(0, -1), PLAN_RULES_LIMIT_8.rules);
  assert.equal(forward.desired.rules.length, 10);
  assert.equal(rule.maxActiveBookings, 8);
  assert.equal(rule.enforceFrom, '2026-09-01');
});

test('initializer supports restart, readback and idempotent startup; rollback restores prior', () => {
  for (const prior of [undefined, PLAN_RULES_LIMIT_8, JSON.stringify(PLAN_RULES_LIMIT_8)]) {
    const { value, writes } = writeGlobal(forward, prior);
    assert.deepEqual(value, forward.desired);
    assert.equal(writes, 1);
    assert.equal(writeGlobal(forward, value).writes, 0);
    assert.deepEqual(writeGlobal(reverse, value).value, PLAN_RULES_LIMIT_8);
  }
});

test('initializer and rollback refuse foreign state without overwriting it', () => {
  const foreign = { ...PLAN_RULES_LIMIT_8, rules: PLAN_RULES_LIMIT_8.rules.slice(1) };
  for (const transition of [forward, reverse]) {
    let writes = 0;
    assert.throws(() => new Function('global', transition.initialize)({ get: () => foreign,
      set: () => { writes += 1; } }), /prior mismatch/);
    assert.equal(writes, 0);
  }
});

test('source patches are reversible and reject duplicate, missing or changed anchors', () => {
  for (const [source, changes] of [[booking, deltas.planStore], [gateway, deltas.freeFirst], [pro, deltas.proDiscount]]) {
    const candidate = applyRaTwoHoursSourceDeltas(source, changes);
    assert.equal(revertRaTwoHoursSourceDeltas(candidate, changes), source);
    assert.throws(() => applyRaTwoHoursSourceDeltas(candidate, changes), /already installed/);
    assert.throws(() => applyRaTwoHoursSourceDeltas(source + source, changes), /anchor drift/);
    assert.throws(() => applyRaTwoHoursSourceDeltas(source.replace(changes[0].before, ''), changes), /anchor drift/);
  }
});

function helperClosure(source, roots) {
  const extracted = extractSubscriptionPricePreviewSource({ source, roots });
  return new Function(`${extracted.source}\nreturn { ${roots.join(', ')} };`)();
}

test('booking and preview extraction recognize exact RA 2.0 and share all RA daily categories', () => {
  // These are the same canonical declarations the preview composer extracts.
  const helpers = helperClosure(nextBooking, ['resolvePlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode']);
  assert.equal(helpers.resolvePlanKey({ productId: PRODUCT, name: 'Падел.РА' }), 'ra_two_hours');
  assert.equal(helpers.resolvePlanKey({ productId: RA_PRODUCT_ID, name: 'Падел.РА 2.0' }), 'ra');
  assert.equal(helpers.resolvePlanKey({ name: 'Падел.РА 2.0' }), 'ra_two_hours');
  assert.deepEqual(helpers.PLAN_CATEGORIES.ra_two_hours, ['open_game', 'group_training', 'tournament']);
  assert.deepEqual(helpers.PLAN_CATEGORIES.ra_two_hours, helpers.PLAN_CATEGORIES.ra);
  for (const category of helpers.PLAN_CATEGORIES.ra_two_hours) {
    assert.equal(helpers.resolveLimitMode('ra_two_hours', '2026-10-06'), 'shared_day', category);
  }
});

test('free-first cohort inherits RA without restricting it to Friendship direction 5278', () => {
  const tables = helperClosure(nextGateway, ['LK1_FREE_FIRST_EVENT_PRODUCTS', 'LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES']);
  assert.deepEqual(tables.LK1_FREE_FIRST_EVENT_PRODUCTS[PRODUCT], ['group_training', 'tournament']);
  assert.deepEqual(tables.LK1_FREE_FIRST_EVENT_PRODUCTS[PRODUCT], tables.LK1_FREE_FIRST_EVENT_PRODUCTS[RA_PRODUCT_ID]);
  assert.equal(tables.LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES[PRODUCT], undefined);
  assert.deepEqual(tables.LK1_FREE_FIRST_EVENT_DIRECTION_SCOPES['6b98e7e3-5bd3-4e94-9dc3-7723ea52513e'], [5278]);
});

test('PRO retains RA monetary discount, never Energy visit eligibility', () => {
  const helpers = new Function(`${nextPro.replace(/^export /gm, '')}\nreturn { isProTrainingDiscountRule, isProTrainingEnergyPack };`)();
  assert.equal(helpers.isProTrainingDiscountRule(rule), true);
  assert.equal(helpers.isProTrainingDiscountRule({ ...rule, productId: OTHER }), false);
  assert.equal(helpers.isProTrainingDiscountRule({ ...rule, groupTrainingDiscountPercent: 100 }), false);
  assert.equal(helpers.isProTrainingEnergyPack({ productId: PRODUCT, visitsLeft: 30 }), false);
});

function dailyReadback(existingCategory, overrides = {}, targetCategory = 'open_game') {
  const eventShape = {
    open_game: { exerciseDirection: { id: 4588 }, exerciseType: { id: 1613 } },
    group_training: { exerciseDirection: { id: 4790 }, exerciseType: { id: 605 } },
    tournament: { exerciseDirection: { id: 5278 }, exerciseType: { id: 839 } },
  }[existingCategory];
  const priorBooking = { id: 'fixture-booking', exerciseId: 'fixture-previous-event',
    paymentType: 'SUBSCRIPTION', clientSubscriptionId: 'fixture-selected-sub',
    exerciseDate: '2026-10-07', timeFrom: '10:00:00', timeTo: '11:00:00',
    ...eventShape, ...overrides };
  return new Function('msg', 'global', nextBooking)({ statusCode: 200, payload: [],
    _subscriptionBooking: { caller: 'http', step: 'history_bookings', tenantKey: 'fixture-tenant',
      operationId: 'fixture-operation', authHeader: 'Bearer fixture', exerciseId: 'fixture-next-event',
      clientSubscriptionId: 'fixture-selected-sub', actorClientId: 'fixture-client',
      serviceDate: '2026-10-07', category: targetCategory, planKey: 'ra_two_hours',
      trackedDailyLimit: true, limitMode: 'shared_day', managedEnforcement: { enabled: false },
      activeBookingsPayload: [priorBooking] },
  }, { get: key => key === 'vivacrm_access_token' ? 'fixture-service' : undefined });
}

test('one daily seat covers game, training and tournament in either booking order', () => {
  for (const category of ['open_game', 'group_training', 'tournament'])
    for (const target of ['open_game', 'group_training', 'tournament']) {
    const outputs = dailyReadback(category, {}, target);
    assert.equal(outputs[4].statusCode, 409, category);
    assert.equal(outputs[4].payload.details.code, 'SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED', category);
    assert.equal(outputs[0], null, 'no provider write is emitted');
    assert.equal(outputs[3], null, 'no operation claim is emitted');
  }
});

test('another selected subscription, another day and a cancelled record do not consume seat', () => {
  for (const overrides of [{ clientSubscriptionId: 'fixture-other-sub' },
    { exerciseDate: '2026-10-08' }, { status: 'CANCELLED' }]) {
    const outputs = dailyReadback('open_game', overrides);
    assert.equal(outputs[4], null);
    assert.equal(outputs[1]._subscriptionBooking.step, 'operation_find');
    assert.equal(outputs[1]._subscriptionBooking.operationKey, 'fixture-tenant:fixture-selected-sub:2026-10-07');
  }
});

function evaluate({ duration = 60, action = 'JOIN_GAME', category = 'GAME', active = 0,
  freeFirst, used = 0, selectedRule = rule } = {}) {
  const msg = { _managedSubscriptionPolicyInput: {
    evaluatedAt: '2026-10-06T06:00:00Z', action,
    lk1Policy: selectedRule,
    lk1ProductBinding: { policyProductId: selectedRule.productId,
      ownedProductId: selectedRule.productId, clientSubscriptionId: 'fixture-owned-sub' },
    target: { resolutionSource: 'SERVER', stationId: 'fixture-station', category,
      durationMinutes: duration, startsAt: '2026-10-07T09:00:00Z',
      basePriceMinor: duration * 1000, currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF' },
    usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY', dailyBucketLocalDate: '2026-10-07',
      activeServices: active, usedOrReservedFreeMinutesToday: used, freeFirstEvent: freeFirst },
  } };
  const outputs = new Function('msg', evaluator)(msg);
  const result = (outputs[0] || outputs[1])._managedSubscriptionPolicyDecision;
  assert.equal(result.eligible, true, JSON.stringify(result.blockers));
  return result;
}

test('creating/joining a 60/90/120-minute game consumes one visit and costs zero below cap', () => {
  for (const action of ['CREATE_GAME', 'JOIN_GAME']) for (const duration of [60, 90, 120]) {
    const decision = evaluate({ action, duration, active: 7 });
    assert.equal(decision.subscriptionVisitCount, 1);
    assert.equal(decision.gameMinutes.freeMinutes, duration);
    assert.equal(decision.benefit.finalPriceMinor, 0);
  }
});

test('paid game overage starts after 120 minutes; ordinary RA still covers only 60', () => {
  const next = evaluate({ duration: 180 });
  assert.equal(next.gameMinutes.freeMinutes, 120);
  assert.equal(next.gameMinutes.paidOverageMinutes, 60);
  assert.equal(next.benefit.finalPriceMinor, 42000);
  const old = evaluate({ duration: 120, selectedRule: PLAN_RULES_LIMIT_8.rules.find(r => r.productId === RA_PRODUCT_ID) });
  assert.equal(old.gameMinutes.freeMinutes, 60);
  assert.equal(old.benefit.finalPriceMinor, 42000);
});

test('at eight active records free minutes stop; only 30 percent game discount remains', () => {
  for (const active of [8, 9]) {
    const decision = evaluate({ duration: 120, active });
    assert.equal(decision.subscriptionVisitCount, 0);
    assert.equal(decision.gameMinutes.freeMinutes, 0);
    assert.equal(decision.benefit.finalPriceMinor, 84000);
  }
});

test('non-game first-event rights and later discounts stay identical to RA', () => {
  for (const [category, action] of [['GROUP_TRAINING', 'BOOK_GROUP_TRAINING'], ['TOURNAMENT', 'BOOK_TOURNAMENT']]) {
    for (const active of [0, 8]) for (const usedEventsToday of [0, 1]) for (const visitsLeft of [0, 1]) {
      const args = { category, action, active, duration: 120,
        freeFirst: { covered: true, usedEventsToday, visitsLeft } };
      const decision = evaluate(args);
      const ordinary = evaluate({ ...args, selectedRule: PLAN_RULES_LIMIT_8.rules.find(r => r.productId === RA_PRODUCT_ID) });
      assert.deepEqual(decision, ordinary);
      const free = active < 8 && usedEventsToday === 0 && visitsLeft > 0;
      assert.equal(decision.subscriptionVisitCount, free ? 1 : 0);
      assert.equal(decision.benefit.finalPriceMinor, free ? 0 : 60000);
    }
  }
});

test('PRO without free-first coverage remains a 50 percent monetary discount with no visit', () => {
  const decision = evaluate({ category: 'GROUP_TRAINING', action: 'BOOK_GROUP_TRAINING',
    freeFirst: { covered: false, usedEventsToday: 0, visitsLeft: 30 } });
  assert.equal(decision.subscriptionVisitCount, 0);
  assert.equal(decision.benefit.finalPriceMinor, 30000);
});
