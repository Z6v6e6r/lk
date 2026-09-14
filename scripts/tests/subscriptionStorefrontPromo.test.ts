import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function loadModule<T>(file: string, stubs: Record<string, unknown> = {}, globals: Record<string, unknown> = {}): T {
  const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\n/gm, '');
  const compiled = ts.transpileModule(`const { ${Object.keys(stubs).join(', ')} } = __stubs;\n${source}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const context = { exports: {}, __stubs: stubs, URL, URLSearchParams, ...globals };
  vm.runInNewContext(compiled, context);
  return context.exports as T;
}

const catalog = loadModule<typeof import('../../src/utils/tournamentSubscriptionCatalog')>('utils/tournamentSubscriptionCatalog.ts');
const promo = loadModule<typeof import('../../src/components/subscription-storefront/promo')>('components/subscription-storefront/promo.ts', catalog);
const fixturePhone = `+${'7'}${'900000000'}`;

function paymentFixture() {
  const calls: { productId: string; phone: string; options: Record<string, unknown> }[] = [];
  const stored = new Map<string, string>();
  let result: unknown = { data: { paymentUrl: 'https://bank.example/promo', toPay: 490000 }, error: null };
  let busy = false;
  let storageFails = false;
  let transportThrows = false;
  const globals = {
    window: {
      location: { href: 'https://padlhub.ru/sub_hab?offer=friendship-promo&authMode=viva&utm_source=piter' },
      localStorage: {
        getItem: (key: string) => { if (storageFails) throw new Error('storage disabled'); return stored.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (storageFails) throw new Error('storage disabled'); stored.set(key, value); },
      },
    },
    navigator: { locks: { request: async (_key: string, _options: unknown, fn: (lock: unknown) => Promise<unknown>) => {
      if (busy) return fn(null);
      busy = true;
      try { return await fn({}); } finally { busy = false; }
    } } },
  };
  const adapter = loadModule<typeof import('../../src/components/subscription-storefront/promoPayment')>('components/subscription-storefront/promoPayment.ts', {
    ...promo,
    StorefrontPaymentError: Error,
    appendCurrentAuthModeToNavigableUrl: (url: URL) => url,
    apiBuySubscroption: async (productId: string, phone: string, options: Record<string, unknown>) => {
      calls.push({ productId, phone, options });
      if (transportThrows) throw new Error('timeout');
      return result;
    },
  }, globals);
  return { adapter, calls, stored, globals,
    setResult: (next: unknown) => { result = next; },
    breakStorage: () => { storageFails = true; },
    breakTransport: () => { transportThrows = true; },
  };
}

test('only explicit supported promo links select promo mode; malformed links never fall back', () => {
  assert.equal(promo.readStorefrontPromoKey('?utm_source=piter'), null);
  assert.equal(promo.readStorefrontPromoKey('?offerKey=FRIENDSHIP-PROMO'), 'friendship-promo');
  assert.equal(promo.readStorefrontPromoKey('?offer=ra-promo&offerKey=ra-promo'), 'ra-promo');
  for (const query of ['?offer=', '?offer&offerKey=friendship-promo', '?offer=ra-promo&offer=friendship-promo']) {
    assert.equal(promo.readStorefrontPromoKey(query), '');
  }
  for (const key of ['', 'sport-promo', 'energy5-promo', '__proto__', 'constructor', 'unknown']) {
    assert.equal(promo.resolveStorefrontPromo(key), null);
  }
});

test('promo cards use the existing promo products and exact display prices, never regular products', async () => {
  for (const [key, productId, priceMinor, planKey] of [
    ['friendship-promo', 'c079dc82-c716-4f0e-b9ad-6aab62fb789e', 490000, 'friendship'],
    ['academy-promo', '6bda152b-0a9c-4308-82d0-3cd4e6aa680d', 1190000, 'academy'],
    ['ra-promo', '3b4806f1-6f9a-46df-a7d7-45075b4e7274', 1190000, 'ra'],
  ] as const) {
    const offer = promo.resolveStorefrontPromo(key);
    assert.equal(offer.priceMinor, priceMinor);
    assert.equal(offer.productId, productId);
    assert.equal(offer.planKey, planKey);
    assert.equal(Number(offer.priceLabel.replace(/\D/g, '')) * 100, priceMinor);
    const f = paymentFixture();
    assert.equal((await f.adapter.createStorefrontPromoPayment(key, fixturePhone)).status, 'redirect');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].productId, productId);
    assert.equal(f.calls[0].options.retries, 0);
    assert.equal(f.stored.size, 1);
    assert.deepEqual([...f.stored.values()], ['pending']);
    assert.ok(!JSON.stringify([...f.stored]).includes(fixturePhone));
  }
});

test('bank return preserves offer, auth, attribution and cabinet without a fabricated summer ref', async () => {
  const href = 'https://padlhub.ru/sub_hab?offerKey=ra-promo&authMode=legacy&cabinetUrl=%2Flk_new&qr=TR-001&utm_source=piter&autoPurchase=1&summerPaymentRef=old#details';
  const url = new URL(promo.buildPromoReturnUrl(href));
  assert.equal(url.pathname, '/sub_hab');
  for (const [key, value] of [['offerKey', 'ra-promo'], ['authMode', 'legacy'], ['cabinetUrl', '/lk_new'], ['qr', 'TR-001'], ['utm_source', 'piter'], ['autoPurchase', '0'], ['promoPaymentReturn', '1']]) {
    assert.equal(url.searchParams.get(key), value);
  }
  assert.equal(url.searchParams.has('summerPaymentRef'), false);
  assert.equal(url.hash, '#details');
  const f = paymentFixture();
  await f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone);
  assert.equal(f.calls[0].options.successUrl, f.calls[0].options.failUrl);
  assert.equal(new URL(String(f.calls[0].options.successUrl)).searchParams.has('summerPaymentRef'), false);
});

test('cabinet links reject external origins, credentials and executable URLs and preserve auth mode', () => {
  const href = 'https://padlhub.ru/sub_hab?offer=friendship-promo&authMode=viva';
  for (const candidate of ['https://attacker.example/login', 'javascript:alert(1)', '//attacker.example', ['https://user:password', 'padlhub.ru/lk_new'].join('@'), 'http://padlhub.ru/lk_new']) {
    assert.equal(promo.resolvePromoCabinetUrl(href, candidate), 'https://padlhub.ru/lk_new?authMode=viva');
  }
  assert.equal(promo.resolvePromoCabinetUrl(href, '/lk_new?tab=subscriptions'), 'https://padlhub.ru/lk_new?tab=subscriptions&authMode=viva');
});

test('invalid selection, missing phone, unavailable storage or locks cannot create a payment', async () => {
  const f = paymentFixture();
  for (const key of ['friendship', 'sport-promo', 'unknown']) await assert.rejects(f.adapter.createStorefrontPromoPayment(key, fixturePhone));
  await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', ''));
  f.breakStorage();
  await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
  assert.equal(f.calls.length, 0);
  const noLocks = paymentFixture();
  Object.assign(noLocks.globals.navigator, { locks: undefined });
  await assert.rejects(noLocks.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
  assert.equal(noLocks.calls.length, 0);
});

test('network, provider, malformed and unsafe redirect responses retain the attempt and never retry', async () => {
  for (const result of [
    { error: { status: 500 }, data: null }, { error: { status: 418 }, data: null },
    { data: {} }, { data: { toPay: null } }, { data: { toPay: -1 } },
    { data: { toPay: NaN } }, { data: { toPay: 490000 } },
    { data: { paid: true, toPay: 490000 } }, { data: { paid: false, toPay: 0 } },
    { data: { paymentUrl: 'javascript:alert(1)' } }, { data: { paymentUrl: 'http://bank.example/pay' } },
    { data: { paymentUrl: ['https://user:pass', 'bank.example/pay'].join('@') } },
  ]) {
    const f = paymentFixture(); f.setResult(result);
    await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
    await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
    assert.equal(f.calls.length, 1);
    assert.equal(f.adapter.hasPromoPaymentAttempt('friendship-promo'), true);
  }
  const f = paymentFixture(); f.breakTransport();
  await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
  assert.equal(f.calls.length, 1);
  assert.equal(f.adapter.hasPromoPaymentAttempt('friendship-promo'), true);
});

test('simultaneous tabs and reloads cannot issue another create for the same offer', async () => {
  const f = paymentFixture();
  const outcomes = await Promise.allSettled([
    f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone),
    f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone),
  ]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
  assert.equal(f.calls.length, 1);
});

test('only explicit payment evidence can settle; settled markers also block accidental repeats', async () => {
  for (const data of [{ paid: true }, { toPay: 0 }, { paid: true, toPay: 0 }]) {
    const f = paymentFixture(); f.setResult({ data });
    assert.equal((await f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone)).status, 'settled');
    assert.deepEqual([...f.stored.values()], ['settled']);
    await assert.rejects(f.adapter.createStorefrontPromoPayment('friendship-promo', fixturePhone));
    assert.equal(f.calls.length, 1);
  }
});

test('shared API preserves legacy retry behavior and honors the promo no-retry option', async () => {
  const source = readFileSync(new URL('../../src/utils/apiClient.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function apiBuySubscroption(');
  const end = source.indexOf('const TOURNAMENT_SUBSCRIPTION_PLAN_TYPES', start);
  const calls: [string, { retries: number; auth: boolean; body: string }][] = [];
  const context = { exports: {} as Pick<typeof import('../../src/utils/apiClient'), 'apiBuySubscroption'>, API_BASE: 'https://fixture.invalid', TENANT_KEY: 'fixture', SUCCESS_URL: '/ok', FAIL_URL: '/fail',
    request: async (...args: [string, { retries: number; auth: boolean; body: string }]) => { calls.push(args); return {}; },
  };
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  await context.exports.apiBuySubscroption('product', fixturePhone);
  await context.exports.apiBuySubscroption('product', fixturePhone, { retries: 0 });
  assert.equal(calls[0][1].retries, 1);
  assert.equal(calls[1][1].retries, 0);
  assert.equal(calls[1][1].auth, true);
  assert.equal(JSON.parse(calls[1][1].body).products[0].id, 'product');
});
