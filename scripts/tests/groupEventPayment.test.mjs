import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
const productId = 'fixture-group-tariff';
const hubId = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const context = (percent = 50, base = 550000) => ({
  caller: 'http', managedAction: 'BOOK_GROUP_TRAINING', category: 'group_training',
  step: 'lk1_payment_products', tenantKey: 'fixture', actorClientId: 'fixture-actor',
  actorPhone: 'fixture-phone', authHeader: 'Bearer fixture', studioId: 'fixture-studio',
  exerciseId: 'fixture-event', confirmedBookingId: 'fixture-booking',
  operationId: 'fixture-operation', operationKey: 'fixture-key', clientSubscriptionId: 'fixture-subscription',
  lk1: {
    target: { category: 'GROUP_TRAINING', eventId: 'fixture-event', priceProductId: productId,
      basePriceMinor: base, stationId: 'fixture-studio' },
    rule: { productId: hubId, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
      gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: percent, tournamentDiscountPercent: 50 },
    decision: { eligible: true, subscriptionVisitCount: 0, benefit: { finalPriceMinor: base - Math.floor(base * percent / 100) } },
  },
});
const service = (base = 550000) => ({ id: productId, productType: 'SERVICE', cost: base });
function call(ctx, payload, options = {}) {
  const msg = { payload, statusCode: 200, ...options.msg };
  const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const dispatch = (ctx, step, method, url, body) => {
    ctx.step = step; msg.method = method; msg.url = url; msg.payload = body;
    return { kind: 'http', step, method, url, payload: body };
  };
  const deps = {
    ctx, msg, isObj, VIVA_API_BASE: 'https://api.vivacrm.ru', OUTPUT_FINAL: 4,
    isHttpOk: status => status >= 200 && status < 300,
    hasCompleteBookingList: rows => Array.isArray(rows) || (Array.isArray(rows?.content) && rows.last === true),
    extractItems: rows => Array.isArray(rows) ? rows : rows.content,
    unwrapRecord: value => value,
    normalizeId: value => String(value || '').trim(), normalizePhone: value => value,
    collectExactProductIds: value => [value.productId],
    collectSubscriptionPurchaseDateEvidence: () => ({ invalid: false, dates: ['2026-09-01'] }),
    MANAGED_ENFORCEMENT_PURCHASE_FROM: '2026-09-01',
    lk1ReadBoundPolicy: () => options.rule || ctx.lk1.rule,
    lk1MongoMatched: result => result?.matchedCount,
    readGlobal: () => 'fixture-service-token',
    lk1NeedsVisitJob: () => false,
    prepareHttp: dispatch,
    prepareUserGet: (ctx, step, url) => dispatch(ctx, step, 'GET', url),
    prepareAdminGet: (ctx, step, url) => dispatch(ctx, step, 'GET', url),
    prepareMongoUpdate: (ctx, step, query, update) => { ctx.step = step; return { kind: 'mongo', step, query, update }; },
    finishPending: (_ctx, _message, details) => ({ kind: 'stop', code: details.code }),
    finishConfirmed: (_ctx, bookingId) => { msg.payload = { state: 'CONFIRMED', bookingId }; },
    emit: () => ({ kind: 'final', payload: msg.payload }),
    managedActionForTarget: () => ctx.managedAction,
  };
  const result = new Function(...Object.keys(deps), source + (options.suffix || ''))(...Object.values(deps));
  return { result, msg };
}
function payment(percent = 50, base = 550000) {
  const ctx = context(percent, base);
  const selected = call(ctx, [service(base), { id: 'fixture-game-carrier', type: 'SERVICE', cost: 1000000 }]);
  assert.equal(selected.result.step, 'lk1_payment_profile_recheck');
  assert.equal(selected.result.method, 'GET');
  const payload = selected.msg._splitCtx.transactionPayload;
  const intent = call(ctx, { id: ctx.actorClientId, phone: ctx.actorPhone }, { msg: { _splitCtx: selected.msg._splitCtx } });
  assert.equal(intent.result.step, 'lk1_payment_attempt_saved');
  assert.equal(intent.result.query['lk1.transactionAttemptedAt'].$exists, false);
  assert.equal(intent.result.query.state, 'CONFIRMED');
  assert.equal(ctx.lk1.transactionIntent.productType, 'SERVICE');
  assert.equal(ctx.lk1.transactionIntent.baseMinor, base);
  return { ctx, payload };
}

