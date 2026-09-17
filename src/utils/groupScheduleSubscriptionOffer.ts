import { resolveSubscriptionCategoryDailyLimitPlanKey } from "./subscriptionCategoryDailyLimit.ts";

/** Marketing visibility only; booking prices and eligibility remain server-owned. */
export function hasGroupTrainingSubscription(subscriptions: Array<{ status: string; name: string | null }>): boolean {
  return subscriptions.some(subscription => {
    const plan = resolveSubscriptionCategoryDailyLimitPlanKey(subscription);
    return subscription.status === "ACTIVE" && (plan === "ra" || plan === "academy");
  });
}
