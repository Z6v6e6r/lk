import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { composeGroupSubscriptionPricePreviewArtifacts } from '../patch_nodered_subscription_price_preview.mjs';

const fixture = process.env.LK_GROUP_DISCOUNT_FLOW_FIXTURE;
const liveBytes = fixture ? fs.readFileSync(fixture) : null;
const candidate = liveBytes ? composeGroupSubscriptionPricePreviewArtifacts(liveBytes, 'group-discount-test').candidate : null;
const run = (name, fn) => test(name, { skip: !candidate && 'Requires private current flow fixture' }, fn);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = uuid(1), sub = uuid(2), exerciseId = uuid(3), room = uuid(4), studio = uuid(5), oneTime = uuid(6);
const productId = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const key = (kind, ...parts) => JSON.stringify([kind, 'iSkq6G', ...parts]);
const rule = { productId, maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const subscription = { subscriptionId: sub, clientId: actor, productId, status: 'ACTIVE', purchaseDate: '2026-09-01',
  activationDate: '2026-09-01', expirationDate: '2100-01-01', visitsLeft: 0 };
const exercise = { id: exerciseId, type: { id: 605 }, direction: { id: 1001 }, room: { id: room }, studio: { id: studio },
  timeFrom: '2099-09-21T08:00:00+03:00', timeTo: '2099-09-21T09:00:00+03:00', availableClientSubscriptions: [] };
const tariff = { id: oneTime, exerciseId, cost: 550000, productType: 'SERVICE' };
const execute = (source, msg, globals) => vm.runInNewContext(`(function(){${source}\n})()`, {
  msg, global: { get: name => globals[name] }, Date, Intl, Set, Map, JSON, Buffer,
});
function harness(options = {}) {
  const node = name => candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_' + name).func;
  const globals = { subscriptions_lk1_product_policy: rule, ...options.globals };
  let msg = { payload: { target: { targetKind: 'GROUP_TRAINING', exerciseId }, ...options.body },
    req: { headers: { authorization: 'Bearer fixture' } } };
  execute(node('entry'), msg, globals);
  const calls = [];
  for (let iteration = 0; iteration < 60; iteration++) {
    const outputs = execute(node('router'), msg, globals);
    assert.ok(outputs, 'router must respond');
    const output = outputs.findIndex(Boolean);
    msg = outputs[output];
    if (output === 4) return { ctx: JSON.parse(JSON.stringify(msg._subscriptionPricePreview)), calls };
    const step = msg._subscriptionPricePreview.step;
    calls.push({ output, step, method: msg.method, url: msg.url });
    if (output === 3) { execute(node('evaluate'), msg, globals); continue; }
    if (output === 0) {
      assert.equal(msg.method, 'GET', 'preview must not invoke a provider mutation');
      msg.statusCode = options.failStep === step ? 503 : 200;
      const rows = options.subscriptions || [{ ...subscription, ...options.subscription }];
      const payloads = {
        profile: { id: actor }, groupExercise: { ...exercise, ...options.exercise },
        subscriptions: { content: rows, totalElements: rows.length, last: true, ...options.pagination },
        activeBookings: options.bookings || [], historyBookings: [],
        groupTariff: options.tariffs || [{ ...tariff, ...options.tariff }],
      };
      assert.ok(step in payloads, `unexpected provider read ${step}`);
      msg.payload = payloads[step];
    } else if (output === 1) {
      assert.deepEqual(Object.keys(msg.payload), ['_id'], 'only metadata reads allowed');
      msg.payload = step === 'metadata' ? [{ _id: key('instance', actor, sub), kind: 'instance', tenantKey: 'iSkq6G',
        actorClientId: actor, subscriptionId: sub, productId, ...options.metadata }]
        : [{ _id: key('product', productId), kind: 'product', tenantKey: 'iSkq6G', productId, name: 'Падел.Дружба.ХАБ' }];
    } else if (output === 2) msg.payload = options.operations || [];
    else assert.fail(`unexpected output ${output}`);
  }
  assert.fail('preview did not complete');
}
run('group quote gives 50% from exact Viva tariff with zero visits and no exercise visit eligibility', () => {
  const { ctx, calls } = harness();
  assert.equal(ctx.error, undefined);
  assert.equal(ctx.quotes.length, 1);
  const q = ctx.quotes[0];
  assert.equal(q.kind, 'GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1');
  assert.equal(q.amountMinor, 275000);
  assert.equal(q.basePriceMinor, 550000);
  assert.equal(q.productId, oneTime);
  assert.equal(q.subscriptionName, 'Падел.Дружба.ХАБ');
  assert.equal(q.discountPercent, 50);
  assert.ok(calls.every(c => [0, 1, 2, 3].includes(c.output)));
});
run('group quote rechecks exactly requested subscription and rejects another owner', () => {
  assert.equal(harness({ body: { subscriptionIds: [sub] } }).ctx.quotes[0].amountMinor, 275000);
  assert.equal(harness({ subscription: { clientId: uuid(99) } }).ctx.error, 'PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
  assert.equal(harness({ body: { subscriptionIds: [uuid(99)] } }).ctx.error, 'PRICE_PREVIEW_OWNERSHIP_UNRESOLVED');
});
run('group quote never accepts ambiguous, unbound, or malformed tariffs', () => {
  for (const tariffChange of [{ exerciseId: undefined }, { exerciseId: uuid(99) }, { price: 1 }, { cost: 5500.5 },
    { productType: 'SUBSCRIPTION' }, { productId: uuid(99) }, { cost: 1000001 }]) {
    assert.ok(harness({ tariff: tariffChange }).ctx.error, JSON.stringify(tariffChange));
  }
  assert.ok(harness({ tariffs: [tariff, tariff] }).ctx.error);
});
run('group quote checks entire lifecycle, product cohort, freeze, and target category', () => {
  for (const delta of [{ status: 'NEW' }, { purchaseDate: '2026-08-31' }, { activationDate: null },
    { expirationDate: '2099-09-21T08:59:59+03:00' }, { activationDate: '2099-01-01' }, { isFrozen: true }]) {
    const ctx = harness({ subscription: delta, body: { subscriptionIds: [sub] } }).ctx;
    assert.ok(ctx.error || ctx.quotes.every(q => q.status !== 'AVAILABLE'), JSON.stringify(delta));
  }
  assert.equal(harness({ exercise: { type: { id: 1613 }, direction: { id: 4588 } } }).ctx.error, 'GROUP_DISCOUNT_TARGET_UNRESOLVED');
  assert.equal(harness({ exercise: { isCancelled: true } }).ctx.error, 'GROUP_DISCOUNT_TARGET_UNRESOLVED');
});
run('group quote respects four active subscription bookings and read failures', () => {
  const bookings = Array.from({ length: 4 }, (_, index) => ({ id: uuid(20 + index), clientId: actor, clientSubscriptionId: sub,
    paymentType: 'SUBSCRIPTION', exercise: { ...exercise, id: uuid(30 + index) } }));
  assert.equal(harness({ bookings }).ctx.quotes[0].status, 'LIMIT_USED');
  assert.ok(harness({ failStep: 'groupTariff' }).ctx.error);
  assert.ok(harness({ pagination: { last: false } }).ctx.error);
  assert.ok(harness({ globals: { subscriptions_lk1_product_policy: { ...rule, groupTrainingDiscountPercent: 40 } } }).ctx.error);
});
run('group composer changes only the scoped gateway and two advisory function bodies', () => {
  const before = JSON.parse(liveBytes);
  const changed = candidate.filter((n, i) => JSON.stringify(n) !== JSON.stringify(before[i]));
  assert.deepEqual(changed.map(n => n.id).sort(), ['lk_subscription_booking_prepare_20260804', 'lk_subscription_booking_router_20260804', ...['entry', 'router'].map(n => 'lk_subscription_price_preview_20260908_' + n)]);
  for (const n of changed) {
    const original = before.find(v => v.id === n.id);
    assert.deepEqual({ ...n, func: original.func }, original);
  }
});

run('unrelated active subscription needs no binding and cannot hide the HUB discount', () => {
  const result = harness({ subscriptions: [subscription, { ...subscription, subscriptionId: uuid(90), productId: uuid(91) }] });
  assert.equal(result.ctx.quotes[0].amountMinor, 275000);
});
run('composer rejects an independently changed checkout evaluator', () => {
  const changed = JSON.parse(liveBytes);
  changed.find(n => n.id === 'lk_subscription_managed_policy_20260820').func += '\n// drift';
  assert.throws(() => composeGroupSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(changed)), 'drift'), /evaluator mismatch/);
});