test('group payment uses the exact event service and rule percentage without a visit product', () => {
  for (const [percent, base, expected] of [[50, 550000, 275000], [10, 550000, 495000], [33, 550001, 368501], [0, 550000, 550000]]) {
    const { ctx, payload } = payment(percent, base);
    assert.deepEqual(payload.products, [{ id: productId, type: 'SERVICE', count: 1,
      bookingIds: [ctx.confirmedBookingId], customAmount: null, discount: base - expected }]);
    assert.equal(ctx.lk1.decision.subscriptionVisitCount, 0);
    assert.equal(ctx.lk1.transactionIntent.chargeMinor, expected);
    const transaction = call(ctx, { matchedCount: 1, modifiedCount: 1 });
    assert.equal(transaction.result.step, 'lk1_transaction_create');
    assert.equal(transaction.result.method, 'POST');
    assert.deepEqual(transaction.result.payload.products, payload.products);
    assert.equal(transaction.result.payload.clientSubscriptionId, undefined);
    assert.equal(transaction.result.payload.clientPhone, ctx.actorPhone);
  }
});

test('event payment fails closed for missing/duplicate tariff, cost/type/identity drift, and incomplete response', () => {
  const invalid = [[], [service(), service()], [{ ...service(), id: 'other' }],
    [{ ...service(), cost: 1000000 }], [{ ...service(), cost: '550000' }],
    [{ ...service(), price: 1 }], [{ ...service(), productId: 'other' }],
    [{ ...service(), type: 'SUBSCRIPTION' }], [{ ...service(), productType: 'ONE_TIME' }],
    [{ ...service(), cost: 550000.5 }], { content: [service()], last: false }];
  for (const rows of invalid) assert.equal(call(context(), rows).result.kind, 'stop', JSON.stringify(rows));
  assert.equal(call(context(), [service()], { msg: { statusCode: 503 } }).result.code, 'LK1_PAYMENT_CARRIER_UNAVAILABLE');
});

test('group binding rejects visit debit, altered event, wrong category, and amount outside rule', () => {
  for (const mutate of [ctx => ctx.lk1.decision.subscriptionVisitCount = 1,
    ctx => ctx.lk1.target.eventId = 'other', ctx => ctx.lk1.target.category = 'GAME',
    ctx => ctx.lk1.decision.benefit.finalPriceMinor = 1,
    ctx => ctx.lk1.rule.groupTrainingDiscountPercent = 50.5]) {
    const ctx = context(); mutate(ctx);
    assert.equal(call(ctx, [service()]).result.code, 'LK1_GROUP_PAYMENT_BINDING_INVALID');
  }
});

test('profile recheck cannot replace group product, discount, rule, actor, or booking', () => {
  for (const mutate of [msg => msg._splitCtx.transactionPayload.products[0].id = 'fixture-game-carrier',
    msg => msg._splitCtx.transactionPayload.products[0].discount = 725000,
    msg => msg._splitCtx.transactionPayload.products[0].bookingIds = ['other'],
    msg => msg._splitCtx.transactionPayload.products[0].type = 'SUBSCRIPTION',
    msg => msg._splitCtx.transactionPayload.products.push(service()),
    msg => msg.payload.id = 'other', msg => msg.payload.phone = 'other']) {
    const ctx = context(); const selected = call(ctx, [service()]);
    const msg = { _splitCtx: selected.msg._splitCtx, payload: { id: ctx.actorClientId, phone: ctx.actorPhone } };
    mutate(msg);
    assert.equal(call(ctx, msg.payload, { msg }).result.kind, 'stop');
    assert.equal(ctx.lk1.transactionAttemptedAt, undefined);
  }
  const ctx = context(); const selected = call(ctx, [service()]);
  assert.equal(call(ctx, { id: ctx.actorClientId, phone: ctx.actorPhone }, {
    msg: { _splitCtx: selected.msg._splitCtx }, rule: { ...ctx.lk1.rule, groupTrainingDiscountPercent: 40 },
  }).result.code, 'LK1_PRODUCT_RULE_CHANGED');
});

