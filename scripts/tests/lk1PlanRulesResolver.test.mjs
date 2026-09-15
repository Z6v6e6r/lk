import { hubGatewaySource } from '../lib/eventPaymentSources.mjs';
import {
  LK1_HUB_PRODUCT_ID,
  LK1_PLAN_RULES_FROM,
  LK1_PLAN_RULES_GLOBAL,
  normalizePlanRules,
  resolveLk1Rule,
} from '../lib/lk1PlanRules.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const HUB = LK1_HUB_PRODUCT_ID;
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const FRIENDSHIP = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
const ACADEMY = '9eb8a7a4-c195-492a-95e4-3fb82899ac10';
const SPORT = '82caad6f-4d19-4d01-852b-932bdbb0f405';
const PROMO = ['6bda152b-0a9c-4308-82d0-3cd4e6aa680d', 'c079dc82-c716-4f0e-b9ad-6aab62fb789e',
  '3b4806f1-6f9a-46df-a7d7-45075b4e7274'];
const ENERGY_5 = 'dfa72adf-233b-4285-8d69-e5eab4234fbe';
const OTHER = '00000000-0000-4000-8000-000000000099';
const FIELDS = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const PLAN_KEYS = { [RA]: 'ra', [FRIENDSHIP]: 'friendship', [ACADEMY]: 'academy', [SPORT]: 'sport',
  [PROMO[0]]: 'promo_academy', [PROMO[1]]: 'promo_friendship', [PROMO[2]]: 'promo_ra' };

const planRule = (productId, enforceFrom = LK1_PLAN_RULES_FROM) =>
  ({ productId, planKey: PLAN_KEYS[productId], enforceFrom, ...FIELDS });
const planRules = (productIds, enforceFrom = LK1_PLAN_RULES_FROM) =>
  ({ formatVersion: 1, rules: productIds.map((id) => planRule(id, enforceFrom)) });
const hubPolicy = () => ({ productId: HUB, ...FIELDS });

