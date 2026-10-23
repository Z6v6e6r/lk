import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { FRIENDSHIP_MONTHLY_PRODUCT_ID } from '../../src/components/subscription-storefront/catalog.ts';

const phone = `+${'7'}${'900000000'}`;
const price = { productId: 'synthetic-product', promoCode: 'SYNTHETIC', sumMinor: 100000, discountMinor: 25000, toPayMinor: 75000 };
function load(file: string, stubs: Record<string, unknown>, globals: Record<string, unknown> = {}, sourceOverride?: string) {
  const source = (sourceOverride ?? readFileSync(file, 'utf8')).replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\n/gm, '');
  const compiled = ts.transpileModule(`const { ${Object.keys(stubs).join(', ')} } = __stubs;\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, (...args: any[]) => any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  vm.runInNewContext(compiled, { exports, __stubs: stubs, URL, URLSearchParams, TextEncoder, Uint8Array, crypto: webcrypto, ...globals });
  return exports;
}
function api(payload: unknown = price) {
  const calls: { url: string; options: { method: string; auth: boolean; retries: number; body: string } }[] = [];
  const exports = load('src/utils/subscriptionPromoCode.ts', {
    API_BASE: 'https://provider.example', TENANT_KEY: 'synthetic-tenant',
    request: async (url: string, options: never) => { calls.push({ url, options }); return { data: payload, error: null }; },
  });
  return { ...exports, calls };
}

function payment(options: { fresh?: typeof price; result?: unknown; reject?: boolean; canProceed?: boolean; paidStatus?: boolean; quote?: typeof price; friendship?: boolean; gatewayResult?: Record<string, unknown>; gatewayReject?: boolean; gatewayError?: Record<string, unknown> } = {}) {
  const storage: Record<string, unknown> = {};
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = value; } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  const window = { localStorage: storage, location: { href: 'https://padlhub.ru/sub_hab?code=private-code&summerPaymentRef=other-ref&variant=atlanty#private-fragment' } };
  const calls: { productId: string; phone: string; options: Record<string, unknown> }[] = [];
  const active = new Set<string>();
  const navigator = { locks: { request: async (key: string, _options: unknown, run: (lock: object | null) => unknown) => {
    if (active.has(key)) return run(null);
    active.add(key); try { return await run({}); } finally { active.delete(key); }
  } } };
  const attempt = load('src/components/subscription-storefront/promoCodeAttempt.ts', { readAuthToken: () => 'synthetic-actor', readSubscriptionPromoTransactionPaid: async () => options.paidStatus === true }, { window, navigator });
  const exports = load('src/components/subscription-storefront/promoCodePayment.ts', {
    apiCreateTournamentSubscriptionPurchase: async (params: Record<string, unknown>) => {
      calls.push({ productId: String(params.productId), phone: String(params.clientPhone), options: params });
      if (options.gatewayReject) throw new Error('synthetic transport failure');
      return { data: options.gatewayResult ?? { productId: price.productId, transactionId: 'synthetic-transaction',
        paymentRef: 'synthetic-ref', campaignKey: 'synthetic', toPayMinor: 75000, paymentUrl: 'https://bank.example/pay' }, error: options.gatewayError ?? null };
    },
    buildStorefrontPaymentRef: () => 'synthetic-ref',
    upsertPendingPaymentEntry: () => {},
    apiBuySubscroption: async (productId: string, requestPhone: string, requestOptions: Record<string, unknown>) => {
      calls.push({ productId, phone: requestPhone, options: requestOptions });
      if (options.reject) throw new Error('synthetic transport failure');
      return { data: options.result ?? { toPay: 75000, paymentUrl: 'https://bank.example/pay' }, error: null };
    },
    previewSubscriptionPromoCode: async () => options.fresh ?? options.quote ?? price,
    StorefrontPaymentError: Error,
    appendCurrentAuthModeToNavigableUrl: (url: URL) => url,
    ...attempt,
  }, { window, localStorage: storage, navigator });
  return { calls, storage, attempt, pay: () => exports.createSubscriptionPromoPayment(options.quote ?? price, phone, () => options.canProceed !== false, options.friendship ? 'friendship' : undefined) };
}

test('provider preview binds SUBSCRIPTION product and trimmed code to authenticated single-shot request', async () => {
  const fixture = api({ sumKopecks: 100000, discountKopecks: 25000, toPayKopecks: 75000 });
  const quote = await fixture.previewSubscriptionPromoCode(price.productId, phone, ' SYNTHETIC ');
  assert.equal(quote.toPayMinor, 75000);
  const call = fixture.calls[0];
  assert.equal(call.url, 'https://provider.example/end-user/api/v1/synthetic-tenant/transactions/preview');
  assert.equal(call.options.auth, true); assert.equal(call.options.retries, 0);
  const payload = JSON.parse(call.options.body);
  assert.deepEqual(payload.products, [{ id: price.productId, type: 'SUBSCRIPTION', count: 1 }]);
  assert.equal(payload.promoCode, price.promoCode);
  assert.equal(payload.clientPhone, phone);
  assert.equal('discount' in payload.products[0], false);
});

test('malformed, contradictory and missing financial facts never authorize payment', async () => {
  for (const payload of [null, {}, { toPay: 75000 }, { sum: 100000, discount: 25000, toPay: -1 },
    { sum: 100000, discount: 25000, toPay: 75001 }, { sum: 100000, discount: 25000, toPay: 75000, toPayMinor: 75001 },
    { sum: 100000, discount: 0, toPay: 100000 }, { sum: 100000, discount: 25000, toPay: '75000' }]) {
    await assert.rejects(api(payload).previewSubscriptionPromoCode(price.productId, phone, price.promoCode));
  }
});

test('reprice drift and account change stop before marker or create', async () => {
  for (const options of [{ fresh: { ...price, discountMinor: 26000, toPayMinor: 74000 } }, { canProceed: false }]) {
    const fixture = payment(options);
    await assert.rejects(fixture.pay());
    assert.equal(fixture.calls.length, 0); assert.equal(Object.keys(fixture.storage).length, 0);
  }
});

test('same product/code goes to single-shot create; bank return excludes sensitive/other-payment parameters', async () => {
  const fixture = payment();
  const result = await fixture.pay();
  assert.equal(result.status, 'redirect');
  const call = fixture.calls[0];
  assert.equal(call.productId, price.productId); assert.equal(call.options.promoCode, price.promoCode);
  assert.equal(call.options.retries, 0);
  const url = new URL(String(call.options.successUrl));
  assert.equal(url.searchParams.get('subscriptionPromoReturn'), '1');
  assert.equal(url.searchParams.get('variant'), 'atlanty');
  assert.equal(url.searchParams.has('code'), false); assert.equal(url.searchParams.has('summerPaymentRef'), false); assert.equal(url.hash, '');
  assert.equal(Object.keys(fixture.storage).length, 1);
  assert.equal(JSON.stringify(fixture.storage).includes(phone), false);
  assert.equal(JSON.stringify(fixture.storage).includes(price.promoCode), false);
  await assert.rejects(fixture.pay()); assert.equal(fixture.calls.length, 1);
});

test('ambiguous response, unsafe URL and price mismatch retain marker and reject repeat', async () => {
  const credentialUrl = new URL('https://bank.example/pay');
  credentialUrl.username = 'user'; credentialUrl.password = 'pass';
  for (const options of [{ reject: true }, { result: {} }, { result: { toPay: 75001, paymentUrl: 'https://bank.example/pay' } },
    { result: { toPay: 75000, paymentUrl: 'http://bank.example/pay' } }, { result: { toPay: 75000, paymentUrl: credentialUrl.toString() } }]) {
    const fixture = payment(options);
    await assert.rejects(fixture.pay()); await assert.rejects(fixture.pay());
    assert.equal(fixture.calls.length, 1);
    assert.equal(await fixture.attempt.hasSubscriptionPromoAttempt(price.productId, phone), true);
  }
});

test('concurrent tabs issue at most one create', async () => {
  const fixture = payment();
  const results = await Promise.allSettled([fixture.pay(), fixture.pay()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(fixture.calls.length, 1);
});


test('verified settlement and later PAID status release the prior attempt for renewal', async () => {
  const zero = payment({ quote: { ...price, discountMinor: 100000, toPayMinor: 0 }, result: { toPay: 0, paid: true, paymentUrl: null } });
  assert.equal((await zero.pay()).status, 'settled');
  assert.equal(Object.keys(zero.storage).length, 0);
  const redirect = payment({ paidStatus: true, result: { id: 'synthetic-transaction', toPay: 75000, paymentUrl: 'https://bank.example/pay' } });
  await redirect.pay();
  assert.equal(Object.keys(redirect.storage).length, 1);
  assert.equal(await redirect.attempt.hasSubscriptionPromoAttempt(price.productId, phone), false);
  assert.equal(Object.keys(redirect.storage).length, 0);
});

test('only exact authoritative PAID status releases a transaction marker', async () => {
  for (const transactionStatus of ['PAID', 'UNPAID', 'WAITING', 'FAILED', 'UNKNOWN', 'REFUND']) {
    assert.equal(await api({ transactionStatus }).readSubscriptionPromoTransactionPaid('synthetic-transaction'), transactionStatus === 'PAID');
  }
});

test('ordinary purchase validation holds the same lock and excludes concurrent promo create', async () => {
  const fixture = payment();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let ordinaryCreates = 0;
  const ordinary = fixture.attempt.withSubscriptionPromoLock(price.productId, phone, async () => {
    entered(); await gate; ordinaryCreates += 1;
  });
  await started;
  await assert.rejects(fixture.pay());
  release(); await ordinary;
  assert.equal(ordinaryCreates, 1); assert.equal(fixture.calls.length, 0);
});

test('real subscription create serializes the exact promo code and disables retries while legacy stays compatible', async () => {
  const source = readFileSync('src/utils/apiClient.ts', 'utf8');
  const start = source.indexOf('export async function apiBuySubscroption(');
  const end = source.indexOf('\nconst TOURNAMENT_SUBSCRIPTION_PLAN_TYPES', start);
  const calls: { options: { body: string; retries: number } }[] = [];
  const exports = load('', { API_BASE: 'https://provider.example', TENANT_KEY: 'synthetic-tenant', SUCCESS_URL: 'https://return.example/success', FAIL_URL: 'https://return.example/fail',
    request: async (_url: string, options: never) => { calls.push({ options }); return { data: null, error: null }; },
  }, {}, source.slice(start, end));
  await exports.apiBuySubscroption(price.productId, phone, { promoCode: ' SYNTHETIC ', retries: 1 });
  assert.equal(calls[0].options.retries, 0);
  assert.equal(JSON.parse(calls[0].options.body).promoCode, price.promoCode);
  assert.deepEqual(JSON.parse(calls[0].options.body).products, [{ id: price.productId, type: 'SUBSCRIPTION', count: 1 }]);
  await exports.apiBuySubscroption(price.productId, phone);
  assert.equal(calls[1].options.retries, 1);
  assert.equal('promoCode' in JSON.parse(calls[1].options.body), false);
});


test('monthly Friendship promo keeps the counter gateway, exact quote and bank confirmation reference', async () => {
  const fixture = payment({ friendship: true });
  assert.equal((await fixture.pay()).status, 'redirect');
  assert.equal(fixture.calls.length, 1);
  const call = fixture.calls[0];
  assert.equal(call.options.counterKey, 'friendship');
  assert.equal(call.options.promoCode, price.promoCode);
  assert.equal(call.options.expectedPromoQuote, price);
  assert.equal(new URL(String(call.options.successUrl)).searchParams.get('summerPaymentRef'), 'synthetic-ref');
  assert.equal(new URL(String(call.options.successUrl)).searchParams.has('subscriptionPromoReturn'), false);
  await assert.rejects(fixture.pay());
  assert.equal(fixture.calls.length, 1);
});

test('ambiguous Friendship gateway and mismatched financial response retain the attempt and block retries', async () => {
  for (const options of [{ gatewayReject: true }, { gatewayResult: {} },
    { gatewayResult: { productId: 'wrong', toPayMinor: 75000, transactionId: 'synthetic', paymentUrl: 'https://bank.example/pay' } },
    { gatewayResult: { productId: price.productId, toPayMinor: 100000, transactionId: 'synthetic', paymentUrl: 'https://bank.example/pay' } }]) {
    const fixture = payment({ ...options, friendship: true });
    await assert.rejects(fixture.pay()); await assert.rejects(fixture.pay());
    assert.equal(fixture.calls.length, 1);
    assert.equal(await fixture.attempt.hasSubscriptionPromoAttempt(price.productId, phone), true);
  }
});

function node(file: string, msg: Record<string, unknown>, enabled = true) {
  return new Function('msg', 'global', 'env', readFileSync(`scripts/nodered_games_nodes/${file}.js`, 'utf8'))(msg,
    { get: (key: string) => ({ summer_subscription_ab_leto_20260903_release_enabled: true,
      summer_subscription_friendship_promo_enabled: enabled } as Record<string, unknown>)[key] }, { get: () => undefined });
}
const friendshipQuote = { productId: FRIENDSHIP_MONTHLY_PRODUCT_ID, sumMinor: 980000, discountMinor: 98000, toPayMinor: 882000 };
const router = 'fn_tournament_subscription_purchase_router';
function promoContext() {
  return { action: 'purchase', step: 'load_products', token: 'synthetic', counterKey: 'friendship', planKey: 'friendship',
    productId: FRIENDSHIP_MONTHLY_PRODUCT_ID, productCostMinor: 980000, clientPhone: phone, paymentRef: 'synthetic',
    promoCode: 'SYNTHETIC', expectedPromoQuote: friendshipQuote, reservationMinutes: 30 };
}
function loadPromo() {
  return node(router, { statusCode: 200, payload: [{ id: FRIENDSHIP_MONTHLY_PRODUCT_ID, name: 'Лето.Падел.Дружба', cost: 980000, type: 'SUBSCRIPTION' }],
    _summerSubscriptionCtx: promoContext() })[0];
}

test('Friendship gateway scopes promo requests to the exact monthly product and capability', () => {
  const prepare = 'fn_tournament_subscription_purchase_prepare';
  const body = { counterKey: 'friendship', clientPhone: phone, promoCode: ' SYNTHETIC ', expectedPromoQuote: friendshipQuote };
  const valid = node(prepare, { payload: body });
  assert.equal(valid[0]._summerSubscriptionCtx.promoCode, 'SYNTHETIC');
  for (const patch of [{ expectedPromoQuote: { ...friendshipQuote, productId: 'wrong' } },
    { expectedPromoQuote: { ...friendshipQuote, toPayMinor: 1 } }, { promoCode: '' }, { promoCode: 'x'.repeat(101) },
    { counterKey: 'sport' }, { counterKey: 'network_friendship' }]) {
    const out = node(prepare, { payload: { ...body, ...patch } });
    assert.equal(out[0], null); assert.ok(out[1].statusCode >= 400);
  }
  assert.equal(node(prepare, { payload: body }, false)[1].statusCode, 503);
});

test('provider preview precedes create; only the provider sets the promo discount', () => {
  const preview = loadPromo();
  assert.equal(preview.url, 'https://api.vivacrm.ru/api/v1/transactions/preview');
  assert.equal(preview.payload.promoCode, 'SYNTHETIC');
  assert.equal('discount' in preview.payload.products[0], false);
  assert.equal(preview.payload.products[0].customAmount, null);
  const create = node(router, { ...preview, statusCode: 200, payload: { sum: 980000, discount: 98000, toPay: 882000 } })[0];
  assert.equal(create.url, 'https://api.vivacrm.ru/api/v1/transactions');
  assert.equal(create._summerSubscriptionCtx.priceMinor, 882000);
  assert.equal(create._summerSubscriptionCtx.discountMinor, 98000);
});

test('missing or drifting provider preview and disabled capability stop before create', () => {
  for (const payload of [{}, { sum: 980000, discount: 0, toPay: 980000 }, { sum: 980000, discount: 98000, toPay: 881999 }]) {
    const out = node(router, { ...loadPromo(), statusCode: 200, payload });
    assert.equal(out[0], null); assert.equal(out[2].statusCode, 409);
  }
  const out = node(router, { ...loadPromo(), statusCode: 200, payload: { sum: 980000, discount: 98000, toPay: 882000 } }, false);
  assert.equal(out[0], null);
});

test('ambiguous promo create has no payment-method fallback and wrong amounts never return a bank link', () => {
  for (const [statusCode, payload] of [[500, { message: 'Payment method not implemented' }],
    [201, { id: 'synthetic', toPay: 980000, paymentUrl: 'https://bank.example/pay' }], [201, {}]] as const) {
    const out = node(router, { statusCode, payload, _summerSubscriptionCtx: { ...promoContext(), step: 'create_transaction' } });
    assert.equal(out[0], null); assert.equal(out[2].statusCode, 502);
  }
});


test('only an explicit reference-bound no-create receipt releases a rejected Friendship attempt', async () => {
  const fixture = payment({ friendship: true, gatewayError: { message: 'Цена изменилась',
    raw: { promoAttempt: { schemaVersion: 1, providerAttempted: false, paymentRef: 'synthetic-ref' } } } });
  await assert.rejects(fixture.pay(), /Цена изменилась/);
  assert.equal(Object.keys(fixture.storage).length, 0);
  await assert.rejects(fixture.pay(), /Цена изменилась/);
  assert.equal(fixture.calls.length, 2);
  for (const promoAttempt of [{ schemaVersion: 1, providerAttempted: true, paymentRef: 'synthetic-ref' },
    { schemaVersion: 1, providerAttempted: false, paymentRef: 'another-ref' }]) {
    const ambiguous = payment({ friendship: true, gatewayError: { message: 'failure', raw: { promoAttempt } } });
    await assert.rejects(ambiguous.pay()); await assert.rejects(ambiguous.pay());
    assert.equal(ambiguous.calls.length, 1);
  }
});

test('gateway no-create receipts disappear once the provider transaction has been attempted', () => {
  const rejected = node(router, { ...loadPromo(), statusCode: 200, payload: {} });
  assert.equal(rejected[2].payload.promoAttempt.providerAttempted, false);
  const create = node(router, { ...loadPromo(), statusCode: 200, payload: { sum: 980000, discount: 98000, toPay: 882000 } })[0];
  assert.equal(create._summerSubscriptionCtx.promoProviderAttempted, true);
  const ambiguous = node(router, { ...create, statusCode: 500, payload: {} });
  assert.equal('promoAttempt' in ambiguous[2].payload, false);
});
