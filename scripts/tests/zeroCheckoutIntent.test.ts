import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionIdentityBinding } from '../../src/utils/authSessionIdentity.ts';
import { createFastIntent, readFastIntent, bindFastQuote, claimFastIntent, cancelFastIntent, takeFastOAuthIntent } from '../../src/components/subscription-storefront/zeroCheckoutIntent.ts';
import { bindOAuthContinuation, completeOAuthContinuation, takeOAuthContinuation, OAUTH_CONTINUATION_KEY, OAUTH_RECEIPT_KEY } from '../../src/utils/oauthContinuation.ts';

function harness() {
  const old = globalThis.window, values = new Map<string, string>();
  let failStorage = false;
  class Element { isConnected = true; key: string; constructor(key = 'residency') { this.key = key; } closest(selector: string) { return selector.includes('ph-buy-' + this.key) ? this : null; } }
  class Event { timeStamp = performance.now(); target = new Element(); type = 'click'; isTrusted = true; key = 'Enter'; }
  const w = { location: { href: 'https://padlhub.ru/landing?utm_source=fixture', origin: 'https://padlhub.ru' }, Event, Element,
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' },
    sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { if (failStorage) throw Error('disabled'); values.set(k, v); }, removeItem: (k: string) => values.delete(k) } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: w });
  return { values, w, event: () => new Event() as unknown as globalThis.Event,
    breakStorage: () => { failStorage = true; },
    restore: () => { if (old) Object.defineProperty(globalThis, 'window', { configurable: true, value: old }); else delete (globalThis as { window?: unknown }).window; } };
}
const quote = { priceMinor: 79000, activationDays: 0 };

test('fast payment requires a recent real card gesture for exactly one of the two products', async () => {
  const h = harness(); try {
    for (const change of [{ isTrusted: false }, { type: 'submit' }, { timeStamp: performance.now() - 16000 }, { type: 'keydown', key: 'Escape' }, { target: new h.w.Element('friendship-two-hours') }]) {
      assert.throws(() => createFastIntent('residency', 79000, Object.assign(h.event(), change)));
    }
    for (const key of ['friendship', 'friendship-year', 'patriots', 'friendship_two_hours', '__proto__']) assert.throws(() => createFastIntent(key, 79000, h.event()));
    for (const price of [0, -1, 1.5, NaN]) assert.throws(() => createFastIntent('residency', price, h.event()));
    const v = createFastIntent('residency', 79000, h.event()); assert.equal(v.phase, 'created');
    assert.equal(claimFastIntent(v.id, quote), false); // Quote not armed yet.
    h.breakStorage(); assert.throws(() => bindFastQuote(v.id, quote));
  } finally { h.restore(); }
});

test('a shown quote is bound once and claimed synchronously before async payment work', async () => {
  const h = harness(); try {
    const v = createFastIntent('residency', 79000, h.event());
    assert.throws(() => bindFastQuote(v.id, { ...quote, priceMinor: 80000 }));
    bindFastQuote(v.id, quote);
    assert.throws(() => bindFastQuote(v.id, { ...quote, activationDays: 1 }));
    assert.equal(claimFastIntent(v.id, { ...quote, priceMinor: 80000 }), false);
    assert.equal(claimFastIntent(v.id, quote), true);
    assert.equal(readFastIntent(v.id)?.phase, 'claimed');
    assert.equal(claimFastIntent(v.id, quote), false);
    assert.throws(() => bindFastQuote(v.id, quote));
    cancelFastIntent(v.id); assert.equal(readFastIntent(), null);
  } finally { h.restore(); }
});

test('ordinary UI resume/reload, forged URL and wrong OAuth state do not grant payment continuation', async () => {
  const h = harness(); try {
    const v = createFastIntent('residency', 79000, h.event()); bindFastQuote(v.id, quote);
    assert.equal(takeFastOAuthIntent('residency'), null);
    const c = bindOAuthContinuation(v.id, 'verified-state', h.w.location.href)!;
    assert.equal(await completeOAuthContinuation(c, 'foreign-state', h.w.location.href, 'identity-A'), false);
    assert.equal(await completeOAuthContinuation(c, 'verified-state', 'https://foreign.example/landing', 'identity-A'), false);
    assert.equal(takeFastOAuthIntent('residency'), null);
    assert.equal(await completeOAuthContinuation(c, 'verified-state', h.w.location.href, 'identity-A'), true);
    assert.equal(takeFastOAuthIntent('friendship-two-hours'), null);
    assert.equal(takeFastOAuthIntent('residency')?.id, v.id);
    assert.equal(takeFastOAuthIntent('residency'), null); // Same-tab receipt consumed.
    assert.equal(claimFastIntent(v.id, quote), true);
  } finally { h.restore(); }
});

