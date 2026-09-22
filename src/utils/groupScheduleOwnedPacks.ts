import type { TournamentVivaProduct } from "./tournamentSignupApi";
import type { GroupSubscriptionDiscountQuote } from "./groupSubscriptionDiscount.ts";
import { pickSubscriptionVisitsLeft } from "./subscriptionValidity.ts";

const ENERGY_VISIT_PRODUCT_IDS = new Set([
  "dfa72adf-233b-4285-8d69-e5eab4234fbe", // Энергия 5
  "9fb759fd-f70c-4395-84e7-57716df97e14", // Энергия 25
]);

function normalizeComparableId(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase()
    : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Match the catalog identity checked by the server; instance ids are not product ids. */
export function getProEnergyPackName(product: TournamentVivaProduct): string | null {
  const raw = asRecord(product.raw);
  const catalog = asRecord(raw.product);
  const subscription = asRecord(raw.subscription);
  const ids = [raw.productId, raw.subscriptionProductId, raw.templateId,
    catalog.id, catalog.uuid, catalog.productId,
    subscription.productId, subscription.subscriptionProductId,
  ].map(normalizeComparableId).filter(Boolean);
  if (ids.length) {
    if (!ids.every(id => ENERGY_VISIT_PRODUCT_IDS.has(id))) return null;
    return ids[0] === "dfa72adf-233b-4285-8d69-e5eab4234fbe" ? "Энергия 5" : "Энергия 25";
  }
  const names = [raw.subscriptionName, raw.productName, raw.name, raw.title,
    subscription.name, catalog.name, asRecord(raw.clientSubscription).name,
    asRecord(raw.clientSub).name, product.name];
  for (const name of names) {
    if (typeof name !== "string") continue;
    const normalized = name.toLocaleLowerCase("ru-RU")
      .replace(/[^a-zа-яё0-9]+/gi, " ").replace(/\s+/g, " ").trim();
    const matched = /^(энергия|energy) (5|25)$/.exec(normalized);
    if (matched) return `Энергия ${matched[2]}`;
  }
  return null;
}

function isEnergyVisitPackProduct(product: TournamentVivaProduct) {
  return getProEnergyPackName(product) !== null;
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