run('actual gateway accepts active zero-visit group money ownership and still rejects unusable or foreign rows', () => {
  const code = candidate.find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  const invoke = (delta = {}, typeId = 605) => {
    const own = { ...subscription, ...delta };
    const target = { ...exercise, type: { id: typeId }, direction: { id: typeId === 605 ? 1001 : 2617 } };
    const ctx = { caller: 'http', step: 'lk1_money_owned_subscriptions', action: 'book', tenantKey: 'iSkq6G',
      actorClientId: actor, clientSubscriptionId: sub, authHeader: 'Bearer fixture', exerciseId, operationId: 'fixture-group-money',
      managedAction: typeId === 605 ? 'BOOK_GROUP_TRAINING' : 'BOOK_TOURNAMENT', lk1MoneyExercise: target, lk1MoneyReturnStep: 'exercise',
      lk1ProductIdentity: { actorClientId: actor, subscriptionId: sub, tenantKey: 'iSkq6G', productId, name: 'HUB',
        purchaseDate: own.purchaseDate, subscription: { ...own, visitsLeft: 100 } },
      lk1TariffProof: { source: 'VIVA_EXISTING_TARIFF', amountMinor: 550000, stationId: studio, roomId: room,
        durationMinutes: 60, startsAt: target.timeFrom, observedAt: Date.now() } };
    return new Function('msg', 'global', 'node', 'env', code)(
      { _subscriptionBooking: ctx, statusCode: 200, payload: { content: [own], totalElements: 1 } },
      { get: key => key === 'subscriptions_lk1_product_policy' ? rule : undefined },
      { warn() {}, error() {} }, { get() {} });
  };
  const accepted = invoke();
  assert.ok(accepted[1], JSON.stringify(accepted.filter(Boolean).map(m => m.payload)));
  assert.equal(accepted[1]._subscriptionBooking.lk1MoneyOwnership.subscription.visitsLeft, 0);
  assert.ok(accepted.every(m => !m || m.method !== 'POST'), 'ownership proof must not write');
  for (const delta of [{ status: 'NEW', activationDate: null, expirationDate: null }, { status: 'REFUNDED' },
    { isFrozen: true }, { clientId: uuid(99) }, { productId: uuid(99) }, { purchaseAt: '2026-08-31' },
    { expirationDate: '2026-09-01' }, { activationDate: '2100-01-01' }]) {
    const rejected = invoke(delta);
    assert.equal(rejected[1], null, JSON.stringify(delta));
    assert.ok(rejected[4]);
  }
  const tournament = invoke({}, 839);
  assert.equal(tournament[1], null, 'zero visits must not widen tournament eligibility');
});
run('first booking refuses a changed displayed price before inserting any operation', () => {
  const code = candidate.find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  const expected = { basePriceMinor: 550000, amountMinor: 275000, productId: oneTime, startsAt: exercise.timeFrom, durationMinutes: 60, discountPercent: 50 };
  const invoke = delta => new Function('msg', 'global', 'node', 'env', code)({
    _subscriptionBooking: { caller: 'http', action: 'book', step: 'lk1_policy_decision', managedAction: 'BOOK_GROUP_TRAINING',
      expectedGroupDiscount: { ...expected, ...delta }, exerciseId, actorClientId: actor, clientSubscriptionId: sub, tenantKey: 'iSkq6G',
      operationId: 'fixture-group-price', operationKey: 'fixture-operation', lk1: { rule,
        target: { basePriceMinor: 550000, priceProductId: oneTime, startsAt: exercise.timeFrom, durationMinutes: 60 } } },
    _managedSubscriptionPolicyDecision: { eligible: true, subscriptionVisitCount: 0, benefit: { finalPriceMinor: 275000 } },
  }, { get() {} }, { warn() {}, error() {} }, { get() {} });
  assert.ok(invoke({})[2], 'unchanged exact quote permits only the first durable insert');
  for (const delta of [{ amountMinor: 200000 }, { basePriceMinor: 600000 }, { productId: uuid(99) },
    { durationMinutes: 90 }, { startsAt: '2099-09-22T08:00:00+03:00' }, { discountPercent: 0 }, { extra: true }]) {
    const out = invoke(delta);
    assert.equal(out[2], null);
    assert.equal(out[0], null);
    assert.equal(out[4].statusCode, 409);
    assert.equal(out[4].payload.details.code, 'GROUP_DISCOUNT_QUOTE_CHANGED');
  }
});
run('earlier GAME composers refuse group support unless the monetary helper was installed', () => {
  const code = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
  const msg = { _subscriptionPricePreview: { groupTraining: true, step: 'start' } };
  const out = new Function('msg', 'canonical', code)(msg, {});
  assert.equal(out[4]._subscriptionPricePreview.error, 'GROUP_DISCOUNT_BACKEND_NOT_READY');
});
