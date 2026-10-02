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
  LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS,
  LK1_FRIENDSHIP_TWO_HOURS_PRODUCT_ID,
  buildFriendshipTwoHoursPlanRulesTransition,
  buildFriendshipTwoHoursPlanRulesRevert,
  LK1_TOPOKRATY_PRODUCT_ID,
  buildTopokratyPlanRulesRevert,
  buildTopokratyPlanRulesTransition,
} from '../lib/lk1PlanRulesTransition.mjs';
import { isTopokratyClubPack, isTopokratyExercise } from '../lib/topokratyExclusion.mjs';

test('two-hour Friendship has its own Viva identity, 120 free minutes and six active bookings', () => {
  const productId = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
  assert.equal(LK1_FRIENDSHIP_TWO_HOURS_PRODUCT_ID, productId);
  const rule = LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.find(item => item.productId === productId);
  assert.deepEqual(rule, {
    productId, planKey: 'friendship_two_hours', enforceFrom: '2026-09-01',
    maxActiveBookings: 6, freeGameMinutesPerDay: 120,
    gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50,
    tournamentDiscountPercent: 50,
  });
  assert.equal(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.length,
    LK1_PLAN_RULES_WITH_TOPOKRATY.rules.length + 1);
});

test('two-hour rule replaces exactly the eight-rule generation and can revert', () => {
  const forward = buildFriendshipTwoHoursPlanRulesTransition();
  assert.deepEqual(forward.expectedPrior, LK1_PLAN_RULES_WITH_TOPOKRATY);
  assert.deepEqual(forward.desired, LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS);
  const revert = buildFriendshipTwoHoursPlanRulesRevert();
  assert.deepEqual(revert.expectedPrior, LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS);
  assert.deepEqual(revert.desired, LK1_PLAN_RULES_WITH_TOPOKRATY);
});

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

test('the two-hour day is one event: a game of 60/90/120 minutes, then the cap is discount-only', () => {
  const rule = LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.at(-1);
  const input = (used, activeServices, durationMinutes) => lk1Input({
    productId: LK1_FRIENDSHIP_TWO_HOURS_PRODUCT_ID, rule,
    target: { category: 'GAME', durationMinutes, directionId: 4588 },
    usage: { usedOrReservedFreeMinutesToday: used, activeServices },
  });
  // The day's single event may last 60, 90 or 120 minutes inside the 120-minute bucket.
  // A second same-day game never reaches this evaluator: the plan holds one daily seat
  // (shared_day) and the booking router refuses it — see subscriptionBookingGateway.
  for (const [durationMinutes, freeMinutes, visitCount] of [[60, 60, 1], [90, 90, 1], [120, 120, 1]]) {
    const single = evaluate(input(0, 0, durationMinutes)).decision;
    assert.equal(single.eligible, true, `${durationMinutes} minutes`);
    assert.equal(single.gameMinutes.freeMinutes, freeMinutes, `${durationMinutes} minutes`);
    assert.equal(single.subscriptionVisitCount, visitCount, `${durationMinutes} minutes`);
  }
  const seventh = evaluate(input(120, 6, 60)).decision;
  assert.equal(seventh.eligible, true);
  assert.equal(seventh.gameMinutes.freeMinutes, 0);
  assert.equal(seventh.gameMinutes.discountPercent, 30);
  assert.equal(seventh.subscriptionVisitCount, 0);
});

test('group, tournament and «Время на друзей» give 50% without consuming a visit', () => {
  const rule = LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.at(-1);
  // The plan's own benefit for these formats is the discount alone: the visit stays
  // untouched (owner decision 2026-09-30), both below and at the active-bookings cap.
  // The gateway never marks this product as a free-first-event cohort member, so the
  // decision is taken from the snapshot it really produces (`covered: false`).
  for (const [category, directionId, activeServices, snapshot] of [
    ['GROUP_TRAINING', 3685, 0, { covered: false }],
    ['TOURNAMENT', 2617, 0, { covered: false }],
    ['TOURNAMENT', 5278, 0, { covered: false }],
    ['TOURNAMENT', 5278, 6, { covered: false }],
    // Defensive: even a covered snapshot cannot hand out a free event at the cap.
    ['TOURNAMENT', 5278, 6, { covered: true, usedEventsToday: 0, visitsLeft: 5 }],
  ]) {
    const decision = evaluate(lk1Input({ productId: LK1_FRIENDSHIP_TWO_HOURS_PRODUCT_ID,
      rule, target: { category, directionId },
      usage: { activeServices, freeFirstEvent: snapshot },
    })).decision;
    const label = `${category}/${directionId}/active ${activeServices}`;
    assert.equal(decision.eligible, true, label);
    assert.equal(decision.subscriptionVisitCount, 0, label);
    assert.equal(decision.benefit.finalPriceMinor, BASE_PRICE_MINOR / 2, label);
    assert.equal(decision.eventDiscountPercent, 50, label);
  }
});

