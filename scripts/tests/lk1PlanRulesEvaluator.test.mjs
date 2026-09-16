// LK1 plan-rules evaluator (line B). Focused contract checks:
//  - the active-bookings cap is no longer a blocker (ACTIVE_SERVICES_LIMIT_REACHED is gone),
//  - above the cap a game stays bookable at the overage discount with no free hour and no visit,
//  - below the cap the previous free-hour / partial-price behaviour is unchanged,
//  - the product of the matched rule is validated by shape only, never recognised as HUB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const EVALUATOR_FILE = new URL('../nodered_lk1_hub_nodes/evaluator.js', import.meta.url);
const evaluatorSource = fs.readFileSync(EVALUATOR_FILE, 'utf8');

const HUB_PRODUCT_ID = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
// A plan product (РА) the evaluator must treat exactly like any other UUID.
const PLAN_PRODUCT_ID = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const PROMO_PRODUCT_ID = '3b4806f1-6f9a-46df-a7d7-45075b4e7274';

const RULE = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const ACTION_BY_CATEGORY = { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING',
  TOURNAMENT: 'BOOK_TOURNAMENT' };

function lk1Input(options = {}) {
  const category = options.target?.category || 'GAME';
  const input = {
    evaluatedAt: '2026-08-14T08:00:00.000Z',
    action: ACTION_BY_CATEGORY[category],
    lk1Policy: { ...RULE, ...options.rule },
    lk1ProductBinding: {
      policyProductId: options.productId || PLAN_PRODUCT_ID,
      ownedProductId: options.productId || PLAN_PRODUCT_ID,
      clientSubscriptionId: 'fixture:owned-sub',
    },
    target: {
      resolutionSource: 'SERVER',
      stationId: 'station-home',
      category,
      externalEventTypeId: category.toLowerCase(),
      productTypeId: null,
      eventId: null,
      durationMinutes: 60,
      startsAt: '2026-08-15T07:00:00.000Z',
      basePriceMinor: 100000,
      currency: 'RUB',
      priceSource: 'VIVA_EXISTING_TARIFF',
      ...options.target,
    },
    usage: {
      activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY',
      dailyBucketLocalDate: '2026-08-15',
      activeServices: 0,
      usedOrReservedFreeMinutesToday: 0,
      ...options.usage,
    },
  };
  if (options.binding !== undefined) input.lk1ProductBinding = options.binding;
  if (options.lk1Policy !== undefined) input.lk1Policy = options.lk1Policy;
  if (options.action !== undefined) input.action = options.action;
  return input;
}

function evaluate(input) {
  const msg = { _managedSubscriptionPolicyInput: structuredClone(input) };
  const outputs = new Function('msg', evaluatorSource)(msg);
  const routed = outputs[0] || outputs[1];
  assert.ok(routed, 'the evaluator must route the message to exactly one output');
  return { allowed: outputs[0], blocked: outputs[1],
    decision: routed._managedSubscriptionPolicyDecision };
}

const codes = input => evaluate(input).decision.blockers.map(item => item.code);
const minutes = (freeMinutes, paidOverageMinutes, usedOrReservedFreeMinutesToday = 0) => ({
  localDate: '2026-08-15', usedOrReservedFreeMinutesToday, freeMinutes, paidOverageMinutes,
  discountPercent: 30 });

test('a rule product that is not the HUB annual product keeps the free hour below the cap', () => {
  for (const [activeServices, durationMinutes, freeMinutes, paidOverageMinutes] of [
    [0, 60, 60, 0],
    [0, 90, 60, 30],
    [3, 60, 60, 0],
    [3, 120, 60, 60],
  ]) {
    const input = lk1Input({ usage: { activeServices }, target: { durationMinutes } });
    const result = evaluate(input);
    const label = `active ${activeServices}, ${durationMinutes} minutes`;
    assert.equal(result.decision.eligible, true, label);
    assert.ok(result.allowed, label);
    assert.equal(result.blocked, null, label);
    assert.equal(result.decision.aboveActiveLimit, false, label);
    assert.equal(result.decision.subscriptionVisitCount, 1, label);
    assert.deepEqual(result.decision.gameMinutes,
      { ...minutes(freeMinutes, paidOverageMinutes) }, label);
    assert.deepEqual(evaluate(input).decision, result.decision, 'pure re-evaluation consumes nothing');
  }
});