test('bank return, other path/tab, expiry and cancel cannot reuse a valid OAuth receipt', async () => {
  for (const mode of ['bank', 'path', 'expired', 'cancel', 'other-tab']) {
    const h = harness(); try {
      const v = createFastIntent('residency', 79000, h.event()); bindFastQuote(v.id, quote);
      const c = bindOAuthContinuation(v.id, 'verified-state', h.w.location.href)!;
      assert.equal(await completeOAuthContinuation(c, 'verified-state', h.w.location.href, 'identity-A'), true);
      if (mode === 'bank') h.w.location.href = 'https://padlhub.ru/landing?phCheckoutReturn=residency';
      if (mode === 'path') h.w.location.href = 'https://padlhub.ru/other';
      if (mode === 'expired') {
        for (const [k, raw] of h.values) { const x = JSON.parse(raw); x.createdAt -= 600001; x.expiresAt -= 600001; h.values.set(k, JSON.stringify(x)); }
      }
      if (mode === 'cancel') cancelFastIntent(v.id);
      if (mode === 'other-tab') h.values.delete(OAUTH_CONTINUATION_KEY);
      assert.equal(takeFastOAuthIntent('residency'), null);
      if (mode !== 'other-tab') assert.equal(claimFastIntent(v.id, quote), false);
    } finally { h.restore(); }
  }
});

test('optional OAuth receipt needs opt-in state binding and verified callback; storage failures fail closed', async () => {
  const h = harness(); try {
    const v = createFastIntent('residency', 79000, h.event()); bindFastQuote(v.id, quote);
    assert.equal(bindOAuthContinuation(undefined, 'state', h.w.location.href), undefined);
    assert.equal(takeOAuthContinuation(v.id), null);
    assert.equal(await completeOAuthContinuation(undefined, 'state', h.w.location.href, 'identity-A'), false);
    const c = bindOAuthContinuation(v.id, 'state', h.w.location.href)!;
    h.breakStorage(); assert.equal(await completeOAuthContinuation(c, 'state', h.w.location.href, 'identity-A'), false);
    assert.equal(h.values.has(OAUTH_RECEIPT_KEY), false);
  } finally { h.restore(); }
});


test('OAuth keeps the card account across redirect: another actor needs manual confirmation', async () => {
  for (const mode of ['same-account', 'other-account', 'guest', 'missing-binding', 'changed-binding']) {
    const h = harness(); try {
      const v = createFastIntent('residency', 79000, h.event()); bindFastQuote(v.id, quote);
      const initialBinding = mode === 'guest' ? 'guest' : await sessionIdentityBinding(v.id, 'identity-A');
      const c = bindOAuthContinuation(v.id, 'verified-state', h.w.location.href, initialBinding)!;
      assert.equal(bindOAuthContinuation(v.id, 'replacement-state', h.w.location.href, 'guest') !== undefined, mode === 'guest');
      // Keep the original state for this callback, including the guest retry case.
      bindOAuthContinuation(v.id, 'verified-state', h.w.location.href, initialBinding);
      if (mode === 'missing-binding' || mode === 'changed-binding') {
        const armed = JSON.parse(h.values.get(OAUTH_CONTINUATION_KEY)!);
        if (mode === 'missing-binding') delete armed.initialBinding;
        else armed.initialBinding = 'guest';
        h.values.set(OAUTH_CONTINUATION_KEY, JSON.stringify(armed));
      }
      const identity = mode === 'other-account' || mode === 'guest' ? 'identity-B' : 'identity-A';
      const expected = mode === 'same-account' || mode === 'guest';
      assert.equal(await completeOAuthContinuation(c, 'verified-state', h.w.location.href, identity), expected);
      const resumed = takeFastOAuthIntent('residency');
      assert.equal(Boolean(resumed), expected);
      assert.equal(readFastIntent(v.id)?.phase, 'armed'); // No claim/POST before verified continuation.
      if (resumed) assert.equal(claimFastIntent(resumed.id, quote), true);
    } finally { h.restore(); }
  }
});
