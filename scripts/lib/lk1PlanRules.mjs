// LK1 plan-rules resolver: the single source of truth for which subscription
// products enter the managed enforcement contour and from which sale date.
// This module is embedded verbatim into the HUB Node-RED gateway at build time;
// its API and semantics are frozen by docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md
// (including decision D1 / section 2.1).
export const LK1_PLAN_RULES_GLOBAL = "subscriptions_lk1_plan_rules";
export const LK1_HUB_PRODUCT_ID = "db7a5250-7369-4f43-8ac5-9111be24bc74";
export const LK1_PLAN_RULES_FROM = "2026-09-01";

const LK1_PLAN_RULE_FIELDS = ["maxActiveBookings", "freeGameMinutesPerDay",
  "gameOverageDiscountPercent", "groupTrainingDiscountPercent", "tournamentDiscountPercent"];

const LK1_PLAN_PRODUCT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const LK1_PLAN_RULES_INVALID = Object.freeze({ ok: false, code: "LK1_PLAN_RULES_INVALID" });

const lk1IsObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const lk1ProductCandidate = (value) => {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  return LK1_PLAN_PRODUCT_PATTERN.test(id) ? id : null;
};

const lk1IsDateKey = (value) => {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === "string" ? value : "");
  if (!matched) return false;
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  // Month lengths are computed here so a rule cannot introduce a date the host
  // calendar helper would have to vouch for; an impossible day is refused either way.
  const days = month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day >= 1 && day <= days;
};

// Product of the selected instance, by the D1 priority order. Diverging product
// ids in the same instance are receipt evidence, never a reason to stop.
function lk1ResolveProductIdentity(selected, owned) {
  const records = Array.isArray(owned) ? owned.filter(lk1IsObject) : lk1IsObject(owned) ? [owned] : [];
  const record = lk1IsObject(selected) ? selected : records[0] || null;
  const identity = lk1IsObject(record?.lk1ProductIdentity) ? record.lk1ProductIdentity : null;
  const candidates = [
    // The live body carries the server-side identity layer; main sources do not,
    // so every access stays optional and an absent layer changes nothing.
    [lk1ProductCandidate(identity?.subscription?.productId), "IDENTITY_SUBSCRIPTION"],
    [lk1ProductCandidate(identity?.productId), "IDENTITY"],
    [lk1ProductCandidate(record?.subscriptionProductId), "SUBSCRIPTION_PRODUCT_ID"],
    [lk1ProductCandidate(record?.productId), "PRODUCT_ID"],
    [lk1ProductCandidate(record?.product?.id), "PRODUCT"],
    [lk1ProductCandidate(record?.templateId), "TEMPLATE_ID"],
    [lk1ProductCandidate(record?.template?.id), "TEMPLATE"],
  ].filter(([id]) => id !== null);
  const productId = candidates.length > 0 ? candidates[0][0] : null;
  const source = candidates.length > 0 ? candidates[0][1] : null;
  return { record, productId, source,
    extraProductIds: productId === null ? []
      : [...new Set(candidates.map(([id]) => id).filter((id) => id !== productId))] };
}

// An empty, missing or blank global means "contour off for plan products", never an error.
export function normalizePlanRules(value) {
  if (value === undefined || value === null || value === "") return { ok: true, rules: new Map() };
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return LK1_PLAN_RULES_INVALID; }
    if (value === null || value === undefined || value === "") return { ok: true, rules: new Map() };
  }
  if (!lk1IsObject(value) || value.formatVersion !== 1 || !Array.isArray(value.rules)
    || Object.keys(value).sort().join() !== ["formatVersion", "rules"].sort().join()) {
    return LK1_PLAN_RULES_INVALID;
  }
  const rules = new Map();
  for (const item of value.rules) {
    // Exactly the frozen key set: a missing or surplus key is a hard refusal.
    if (!lk1IsObject(item) || Object.keys(item).sort().join()
      !== ["enforceFrom", "planKey", "productId", ...LK1_PLAN_RULE_FIELDS].sort().join()) {
      return LK1_PLAN_RULES_INVALID;
    }
    const productId = lk1ProductCandidate(item.productId);
    if (!productId || rules.has(productId)
      || typeof item.planKey !== "string" || item.planKey.trim() === ""
      || (item.enforceFrom !== null && !lk1IsDateKey(item.enforceFrom))) {
      return LK1_PLAN_RULES_INVALID;
    }
    if (LK1_PLAN_RULE_FIELDS.some((key) => !Number.isSafeInteger(item[key]) || item[key] < 0)
      || item.maxActiveBookings < 1
      || LK1_PLAN_RULE_FIELDS.slice(2).some((key) => item[key] > 100)) {
      return LK1_PLAN_RULES_INVALID;
    }
    const rule = { productId, planKey: item.planKey, enforceFrom: item.enforceFrom };
    for (const key of LK1_PLAN_RULE_FIELDS) rule[key] = item[key];
    rules.set(productId, rule);
  }
  return { ok: true, rules };
}

