import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { billingFromStatus, canContinue, subscriptionCheckoutUrl } from '../../src/components/subscription-storefront/catalog.ts';

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
