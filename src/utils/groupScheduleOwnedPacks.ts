import type { TournamentVivaProduct } from "./tournamentSignupApi";
import type { GroupSubscriptionDiscountQuote } from "./groupSubscriptionDiscount.ts";
import { isEnergyVisitPackSubscriptionName, pickSubscriptionVisitsLeft } from "./subscriptionValidity.ts";

const ENERGY_VISIT_PRODUCT_IDS = new Set([
  "dfa72adf-233b-4285-8d69-e5eab4234fbe", // Энергия 5
  "9fb759fd-f70c-4395-84e7-57716df97e14", // Энергия 25
]);

function normalizeComparableId(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isEnergyVisitPackProduct(product: TournamentVivaProduct) {
  if (isEnergyVisitPackSubscriptionName(product.name)) return true;
  const raw = product.raw;
  if (!raw || typeof raw !== "object") return false;
  const record = raw as Record<string, unknown>;
  return [
    product.id,
    record.id,
    record.uuid,
    record.productId,
    record.subscriptionId,
    record.clientSubscriptionId,
  ].some(value => ENERGY_VISIT_PRODUCT_IDS.has(normalizeComparableId(value)));
}

/** Only visit packs already offered for this exercise by the checkout API. */
export function getGroupScheduleOwnedPacks(products: TournamentVivaProduct[]): TournamentVivaProduct[] {
  return products.filter(product => {
    if (product.source !== "client-subscription" || product.lk1MoneyDiscountCandidate === true
      || !isEnergyVisitPackProduct(product)) return false;
    const visitsLeft = pickSubscriptionVisitsLeft(product.raw);
    return visitsLeft == null || visitsLeft > 0;
  });
}

/**
 * A positive discount quote already prices this subscription on the one-time option,
 * so the owned button would be a second, unpriced way to book the same instance.
 */
function hasManagedGroupDiscount(
  quotes: GroupSubscriptionDiscountQuote[],
  product: TournamentVivaProduct,
): boolean {
  return quotes.some(quote => quote.subscriptionId === product.id && quote.discountPercent > 0);
}

/**
 * Owned subscriptions the client can book this exercise with.
 *
 * Energy visit packs keep their own balance rule. A plan outside the LK1 money contour
 * (a sale date before the rule, or no plan rule at all) is quoted by the price preview at
 * zero discount, so it has to stay a booking option of its own: collapsing it into the
 * ordinary tariff offered a group training to that cohort only at full price.
 *
 * `quotes === null` means the price check is still running; only visit packs are shown
 * then, so a managed plan never appears as an unpriced second option even briefly.
 */
export function getGroupScheduleOwnedSubscriptions(
  products: TournamentVivaProduct[],
  quotes: GroupSubscriptionDiscountQuote[] | null,
): TournamentVivaProduct[] {
  const visitPacks = getGroupScheduleOwnedPacks(products);
  if (quotes === null) return visitPacks;
  const outOfContour = products.filter(product => {
    if (product.source !== "client-subscription" || product.lk1MoneyDiscountCandidate === true
      || isEnergyVisitPackProduct(product)) return false;
    const visitsLeft = pickSubscriptionVisitsLeft(product.raw);
    if (visitsLeft != null && visitsLeft <= 0) return false;
    return !hasManagedGroupDiscount(quotes, product);
  });
  return [...visitPacks, ...outOfContour];
}