test('the evaluator holds no product knowledge: HUB and plan products decide identically', () => {
  const plan = evaluate(lk1Input({ productId: PLAN_PRODUCT_ID, usage: { activeServices: 3 } })).decision;
  const hub = evaluate(lk1Input({ productId: HUB_PRODUCT_ID, usage: { activeServices: 3 } })).decision;
  const promo = evaluate(lk1Input({ productId: PROMO_PRODUCT_ID, usage: { activeServices: 3 } })).decision;
  assert.deepEqual(hub, plan);
  assert.deepEqual(promo, plan);
  assert.equal(plan.policyVersion, null, 'Viva product IDs are not CUP policy types');
});

test('activeCount 4 and 5 record the game at the overage discount without a visit or free minutes', () => {
  for (const activeServices of [4, 5, 9]) {
    for (const [durationMinutes, basePriceMinor] of [[60, 100000], [90, 150000], [120, 200000]]) {
      const input = lk1Input({ usage: { activeServices }, target: { durationMinutes, basePriceMinor } });
      const result = evaluate(input);
      const label = `active ${activeServices}, ${durationMinutes} minutes`;
      assert.equal(result.decision.eligible, true, label);
      assert.ok(result.allowed, label);
      assert.equal(result.blocked, null, label);
      assert.equal(result.decision.aboveActiveLimit, true, label);
      assert.equal(result.decision.activeServices, activeServices, label);
      assert.equal(result.decision.maxActiveServices, 4, label);
      assert.equal(result.decision.subscriptionVisitCount, 0, label);
      assert.deepEqual(result.decision.gameMinutes, minutes(0, durationMinutes), label);
      assert.equal(result.decision.benefit.kind, 'PERCENT_DISCOUNT', label);
      assert.equal(result.decision.benefit.ruleId, 'lk1-game', label);
      assert.equal(result.decision.benefit.partialPriceCalculation, null, label);
      assert.equal(result.decision.benefit.discountMinor, basePriceMinor * 0.3, label);
      assert.equal(result.decision.benefit.finalPriceMinor, basePriceMinor * 0.7, label);
      assert.ok(!codes(input).includes('ACTIVE_SERVICES_LIMIT_REACHED'), label);
    }
  }
});

test('above the cap a game ignores the remaining free minutes instead of spending them', () => {
  for (const usedOrReservedFreeMinutesToday of [0, 30, 60, 120]) {
    const input = lk1Input({ usage: { activeServices: 4, usedOrReservedFreeMinutesToday },
      target: { durationMinutes: 90, basePriceMinor: 150000 } });
    const { decision } = evaluate(input);
    assert.equal(decision.eligible, true, `used ${usedOrReservedFreeMinutesToday}`);
    assert.equal(decision.gameMinutes.usedOrReservedFreeMinutesToday, usedOrReservedFreeMinutesToday);
    assert.equal(decision.gameMinutes.freeMinutes, 0, 'no free minute is consumed above the cap');
    assert.equal(decision.gameMinutes.paidOverageMinutes, 90);
    assert.equal(decision.subscriptionVisitCount, 0);
    assert.equal(decision.benefit.finalPriceMinor, 105000);
  }
});

test('activeCount 4 and 5 keep group training and tournaments bookable at 50 percent', () => {
  for (const activeServices of [4, 5]) {
    for (const category of ['GROUP_TRAINING', 'TOURNAMENT']) {
      const input = lk1Input({ target: { category }, usage: { activeServices } });
      const result = evaluate(input);
      const label = `active ${activeServices}, ${category}`;
      assert.equal(result.decision.eligible, true, label);
      assert.ok(result.allowed, label);
      assert.equal(result.decision.aboveActiveLimit, true, label);
      assert.equal(result.decision.subscriptionVisitCount, 0, label);
      assert.equal(result.decision.gameMinutes, undefined, label);
      assert.equal(result.decision.benefit.kind, 'PERCENT_DISCOUNT', label);
      assert.equal(result.decision.benefit.discountMinor, 50000, label);
      assert.equal(result.decision.benefit.finalPriceMinor, 50000, label);
      assert.ok(!codes(input).includes('ACTIVE_SERVICES_LIMIT_REACHED'), label);
    }
  }
});