test('«Время на друзей» is the day’s free event until that day is spent', () => {
  const rule = LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS.rules.at(-1);
  const scene = (snapshot) => evaluate(lk1Input({ productId: LK1_FRIENDSHIP_TWO_HOURS_PRODUCT_ID,
    rule, target: { category: 'TOURNAMENT', directionId: 5278 },
    usage: { activeServices: 0, freeFirstEvent: snapshot } })).decision;
  // The day's free event is still unspent: the «Время на друзей» session is carried by the
  // plan — one visit, nothing charged (owner decision 2026-09-30).
  const free = scene({ covered: true, usedEventsToday: 0, visitsLeft: 10 });
  assert.equal(free.eligible, true);
  assert.equal(free.benefit.kind, 'FREE_ENTITLEMENT');
  assert.equal(free.benefit.finalPriceMinor, 0);
  assert.equal(free.subscriptionVisitCount, 1);
  // The day is already spent (or this is a ПадлхАБ tournament): 50 %, no visit.
  for (const snapshot of [{ covered: false }, { covered: true, usedEventsToday: 1, visitsLeft: 10 }]) {
    const paid = scene(snapshot);
    assert.equal(paid.eligible, true, JSON.stringify(snapshot));
    assert.equal(paid.benefit.kind, 'PERCENT_DISCOUNT', JSON.stringify(snapshot));
    assert.equal(paid.benefit.finalPriceMinor, BASE_PRICE_MINOR / 2, JSON.stringify(snapshot));
    assert.equal(paid.subscriptionVisitCount, 0, JSON.stringify(snapshot));
  }
});

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
  // The paired revert restores the installed payload, so an evaluator rollback can never
  // leave the club rule in the global with an evaluator that has no club branch.
  const revert = buildTopokratyPlanRulesRevert();
  assert.deepEqual(revert.expectedPrior, LK1_PLAN_RULES_WITH_TOPOKRATY);
  assert.deepEqual(revert.desired, LK1_PLAN_RULES_DESIRED);
  const rolledBack = store({ subscriptions_lk1_plan_rules: structuredClone(LK1_PLAN_RULES_WITH_TOPOKRATY) });
  new Function('global', 'env', 'node', 'flow', revert.initialize)({ get: rolledBack.get, set: rolledBack.set });
  assert.deepEqual(rolledBack.get('subscriptions_lk1_plan_rules'), LK1_PLAN_RULES_DESIRED);
});

