import { isSubscriptionEventDiscountQuote, matchSubscriptionEventDiscount, type SubscriptionEventDiscountQuote } from "./groupSubscriptionDiscount.ts";
import type { TournamentVivaProduct } from "./tournamentSignupApi.ts";

export function isChildTournamentExercise(exercise: Record<string, unknown> | null | undefined): boolean {
  const direction = exercise?.direction ?? exercise?.exerciseDirection;
  const nested = direction && typeof direction === "object" ? direction as Record<string, unknown> : null;
  const value = nested ? nested.id ?? nested.directionId : direction;
  const directionId = value ?? exercise?.directionId ?? exercise?.exerciseDirectionId;
  return directionId === 7108 || directionId === "7108";
}

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
  return matchSubscriptionEventDiscount(quotes, "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1", product);
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
