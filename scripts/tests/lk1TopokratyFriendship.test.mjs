// «Дружба Топократы» in the LK1 contour (owner decision 2026-09-26).
//
// The club plan (Viva product 14692232-12be-4218-9fa1-2d5b79b62035) carries the five
// standard friendship numbers, and its training direction 6233 is covered like an open
// game: the shared free hour of the day is spent first with one visit, and the minutes
// above it are charged at a quarter of the event's court price, pro rata to the duration.
// Without a free hour (the day's minutes spent, or the active cap reached) the training is
// paid at its full one-time price and consumes no visit.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  LK1_PLAN_RULES_DESIRED,
  LK1_PLAN_RULES_WITH_TOPOKRATY,
  LK1_TOPOKRATY_PRODUCT_ID,
  buildTopokratyPlanRulesTransition,
} from '../lib/lk1PlanRulesTransition.mjs';

const EVALUATOR_FILE = new URL('../nodered_lk1_hub_nodes/evaluator.js', import.meta.url);
const GATEWAY_FILE = new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url);
const PREVIEW_ROUTER_FILE = new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url);
const evaluatorSource = fs.readFileSync(EVALUATOR_FILE, 'utf8');
const gatewaySource = fs.readFileSync(GATEWAY_FILE, 'utf8');
const previewRouterSource = fs.readFileSync(PREVIEW_ROUTER_FILE, 'utf8');

const CLUB_PRODUCT_ID = '14692232-12be-4218-9fa1-2d5b79b62035';
const FRIENDSHIP_PRODUCT_ID = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
const CLUB_TRAINING_DIRECTION_ID = 6233;
const CLUB_GAME_DIRECTION_ID = 6180;
const RULE = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const BASE_PRICE_MINOR = 400000;
const ACTION_BY_CATEGORY = { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING',
  TOURNAMENT: 'BOOK_TOURNAMENT' };