test('the event payment binding accepts the charged club shapes', () => {
  const bindingSource = fs.readFileSync(
    new URL('../nodered_lk1_hub_nodes/event_payments.js', import.meta.url), 'utf8');
  const lk1EventPaymentBinding = new Function('isObj',
    `${bindingSource}\nreturn lk1EventPaymentQuoteBinding;`)(
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const ctxOf = (decision, rule = { groupTrainingDiscountPercent: 50 }) => ({ caller: 'http',
    category: 'group_training', managedAction: 'BOOK_GROUP_TRAINING', exerciseId: 'club-exercise',
    studioId: 'station-club', lk1: { rule, decision, target: { category: 'GROUP_TRAINING',
      eventId: 'club-exercise', stationId: 'station-club', priceProductId: 'one-time-carrier',
      basePriceMinor: BASE_PRICE_MINOR } } });
  const decisionOf = (over = {}) => ({ eligible: true, subscriptionVisitCount: 1,
    eventDiscountPercent: 75, benefit: { kind: 'PARTIAL_PRICE_PERCENT_DISCOUNT', finalPriceMinor: 50000 },
    gameMinutes: { freeMinutes: 60, paidOverageMinutes: 60 }, ...over });
  const flat = (finalPriceMinor, eventDiscountPercent, kind = 'PERCENT_DISCOUNT') => decisionOf({
    subscriptionVisitCount: 0, eventDiscountPercent, gameMinutes: undefined,
    benefit: { kind, finalPriceMinor } });
  // The co-pay of a two-hour training: one visit spent, 500 ₽ billed on the second hour.
  assert.equal(lk1EventPaymentBinding(ctxOf(decisionOf())).chargeMinor, 50000);
  assert.equal(lk1EventPaymentBinding(ctxOf(decisionOf())).discountMinor, BASE_PRICE_MINOR - 50000);
  // Without the free hour the whole event is billed at the decision's 0 %, not the rule's 50 %.
  assert.equal(lk1EventPaymentBinding(ctxOf(flat(BASE_PRICE_MINOR, 0))).chargeMinor, BASE_PRICE_MINOR);
  // Unchanged answers: a visit-covered event and an ordinary configured discount.
  assert.equal(lk1EventPaymentBinding(ctxOf(decisionOf({ eventDiscountPercent: 100,
    benefit: { kind: 'FREE_ENTITLEMENT', finalPriceMinor: 0 }, gameMinutes: undefined }))).chargeMinor, 0);
  assert.equal(lk1EventPaymentBinding(ctxOf(flat(200000, 50))).chargeMinor, 200000);
  // A share that does not add up, a visit with no share, or a wrongly priced amount is refused.
  for (const bad of [
    decisionOf({ benefit: { kind: 'PARTIAL_PRICE_PERCENT_DISCOUNT', finalPriceMinor: 40000 } }),
    decisionOf({ gameMinutes: { freeMinutes: 60, paidOverageMinutes: 30 } }),
    decisionOf({ gameMinutes: { freeMinutes: 0, paidOverageMinutes: 120 } }),
    decisionOf({ eventDiscountPercent: 50 }),
    decisionOf({ subscriptionVisitCount: 0 }),
  ]) assert.equal(lk1EventPaymentBinding(ctxOf(bad)), null, JSON.stringify(bad));
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

// ---------------------------------------------------------------------------------------------
// The club game direction 6180 (owner decision 2026-10-01): the same visit-based mechanism as a
// game, priced against the player's share (`target.basePriceMinor`), never against a quarter of
// the court. A game of up to 90 minutes is the visit; a longer one spends the shared day bucket
// first and charges the minutes above it at 100 % of that share.
test('a club game of up to 90 minutes is carried by the plan with exactly one visit', () => {
  for (const durationMinutes of [30, 60, 90]) {
    const decision = evaluate(lk1Input({
      target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes },
    })).decision;
    const label = `${durationMinutes} minutes`;
    assert.equal(decision.eligible, true, label);
    assert.equal(decision.subscriptionVisitCount, 1, label);
    assert.equal(decision.eventDiscountPercent, 100, label);
    assert.equal(decision.benefit.kind, 'FREE_ENTITLEMENT', label);
    assert.equal(decision.benefit.basePriceMinor, BASE_PRICE_MINOR, label);
    assert.equal(decision.benefit.finalPriceMinor, 0, label);
    assert.equal(decision.benefit.discountMinor, BASE_PRICE_MINOR, label);
    assert.deepEqual(decision.gameMinutes, { localDate: '2026-08-15',
      usedOrReservedFreeMinutesToday: 0, freeMinutes: durationMinutes, paidOverageMinutes: 0,
      discountPercent: 0 }, label);
  }
});

test('a longer club game charges 100 % of the player share for the minutes above the shared hour', () => {
  const game = (used, durationMinutes = 120) => evaluate(lk1Input({
    target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes },
    usage: { usedOrReservedFreeMinutesToday: used },
  })).decision;
  const full = game(0);
  assert.equal(full.eligible, true);
  assert.equal(full.subscriptionVisitCount, 1);
  assert.equal(full.eventDiscountPercent, 0);
  assert.equal(full.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.deepEqual(full.gameMinutes, { localDate: '2026-08-15',
    usedOrReservedFreeMinutesToday: 0, freeMinutes: 60, paidOverageMinutes: 60, discountPercent: 0 });
  // The partial price is `base * paid / duration` at the decision's 0 % — for a GAME the base
  // already is the player's share, so there is no second division by the court share.
  assert.deepEqual(full.benefit.partialPriceCalculation, { numerator: 60, denominator: 120,
    chargeBeforeDiscountMinor: Math.floor(BASE_PRICE_MINOR * 60 / 120), percentageDiscountMinor: 0 });
  assert.equal(full.benefit.finalPriceMinor, Math.floor(BASE_PRICE_MINOR * 60 / 120));
  // 30 of the 60 minutes already spent: only the remaining half hour is free.
  const shared = game(30);
  assert.equal(shared.subscriptionVisitCount, 1);
  assert.equal(shared.eventDiscountPercent, 0);
  assert.equal(shared.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.deepEqual(shared.gameMinutes, { localDate: '2026-08-15',
    usedOrReservedFreeMinutesToday: 30, freeMinutes: 30, paidOverageMinutes: 90, discountPercent: 0 });
  assert.equal(shared.benefit.finalPriceMinor, Math.floor(BASE_PRICE_MINOR * 90 / 120));
  // Purity: re-evaluating the same snapshot consumes nothing.
  const input = lk1Input({ target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120 },
    usage: { usedOrReservedFreeMinutesToday: 30 } });
  assert.deepEqual(evaluate(input).decision, shared);
});

test('without a free visit the club game is the full base price and consumes no visit', () => {
  for (const [label, usage] of [
    ['day minutes spent', { usedOrReservedFreeMinutesToday: 60 }],
    ['active cap reached', { activeServices: 4 }],
  ]) {
    const decision = evaluate(lk1Input({
      target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120 },
      usage,
    })).decision;
    assert.equal(decision.eligible, true, label);
    assert.equal(decision.subscriptionVisitCount, 0, label);
    assert.equal(decision.eventDiscountPercent, 0, label);
    assert.equal(decision.benefit.kind, 'PERCENT_DISCOUNT', label);
    assert.equal(decision.benefit.finalPriceMinor, BASE_PRICE_MINOR, label);
    assert.equal(decision.benefit.discountMinor, 0, label);
    assert.deepEqual(decision.gameMinutes, { localDate: '2026-08-15',
      usedOrReservedFreeMinutesToday: usage.usedOrReservedFreeMinutesToday || 0,
      freeMinutes: 0, paidOverageMinutes: 120, discountPercent: 0 }, label);
  }
});

test('the club game rule stays bound to the club product and to direction 6180', () => {
  const game = (options = {}) => evaluate(lk1Input({
    ...options,
    target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120,
      ...options.target },
  })).decision;
  // Another plan product on the club game direction keeps the standard GAME branch: the
  // configured overage discount, not the club visit.
  const friendship = game({ productId: FRIENDSHIP_PRODUCT_ID });
  assert.equal(friendship.eligible, true);
  assert.equal(friendship.eventDiscountPercent, 30);
  assert.equal(friendship.gameMinutes.discountPercent, 30);
  assert.equal(friendship.benefit.kind, 'PARTIAL_PRICE_PERCENT_DISCOUNT');
  assert.equal(friendship.benefit.finalPriceMinor, 140000);
  // The club product on a foreign game direction keeps the standard branch too.
  const foreignDirection = game({ target: { directionId: 4588 } });
  assert.equal(foreignDirection.eventDiscountPercent, 30);
  assert.equal(foreignDirection.gameMinutes.discountPercent, 30);
  // A club tournament keeps its own configured discount.
  const tournament = game({ target: { category: 'TOURNAMENT' } });
  assert.equal(tournament.eventDiscountPercent, 50);
});

