import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const readBlock = name => readFileSync(new URL(`../../docs/patriots-tilda/${name}`, import.meta.url), 'utf8');
const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);

test('Patriots schedule contains the four exact Viva directions and LK booking filters', () => {
  const html = readBlock('2-events.html');
  const sandbox = { window: {} };
  vm.runInNewContext(scripts(html)[0], sandbox);
  const config = sandbox.window.LK_ATLANTY_SCHEDULE_CONFIG;
  assert.deepEqual(Array.from(config.categories, item => [item.directionId, item.typeId]), [
    [6181, 2349], [6306, 2349], [6307, 2349], [5278, 839],
  ]);
  assert.deepEqual(Array.from(config.bookingDirectionIds), [6181, 6306, 6307, 5278]);
  assert.deepEqual(Array.from(config.bookingAllowedTypeIds), [2349, 839]);
  assert.equal(config.booking, 'lk');
  assert.equal(config.maxPerCategory, 6);
  for (const category of config.categories) assert.equal(category.badge, 'Условия подключаются');
  const active = { window: {} };
  vm.runInNewContext(scripts(html.replace('window.PH_PATRIOTS_ENTITLEMENTS_READY = false;',
    'window.PH_PATRIOTS_ENTITLEMENTS_READY = true;'))[0], active);
  assert.equal(active.window.LK_ATLANTY_SCHEDULE_CONFIG.categories[0].badge, '0 ₽ по подписке');
  for (const category of active.window.LK_ATLANTY_SCHEDULE_CONFIG.categories.slice(1)) assert.match(category.badge, /2 750 ₽/);
  assert.match(html, /id="atlanty-schedule-root"/);
  assert.match(html, /\/lk\/atlanty-schedule\.js/);
});

test('Patriots copy has the actual monthly subscription and no demo checkout or invented annual offer', () => {
  const hero = readBlock('1-hero.html');
  const footer = readBlock('3-footer.html');
  assert.match(hero, /6 800 ₽/);
  assert.match(hero, /30 посещений за 30 дней/);
  assert.match(hero, /Все события «Время на друзей» — доплата 2 750 ₽/);
  assert.equal((hero.match(/2 750 ₽/g) || []).length, 3);
  assert.doesNotMatch(hero + footer, /checkout-preview|data-period="year"|30%|50%|1 час игры|До 4 активных/);
  assert.equal((hero + footer).match(/data-patriots-checkout[^>]*disabled/g)?.length, 2);
});

function controllerFixture(candidate, enableEntitlements = false) {
  const html = readBlock('5-page-controller.html');
  const calls = { opened: [], resumed: [] };
  const buttons = [0, 1].map(() => ({ disabled: true, addEventListener(_kind, listener) { this.click = listener; } }));
  const status = { textContent: '' };
  const pendingNote = { hidden: false };
  const benefitsTitle = { textContent: 'Условия после подключения' };
  const hero = { style: { setProperty() {} } };
  const content = { offsetHeight: 400 };
  let script;
  const document = {
    readyState: 'complete',
    querySelector(selector) {
      if (selector.includes('checkout-status')) return status;
      if (selector.endsWith('.ph-hero__content')) return content;
      if (selector.endsWith('.ph-hero')) return hero;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('[data-patriots-checkout]')) return buttons;
      if (selector.includes('[data-patriots-pending-note]')) return [pendingNote];
      if (selector.includes('[data-patriots-benefits-title]')) return [benefitsTitle];
      return [];
    },
    createElement() { script = {}; return script; },
    head: { appendChild() {} },
  };
  const window = {
    PH_PATRIOTS_ENTITLEMENTS_READY: enableEntitlements,
    LKWidgetSubscriptionStorefront: candidate && {
      ...candidate,
      openCheckout: key => { calls.opened.push(key); },
      resumeCheckout: key => { calls.resumed.push(key); },
    },
    addEventListener() {},
    setTimeout() {},
  };
  vm.runInNewContext(scripts(html)[0], { window, document, console, Date });
  return { buttons, status, pendingNote, benefitsTitle, script, calls };
}

test('Tilda draft keeps checkout closed and labels benefits as pending until server rules are proved', () => {
  const fixture = controllerFixture({ checkoutVersion: 1, checkoutChannel: 'prod', supportsCheckoutOffer: () => true });
  assert.equal(fixture.script, undefined);
  assert.equal(fixture.buttons.every(button => button.disabled), true);
  assert.equal(fixture.pendingNote.hidden, false);
  assert.equal(fixture.benefitsTitle.textContent, 'Условия после подключения');
  assert.match(fixture.status.textContent, /после подтверждения/);
  assert.deepEqual(fixture.calls.resumed, []);
});

test('Tilda checkout refuses legacy, dev and unsupported storefront bundles', () => {
  for (const candidate of [
    { checkoutVersion: 1, checkoutChannel: 'dev', supportsCheckoutOffer: () => true },
    { checkoutVersion: 1, checkoutChannel: 'prod', supportsCheckoutOffer: () => false },
    { checkoutVersion: 1, checkoutChannel: 'prod' },
  ]) {
    const fixture = controllerFixture(candidate, true);
    fixture.script.onload();
    assert.equal(fixture.buttons.every(button => button.disabled), true);
    assert.match(fixture.status.textContent, /недоступно/);
    assert.deepEqual(fixture.calls.opened, []);
  }
});

test('Tilda checkout opens only Patriots and scopes bank/OAuth return to Patriots', () => {
  const fixture = controllerFixture({ checkoutVersion: 1, checkoutChannel: 'prod', supportsCheckoutOffer: key => key === 'patriots' }, true);
  assert.equal(fixture.buttons.every(button => !button.disabled), true);
  assert.equal(fixture.pendingNote.hidden, true);
  assert.equal(fixture.benefitsTitle.textContent, 'Условия участия');
  assert.deepEqual(fixture.calls.resumed, ['patriots']);
  fixture.buttons[0].click();
  fixture.buttons[1].click();
  assert.deepEqual(fixture.calls.opened, ['patriots', 'patriots']);
});

test('scoped checkout return never reopens a different club offer', () => {
  const source = readFileSync(new URL('../../src/components/subscription-storefront/zeroCheckoutMount.tsx', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export function resumeCheckout('));
  const compiled = ts.transpileModule(fn, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const opened = [];
  const window = {
    location: { search: '?phCheckoutReturn=topocraty' },
    sessionStorage: { getItem: () => JSON.stringify({ key: 'topocraty', at: Date.now() }) },
  };
  const context = {
    exports: {}, window, URLSearchParams, Date, ZERO_CHECKOUT_RETURN: 'phCheckoutReturn',
    resolveZeroOffer: key => ['patriots', 'topocraty'].includes(key) ? { key } : null,
    hasZeroAttempt: () => true,
    openCheckout: key => { opened.push(key); return true; },
  };
  vm.runInNewContext(compiled, context);
  assert.equal(context.exports.resumeCheckout('patriots'), false);
  assert.deepEqual(opened, []);
  window.location.search = '?phCheckoutReturn=patriots';
  assert.equal(context.exports.resumeCheckout('patriots'), true);
  assert.deepEqual(opened, ['patriots']);
  opened.length = 0;
  window.location.search = '';
  assert.equal(context.exports.resumeCheckout('patriots'), false);
  assert.deepEqual(opened, []);
});
