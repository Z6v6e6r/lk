// 2026-10-05 owner decision. Historic generations remain exact rollback priors.
import { HUB_POLICY_PRODUCT, buildHubPolicyTransition } from './lk1HubPolicyTransition.mjs';
import { LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS, LK1_PLAN_RULES_WITH_PATRIOTS,
  buildPlanRulesTransition } from './lk1PlanRulesTransition.mjs';

export const ACTIVE_BOOKING_LIMIT = 8;
export const HUB_POLICY_PRIOR = Object.freeze({ productId: HUB_POLICY_PRODUCT,
  maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 });
export const HUB_POLICY_LIMIT_8 = Object.freeze({ ...HUB_POLICY_PRIOR, maxActiveBookings: ACTIVE_BOOKING_LIMIT });
const withLimit8 = prior => Object.freeze({ formatVersion: prior.formatVersion,
  rules: Object.freeze(prior.rules.map(rule => Object.freeze({ ...rule, maxActiveBookings: ACTIVE_BOOKING_LIMIT }))) });
export const PLAN_RULES_LIMIT_8 = withLimit8(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS);
// This generation is for the separately authorized Patriots rollout; it does not activate it.
export const PLAN_RULES_WITH_PATRIOTS_LIMIT_8 = withLimit8(LK1_PLAN_RULES_WITH_PATRIOTS);
export const buildActiveBookingLimitTransitions = () => ({
  hub: buildHubPolicyTransition({ expectedPrior: HUB_POLICY_PRIOR, desired: HUB_POLICY_LIMIT_8, acceptEmptyPrior: true }),
  plans: buildPlanRulesTransition({ expectedPrior: LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS,
    desired: PLAN_RULES_LIMIT_8, acceptEmptyPrior: true }),
});
