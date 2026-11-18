import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = readFileSync(new URL('../../src/residency/ResidencyPurchasePage.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function harness(search = '?buyResidency=1', failure) {
  let state;
  const calls = [], resumes = [], effects = [];
  const module = { exports: {} };
  const CheckoutAuthProvider = ({ children }) => children;
  const ZeroCheckoutDialog = ({ offerKey }) => React.createElement('dialog', { 'data-offer': offerKey });
  const mockedRequire = name => {
    if (name === 'react') return {
      useEffect: effect => { effects.push(effect); },
      useState: initial => {
        if (state === undefined) state = typeof initial === 'function' ? initial() : initial;
        return [state, next => { state = next; }];
      },
    };
    if (name.endsWith('/zeroCheckoutMount')) return {
      startCheckout: (...args) => { if (failure) throw failure; calls.push(args); return true; },
      resumeCheckout: key => { resumes.push(key); return false; },
    };
    // The predecessor's inline checkout must not count as the direct-payment owner.
    if (name.endsWith('/CheckoutAuthProvider')) return { CheckoutAuthProvider };
    if (name.endsWith('/ZeroCheckoutDialog')) return { ZeroCheckoutDialog };
    if (name === './residencyPurchase') return { RESIDENCY_OFFER_KEY: 'residency' };
    if (name.endsWith('.css')) return {};
    return require(name);
  };
  new Function('require', 'module', 'exports', 'window', compiled)(mockedRequire, module, module.exports, { location: { search } });
  return { render: () => module.exports.ResidencyPurchasePage(), flush: () => effects.splice(0).forEach(effect => effect()), calls, resumes };
}
function find(tree, predicate) {
  if (!React.isValidElement(tree)) return null;
  if (predicate(tree)) return tree;
  for (const child of React.Children.toArray(tree.props.children)) {
    const match = find(child, predicate);
    if (match) return match;
  }
  return null;
}

test('purchase landing shows the reference offer without creating a payment on mount', () => {
  const h = harness();
  const tree = h.render();
  const html = renderToStaticMarkup(tree);
  for (const text of ['Резидент', '790 ₽', '/ 30 дней', '30%', '50%', 'Скидка на создание / участие в игре', 'игра + тренер', 'групповые тренировки', 'Время на друзей', 'турниры ПадлхАБ', 'Ракетка', 'Полотенце', 'Стать резидентом']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/Включено/g) || []).length, 2);
  assert.doesNotMatch(html, /role="switch"|type="checkbox"/);
  const card = find(tree, el => el.type === 'article');
  const last = React.Children.toArray(card.props.children).at(-1);
  assert.equal(last.type, 'button');
  assert.equal(last.props.children, 'Стать резидентом');
  assert.equal(h.calls.length, 0);
});

test('CTA forwards the real gesture and displayed price to the existing direct-checkout owner, not a second confirmation', () => {
  const h = harness();
  const button = find(h.render(), el => el.type === 'button');
  const nativeEvent = { type: 'click', isTrusted: true };
  button.props.onClick({ nativeEvent });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0], ['residency', 79000, nativeEvent]);
  assert.equal(button.props['data-ph-buy'], 'residency');
  assert.equal(find(h.render(), el => el.type === 'dialog'), null);
});

test('initial entry and bank return delegate only to the existing receipt-aware recovery owner', () => {
  for (const search of ['?buyResidency=1', '?phCheckoutReturn=residency']) {
    const h = harness(search);
    h.render(); h.flush();
    assert.deepEqual(h.resumes, ['residency']);
    assert.equal(h.calls.length, 0);
  }
});

test('a rejected gesture or disabled storage remains a visible error, never a manual purchase bypass', () => {
  const h = harness('?buyResidency=1', new Error('Нажмите кнопку выбранной подписки ещё раз.'));
  find(h.render(), el => el.type === 'button').props.onClick({ nativeEvent: {} });
  const html = renderToStaticMarkup(h.render());
  assert.match(html, /role="alert"/);
  assert.ok(html.includes('Нажмите кнопку выбранной подписки ещё раз.'));
  assert.equal(h.calls.length, 0);
});
