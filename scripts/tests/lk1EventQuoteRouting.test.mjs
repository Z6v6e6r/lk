// Event-route quote routing, driven at step level against the reviewed router body.
//
// 2026-09-15, after the plan-rules release: the event route (group training and
// tournament quotes) dropped every out-of-contour subscription from the request, so the
// batch came back as `quotes: []` and the cabinet blocked the booking; a plan product
// that passed the cohort gate died in `identityMoneyOwned` (HUB-only) with
// PRODUCT_IDENTITY_UNRESOLVED; and every decision blocker other than the removed cap
// blocker became a 503 `PRICE_PREVIEW_DECISION_UNRESOLVED`. These tests pin the fixed
// routing without needing a private live-flow fixture: the router body is executed with
// a stub `canonical`, so they run everywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const routerSource = fs.readFileSync(
  new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
const finalSource = fs.readFileSync(
  new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8');

const HUB = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const PLAN = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
const SUB = '00000000-0000-4000-8000-000000000002';
const EXERCISE = '00000000-0000-4000-8000-000000000003';
const TENANT = 'iSkq6G';
const BASE = 550000;

/** Execute the router body with a stub `canonical` and return its output array. */
function runRouter({ ctx, msg = {}, canonical = {} }) {
  const sandbox = {
    msg: { _subscriptionPricePreview: ctx, ...msg },
    canonical,
    global: { get: () => undefined },
    Date, Math, Number, String, Set, Map, JSON, Intl, Boolean, Array, Object,
    encodeURIComponent,
  };
  const outputs = vm.runInNewContext(`(function(){${routerSource}\n})()`, sandbox);
  return { outputs, msg: sandbox.msg };
}

const baseCtx = (overrides = {}) => ({
  tenantKey: TENANT, actorClientId: 'actor', step: 'next', pending: [SUB],
  requestedIds: [SUB], subscriptions: { [SUB]: { subscriptionId: SUB, status: 'ACTIVE', purchaseDate: '2026-08-01' } },
  metadata: { [SUB]: { productId: PLAN } }, catalog: { [PLAN]: 'Дружба 30 дней' },
  rules: { [SUB]: { matched: false } }, bookings: [], quotes: [], basePriceMinor: BASE,
  priceProductId: '00000000-0000-4000-8000-000000000006', exerciseId: EXERCISE,
  existingGame: false, eventCategory: 'GROUP_TRAINING',
  target: { targetKind: 'GROUP_TRAINING', startsAt: '2099-09-21T08:00:00+03:00', durationMinutes: 60, stationId: 's', roomId: 'r' },
  ...overrides,
});

const quoteOf = (msg) => (msg._subscriptionPricePreview.quotes || []).at(-1);
// Values cross a vm realm boundary, so compare serialized shapes, never prototypes.
const outputShape = (outputs) => JSON.stringify(outputs.map(Boolean));
const QUOTED = JSON.stringify([false, false, false, false, true, false]);
const plain = (value) => JSON.parse(JSON.stringify(value));
const identityStub = (calls) => ({
  isObj: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  normalizeId: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : null),
  LK1_OVERLAY_HUB_PRODUCT_ID: HUB,
  resolveLk1Rule: () => ({ matched: false }),
  lk1PlanRulesGlobal: () => undefined,
  collectSubscriptionPurchaseDateEvidence: () => ({ invalid: false, dates: ['2026-08-01'] }),
  hasCompleteBookingList: () => true,
  extractItems: (payload) => (Array.isArray(payload) ? payload
    : Array.isArray(payload?.content) ? payload.content : []),
  preflightAvailability: { resolveSplitSubscriptionLifecycle: () => 'AVAILABLE' },
  identityOwned: () => { calls.push('identityOwned'); return [{ productId: PLAN, purchaseDate: '2026-08-01' }]; },
  identityMoneyOwned: () => { calls.push('identityMoneyOwned'); return [{ productId: HUB, purchaseDate: '2026-08-01' }]; },
});

test('an out-of-contour subscription is quoted at the ordinary event tariff', () => {
  const calls = [];
  const { outputs, msg } = runRouter({ ctx: baseCtx(), canonical: identityStub(calls) });
  assert.equal(outputShape(outputs), QUOTED);
  const quote = quoteOf(msg);
  assert.equal(msg._subscriptionPricePreview.error, undefined);
  assert.equal(quote.subscriptionId, SUB);
  assert.equal(quote.status, 'AVAILABLE');
  assert.equal(quote.amountMinor, BASE);
  assert.equal(quote.basePriceMinor, BASE);
  assert.equal(quote.discountPercent, 0);
  assert.equal(quote.paidMinutes, 60);
  assert.equal(quote.durationMinutes, 60);
  // The validator the group schedule uses requires exactly this identity.
  assert.equal(quote.amountMinor, quote.basePriceMinor - Math.floor(quote.basePriceMinor * quote.discountPercent / 100));
  assert.deepEqual(calls, ['identityOwned']);
});

