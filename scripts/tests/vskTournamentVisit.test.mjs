import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  patchVskTournamentVisitEvaluator,
  prepareVskTournamentVisit,
} from '../prepare_vsk_tournament_visit.mjs';
import { VSK_EVALUATORS } from '../prepare_vsk_tournament_discount.mjs';

const productId = '94e32355-1c69-462b-9f2a-77f2817cb24c';
const type = 'viva:direction:6977:type:2349';
const bookingRouters = ['lk_subscription_booking_router_20260804', '6cffa6278ef875e4'];
const previewRouter = 'lk_subscription_price_preview_20260908_router';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureEvaluator = `
  const { category, target, input, usage, dailyVisits, decision } = msg;
  const blockers = [];
  const block = code => blockers.push(code);
  let selectedRule;
  if (category === "GAME") {
    selectedRule = { ruleId: "game" };
  } else if (category === "GROUP_TRAINING"
    && isTopokratyTrainingBenefit()) {
    selectedRule = { ruleId: "training" };
  } else {
    selectedRule = { kind: "PERCENT_DISCOUNT", percentage: 50 };
  }
  return { decision, selectedRule, blockers };
`;
const fixtureUsage = `
  const dailyVisits = 0, freeFirstVisitsLeft = 7;
  const usage = {
      usedOrReservedVisitsToday: dailyVisits,
  };
`;
const fixtureRouter = fixtureUsage + `
  const finishError = (_ctx, statusCode, _message, details) => ({ statusCode, details });
  const preparePreaccept = (ctx) => { return "prepare"; };
  const prepareBookingCreate = (ctx) => { return "booking"; };
  const lk1Finish = (ctx) => { return "finish"; };
  const lk1Checkout = (ctx) => { return "checkout"; };
  const ctx = msg.context;
  if (ctx.step === "lk1_payment_attempt_saved") {
    return "invoice";
  }
  return ({ preparePreaccept, prepareBookingCreate, lk1Finish, lk1Checkout })[msg.action](msg.context);
`;
const fixturePreview = fixtureUsage + `
const LIMIT_DECISION_BLOCKERS = ['ACTIVE_SERVICES_LIMIT_REACHED', 'USAGE_SNAPSHOT_BUCKET_MISMATCH'];
const UNAVAILABLE_DECISION_BLOCKERS = ['EVENT_NOT_INCLUDED',
  'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND'];
return { usage, LIMIT_DECISION_BLOCKERS, UNAVAILABLE_DECISION_BLOCKERS };
`;
const fn = (id, func) => ({ id, type: 'function', func, wires: [['retained']] });
const fixture = () => [
  ...VSK_EVALUATORS.map(id => fn(id, fixtureEvaluator)),
  ...bookingRouters.map(id => fn(id, fixtureRouter)),
  fn(previewRouter, fixturePreview),
  { id: 'retained', type: 'debug', active: false },
];
const build = flow => {
  const raw = JSON.stringify(flow);
  return JSON.parse(prepareVskTournamentVisit(raw, hash(raw)));
};
const binding = { ownedProductId: productId, policyProductId: productId };
const decisionInput = () => ({
  category: 'TOURNAMENT', target: { externalEventTypeId: type },
  input: { lk1ProductBinding: binding }, dailyVisits: 0, decision: { aboveActiveLimit: false },
  usage: { subscriptionVisitsLeft: 1 },
});

test('the visit is limited to the exact owned VSK product and tournament direction and type', () => {
  const run = new Function('msg', patchVskTournamentVisitEvaluator(fixtureEvaluator));
  const full = run(decisionInput());
  assert.equal(full.selectedRule.kind, 'FREE_ENTITLEMENT');
  assert.equal(full.decision.subscriptionVisitCount, 1);
  assert.deepEqual(full.blockers, []);

  for (const changes of [
    { target: { externalEventTypeId: 'viva:direction:6977:type:1613' } },
    { target: { externalEventTypeId: 'viva:direction:6975:type:2349' } },
    { target: { externalEventTypeId: 'viva:direction:9899:type:2349' } },
    { input: { lk1ProductBinding: { ...binding, ownedProductId: 'another-product' } } },
    { input: { lk1ProductBinding: { ...binding, policyProductId: 'another-product' } } },
    { input: {} },
  ]) {
    const other = run({ ...decisionInput(), ...changes });
    assert.equal(other.selectedRule.percentage, 50);
    assert.equal(other.decision.subscriptionVisitCount, undefined);
  }
});