// The resolver is idempotent over its own normalizer output so a caller that
// already read and normalized the global pays for neither the read nor the parse.
function lk1PlanRuleSet(value) {
  if (lk1IsObject(value) && typeof value.ok === "boolean"
    && (value.ok === false || typeof value.rules?.get === "function")) return value;
  try { return normalizePlanRules(value); } catch { return LK1_PLAN_RULES_INVALID; }
}

export function resolveLk1Rule({ owned, hubPolicy, planRules } = {}) {
  const { record, productId, source, extraProductIds } = lk1ResolveProductIdentity(null, owned);
  // Ownership that names no exact product cannot select a rule: legacy, no error.
  if (productId === null) return { matched: false };
  const evidence = { productId, productIdSource: source, extraProductIds };
  if (productId !== null && productId === LK1_HUB_PRODUCT_ID) {
    try {
      // An explicitly supplied policy wins; otherwise the bound source global is
      // read, and its mismatch is the historical fail-closed code.
      // eslint-disable-next-line no-undef -- injected by the Node-RED host
      const raw = hubPolicy !== undefined ? hubPolicy : lk1ReadBoundPolicy();
      if (raw === null) return { matched: true, code: "LK1_PRODUCT_RULE_OFF", ...evidence };
      // An unparseable policy is an invalid rule shape, not a source mismatch.
      let policy = raw;
      if (typeof policy === "string") {
        try { policy = JSON.parse(policy); } catch { policy = null; }
      }
      if (!lk1IsObject(policy) || lk1ProductCandidate(policy.productId) !== LK1_HUB_PRODUCT_ID
        || Object.keys(policy).sort().join() !== ["productId", ...LK1_PLAN_RULE_FIELDS].sort().join()
        || LK1_PLAN_RULE_FIELDS.some((key) => !Number.isSafeInteger(policy[key]) || policy[key] < 0)
        || policy.maxActiveBookings < 1
        || LK1_PLAN_RULE_FIELDS.slice(2).some((key) => policy[key] > 100)) {
        return { matched: true, code: "LK1_PRODUCT_RULE_INVALID", ...evidence };
      }
      const rule = { productId: policy.productId };
      for (const key of LK1_PLAN_RULE_FIELDS) rule[key] = policy[key];
      // The HUB rule carries no sale-date gate: the contour is on for every sale.
      return { matched: true, legacy: false, source: "HUB", productId: policy.productId, rule,
        purchaseDate: null, enforceFrom: null, ...evidence };
    } catch { return { matched: true, code: "LK1_PRODUCT_RULE_SOURCE_MISMATCH", ...evidence }; }
  }
  // An explicit rule set wins; otherwise the rollout global is read, and an absent
  // global means the plan contour is off rather than an error.
  const configured = lk1PlanRuleSet(planRules !== undefined ? planRules
    : typeof lk1InternalPlanRules === "function" ? lk1InternalPlanRules() : undefined);
  if (configured.ok !== true) return { matched: true, code: "LK1_PLAN_RULES_INVALID", ...evidence };
  const rule = configured.rules.get(productId);
  // No rule for the selected product: untouched legacy behaviour, not an error.
  if (rule === undefined) return { matched: false, ...evidence };
  // The sale date belongs to the selected instance, not to sibling subscriptions.
  let dates;
  // eslint-disable-next-line no-undef -- injected by the Node-RED host
  try { dates = collectSubscriptionPurchaseDateEvidence(record ?? owned); } catch { dates = null; }
  if (!lk1IsObject(dates) || dates.invalid || !Array.isArray(dates.dates) || dates.dates.length !== 1) {
    return { matched: true, code: "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED", ...evidence };
  }
  const purchaseDate = dates.dates[0];
  const enforceFrom = rule.enforceFrom === null ? LK1_PLAN_RULES_FROM : rule.enforceFrom;
  // Inclusive comparison against the Moscow calendar date of the sale.
  const legacy = purchaseDate < enforceFrom;
  return { matched: true, legacy, source: "PLAN", productId: rule.productId,
    planKey: rule.planKey, enforceFrom, purchaseDate, ...evidence,
    ...(legacy ? {} : { rule }) };
}

// The embedded gateway reads the rollout global through this hook; an unreadable
// global is an invalid rule set (fail-closed), an absent one means contour off.
function lk1InternalPlanRules() {
  try { return global.get(LK1_PLAN_RULES_GLOBAL); } catch { return LK1_PLAN_RULES_INVALID; }
}
