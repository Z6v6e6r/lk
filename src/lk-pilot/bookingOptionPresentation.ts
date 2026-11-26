import type { SubscriptionPricePreview } from "../components/games/subscriptionPricePreview";
import { resolveSubscriptionCategoryDailyLimitPlanKey, SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS } from "../utils/subscriptionCategoryDailyLimit.ts";
import type { SubscriptionEventDiscountQuote } from "../utils/groupSubscriptionDiscount";

export type BookingOption = {
  id: string;
  name: string;
  amountMinor: number | null;
  basePriceMinor?: number | null;
  benefit?: string | null;
};

export function minorFromRubles(value: number | null | undefined, shares = 1): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 100 / shares)
    : null;
}

export const money = (minor: number) => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency: "RUB", maximumFractionDigits: 2,
}).format(minor / 100);

function confirmedGameDiscount(quote: SubscriptionPricePreview): string | null {
  if (!quote.discounted || quote.amountMinor === null || !quote.basePriceMinor) return null;
  const base = quote.basePriceMinor;
  const discount = Math.round((base - quote.amountMinor) * 100 / base);
  return discount > 0 && discount < 100 && base - Math.floor(base * discount / 100) === quote.amountMinor
    ? `Скидка ${discount}% на запись`
    : "Применена скидка подписки";
}

export function gameBookingOptions(
  subscriptions: readonly { subscriptionId: string; name: string }[],
  previews: Readonly<Record<string, SubscriptionPricePreview>>,
  durationMinutes: number,
  ownedSubscriptions: readonly { subscriptionId: string }[] = [],
) {
  const options: BookingOption[] = [];
  const explanations: string[] = [];
  const ownedById = new Map(ownedSubscriptions.map(subscription => [subscription.subscriptionId.trim(), subscription]));
  for (const { subscriptionId, name } of subscriptions) {
    const quote = previews[subscriptionId];
    if (!quote || quote.state === "checking") continue;
    const friendshipTwoHours = quote.subscriptionProductId
      ? quote.subscriptionProductId === SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.friendship_two_hours
      : resolveSubscriptionCategoryDailyLimitPlanKey(ownedById.get(subscriptionId)) === "friendship_two_hours"
        || /^(?:падел[.\s]+)?дружба\s*2\.0$/iu.test(name.trim());
    const displayName = friendshipTwoHours
      ? "по Подписке Дружба2.0"
      : name === "Абонемент" ? "По подписке" : name;
    if (quote.state !== "available" || quote.amountMinor === null) {
      explanations.push(`${displayName} · ${quote.label}`);
      continue;
    }
    const freeMinutes = durationMinutes - quote.paidMinutes;
    const benefit = quote.amountMinor === 0
      ? "Участие по подписке без доплаты"
      : freeMinutes > 0 && quote.paidMinutes > 0
        ? `${freeMinutes} мин бесплатно · доплата за ${quote.paidMinutes} мин`
        : confirmedGameDiscount(quote);
    options.push({ id: subscriptionId, name: displayName, amountMinor: quote.amountMinor, basePriceMinor: quote.basePriceMinor, benefit });
  }
  return { options, explanations: [...new Set(explanations)] };
}

function isEventResidencyQuote(quote: SubscriptionEventDiscountQuote): boolean {
  return /^Резидентство(?:\s+ПадлхАБ)?$/iu.test(quote.subscriptionName.trim());
}

export function eventBookingOptions(
  products: readonly { id: string; name: string; source: string; cost: number | null }[],
  quotes: readonly SubscriptionEventDiscountQuote[],
  now = Date.now(),
) {
  const tariffs = products.filter(product => product.source === "one-time" && product.cost !== null);
  const options: BookingOption[] = tariffs.map(product => ({
    id: `tariff:${product.id}`,
    name: /^Разовая(?:\s*🎾|\s+запись)?$/iu.test(product.name.trim()) ? "Разовая" : product.name,
    amountMinor: product.cost,
  }));
  const currentQuotes = quotes.filter(quote => Number.isFinite(quote.expiresAt) && quote.expiresAt > now);
  const discountedQuotes = currentQuotes.filter(quote => {
    const amount = quote.amountMinor;
    return quote.status === "AVAILABLE" && amount !== null && Number.isSafeInteger(amount)
      && amount >= 0 && amount < quote.basePriceMinor
      && (!tariffs.length || tariffs.some(tariff => tariff.id === quote.productId && tariff.cost === quote.basePriceMinor));
  });
  const subscriptionDiscounts = discountedQuotes.filter(quote => !isEventResidencyQuote(quote));
  const showQuote = (quote: SubscriptionEventDiscountQuote) =>
    !isEventResidencyQuote(quote) || !subscriptionDiscounts.some(other =>
      other.exerciseId === quote.exerciseId && other.productId === quote.productId && other.basePriceMinor === quote.basePriceMinor);
  const explanations: string[] = [];
  for (const quote of currentQuotes) {
    if (quote.status === "AVAILABLE" || !showQuote(quote)) continue;
    const reason = quote.status === "LIMIT_USED" ? "Лимит исчерпан" : "Льгота недоступна для этого события";
    explanations.push(`${quote.subscriptionName} · ${reason}`);
  }
  for (const quote of discountedQuotes) {
    if (!showQuote(quote)) continue;
    const benefit = quote.amountMinor === 0
      ? "Участие по подписке без доплаты"
      : quote.freeMinutes && quote.paidMinutes
        ? `${quote.freeMinutes} мин бесплатно · доплата за ${quote.paidMinutes} мин`
        : quote.discountPercent > 0 ? `Скидка ${quote.discountPercent}% на запись` : null;
    options.push({ id: `quote:${quote.subscriptionId}:${quote.productId}`, name: quote.subscriptionName,
      amountMinor: quote.amountMinor, basePriceMinor: quote.basePriceMinor, benefit });
  }
  return { options, explanations: [...new Set(explanations)] };
}
