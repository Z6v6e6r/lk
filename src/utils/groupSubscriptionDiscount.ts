/** Authenticated, event-bound monetary quote; amounts are kopecks. */
export interface GroupSubscriptionDiscountQuote {
  kind: "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1";
  exerciseId: string;
  actorClientId: string;
  subscriptionId: string;
  subscriptionName: string;
  productId: string;
  status: "AVAILABLE" | "LIMIT_USED" | "UNAVAILABLE";
  discountPercent: number;
  basePriceMinor: number;
  amountMinor: number | null;
  startsAt: string;
  durationMinutes: number;
  evaluatedAt: number;
  expiresAt: number;
}

export function isGroupSubscriptionDiscountQuote(
  value: unknown,
  exerciseId: string,
  actorClientId: string,
  now = Date.now(),
): value is GroupSubscriptionDiscountQuote {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as GroupSubscriptionDiscountQuote;
  return q.kind === "GROUP_TRAINING_SUBSCRIPTION_DISCOUNT_V1"
    && q.exerciseId === exerciseId && q.actorClientId === actorClientId
    && typeof q.subscriptionId === "string" && Boolean(q.subscriptionId.trim())
    && typeof q.subscriptionName === "string" && Boolean(q.subscriptionName.trim())
    && typeof q.productId === "string" && Boolean(q.productId.trim())
    && q.status === "AVAILABLE" && q.discountPercent === 50
    && Number.isSafeInteger(q.basePriceMinor) && q.basePriceMinor > 0 && q.basePriceMinor <= 1_000_000
    && Number.isSafeInteger(q.amountMinor) && q.amountMinor === Math.round(q.basePriceMinor * 0.5)
    && Number.isFinite(Date.parse(q.startsAt)) && Date.parse(q.startsAt) > now
    && Number.isSafeInteger(q.durationMinutes) && q.durationMinutes > 0 && q.durationMinutes <= 720
    && Number.isFinite(q.evaluatedAt) && Number.isFinite(q.expiresAt)
    && q.evaluatedAt <= now + 5000 && q.expiresAt > now
    && q.expiresAt > q.evaluatedAt && q.expiresAt - q.evaluatedAt <= 60_000;
}

export function matchGroupSubscriptionDiscount(
  quotes: GroupSubscriptionDiscountQuote[],
  product: { id: string; cost: number | null; source: string },
): GroupSubscriptionDiscountQuote | null {
  if (product.source !== "one-time") return null;
  return quotes.find(q => q.status === "AVAILABLE" && q.productId === product.id && q.basePriceMinor === product.cost) ?? null;
}
