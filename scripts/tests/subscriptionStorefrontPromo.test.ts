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
  const locks = new Set<string>();
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
    navigator: { locks: { request: async (key: string, _options: unknown, fn: (lock: unknown) => Promise<unknown>) => {
      if (locks.has(key)) return fn(null);
      locks.add(key);
      try { return await fn({}); } finally { locks.delete(key); }
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


const regularPayment = loadModule<typeof import('../../src/components/subscription-storefront/payment')>('components/subscription-storefront/payment.ts', {
  ...catalog,
  ATLANTY_MONTHLY_PRODUCT_ID: '3907d127-a6b0-419e-a933-4a2857f26356',
  ATLANTY_ANNUAL_PRODUCT_ID: '',
  TOPOCRATY_PRODUCT_ID: '14692232-12be-4218-9fa1-2d5b79b62035',
  apiBuySubscroption: () => {}, apiConfirmTournamentSubscriptionPurchase: () => {},
  apiCreateTournamentSubscriptionPurchase: () => {}, apiFetchProfile: () => {}, appendCurrentAuthModeToNavigableUrl: (url: URL) => url,
});
function zeroFixture() {
  const f = paymentFixture();
  let result: any = { data: { paymentUrl: 'https://bank.example/zero' }, error: null };
  let confirmation: any = { data: { paid: true, failed: false, status: 'PAID' } };
  let price = 980000;
  let availability = true;
  let broken = false;
  let storageFails = false;
  const writes: any[] = [], confirms: any[] = [];
  Object.assign(f.globals.window.location, { origin: 'https://padlhub.ru', pathname: '/spb2', href: 'https://padlhub.ru/spb2?authMode=viva&code=private&summerPaymentRef=foreign&utm_source=tilda#old' });
  Object.assign(f.globals.window, { crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' } });
  const setItem = f.globals.window.localStorage.setItem;
  f.globals.window.localStorage.setItem = (key, value) => { if (storageFails) throw new Error('storage disabled'); setItem(key, value); };
  const adapter = loadModule<typeof import('../../src/components/subscription-storefront/zeroCheckoutPayment')>('components/subscription-storefront/zeroCheckoutPayment.ts', {
    ...regularPayment, ...promo, ...f.adapter,
    ATLANTY_MONTHLY_PRICE_MINOR: 680000,
    TOPOCRATY_MONTHLY_PRICE_MINOR: 680000,
    canContinue: (row: any) => row.canPurchase && row.bindingReady && row.priceMinor > 0 && row.remainingCount > 0,
    appendCurrentAuthModeToNavigableUrl: (url: URL) => { url.searchParams.set('authMode', 'viva'); return url; },
    getServ2Origin: () => 'https://fixture.invalid',
    request: async (path: string) => ({ data: [{ counterKey: new URL(path, 'https://fixture.invalid').searchParams.get('counterKey'), priceMinor: price, canPurchase: availability, bindingReady: true, remainingCount: 2, totalLimit: 10, unlimited: false }] }),
    apiBuySubscroption: async (...args: any[]) => { writes.push(args); if (broken) throw new Error('timeout'); return result; },
    apiCreateTournamentSubscriptionPurchase: async (...args: any[]) => { writes.push(args); if (broken) throw new Error('timeout'); return result; },
    apiConfirmTournamentSubscriptionPurchase: async (...args: any[]) => { confirms.push(args); return confirmation; },
  }, { ...f.globals, setTimeout, clearTimeout });
  return { ...f, adapter, writes, confirms, setResult: (value: any) => { result = value; },
    setConfirmation: (value: any) => { confirmation = value; }, setPrice: (value: number) => { price = value; },
    unavailable: () => { availability = false; }, breakTransport: () => { broken = true; }, failWrite: () => { storageFails = true; } };
}

test('Zero Block resolves exact monthly, annual and promo products; rejects arbitrary IDs', () => {
  const f = zeroFixture();
  assert.equal(f.adapter.resolveZeroOffer('friendship-year')?.target?.counterKey, 'network_friendship');
  assert.equal(f.adapter.resolveZeroOffer('friendship-year')?.billingOptionId, 'annual');
  assert.equal(f.adapter.resolveZeroOffer('energy5')?.period, '60 дней, 5 занятий');
  for (const key of ['constructor', '__proto__', 'sport-promo', 'unknown', 'atlanty-year']) assert.equal(f.adapter.resolveZeroOffer(key), null);
});

test('Zero Block sells the Atlanty club offer from the catalogue price, never the friendship counter', async () => {
  const f = zeroFixture();
  const offer = f.adapter.resolveZeroOffer('atlanty');
  assert.equal(offer?.label, 'ДРУЖБА.АТЛАНТЫ');
  assert.equal(offer?.period, '30 дней');
  assert.equal(offer?.planId, 'atlanty');
  assert.equal(offer?.billingOptionId, 'monthly');
  assert.equal(offer?.target?.counterKey, 'atlanty');
  assert.equal(offer?.target?.directProductId, '3907d127-a6b0-419e-a933-4a2857f26356');
  // No status request: the club product has no counter and the price is the catalogue price.
  assert.equal(await f.adapter.loadZeroOfferPrice('atlanty'), 680000);
  assert.equal(f.writes.length, 0);

  await f.adapter.createZeroPayment('atlanty', fixturePhone, 680000, () => true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], '3907d127-a6b0-419e-a933-4a2857f26356');
  assert.equal(f.writes[0][2].retries, 0);
});

test('Zero Block sells the Topocrats club subscription by its operator-issued id, without a counter request', async () => {
  const f = zeroFixture();
  const offer = f.adapter.resolveZeroOffer('topocraty');
  assert.equal(offer?.label, 'ДРУЖБА.ТОПОКРАТЫ');
  assert.equal(offer?.period, '30 дней');
  assert.equal(offer?.planId, 'topocraty');
  assert.equal(offer?.billingOptionId, 'monthly');
  assert.equal(offer?.target?.counterKey, 'topocraty');
  assert.equal(offer?.target?.directProductId, '14692232-12be-4218-9fa1-2d5b79b62035');
  assert.equal(await f.adapter.loadZeroOfferPrice('topocraty'), 680000);
  assert.equal(f.writes.length, 0);

  await f.adapter.createZeroPayment('topocraty', fixturePhone, 680000, () => true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0][0], '14692232-12be-4218-9fa1-2d5b79b62035');
  assert.equal(f.writes[0][2].retries, 0);
});

test('Zero Block rejects a changed Topocrats price instead of charging it', async () => {
  const f = zeroFixture();
  await assert.rejects(f.adapter.createZeroPayment('topocraty', fixturePhone, 490000, () => true));
  assert.equal(f.writes.length, 0);
});

test('Zero Block persists ref before one counter POST; reopening and concurrent clicks never create again', async () => {
  const f = zeroFixture();
  const results = await Promise.allSettled([1, 2].map(() => f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true)));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(f.writes.length, 1);
  const body = f.writes[0][0];
  assert.equal(body.counterKey, 'friendship');
  const stored = [...f.stored.values()][0];
  assert.equal(JSON.parse(stored).paymentRef, body.paymentRef);
  assert.ok(!stored.includes(fixturePhone));
  assert.ok(!stored.includes('bank.example'));
  await assert.rejects(f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true));
  assert.equal(f.writes.length, 1);
});

test('Zero Block return URL keeps landing path and safe attribution, strips unrelated auth/payment parameters', () => {
  const url = new URL(zeroFixture().adapter.buildZeroReturnUrl('friendship-year'));
  assert.equal(url.pathname, '/spb2');
  assert.equal(url.searchParams.get('phCheckoutReturn'), 'friendship-year');
  assert.equal(url.searchParams.get('authMode'), 'viva');
  assert.equal(url.searchParams.get('utm_source'), 'tilda');
  assert.equal(url.searchParams.has('code'), false);
  assert.equal(url.searchParams.has('summerPaymentRef'), false);
  assert.equal(url.hash, '');
});

test('Zero Block does not create after closing, unavailable inventory, changed price, missing locks/storage', async () => {
  for (const setup of [
    (f: ReturnType<typeof zeroFixture>) => f.unavailable(),
    (f: ReturnType<typeof zeroFixture>) => f.setPrice(1000000),
    (f: ReturnType<typeof zeroFixture>) => f.failWrite(),
    (f: ReturnType<typeof zeroFixture>) => Object.assign(f.globals.navigator, { locks: undefined }),
  ]) {
    const f = zeroFixture(); setup(f);
    await assert.rejects(f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true));
    assert.equal(f.writes.length, 0);
  }
  const f = zeroFixture();
  await assert.rejects(f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => false));
  assert.equal(f.writes.length, 0); assert.equal(f.stored.size, 0);
});