test('below the cap the free hour, partial overage and group visit rules are unchanged', () => {
  const free = evaluate(lk1Input({ target: { durationMinutes: 60 } })).decision;
  assert.equal(free.benefit.kind, 'FREE_ENTITLEMENT');
  assert.equal(free.subscriptionVisitCount, 1);
  assert.equal(free.benefit.finalPriceMinor, 0);
  assert.equal(free.aboveActiveLimit, false);

  const partial = evaluate(lk1Input({ target: { durationMinutes: 90, basePriceMinor: 150000 } })).decision;
  assert.equal(partial.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.equal(partial.subscriptionVisitCount, 1);
  assert.deepEqual(partial.gameMinutes, minutes(60, 30));
  assert.deepEqual(partial.benefit.partialPriceCalculation, { numerator: 30, denominator: 90,
    chargeBeforeDiscountMinor: 50000, percentageDiscountMinor: 15000 });
  assert.equal(partial.benefit.discountMinor, 115000);
  assert.equal(partial.benefit.finalPriceMinor, 35000);

  const spent = evaluate(lk1Input({ usage: { usedOrReservedFreeMinutesToday: 60 } })).decision;
  assert.equal(spent.benefit.kind, 'PERCENT_DISCOUNT');
  assert.equal(spent.subscriptionVisitCount, 0);
  assert.deepEqual(spent.gameMinutes, minutes(0, 60, 60));
  assert.equal(spent.aboveActiveLimit, false);

  const group = evaluate(lk1Input({ target: { category: 'GROUP_TRAINING' } })).decision;
  assert.equal(group.benefit.kind, 'PERCENT_DISCOUNT');
  assert.equal(group.subscriptionVisitCount, 0);
  assert.equal(group.aboveActiveLimit, false);
});

test('the rule product binding must be a UUID the client owns with an opaque subscription id', () => {
  const forged = [
    null,
    [],
    'uuid',
    42,
    { policyProductId: 'fixture:hub-annual', ownedProductId: 'fixture:hub-annual',
      clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: null, ownedProductId: null, clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: 12345, ownedProductId: 12345, clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: {}, ownedProductId: {}, clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: `${PLAN_PRODUCT_ID} `, ownedProductId: `${PLAN_PRODUCT_ID} `,
      clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: HUB_PRODUCT_ID,
      clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: HUB_PRODUCT_ID, ownedProductId: 'fixture:wrong-product',
      clientSubscriptionId: 'fixture:owned-sub' },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: PLAN_PRODUCT_ID, clientSubscriptionId: '' },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: PLAN_PRODUCT_ID, clientSubscriptionId: '  ' },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: PLAN_PRODUCT_ID, clientSubscriptionId: null },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: PLAN_PRODUCT_ID, clientSubscriptionId: [] },
    { policyProductId: PLAN_PRODUCT_ID, ownedProductId: PLAN_PRODUCT_ID },
  ];
  for (const binding of forged) {
    const result = evaluate(lk1Input({ binding }));
    assert.equal(result.decision.eligible, false, JSON.stringify(binding));
    assert.ok(codes(lk1Input({ binding })).includes('LK1_PRODUCT_BINDING_INVALID'),
      JSON.stringify(binding));
  }

  for (const productId of [PLAN_PRODUCT_ID, HUB_PRODUCT_ID, PROMO_PRODUCT_ID]) {
    const input = lk1Input({ binding: { policyProductId: productId, ownedProductId: productId,
      clientSubscriptionId: `fixture:${productId}` } });
    assert.equal(evaluate(input).decision.eligible, true, productId);
  }
});

test('the removed cap blocker never reappears and the existing fail-closed checks survive', () => {
  for (const usage of [{ activeServices: 4 }, { activeServices: 5 },
    { activeServiceScope: 'ALL_BOOKINGS' }, { activeServices: null }]) {
    const input = lk1Input({ usage });
    assert.ok(!codes(input).includes('ACTIVE_SERVICES_LIMIT_REACHED'), JSON.stringify(usage));
  }

  assert.deepEqual(codes(lk1Input({ usage: { activeServiceScope: 'ALL_BOOKINGS' } })),
    ['USAGE_SNAPSHOT_INVALID']);
  const invalidSnapshot = evaluate(lk1Input({ usage: { activeServices: null } })).decision;
  assert.equal(invalidSnapshot.aboveActiveLimit, false);
  assert.ok(codes(lk1Input({ usage: { dailyBucketLocalDate: '2026-08-14' } }))
    .includes('USAGE_SNAPSHOT_BUCKET_MISMATCH'));
  assert.ok(codes(lk1Input({ usage: { usedOrReservedFreeMinutesToday: null } }))
    .includes('USAGE_SNAPSHOT_BUCKET_MISMATCH'));
  assert.ok(codes(lk1Input({ target: { resolutionSource: 'BROWSER' } }))
    .includes('TARGET_NOT_SERVER_RESOLVED'));
  assert.ok(codes(lk1Input({ target: { currency: 'USD' } })).includes('TARGET_NOT_SERVER_RESOLVED'));
  assert.ok(codes(lk1Input({ target: { priceSource: 'BROWSER' } })).includes('BASE_PRICE_UNRESOLVED'));
  assert.ok(codes(lk1Input({ target: { basePriceMinor: -1 } })).includes('BASE_PRICE_UNRESOLVED'));
  assert.ok(codes(lk1Input({ lk1Policy: null })).includes('LK1_POLICY_INVALID'));
  assert.ok(codes(lk1Input({ rule: { gameOverageDiscountPercent: 101 } })).includes('LK1_POLICY_INVALID'));
});

