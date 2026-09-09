import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { billingFromStatus, canContinue, subscriptionCheckoutUrl, friendshipBillingOptions, scopedStorefrontStatuses } from '../../src/components/subscription-storefront/catalog.ts';

const available = { counterKey: 'ra', priceMinor: 2380000, canPurchase: true, bindingReady: true, unlimited: false, remainingCount: 12, totalLimit: 100 };
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
test('navigation uses an allowlisted LK1 page with auto-purchase disabled and matching channel', () => {
  for (const channel of ['prod', 'dev'] as const) {
    const url = new URL(subscriptionCheckoutUrl('ra', channel)!);
    assert.equal(url.origin, 'https://padlhub.ru');
    assert.equal(url.pathname, '/ab_leto');
    assert.equal(url.searchParams.get('autoPurchase'), '0');
    assert.equal(url.searchParams.get('channel'), channel);
    assert.equal(url.searchParams.get('artworkKey'), 'ra');
    assert.equal(url.searchParams.has('priceLabel'), false);
  }
  assert.equal(subscriptionCheckoutUrl('sport', 'prod'), null);
  assert.equal(subscriptionCheckoutUrl('https://example.com', 'prod'), null);
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

test('annual navigation has its own binding; future and unknown variants never navigate', () => {
  for (const channel of ['prod', 'dev'] as const) {
    const annual = new URL(subscriptionCheckoutUrl('friendship', channel, 'annual')!);
    assert.equal(annual.searchParams.get('variant'), 'network_friendship');
    assert.equal(annual.searchParams.has('artworkKey'), false);
    assert.equal(annual.searchParams.get('autoPurchase'), '0');
    assert.equal(annual.searchParams.get('channel'), channel);
    assert.equal(subscriptionCheckoutUrl('friendship', channel, 'monthly-two-hours'), null);
    assert.equal(subscriptionCheckoutUrl('ra', channel, 'annual'), null);
    assert.equal(subscriptionCheckoutUrl('friendship', channel, 'unknown'), null);
  }
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
