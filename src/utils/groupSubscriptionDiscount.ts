/** Authenticated, event-bound monetary quote; amounts are kopecks. */
export interface SubscriptionEventDiscountQuote {
  kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1" | "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1";
  exerciseId: string;
  actorClientId: string;
  subscriptionId: string;
  subscriptionName: string;
  productId: string;
  status: "AVAILABLE" | "LIMIT_USED" | "UNAVAILABLE";
  discountPercent: number;
  basePriceMinor: number;
  amountMinor: number | null;
  /**
   * Minutes of the event carried by the subscription's free hour (0 for a flat quote) and
   * minutes the client pays for (the whole event for a flat quote). The club plan «Дружба
   * Топократы» quotes its training as the paid share above the free hour.
   */
  freeMinutes?: number;
  paidMinutes?: number;
  startsAt: string;
  durationMinutes: number;
  evaluatedAt: number;
  expiresAt: number;
}

/**
 * True when the quote charges only the paid share of the event (the club training co-pay).
 * The share has to add up to the event, so a quote whose minutes do not cover its own
 * duration is never treated as a co-pay — neither for the label nor for the amount.
 */
export function isPartialSubscriptionEventDiscountQuote(
  quote: Pick<SubscriptionEventDiscountQuote, "freeMinutes" | "paidMinutes" | "durationMinutes">,
): boolean {
  const freeMinutes = quote.freeMinutes as number;
  const paidMinutes = quote.paidMinutes as number;
  return Number.isSafeInteger(freeMinutes) && freeMinutes > 0
    && Number.isSafeInteger(paidMinutes) && paidMinutes > 0
    && Number.isSafeInteger(quote.durationMinutes) && quote.durationMinutes > 0
    && freeMinutes + paidMinutes === quote.durationMinutes;
}

/**
 * The amount a quote must carry: the whole base less the discount, or — for a paid share —
 * the charged share of the base less the same discount on it.
 */
export function subscriptionEventQuoteAmountMinor(
  quote: Pick<SubscriptionEventDiscountQuote,
    "basePriceMinor" | "discountPercent" | "durationMinutes" | "freeMinutes" | "paidMinutes">,
): number | null {
  if (!Number.isSafeInteger(quote.basePriceMinor) || quote.basePriceMinor <= 0
    || !Number.isSafeInteger(quote.discountPercent) || quote.discountPercent < 0 || quote.discountPercent > 100
    || !Number.isSafeInteger(quote.durationMinutes) || quote.durationMinutes <= 0) return null;
  const paidShare = isPartialSubscriptionEventDiscountQuote(quote);
  const chargedMinor = paidShare
    ? Math.floor(quote.basePriceMinor * (quote.paidMinutes as number) / quote.durationMinutes)
    : quote.basePriceMinor;
  return chargedMinor - Math.floor(chargedMinor * quote.discountPercent / 100);
}

export interface GroupSubscriptionDiscountQuote extends SubscriptionEventDiscountQuote {
  kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1";
}

export function isSubscriptionEventDiscountQuote(
  value: unknown,
  kind: SubscriptionEventDiscountQuote["kind"],
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is SubscriptionEventDiscountQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as SubscriptionEventDiscountQuote;
  return q.kind === kind
    && q.exerciseId === exerciseId && q.actorClientId === actorClientId
    && typeof q.subscriptionId === "string" && Boolean(q.subscriptionId.trim())
    && typeof q.subscriptionName === "string" && Boolean(q.subscriptionName.trim())
    && typeof q.productId === "string" && Boolean(q.productId.trim())
    && q.status === "AVAILABLE" && Number.isSafeInteger(q.discountPercent) && q.discountPercent >= 0 && q.discountPercent <= 100
    && Number.isSafeInteger(q.basePriceMinor) && q.basePriceMinor > 0 && q.basePriceMinor <= 1_000_000
    && Number.isSafeInteger(q.amountMinor)
    && q.amountMinor === subscriptionEventQuoteAmountMinor(q)
    && Number.isFinite(Date.parse(q.startsAt)) && Date.parse(q.startsAt) > now
    && Number.isSafeInteger(q.durationMinutes) && q.durationMinutes > 0 && q.durationMinutes <= 720
    && Number.isFinite(q.evaluatedAt) && Number.isFinite(q.expiresAt)
    && q.evaluatedAt <= now + 5000 && q.expiresAt > now
    && q.expiresAt > q.evaluatedAt && q.expiresAt - q.evaluatedAt <= 60_000;
}

export function isGroupSubscriptionDiscountQuote(
  value: unknown,
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is GroupSubscriptionDiscountQuote {
  return isSubscriptionEventDiscountQuote(value, "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1", exerciseId, actorClientId, now);
}

export function matchGroupSubscriptionDiscount(
  quotes: GroupSubscriptionDiscountQuote[],
  product: { id: string; cost: number | null; source: string },
): GroupSubscriptionDiscountQuote | null {
  if (product.source !== "one-time") return null;
  return quotes.reduce<GroupSubscriptionDiscountQuote | null>((best, quote) => {
    if (quote.kind !== "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1"
      || quote.status !== "AVAILABLE" || quote.productId !== product.id || quote.basePriceMinor !== product.cost
      || quote.amountMinor == null) return best;
    return !best || quote.amountMinor < best.amountMinor! ? quote : best;
  }, null);
}