test('Zero Block direct purchases disable retries and retain unknown outcomes, including malformed/free responses', async () => {
  for (const data of [{}, { toPay: 0 }, { paid: true, toPay: 100 }, { paymentUrl: 'javascript:alert(1)' }, { paymentUrl: 'http://bank.example/pay' }, { paymentUrl: ['https://user:pass', 'bank.example/pay'].join('@') }]) {
    const f = zeroFixture(); f.setResult({ data });
    await assert.rejects(f.adapter.createZeroPayment('academy', fixturePhone, 980000, () => true));
    assert.equal(f.writes[0][2].retries, 0);
    await assert.rejects(f.adapter.createZeroPayment('academy', fixturePhone, 980000, () => true));
    assert.equal(f.writes.length, 1);
    assert.equal(f.adapter.hasZeroAttempt('academy'), true);
  }
  const f = zeroFixture(); f.breakTransport();
  await assert.rejects(f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true));
  assert.equal(f.adapter.hasZeroAttempt('friendship'), true);
});

test('Zero Block confirmation uses only stored exact ref; missing local evidence and direct plans do not confirm', async () => {
  const f = zeroFixture();
  await f.adapter.confirmZeroPayment('friendship');
  assert.equal(f.confirms.length, 0);
  await f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true);
  f.setConfirmation({ data: { status: 'FAILED', failed: true, paid: false, archived: true } });
  assert.equal((await f.adapter.confirmZeroPayment('friendship')).status, 'pending');
  assert.equal(f.adapter.hasZeroAttempt('friendship'), true);
  assert.equal(f.confirms[0][0], f.writes[0][0].paymentRef);
  f.setConfirmation({ data: { status: 'PAID', paid: true, failed: false } });
  assert.equal((await f.adapter.confirmZeroPayment('friendship')).status, 'paid');
  assert.equal(f.adapter.hasZeroAttempt('friendship'), true);
  await f.adapter.confirmZeroPayment('academy');
  assert.equal(f.confirms.length, 2);
});

