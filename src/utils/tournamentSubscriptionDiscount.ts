import { isSubscriptionEventDiscountQuote, type SubscriptionEventDiscountQuote } from "./groupSubscriptionDiscount.ts";
import type { TournamentVivaProduct } from "./tournamentSignupApi.ts";

export interface TournamentSubscriptionDiscountQuote extends SubscriptionEventDiscountQuote {
  kind: "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1";
}

export function isTournamentSubscriptionDiscountQuote(
  value: unknown,
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is TournamentSubscriptionDiscountQuote {
  return isSubscriptionEventDiscountQuote(value, "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1", exerciseId, actorClientId, now);
}

export function matchTournamentSubscriptionDiscount(
  quotes: TournamentSubscriptionDiscountQuote[],
  product: { id: string; cost: number | null; source: string },
): TournamentSubscriptionDiscountQuote | null {
  if (product.source !== "one-time") return null;
  return quotes.find(q => q.kind === "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1"
    && q.status === "AVAILABLE" && q.productId === product.id && q.basePriceMinor === product.cost) ?? null;
}

export function buildTournamentSubscriptionDiscountProduct(
  quote: TournamentSubscriptionDiscountQuote,
): TournamentVivaProduct {
  return {
    id: quote.subscriptionId, name: quote.subscriptionName, source: "client-subscription", type: "SUBSCRIPTION",
    cost: quote.amountMinor, visitsTotal: null, raw: { clientSubscriptionId: quote.subscriptionId },
    lk1MoneyDiscountCandidate: true, tournamentDiscountQuote: quote,
  };
}
