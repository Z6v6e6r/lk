import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { composeSubscriptionCalculationRepair } from '../patch_live_subscription_calculation_repair.mjs';
import { patchTopokratyReclaimPreviewBody } from '../patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs';

const source = name => fs.readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), 'utf8');
test('runtime catch preserves only a safe stage and final logs no credentials or provider messages', () => {
  const warnings = [];
  const message = { _msgid: 'fixture-correlation', error: { message: 'fixture-sensitive-provider-error' },
    _subscriptionPricePreview: { step: 'metadata' } };
  new Function('msg', source('error'))(message);
  new Function('msg', 'node', source('final'))(message, { warn: value => warnings.push(value) });
  assert.equal(message.statusCode, 503);
  assert.deepEqual(message.payload, { error: { code: 'PRICE_PREVIEW_UNAVAILABLE' } });
  assert.deepEqual(JSON.parse(warnings[0]), { event: 'subscription_price_preview_failed',
    code: 'PRICE_PREVIEW_UNAVAILABLE', step: 'metadata', correlationId: 'fixture-correlation' });
  assert.ok(!warnings[0].includes('fixture-sensitive'));
});

test('the focused composer refuses an unreviewed preimage before generation', () => {
  assert.throws(() => composeSubscriptionCalculationRepair(Buffer.from('[]')), /preimage drift/);
});

const fixture = process.env.LK_CALCULATION_REPAIR_FLOW_FIXTURE;
test('exact reviewed flow changes only four preview bodies and preserves the booking evaluator', { skip: !fixture }, () => {
  const bytes = fs.readFileSync(fixture);
  const original = JSON.parse(bytes);
  const { candidateBytes, report } = composeSubscriptionCalculationRepair(bytes);
  const candidate = JSON.parse(candidateBytes);
  assert.equal(candidate.length, original.length);
  const changes = original.filter((node, index) => JSON.stringify(node) !== JSON.stringify(candidate[index]));
  assert.equal(changes.length, 4);
  for (const node of changes) {
    assert.ok(node.id.startsWith('lk_subscription_price_preview_20260908_'));
    const changed = candidate.find(row => row.id === node.id);
    assert.deepEqual({ ...changed, func: node.func }, node);
  }
  assert.equal(report.bookingChanged, false);
  assert.equal(candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_evaluate').func,
    candidate.find(n => n.id === 'lk_subscription_managed_policy_20260820').func);
  assert.throws(() => composeSubscriptionCalculationRepair(candidateBytes), /preimage drift/);
});

test('production-composed usage keeps A and B independent and resolves covered provider bookings', { skip: !fixture }, () => {
  const { candidateBytes } = composeSubscriptionCalculationRepair(fs.readFileSync(fixture));
  const flow = JSON.parse(candidateBytes);
  const router = flow.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func;
  const prefix = router.slice(0, router.indexOf('// Dedicated advisory graph.'));
  const scope = vm.compileFunction(prefix + '\nreturn {canonicalUsage};', ['global'],
    { parsingContext: vm.createContext({}) })({ get: () => undefined });
  const rule = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4,
    freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const booking = { id: 'fixture-booking', clientSubscriptionId: 'sub-A', paymentType: 'SUBSCRIPTION',
    exerciseDate: '2099-09-21', exerciseDateTo: '2099-09-21T08:00:00+03:00',
    timeFrom: '2099-09-21T07:00:00+03:00', timeTo: '2099-09-21T08:00:00+03:00', typeId: 1613, directionId: 4588 };
  for (const selected of ['sub-A', 'sub-B']) {
    const msg = { payload: [], _subscriptionBooking: { step: 'lk1_usage_operations', tenantKey: 'fixture',
      actorClientId: 'fixture-actor', clientSubscriptionId: selected, serviceDate: '2099-09-21', category: 'open_game',
      managedAction: 'CREATE_GAME', lk1: { rule, bookings: [booking], activeBookings: [booking], target: {} } } };
    scope.canonicalUsage(msg);
    assert.equal(msg.previewError, undefined);
    assert.equal(msg._managedSubscriptionPolicyInput.usage.activeServices, selected === 'sub-A' ? 1 : 0);
    assert.equal(msg._managedSubscriptionPolicyInput.usage.usedOrReservedFreeMinutesToday, selected === 'sub-A' ? 60 : 0);
  }
  for (const productId of ['b91e14d1-fe6e-4d0b-be39-3e45ad86b759', '9eb8a7a4-c195-492a-95e4-3fb82899ac10']) {
    const groupBooking = { ...booking, typeId: 605, directionId: 6233 };
    const msg = { payload: [], _subscriptionBooking: { step: 'lk1_usage_operations', tenantKey: 'fixture',
      actorClientId: 'fixture-actor', clientSubscriptionId: 'sub-A', serviceDate: '2099-09-21', category: 'group_training',
      managedAction: 'BOOK_GROUP_TRAINING', lk1ProductIdentity: { subscription: { visitsLeft: 10 } },
      lk1: { rule: { ...rule, productId }, bookings: [groupBooking], activeBookings: [groupBooking], target: { directionId: 6233 } } } };
    scope.canonicalUsage(msg);
    assert.equal(msg.previewError, undefined);
    assert.equal(msg._managedSubscriptionPolicyInput.usage.freeFirstEvent.usedEventsToday, 1);
  }
});

function assertClubRefusal(router) {
  assert.equal(router.split('function isTopokratyExercise(value) {').length - 1, 1);
  const run = new Function('msg', 'node', 'env', 'global', router);
  for (const productId of ['b91e14d1-fe6e-4d0b-be39-3e45ad86b759', '9eb8a7a4-c195-492a-95e4-3fb82899ac10']) {
    for (const directionId of [6180, 6233]) {
      const ctx = { step: 'next', pending: ['fixture-instance'], subscriptions: { 'fixture-instance': {} },
        metadata: { 'fixture-instance': { productId } }, catalog: { [productId]: 'Fixture plan' },
        actorClientId: 'fixture-actor', tenantKey: 'fixture', eventCategory: 'GROUP_TRAINING',
        startedAt: Date.now(), quotes: [], basePriceMinor: 600000, selectionKey: 'fixture-key',
        target: { startsAt: '2099-09-21T07:00:00+03:00', durationMinutes: 90 },
        exercise: { directionId } };
      const msg = { _subscriptionPricePreview: ctx };
      run(msg, {}, {}, { get: () => undefined });
      assert.equal(ctx.statusCode, 200);
      assert.equal(ctx.quotes.length, 1);
      assert.equal(ctx.quotes[0].status, 'UNAVAILABLE');
      assert.equal(ctx.quotes[0].amountMinor, null);
      assert.equal(ctx.quotes[0].reasonCode, 'TOPOKRATY_SUBSCRIPTION_UNAVAILABLE');
    }
  }
}

test('the preserved club generation refuses other plans before quota or write helpers', () => {
  const canonical = 'const canonical = { isObj: value => value !== null && typeof value === "object", identityMoneyOwned: () => true };\n';
  assertClubRefusal(patchTopokratyReclaimPreviewBody(canonical + source('router')));
});

test('production-composed preview retains the installed club-only refusal for RA and Academy', { skip: !fixture }, () => {
  const { candidateBytes } = composeSubscriptionCalculationRepair(fs.readFileSync(fixture));
  const router = JSON.parse(candidateBytes).find(n => n.id === 'lk_subscription_price_preview_20260908_router').func;
  assertClubRefusal(router);
});