test('Zero Block empty counter create requires confirmation, never interprets missing price as success', async () => {
  const f = zeroFixture(); f.setResult({ data: {} }); f.setConfirmation({ data: null, error: { status: 503 } });
  const result = await f.adapter.createZeroPayment('friendship', fixturePhone, 980000, () => true);
  assert.equal(result.status, 'settled');
  assert.match('message' in result ? result.message : '', /уже отправлена/);
  assert.equal(f.confirms.length, 1);
  assert.equal(JSON.parse([...f.stored.values()][0]).state, 'pending');
});

test('Zero Block promo uses the existing product/guard and returns to the landing page', async () => {
  const f = zeroFixture();
  const result = await f.adapter.createZeroPayment('ra-promo', fixturePhone, 1190000, () => true);
  assert.equal(result.status, 'redirect');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].productId, promo.resolveStorefrontPromo('ra-promo').productId);
  assert.equal(new URL(String(f.calls[0].options.successUrl)).searchParams.get('phCheckoutReturn'), 'ra-promo');
  assert.equal(f.stored.size, 2);
});


test('Zero Block rejects incomplete raw flags, duplicate/wrong counters and invalid inventory', () => {
  const f = zeroFixture();
  const valid = { counterKey: 'friendship', priceMinor: 980000, canPurchase: true, bindingReady: true, unlimited: false, remainingCount: 1, totalLimit: 10 };
  assert.equal(f.adapter.parseZeroPrice({ data: { plans: [valid] } }, 'friendship'), 980000);
  for (const row of [{ ...valid, canPurchase: undefined }, { ...valid, bindingReady: undefined }, { ...valid, unlimited: undefined }, { ...valid, remainingCount: 11 }, { ...valid, priceMinor: null }, { ...valid, counterKey: 'network_friendship' }]) {
    assert.throws(() => f.adapter.parseZeroPrice([row], 'friendship'));
  }
  assert.throws(() => f.adapter.parseZeroPrice([valid, valid], 'friendship'));
  assert.throws(() => f.adapter.parseZeroPrice({ ok: false, plans: [valid] }, 'friendship'));
});

test('Zero Block bounded wait rejects a stuck operation and ignores its late result', async () => {
  const f = zeroFixture();
  let finish!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finish = resolve; });
  await assert.rejects(f.adapter.withZeroDeadline(pending, 5), /Время ожидания/);
  finish('late bank redirect');
  assert.equal(await f.adapter.withZeroDeadline(Promise.resolve('ready'), 20), 'ready');
});


test('Zero Block loader rejects preloaded wrong channel and legacy runtime; compatible channel resumes UI only', async () => {
  const source = readFileSync(new URL('../../docs/zero-block/padlhub-zero-block.js', import.meta.url), 'utf8');
  for (const checkoutChannel of ['dev', 'prod', undefined]) {
    let resumed = 0;
    const document = { querySelectorAll: () => [], dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {}, hidden: false };
    const window: any = { document, location: { href: 'https://padlhub.ru/spb2' }, setTimeout: () => 1, clearTimeout: () => {},
      LKWidgetSubscriptionStorefront: { checkoutVersion: 1, checkoutChannel, openCheckout: () => { throw new Error('No auto-purchase'); }, resumeCheckout: () => { resumed++; }, closeCheckout: () => true } };
    vm.runInNewContext(source, { window, document, URL, URLSearchParams, AbortController, CustomEvent: class {}, setTimeout, clearTimeout });
    const instance = window.PadlHubZeroBlock.init({ offerKeys: ['ra-promo'], channel: 'prod' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(instance.getState('ra-promo').checkoutReady, checkoutChannel === 'prod');
    assert.equal(resumed, checkoutChannel === 'prod' ? 1 : 0);
    assert.equal(instance.destroy(), true);
  }
});
