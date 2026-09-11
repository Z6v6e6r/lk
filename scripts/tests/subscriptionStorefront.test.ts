import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { billingFromStatus, canContinue, friendshipBillingOptions, scopedStorefrontStatuses } from '../../src/components/subscription-storefront/catalog.ts';

const available = { counterKey: 'ra', priceMinor: 2380000, canPurchase: true, bindingReady: true, unlimited: false, remainingCount: 12, totalLimit: 100 };

/** Synthetic fixture number, built at runtime to keep source free of phone literals. */
const FIXTURE_PHONE = `+${'7'}${'900000000'}`;

interface PaymentAdapterCalls {
  created: { counterKey: string | null; planType: string | null }[];
  bought: { productId: string; phone: string }[];
}

/** Removes top-level import declarations before transpiling the module for the VM. */
function stripImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '');
}

/** Loads the payment adapter in a VM with stubbed LK1 API calls. */
function loadPaymentAdapter(): {
  resolveStorefrontBillingTarget: (planId: string, optionId: string) => unknown;
  createStorefrontSubscriptionPayment: (params: { planId: string; billingOptionId: string; phone: string }) => Promise<unknown>;
  calls: PaymentAdapterCalls;
} {
  const source = stripImports(readFileSync(
    new URL('../../src/components/subscription-storefront/payment.ts', import.meta.url),
    'utf8',
  ));
  const withStubs = `const { apiBuySubscroption, apiConfirmTournamentSubscriptionPurchase, apiCreateTournamentSubscriptionPurchase, apiFetchProfile, appendCurrentAuthModeToNavigableUrl, resolveTournamentSubscriptionDirectProductId } = __stubs;\n${source}`;
  const compiled = ts.transpileModule(withStubs, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const calls: PaymentAdapterCalls = { created: [], bought: [] };
  const exported: Record<string, (...args: never[]) => unknown> = {};
  const stubs = {
    apiBuySubscroption: async (productId: string, phone: string) => {
      calls.bought.push({ productId, phone });
      return { data: { toPay: 2380000, paymentUrl: 'https://bank.example/pay/direct' }, error: null, status: 200 };
    },
    apiCreateTournamentSubscriptionPurchase: async (params: { counterKey?: string | null; planType?: string | null }) => {
      calls.created.push({ counterKey: params.counterKey ?? null, planType: params.planType ?? null });
      return {
        data: { paymentUrl: 'https://bank.example/pay/counter', paymentRef: params.counterKey ?? null, counterKey: params.counterKey ?? null, toPayMinor: 2380000 },
        error: null,
        status: 200,
      };
    },
    apiConfirmTournamentSubscriptionPurchase: async () => ({ data: null, error: { status: 500, message: 'not used' }, status: 500 }),
    apiFetchProfile: async () => ({ data: { phone: FIXTURE_PHONE }, error: null, status: 200 }),
    appendCurrentAuthModeToNavigableUrl: (input: URL) => input,
    resolveTournamentSubscriptionDirectProductId: (value: string) => (
      value === 'academy' ? '9eb8a7a4-c195-492a-95e4-3fb82899ac10'
        : value === 'ra' ? 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759'
          : null
    ),
  };
  const context = {
    exports: exported,
    __stubs: stubs,
    console,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    window: {
      location: {
        href: 'https://padlhub.ru/subsription',
        search: '',
        pathname: '/subsription',
        hash: '',
        origin: 'https://padlhub.ru',
      },
      history: { state: null, replaceState: () => {} },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
    document: { title: 'Подписки' },
  };
  vm.runInNewContext(compiled, context);
  return {
    calls,
    resolveStorefrontBillingTarget: exported.resolveStorefrontBillingTarget as never,
    createStorefrontSubscriptionPayment: exported.createStorefrontSubscriptionPayment as never,
  };
}

test('uses API price and inventory; no invented price for missing/invalid data', () => {
  assert.equal(billingFromStatus(available)[0].priceMinor, 2380000);
  assert.equal(billingFromStatus(available)[0].progress?.current, 12);
  for (const priceMinor of [null, NaN, -1, 0, 12.5]) assert.deepEqual(billingFromStatus({ ...available, priceMinor }), []);
});
test('blocks unavailable, unbound and stale inventory', () => {
  assert.equal(canContinue(available), true);
  assert.equal(canContinue(available, true), false);
  assert.equal(canContinue({ ...available, canPurchase: false }), false);
  assert.equal(canContinue({ ...available, bindingReady: false }), false);
  assert.equal(canContinue({ ...available, remainingCount: 0 }), false);
  assert.equal(canContinue({ ...available, remainingCount: 0, unlimited: true }), true);
});
test('storefront CTA creates the payment in the widget instead of navigating to /ab_leto', () => {
  const catalogSource = readFileSync(new URL('../../src/components/subscription-storefront/catalog.ts', import.meta.url), 'utf8');
  const pageSource = readFileSync(new URL('../../src/components/subscription-storefront/SubscriptionPage.tsx', import.meta.url), 'utf8');
  const paymentSource = readFileSync(new URL('../../src/components/subscription-storefront/payment.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(catalogSource, /ab_leto|autoPurchase|subscriptionCheckoutUrl/);
  assert.doesNotMatch(pageSource, /ab_leto|subscriptionCheckoutUrl/);
  assert.match(pageSource, /createStorefrontSubscriptionPayment/);
  assert.match(pageSource, /<AuthForm onLogin=/);
  assert.doesNotMatch(pageSource, /StorefrontLogin/);
  assert.match(paymentSource, /apiCreateTournamentSubscriptionPurchase/);
  assert.match(paymentSource, /apiBuySubscroption/);
  assert.match(pageSource, /window\.location\.href = outcome\.paymentUrl/);
});

test('storefront ships the cabinet auth styles it needs for the shared AuthForm', () => {
  const myAppSource = readFileSync(new URL('../../src/MyApp.css', import.meta.url), 'utf8');
  const authBlock = myAppSource.slice(
    myAppSource.indexOf('/* ─── AUTH ─── */'),
    myAppSource.indexOf('/* ─── CABINET HEADER ─── */'),
  ).trimEnd();
  const authSource = readFileSync(new URL('../../src/components/subscription-storefront/storefront-auth.css', import.meta.url), 'utf8');
  // The auth rules must stay a verbatim copy of MyApp.css, otherwise the widget
  // and /ab_leto would render the same AuthForm differently.
  for (const selector of ['.auth-wrapper', '.auth-card', '.auth-title', '.auth-btn', '.auth-input', '.auth-oauth-btn', '.auth-consents', '.phone-input', '.resend-row']) {
    assert.ok(authBlock.includes(selector), `MyApp.css lost ${selector}`);
    assert.ok(authSource.includes(selector), `storefront-auth.css lost ${selector}`);
  }
  assert.doesNotMatch(authSource, /@media/);
  const overlaySource = readFileSync(new URL('../../src/components/subscription-storefront/storefront-auth-overlay.css', import.meta.url), 'utf8');
  for (const selector of ['.subscription-auth-overlay', '.subscription-auth-backdrop', '.subscription-auth-block', '.subscription-auth-title', '.subscription-auth-caption']) {
    assert.ok(overlaySource.includes(selector), `storefront-auth-overlay.css lost ${selector}`);
  }
  assert.match(overlaySource, /\.subscription-auth-block \.auth-wrapper/);
});
test('T123 embeds a valid isolated loader using its own release manifests and widget lifecycle', () => {
  const html = readFileSync(new URL('../../docs/tilda-subscription-storefront.html', import.meta.url), 'utf8');
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]);
  assert.match(html, /\/lk\/subscription-storefront\/release-dev\.json/);
  assert.match(html, /LKWidgetSubscriptionStorefront\.unmount/);
  assert.match(html, /targetId: "padlhub-subscriptions"/);
  assert.doesNotMatch(html, /autoPurchase|productId/);
});

test('LK1 status helper forwards cancellation and preserves legacy calls', async () => {
  const source = readFileSync(new URL('../../src/utils/apiClient.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function apiFetchTournamentSubscriptionStatus(');
  const end = source.indexOf('export async function apiCreateTournamentSubscriptionPurchase(', start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let received: AbortSignal | undefined;
  const exported: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  vm.runInNewContext(compiled, { exports: exported, URLSearchParams,
    getServ2Origin: () => 'https://fixture.invalid',
    normalizeTournamentSubscriptionStatuses: (value: unknown) => value,
    request: async (_path: string, options: { signal?: AbortSignal }) => {
      received = options.signal;
      return { data: [], error: null, status: 200 };
    },
  });
  const controller = new AbortController();
  await exported.apiFetchTournamentSubscriptionStatus({}, { signal: controller.signal });
  assert.equal(received, controller.signal);
  controller.abort();
  assert.equal(received?.aborted, true);
  await exported.apiFetchTournamentSubscriptionStatus();
  assert.equal(received, undefined);
});


test('friendship variants retain independent prices, inventory and availability', () => {
  const monthly = { ...available, counterKey: 'friendship', priceMinor: 980000 };
  const annual = { ...available, counterKey: 'network_friendship', priceMinor: 5680000, remainingCount: 10, totalLimit: 10, canPurchase: false };
  const options = friendshipBillingOptions([monthly, annual]);
  assert.deepEqual(options.map(option => option.id), ['monthly', 'monthly-two-hours', 'annual']);
  assert.deepEqual(options.map(option => option.priceMinor), [980000, 1980000, 5680000]);
  assert.deepEqual(options.map(option => option.ctaDisabled), [false, true, true]);
  assert.equal(options[1].progress, undefined);
  assert.equal(options[1].ctaLabel, 'Скоро');
  assert.equal(options[2].progress?.current, 10);
  assert.equal(options[2].priceSuffix, '/ год');
  assert.ok(friendshipBillingOptions([monthly, { ...annual, canPurchase: true }], true).every(option => option.ctaDisabled));
  assert.equal(friendshipBillingOptions([monthly])[2].priceMinor, null);
  assert.equal(friendshipBillingOptions([annual])[0].ctaDisabled, true);
  for (const priceMinor of [null, NaN, -1, 0]) {
    const option = friendshipBillingOptions([{ ...annual, canPurchase: true, priceMinor }])[2];
    assert.equal(option.priceMinor, null);
    assert.equal(option.ctaDisabled, true);
  }
});

test('payment adapter binds every sold billing option to its own LK1 counter', async () => {
  const adapter = loadPaymentAdapter();
  // VM-created objects use the VM realm prototype: copy before deep comparison.
  function target(a: ReturnType<typeof loadPaymentAdapter>, planId: string, optionId: string) {
    const resolved = a.resolveStorefrontBillingTarget(planId, optionId) as Record<string, unknown> | null;
    return resolved ? { ...resolved } : null;
  }
  assert.deepEqual(
    target(adapter, 'friendship', 'monthly'),
    { counterKey: 'friendship', directProductId: null, planType: 'friendship' },
  );
  assert.deepEqual(
    target(adapter, 'friendship', 'annual'),
    { counterKey: 'network_friendship', directProductId: null, planType: 'friendship' },
  );
  assert.deepEqual(
    target(adapter, 'ra', 'monthly'),
    { counterKey: 'ra', directProductId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', planType: 'friendship' },
  );
  assert.deepEqual(
    target(adapter, 'academy', 'monthly'),
    { counterKey: 'academy', directProductId: '9eb8a7a4-c195-492a-95e4-3fb82899ac10', planType: 'friendship' },
  );
  for (const [planId, optionId] of [['friendship', 'monthly-two-hours'], ['sport', 'monthly'], ['ra', 'annual'], ['friendship', 'unknown']] as const) {
    assert.equal(adapter.resolveStorefrontBillingTarget(planId, optionId), null, `${planId}/${optionId}`);
  }

  await adapter.createStorefrontSubscriptionPayment({ planId: 'friendship', billingOptionId: 'annual', phone: FIXTURE_PHONE });
  assert.equal(adapter.calls.created.length, 1);
  assert.equal(adapter.calls.created[0].counterKey, 'network_friendship');
  assert.equal(adapter.calls.created[0].planType, 'friendship');
  assert.equal(adapter.calls.bought.length, 0);

  await adapter.createStorefrontSubscriptionPayment({ planId: 'ra', billingOptionId: 'monthly', phone: FIXTURE_PHONE });
  assert.equal(adapter.calls.bought.length, 1);
  assert.equal(adapter.calls.bought[0].productId, 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759');
  assert.equal(adapter.calls.created.length, 1);
});


test('annual must come from its explicit response, never from aggregate fallback', () => {
  const monthly = { ...available, counterKey: 'friendship' };
  const annual = { ...available, counterKey: 'network_friendship' };
  const aggregate = scopedStorefrontStatuses([monthly, annual]);
  assert.deepEqual(aggregate, [monthly]);
  for (const explicit of [[], [monthly]]) {
    const merged = [...scopedStorefrontStatuses(explicit, 'network_friendship'), ...aggregate];
    assert.equal(friendshipBillingOptions(merged)[2].ctaDisabled, true);
    assert.equal(friendshipBillingOptions(merged)[2].priceMinor, null);
  }
  assert.deepEqual(scopedStorefrontStatuses([monthly, annual], 'network_friendship'), [annual]);
});