test('a matched plan product is verified by the product identity, HUB keeps the money identity', () => {
  const planCalls = [];
  runRouter({ ctx: baseCtx(), canonical: identityStub(planCalls) });
  assert.deepEqual(planCalls, ['identityOwned']);
  const hubCalls = [];
  runRouter({
    ctx: baseCtx({ metadata: { [SUB]: { productId: HUB } }, catalog: { [HUB]: 'Годовая HUB' } }),
    canonical: identityStub(hubCalls),
  });
  assert.deepEqual(hubCalls, ['identityMoneyOwned']);
});

test('decision blockers the client can act on become quotes, not a 503', () => {
  const limit = 'USAGE_SNAPSHOT_BUCKET_MISMATCH';
  const unavailable = 'LK1_GAME_OVERAGE_ALLOCATION_UNBOUND';
  for (const [code, status] of [[limit, 'LIMIT_USED'], [unavailable, 'UNAVAILABLE'],
    ['EVENT_NOT_INCLUDED', 'UNAVAILABLE'], ['TARGET_NOT_SERVER_RESOLVED', 'UNAVAILABLE'],
    ['ACTIVE_SERVICES_LIMIT_REACHED', 'LIMIT_USED']]) {
    const ctx = baseCtx({ step: 'evaluate', currentId: SUB, pending: [], quotes: [], groupDiscountPercent: 50 });
    const { outputs, msg } = runRouter({
      ctx, canonical: identityStub([]),
      msg: { _managedSubscriptionPolicyDecision: { eligible: false, blockers: [{ code }] } },
    });
    assert.equal(outputShape(outputs), QUOTED, code);
    const quote = quoteOf(msg);
    assert.equal(quote.status, status, code);
    assert.equal(quote.reasonCode, code, code);
    assert.equal(msg._subscriptionPricePreview.error, undefined, code);
  }
});

test('a technical blocker stays a fail-closed 503', () => {
  for (const code of ['USAGE_SNAPSHOT_INVALID', 'LK1_POLICY_INVALID', 'BASE_PRICE_UNRESOLVED',
    'SUBSCRIPTION_INSTANCE_INVALID', 'PRICE_CALCULATION_OVERFLOW']) {
    const ctx = baseCtx({ step: 'evaluate', currentId: SUB, pending: [], quotes: [], groupDiscountPercent: 50 });
    const { outputs, msg } = runRouter({
      ctx, canonical: identityStub([]),
      msg: { _managedSubscriptionPolicyDecision: { eligible: false, blockers: [{ code }] } },
    });
    assert.equal(outputShape(outputs), QUOTED, code);
    assert.equal(msg._subscriptionPricePreview.error, 'PRICE_PREVIEW_DECISION_UNRESOLVED', code);
    assert.equal(msg._subscriptionPricePreview.statusCode, 503, code);
  }
  // A blocker list the preview cannot attribute stays fail-closed as well.
  const ctx = baseCtx({ step: 'evaluate', currentId: SUB, pending: [], quotes: [], groupDiscountPercent: 50 });
  const { msg } = runRouter({
    ctx, canonical: identityStub([]),
    msg: { _managedSubscriptionPolicyDecision: { eligible: false, blockers: [{ code: 'A' }, { code: 'B' }] } },
  });
  assert.equal(msg._subscriptionPricePreview.error, 'PRICE_PREVIEW_DECISION_UNRESOLVED');
});

