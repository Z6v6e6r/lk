import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const source = (name) => readFileSync(new URL(`../../src/components/subscription-storefront/${name}`, import.meta.url), 'utf8');

test('review group 1: the friendship card omits annual without removing legacy checkout support', () => {
  assert.match(source('SubscriptionPage.tsx'), /friendshipBillingOptions\(statuses \?\? \[\], error, twoHourProductPriceMinor\)\s*\.filter\(option => option\.id !== 'annual'\)\s*\.map/);
  assert.match(source('catalog.ts'), /availableOption\(annual, 'annual', 'год', '\/ год'\)/);
  assert.ok(source('SubscriptionPlanCard.tsx').includes("billingOptions.some(option => option.id === 'monthly-two-hours')"), 'two remaining friendship options keep the stacked price layout');
});

test('review group 2: friendship billing buttons have no decorative fill', () => {
  const css = source('subscriptions.css');
  assert.ok(/\.subscription-card\[data-plan-id='friendship'\] \.subscription-card__billing-options button::before\s*\{\s*content: none;\s*\}/.test(css));
  assert.match(css, /\.subscription-card__billing-options button\[aria-checked='true'\]/);
});

test('review group 4: the promo addon follows every benefit and booking-limit note', () => {
  const require = createRequire(import.meta.url);
  const exports = {};
  const compiled = ts.transpileModule(source('SubscriptionPlanCard.tsx'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require: (id) => {
      if (id === './zeroCheckoutOffers') return { fastOfferKey: () => undefined };
      if (id === './assets/benefit-icons.js') return { subscriptionBenefitIconUrls: {} };
      if (id.endsWith('.svg')) return { default: 'fixture.svg' };
      return require(id);
    },
  });
  for (const withNote of [true, false]) {
    const plan = {
      id: 'fixture', label: 'Fixture', labelKind: 'plain',
      billingOptions: [{ id: 'monthly', label: 'месяц', priceMinor: 980000 }],
      benefitGroups: [
        { id: 'daily', title: 'Benefits', items: [{ id: 'game', label: 'Game benefit' }] },
        ...(withNote ? [{ id: 'limit', title: 'Limit', kind: 'note', items: [{ id: 'limit', label: 'Booking limit' }] }] : []),
      ],
    };
    const html = renderToStaticMarkup(createElement(exports.SubscriptionPlanCard, {
      plan, selectedBillingOptionId: 'monthly', onChoose: () => {}, onBillingOptionChange: () => {},
      checkoutAddon: createElement('button', { className: 'subscription-card__promo-trigger', disabled: true }, 'Promo code'),
    }));
    assert.ok(html.indexOf('subscription-card__promo-trigger') > html.indexOf(withNote ? 'Booking limit' : 'Game benefit'));
    assert.ok(html.includes('disabled=""'), 'relocation preserves the addon disabled state');
  }
});
