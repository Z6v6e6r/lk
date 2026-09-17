import type { TournamentVivaProduct } from "./tournamentSignupApi";
import { isEnergyVisitPackSubscriptionName, pickSubscriptionVisitsLeft } from "./subscriptionValidity.ts";

/** Only visit packs already offered for this exercise by the checkout API. */
export function getGroupScheduleOwnedPacks(products: TournamentVivaProduct[]): TournamentVivaProduct[] {
  return products.filter(product => {
    if (product.source !== "client-subscription" || product.lk1MoneyDiscountCandidate === true
      || !isEnergyVisitPackSubscriptionName(product.name)) return false;
    const visitsLeft = pickSubscriptionVisitsLeft(product.raw);
    return visitsLeft == null || visitsLeft > 0;
  });
}
