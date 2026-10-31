import {
  isGroupSubscriptionDiscountQuote,
  matchGroupSubscriptionDiscount,
  type GroupSubscriptionQuote,
} from "./groupSubscriptionDiscount.ts";
import {
  buildTournamentSubscriptionDiscountProduct,
  isTournamentSubscriptionDiscountQuote,
  matchTournamentSubscriptionDiscount,
  type TournamentSubscriptionDiscountQuote,
} from "./tournamentSubscriptionDiscount.ts";
import type { TournamentVivaProduct } from "./tournamentSignupApi.ts";

export type GroupScheduleSubscriptionQuote = GroupSubscriptionQuote | TournamentSubscriptionDiscountQuote;

/** Corporate events share the schedule UI; this exact Viva pair uses tournament pricing. */
export function isPatriotsTournament(value: { directionId: number | null; typeId: number | null } | null): boolean {
  return value?.directionId === 6306 && value.typeId === 2349;
}

export function isGroupScheduleSubscriptionQuote(
  value: unknown,
  tournament: boolean,
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is GroupScheduleSubscriptionQuote {
  return tournament
    ? isTournamentSubscriptionDiscountQuote(value, exerciseId, actorClientId, now)
    : isGroupSubscriptionDiscountQuote(value, exerciseId, actorClientId, now);
}

export function matchGroupScheduleSubscriptionDiscount(
  quotes: GroupScheduleSubscriptionQuote[],
  product: { id: string; cost: number | null; source: string },
  tournament: boolean,
  directionId: number | null,
): GroupScheduleSubscriptionQuote | null {
  return tournament
    ? matchTournamentSubscriptionDiscount(quotes.filter(q => q.kind === "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1"), product)
    : matchGroupSubscriptionDiscount(quotes.filter(q => q.kind !== "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1"), product, directionId);
}

export function buildGroupScheduleSubscriptionDiscountProduct(quote: GroupScheduleSubscriptionQuote): TournamentVivaProduct {
  if (quote.kind === "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1") return buildTournamentSubscriptionDiscountProduct(quote);
  return {
    id: quote.subscriptionId, name: quote.subscriptionName, source: "client-subscription", type: "SUBSCRIPTION",
    cost: quote.amountMinor, visitsTotal: null, raw: { clientSubscriptionId: quote.subscriptionId },
    lk1MoneyDiscountCandidate: true, groupDiscountQuote: quote,
  };
}