// The resolver runs inside the Node-RED function scope, so the test evaluates the
// real module source with only the host helpers the gateway already provides.
const source = fs.readFileSync(new URL('../lib/lk1PlanRules.mjs', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const DEFAULT_DATES = () => ({ dates: ['2026-09-01'], invalid: false });
const bind = (host = {}) => new Function(
  'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence',
  'isValidDateKey', 'lk1ReadBoundPolicy', 'global',
  `${source}\nreturn { normalizePlanRules, resolveLk1Rule };`,
)(
  host.normalizeId || ((value) => (typeof value === 'string' ? value.trim().toLowerCase() : null)),
  host.collectExactProductIds || (() => []),
  host.collectSubscriptionPurchaseDateEvidence || DEFAULT_DATES,
  host.isValidDateKey || ((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  host.lk1ReadBoundPolicy || (() => hubPolicy()),
  host.global || { get: () => undefined },
);
const owned = (...productIds) => productIds.map((productId) => ({ productId }));
const dateFrom = (dates, invalid = false) => ({
  collectSubscriptionPurchaseDateEvidence: () => ({ dates, invalid }),
});

test('HUB rule is enforced for every sale date, including before the plan cutover', () => {
  for (const purchaseDate of ['2026-08-15', '2026-08-31', '2026-09-01', '2030-01-01']) {
    const result = bind(dateFrom([purchaseDate])).resolveLk1Rule({ owned: owned(HUB) });
    assert.equal(result.matched, true, purchaseDate);
    assert.equal(result.code, undefined, purchaseDate);
    assert.equal(result.legacy, false, purchaseDate);
    assert.equal(result.source, 'HUB', purchaseDate);
    assert.equal(result.productId, HUB, purchaseDate);
    assert.equal(result.enforceFrom, null, purchaseDate);
    assert.equal(result.productIdSource, 'PRODUCT_ID', purchaseDate);
    assert.deepEqual(result.rule, hubPolicy(), purchaseDate);
  }
});

test('plan products sold before the cutover stay legacy; the cutover day is enforced', () => {
  const rules = planRules([RA, FRIENDSHIP, ACADEMY, SPORT, ...PROMO]);
  for (const productId of [RA, FRIENDSHIP, ACADEMY, SPORT, ...PROMO]) {
    for (const [purchaseDate, legacy] of [['2026-08-31', true], ['2026-09-01', false], ['2026-09-02', false]]) {
      const result = bind({ collectSubscriptionPurchaseDateEvidence: () => ({ dates: [purchaseDate], invalid: false }) })
        .resolveLk1Rule({ owned: owned(productId), hubPolicy: hubPolicy(), planRules: rules });
      assert.equal(result.matched, true, `${productId} ${purchaseDate}`);
      assert.equal(result.code, undefined, `${productId} ${purchaseDate}`);
      assert.equal(result.legacy, legacy, `${productId} ${purchaseDate}`);
      assert.equal(result.source, 'PLAN');
      assert.equal(result.productId, productId);
      assert.equal(result.planKey, PLAN_KEYS[productId]);
      assert.equal(result.purchaseDate, purchaseDate);
      assert.equal(result.enforceFrom, LK1_PLAN_RULES_FROM);
      if (legacy) assert.deepEqual(result.rule, undefined);
      else {
        assert.deepEqual(Object.keys(result.rule).sort(),
          ['productId', 'planKey', 'enforceFrom', ...Object.keys(FIELDS)].sort());
        assert.deepEqual(result.rule, planRule(productId));
      }
    }
  }
});

test('the product of the selected instance decides by the D1 priority order', () => {
  const rules = planRules([RA, SPORT, ACADEMY]);
  const resolve = bind().resolveLk1Rule;
  // The live identity layer wins over every flat alias of the same instance.
  const live = { productId: SPORT, subscriptionProductId: SPORT, product: { id: SPORT }, templateId: SPORT,
    lk1ProductIdentity: { productId: RA, subscription: { productId: RA } } };
  const identity = resolve({ owned: [live], planRules: rules });
  assert.equal(identity.productId, RA);
  assert.equal(identity.productIdSource, 'IDENTITY_SUBSCRIPTION');
  assert.deepEqual(identity.extraProductIds, [SPORT]);
  assert.equal(identity.legacy, false);
  // The identity layer's own productId answers when the subscription row is absent.
  assert.equal(resolve({ owned: [{ lk1ProductIdentity: { productId: RA } }], planRules: rules }).productIdSource,
    'IDENTITY');
  // Even a rule on a lower-priority alias cannot outrank the selected product.
  assert.equal(resolve({ owned: [live], planRules: planRules([SPORT]) }).matched, false);
  // subscriptionProductId outranks productId; product.id outranks templateId.
  const cases = [
    [{ subscriptionProductId: RA, productId: OTHER, product: { id: SPORT }, templateId: SPORT }, RA, 'SUBSCRIPTION_PRODUCT_ID'],
    [{ productId: RA, product: { id: SPORT }, template: { id: SPORT } }, RA, 'PRODUCT_ID'],
    [{ product: { id: ACADEMY }, templateId: SPORT }, ACADEMY, 'PRODUCT'],
    [{ templateId: SPORT, template: { id: ACADEMY } }, SPORT, 'TEMPLATE_ID'],
    [{ template: { id: ACADEMY } }, ACADEMY, 'TEMPLATE'],
  ];
  for (const [record, productId, productIdSource] of cases) {
    const result = resolve({ owned: [record], planRules: rules });
    assert.equal(result.productId, productId, productIdSource);
    assert.equal(result.productIdSource, productIdSource);
  }
  // A non-UUID alias is ignored rather than used as a rule key.
  assert.equal(resolve({ owned: [{ productId: 'not-a-uuid', templateId: SPORT }], planRules: rules }).productId, SPORT);
});

test('diverging product ids in one instance are recorded, never blocking', () => {
  const rules = planRules([RA, SPORT, ACADEMY]);
  const resolve = bind().resolveLk1Rule;
  // A HUB product alongside a plan product is no longer an ambiguous ownership stop.
  const hubFirst = resolve({ owned: [{ productId: HUB, product: { id: RA } }], planRules: rules });
  assert.equal(hubFirst.code, undefined);
  assert.equal(hubFirst.source, 'HUB');
  assert.deepEqual(hubFirst.extraProductIds, [RA]);
  const planFirst = resolve({ owned: [{ productId: RA, product: { id: HUB } }], planRules: rules });
  assert.equal(planFirst.code, undefined);
  assert.equal(planFirst.source, 'PLAN');
  assert.equal(planFirst.productId, RA);
  assert.deepEqual(planFirst.extraProductIds, [HUB]);
  // Duplicate aliases collapse instead of reporting themselves as extras.
  const duplicate = resolve({ owned: [{ productId: RA, product: { id: RA }, templateId: RA }], planRules: rules });
  assert.deepEqual(duplicate.extraProductIds, []);
  assert.equal(duplicate.productIdSource, 'PRODUCT_ID');
});

test('a product without a rule stays legacy and never fails the request', () => {
  const rules = planRules([RA, ...PROMO]);
  const resolve = bind().resolveLk1Rule;
  const unmatched = { matched: false };
  for (const ownedIds of [[ENERGY_5], [ENERGY_5, RA], ['not-a-uuid'], [{ productId: 42 }]]) {
    assert.equal(resolve({ owned: ownedIds, planRules: rules }).matched, false, JSON.stringify(ownedIds));
  }
  assert.equal(resolve({ owned: owned(RA), planRules: { formatVersion: 1, rules: [] } }).matched, false);
  assert.deepEqual(resolve({ owned: [] }), unmatched);
  assert.deepEqual(resolve({}), unmatched);
  // The selected subscription row may arrive directly instead of in a list.
  assert.equal(resolve({ owned: { productId: RA }, planRules: rules }).legacy, false);
});

test('a missing or empty plan-rules global disables the contour instead of failing', () => {
  for (const stored of [undefined, null, '', 'null']) {
    for (const host of [{ global: { get: () => stored } }, {}]) {
      assert.equal(bind(host).resolveLk1Rule({ owned: owned(RA) }).matched, false, String(stored));
    }
  }
  const rules = planRules([RA]);
  for (const planRulesValue of [undefined, null, '', rules]) {
    const result = bind().resolveLk1Rule({ owned: owned(RA), planRules: planRulesValue, global: { get: () => undefined } });
    if (planRulesValue === rules) assert.equal(result.legacy, false);
    else assert.equal(result.matched, false, String(planRulesValue));
  }
  // An explicit empty rule set is a valid contour, not a missing global.
  const empty = bind({ global: { get: () => ({ formatVersion: 1, rules: [] }) } });
  assert.equal(empty.resolveLk1Rule({ owned: owned(RA) }).matched, false);
});

test('an unreadable or malformed plan-rules global fails closed', () => {
  const unreadable = { global: { get: () => { throw new Error('global store unavailable'); } } };
  assert.deepEqual(bind(unreadable).resolveLk1Rule({ owned: owned(RA) }),
    { matched: true, code: 'LK1_PLAN_RULES_INVALID', productId: RA, productIdSource: 'PRODUCT_ID', extraProductIds: [] });
  const malformed = [
    'not json', 42, [], {},
    { formatVersion: 2, rules: [] }, { formatVersion: 1 },
    { formatVersion: '1', rules: [] }, { formatVersion: 1, rules: {}, extra: true },
    { formatVersion: 1, rules: [{ ...planRule(RA), planKey: '' }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), planKey: '  ' }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), productId: 'not-a-uuid' }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), enforceFrom: '2026-9-1' }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), enforceFrom: '2026-02-30' }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), enforceFrom: 20260901 }] },
    { formatVersion: 1, rules: [planRule(RA), planRule(RA)] },
    { formatVersion: 1, rules: [{ ...planRule(RA), maxActiveBookings: 0 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), maxActiveBookings: 4.5 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), freeGameMinutesPerDay: -1 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), gameOverageDiscountPercent: 101 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), groupTrainingDiscountPercent: 101 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), tournamentDiscountPercent: -1 }] },
    { formatVersion: 1, rules: [{ ...planRule(RA), unknownField: 1 }] },
    { formatVersion: 1, rules: [{ productId: RA, planKey: 'ra', enforceFrom: null }] },
  ];
  for (const stored of malformed) {
    for (const value of [stored, typeof stored === 'string' ? stored : JSON.stringify(stored)]) {
      const result = bind(dateFrom(['2026-09-01'])).resolveLk1Rule({ owned: owned(RA), planRules: value });
      assert.equal(result.matched, true, JSON.stringify(value));
      assert.equal(result.code, 'LK1_PLAN_RULES_INVALID', JSON.stringify(value));
      assert.equal(result.legacy, undefined, JSON.stringify(value));
    }
  }
  assert.deepEqual(normalizePlanRules('not json'), { ok: false, code: 'LK1_PLAN_RULES_INVALID' });
});

