import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import test from 'node:test';

const adapter = readFileSync(new URL('../../docs/zero-block/padlhub-zero-block.js', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../docs/zero-block/padlhub-main-subscriptions.js', import.meta.url), 'utf8');
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
  focus() {}
}
async function fixture({ failed = false, unavailable = false, runtime = 'prod' } = {}) {
  const roles = ['price', 'remaining', 'total', 'status', 'buy', 'counter', 'card'];
  const elements = [];
  const twins = [0, 1].map(() => Object.fromEntries(roles.map(role => {
    const atom = new Element('tn-atom', role === 'buy' ? 'A' : 'SPAN');
    const element = new Element('ph-' + role + '-friendship', 'DIV', atom);
    elements.push(element); return [role, element];
  })));
  const month = new Element('ph-period-month'), year = new Element('ph-period-year');
  const label = new Element('ph-period-label'), count = new Element('count-box');
  elements.push(month, year, label, count);
  const listeners = new Map(), opened = [], requests = [];
  const document = {
    readyState: 'complete', hidden: false,
    querySelectorAll: selector => elements.filter(element => element.matches(selector)),
    addEventListener: (name, fn, capture = false) => { const list = listeners.get(name) || []; list.push({ fn, capture }); listeners.set(name, list); },
    removeEventListener: (name, fn) => listeners.set(name, (listeners.get(name) || []).filter(item => item.fn !== fn)),
    dispatchEvent: () => {},
  };
  const window = {
    document, Element, setTimeout: () => 1, clearTimeout: () => {},
    location: { search: '?channel=dev&offer=academy-promo&productId=untrusted' },
    LKWidgetSubscriptionStorefront: { checkoutVersion: 1, checkoutChannel: runtime, openCheckout: key => opened.push(key), resumeCheckout: () => {}, closeCheckout: () => true },
    fetch: async (url, options) => {
      requests.push({ url, options });
      const key = new URL(url).searchParams.get('counterKey');
      return { ok: !failed, status: failed ? 503 : 200, json: async () => [{ counterKey: key, priceMinor: key === 'network_friendship' ? 9800000 : 980000, unlimited: false, remainingCount: unavailable ? 0 : key === 'network_friendship' ? 1 : 7, totalLimit: 11, bindingReady: true, canPurchase: !unavailable }] };
    },
  };
  const context = vm.createContext({ window, document, URL, AbortController, CustomEvent: class {} });
  vm.runInContext(adapter, context); vm.runInContext(bootstrap, context);
  await new Promise(resolve => setImmediate(resolve));
  function dispatch(name, target, key) {
    const event = { target, key, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
    for (const { fn } of [...(listeners.get(name) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) { fn(event); if (event.stopped) break; }
  }
  return { window, context, twins, month, year, label, count, requests, opened, click: target => dispatch('click', target), key: (target, key) => dispatch('keydown', target, key) };
}

test('main month/year bindings select exact offer/price for every responsive duplicate', async () => {
  const f = await fixture();
  const requestCount = f.requests.length;
  for (const [tab, key, price] of [[f.month, 'friendship', '9 800 ₽'], [f.year, 'friendship-year', '98 000 ₽'], [f.month, 'friendship', '9 800 ₽']]) {
    f.click(tab);
    for (const twin of f.twins) {
      assert.equal(twin.price.child.textContent, price);
      assert.equal(twin.remaining.child.textContent, key === 'friendship-year' ? '1' : '7');
      assert.equal(twin.buy.getAttribute('data-ph-buy'), key);
      assert.equal(twin.buy.child.getAttribute('href'), '#ph-checkout');
      f.click(twin.buy.child); assert.equal(f.opened.at(-1), key);
    }
    assert.equal(f.year.getAttribute('aria-pressed'), key === 'friendship-year' ? 'true' : 'false');
  }
  assert.equal(f.requests.length, requestCount, 'rebinding does not fetch or purchase');
  assert.ok(f.requests.every(request => request.options.method === 'GET' && request.url.startsWith('https://padlhub.su/')));
  assert.deepEqual(f.requests.map(request => new URL(request.url).searchParams.get('counterKey')).sort(), ['academy', 'energy5', 'friendship', 'network_friendship', 'ra']);
});

test('main fails closed on unavailable inventory, status error or incompatible runtime', async () => {
  for (const options of [{ failed: true }, { unavailable: true }, { runtime: 'dev' }]) {
    const f = await fixture(options);
    f.click(f.year);
    for (const twin of f.twins) { f.click(twin.buy.child); assert.equal(twin.buy.child.getAttribute('aria-disabled'), 'true'); }
    assert.equal(f.opened.length, 0);
  }
});

test('Tilda DIV period controls support keyboard and stale dual bindings are normalized', async () => {
  const f = await fixture();
  for (const twin of f.twins) { twin.buy.classList.add('ph-buy-friendship-year'); twin.buy.setAttribute('data-ph-buy', 'friendship-year'); }
  assert.equal(f.year.getAttribute('role'), 'button'); assert.equal(f.year.getAttribute('tabindex'), '0');
  f.key(f.year, 'Enter');
  for (const twin of f.twins) {
    assert.equal(twin.buy.classList.contains('ph-buy-friendship'), false);
    f.click(twin.buy.child); assert.equal(f.opened.at(-1), 'friendship-year');
  }
  f.key(f.month, ' ');
  for (const twin of f.twins) {
    assert.equal(twin.buy.classList.contains('ph-buy-friendship-year'), false);
    f.click(twin.buy.child); assert.equal(f.opened.at(-1), 'friendship');
  }
});

test('duplicate bootstrap is inert and destroy restores bindings/removes period listener', async () => {
  const f = await fixture();
  const api = f.window.phSubscriptions, requests = f.requests.length;
  vm.runInContext(bootstrap, f.context);
  assert.equal(f.window.phSubscriptions, api); assert.equal(f.requests.length, requests);
  f.click(f.year); assert.equal(api.destroy(), true);
  for (const twin of f.twins) { assert.equal(twin.buy.getAttribute('class'), 'ph-buy-friendship'); assert.equal(twin.buy.getAttribute('data-ph-buy'), null); }
  f.click(f.month); assert.equal(f.window.phSubscriptionsActiveKey, undefined);
});

test('main rejects a preloaded older adapter without replacing it', () => {
  const old = { version: '2.0.0', init: () => assert.fail('must not initialize old adapter') };
  const window = { PadlHubZeroBlock: old };
  assert.throws(() => vm.runInNewContext(bootstrap, { window, document: { readyState: 'complete' } }), /актуальный/);
  assert.equal(window.PadlHubZeroBlock, old);
});

test('designer kit contains standalone main insertion with normal offers and no checkoutUrl', async () => {
  const destination = await mkdtemp(join(tmpdir(), 'padlhub-main-kit-'));
  execFileSync(process.execPath, ['scripts/package-zero-block.mjs', destination], { cwd: new URL('../../', import.meta.url) });
  const html = await readFile(join(destination, 'T123-Главная.html'), 'utf8');
  assert.ok(html.includes(adapter)); assert.ok(html.includes(bootstrap));
  assert.doesNotMatch(bootstrap, /checkoutUrl|autoPurchase|location\.(?:href|assign)\s*[=(]/);
});
