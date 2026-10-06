// Offline preparation only. No default product ID, global writes or provider I/O.
import { PLAN_RULES_LIMIT_8 } from './lk1ActiveBookingLimit.mjs';
import { normalizePlanRules, LK1_HUB_PRODUCT_ID } from './lk1PlanRules.mjs';
import { buildPlanRulesTransition } from './lk1PlanRulesTransition.mjs';
import { isDeepStrictEqual } from 'node:util';

export const RA_PRODUCT_ID = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
export const RA_TWO_HOURS_PLAN_KEY = 'ra_two_hours';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESERVED_PRODUCTS = new Set([LK1_HUB_PRODUCT_ID,
  'dfa72adf-233b-4285-8d69-e5eab4234fbe', '9fb759fd-f70c-4395-84e7-57716df97e14',
  '37ab3713-4431-4815-96ba-d7ece76a9241']);

/** Inherits current RA semantics; only identity and free GAME minutes change. */
export function buildRaTwoHoursPlanRules({ productId, expectedPrior = PLAN_RULES_LIMIT_8 } = {}) {
  if (typeof productId !== 'string' || !UUID.test(productId)) {
    throw Error('RA 2.0 requires an explicit canonical Viva product UUID');
  }
  if (!isDeepStrictEqual(expectedPrior, PLAN_RULES_LIMIT_8)) {
    throw Error('RA 2.0 reviewed prior drift; review before generation');
  }
  const normalized = normalizePlanRules(expectedPrior);
  if (!normalized.ok || normalized.rules.size === 0) throw Error('RA 2.0 prior rules invalid or empty');
  if (normalized.rules.has(productId) || RESERVED_PRODUCTS.has(productId)
    || [...normalized.rules.values()].some(rule => rule.planKey === RA_TWO_HOURS_PLAN_KEY)) {
    throw Error('RA 2.0 product or plan key already bound');
  }
  const base = normalized.rules.get(RA_PRODUCT_ID);
  if (!base || base.planKey !== 'ra' || base.freeGameMinutesPerDay !== 60
    || base.maxActiveBookings !== 8 || base.gameOverageDiscountPercent !== 30
    || base.groupTrainingDiscountPercent !== 50 || base.tournamentDiscountPercent !== 50) {
    throw Error('RA 2.0 ordinary RA prior drift; review before generation');
  }
  const rule = { ...base, productId, planKey: RA_TWO_HOURS_PLAN_KEY, freeGameMinutesPerDay: 120 };
  const desired = { formatVersion: expectedPrior.formatVersion, rules: [...expectedPrior.rules, rule] };
  const forward = buildPlanRulesTransition({ expectedPrior, desired, acceptEmptyPrior: true });
  const reverse = buildPlanRulesTransition({ expectedPrior: desired, desired: expectedPrior, acceptEmptyPrior: true });
  return { rule, forward, reverse };
}

function replaceOnce(source, before, after, label) {
  if (typeof source !== 'string' || source.split(before).length !== 2) {
    throw Error(`RA 2.0 ${label} anchor drift`);
  }
  return source.replace(before, () => after);
}

/**
 * Reviewed source deltas for the booking/preview tables and PRO helper. Callers
 * must bind a real product first. These are NOT deployable flow artifacts: live
 * hashes, graph contract and the complete paired candidate are separate gates.
 */
export function buildRaTwoHoursSourceDeltas(options) {
  const { rule } = buildRaTwoHoursPlanRules(options);
  const productId = rule.productId;
  return {
    planStore: [
      { label: 'product table', before: `  ra: "${RA_PRODUCT_ID}",`,
        after: `  ra_two_hours: "${productId}",\n  ra: "${RA_PRODUCT_ID}",` },
      { label: 'category table', before: '  ra: ["open_game", "group_training", "tournament"],',
        after: '  ra_two_hours: ["open_game", "group_training", "tournament"],\n  ra: ["open_game", "group_training", "tournament"],' },
      { label: 'name classification',
        before: '  if (normalized.some((marker) => marker === "ра" || marker === "ra" || marker.includes("летопаделра") || marker.includes("padelra"))) return "ra";',
        after: '  if (normalized.some((marker) => ["ра20", "паделра20", "летопаделра20", "ra20", "padelra20", "ratwohours"].includes(marker))) return "ra_two_hours";\n'
          + '  if (normalized.some((marker) => marker === "ра" || marker === "ra" || marker.includes("летопаделра") || marker.includes("padelra"))) return "ra";' },
    ],
    freeFirst: [{ label: 'RA free-first event cohort',
      before: `  "${RA_PRODUCT_ID}": Object.freeze(["group_training", "tournament"]),`,
      after: `  "${productId}": Object.freeze(["group_training", "tournament"]),\n  "${RA_PRODUCT_ID}": Object.freeze(["group_training", "tournament"]),` }],
    proDiscount: [{ label: 'RA PRO discount cohort', before: `  "${RA_PRODUCT_ID}", // RA`,
      after: `  "${productId}", // RA 2.0\n  "${RA_PRODUCT_ID}", // RA` }],
  };
}

export function applyRaTwoHoursSourceDeltas(source, deltas) {
  return deltas.reduce((out, delta) => {
    if (out.includes(delta.after)) throw Error(`RA 2.0 ${delta.label} already installed`);
    return replaceOnce(out, delta.before, delta.after, delta.label);
  }, source);
}

export function revertRaTwoHoursSourceDeltas(source, deltas) {
  return [...deltas].reverse().reduce((out, delta) =>
    replaceOnce(out, delta.after, delta.before, `${delta.label} revert`), source);
}
