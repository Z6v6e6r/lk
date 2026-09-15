// Frozen rule payload for the LK1 plan-rules acceptance matrix (line T).
// Mirrors contract §1 (`subscriptions_lk1_plan_rules`, formatVersion 1) and the
// single HUB policy carried by `subscriptions_lk1_product_policy` (contract §1,
// «HUB-правило ... трактуется как enforceFrom: null»).
//
// The numbers are the frozen rule numbers (contract §0): maxActiveBookings=4,
// freeGameMinutesPerDay=60, gameOverageDiscountPercent=30,
// groupTrainingDiscountPercent=50, tournamentDiscountPercent=50. They must not
// be changed by this line.
import { HUB_PRODUCT_ID, PLAN_PRODUCTS } from './products.js';

export const ENFORCE_FROM = '2026-09-01';

export const LK1_PLAN_RULES_GLOBAL = 'subscriptions_lk1_plan_rules';
export const LK1_HUB_POLICY_GLOBAL = 'subscriptions_lk1_product_policy';

const frozenNumbers = Object.freeze({
  maxActiveBookings: 4,
  freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50,
  tournamentDiscountPercent: 50,
});

export const RULE_NUMBERS = frozenNumbers;

/** `subscriptions_lk1_product_policy` — HUB rule, read by the live sale nodes. */
export const HUB_POLICY = Object.freeze({
  productId: HUB_PRODUCT_ID,
  ...frozenNumbers,
});

/** Valid `subscriptions_lk1_plan_rules` document (formatVersion 1). */
export const PLAN_RULES_DOCUMENT = Object.freeze({
  formatVersion: 1,
  rules: Object.freeze(PLAN_PRODUCTS.map(product => Object.freeze({
    productId: product.productId,
    planKey: product.planKey,
    enforceFrom: ENFORCE_FROM,
    ...frozenNumbers,
  }))),
});

/** The five rule fields the evaluator consumes (contract §3.1). */
export const ruleFieldsOf = rule => Object.fromEntries(Object.entries(rule)
  .filter(([key]) => Object.hasOwn(frozenNumbers, key)));

/**
 * Fail-closed shapes: contract §1 requires each of these to be rejected with
 * `LK1_PLAN_RULES_INVALID` (and §2.1 removed the «several product ids» case from
 * that family — priority selection never produces this code).
 */
export const INVALID_PLAN_RULES = Object.freeze([
  { name: 'formatVersion 2', value: { ...PLAN_RULES_DOCUMENT, formatVersion: 2 } },
  { name: 'rules not an array', value: { formatVersion: 1, rules: {} } },
  {
    name: 'duplicate productId',
    value: {
      formatVersion: 1,
      rules: [PLAN_RULES_DOCUMENT.rules[0], { ...PLAN_RULES_DOCUMENT.rules[0], planKey: 'ra_copy' }],
    },
  },
  {
    name: 'non-uuid productId',
    value: {
      formatVersion: 1,
      rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], productId: 'not-a-uuid' }],
    },
  },
  {
    name: 'empty planKey',
    value: { formatVersion: 1, rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], planKey: '' }] },
  },
  {
    name: 'bad enforceFrom',
    value: { formatVersion: 1, rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], enforceFrom: '01.09.2026' }] },
  },
  {
    name: 'percent above 100',
    value: {
      formatVersion: 1,
      rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], gameOverageDiscountPercent: 101 }],
    },
  },
  {
    name: 'missing rule field',
    value: {
      formatVersion: 1,
      rules: [{
        productId: PLAN_PRODUCTS[0].productId,
        planKey: PLAN_PRODUCTS[0].planKey,
        enforceFrom: ENFORCE_FROM,
        maxActiveBookings: frozenNumbers.maxActiveBookings,
        freeGameMinutesPerDay: frozenNumbers.freeGameMinutesPerDay,
        gameOverageDiscountPercent: frozenNumbers.gameOverageDiscountPercent,
        groupTrainingDiscountPercent: frozenNumbers.groupTrainingDiscountPercent,
      }],
    },
  },
  {
    name: 'extra rule field',
    value: {
      formatVersion: 1,
      rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], unexpected: 1 }],
    },
  },
  {
    name: 'maxActiveBookings below one',
    value: {
      formatVersion: 1,
      rules: [{ ...PLAN_RULES_DOCUMENT.rules[0], maxActiveBookings: 0 }],
    },
  },
]);

/** Absent/empty global per contract §1: contour off, not an error. */
export const DISABLED_PLAN_RULES = Object.freeze([null, '', { formatVersion: 1, rules: [] }]);