test('normalizer accepts the frozen shape and rejects a surplus top-level key', () => {
  const normalized = normalizePlanRules(planRules([RA, ...PROMO]));
  assert.equal(normalized.ok, true);
  assert.equal(normalized.rules.size, 4);
  assert.deepEqual(normalized.rules.get(RA), planRule(RA));
  assert.deepEqual(normalizePlanRules(null), { ok: true, rules: new Map() });
  assert.deepEqual(normalizePlanRules(''), { ok: true, rules: new Map() });
  assert.equal(normalizePlanRules({ formatVersion: 1, rules: [], formatVersionExtra: 1 }).ok, false);
  assert.equal(normalizePlanRules(JSON.stringify(planRules([SPORT]))).rules.get(SPORT).planKey, 'sport');
  // An enforceFrom of null means the frozen cutover constant.
  const open = normalizePlanRules({ formatVersion: 1, rules: [{ ...planRule(RA), enforceFrom: null }] });
  assert.equal(open.ok, true);
  assert.equal(open.rules.get(RA).enforceFrom, null);
  // A rule set that is already normalized is accepted idempotently.
  const embedded = bind();
  assert.equal(embedded.normalizePlanRules(planRules([RA])).ok, true);
  assert.equal(embedded.resolveLk1Rule({ owned: owned(RA), planRules: normalized }).legacy, false);
  // An uppercase product id in the global normalizes to the canonical UUID.
  const upper = embedded.normalizePlanRules({ formatVersion: 1, rules: [{ ...planRule(RA), productId: RA.toUpperCase() }] });
  assert.equal(upper.ok, true);
  assert.equal(upper.rules.has(RA), true);
});

