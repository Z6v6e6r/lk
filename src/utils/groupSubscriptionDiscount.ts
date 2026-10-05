/**
 * Every event quote kind the price preview may emit. Each kind owns its own amount formula; the
 * kind is the honest discriminator between a percentage of the event tariff and the club co-pay,
 * whose money is the court's, not a share of the event price.
 */
export type SubscriptionEventQuoteKind =
  | "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1"
  | "TOURNAMENT_SUBSCRIPTION_DISCOUNT_V1"
  | "GROUP_TRAINING_COURT_COPAY_V1";

/** Authenticated, event-bound monetary quote; amounts are kopecks. */
export interface SubscriptionEventDiscountQuote {
  kind: SubscriptionEventQuoteKind;
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
  /**
   * `GROUP_TRAINING_COURT_COPAY_V1` only: hours of court started above the free visit that the
   * co-pay charges, the hourly court price the server proved for the event window, and its
   * quarter actually charged per hour. The co-pay cannot be expressed as a percentage of the
   * event tariff, so `discountPercent` stays 0 and these fields carry the meaning.
   */
  chargeableHours?: number;
  hourlyCourtPriceMinor?: number;
  perHourMinor?: number;
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

/**
 * The club court-hourly co-pay («Дружба Топократы», owner decision 2026-10-05). The subscription
 * carries the event's free hour; every started hour above it costs a quarter of the hourly court
 * price the server proved for the event window, capped by the event's own base price. It is not a
 * percentage of the event tariff, so `discountPercent` is 0 and this kind carries the meaning.
 */
export interface GroupTrainingCourtCoPayQuote extends SubscriptionEventDiscountQuote {
  kind: "GROUP_TRAINING_COURT_COPAY_V1";
  chargeableHours: number;
  hourlyCourtPriceMinor: number;
  perHourMinor: number;
}

export type GroupSubscriptionQuote = GroupSubscriptionDiscountQuote | GroupTrainingCourtCoPayQuote;

const GROUP_TRAINING_QUOTE_KINDS: readonly SubscriptionEventQuoteKind[] = Object.freeze([
  "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1",
  "GROUP_TRAINING_COURT_COPAY_V1",
]);

/**
 * The amount a court-hourly co-pay must carry: the charged hours at the proved quarter of the
 * hourly court price, never more than the event's own base price. Null when the quote does not
 * prove its own court price, its hour count or a whole-kopeck product.
 */
export function courtHourlyCoPayAmountMinor(
  quote: Pick<SubscriptionEventDiscountQuote,
    "basePriceMinor" | "chargeableHours" | "hourlyCourtPriceMinor" | "perHourMinor">,
): number | null {
  const perHourMinor = quote.perHourMinor as number;
  const chargeableHours = quote.chargeableHours as number;
  if (!Number.isSafeInteger(quote.basePriceMinor) || (quote.basePriceMinor as number) <= 0
    || !Number.isSafeInteger(perHourMinor) || perHourMinor <= 0
    || !Number.isSafeInteger(quote.hourlyCourtPriceMinor) || (quote.hourlyCourtPriceMinor as number) <= 0
    || !Number.isSafeInteger(chargeableHours) || chargeableHours < 1) return null;
  const chargedMinor = perHourMinor * chargeableHours;
  if (!Number.isSafeInteger(chargedMinor)) return null;
  return Math.min(chargedMinor, quote.basePriceMinor);
}

export function isSubscriptionEventDiscountQuote(
  value: unknown,
  kind: SubscriptionEventQuoteKind | readonly SubscriptionEventQuoteKind[],
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is SubscriptionEventDiscountQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as SubscriptionEventDiscountQuote;
  const kinds: readonly SubscriptionEventQuoteKind[] = typeof kind === "string" ? [kind] : kind;
  if (!kinds.includes(q.kind)) return false;
  // The court co-pay is not a percentage of the event tariff, so it is validated by its own
  // formula and its own fields; every other kind keeps the reviewed flat / paid-share arithmetic.
  const courtCoPay = q.kind === "GROUP_TRAINING_COURT_COPAY_V1";
  return q.exerciseId === exerciseId && q.actorClientId === actorClientId
    && typeof q.subscriptionId === "string" && Boolean(q.subscriptionId.trim())
    && typeof q.subscriptionName === "string" && Boolean(q.subscriptionName.trim())
    && typeof q.productId === "string" && Boolean(q.productId.trim())
    && q.status === "AVAILABLE" && Number.isSafeInteger(q.discountPercent) && q.discountPercent >= 0 && q.discountPercent <= 100
    && (!courtCoPay || q.discountPercent === 0)
    && Number.isSafeInteger(q.basePriceMinor) && q.basePriceMinor > 0 && q.basePriceMinor <= 1_000_000
    && Number.isSafeInteger(q.amountMinor)
    && q.amountMinor === (courtCoPay ? courtHourlyCoPayAmountMinor(q) : subscriptionEventQuoteAmountMinor(q))
    && (!courtCoPay || (Number.isSafeInteger(q.freeMinutes) && (q.freeMinutes as number) >= 0
      && Number.isSafeInteger(q.paidMinutes) && (q.paidMinutes as number) > 0
      && (q.freeMinutes as number) + (q.paidMinutes as number) === q.durationMinutes))
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
): value is GroupSubscriptionQuote {
  return isSubscriptionEventDiscountQuote(value, GROUP_TRAINING_QUOTE_KINDS, exerciseId, actorClientId, now);
}

export function matchSubscriptionEventDiscount<T extends SubscriptionEventDiscountQuote>(
  quotes: T[],
  kind: SubscriptionEventQuoteKind | readonly SubscriptionEventQuoteKind[],
  product: { id: string; cost: number | null; source: string },
): T | null {
  const kinds: readonly SubscriptionEventQuoteKind[] = typeof kind === "string" ? [kind] : kind;
  if (product.source !== "one-time") return null;
  return quotes.reduce<T | null>((best, quote) => {
    if (!kinds.includes(quote.kind)
      || quote.status !== "AVAILABLE" || quote.productId !== product.id || quote.basePriceMinor !== product.cost
      || !Number.isSafeInteger(quote.amountMinor) || quote.amountMinor! < 0
      || quote.amountMinor! > quote.basePriceMinor) return best;
    return !best || quote.amountMinor! < best.amountMinor!
      || (quote.amountMinor === best.amountMinor && quote.subscriptionId < best.subscriptionId) ? quote : best;
  }, null);
}

export function matchGroupSubscriptionDiscount(
  quotes: GroupSubscriptionQuote[],
  product: { id: string; cost: number | null; source: string },
): GroupSubscriptionQuote | null {
  return matchSubscriptionEventDiscount(quotes, GROUP_TRAINING_QUOTE_KINDS, product);
}