test('CAS ambiguity never dispatches transaction; verified readback returns exact payment link', () => {
  const { ctx } = payment();
  assert.equal(call(structuredClone(ctx), { matchedCount: 0, modifiedCount: 0 }).result.code, 'LK1_PAYMENT_ATTEMPT_NOT_OWNED');
  ctx.step = 'lk1_transaction_readback'; ctx.lk1.transactionId = 'fixture-transaction';
  const transaction = { id: ctx.lk1.transactionId, clientId: ctx.actorClientId, toPayMinor: 275000,
    paymentUrl: 'https://pay.example.test/checkout', products: [{ id: productId, type: 'SERVICE', count: 1,
      bookingIds: [ctx.confirmedBookingId], discount: 275000 }] };
  for (const change of [{ toPayMinor: 1 }, { clientId: 'other' }, { products: [{ ...transaction.products[0], id: 'other' }] },
    { products: [{ ...transaction.products[0], bookingIds: ['other'] }] }, { paymentUrl: 'javascript:bad' }]) {
    assert.equal(call(structuredClone(ctx), { ...transaction, ...change }).result.kind, 'stop');
  }
  assert.equal(call(ctx, transaction).result.step, 'lk1_checkout_saved');
  const confirmed = call(ctx, { matchedCount: 1 });
  assert.equal(confirmed.result.payload.paymentUrl, transaction.paymentUrl);
  assert.equal(confirmed.result.payload.toPayMinor, 275000);
  assert.equal(confirmed.result.payload.subscriptionVisitCount, 0);
});

test('game payments still use split serializer and its unchanged 10000 carrier', () => {
  const ctx = context(); ctx.managedAction = 'JOIN_GAME'; ctx.lk1.target.category = 'GAME';
  assert.equal(call(ctx, [service()]).result.kind, 'final');
  ctx.step = 'lk1_payment_profile_recheck';
  const msg = { _splitCtx: { productId, transactionPayload: { clientPhone: ctx.actorPhone, studioId: ctx.studioId,
    paymentMethod: 'SMS', products: [{ id: productId, type: 'SERVICE', count: 1, customAmount: null,
      bookingIds: [ctx.confirmedBookingId], discount: 725000 }] } } };
  const result = call(ctx, { id: ctx.actorClientId, phone: ctx.actorPhone }, { msg });
  assert.equal(result.result.step, 'lk1_payment_attempt_saved');
  assert.equal(ctx.lk1.transactionIntent.baseMinor, undefined);
});

test('100 percent rule completes free group booking without a transaction', () => {
  const ctx = context(100); ctx.step = 'fixture_checkout';
  const result = call(ctx, {}, { suffix: '\nreturn lk1Checkout(ctx);' });
  assert.equal(result.result.kind, 'final');
  assert.equal(result.result.payload.paid, true);
  assert.equal(result.result.payload.paymentUrl, null);
  assert.equal(result.result.payload.subscriptionVisitCount, 0);
});

test('group and game+trainer type IDs both retain the canonical group classification', () => {
  const router = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const categorySource = router.slice(router.indexOf('const resolveCategory ='), router.indexOf('const eventDate ='));
  const resolve = new Function('isObj', 'numericId', `${categorySource}; return resolveCategory;`)(
    value => value !== null && typeof value === 'object', value => Number(value?.id ?? value));
  assert.equal(resolve({ type: { id: 605 } }), 'group_training');
  assert.equal(resolve({ type: { id: 847 } }), 'group_training');
});

