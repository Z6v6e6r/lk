import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import postcss from 'postcss';

const adapter = readFileSync(new URL('../../docs/zero-block/padlhub-zero-block.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../docs/zero-block/padlhub-main-subscriptions.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
class Element {
  constructor(classes = '', tag = 'DIV', child = null) {
    this.attrs = new Map([['class', classes]]); this.tagName = tag; this.child = child;
    if (child) child.parent = this;
    this.innerHTML = 'initial';
    this.classList = {
      contains: name => this.classes().includes(name),
      remove: (...names) => this.setAttribute('class', this.classes().filter(name => !names.includes(name)).join(' ')),
      add: name => this.setAttribute('class', [...new Set([...this.classes(), name])].join(' ')),
      toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
    };
    this.listeners = new Map();
  }
  classes() { return (this.getAttribute('class') || '').split(' ').filter(Boolean); }
  setAttribute(key, value) { this.attrs.set(key, value); }
  getAttribute(key) { return this.attrs.get(key) ?? null; }
  removeAttribute(key) { this.attrs.delete(key); }
  matches(selector) {
    return selector.split(',').some(part => {
      if (part.startsWith('.')) return this.classList.contains(part.slice(1));
      if (part.startsWith('[')) { const [, name, value] = part.match(/^\[([^=]+)="([^"]*)"\]$/) || []; return name && this.getAttribute(name) === value; }
      return this.tagName === part.toUpperCase();
    });
  }
  querySelector(selector) { return this.child?.matches(selector) ? this.child : null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  contains(element) { return element === this || Boolean(element.parent && this.contains(element.parent)); }
  focus() {}
  addEventListener(name, fn, capture = false) { const list = this.listeners.get(name) || []; list.push({ fn, capture }); this.listeners.set(name, list); }
  removeEventListener(name, fn) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.fn !== fn)); }
  dispatchEvent(event) {
    event.preventDefault ||= function () { this.defaultPrevented = true; };
    event.stopImmediatePropagation ||= function () { this.stopped = true; };
    for (const { fn } of [...(this.listeners.get(event.type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) { fn(event); if (event.stopped) break; }
    return !event.defaultPrevented;
  }
}
async function fixture({ failed = false, unavailable = false, binding = true, duplicate = false, runtime = 'prod', isolated = true, preloaded = true, failManifest = false, disabled = false, missingRoot = false, hash = '', saved = null, attempt = false, storageFails = false, search = '?channel=dev&offer=academy-promo&productId=untrusted' } = {}) {
  const roles = ['price', 'remaining', 'total', 'status', 'buy', 'counter', 'card'];
  const elements = [], root = new Element(), outside = new Element('ph-buy-friendship', 'A');
  const twins = [0, 1].map(() => Object.fromEntries(roles.map(role => {
    const atom = new Element('tn-atom', role === 'buy' ? 'A' : 'SPAN');
    if (role === 'buy') atom.setAttribute('href', 'https://padlhub.ru/sub_hab');
    const element = new Element('ph-' + role + '-friendship', 'DIV', atom);
    element.parent = root; elements.push(element); return [role, element];
  })));
  const month = new Element('ph-period-month'), year = new Element('ph-period-year');
  const label = new Element('ph-period-label'), count = new Element('count-box');
  elements.push(month, year, label, count); for (const element of elements) element.parent = root;
  root.querySelectorAll = selector => elements.filter(element => element.matches(selector));
  const document = new Element(), window = new Element();
  Object.assign(document, {
    readyState: 'complete', hidden: false, documentElement: new Element(),
    getElementById: () => missingRoot ? null : root,
    querySelectorAll: selector => [...elements, outside].filter(element => element.matches(selector)),
    createElement: tag => new Element('', tag.toUpperCase()),
  });
  const opened = [], resumed = [], navigated = [], requests = [], scripts = [], timers = new Map();
  let timerId = 0, observe, dialogOpen = false, closeAllowed = true;
  const runtimeApi = {
    checkoutVersion: 1, checkoutIsolationVersion: isolated ? 1 : undefined, checkoutChannel: runtime,
    openCheckout: key => { if (dialogOpen) return false; opened.push(key); dialogOpen = true; return true; },
    resumeCheckout: key => { resumed.push(key); dialogOpen = true; return true; },
    isCheckoutOpen: () => dialogOpen,
    closeCheckout: () => { if (!closeAllowed) return false; dialogOpen = false; return true; },
  };
  document.head = { appendChild: script => {
    script.parentNode = { removeChild: () => { script.removed = true; } };
    scripts.push(script);
  } };
  Object.assign(window, {
    document, Element, PADLHUB_MAIN_CHECKOUT_DISABLED: disabled,
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    IntersectionObserver: class { constructor(fn) { observe = fn; } observe() {} disconnect() { observe = null; } },
    sessionStorage: { getItem: () => saved ? JSON.stringify(saved) : null },
    localStorage: { getItem: () => { if (storageFails) throw new Error('blocked storage'); return attempt ? 'opaque-attempt' : null; } },
    location: { href: 'https://padlhub.ru/' + search + hash, search, hash, assign: url => navigated.push(url) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('release.json')) return { ok: !failManifest, json: async () => ({ version: 'fixture' }) };
      const key = new URL(url).searchParams.get('counterKey');
      const row = { counterKey: key, priceMinor: key === 'network_friendship' ? 6800000 : 980000, unlimited: false, remainingCount: unavailable ? 0 : key === 'network_friendship' ? 1 : 7, totalLimit: 11, bindingReady: binding, canPurchase: !unavailable };
      return { ok: !failed, status: failed ? 503 : 200, json: async () => duplicate ? [row, row] : [row] };
    },
  });
  if (preloaded) window.LKWidgetSubscriptionStorefront = runtimeApi;
  const context = vm.createContext({ window, document, URL, URLSearchParams, AbortController, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  vm.runInContext(adapter, context); vm.runInContext(bootstrap, context);
  await flush();
  const fire = (name, target, extra = {}) => root.dispatchEvent({ type: name, target, ...extra });
  return {
    window, document, root, context, twins, month, year, label, count, outside, requests, opened, resumed, navigated, scripts, timers,
    click: (target, extra) => fire('click', target, { button: 0, ...extra }), key: (target, key) => fire('keydown', target, { key }),
    visible: async value => { observe?.([{ isIntersecting: value }]); await flush(); },
    hash: async value => { window.location.hash = value; window.dispatchEvent({ type: 'hashchange' }); await flush(); },
    hidden: value => { document.hidden = value; document.dispatchEvent({ type: 'visibilitychange' }); },
    loadRuntime: async () => { window.LKWidgetSubscriptionStorefront = runtimeApi; scripts.at(-1)?.onload?.(); await flush(); },
    runTimers: async ms => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await flush(); },
    busy: value => { closeAllowed = !value; },
    saveAttempt: () => { attempt = true; }, close: () => runtimeApi.closeCheckout(),
  };
}

test('main performs zero network/runtime work before intent or visible section; outside controls stay untouched', async () => {
  const f = await fixture({ preloaded: false });
  assert.equal(f.requests.length, 0); assert.equal(f.scripts.length, 0);
  assert.equal(f.outside.getAttribute('aria-disabled'), null);
  assert.equal(f.twins[0].buy.child.getAttribute('href'), 'https://padlhub.ru/sub_hab');
  await f.visible(true);
  assert.equal(f.requests.length, 5); assert.equal(f.scripts.length, 0);
  assert.ok(f.requests.every(request => request.options.method === 'GET' && request.url.startsWith('https://padlhub.su/')));
  assert.deepEqual(f.requests.map(request => new URL(request.url).searchParams.get('counterKey')).sort(), ['academy', 'energy5', 'friendship', 'network_friendship', 'ra']);
});

test('month/year bindings keep exact price/counter for all responsive duplicates, without network on toggle', async () => {
  const f = await fixture(); await f.visible(true);
  const count = f.requests.length;
  for (const [tab, key, price] of [[f.month, 'friendship', '9 800 ₽'], [f.year, 'friendship-year', '68 000 ₽'], [f.month, 'friendship', '9 800 ₽']]) {
    f.click(tab);
    for (const twin of f.twins) {
      assert.equal(twin.price.child.textContent, price);
      assert.equal(twin.remaining.child.textContent, key === 'friendship-year' ? '1' : '7');
      assert.equal(twin.buy.getAttribute('data-ph-buy'), key);
      assert.equal(twin.buy.child.getAttribute('href'), 'https://padlhub.ru/sub_hab');
    }
    assert.equal(f.year.getAttribute('aria-pressed'), key === 'friendship-year' ? 'true' : 'false');
  }
  assert.equal(f.requests.length, count);
  f.click(f.year); f.click(f.twins[1].buy.child); await flush(); assert.deepEqual(f.opened, ['friendship-year']);
});

test('DIV period controls support Enter/Space; stale dual keys normalize to one selected offer', async () => {
  const f = await fixture(); await f.visible(true);
  for (const twin of f.twins) { twin.buy.classList.add('ph-buy-friendship-year'); twin.buy.setAttribute('data-ph-buy', 'friendship-year'); }
  assert.equal(f.year.getAttribute('role'), 'button'); assert.equal(f.year.getAttribute('tabindex'), '0');
  f.key(f.year, 'Enter');
  for (const twin of f.twins) assert.equal(twin.buy.classList.contains('ph-buy-friendship'), false);
  f.key(f.month, ' ');
  for (const twin of f.twins) assert.equal(twin.buy.classList.contains('ph-buy-friendship-year'), false);
});

test('strict hash links choose allowed ordinary offer only; duplicates/unknown/executable payloads never open', async () => {
  const annual = await fixture({ hash: '#ph-checkout=friendship-year' });
  assert.deepEqual(annual.opened, ['friendship-year']); assert.equal(annual.label.textContent, '/ год');
  for (const hash of ['#ph-checkout=unknown', '#ph-checkout=ra&ph-checkout=academy', '#ph-checkout=javascript:alert(1)', '#ph-checkout=academy-promo']) {
    const f = await fixture({ hash }); assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
  }
  const f = await fixture(); await f.hash('#ph-checkout=ra'); assert.deepEqual(f.opened, ['ra']);
});

test('runtime loads once for repeated clicks; no purchase requests are sent by the adapter', async () => {
  const f = await fixture({ preloaded: false });
  f.click(f.twins[0].buy.child); f.click(f.twins[1].buy.child); await flush();
  assert.equal(f.scripts.length, 1); assert.equal(f.twins[0].buy.child.getAttribute('aria-busy'), 'true');
  await f.loadRuntime(); assert.deepEqual(f.opened, ['friendship']); assert.equal(f.navigated.length, 0);
  assert.ok(f.requests.every(request => !request.options?.method || request.options.method === 'GET'));
});

test('opening an available offer does not wait for an unrelated hung counter or claim it is unavailable', async () => {
  const f = await fixture();
  const original = f.window.fetch;
  f.window.fetch = (url, options) => url.includes('counterKey=energy5') ? new Promise(() => {}) : original(url, options);
  await f.visible(true);
  assert.equal(f.twins[0].status.child.textContent, '');
  f.click(f.twins[0].buy.child); await flush();
  assert.deepEqual(f.opened, ['friendship']); assert.equal(f.navigated.length, 0);
});

test('manifest/script failure and incompatible channel/isolation produce exactly one catalog fallback', async () => {
  for (const setup of [{ preloaded: false, failManifest: true }, { runtime: 'dev' }, { isolated: false }, { failed: true }, { duplicate: true }]) {
    const f = await fixture(setup);
    f.click(f.twins[0].buy.child); f.click(f.twins[1].buy.child); await flush();
    assert.deepEqual(f.navigated, ['https://padlhub.ru/sub_hab']); assert.equal(f.opened.length, 0);
  }
  const f = await fixture({ preloaded: false }); f.click(f.twins[0].buy.child); await flush();
  f.scripts[0].onerror(); await flush();
  assert.deepEqual(f.navigated, ['https://padlhub.ru/sub_hab']); assert.equal(f.scripts[0].removed, true);
});

test('deadline falls back once; a late runtime cannot open UI', async () => {
  const f = await fixture({ preloaded: false }); f.click(f.twins[0].buy.child); await flush();
  const late = f.scripts[0].onload;
  await f.runTimers(12000); await f.loadRuntime(); late(); await flush();
  assert.deepEqual(f.navigated, ['https://padlhub.ru/sub_hab']); assert.equal(f.opened.length, 0);
});

test('Escape, hidden tab and destroy cancel pending UI/fallback; busy checkout refuses destruction', async () => {
  for (const cancel of [f => f.document.dispatchEvent({ type: 'keydown', target: f.outside, key: 'Escape' }), f => f.hidden(true), f => f.window.phSubscriptions.destroy()]) {
    const f = await fixture({ preloaded: false }); f.click(f.twins[0].buy.child); await flush(); cancel(f);
    await f.loadRuntime(); await f.runTimers(12000);
    assert.equal(f.opened.length, 0); assert.equal(f.navigated.length, 0);
  }
  const f = await fixture(); f.click(f.twins[0].buy.child); await flush(); f.busy(true);
  assert.equal(f.window.phSubscriptions.destroy(), false); assert.ok(f.window.phSubscriptions);
  f.busy(false); assert.equal(f.window.phSubscriptions.destroy(), true);
});

test('known sold-out/unbound offer never opens or automatically falls back', async () => {
  for (const options of [{ unavailable: true }, { binding: false }]) {
    const f = await fixture(options); await f.visible(true); f.click(f.twins[0].buy.child); await flush();
    assert.equal(f.opened.length, 0); assert.equal(f.navigated.length, 0);
    assert.equal(f.twins[0].buy.child.getAttribute('aria-disabled'), 'true');
  }
});

test('modified/middle clicks keep native navigation; disabled/missing-root bootstrap is inert', async () => {
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    const f = await fixture(); assert.equal(f.click(f.twins[0].buy.child, extra), true); await flush();
    assert.equal(f.requests.length, 0); assert.equal(f.opened.length, 0);
  }
  for (const setup of [{ disabled: true }, { missingRoot: true }]) {
    const f = await fixture(setup); assert.equal(f.window.phSubscriptions, undefined); assert.equal(f.requests.length, 0);
    assert.equal(f.twins[0].buy.child.getAttribute('href'), 'https://padlhub.ru/sub_hab');
  }
});

test('bank and fresh OAuth returns resume UI without checkout create, even if inventory is now unavailable', async () => {
  for (const setup of [{ search: '?phCheckoutReturn=friendship-year', unavailable: true }, { saved: { key: 'ra', at: Date.now() } }, { hash: '#ph-checkout=ra', saved: { key: 'ra', at: Date.now() }, failed: true }]) {
    const f = await fixture(setup); assert.equal(f.opened.length, 0); assert.equal(f.resumed.length, 1); assert.equal(f.navigated.length, 0);
  }
  for (const setup of [{ search: '?phCheckoutReturn=ra&phCheckoutReturn=academy' }, { saved: { key: 'ra', at: Date.now() - 1800001 } }]) {
    const f = await fixture(setup); assert.equal(f.requests.length, 0); assert.equal(f.resumed.length, 0);
  }
});

test('bank return owns the selection even with a conflicting hash; invalid returns cannot start a hash checkout', async () => {
  const f = await fixture({ search: '?phCheckoutReturn=friendship-year', hash: '#ph-checkout=ra' });
  assert.deepEqual(f.resumed, ['friendship-year']); assert.equal(f.opened.length, 0);
  const invalid = await fixture({ search: '?phCheckoutReturn=unknown', hash: '#ph-checkout=ra' });
  assert.equal(invalid.requests.length, 0); assert.equal(invalid.opened.length, 0);
});

test('hash navigation away cancels pending UI; changing selected hash opens only the final offer', async () => {
  const f = await fixture({ preloaded: false, hash: '#ph-checkout=friendship' });
  await f.hash('#info'); await f.loadRuntime(); assert.equal(f.opened.length, 0); assert.equal(f.navigated.length, 0);
  const g = await fixture({ preloaded: false, hash: '#ph-checkout=friendship' });
  await g.hash('#ph-checkout=ra'); await g.loadRuntime();
  assert.deepEqual(g.opened, ['ra']); assert.equal(g.navigated.length, 0);
});

test('an open checkout owns subsequent intents: later status errors cannot trigger catalog navigation', async () => {
  const f = await fixture(); f.click(f.twins[0].buy.child); await flush();
  const before = f.requests.length; await f.hash('#ph-checkout=ra');
  assert.equal(f.requests.length, before); assert.deepEqual(f.opened, ['friendship']); assert.equal(f.navigated.length, 0);
});

test('durable or unknown attempt custody prevents fallback after closing UI or loading failure', async () => {
  for (const options of [{ attempt: true }, { storageFails: true }]) {
    const f = await fixture({ ...options, preloaded: false, failManifest: true });
    f.click(f.twins[0].buy.child); await flush(); assert.equal(f.navigated.length, 0);
  }
  const f = await fixture(); f.click(f.twins[0].buy.child); await flush();
  f.saveAttempt(); f.close(); f.window.fetch = async () => ({ ok: false });
  f.click(f.twins[0].buy.child); await flush();
  assert.equal(f.opened.length, 2); assert.equal(f.navigated.length, 0);
  const g = await fixture({ preloaded: false }); g.click(g.twins[0].buy.child); await flush();
  g.saveAttempt(); await g.runTimers(12000); assert.equal(g.navigated.length, 0);
});

test('an existing attempt remains keyboard-accessible when its last inventory slot has sold out', async () => {
  const f = await fixture({ attempt: true, unavailable: true }); await f.visible(true);
  assert.equal(f.twins[0].buy.child.getAttribute('aria-disabled'), 'false');
  assert.equal(f.twins[0].buy.child.getAttribute('tabindex'), '0');
  f.click(f.twins[0].buy.child); await flush();
  assert.deepEqual(f.opened, ['friendship']); assert.equal(f.navigated.length, 0);
});

test('polling pauses outside section/hidden tab and backs off on failures', async () => {
  const f = await fixture({ failed: true }); await f.visible(true);
  assert.ok([...f.timers.values()].some(timer => timer.ms === 60000));
  await f.visible(false); assert.equal(f.timers.size, 0);
  await f.visible(true); f.hidden(true); assert.equal(f.timers.size, 0);
});

test('duplicate bootstrap is inert and destroy restores native controls and removes handlers', async () => {
  const f = await fixture(); const api = f.window.phSubscriptions;
  vm.runInContext(bootstrap, f.context); assert.equal(f.window.phSubscriptions, api);
  f.click(f.year); assert.equal(api.destroy(), true);
  for (const twin of f.twins) {
    assert.equal(twin.buy.getAttribute('class'), 'ph-buy-friendship'); assert.equal(twin.buy.getAttribute('data-ph-buy'), null);
    assert.equal(twin.buy.child.getAttribute('href'), 'https://padlhub.ru/sub_hab');
  }
  f.click(f.month); assert.equal(f.window.phSubscriptionsActiveKey, undefined);
  await f.hash('#ph-checkout=academy'); assert.equal(f.opened.length, 0);
});

test('older adapter is left untouched with native fallback links', () => {
  const old = { version: '2.0.1', init: () => assert.fail('must not initialize old adapter') };
  const window = { PadlHubZeroBlock: old };
  vm.runInNewContext(bootstrap, { window, document: { readyState: 'complete', getElementById: () => ({}) } });
  assert.equal(window.PadlHubZeroBlock, old);
});

test('checkout auth selects the existing protocol without installing page-wide tracking/idle hooks', () => {
  const source = readFileSync(new URL('../../src/components/subscription-storefront/CheckoutAuthProvider.tsx', import.meta.url), 'utf8');
  const body = source.replace(/^import[^\n]+\n/gm, '');
  const compiled = ts.transpileModule(body, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const mode of ['viva', 'legacy']) {
    const exported = {};
    vm.runInNewContext(compiled, { exports: exported, resolveConfiguredAuthMode: () => mode, VivaAuthProvider: 'viva-provider', LegacyAuthProvider: 'legacy-provider', require: () => ({ jsx: (type, props) => ({ type, props }) }) });
    const view = exported.CheckoutAuthProvider({ children: 'form' }); assert.equal(view.type, mode + '-provider'); assert.equal(view.props.children, 'form');
  }
  assert.doesNotMatch(source, /installGlobalErrorTracking|useGlobalClickAnalytics|installLkIdleDataGuard/);
});

test('auth CSS never targets document root or external forms; portal and idle guard retain scoped defaults', () => {
  const source = readFileSync(new URL('../../src/components/subscription-storefront/storefront-auth.css', import.meta.url), 'utf8');
  postcss.parse(source).walkRules(rule => {
    assert.ok(rule.selector.startsWith(':where(.subscription-storefront-runtime, .ph-zero-checkout-host'), rule.selector);
    assert.ok(!rule.selector.includes(':root'));
  });
  assert.ok(source.includes('.lk-idle-data-guard)'));
  const guard = readFileSync(new URL('../../src/components/subscription-storefront/storefront-idle-guard.css', import.meta.url), 'utf8');
  assert.match(guard, /font-family: 'Subscription Auth RF Dewi UltraBold'/);
  assert.doesNotMatch(guard, /font-family: ['"]RF Dewi UltraBold/);
  const portal = readFileSync(new URL('../../src/components/subscription-storefront/SubscriptionPromoCodeDialog.tsx', import.meta.url), 'utf8');
  assert.match(portal, /className="subscription-storefront-runtime subscription-auth-overlay/);
  const entry = readFileSync(new URL('../../src/subscription-storefront.tsx', import.meta.url), 'utf8');
  assert.match(entry, /checkoutIsolationVersion: 1/); assert.match(entry, /restoreScope\?\.\(\)/);
});

test('kit keeps native fallback guidance and ships main script without auto-purchase', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'padlhub-main-kit-'));
  execFileSync(process.execPath, ['scripts/package-zero-block.mjs', destination], { cwd: new URL('../../', import.meta.url) });
  const html = await readFile(join(destination, 'T123-Главная.html'), 'utf8');
  assert.ok(html.includes(adapter)); assert.ok(html.includes(bootstrap));
  assert.ok(html.includes('[data-ph-zero-root] [data-ph-hidden'));
  assert.doesNotMatch(bootstrap, /checkoutUrl|autoPurchase/);
});
