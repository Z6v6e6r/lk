import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

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

function payment(options: { fresh?: typeof price; result?: unknown; reject?: boolean; canProceed?: boolean; paidStatus?: boolean; quote?: typeof price } = {}) {
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
  return { calls, storage, attempt, pay: () => exports.createSubscriptionPromoPayment(options.quote ?? price, phone, () => options.canProceed !== false) };
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
