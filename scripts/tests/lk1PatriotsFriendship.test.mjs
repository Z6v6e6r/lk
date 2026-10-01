import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  LK1_PATRIOTS_PRODUCT_ID,
  LK1_PLAN_RULES_WITH_PATRIOTS,
  LK1_PLAN_RULES_WITH_TOPOKRATY,
  buildPatriotsPlanRulesRevert,
  buildPatriotsPlanRulesTransition,
} from '../lib/lk1PlanRulesTransition.mjs';
import { composePatriotsArtifacts, PATRIOTS_NODES,
  PATRIOTS_POSTIMAGE } from '../patch_live_lk1_patriots_friendship.mjs';

const evaluatorSource = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/evaluator.js', import.meta.url), 'utf8');
const paymentSource = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/event_payments.js', import.meta.url), 'utf8');
const bookingRouterSource = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const rule = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };

function evaluate(category, externalEventTypeId, overrides = {}) {
  const input = {
    evaluatedAt: '2026-09-30T09:00:00.000Z',
    action: { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING',
      TOURNAMENT: 'BOOK_TOURNAMENT' }[category],
    lk1Policy: rule,
    lk1ProductBinding: { policyProductId: LK1_PATRIOTS_PRODUCT_ID,
      ownedProductId: LK1_PATRIOTS_PRODUCT_ID, clientSubscriptionId: 'fixture:patriots' },
    target: { resolutionSource: 'SERVER', category, externalEventTypeId,
      stationId: 'station', eventId: 'exercise', durationMinutes: 90,
      startsAt: '2026-10-01T08:00:00.000Z', basePriceMinor: 300000,
      currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF', ...overrides.target },
    usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY',
      dailyBucketLocalDate: '2026-10-01', activeServices: 0,
      usedOrReservedFreeMinutesToday: 0, freeFirstEvent: { covered: false }, ...overrides.usage },
  };
  const msg = { _managedSubscriptionPolicyInput: input };
  const output = new Function('msg', evaluatorSource)(msg);
  return (output[0] || output[1])._managedSubscriptionPolicyDecision;
}

function context(initial) {
  const values = new Map(initial ? [['subscriptions_lk1_plan_rules', initial]] : []);
  return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
}

test('Viva Patriots exercises are classified by direction and type, independent of names', () => {
  const source = bookingRouterSource.slice(bookingRouterSource.indexOf('const resolveCategory ='),
    bookingRouterSource.indexOf('function normalizeServiceDateMoscow'));
  const resolveCategory = new Function('isObj', 'numericId', 'markerName', 'normalizeMarker',
    `${source}\nreturn resolveCategory;`)(
    value => value !== null && typeof value === 'object' && !Array.isArray(value),
    value => Number(value?.id ?? value), value => value?.name ?? String(value ?? ''),
    value => String(value ?? '').toLowerCase().replace(/[^a-z0-9а-я]+/gi, ''));
  for (const [directionId, typeId, category] of [
    [6181, 2349, 'open_game'], [6306, 2349, 'tournament'],
    [6307, 2349, 'group_training'], [5278, 839, 'tournament'],
    [4588, 1613, 'open_game'],
  ]) {
    assert.equal(resolveCategory({ direction: { id: directionId, name: 'без метки' },
      type: { id: typeId, name: 'без метки' } }), category, `${directionId}/${typeId}`);
  }
});

test('Patriots rule is an exact guarded addition to the installed Topokraty rules', () => {
  assert.deepEqual(LK1_PLAN_RULES_WITH_PATRIOTS.rules.slice(0, 8), LK1_PLAN_RULES_WITH_TOPOKRATY.rules);
  assert.deepEqual(LK1_PLAN_RULES_WITH_PATRIOTS.rules[8], {
    productId: LK1_PATRIOTS_PRODUCT_ID, planKey: 'patriots', enforceFrom: '2026-09-01', ...rule,
  });
  const transition = buildPatriotsPlanRulesTransition();
  assert.deepEqual(transition.expectedPrior, LK1_PLAN_RULES_WITH_TOPOKRATY);
  const live = context(structuredClone(LK1_PLAN_RULES_WITH_TOPOKRATY));
  new Function('global', transition.initialize)(live);
  assert.deepEqual(live.get('subscriptions_lk1_plan_rules'), LK1_PLAN_RULES_WITH_PATRIOTS);
  assert.throws(() => new Function('global', transition.initialize)(context({ formatVersion: 1, rules: [] })),
    /prior mismatch; no overwrite/);
  const revert = buildPatriotsPlanRulesRevert();
  new Function('global', revert.initialize)(live);
  assert.deepEqual(live.get('subscriptions_lk1_plan_rules'), LK1_PLAN_RULES_WITH_TOPOKRATY);
});