function lk1Input(options = {}) {
  const category = options.target?.category || 'GROUP_TRAINING';
  const input = {
    evaluatedAt: '2026-08-14T08:00:00.000Z',
    action: ACTION_BY_CATEGORY[category],
    lk1Policy: { ...RULE, ...options.rule },
    lk1ProductBinding: {
      policyProductId: options.productId || CLUB_PRODUCT_ID,
      ownedProductId: options.productId || CLUB_PRODUCT_ID,
      clientSubscriptionId: 'fixture:club-sub',
    },
    target: {
      resolutionSource: 'SERVER',
      stationId: 'station-club',
      category,
      externalEventTypeId: 'viva:direction:6233:type:2349',
      productTypeId: null,
      eventId: null,
      durationMinutes: 120,
      startsAt: '2026-08-15T07:00:00.000Z',
      basePriceMinor: BASE_PRICE_MINOR,
      currency: 'RUB',
      priceSource: 'VIVA_EXISTING_TARIFF',
      directionId: CLUB_TRAINING_DIRECTION_ID,
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

const clubMinutes = (freeMinutes, paidOverageMinutes, usedOrReservedFreeMinutesToday = 0) => ({
  localDate: '2026-08-15', usedOrReservedFreeMinutesToday, freeMinutes, paidOverageMinutes,
  discountPercent: 75 });

test('a club training charges a quarter of the court price only for the minutes above the free hour', () => {
  const result = evaluate(lk1Input()).decision;
  assert.equal(result.eligible, true);
  assert.equal(result.subscriptionVisitCount, 1);
  assert.equal(result.eventDiscountPercent, 75);
  assert.deepEqual(result.gameMinutes, clubMinutes(60, 60));
  assert.equal(result.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.equal(result.benefit.basePriceMinor, BASE_PRICE_MINOR);
  // 60 paid minutes of a 120-minute, 4 000 ₽ training: 2 000 ₽ charged, a quarter paid.
  assert.deepEqual(result.benefit.partialPriceCalculation, { numerator: 60, denominator: 120,
    chargeBeforeDiscountMinor: 200000, percentageDiscountMinor: 150000 });
  assert.equal(result.benefit.finalPriceMinor, 50000);
  assert.equal(result.benefit.discountMinor, BASE_PRICE_MINOR - 50000);
});

test('the club co-pay is pro rata to the event duration and the free hour is the shared day bucket', () => {
  for (const [durationMinutes, used, freeMinutes, paidOverageMinutes, finalPriceMinor] of [
    [120, 0, 60, 60, 50000],
    [90, 0, 60, 30, 33334],
    [90, 30, 30, 60, 66667],
    [120, 45, 15, 105, 87500],
  ]) {
    const input = lk1Input({ target: { durationMinutes }, usage: { usedOrReservedFreeMinutesToday: used } });
    const result = evaluate(input).decision;
    const label = `${durationMinutes} min, ${used} used`;
    assert.equal(result.eligible, true, label);
    assert.equal(result.subscriptionVisitCount, 1, label);
    assert.deepEqual(result.gameMinutes,
      { ...clubMinutes(freeMinutes, paidOverageMinutes, used) }, label);
    assert.equal(result.benefit.finalPriceMinor, finalPriceMinor, label);
    // Purity: re-evaluating the same snapshot consumes nothing.
    assert.deepEqual(evaluate(input).decision, result, label);
  }
});

test('an hour or less of club training is carried by the plan with one visit', () => {
  for (const durationMinutes of [60, 30]) {
    const result = evaluate(lk1Input({ target: { durationMinutes } })).decision;
    assert.equal(result.eligible, true);
    assert.equal(result.subscriptionVisitCount, 1);
    assert.equal(result.eventDiscountPercent, 100);
    assert.equal(result.benefit.kind, 'FREE_ENTITLEMENT');
    assert.equal(result.benefit.finalPriceMinor, 0);
    assert.deepEqual(result.gameMinutes,
      { ...clubMinutes(durationMinutes, 0) });
  }
});

test('without a free hour the club training is the full one-time price and no visit', () => {
  for (const [label, options] of [
    ['day minutes spent', { usage: { usedOrReservedFreeMinutesToday: 60 } }],
    ['active cap reached', { usage: { activeServices: 4 } }],
  ]) {
    const result = evaluate(lk1Input(options)).decision;
    assert.equal(result.eligible, true, label);
    assert.equal(result.subscriptionVisitCount, 0, label);
    assert.equal(result.eventDiscountPercent, 0, label);
    assert.equal(result.benefit.kind, 'PERCENT_DISCOUNT', label);
    assert.equal(result.benefit.finalPriceMinor, BASE_PRICE_MINOR, label);
    assert.equal(result.benefit.discountMinor, 0, label);
    assert.deepEqual(result.gameMinutes,
      { ...clubMinutes(0, 120, options.usage?.usedOrReservedFreeMinutesToday || 0) }, label);
  }
});

test('the club rule is bound to the club product and to direction 6233 only', () => {
  const standard = (options) => {
    const result = evaluate(lk1Input(options)).decision;
    assert.equal(result.subscriptionVisitCount, 0);
    assert.equal(result.benefit.kind, 'PERCENT_DISCOUNT');
    return result;
  };
  // Another plan product keeps the standard group-training discount, even on direction 6233.
  const friendship = standard({ productId: FRIENDSHIP_PRODUCT_ID });
  assert.equal(friendship.eventDiscountPercent, 50);
  assert.equal(friendship.benefit.finalPriceMinor, BASE_PRICE_MINOR / 2);
  assert.equal(friendship.gameMinutes, undefined);
  // The club game direction keeps the standard group-training answer as well.
  const clubGame = standard({ target: { directionId: CLUB_GAME_DIRECTION_ID } });
  assert.equal(clubGame.eventDiscountPercent, 50);
  // A tournament of the club keeps its own configured discount.
  const tournament = standard({ target: { category: 'TOURNAMENT' } });
  assert.equal(tournament.eventDiscountPercent, 50);
  assert.equal(tournament.benefit.finalPriceMinor, BASE_PRICE_MINOR / 2);
});

test('the club direction is read through the same aliases the booking target carries', () => {
  for (const direction of [
    { direction: { id: CLUB_TRAINING_DIRECTION_ID } },
    { direction: CLUB_TRAINING_DIRECTION_ID },
    { directionId: String(CLUB_TRAINING_DIRECTION_ID) },
    { exerciseDirection: { directionId: CLUB_TRAINING_DIRECTION_ID } },
  ]) {
    const result = evaluate(lk1Input({ target: { directionId: undefined, ...direction } })).decision;
    assert.equal(result.eventDiscountPercent, 75, JSON.stringify(direction));
  }
  for (const direction of [{ directionId: null }, { directionId: '6233x' }, { directionId: 62330 }]) {
    assert.equal(evaluate(lk1Input({ target: { directionId: undefined, ...direction } })).decision.eventDiscountPercent,
      50, JSON.stringify(direction));
  }
});

test('a day bucket that does not prove the training date fails closed', () => {
  const result = evaluate(lk1Input({ usage: { dailyBucketLocalDate: '2026-08-16' } })).decision;
  assert.equal(result.eligible, false);
  assert.deepEqual(result.blockers.map((item) => item.code), ['USAGE_SNAPSHOT_BUCKET_MISMATCH']);
});

test('the club plan enters the frozen contour as the next guarded generation', () => {
  // The installed payload stays exactly the reviewed generation input.
  assert.equal(LK1_PLAN_RULES_DESIRED.rules.length, 7);
  assert.equal(LK1_PLAN_RULES_DESIRED.rules.some((item) => item.productId === LK1_TOPOKRATY_PRODUCT_ID), false);
  // The club payload is that prior plus one standard friendship rule.
  assert.equal(LK1_PLAN_RULES_WITH_TOPOKRATY.rules.length, 8);
  const club = LK1_PLAN_RULES_WITH_TOPOKRATY.rules.find((item) => item.productId === LK1_TOPOKRATY_PRODUCT_ID);
  assert.deepEqual(club, { productId: LK1_TOPOKRATY_PRODUCT_ID, planKey: 'topocraty',
    enforceFrom: '2026-09-01', ...RULE });
  assert.deepEqual(LK1_PLAN_RULES_WITH_TOPOKRATY.rules.slice(0, 7), LK1_PLAN_RULES_DESIRED.rules);
});

test('the club transition replaces exactly the installed payload and refuses a foreign prior', () => {
  const { expectedPrior, desired, initialize } = buildTopokratyPlanRulesTransition();
  assert.deepEqual(expectedPrior, LK1_PLAN_RULES_DESIRED);
  assert.deepEqual(desired, LK1_PLAN_RULES_WITH_TOPOKRATY);
  new Function('global', 'env', 'node', 'flow', initialize);
  const runInitialize = (context) => new Function('global', 'env', 'node', 'flow', initialize)(context);
  const store = (initial) => {
    const values = new Map(Object.entries(initial));
    return { get: (key) => values.get(key), set: (key, value) => values.set(key, value), values };
  };
  const installed = store({ subscriptions_lk1_plan_rules: structuredClone(LK1_PLAN_RULES_DESIRED) });
  runInitialize({ get: installed.get, set: installed.set });
  assert.deepEqual(installed.get('subscriptions_lk1_plan_rules'), LK1_PLAN_RULES_WITH_TOPOKRATY);
  // Idempotent: the same generation on its own output writes nothing.
  let writes = 0;
  runInitialize({ get: installed.get, set: (key, value) => { writes += 1; installed.set(key, value); } });
  assert.equal(writes, 0);
  // A runtime that already drifted is refused instead of overwritten.
  const foreign = store({ subscriptions_lk1_plan_rules: { formatVersion: 1, rules: [] } });
  assert.throws(() => runInitialize({ get: foreign.get, set: foreign.set }), /prior mismatch; no overwrite/);
  assert.deepEqual(foreign.get('subscriptions_lk1_plan_rules'), { formatVersion: 1, rules: [] });
});

test('the preview quotes the decision a club training actually commits', () => {
  const previewEvaluate = (decision, overrides = {}) => {
    const ctx = { step: 'evaluate', eventCategory: 'GROUP_TRAINING', pending: [],
      currentId: 'sub-club', basePriceMinor: BASE_PRICE_MINOR, groupDiscountPercent: 50,
      target: { durationMinutes: 120, startsAt: '2099-01-01T12:00:00+03:00', stationId: 'station-club', roomId: 'court-club' },
      selectionKey: 'preview:club', priceProductId: 'one-time-carrier', exerciseId: 'club-exercise',
      actorClientId: 'club-actor', quotes: [], catalog: { 'club-product': 'Дружба Топократы' },
      metadata: { 'sub-club': { productId: 'club-product' } }, ...overrides };
    const msg = { _subscriptionPricePreview: ctx, _managedSubscriptionPolicyDecision: decision };
    new Function('msg', 'canonical', previewRouterSource)(msg,
      { isObj: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
        identityMoneyOwned: () => [] });
    return ctx;
  };
  const benefit = (finalPriceMinor, kind) => ({ kind, ruleId: 'lk1-topokraty-training',
    basePriceMinor: BASE_PRICE_MINOR, discountMinor: BASE_PRICE_MINOR - finalPriceMinor,
    surchargeMinor: 0, finalPriceMinor, partialPriceCalculation: null, currency: 'RUB' });
  // A 4 000 ₽ two-hour training: the free hour plus a quarter of the court for the second.
  const partial = previewEvaluate({ eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 75,
    benefit: { ...benefit(50000, 'PARTIAL_PRICE_PERCENT_DISCOUNT'), partialPriceCalculation: { numerator: 60, denominator: 120 } },
    gameMinutes: { freeMinutes: 60, paidOverageMinutes: 60 } });
  assert.equal(partial.error, undefined);
  const [partialQuote] = partial.quotes;
  assert.deepEqual({ ...partialQuote, subscriptionName: undefined, evaluatedAt: undefined, expiresAt: undefined }, {
    subscriptionId: 'sub-club', selectionKey: 'preview:club', status: 'AVAILABLE',
    basePriceMinor: BASE_PRICE_MINOR, amountMinor: 50000, freeMinutes: 60, paidMinutes: 60, reasonCode: null,
    kind: 'GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1', exerciseId: 'club-exercise', actorClientId: 'club-actor',
    productId: 'one-time-carrier', subscriptionName: undefined, discountPercent: 75,
    startsAt: '2099-01-01T12:00:00+03:00', durationMinutes: 120, evaluatedAt: undefined, expiresAt: undefined });
  // Without the free hour the decision charges the full one-time price at 0 %, not the rule's 50 %.
  const fullPrice = previewEvaluate({ eligible: true, subscriptionVisitCount: 0, eventDiscountPercent: 0,
    benefit: benefit(BASE_PRICE_MINOR, 'PERCENT_DISCOUNT') });
  assert.equal(fullPrice.error, undefined);
  assert.equal(fullPrice.quotes[0].amountMinor, BASE_PRICE_MINOR);
  assert.equal(fullPrice.quotes[0].discountPercent, 0);
  assert.equal(fullPrice.quotes[0].freeMinutes, 0);
  // The ordinary answers are unchanged: a configured discount and a visit-covered event.
  const flat = previewEvaluate({ eligible: true, subscriptionVisitCount: 0, eventDiscountPercent: 50,
    benefit: benefit(200000, 'PERCENT_DISCOUNT') });
  assert.equal(flat.error, undefined);
  assert.equal(flat.quotes[0].amountMinor, 200000);
  assert.equal(flat.quotes[0].discountPercent, 50);
  const covered = previewEvaluate({ eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 100,
    benefit: benefit(0, 'FREE_ENTITLEMENT') });
  assert.equal(covered.error, undefined);
  assert.equal(covered.quotes[0].amountMinor, 0);
  assert.equal(covered.quotes[0].discountPercent, 100);
  // A decision whose amount does not follow its own percent never reaches the widget.
  for (const tampered of [
    { eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 75,
      benefit: { ...benefit(40000, 'PARTIAL_PRICE_PERCENT_DISCOUNT'), partialPriceCalculation: { numerator: 60, denominator: 120 } },
      gameMinutes: { freeMinutes: 60, paidOverageMinutes: 60 } },
    { eligible: true, subscriptionVisitCount: 0, eventDiscountPercent: 0,
      benefit: benefit(200000, 'PERCENT_DISCOUNT') },
    { eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 75,
      benefit: benefit(50000, 'PARTIAL_PRICE_PERCENT_DISCOUNT'),
      gameMinutes: { freeMinutes: 0, paidOverageMinutes: 120 } },
  ]) {
    assert.equal(previewEvaluate(tampered).error, 'GROUP_DISCOUNT_DECISION_INVALID', JSON.stringify(tampered));
  }
});

test('the contour sources carry the club rule on the booking, preview and widget paths', () => {
  for (const marker of [
    'const TOPOKRATY_FRIENDSHIP_PRODUCT_ID = "14692232-12be-4218-9fa1-2d5b79b62035";',
    'const TOPOKRATY_TRAINING_DIRECTION_IDS = [6233];',
    'const TOPOKRATY_TRAINING_COURT_PAY_PERCENT = 25;',
    'ruleId: "lk1-topokraty-training"',
    'decision.eventDiscountPercent',
  ]) assert.ok(evaluatorSource.includes(marker), marker);
  for (const marker of [
    'directionId: exerciseDirectionId(exercise),',
    'const lk1ExpectedEventDiscountPercent = (decision, route) => (',
    'expected.discountPercent !== lk1ExpectedEventDiscountPercent(decision, route)',
    // The shared day bucket: the club training publishes gameMinutes, and the allowance
    // accumulator spends exactly those minutes for the same subscription and date.
    'const minutes = operation.lk1.decision.gameMinutes;',
    'used += minutes.freeMinutes;',
  ]) assert.ok(gatewaySource.includes(marker), marker);
  for (const marker of [
    'const previewDirectionId = (canonical, exercise) => {',
    'directionId: previewDirectionId(canonical, exercise),',
    "const paidShare = decision.benefit?.kind === 'PARTIAL_PRICE_PERCENT_DISCOUNT'",
  ]) assert.ok(previewRouterSource.includes(marker), marker);
});
