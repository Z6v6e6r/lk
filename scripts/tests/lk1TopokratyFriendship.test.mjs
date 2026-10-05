// «Дружба Топократы» in the LK1 contour (owner decision 2026-09-26).
//
// The club plan (Viva product 14692232-12be-4218-9fa1-2d5b79b62035) carries the five
// standard friendship numbers, and its training direction 6233 is covered like an open
// game: the shared free hour of the day is spent first with one visit. Owner decision
// 2026-10-05: every further hour then costs exactly ONE QUARTER of the HOURLY court price
// proved server-side for the event's station, room and time (Skolkovo: 6 000 ₽/hour ->
// 1 500 ₽ for the second hour), with no re-scaling of the base by minutes and no second
// division by four. Without a free hour (the day's minutes spent, or the active cap
// reached) the training is paid at its full one-time price and consumes no visit.
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
// Skolkovo court: 6 000 ₽ per hour, i.e. 12 000 ₽ for the two-hour training window.
const COURT_HOURLY_MINOR = 600000;
const CLUB_PARTIAL_CALC = Object.freeze({ chargeableHours: 1, hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
  perHourMinor: 150000, chargeBeforeDiscountMinor: 150000, percentageDiscountMinor: 0 });
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
      hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
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
  localDate: '2026-08-15', usedOrReservedFreeMinutesToday, freeMinutes, paidOverageMinutes });
const clubPartial = (hours, finalPriceMinor) => ({
  kind: 'COURT_HOURLY_COPAY', ruleId: 'lk1-topokraty-training', basePriceMinor: BASE_PRICE_MINOR,
  discountMinor: BASE_PRICE_MINOR - finalPriceMinor, surchargeMinor: 0,
  finalPriceMinor,
  partialPriceCalculation: { ...CLUB_PARTIAL_CALC, chargeableHours: hours,
    chargeBeforeDiscountMinor: hours * 150000 },
  currency: 'RUB' });

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

test('Skolkovo 6 000 ₽/hour, 2-hour club training, free visit: co-pay 1 500 ₽ and one visit', () => {
  const result = evaluate(lk1Input()).decision;
  assert.equal(result.eligible, true);
  assert.equal(result.subscriptionVisitCount, 1);
  assert.equal(result.eventDiscountPercent, 0);
  assert.deepEqual(result.courtMinutes, clubMinutes(60, 60));
  assert.equal(result.gameMinutes, undefined);
  assert.deepEqual(result.benefit, clubPartial(1, 150000));
});

test('Skolkovo 6 000 ₽/hour, 3-hour club training: two chargeable hours -> 3 000 ₽', () => {
  const result = evaluate(lk1Input({ target: { durationMinutes: 180 } })).decision;
  assert.equal(result.eligible, true);
  assert.equal(result.subscriptionVisitCount, 1);
  assert.equal(result.eventDiscountPercent, 0);
  assert.deepEqual(result.courtMinutes, clubMinutes(60, 120));
  assert.equal(result.benefit.kind, 'COURT_HOURLY_COPAY');
  assert.equal(result.benefit.finalPriceMinor, 300000);
  assert.equal(result.benefit.partialPriceCalculation.chargeableHours, 2);
  assert.equal(result.benefit.partialPriceCalculation.perHourMinor, 150000);
});

test('a partially spent club day still charges whole court hours over the free minutes', () => {
  for (const [durationMinutes, used, freeMinutes, paidOverageMinutes, hours, finalPriceMinor] of [
    [120, 0, 60, 60, 1, 150000],
    [180, 0, 60, 120, 2, 300000],
    [90, 30, 30, 60, 1, 150000],
    [120, 45, 15, 105, 2, 300000],
  ]) {
    const input = lk1Input({ target: { durationMinutes }, usage: { usedOrReservedFreeMinutesToday: used } });
    const result = evaluate(input).decision;
    const label = `${durationMinutes} min, ${used} used`;
    assert.equal(result.eligible, true, label);
    assert.equal(result.subscriptionVisitCount, 1, label);
    assert.deepEqual(result.courtMinutes, clubMinutes(freeMinutes, paidOverageMinutes, used), label);
    assert.equal(result.benefit.finalPriceMinor, finalPriceMinor, label);
    assert.equal(result.benefit.partialPriceCalculation.chargeableHours, hours, label);
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
    assert.deepEqual(result.courtMinutes,
      { ...clubMinutes(durationMinutes, 0) });
  }
});

