import { hubGatewaySource } from '../lib/eventPaymentSources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = hubGatewaySource();
const productId = 'fixture-group-tariff';
const hubId = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const context = (percent = 50, base = 550000) => ({
  caller: 'http', managedAction: 'BOOK_GROUP_TRAINING', category: 'group_training',
  step: 'lk1_group_payment_products', tenantKey: 'fixture', actorClientId: 'fixture-actor',
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
  assert.equal(selected.result.step, 'lk1_group_payment_profile');
  assert.equal(selected.result.method, 'GET');
  const payload = ctx.lk1EventPayment.transactionPayload;
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
  assert.equal(call(context(), [service()], { msg: { statusCode: 503 } }).result.code, 'LK1_GROUP_PAYMENT_PRODUCT_UNAVAILABLE');
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
  for (const mutate of [msg => msg.eventCtx.transactionPayload.products[0].id = 'fixture-game-carrier',
    msg => msg.eventCtx.transactionPayload.products[0].discount = 725000,
    msg => msg.eventCtx.transactionPayload.products[0].bookingIds = ['other'],
    msg => msg.eventCtx.transactionPayload.products[0].type = 'SUBSCRIPTION',
    msg => msg.eventCtx.transactionPayload.products.push(service()),
    msg => msg.payload.id = 'other', msg => msg.payload.phone = 'other']) {
    const ctx = context(); call(ctx, [service()]);
    const msg = { eventCtx: ctx.lk1EventPayment, payload: { id: ctx.actorClientId, phone: ctx.actorPhone } };
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

test('split game readback accepts the real Viva transaction evidence shape', () => {
  const gameCtx = () => ({
    caller: 'split', managedAction: 'JOIN_GAME', category: 'open_game',
    step: 'lk1_transaction_readback', tenantKey: 'fixture', actorClientId: 'fixture-actor',
    actorPhone: 'fixture-phone', studioId: 'fixture-studio', exerciseId: 'fixture-event',
    confirmedBookingId: 'fixture-booking', operationId: 'fixture-operation', operationKey: 'fixture-key',
    clientSubscriptionId: 'fixture-subscription',
    lk1: {
      transactionId: 'fixture-transaction', transactionAttemptedAt: '2026-09-15T12:26:00.000Z',
      target: { category: 'GAME', eventId: 'fixture-event', stationId: 'fixture-studio',
        priceProductId: 'fixture-game-carrier', basePriceMinor: 1000000 },
      rule: { productId: hubId, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
        gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 },
      decision: { eligible: true, subscriptionVisitCount: 0, benefit: { finalPriceMinor: 210000 } },
      transactionIntent: { productId: 'fixture-game-carrier', bookingId: 'fixture-booking',
        actorClientId: 'fixture-actor', studioId: 'fixture-studio', chargeMinor: 210000, discountMinor: 790000 },
    },
  });
  // Real Viva admin transaction readback: the checkout link lives in
  // cardPaymentInfo, the payable amount is the minor `toPay`, and neither the
  // client nor the booking reference is echoed by this DTO.
  const transaction = { id: 'fixture-transaction', toPay: 210000,
    cardPaymentInfo: { paymentId: 'fixture-payment', paymentUrl: 'https://pay.tbank.ru/fixture', status: 'NEW' },
    paymentDueDate: '2026-09-15T12:36:00.000Z' };
  const accepted = call(gameCtx(), transaction);
  assert.equal(accepted.result.step, 'lk1_checkout_saved');
  assert.deepEqual(accepted.result.update.$set['lk1.checkout'],
    { transactionId: 'fixture-transaction', paymentUrl: 'https://pay.tbank.ru/fixture', toPayMinor: 210000 });
  // Nested provider echoes are read exactly like the legacy split lookup reads them.
  for (const echoed of [
    { bookingIds: ['fixture-booking'] },
    { products: [{ paymentBookingIds: ['fixture-booking'] }] },
    { products: [{ pricingDetails: [{ clientBookingId: 'fixture-booking' }] }] },
    { client: { id: 'fixture-actor' } },
    { products: [{ id: 'fixture-game-carrier', type: 'SERVICE', count: 1, discount: 790000 }] },
  ]) {
    assert.equal(call(gameCtx(), { ...transaction, ...echoed }).result.step, 'lk1_checkout_saved', JSON.stringify(echoed));
  }
  // Every alias the provider does echo still has to agree with the recorded intent.
  for (const conflict of [
    { id: 'other' }, { id: 'fixture-transaction', transactionId: 'other' }, { toPay: 209999 },
    { clientId: 'other' }, { client: { id: 'fixture-actor', uuid: 'other' } },
    { bookingIds: ['other'] }, { products: [{ bookingId: 'other' }] },
    { products: [{ pricingDetails: [{ clientBookingId: 'other' }] }] },
    { products: [{ id: 'other' }] }, { products: [{ discount: 1 }] },
    { cardPaymentInfo: { paymentUrl: 'javascript:bad' } },
    { paymentUrl: 'https://pay.example.test/other', cardPaymentInfo: { paymentUrl: 'https://pay.tbank.ru/fixture' } },
    { currency: 'USD' },
  ]) {
    assert.equal(call(gameCtx(), { ...transaction, ...conflict }).result.kind, 'stop', JSON.stringify(conflict));
  }
  assert.equal(call(gameCtx(), transaction, { msg: { statusCode: 503 } }).result.kind, 'stop');
});

test('game payments still use split serializer and its unchanged 10000 carrier', () => {
  const ctx = context(); ctx.managedAction = 'JOIN_GAME'; ctx.caller = 'split'; ctx.step = 'lk1_payment_products'; ctx.lk1.target.category = 'GAME';
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
    category: ctx.category, clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId, bookingId: ctx.confirmedBookingId,
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
    assert.equal(call(context(), rows).result.step, 'lk1_group_payment_profile');
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
    category: ctx.category, clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId, bookingId: ctx.confirmedBookingId,
    state: 'CONFIRMED', lk1: ctx.lk1 };
  record.lk1.fingerprint = JSON.stringify({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    clientSubscriptionId: ctx.clientSubscriptionId, action: ctx.managedAction, rule: ctx.lk1.rule, target: ctx.lk1.target });
  assert.equal(call(ctx, [record]).result.payload.paymentUrl, 'https://pay.example.test/legacy');
  ctx.step = 'lk1_ingress_operation_find'; delete record.lk1.checkout;
  assert.equal(call(ctx, [record]).result.code, 'LK1_PAYMENT_RECONCILIATION_REQUIRED');
});

test('tournament route uses its own rule, service and context through verified checkout', () => {
  for (const percent of [0, 20, 50, 100]) {
    const ctx = context(50, 630000);
    ctx.managedAction = 'BOOK_TOURNAMENT'; ctx.category = 'tournament';
    ctx.lk1.target.category = 'TOURNAMENT'; ctx.lk1.rule.tournamentDiscountPercent = percent;
    ctx.lk1.decision.benefit.finalPriceMinor = 630000 - Math.floor(630000 * percent / 100);
    ctx.step = 'fixture_checkout';
    const checkout = call(ctx, null, {suffix:'\nreturn lk1Checkout(ctx);'});
    if (percent === 100) { assert.equal(checkout.result.payload.paid, true); continue; }
    assert.equal(checkout.result.step, 'lk1_tournament_payment_products');
    const selected = call(ctx, [service(630000), {id:'game-carrier',type:'SERVICE',cost:1000000}]);
    assert.equal(selected.result.step, 'lk1_tournament_payment_profile');
    assert.equal(selected.msg._splitCtx, undefined);
    const intent = call(ctx, {id:ctx.actorClientId,phone:ctx.actorPhone});
    assert.equal(intent.result.step, 'lk1_payment_attempt_saved');
    assert.equal(ctx.lk1.transactionIntent.chargeMinor, 630000 - Math.floor(630000 * percent / 100));
    assert.equal(ctx.lk1.transactionIntent.baseMinor, 630000);
    assert.equal(ctx.lk1.decision.subscriptionVisitCount, 0);
  }
});

test('an event cannot fall through into the open-game serializer or use another category', () => {
  for (const mutate of [ctx => ctx.step = 'lk1_payment_products', ctx => ctx.category = 'tournament',
    ctx => ctx.caller = 'split', ctx => ctx.lk1.target.stationId = 'another-station']) {
    const ctx = context(); mutate(ctx);
    assert.equal(call(ctx,[service()]).result.kind,'stop');
  }
  const ctx=context();call(ctx,[service()]);ctx.step='lk1_payment_profile_recheck';
  assert.equal(call(ctx,{id:ctx.actorClientId,phone:ctx.actorPhone}).result.kind,'stop');
});

test('event preview validates actual category and reads its configured percentage', () => {
  const entry=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/entry.js',import.meta.url),'utf8');
  const router=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js',import.meta.url),'utf8');
  const id='11111111-1111-4111-8111-111111111111';
  for(const kind of ['GROUP_TRAINING','TOURNAMENT']) {
    const msg={req:{headers:{authorization:'Bearer fixture'}},payload:{target:{targetKind:kind,exerciseId:id}}};
    new Function('msg',entry)(msg);assert.equal(msg._subscriptionPricePreview.eventCategory,kind);
    const ctx=msg._subscriptionPricePreview;ctx.step='groupExercise';msg.statusCode=200;
    msg.payload={id,time:'2099-01-01'};
    const canonical={unwrapRecord:v=>v,eventStartsAt:()=> '2099-01-01',eventDurationMinutes:()=>60,
      resolveCategory:()=> kind==='TOURNAMENT'?'group_training':'tournament',exerciseRoomId:()=> 'room',managedExternalEventTypeId:()=>1,identityMoneyOwned(){}};
    new Function('msg','canonical',router)(msg,canonical);
    assert.equal(ctx.error,kind==='TOURNAMENT'?'TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED':'GROUP_DISCOUNT_TARGET_UNRESOLVED');
  }
});

test('displayed tournament expectation cannot select group rule or alter the recomputed charge', () => {
  const block=source.slice(source.indexOf('  const expectedGroup ='),source.indexOf('  ctx.lk1.decision = JSON.parse'));
  const valid=context();valid.managedAction='BOOK_TOURNAMENT';valid.category='tournament';valid.lk1.target.category='TOURNAMENT';
  valid.lk1.rule.tournamentDiscountPercent=20;valid.lk1.decision.benefit.finalPriceMinor=440000;
  Object.assign(valid.lk1.target,{startsAt:'2099-01-01T12:00:00+03:00',durationMinutes:60});
  valid.expectedTournamentDiscount={basePriceMinor:550000,amountMinor:440000,productId,
    startsAt:valid.lk1.target.startsAt,durationMinutes:60,discountPercent:20};
  const run=ctx=>new Function('ctx','decision','isObj','lk1EventPaymentRoute','finishError',block+'\nreturn "accepted";')(
    ctx,ctx.lk1.decision,v=>v!==null&&typeof v==='object',()=>({sourceCategory:'tournament',category:'TOURNAMENT',discountField:'tournamentDiscountPercent'}),()=> 'rejected');
  assert.equal(run(valid),'accepted');
  for(const mutate of [c=>c.expectedTournamentDiscount.amountMinor=275000,c=>c.expectedTournamentDiscount.discountPercent=50,
    c=>c.expectedTournamentDiscount.productId='game-carrier',c=>c.expectedGroupDiscount=c.expectedTournamentDiscount,
    c=>c.category='group_training',c=>c.expectedTournamentDiscount.startsAt='2099-01-02T12:00:00+03:00']) {
    const ctx=structuredClone(valid);mutate(ctx);assert.equal(run(ctx),'rejected');
  }
});