test('the club game fails closed when the paid share has no proven tariff', () => {
  const decision = evaluate(lk1Input({
    target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120,
      priceSource: undefined },
  })).decision;
  assert.equal(decision.eligible, false);
  assert.ok(decision.blockers.some((item) => item.code === 'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND'),
    JSON.stringify(decision.blockers));
});

// ---------------------------------------------------------------------------------------------
// The club-only gate is the reviewed HUB_EXERCISE hook, run here on the real control flow with
// intercepting stubs so the refusal is proven rather than matched as text.
const hooksSource = fs.readFileSync(
  new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8');

function hookSections(source) {
  const parts = source.split(/^\/\/ HUB_([A-Z]+)\s*$/m);
  const result = {};
  for (let i = 1; i < parts.length; i += 2) result[parts[i]] = parts[i + 1].trim();
  return result;
}

function runExerciseHook(options = {}) {
  const calls = { finishError: [] };
  const stubs = new Proxy({
    ctx: { caller: 'http', tenantKey: 'iSkq6G', clientSubscriptionId: 'sub-1', managedAction: 'JOIN_GAME' },
    msg: {},
    isProTrainingExercise: () => false,
    isProTrainingEnergyPack: () => false,
    isTopokratyExercise,
    isTopokratyClubPack,
    resolveCategory: () => options.category ?? 'open_game',
    findOwnedSubscriptions: () => options.selectedOwned ?? [],
    lk1Config: () => options.rule ?? { matched: false },
    lk1ReadPlanRules: () => options.planRules ?? null,
    lk1QuoteOwned: () => options.quoteOwned ?? [],
    lk1Quote: () => ({ code: 'LK1_EVENT_TARIFF_UNVERIFIED' }),
    managedActionForTarget: () => 'JOIN_GAME',
    finishError: (ctx, status, message, body) => {
      calls.finishError.push({ status, message, body }); return { finished: true };
    },
    lk1Stop: (ctx, code) => ({ stopped: code }),
    prepareUserGet: (ctx, step) => ({ prepared: step }),
    emit: index => ({ emitted: index }),
    global: { get: () => null },
    LK1_PRODUCT_POLICY_GLOBAL: 'subscriptions_lk1_product_policy',
    OUTPUT_FINAL: 4,
    OUTPUT_MANAGED_POLICY: 6,
  }, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : globalThis[key]),
  });
  const section = hookSections(hooksSource).EXERCISE;
  const factory = new Function('stubs', `with (stubs) { return (ctx, exercise, msg) => {\n${section}\n}; }`);
  return {
    result: factory(stubs)(stubs.ctx,
      options.exercise ?? { direction: { id: CLUB_GAME_DIRECTION_ID, name: 'Топократы игра' } },
      stubs.msg),
    calls,
  };
}

