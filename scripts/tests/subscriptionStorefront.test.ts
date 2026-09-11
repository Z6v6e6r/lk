import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  billingFromStatus, canContinue, energy5BillingOptions, friendshipBillingOptions, requiresAnnualTermsConsent,
  scopedStorefrontStatuses,
} from '../../src/components/subscription-storefront/catalog.ts';

const available = { counterKey: 'ra', priceMinor: 2380000, canPurchase: true, bindingReady: true, unlimited: false, remainingCount: 12, totalLimit: 100 };

/** Synthetic fixture number, built at runtime to keep source free of phone literals. */
const FIXTURE_PHONE = `+${'7'}${'900000000'}`;

interface PaymentAdapterCalls {
  created: { counterKey: string | null; planType: string | null }[];
  bought: { productId: string; phone: string }[];
  /** Provider failure returned by the direct-product purchase stub. */
  buyFailure?: { status: number; message: string } | null;
}

/** Removes top-level import declarations before transpiling the module for the VM. */
function stripImports(source: string): string {
  return source.replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '');
}

/** Loads the payment adapter in a VM with stubbed LK1 API calls. */
function loadPaymentAdapter(): {
  resolveStorefrontBillingTarget: (planId: string, optionId: string) => unknown;
  createStorefrontSubscriptionPayment: (params: { planId: string; billingOptionId: string; phone: string }) => Promise<unknown>;
  describePaymentFailure: (error: { status?: number | null; message?: string | null } | null, fallback: string) => string;
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
      if (calls.buyFailure) return { data: null, error: calls.buyFailure, status: calls.buyFailure.status };
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
          : value === 'energy5' ? 'dfa72adf-233b-4285-8d69-e5eab4234fbe'
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
    describePaymentFailure: exported.describePaymentFailure as never,
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

test('annual terms are confirmed only after the CTA press, never above the storefront', () => {
  const pageSource = readFileSync(new URL('../../src/components/subscription-storefront/SubscriptionPage.tsx', import.meta.url), 'utf8');
  const storefrontIndex = pageSource.indexOf('<SubscriptionStorefront');
  const consentIndex = pageSource.indexOf('className="subscription-consent"');
  assert.ok(storefrontIndex > 0, 'the storefront render disappeared');
  assert.ok(consentIndex > storefrontIndex, 'the terms row must not render above the storefront');
  // The row is inside the dialog that the CTA opens, not in the initial page.
  assert.match(pageSource, /const \[consentRequested, setConsentRequested\] = useState\(false\)/);
  assert.match(pageSource, /consentRequested && isAuthenticated/);
  assert.match(pageSource, /aria-labelledby="subscription-consent-title"/);
  assert.match(pageSource, /requiresAnnualTermsConsent\(billingOptionId, annualTermsAccepted\)/);
  assert.equal(
    pageSource.slice(storefrontIndex).match(/className="subscription-consent"/g)?.length,
    1,
    'the terms row must exist once, in the confirmation dialog',
  );
  for (const [optionId, accepted, expected] of [
    ['annual', false, true],
    ['annual', true, false],
    ['monthly', false, false],
    ['monthly-two-hours', false, false],
  ] as const) {
    assert.equal(
      requiresAnnualTermsConsent(optionId, accepted),
      expected,
      `${optionId} with accepted=${accepted}`,
    );
  }
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
    target(adapter, 'energy5', 'monthly'),
    { counterKey: 'energy5', directProductId: 'dfa72adf-233b-4285-8d69-e5eab4234fbe', planType: 'friendship' },
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

  await adapter.createStorefrontSubscriptionPayment({ planId: 'energy5', billingOptionId: 'monthly', phone: FIXTURE_PHONE });
  assert.equal(adapter.calls.bought.length, 2);
  assert.equal(adapter.calls.bought[1].productId, 'dfa72adf-233b-4285-8d69-e5eab4234fbe');
});

test('five-visit pass keeps its API price and disables the CTA without one', () => {
  const pass = energy5BillingOptions({ ...available, counterKey: 'energy5', priceMinor: 1980000, unlimited: true, remainingCount: 0 });
  assert.equal(pass.length, 1);
  assert.equal(pass[0].id, 'monthly');
  assert.equal(pass[0].label, '5 занятий');
  assert.equal(pass[0].priceSuffix, '/ 5 занятий');
  assert.equal(pass[0].priceMinor, 1980000);
  assert.equal(pass[0].ctaLabel, 'Оформить абонемент');
  assert.equal(pass[0].progress, undefined);
  assert.equal(pass[0].ctaDisabled, false);
  assert.equal(energy5BillingOptions(undefined).length, 0);
  const soldOut = energy5BillingOptions({ ...available, counterKey: 'energy5', canPurchase: false });
  assert.equal(soldOut.length, 1);
  assert.equal(soldOut[0].ctaDisabled, true);
  assert.equal(soldOut[0].ctaLabel, 'Сейчас недоступно');
  for (const priceMinor of [null, 0, NaN]) {
    const unavailable = energy5BillingOptions({ ...available, counterKey: 'energy5', priceMinor, unlimited: true, remainingCount: 0 });
    assert.equal(unavailable.length, 0, `price ${priceMinor}`);
  }
  // Every 30-day variant names its period instead of a bare «мес.».
  const monthly = friendshipBillingOptions([{ ...available, counterKey: 'friendship', priceMinor: 980000 }]);
  assert.deepEqual(monthly.map(option => option.priceSuffix), ['/ 30 дней', '/ 30 дней', '/ год']);
});

test('card copy follows the approved mock: free hour, footer note and five-visit pass', () => {
  const presentationSource = readFileSync(new URL('../../src/components/subscription-storefront/presentation.ts', import.meta.url), 'utf8');
  assert.equal((presentationSource.match(/title: '1 час в день бесплатно:'/g) || []).length, 4);
  assert.match(presentationSource, /kind: 'note'/);
  assert.match(presentationSource, /energy5: \{\s*label: 'Абонемент «Энергия 5»',\s*shortLabel: 'Энергия',\s*labelKind: 'plain',/);
  assert.match(presentationSource, /title: 'Форматы на выбор:'/);
  assert.match(presentationSource, /label: 'До 4 активных записей'/);
  assert.doesNotMatch(presentationSource, /на 2 недели вперёд/);
  // The «Другие действия» menu was removed from the public page.
  const storefrontSource = readFileSync(new URL('../../src/components/subscription-storefront/SubscriptionStorefront.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(storefrontSource, /subscription-storefront__more/);
  // The back arrow overlays the hero band instead of taking its own row.
  const cssSource = readFileSync(new URL('../../src/components/subscription-storefront/subscriptions.css', import.meta.url), 'utf8');
  assert.match(cssSource, /\.subscription-storefront__canvas \{ position: relative; \}/);
  assert.match(cssSource, /\.subscription-storefront__navigation \{\s*position: absolute;/);
  // The card pager is a named switcher, not a dot indicator.
  const sectionSource = readFileSync(new URL('../../src/components/subscription-storefront/SubscriptionOfferSection.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(sectionSource, /subscription-rail-dots/);
  assert.match(sectionSource, /className="subscription-plan-switcher"/);
  assert.match(sectionSource, /plan\.shortLabel \?\? plan\.label/);
  assert.match(sectionSource, /stopPlans/);
  assert.doesNotMatch(cssSource, /\.subscription-rail-dots/);
  assert.match(cssSource, /\.subscription-plan-switcher button\[aria-current='true'\]/);
  // Phones fit the hero, one card and the switcher on a single screen.
  assert.match(cssSource, /\.subscription-storefront__canvas \{ padding: 12px; gap: 14px; \}/);
  assert.match(cssSource, /\.subscription-card__panel \{ min-height: 0; padding: 16px 14px 16px; gap: 14px; \}/);
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

test('provider rejections keep their own reason and status code', async () => {
  const adapter = loadPaymentAdapter();
  assert.equal(
    adapter.describePaymentFailure({ status: 418, message: "I'm a teapot" }, 'fallback'),
    "I'm a teapot (код 418)",
  );
  assert.equal(adapter.describePaymentFailure({ status: null, message: null }, 'Не удалось создать оплату'), 'Не удалось создать оплату');
  assert.equal(adapter.describePaymentFailure(null, 'Не удалось создать оплату'), 'Не удалось создать оплату');

  adapter.calls.buyFailure = { status: 418, message: "I'm a teapot" };
  await assert.rejects(
    adapter.createStorefrontSubscriptionPayment({ planId: 'ra', billingOptionId: 'monthly', phone: FIXTURE_PHONE }),
    // The adapter lives in another VM realm, so assert on the message, not on `instanceof`.
    (error: unknown) => /I'm a teapot/.test(String((error as { message?: string })?.message)) && /418/.test(String((error as { message?: string })?.message)),
  );
});