test('without a proven hourly court price the club co-pay refuses instead of using the tariff', () => {
  for (const [label, target] of [
    ['hourly court price absent', { hourlyCourtPriceMinor: undefined }],
    ['hourly court price zero', { hourlyCourtPriceMinor: 0 }],
    ['hourly court price not proven as integer', { hourlyCourtPriceMinor: COURT_HOURLY_MINOR + 0.5 }],
  ]) {
    for (const durationMinutes of [120, 180]) {
      const decision = evaluate(lk1Input({ target: { durationMinutes, ...target } })).decision;
      const scene = `${label}, ${durationMinutes} min`;
      assert.equal(decision.eligible, false, scene);
      assert.deepEqual(decision.blockers.map((item) => item.code), ['LK1_COURT_PRICE_UNRESOLVED'], scene);
      assert.equal(decision.benefit?.finalPriceMinor, undefined, scene);
      assert.equal(decision.subscriptionVisitCount, 1, scene);
      assert.deepEqual(decision.courtMinutes, clubMinutes(60, durationMinutes - 60), scene);
    }
  }
});

test('Skolkovo 6 000 ₽/hour, no free visit: full one-time price 4 000 ₽ and no visit', () => {
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
    assert.deepEqual(result.courtMinutes,
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
    assert.equal(result.eventDiscountPercent, 0, JSON.stringify(direction));
    assert.equal(result.benefit.kind, 'COURT_HOURLY_COPAY', JSON.stringify(direction));
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

test('the event payment carrier bills the club court-hourly co-pay', () => {
  const bindingSource = fs.readFileSync(
    new URL('../nodered_lk1_hub_nodes/event_payments.js', import.meta.url), 'utf8');
  const lk1EventPaymentBinding = new Function('isObj',
    `${bindingSource}\nreturn lk1EventPaymentQuoteBinding;`)(
    (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const ctxOf = (decision) => ({ caller: 'http', category: 'group_training',
    managedAction: 'BOOK_GROUP_TRAINING', exerciseId: 'club-exercise', studioId: 'station-club',
    lk1: { rule: { groupTrainingDiscountPercent: 50 }, decision,
      target: { category: 'GROUP_TRAINING', eventId: 'club-exercise', stationId: 'station-club',
        priceProductId: 'one-time-carrier', basePriceMinor: BASE_PRICE_MINOR } } });
  const courtDecision = (hours, finalPriceMinor, over = {}) => ({
    eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 0,
    benefit: { kind: 'COURT_HOURLY_COPAY', ruleId: 'lk1-topokraty-training',
      basePriceMinor: BASE_PRICE_MINOR, discountMinor: BASE_PRICE_MINOR - finalPriceMinor,
      surchargeMinor: 0, finalPriceMinor, currency: 'RUB',
      partialPriceCalculation: { chargeableHours: hours, hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
        perHourMinor: 150000, chargeBeforeDiscountMinor: hours * 150000, percentageDiscountMinor: 0 } },
    courtMinutes: { localDate: '2026-08-15', usedOrReservedFreeMinutesToday: 0,
      freeMinutes: 60, paidOverageMinutes: hours * 60 }, ...over });
  // Skolkovo: 4 000 ₽ event tariff, 1 500 ₽ co-pay -> the carrier discount is 2 500 ₽.
  assert.equal(lk1EventPaymentBinding(ctxOf(courtDecision(1, 150000))).chargeMinor, 150000);
  assert.equal(lk1EventPaymentBinding(ctxOf(courtDecision(1, 150000))).discountMinor, BASE_PRICE_MINOR - 150000);
  // A 3-hour training: two chargeable hours -> 3 000 ₽.
  assert.equal(lk1EventPaymentBinding(ctxOf(courtDecision(2, 300000))).chargeMinor, 300000);
  // A co-pay above the event tariff is refused rather than billed.
  for (const bad of [
    courtDecision(1, 400000),
    courtDecision(1, 150000, { benefit: { kind: 'COURT_HOURLY_COPAY', finalPriceMinor: 150000,
      partialPriceCalculation: { chargeableHours: 1, hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
        perHourMinor: 200000, chargeBeforeDiscountMinor: 200000, percentageDiscountMinor: 0 } } }),
    courtDecision(1, 150000, { subscriptionVisitCount: 0 }),
  ]) assert.equal(lk1EventPaymentBinding(ctxOf(bad)), null, JSON.stringify(bad));
});

test('the preview quotes the court-hourly decision the club training commits', () => {
  const previewEvaluate = (decision, overrides = {}) => {
    const ctx = { step: 'evaluate', eventCategory: 'GROUP_TRAINING', pending: [],
      currentId: 'sub-club', basePriceMinor: BASE_PRICE_MINOR, groupDiscountPercent: 50,
      hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
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
  const courtBenefit = (hours, finalPriceMinor) => ({ ...benefit(finalPriceMinor, 'COURT_HOURLY_COPAY'),
    partialPriceCalculation: { chargeableHours: hours, hourlyCourtPriceMinor: COURT_HOURLY_MINOR,
      perHourMinor: 150000, chargeBeforeDiscountMinor: hours * 150000, percentageDiscountMinor: 0 } });
  const courtDecision = (freeMinutes, paidMinutes, hours, finalPriceMinor) => ({
    eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 0,
    benefit: courtBenefit(hours, finalPriceMinor),
    courtMinutes: { localDate: '2099-01-01', usedOrReservedFreeMinutesToday: 0,
      freeMinutes, paidOverageMinutes: paidMinutes } });
  // Skolkovo 6 000 ₽/hour, 2-hour training: the free hour, then 1 500 ₽ for the second hour.
  const partial = previewEvaluate(courtDecision(60, 60, 1, 150000));
  assert.equal(partial.error, undefined);
  const [partialQuote] = partial.quotes;
  assert.deepEqual({ ...partialQuote, subscriptionName: undefined, evaluatedAt: undefined, expiresAt: undefined }, {
    subscriptionId: 'sub-club', selectionKey: 'preview:club', status: 'AVAILABLE',
    basePriceMinor: BASE_PRICE_MINOR, amountMinor: 150000, freeMinutes: 60, paidMinutes: 60, reasonCode: null,
    kind: 'GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1', exerciseId: 'club-exercise', actorClientId: 'club-actor',
    productId: 'one-time-carrier', subscriptionName: undefined, discountPercent: 0,
    startsAt: '2099-01-01T12:00:00+03:00', durationMinutes: 120, evaluatedAt: undefined, expiresAt: undefined });
  // Skolkovo, 3-hour training: two chargeable hours -> 3 000 ₽.
  const threeHours = previewEvaluate(courtDecision(60, 120, 2, 300000),
    { target: { durationMinutes: 180, startsAt: '2099-01-01T12:00:00+03:00', stationId: 'station-club', roomId: 'court-club' } });
  assert.equal(threeHours.error, undefined);
  assert.equal(threeHours.quotes[0].amountMinor, 300000);
  assert.equal(threeHours.quotes[0].paidMinutes, 120);
  assert.equal(threeHours.quotes[0].discountPercent, 0);
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
  // A decision whose amount does not follow its own court arithmetic never reaches the widget.
  for (const tampered of [
    // 2 hours charged instead of 1.
    previewEvaluate(courtDecision(60, 60, 2, 300000)),
    // The per-hour quarter was not floored from the proved hourly price.
    previewEvaluate({ ...courtDecision(60, 60, 1, 200000),
      benefit: { ...courtBenefit(1, 200000), partialPriceCalculation: { chargeableHours: 1,
        hourlyCourtPriceMinor: COURT_HOURLY_MINOR, perHourMinor: 200000,
        chargeBeforeDiscountMinor: 200000, percentageDiscountMinor: 0 } } }),
    // The quote proved no hourly court price at all.
    previewEvaluate(courtDecision(60, 60, 1, 150000), { hourlyCourtPriceMinor: undefined }),
    // The minutes do not add up with the hours.
    previewEvaluate(courtDecision(60, 60, 2, 150000)),
  ]) {
    assert.equal(tampered.error, 'GROUP_DISCOUNT_DECISION_INVALID', JSON.stringify(tampered.quotes));
  }
  // A flat decision that does not follow its own percent is still refused.
  for (const tampered of [
    { eligible: true, subscriptionVisitCount: 0, eventDiscountPercent: 0,
      benefit: benefit(200000, 'PERCENT_DISCOUNT') },
  ]) {
    assert.equal(previewEvaluate(tampered).error, 'GROUP_DISCOUNT_DECISION_INVALID', JSON.stringify(tampered));
  }
});

test('the hub court-window step proves the Skolkovo hour through the verified price route', () => {
  // The booking gateway cannot be executed in isolation (it is one composed Node-RED body), so
  // the reviewed court-window fragments are run on the real step control flow with the same
  // host helpers the composition provides. The numbers are the Skolkovo ones: 12 000 ₽ for the
  // two-hour window, 6 000 ₽ per hour.
  const sections = hookSections(
    fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8'));
  const host = {
    toStr: (value) => (value === null || value === undefined || String(value).trim() === ''
      ? null : String(value).trim()),
    isObj: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
    VIVA_API_BASE: 'https://api.vivacrm.ru',
    eventDurationMinutes: (exercise) => Number(exercise?.durationMinutes) || null,
    eventStartsAt: (exercise) => exercise?.timeFrom || null,
    exerciseRoomId: (exercise) => exercise?.roomId || null,
    prepareAdminGet: (ctx, step, path) => ({ step, url: `${host.VIVA_API_BASE}${path}` }),
    isHttpOk: (status) => Number(status) >= 200 && Number(status) < 300,
    lk1Stop: (ctx, code) => ({ stopped: code }),
    global: { get: () => null, set: () => undefined },
  };
  const source = sections.COURT_WINDOW + '\n' + sections.COURT_WINDOW_RESPONSE;
  const runStep = (ctx, msg = {}) => new Function('ctx', 'msg', 'host',
    `const { toStr, isObj, VIVA_API_BASE, eventDurationMinutes, eventStartsAt, exerciseRoomId,
      prepareAdminGet, isHttpOk, lk1Stop, global } = host;\n${source}\nreturn { needed: lk1CourtWindowNeeded(ctx),
      url: lk1CourtWindowUrl(lk1CourtWindowService(ctx.studioId, ctx.roomId), ctx.studioId, ctx.roomId,
        ctx.lk1CourtExercise) };`)(
    ctx, msg, host);
  const exercise = { id: 'club-exercise', timeFrom: '2099-01-01T12:00:00+03:00',
    timeTo: '2099-01-01T14:00:00+03:00', durationMinutes: 120, roomId: 'court-club',
    studioId: 'station-club' };
  const base = { studioId: '0d5504f6-ea6f-44bb-a9e4-947faf0273ab', roomId: 'court-club',
    exerciseId: 'club-exercise', lk1TariffProof: { source: 'VIVA_EXISTING_TARIFF',
      amountMinor: BASE_PRICE_MINOR, stationId: '0d5504f6-ea6f-44bb-a9e4-947faf0273ab',
      roomId: 'court-club', durationMinutes: 120, startsAt: exercise.timeFrom,
      observedAt: Date.now() },
    lk1: { rule: { productId: CLUB_PRODUCT_ID },
      target: { category: 'GROUP_TRAINING', directionId: CLUB_TRAINING_DIRECTION_ID } } };
  // The dispatch gate and the verified route: only the club product on a club direction
  // without a proved hour asks for the window, and the request binds station, room and window.
  const dispatch = runStep({ ...base, step: 'profile', lk1CourtExercise: exercise });
  assert.equal(dispatch.needed, true);
  assert.equal(dispatch.url,
    'https://api.vivacrm.ru/api/v1/studios/0d5504f6-ea6f-44bb-a9e4-947faf0273ab'
    + '/rooms/court-club/sub-services/96d2179a-5a96-41bd-a0c9-1df9e5890e16/price'
    + '?fromDate=2099-01-01&fromTime=12%3A00&toTime=14%3A00&size=100');
  // A club game on 6180 asks for the same window; a foreign product or direction never does.
  assert.equal(runStep({ ...base, step: 'profile', lk1CourtExercise: exercise,
    lk1: { ...base.lk1, target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID } } }).needed, true);
  assert.equal(runStep({ ...base, step: 'profile', lk1CourtExercise: exercise,
    lk1: { ...base.lk1, rule: { productId: FRIENDSHIP_PRODUCT_ID } } }).needed, false);
  assert.equal(runStep({ ...base, step: 'profile', lk1CourtExercise: exercise,
    lk1: { ...base.lk1, target: { category: 'TOURNAMENT', directionId: 6233 } } }).needed, false);
  // The 12 000 ₽ window becomes the 6 000 ₽ hour, and the request URL binds the answer.
  const ctx = { ...base, step: 'lk1_court_window', lk1CourtExercise: exercise,
    lk1CourtService: { masterServiceId: 'e2caa535-6660-479a-bd32-3638ba7f6b89',
      subServiceIds: ['96d2179a-5a96-41bd-a0c9-1df9e5890e16'] } };
  const requestedUrl = dispatch.url;
  const response = runStep(ctx, { statusCode: 200, url: requestedUrl, responseUrl: requestedUrl,
    payload: { from: 1200000, total: 1200000 } });
  assert.equal(response, false);
  assert.equal(ctx.step, 'profile');
  assert.equal(ctx.lk1TariffProof.windowTotalMinor, 1200000);
  assert.equal(Math.round(ctx.lk1TariffProof.windowTotalMinor * 60 / 120), COURT_HOURLY_MINOR);
  // A malformed or unusable price refuses; nothing is stored.
  for (const [label, payload] of [
    ['no total', { from: 1200000 }],
    ['zero total', { from: 0, total: 0 }],
    ['negative total', { from: 100, total: -1 }],
    ['fractional total', { from: 100, total: 1200000.5 }],
    ['implausible total', { from: 100, total: 10_000_001 }],
  ]) {
    const refused = { ...ctx, step: 'lk1_court_window', lk1CourtExercise: exercise,
      lk1CourtService: { masterServiceId: 'e2caa535-6660-479a-bd32-3638ba7f6b89',
        subServiceIds: ['96d2179a-5a96-41bd-a0c9-1df9e5890e16'] },
      lk1TariffProof: { ...base.lk1TariffProof } };
    const outcome = runStep(refused, { statusCode: 200, url: requestedUrl, responseUrl: requestedUrl,
      payload });
    assert.equal(outcome?.stopped, 'LK1_COURT_PRICE_UNRESOLVED', label);
    assert.equal(refused.lk1TariffProof.windowTotalMinor, undefined, label);
  }
});

test('the contour sources carry the club rule on the booking, preview and widget paths', () => {
  for (const marker of [
    'const TOPOKRATY_FRIENDSHIP_PRODUCT_ID = "14692232-12be-4218-9fa1-2d5b79b62035";',
    'const TOPOKRATY_TRAINING_DIRECTION_IDS = [6233];',
    'const TOPOKRATY_COURT_HOUR_PAY_DIVISOR = 4;',
    'ruleId: "lk1-topokraty-training"',
    'kind: "COURT_HOURLY_COPAY"',
    'LK1_COURT_PRICE_UNRESOLVED',
    'decision.eventDiscountPercent',
  ]) assert.ok(evaluatorSource.includes(marker), marker);
  for (const marker of [
    'directionId: exerciseDirectionId(exercise),',
    'target.hourlyCourtPriceMinor = hourlyCourtPriceMinor;',
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
    "const courtCoPay = decision.benefit?.kind === 'COURT_HOURLY_COPAY'",
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

test('Skolkovo 6 000 ₽/hour, longer club game: one chargeable hour -> 1 500 ₽', () => {
  const game = (used, durationMinutes = 120) => evaluate(lk1Input({
    target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes },
    usage: { usedOrReservedFreeMinutesToday: used },
  })).decision;
  const full = game(0);
  assert.equal(full.eligible, true);
  assert.equal(full.subscriptionVisitCount, 1);
  assert.equal(full.eventDiscountPercent, 0);
  assert.equal(full.benefit.kind, 'COURT_HOURLY_COPAY');
  assert.deepEqual(full.gameMinutes, { localDate: '2026-08-15',
    usedOrReservedFreeMinutesToday: 0, freeMinutes: 60, paidOverageMinutes: 60, discountPercent: 0 });
  // The game uses the same court-hourly model as the training: one started hour above the free
  // hour costs a quarter of the hourly court price, never the player's share.
  assert.deepEqual(full.benefit.partialPriceCalculation, { chargeableHours: 1,
    hourlyCourtPriceMinor: COURT_HOURLY_MINOR, perHourMinor: 150000,
    chargeBeforeDiscountMinor: 150000, percentageDiscountMinor: 0 });
  assert.equal(full.benefit.finalPriceMinor, 150000);
  // 30 of the 60 minutes already spent: only the remaining half hour is free, but the minutes
  // above it are 90 and therefore two started hours.
  const shared = game(30);
  assert.equal(shared.subscriptionVisitCount, 1);
  assert.equal(shared.eventDiscountPercent, 0);
  assert.equal(shared.benefit.kind, 'COURT_HOURLY_COPAY');
  assert.deepEqual(shared.gameMinutes, { localDate: '2026-08-15',
    usedOrReservedFreeMinutesToday: 30, freeMinutes: 30, paidOverageMinutes: 90, discountPercent: 0 });
  assert.equal(shared.benefit.partialPriceCalculation.chargeableHours, 2);
  assert.equal(shared.benefit.finalPriceMinor, 300000);
  // Purity: re-evaluating the same snapshot consumes nothing.
  const input = lk1Input({ target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120 },
    usage: { usedOrReservedFreeMinutesToday: 30 } });
  assert.deepEqual(evaluate(input).decision, shared);
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

test('the club game fails closed when the hourly court price is not proven', () => {
  for (const [label, target] of [
    ['hourly court price absent', { hourlyCourtPriceMinor: undefined }],
    ['hourly court price zero', { hourlyCourtPriceMinor: 0 }],
  ]) {
    const decision = evaluate(lk1Input({
      target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 120, ...target },
    })).decision;
    assert.equal(decision.eligible, false, label);
    assert.ok(decision.blockers.some((item) => item.code === 'LK1_COURT_PRICE_UNRESOLVED'),
      `${label}: ${JSON.stringify(decision.blockers)}`);
  }
  // A club game of up to 90 minutes needs no court price: the visit carries it whole.
  const free = evaluate(lk1Input({
    target: { category: 'GAME', directionId: CLUB_GAME_DIRECTION_ID, durationMinutes: 90,
      hourlyCourtPriceMinor: undefined },
  })).decision;
  assert.equal(free.eligible, true);
  assert.equal(free.benefit.kind, 'FREE_ENTITLEMENT');
  assert.equal(free.benefit.finalPriceMinor, 0);
});

// ---------------------------------------------------------------------------------------------
// The club-only gate is the reviewed HUB_EXERCISE hook, run here on the real control flow with
// intercepting stubs so the refusal is proven rather than matched as text.
const hooksSource = fs.readFileSync(
  new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8');

function hookSections(source) {
  const parts = source.split(/^\/\/ HUB_([A-Z_]+)\s*$/m);
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

test('the allowance binding admits the club free-visit game and keeps the ordinary ceiling', () => {
  // A 90-minute club game records freeMinutes = duration, which exceeds the day's 60-minute
  // bucket. The resumed-operation allowance must accept exactly that club pair and nothing else.
  for (const marker of [
    'const clubFreeVisit = typeof isTopokratyClubPack === "function"',
    '&& isTopokratyExercise(operation.lk1.target);',
    'const freeCeiling = clubFreeVisit ? duration : ctx.lk1.rule.freeGameMinutesPerDay;',
    '|| free > freeCeiling',
  ]) assert.ok(gatewaySource.includes(marker), marker);
  assert.equal(gatewaySource.includes('free > ctx.lk1.rule.freeGameMinutesPerDay'), false);
});
