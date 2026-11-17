import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const load = (code, deps) => { const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => deps(name), module, module.exports); return module.exports; };
const purchase = { RESIDENCY_PRODUCT_ID: '4037a3a3-e551-4f9a-a9db-1410e46b8635' };
const planner = load(compile('../../src/residency/compositeResidencyOrder.ts'), name => {
  if (name === './residencyPurchase.ts') return purchase; throw new Error(name); });
const { CompositeResidencyOffer } = load(compile('../../src/residency/CompositeResidencyOffer.tsx'), name => {
  if (name === './compositeResidencyOrder.ts') return planner;
  if (name.endsWith('.css')) return {};
  return require(name); });

const NOW = Date.parse('2026-11-18T09:00:00.000Z');
const input = (over = {}) => ({ category: 'GROUP_TRAINING', nowMs: NOW, existingResidency: 'NONE', levelDecision: null,
  participation: { productId: 'service-group', name: 'Групповая тренировка', exerciseId: 'exercise-1', basePriceMinor: 160000 },
  residencyProduct: { id: purchase.RESIDENCY_PRODUCT_ID, name: 'Резидентство', costMinor: 79000, observedAtMs: NOW },
  policy: { publicationId: 'publication-1', policyVersion: 2, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 }, ...over });
const render = (props) => renderToStaticMarkup(React.createElement(CompositeResidencyOffer, { onConsentChange() {}, consentAccepted: false, ...props }));

test('RES-004: unchecked consent shows the offer but no payable breakdown', () => {
  const html = render({ input: input() });
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /checked/);
  assert.match(html, /Оформить резидентство за 790 ₽/);
  assert.match(html, /скидку 50%/);
  assert.doesNotMatch(html, /Итого одной оплатой/);
});

test('RES-005: consent shows participation, residency and one total separately', () => {
  const html = render({ input: input(), consentAccepted: true });
  assert.match(html, /checked/);
  assert.match(html, /Участие<\/dt><dd><s>1\s600 ₽<\/s> 800 ₽/);
  assert.match(html, /Резидентство, 30 дней<\/dt><dd>790 ₽/);
  assert.match(html, /Итого одной оплатой<\/dt><dd>1\s590 ₽/);
});

test('RES-006 and failures: active residency explains, unknown state and games render nothing', () => {
  assert.match(render({ input: input({ existingResidency: 'ACTIVE' }) }), /уже есть резидентство/);
  assert.doesNotMatch(render({ input: input({ existingResidency: 'ACTIVE' }) }), /checkbox/);
  assert.equal(render({ input: input({ existingResidency: 'UNKNOWN' }) }), '');
  assert.equal(render({ input: input({ category: 'GAME' }) }), '');
  assert.equal(render({ input: input({ policy: null }) }), '');
  assert.match(render({ input: input({ residencyProduct: { ...input().residencyProduct, observedAtMs: NOW - 120000 } }) }), /Обновляем цену/);
});

test('the composite offer flag is off by default', () => {
  const config = readFileSync(new URL('../../src/residency/residencyConfig.ts', import.meta.url), 'utf8');
  assert.match(config, /COMPOSITE_RESIDENCY_ENABLED = readBoolean\(ENV\.VITE_LK1_COMPOSITE_RESIDENCY_ENABLED, false\)/);
});