test('an unparseable or double sale date of the selected instance stops with the frozen code', () => {
  const rules = planRules([RA]);
  const cases = [
    { dates: [], invalid: false },
    { dates: [], invalid: true },
    { dates: ['2026-09-01', '2026-09-02'], invalid: false },
    { dates: [null], invalid: true },
    undefined,
    { dates: '2026-09-01', invalid: false },
    { dates: ['2026-09-01', null], invalid: true },
  ];
  for (const evidence of cases) {
    const result = bind({ collectSubscriptionPurchaseDateEvidence: () => evidence })
      .resolveLk1Rule({ owned: owned(RA), planRules: rules });
    assert.deepEqual([result.matched, result.code, result.legacy],
      [true, 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED', undefined], JSON.stringify(evidence));
  }
  const throwing = { collectSubscriptionPurchaseDateEvidence: () => { throw new Error('dates unavailable'); } };
  assert.equal(bind(throwing).resolveLk1Rule({ owned: owned(RA), planRules: rules }).code,
    'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED');
  // A legacy HUB subscription never consults the plan-rule sale date.
  assert.equal(bind(throwing).resolveLk1Rule({ owned: owned(HUB) }).legacy, false);
});

test('the HUB policy source keeps its own fail-closed codes', () => {
  const hub = (policy, host = {}) => bind({ lk1ReadBoundPolicy: () => policy, ...host })
    .resolveLk1Rule({ owned: owned(HUB) });
  assert.equal(hub(null).code, 'LK1_PRODUCT_RULE_OFF');
  assert.deepEqual(hub(JSON.stringify(hubPolicy())).rule, hubPolicy());
  for (const policy of [{ ...hubPolicy(), productId: RA }, { ...hubPolicy(), maxActiveBookings: 0 },
    { ...hubPolicy(), maxActiveBookings: 5.5 }, { ...hubPolicy(), gameOverageDiscountPercent: 101 },
    { ...hubPolicy(), extra: 1 }, { productId: HUB }, { ...hubPolicy(), freeGameMinutesPerDay: -1 }]) {
    assert.equal(hub(policy).code, 'LK1_PRODUCT_RULE_INVALID', JSON.stringify(policy));
  }
  assert.equal(hub(null, { lk1ReadBoundPolicy: () => { throw new Error('bound policy mismatch'); } }).code,
    'LK1_PRODUCT_RULE_SOURCE_MISMATCH');
  // A policy that is present but unparseable is judged as an invalid rule shape.
  assert.equal(hub('not json').code, 'LK1_PRODUCT_RULE_INVALID');
  // The HUB policy shape is judged even when plan rules are otherwise valid.
  assert.equal(hub({ ...hubPolicy(), tournamentDiscountPercent: 101 }).code, 'LK1_PRODUCT_RULE_INVALID');
});

test('per-product enforceFrom precedes the frozen cutover', () => {
  const rules = { formatVersion: 1, rules: [planRule(ACADEMY, '2026-10-01'), planRule(SPORT, null)] };
  const at = (date) => bind(dateFrom([date])).resolveLk1Rule({ owned: owned(ACADEMY), planRules: rules });
  assert.equal(at('2026-09-01').legacy, true);
  assert.equal(at('2026-09-30').legacy, true);
  assert.equal(at('2026-10-01').legacy, false);
  assert.equal(at('2026-09-01').enforceFrom, '2026-10-01');
  const sport = bind(dateFrom(['2026-08-31'])).resolveLk1Rule({ owned: owned(SPORT), planRules: rules });
  assert.equal(sport.legacy, true);
  assert.equal(sport.enforceFrom, LK1_PLAN_RULES_FROM);
});

test('the embedded module keeps the frozen API surface and host contract', () => {
  assert.equal(LK1_PLAN_RULES_GLOBAL, 'subscriptions_lk1_plan_rules');
  assert.equal(LK1_HUB_PRODUCT_ID, 'db7a5250-7369-4f43-8ac5-9111be24bc74');
  assert.equal(LK1_PLAN_RULES_FROM, '2026-09-01');
  assert.equal(typeof normalizePlanRules, 'function');
  assert.equal(typeof resolveLk1Rule, 'function');
  const embedded = bind();
  assert.equal(typeof embedded.normalizePlanRules, 'function');
  assert.equal(typeof embedded.resolveLk1Rule, 'function');
  // Only the host helpers the assembled gateway already provides may be referenced.
  const hostRefs = [...source.matchAll(/\b(?:collectExactProductIds|collectSubscriptionPurchaseDateEvidence|normalizeId|isValidDateKey|lk1ReadBoundPolicy|global)\b/g)]
    .map((match) => match[0]);
  assert.deepEqual([...new Set(hostRefs)].sort(),
    ['collectSubscriptionPurchaseDateEvidence', 'global', 'lk1ReadBoundPolicy']);
  // The resolver must not depend on the legacy HUB hardcode in the source header.
  assert.equal(source.includes(`const ${'LK1_OVERLAY_HUB_PRODUCT_ID'}`), false);
  // An absent isValidDateKey host helper still rejects an impossible calendar day
  // only when the host provides it; the regex fallback accepts the frozen shape.
  const withoutHost = new Function('normalizeId', 'collectSubscriptionPurchaseDateEvidence', 'lk1ReadBoundPolicy',
    'global', `${source}\nreturn normalizePlanRules;`)(
    (value) => value, DEFAULT_DATES, () => hubPolicy(), { get: () => undefined });
  assert.equal(withoutHost(planRules([RA])).ok, true);
  assert.equal(withoutHost({ formatVersion: 1, rules: [{ ...planRule(RA), enforceFrom: '2026-9-1' }] }).ok, false);
});

test('the selected instance supplies the sale date, not its siblings', () => {
  const rules = planRules([RA]);
  const dates = (value) => {
    const records = Array.isArray(value) ? value : [value];
    return { dates: records.map((record) => record?.purchaseDate).filter(Boolean), invalid: false };
  };
  const resolve = (input) => bind({ collectSubscriptionPurchaseDateEvidence: dates }).resolveLk1Rule(input);
  const first = { productId: RA, purchaseDate: '2026-09-01' };
  const sibling = { productId: RA, purchaseDate: '2026-08-01' };
  const result = resolve({ owned: [first, sibling], planRules: rules });
  assert.equal(result.purchaseDate, '2026-09-01');
  assert.equal(result.legacy, false);
  const reordered = resolve({ owned: [sibling, first], planRules: rules });
  assert.equal(reordered.purchaseDate, '2026-08-01');
  assert.equal(reordered.legacy, true);
  const selected = resolve({ owned: { productId: RA, purchaseDate: '2026-09-05' }, planRules: rules });
  assert.equal(selected.purchaseDate, '2026-09-05');
});

// The gateway decides whether the enforcement contour exists at all before it
// builds any policy input. The verdicts themselves are covered by the resolver
// cases above (run with the real module source); these cases bind the exact
// gateway lines that turn those verdicts into the managed contour, so a regression
// in the wiring cannot pass unnoticed.
const gatewaySource = hubGatewaySource();
const gatewayHooks = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8');
const region = (text, startMarker, endMarker) => {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `fragment start missing: ${startMarker.slice(0, 40)}`);
  const end = endMarker === null ? text.length : text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `fragment end missing: ${startMarker.slice(0, 40)}`);
  return text.slice(start, end);
};
const GATEWAY_CONFIG = region(gatewaySource, 'const LK1_OVERLAY_HUB_PRODUCT_ID = ', 'const lk1Stop = (ctx, code)');
const GATEWAY_QUOTE = region(gatewaySource, 'const lk1Quote = (ctx, exercise, owned) => {', 'const lk1Finish = (ctx)');
const MANAGED_BLOCK = region(gatewayHooks, '// HUB_EXERCISE', '// HUB_RECHECK');
// The gateway calls the embedded resolver; the fallback exists only so the main
// sources stay executable until the release generation injects the module.
// lk1Config is the last declaration of the config fragment, so the slice runs to
// its end rather than to a marker inside it.
const gatewayConfigCall = () => region(GATEWAY_CONFIG, 'const lk1Config = (owned) => {', null);

