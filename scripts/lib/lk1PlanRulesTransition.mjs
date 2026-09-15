// A source-bound transition for the LK1 plan-rules global, not an admin API.
//
// The rollout global is the only runtime input of the plan-rules resolver embedded
// in the booking gateway (scripts/lib/lk1PlanRules.mjs). Without it the contour is
// off for every plan product (rules 1/2/4/5 keep working, rule 3 does not), so the
// activation ships inside the Node-RED generation as reviewed, versioned code
// rather than as an out-of-band admin write.
//
// Shape and semantics are frozen by docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md
// section 1; the payload below is the product decision and must not be edited.
export const LK1_PLAN_RULES_KEY = 'subscriptions_lk1_plan_rules';

export const LK1_PLAN_RULES_FIELDS = Object.freeze(['maxActiveBookings', 'freeGameMinutesPerDay',
  'gameOverageDiscountPercent', 'groupTrainingDiscountPercent', 'tournamentDiscountPercent']);

// The five rule numbers are identical for every product.
const rule = (productId, planKey) => ({
  productId,
  planKey,
  enforceFrom: '2026-09-01',
  maxActiveBookings: 4,
  freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50,
  tournamentDiscountPercent: 50,
});

export const LK1_PLAN_RULES_DESIRED = Object.freeze({
  formatVersion: 1,
  rules: Object.freeze([
    rule('b91e14d1-fe6e-4d0b-be39-3e45ad86b759', 'ra'),
    rule('b2e6a9d4-53b5-4f79-87ec-3fb076381e9b', 'friendship'),
    rule('9eb8a7a4-c195-492a-95e4-3fb82899ac10', 'academy'),
    rule('82caad6f-4d19-4d01-852b-932bdbb0f405', 'sport'),
    rule('6bda152b-0a9c-4308-82d0-3cd4e6aa680d', 'promo_academy'),
    rule('c079dc82-c716-4f0e-b9ad-6aab62fb789e', 'promo_friendship'),
    rule('3b4806f1-6f9a-46df-a7d7-45075b4e7274', 'promo_ra'),
  ]),
});

// Missing/empty means "no plan-rules global yet", which is a legitimate prior.
// Everything else must match the frozen shape exactly: a surplus, missing or
// mistyped key is a hard refusal, never a silent coercion.
function normalizePlanRulesGlobal(value, fields) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') value = JSON.parse(value);
  const isObject = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const dateKey = /^\d{4}-\d{2}-\d{2}$/;
  if (!isObject(value) || value.formatVersion !== 1 || !Array.isArray(value.rules)
    || Object.keys(value).sort().join() !== ['formatVersion', 'rules'].sort().join()) {
    throw new Error('LK1 plan rules shape mismatch');
  }
  const seen = new Set();
  const rules = value.rules.map(item => {
    if (!isObject(item)
      || Object.keys(item).sort().join()
        !== ['productId', 'planKey', 'enforceFrom', ...fields].sort().join()) {
      throw new Error('LK1 plan rules shape mismatch');
    }
    const productId = typeof item.productId === 'string' ? item.productId.trim().toLowerCase() : '';
    if (!uuid.test(productId) || seen.has(productId)
      || typeof item.planKey !== 'string' || item.planKey.trim() === ''
      || (item.enforceFrom !== null
        && (typeof item.enforceFrom !== 'string' || !dateKey.test(item.enforceFrom)))
      || fields.some(key => !Number.isSafeInteger(item[key]) || item[key] < 0)
      || item.maxActiveBookings < 1 || fields.slice(2).some(key => item[key] > 100)) {
      throw new Error('LK1 plan rules shape mismatch');
    }
    seen.add(productId);
    // Canonical key order, so the write/compare stays a JSON.stringify equality.
    return Object.fromEntries([['productId', productId], ['planKey', item.planKey],
      ['enforceFrom', item.enforceFrom], ...fields.map(key => [key, item[key]])]);
  });
  return { formatVersion: 1, rules };
}

export function buildPlanRulesTransition({ expectedPrior, desired } = {}) {
  // Explicit null means "no global yet". Missing options cannot silently become a
  // transition, and a later rule change must name the exact prior it replaces.
  if (expectedPrior === undefined || desired === undefined) {
    throw new Error('Explicit plan-rules prior and desired global required');
  }
  const prior = normalizePlanRulesGlobal(expectedPrior, LK1_PLAN_RULES_FIELDS);
  const next = normalizePlanRulesGlobal(desired, LK1_PLAN_RULES_FIELDS);
  const declarations = `const lk1PlanRulesKey = ${JSON.stringify(LK1_PLAN_RULES_KEY)};
const lk1DesiredPlanRules = ${JSON.stringify(next)};
const lk1NormalizePlanRules = value => (${normalizePlanRulesGlobal.toString()})(value, ${JSON.stringify(LK1_PLAN_RULES_FIELDS)});
`;
  const initialize = declarations + `const lk1PlanRulesExpectedPrior = ${JSON.stringify(prior)};
const lk1PlanRulesCurrent = lk1NormalizePlanRules(global.get(lk1PlanRulesKey));
if (JSON.stringify(lk1PlanRulesCurrent) !== JSON.stringify(lk1DesiredPlanRules)) {
  if (JSON.stringify(lk1PlanRulesCurrent) !== JSON.stringify(lk1PlanRulesExpectedPrior)) throw new Error("plan rules prior mismatch; no overwrite");
  global.set(lk1PlanRulesKey, lk1DesiredPlanRules);
}
if (JSON.stringify(lk1NormalizePlanRules(global.get(lk1PlanRulesKey))) !== JSON.stringify(lk1DesiredPlanRules)) {
  throw new Error("plan rules readback mismatch");
}
`;
  return { expectedPrior: prior, desired: next, initialize };
}