test('the free visit is required and never falls through to the paid tariff', () => {
  const run = new Function('msg', patchVskTournamentVisitEvaluator(fixtureEvaluator));
  for (const [changes, code] of [
    [{ decision: { aboveActiveLimit: true } }, 'ACTIVE_SERVICES_LIMIT_REACHED'],
    [{ dailyVisits: 1 }, 'VSK_TOURNAMENT_DAILY_VISIT_USED'],
    [{ usage: {} }, 'VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE'],
    [{ usage: { subscriptionVisitsLeft: -1 } }, 'VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE'],
    [{ usage: { subscriptionVisitsLeft: 0 } }, 'SUBSCRIPTION_VISITS_EXHAUSTED'],
  ]) {
    const blocked = run({ ...decisionInput(), ...changes });
    assert.deepEqual(blocked.blockers, [code]);
    assert.equal(blocked.selectedRule, undefined);
  }
  const preview = build(fixture()).find(node => node.id === previewRouter);
  const output = new Function('msg', preview.func)();
  assert.equal(output.usage.subscriptionVisitsLeft, 7);
  assert(output.LIMIT_DECISION_BLOCKERS.includes('VSK_TOURNAMENT_DAILY_VISIT_USED'));
  assert(output.LIMIT_DECISION_BLOCKERS.includes('SUBSCRIPTION_VISITS_EXHAUSTED'));
  assert(output.UNAVAILABLE_DECISION_BLOCKERS.includes('VSK_TOURNAMENT_VISIT_BALANCE_UNAVAILABLE'));
});

test('old VSK checkout is neither replayed nor resumed in either booking router', () => {
  const flow = build(fixture());
  for (const id of bookingRouters) {
    const run = new Function('msg', flow.find(node => node.id === id).func);
    const lk1 = {
      rule: { productId }, target: { category: 'TOURNAMENT', externalEventTypeId: type },
      decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 275000 } },
    };
    for (const [action, ordinaryResult] of [
      ['preparePreaccept', 'prepare'], ['prepareBookingCreate', 'booking'],
      ['lk1Finish', 'finish'], ['lk1Checkout', 'checkout'],
    ]) {
      const call = quote => run({ action, context: { lk1: quote } });
      assert.equal(call(lk1).statusCode, 409);
      const free = { ...lk1, decision: { subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } };
      assert.equal(call({ ...free, transactionId: 'old-transaction' }).statusCode, 409);
      assert.equal(call(free), ordinaryResult);
      assert.equal(call({ ...lk1, rule: { productId: 'another-product' } }), ordinaryResult);
    }
    const dispatchInvoice = quote => run({ context: { step: 'lk1_payment_attempt_saved', lk1: quote } });
    assert.equal(dispatchInvoice(lk1).statusCode, 409);
    assert.equal(dispatchInvoice({ ...lk1, rule: { productId: 'another-product' } }), 'invoice');
  }
});

test('candidate preserves graph order and all fields except the six function bodies', () => {
  const nodes = fixture();
  const candidate = build(nodes);
  assert.deepEqual(candidate.map((node, i) => node.func ? { ...node, func: nodes[i].func } : node), nodes);
  assert.equal(candidate.filter((node, i) => node.func !== nodes[i].func).length, 6);
  assert.throws(() => build(candidate), /Already patched/);
  assert.throws(() => prepareVskTournamentVisit(JSON.stringify(nodes), '0'.repeat(64)), /Live source drift/);
  assert.throws(() => build(nodes.slice(1)), /Missing function/);
  assert.throws(() => build([{ ...nodes[0], func: 'return null;' }, ...nodes.slice(1)]), /matching function anchor/);
});

