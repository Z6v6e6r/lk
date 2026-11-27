import type { SubscriptionPricePreview } from "../components/games/subscriptionPricePreview";
import { resolveSubscriptionCategoryDailyLimitPlanKey } from "../utils/subscriptionCategoryDailyLimit.ts";
import type { SubscriptionEventDiscountQuote } from "../utils/groupSubscriptionDiscount";
import { RESIDENCY_LIFECYCLE_PRODUCT_ID } from "../residency/residencyLifecycleClient.ts";
import { isPilotGameResidencyProduct } from "./gameResidencyCandidates.ts";

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

const residencyLabel = "Резидентство ПадлхАБ";
const friendshipLabel = "По подписке Дружба2.0";
const isResidencyName = (name: string) => /^резидентство(?:\s+падлхаб)?$/iu.test(name.trim());
type GameOption = { subscriptionId: string; name: string };
type OwnedGameSubscription = NonNullable<Parameters<typeof isPilotGameResidencyProduct>[0]>;

function gameOptionName(name: string, quote: SubscriptionPricePreview, owned: OwnedGameSubscription | undefined): string {
  if (quote.appliedSubscriptionProductId?.toLowerCase() === RESIDENCY_LIFECYCLE_PRODUCT_ID
    || (!quote.appliedSubscriptionProductId && isPilotGameResidencyProduct(owned))) return residencyLabel;
  if (resolveSubscriptionCategoryDailyLimitPlanKey(owned) === "friendship_two_hours"
    || /^(?:падел[.\s]+)?дружба\s*2\.0$/iu.test(name.trim())) return friendshipLabel;
  return name === "Абонемент" || isResidencyName(name) ? "По подписке" : name;
}

export function pilotGamePricePreview(
  quote: SubscriptionPricePreview,
  subscriptions: readonly GameOption[],
  ownedSubscriptions: readonly OwnedGameSubscription[],
): SubscriptionPricePreview {
  if (quote.state !== "available" || quote.amountMinor === null) return quote;
  const option = subscriptions.find(item => item.subscriptionId === quote.confirmedSubscriptionId);
  const owned = ownedSubscriptions.find(item => item.subscriptionId.trim() === quote.confirmedSubscriptionId);
  const label = gameOptionName(option?.name ?? "Абонемент", quote, owned);
  if (label !== residencyLabel && label !== friendshipLabel) return quote;
  return { ...quote, label: `${label} · от ${money(quote.amountMinor)}`,
    detail: label === residencyLabel ? null : quote.detail };
}

function confirmedGameDiscount(quote: SubscriptionPricePreview, residency: boolean): string | null {
  if (!quote.discounted || quote.amountMinor === null || !quote.basePriceMinor) return null;
  const base = quote.basePriceMinor;
  const discount = Math.round((base - quote.amountMinor) * 100 / base);
  return discount > 0 && discount < 100 && base - Math.floor(base * discount / 100) === quote.amountMinor
    ? `Скидка ${discount}% на запись`
    : residency ? "Применена скидка по резидентству" : "Применена скидка подписки";
}

export function gameBookingOptions(
  subscriptions: readonly GameOption[],
  previews: Readonly<Record<string, SubscriptionPricePreview>>,
  durationMinutes: number,
  ownedSubscriptions: readonly OwnedGameSubscription[] = [],
) {
  const options: BookingOption[] = [];
  const explanations: string[] = [];
  const ownedById = new Map(ownedSubscriptions.map(subscription => [subscription.subscriptionId.trim(), subscription]));
  for (const { subscriptionId, name } of subscriptions) {
    const quote = previews[subscriptionId];
    if (!quote || quote.state === "checking") continue;
    const displayName = gameOptionName(name, quote, ownedById.get(subscriptionId));
    if (quote.state !== "available" || quote.amountMinor === null) {
      explanations.push(`${displayName} · ${quote.label}`);
      continue;
    }
    const freeMinutes = durationMinutes - quote.paidMinutes;
    const benefit = quote.amountMinor === 0
      ? "Участие по подписке без доплаты"
      : freeMinutes > 0 && quote.paidMinutes > 0
        ? `${freeMinutes} мин бесплатно · доплата за ${quote.paidMinutes} мин`
        : confirmedGameDiscount(quote, displayName === residencyLabel);
    options.push({ id: subscriptionId, name: displayName, amountMinor: quote.amountMinor, basePriceMinor: quote.basePriceMinor, benefit });
  }
  return { options, explanations: [...new Set(explanations)] };
}

function isEventResidencyQuote(quote: SubscriptionEventDiscountQuote): boolean {
  return isResidencyName(quote.subscriptionName);
}

export function eventBookingOptions(
  products: readonly { id: string; name: string; source: string; cost: number | null }[],
  quotes: readonly SubscriptionEventDiscountQuote[],
  now = Date.now(),
  excludeResidency = false,
) {
  const tariffs = products.filter(product => product.source === "one-time" && product.cost !== null);
  const options: BookingOption[] = tariffs.map(product => ({
    id: `tariff:${product.id}`,
    name: /^Разовая(?:\s*🎾|\s+запись)?$/iu.test(product.name.trim()) ? "Разовая" : product.name,
    amountMinor: product.cost,
  }));
  const currentQuotes = quotes.filter(quote => Number.isFinite(quote.expiresAt) && quote.expiresAt > now
    && (!excludeResidency || !isEventResidencyQuote(quote)));
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
    explanations.push(`${isEventResidencyQuote(quote) ? residencyLabel : quote.subscriptionName} · ${reason}`);
  }
  for (const quote of discountedQuotes) {
    if (!showQuote(quote)) continue;
    const benefit = quote.amountMinor === 0
      ? "Участие по подписке без доплаты"
      : quote.freeMinutes && quote.paidMinutes
        ? `${quote.freeMinutes} мин бесплатно · доплата за ${quote.paidMinutes} мин`
        : quote.discountPercent > 0 ? `Скидка ${quote.discountPercent}% на запись` : null;
    options.push({ id: `quote:${quote.subscriptionId}:${quote.productId}`, name: isEventResidencyQuote(quote) ? residencyLabel : quote.subscriptionName,
      amountMinor: quote.amountMinor, basePriceMinor: quote.basePriceMinor, benefit });
  }
  return { options, explanations: [...new Set(explanations)] };
}