test('a refused event tariff names the sub-condition and the observed shape', () => {
  const tariffUrl = `https://api.vivacrm.ru/end-user/api/v2/${TENANT}/products/one-times?exerciseId=${EXERCISE}`;
  const cases = [
    { name: 'url', msg: { statusCode: 200, method: 'GET', url: 'https://api.vivacrm.ru/other', payload: { content: [{}] } }, stage: 'request_url' },
    { name: 'type', msg: { statusCode: 200, method: 'GET', url: tariffUrl, payload: { content: [{ id: 'p1', productType: 'TOURNAMENT', cost: BASE }] } }, stage: 'product_type' },
    { name: 'amount', msg: { statusCode: 200, method: 'GET', url: tariffUrl, payload: { content: [{ id: 'p1', productType: 'SERVICE', cost: BASE, trialCost: 0 }] } }, stage: 'product_amount' },
    { name: 'event id', msg: { statusCode: 200, method: 'GET', url: tariffUrl, payload: { content: [{ id: 'p1', productType: 'SERVICE', cost: BASE, exerciseId: 'other' }] } }, stage: 'product_identity' },
  ];
  for (const item of cases) {
    const ctx = baseCtx({ step: 'groupTariff' });
    const { msg } = runRouter({ ctx, canonical: identityStub([]), msg: item.msg });
    const state = msg._subscriptionPricePreview;
    assert.equal(state.error, 'LK1_EVENT_TARIFF_UNVERIFIED', item.name);
    assert.equal(state.statusCode, 503, item.name);
    assert.equal(state.errorDetails.stage, item.stage, item.name);
    assert.ok(plain(state.errorDetails.observed), item.name);
  }
  // The accepted shape keeps the proven tariff and never carries a detail.
  const ctx = baseCtx({ step: 'groupTariff' });
  const { msg } = runRouter({
    ctx, canonical: identityStub([]),
    msg: { statusCode: 200, method: 'GET', url: tariffUrl, payload: { content: [{ id: 'p1', productType: 'SERVICE', cost: BASE, trialCost: BASE }] } },
  });
  assert.equal(msg._subscriptionPricePreview.basePriceMinor, BASE);
  assert.equal(msg._subscriptionPricePreview.priceProductId, 'p1');
  assert.equal(msg._subscriptionPricePreview.error, undefined);
});

test('the response carries the refusal detail only when the router recorded one', () => {
  const runFinal = (ctx) => {
    const sandbox = { msg: { _subscriptionPricePreview: ctx }, JSON, Date, Number, String, Boolean, Object };
    return vm.runInNewContext(`(function(){${finalSource}\n})()`, sandbox);
  };
  const withDetail = runFinal({ done: true, error: 'LK1_EVENT_TARIFF_UNVERIFIED', statusCode: 503,
    errorDetails: { stage: 'product_type', observed: { types: ['TOURNAMENT'] } } });
  assert.equal(JSON.stringify(withDetail.payload), JSON.stringify({ error: { code: 'LK1_EVENT_TARIFF_UNVERIFIED',
    details: { stage: 'product_type', observed: { types: ['TOURNAMENT'] } } } }));
  const plain = runFinal({ done: true, error: 'PRICE_PREVIEW_DECISION_UNRESOLVED', statusCode: 503 });
  assert.equal(JSON.stringify(plain.payload), JSON.stringify({ error: { code: 'PRICE_PREVIEW_DECISION_UNRESOLVED' } }));
  const quotes = runFinal({ done: true, statusCode: 200, quotes: [{ subscriptionId: SUB }] });
  assert.equal(JSON.stringify(quotes.payload), JSON.stringify({ quotes: [{ subscriptionId: SUB }] }));
});

test('every prepared event request drops the previous response provenance', () => {
  // The group-tariff step compares `msg.responseUrl` with the URL it asked for, and
  // Node-RED sets that field on every reply. A stale value from the previous step made
  // the comparison fail while the response itself was correct.
  const ctx = baseCtx({ step: 'operations', operations: [], ruleProductIds: [PLAN] });
  const { msg } = runRouter({
    ctx, canonical: identityStub([]),
    msg: { statusCode: 200, responseUrl: 'https://api.vivacrm.ru/end-user/api/v2/iSkq6G/bookings?size=1000', payload: [] },
  });
  const state = msg._subscriptionPricePreview;
  assert.equal(state.step, 'groupTariff');
  assert.equal(msg.responseUrl, undefined);
  assert.equal(msg.url, `https://api.vivacrm.ru/end-user/api/v2/${TENANT}/products/one-times?exerciseId=${EXERCISE}`);
  assert.equal(msg.method, 'GET');
});

test('the booking gateway prepares its requests with the same provenance rule', () => {
  const source = fs.readFileSync(
    new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const prepare = source.slice(source.indexOf('const prepareHttp = '));
  const body = prepare.slice(0, prepare.indexOf('const prepareManagedHttp'));
  assert.match(body, /delete msg\.responseUrl;/);
  assert.ok(body.indexOf('delete msg.responseUrl;') < body.indexOf('return emit(OUTPUT_HTTP);'));
});