test('group payment replay returns verified link or reconciliation without HTTP or Mongo mutation', () => {
  const { ctx } = payment();
  ctx.lk1.transactionId = 'fixture-transaction';
  ctx.lk1.checkout = { transactionId: ctx.lk1.transactionId, toPayMinor: 275000, paymentUrl: 'https://pay.example.test/group' };
  ctx.step = 'lk1_ingress_operation_find';
  const record = { _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, operationId: ctx.operationId,
    clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId, bookingId: ctx.confirmedBookingId,
    state: 'CONFIRMED', lk1: ctx.lk1 };
  record.lk1.fingerprint = JSON.stringify({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    clientSubscriptionId: ctx.clientSubscriptionId, action: ctx.managedAction,
    rule: ctx.lk1.rule, target: ctx.lk1.target });
  const accepted = call(ctx, [record]);
  assert.equal(accepted.result.kind, 'final');
  assert.equal(accepted.result.payload.paymentUrl, 'https://pay.example.test/group');
  for (const change of [r => delete r.lk1.checkout, r => delete r.lk1.transactionIntent.baseMinor,
    r => r.lk1.transactionIntent.productId = 'other', r => r.lk1.transactionIntent.discountMinor = 1]) {
    const broken = structuredClone(record); change(broken);
    ctx.step = 'lk1_ingress_operation_find';
    assert.equal(call(ctx, [broken]).result.code, 'LK1_PAYMENT_RECONCILIATION_REQUIRED');
  }
});

test('preview accepts current rule percentages and rejects an incorrectly rounded amount', () => {
  const router = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
  for (const [percent, base, amount, error] of [[50, 550000, 275000], [10, 550000, 495000],
    [33, 550001, 368501], [0, 550000, 550000], [100, 550000, 0], [33, 550001, 368500, 'GROUP_DISCOUNT_DECISION_INVALID']]) {
    const ctx = { step: 'evaluate', pending: [], catalog: { product: 'fixture-name' }, metadata: { 'fixture-subscription': { productId: 'product' } }, groupTraining: true, groupDiscountPercent: percent,
      basePriceMinor: base, currentId: 'fixture-subscription', requestedIds: [], index: 0,
      actorClientId: 'fixture-actor', exerciseId: 'fixture-event', names: {},
      target: { startsAt: '2099-01-01', durationMinutes: 60 }, quotes: [] };
    const msg = { _subscriptionPricePreview: ctx,
      _managedSubscriptionPolicyDecision: { eligible: true, subscriptionVisitCount: 0, benefit: { finalPriceMinor: amount } } };
    new Function('msg', 'canonical', router)(msg, { identityMoneyOwned() {}, isObj: value => value !== null && typeof value === 'object' });
    assert.equal(ctx.error, error);
    if (!error) assert.equal(ctx.quotes[0].amountMinor, amount);
  }
});

test('payment product envelopes support existing Viva services shapes and reject incomplete lists', () => {
  for (const rows of [{ services: [service()] }, { subServices: [service()] },
    { data: { services: [service()] } }, { result: [service()] },
    { services: [service()], subServices: [{ id: 'other', type: 'SUBSCRIPTION' }] }]) {
    assert.equal(call(context(), rows).result.step, 'lk1_payment_profile_recheck');
  }
  for (const rows of [{ services: [service()], last: false }, { data: [service()], totalElements: 2 },
    { services: [service()], hasNext: true }, { services: [service()], subServices: [service()] }]) {
    assert.equal(call(context(), rows).result.kind, 'stop');
  }
});

test('previously verified legacy group checkout stays replayable without issuing a new transaction', () => {
  const { ctx } = payment();
  delete ctx.lk1.transactionIntent.productType; delete ctx.lk1.transactionIntent.baseMinor;
  ctx.lk1.transactionIntent.productId = 'fixture-legacy-game-carrier';
  ctx.lk1.transactionIntent.discountMinor = 725000;
  ctx.lk1.transactionId = 'fixture-legacy-transaction';
  ctx.lk1.checkout = { transactionId: ctx.lk1.transactionId, toPayMinor: 275000, paymentUrl: 'https://pay.example.test/legacy' };
  ctx.step = 'lk1_ingress_operation_find';
  const record = { _id: `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, operationId: ctx.operationId,
    clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId, bookingId: ctx.confirmedBookingId,
    state: 'CONFIRMED', lk1: ctx.lk1 };
  record.lk1.fingerprint = JSON.stringify({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    clientSubscriptionId: ctx.clientSubscriptionId, action: ctx.managedAction, rule: ctx.lk1.rule, target: ctx.lk1.target });
  assert.equal(call(ctx, [record]).result.payload.paymentUrl, 'https://pay.example.test/legacy');
  ctx.step = 'lk1_ingress_operation_find'; delete record.lk1.checkout;
  assert.equal(call(ctx, [record]).result.code, 'LK1_PAYMENT_RECONCILIATION_REQUIRED');
});