test('the gateway delegates the rule verdict to the embedded resolver', () => {
  const call = gatewayConfigCall();
  assert.equal(call.includes('const planRules = lk1ReadPlanRules();'), true, 'plan-rules global read drift');
  assert.equal(call.includes('resolveLk1Rule({ owned, planRules })'), true, 'embedded resolver not called');
  assert.equal(call.includes('lk1ConfigRule(owned, planRules)'), true, 'fallback binding drift');
  assert.equal(call.includes('const rule = { productId: configured.productId };'), true,
    'the rule product id must come from the selected rule');
  // The two date gates that used to block a HUB sale before 2026-09-01 are gone.
  assert.equal(GATEWAY_CONFIG.includes('dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM'), false,
    'lk1Config must not keep a sale-date gate');
  assert.equal(GATEWAY_QUOTE.includes('dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM'), false,
    'lk1Quote must not keep a sale-date gate');
  assert.equal(GATEWAY_QUOTE.includes('if (configured.legacy) return { legacy: true };'), true,
    'lk1Quote must follow the resolver cohort verdict');
});

test('the gateway enters the managed contour only for matched && !legacy', () => {
  assert.equal(gatewayHooks.includes('if (productRule.matched && !productRule.legacy) {'), true,
    'HUB_EXERCISE managed gate drift');
  assert.equal(gatewayHooks.includes('if (productRule.matched) {'), false, 'ungated managed entry');
  assert.equal(MANAGED_BLOCK.includes('if (productRule.matched && !productRule.legacy) {'), true,
    'managed branch must require the enforced cohort');
  assert.equal(gatewayHooks.includes(`if ((ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding) && !productRule.matched
  && !productRule.legacy)`), true, 'create-cohort gate drift');
  // ctx.lk1 is assigned only inside that branch, and the policy input is built only
  // from ctx.lk1, so a legacy or unmatched subscription can never carry lk1Policy.
  assert.equal(region(gatewayHooks, '// HUB_EXERCISE', '// HUB_RECHECK')
    .includes('ctx.lk1 = quote;'), true, 'ctx.lk1 assignment drift');
  // The policy input sits inside the lk1_usage_operations step, which is reached
  // only after ctx.lk1 was set by the managed branch above.
  assert.equal(gatewaySource.includes('if (ctx.step === "lk1_usage_operations") {'), true,
    'managed policy step missing');
  assert.equal(region(gatewaySource, 'if (ctx.step === "lk1_usage_operations") {', 'delete ctx.lk1.bookings;')
    .includes('lk1Policy: policy,'), true, 'lk1Policy must be built inside the managed step');
  assert.equal(gatewaySource.includes('action: ctx.managedAction, lk1Policy: policy,'), true, 'lk1Policy input drift');
});

test('the policy binding carries the rule product id, never a hardcoded HUB id', () => {
  assert.equal(gatewaySource.includes('lk1ProductBinding: { policyProductId: ctx.lk1.rule.productId,'), true,
    'binding must carry the rule product id');
  assert.equal(gatewaySource.includes('policyProductId: "db7a5250'), false, 'hardcoded binding product id');
  assert.equal(gatewaySource.includes('policyProductId: LK1_OVERLAY_HUB_PRODUCT_ID'), false,
    'hardcoded binding product constant');
  // The fallback keeps the same verdicts as the resolver for the flat aliases.
  const fallback = region(GATEWAY_CONFIG, 'const lk1ConfigRule = (owned, planRules) => {', 'const lk1Config = (owned)');
  assert.equal(fallback.includes('return { matched: false, ...evidence };'), true, 'unmatched must stay legacy');
  assert.equal(fallback.includes('if (productId === LK1_OVERLAY_HUB_PRODUCT_ID) {'), true, 'HUB branch drift');
  assert.equal(fallback.includes('matched.enforceFrom === null ? LK1_PLAN_RULES_FROM : matched.enforceFrom'), true,
    'plan cutover default drift');
});
