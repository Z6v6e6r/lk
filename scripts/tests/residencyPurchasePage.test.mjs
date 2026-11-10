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

function harness(search = '?buyResidency=1') {
  let state;
  const module = { exports: {} };
  const CheckoutAuthProvider = ({ children }) => children;
  const ZeroCheckoutDialog = ({ offerKey }) => React.createElement('dialog', { 'data-offer': offerKey });
  const mockedRequire = name => {
    if (name === 'react') return { useState: initial => {
      if (state === undefined) state = typeof initial === 'function' ? initial() : initial;
      return [state, next => { state = next; }];
    } };
    if (name.endsWith('/CheckoutAuthProvider')) return { CheckoutAuthProvider };
    if (name.endsWith('/ZeroCheckoutDialog')) return { ZeroCheckoutDialog };
    if (name === './residencyPurchase') return { RESIDENCY_OFFER_KEY: 'residency' };
    if (name.endsWith('.css')) return {};
    return require(name);
  };
  new Function('require', 'module', 'exports', 'window', compiled)(mockedRequire, module, module.exports, { location: { search } });
  return { render: () => module.exports.ResidencyPurchasePage(), CheckoutAuthProvider, ZeroCheckoutDialog };
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

test('purchase landing shows the reference offer and bottom CTA without opening checkout', () => {
  const h = harness();
  const tree = h.render();
  const html = renderToStaticMarkup(tree);
  for (const text of ['Резидент', '790 ₽', '/ 30 дней', '30%', '50%', 'Скидка на создание / участие в игре', 'игра + тренер', 'групповые тренировки', 'Время на друзей', 'турниры ПадлхАБ', 'Ракетка', 'Полотенце', 'Стать резидентом']) assert.ok(html.includes(text), text);
  assert.equal(find(tree, el => el.type === h.ZeroCheckoutDialog), null);
  assert.equal((html.match(/Включено/g) || []).length, 2);
  assert.doesNotMatch(html, /role="switch"|type="checkbox"/);
  const card = find(tree, el => el.type === 'article');
  const last = React.Children.toArray(card.props.children).at(-1);
  assert.equal(last.type, 'button');
  assert.equal(last.props.children, 'Стать резидентом');
});

test('CTA opens the existing residency checkout with its auth provider; closing restores the offer', () => {
  const h = harness();
  find(h.render(), el => el.type === 'button').props.onClick();
  let tree = h.render();
  assert.ok(find(tree, el => el.type === h.CheckoutAuthProvider));
  const checkout = find(tree, el => el.type === h.ZeroCheckoutDialog);
  assert.equal(checkout.props.offerKey, 'residency');
  assert.equal(checkout.props.fast, undefined);
  checkout.props.onClose();
  tree = h.render();
  assert.equal(find(tree, el => el.type === h.ZeroCheckoutDialog), null);
  assert.ok(renderToStaticMarkup(tree).includes('Стать резидентом'));
});

test('payment return keeps the existing checkout recovery UI and never enables automatic purchase', () => {
  const h = harness('?phCheckoutReturn=residency');
  const checkout = find(h.render(), el => el.type === h.ZeroCheckoutDialog);
  assert.equal(checkout.props.offerKey, 'residency');
  assert.equal(checkout.props.fast, undefined);
  const other = harness('?phCheckoutReturn=friendship');
  assert.equal(find(other.render(), el => el.type === other.ZeroCheckoutDialog), null);
});