const liveFixture = process.env.VSK_TOURNAMENT_VISIT_FLOW_FIXTURE;
test('real router functions emit one Viva subscription booking and a 0 ₽ confirmation without a transaction',
  { skip: !liveFixture }, () => {
    const raw = readFileSync(liveFixture);
    const live = JSON.parse(prepareVskTournamentVisit(raw, hash(raw)));
    for (const id of bookingRouters) {
      const router = new vm.Script(`(function(msg, node, global, env){\n${live.find(item => item.id === id).func}\n})(msg, node, global, env)`);
      const run = msg => router.runInNewContext({
        msg, node: { warn() {}, error() {}, status() {} },
        global: { get: key => key === 'vivacrm_access_token' ? 'fixture-admin' : undefined },
        env: { get: () => undefined },
      }, { timeout: 3000 });
      const target = {
        category: 'TOURNAMENT', externalEventTypeId: type, eventId: 'fixture-event',
        stationId: 'fixture-studio', priceSource: 'VIVA_EXISTING_TARIFF', priceProductId: 'fixture-rate', basePriceMinor: 550000,
      };
      const ctx = {
        step: 'operation_precreated_promote', caller: 'http', action: 'book', managedAction: 'BOOK_TOURNAMENT',
        category: 'tournament', tenantKey: 'fixture', actorClientId: 'fixture-actor', clientSubscriptionId: 'fixture-subscription',
        exerciseId: target.eventId, studioId: target.stationId, operationId: 'fixture-operation',
        operationKey: 'fixture-operation-key', authHeader: 'Bearer fixture-user', subscriptionVisitCount: 1,
        lk1FreeGateCleared: true, lk1DailyVisitOwned: true,
        lk1: {
          target, rule: { productId, tournamentDiscountPercent: 50 },
          decision: { eligible: true, subscriptionVisitCount: 1, benefit: { kind: 'FREE_ENTITLEMENT', finalPriceMinor: 0 } },
        },
      };
      const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
      const created = run({ _subscriptionBooking: ctx, payload: ack });
      assert.equal(created[0]?.method, 'POST',
        JSON.stringify({ step: ctx.step, response: created[4]?.payload }));
      assert.match(created[0].url, /\/api\/v1\/exercises\/fixture-event\/bookings$/);
      assert.equal(created[0].payload.paymentType, 'SUBSCRIPTION');
      assert.equal(created[0].payload.clientSubscriptionId, ctx.clientSubscriptionId);
      assert.equal(created[0].payload.count ?? 1, 1);
      const accepted = run({ ...created[0], statusCode: 201, payload: { id: 'fixture-booking' } });
      assert.equal(accepted[3]._subscriptionBooking.step, 'operation_accept');
      const read = run({ ...accepted[3], payload: ack });
      assert.equal(read[0].method, 'GET');
      const booking = {
        id: 'fixture-booking', clientId: ctx.actorClientId, paymentType: 'SUBSCRIPTION',
        clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId, count: 1,
      };
      const persisted = run({ ...read[0], statusCode: 200, responseUrl: read[0].url,
        payload: { content: [booking], totalElements: 1, totalPages: 1, number: 0, last: true } });
      assert.equal(persisted[3]?._subscriptionBooking.step, 'operation_confirm', JSON.stringify(persisted[4]?.payload));
      const settled = run({ ...persisted[3], payload: ack });
      assert.equal(settled[0], null);
      assert.equal(settled[4].payload.state, 'CONFIRMED');
      assert.equal(settled[4].payload.bookingId, 'fixture-booking');
      assert.equal(settled[4].payload.toPayMinor, 0);
      assert.equal(settled[4].payload.subscriptionVisitCount, 1);
      assert.equal(settled[4].payload.paymentUrl, null);
      assert.equal(settled[4].payload.transactionId, null);

      const oldPayment = run({ _subscriptionBooking: {
        ...ctx, step: 'lk1_payment_attempt_saved', lk1: {
          ...ctx.lk1, decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 275000 } },
        },
      }, payload: ack });
      assert.equal(oldPayment[0], null);
      assert.equal(oldPayment[4].statusCode, 409);
    }
  });