test('the club gate refuses a non-club subscription on a 6180 game and allows the club pack', () => {
  // The 6180 game resolves to `open_game`, so the widened gate must fire for it too.
  const foreign = runExerciseHook({ selectedOwned: [{ productId: FRIENDSHIP_PRODUCT_ID }] });
  assert.equal(foreign.calls.finishError.length, 1);
  assert.equal(foreign.calls.finishError[0].status, 409);
  assert.equal(foreign.calls.finishError[0].body.code, 'TOPOKRATY_SUBSCRIPTION_UNAVAILABLE');
  assert.match(foreign.calls.finishError[0].message, /На занятия Топократов общие подписки не действуют/);
  // The club pack keeps the club game benefit and reaches the plan-rule path.
  const club = runExerciseHook({ selectedOwned: [{ productId: CLUB_PRODUCT_ID }],
    quoteOwned: [{ productId: CLUB_PRODUCT_ID }], rule: { matched: false } });
  assert.equal(club.calls.finishError.length, 0);
  // The training direction of the club stays gated on the same condition.
  const training = runExerciseHook({ category: 'group_training',
    exercise: { direction: { id: CLUB_TRAINING_DIRECTION_ID, name: 'Топократы тренировка' } },
    selectedOwned: [{ productId: FRIENDSHIP_PRODUCT_ID }] });
  assert.equal(training.calls.finishError[0].body.code, 'TOPOKRATY_SUBSCRIPTION_UNAVAILABLE');
  // A game on another direction is untouched by the club gate.
  const ordinary = runExerciseHook({ exercise: { direction: { id: 4588, name: 'Открытая игра' } },
    selectedOwned: [{ productId: FRIENDSHIP_PRODUCT_ID }] });
  assert.equal(ordinary.calls.finishError[0]?.body.code, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE');
});

test('the booking router classifies the club directions without the Viva name', () => {
  const router = fs.readFileSync(
    new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url),
    'utf8');
  const categorySource = router.slice(router.indexOf('const resolveCategory ='),
    router.indexOf('const eventDate ='));
  const resolve = new Function('isObj', 'numericId', 'markerName', 'normalizeMarker',
    `${categorySource}; return resolveCategory;`)(
    (value) => Boolean(value) && typeof value === 'object',
    (value) => { const id = Number(value?.id ?? value); return Number.isFinite(id) ? Math.trunc(id) : null; },
    () => null, (value) => String(value || '').trim().toLowerCase());
  // A rename in Viva that drops «игра»/«тренировка» cannot move the club contour.
  assert.equal(resolve({ direction: { id: 6180, name: 'Клубная встреча' } }), 'open_game');
  assert.equal(resolve({ directionId: 6233, title: 'Клубная встреча' }), 'group_training');
  // Type 2349 is shared with «Атланты» (direction 6152): the type alone is never a category.
  assert.equal(resolve({ type: { id: 2349 } }), null);
  assert.equal(resolve({ direction: { id: 6152, name: 'Атланты' } }), null);
});