test('Patriots games spend the free hour and discount only the paid minutes', () => {
  for (const eventType of ['viva:direction:6181:type:2349', 'viva:direction:4588:type:1613']) {
    const partial = evaluate('GAME', eventType);
    assert.equal(partial.eligible, true, eventType);
    assert.equal(partial.subscriptionVisitCount, 1, eventType);
    assert.deepEqual(partial.gameMinutes, { localDate: '2026-10-01', usedOrReservedFreeMinutesToday: 0,
      freeMinutes: 60, paidOverageMinutes: 30, discountPercent: 30 });
    assert.equal(partial.benefit.finalPriceMinor, 70000, eventType);
    for (const usage of [{ usedOrReservedFreeMinutesToday: 60 }, { activeServices: 4 }]) {
      const discounted = evaluate('GAME', eventType, { usage });
      assert.equal(discounted.eligible, true, eventType);
      assert.equal(discounted.subscriptionVisitCount, 0, eventType);
      assert.equal(discounted.gameMinutes.freeMinutes, 0, eventType);
      assert.equal(discounted.benefit.finalPriceMinor, 210000, eventType);
    }
  }
});

test('Patriots event directions always receive 50 percent without a visit', () => {
  for (const [category, eventType] of [
    ['GROUP_TRAINING', 'viva:direction:6307:type:2349'],
    ['TOURNAMENT', 'viva:direction:6306:type:2349'],
    ['TOURNAMENT', 'viva:direction:5278:type:839'],
  ]) {
    const decision = evaluate(category, eventType);
    assert.equal(decision.eligible, true, eventType);
    assert.equal(decision.subscriptionVisitCount, 0, eventType);
    assert.equal(decision.eventDiscountPercent, 50, eventType);
    assert.equal(decision.benefit.finalPriceMinor, 150000, eventType);
    assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT', eventType);
    const capped = evaluate(category, eventType, { usage: { activeServices: 4,
      freeFirstEvent: { covered: true, usedEventsToday: 0, visitsLeft: 30 } } });
    assert.equal(capped.subscriptionVisitCount, 0, eventType);
    assert.equal(capped.benefit.finalPriceMinor, 150000, eventType);
  }
});

test('Patriots event discounts refuse another direction, type or category', () => {
  for (const [category, eventType] of [
    ['GAME', 'viva:direction:6152:type:2349'],
    ['GAME', 'viva:direction:6181:type:839'],
    ['TOURNAMENT', 'viva:direction:5278:type:2349'],
    ['GROUP_TRAINING', 'viva:direction:5278:type:839'],
    ['TOURNAMENT', 'viva:direction:6307:type:2349'],
    ['GROUP_TRAINING', 'viva:direction:6233:type:2349'],
    ['TOURNAMENT', null],
  ]) {
    const decision = evaluate(category, eventType);
    assert.equal(decision.eligible, false, String(eventType));
    assert.ok(decision.blockers.some((blocker) => blocker.code === 'EVENT_NOT_INCLUDED'), String(eventType));
  }
});

test('a 5278 discount binds the one-time SERVICE tariff, not a subscription visit', () => {
  const decision = evaluate('TOURNAMENT', 'viva:direction:5278:type:839');
  const binding = new Function('isObj', `${paymentSource}\nreturn lk1EventPaymentQuoteBinding;`)(
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const ctx = { caller: 'http', category: 'tournament', managedAction: 'BOOK_TOURNAMENT',
    exerciseId: 'exercise', studioId: 'station', lk1: { rule, decision,
      target: { category: 'TOURNAMENT', eventId: 'exercise', stationId: 'station',
        priceProductId: 'one-time-service', basePriceMinor: 300000 } } };
  assert.deepEqual(binding(ctx), { productId: 'one-time-service', productType: 'SERVICE',
    baseMinor: 300000, chargeMinor: 150000, discountMinor: 150000 });
  assert.equal(binding({ ...ctx, lk1: { ...ctx.lk1,
    decision: { ...decision, subscriptionVisitCount: 1 } } }), null);
});

const privateLiveFlow = process.env.LK1_PATRIOTS_LIVE_FLOW;
test('the private live snapshot yields only the reviewed four-node candidate',
  { skip: !privateLiveFlow || !fs.existsSync(privateLiveFlow) }, () => {
    const source = fs.readFileSync(privateLiveFlow);
    const built = composePatriotsArtifacts(source);
    assert.deepEqual(built.changes, [
      { id: PATRIOTS_NODES.gateway, fields: ['func', 'initialize'] },
      { id: PATRIOTS_NODES.evaluator, fields: ['func'] },
      { id: PATRIOTS_NODES.preview, fields: ['func'] },
      { id: PATRIOTS_NODES.previewEvaluator, fields: ['func'] },
    ]);
    assert.deepEqual(built.postimages, PATRIOTS_POSTIMAGE);
    const candidate = JSON.parse(built.candidateBytes.toString('utf8'));
    const preview = candidate.find(node => node.id === PATRIOTS_NODES.preview);
    assert.match(preview.func, /typeId === 2349 && directionId === 6181/);
    assert.throws(() => composePatriotsArtifacts(built.candidateBytes), /Live flow preimage drift/);
  });
