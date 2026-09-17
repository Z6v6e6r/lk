import { resolveSubscriptionCategoryDailyLimitPlanKey } from "./subscriptionCategoryDailyLimit.ts";
import type { GroupSubscriptionDiscountQuote } from "./groupSubscriptionDiscount.ts";
import type { TournamentVivaProduct } from "./tournamentSignupApi.ts";

/** Marketing visibility only; booking prices and eligibility remain server-owned. */
export function hasGroupTrainingSubscription(subscriptions: Array<{ status: string; name: string | null }>): boolean {
  return subscriptions.some(subscription => {
    const plan = resolveSubscriptionCategoryDailyLimitPlanKey(subscription);
    return subscription.status === "ACTIVE" && (plan === "ra" || plan === "academy");
  });
}

/** Checkout availability and validated quotes can identify a plan missing from the profile list. */
export function hasGroupTrainingSubscriptionEvidence(
  products: TournamentVivaProduct[],
  quotes: GroupSubscriptionDiscountQuote[],
): boolean {
  return hasGroupTrainingSubscription([
    ...products.filter(product => product.source === "client-subscription")
      .map(product => ({ ...product, status: "ACTIVE" })),
    ...quotes.filter(quote => quote.status === "AVAILABLE")
      .map(quote => ({ name: quote.subscriptionName, status: "ACTIVE" })),
  ]);
}