// The free-first-event rule (owner decision 2026-09-16): in the covered products the first
// group-training/tournament event of the subscription's local day is carried by the plan
// itself — one visit, nothing charged — and every later event that day, or any event once the
// visits are used up, keeps the configured discount without consuming a visit.
test('the covered cohort carries the first event of the day with one visit and no charge', () => {
  for (const category of ['GROUP_TRAINING', 'TOURNAMENT']) {
    const decision = evaluate(lk1Input({ target: { category },
      usage: { freeFirstEvent: { covered: true, usedEventsToday: 0, visitsLeft: 30 } } })).decision;
    assert.equal(decision.eligible, true, category);
    assert.equal(decision.subscriptionVisitCount, 1, category);
    assert.equal(decision.benefit.kind, 'FREE_ENTITLEMENT', category);
    assert.equal(decision.benefit.finalPriceMinor, 0, category);
    assert.equal(decision.benefit.discountMinor, decision.benefit.basePriceMinor, category);
  }
});

test('a later event of the same day, or an exhausted balance, keeps the discount', () => {
  const cases = [
    { name: 'second event', usage: { usedEventsToday: 1, visitsLeft: 30 } },
    { name: 'no visits left', usage: { usedEventsToday: 0, visitsLeft: 0 } },
  ];
  for (const item of cases) {
    const decision = evaluate(lk1Input({ target: { category: 'GROUP_TRAINING' },
      usage: { freeFirstEvent: { covered: true, ...item.usage } } })).decision;
    assert.equal(decision.eligible, true, item.name);
    assert.equal(decision.subscriptionVisitCount, 0, item.name);
    assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT', item.name);
    assert.equal(decision.benefit.finalPriceMinor, 50000, item.name);
  }
  const tournament = evaluate(lk1Input({ target: { category: 'TOURNAMENT' },
    usage: { freeFirstEvent: { covered: true, usedEventsToday: 2, visitsLeft: 3 } } })).decision;
  assert.equal(tournament.benefit.finalPriceMinor, 50000);
  assert.equal(tournament.subscriptionVisitCount, 0);
});

test('a product outside the cohort and an unproved snapshot never grant a free event', () => {
  for (const usage of [{ freeFirstEvent: { covered: false } }, {}]) {
    const decision = evaluate(lk1Input({ target: { category: 'GROUP_TRAINING' }, usage })).decision;
    assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT', JSON.stringify(usage));
    assert.equal(decision.subscriptionVisitCount, 0, JSON.stringify(usage));
  }
  // A covered product must arrive with a proved day bucket and visit balance.
  for (const snapshot of [{ covered: true }, { covered: true, usedEventsToday: -1, visitsLeft: 3 },
    { covered: true, usedEventsToday: 0, visitsLeft: null }]) {
    assert.ok(codes(lk1Input({ target: { category: 'GROUP_TRAINING' }, usage: { freeFirstEvent: snapshot } }))
      .includes('FREE_FIRST_EVENT_SNAPSHOT_INVALID'), JSON.stringify(snapshot));
  }
});

test('the free-first rule stays outside the game path', () => {
  const decision = evaluate(lk1Input({ target: { category: 'GAME' },
    usage: { freeFirstEvent: { covered: true, usedEventsToday: 0, visitsLeft: 30 } } })).decision;
  assert.equal(decision.benefit.kind, 'FREE_ENTITLEMENT');
  assert.equal(decision.subscriptionVisitCount, 1);
  assert.equal(decision.benefit.finalPriceMinor, 0);
});
