import type { TournamentVivaCheckout, TournamentVivaProduct } from "./tournamentSignupApi";

export interface TournamentPricingPreviewRow {
  id: string;
  label: string;
  value: string;
}

export interface TournamentPricingPromoOnlyOffer {
  id: string;
  label: string;
  value: string;
}

export interface TournamentPricingPreview {
  triggerLabel: string;
  rows: TournamentPricingPreviewRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]) {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function normalizeTournamentPricingPreviewRow(
  value: unknown,
  index: number,
): TournamentPricingPreviewRow | null {
  if (!isRecord(value)) return null;
  const label = pickString(value, ["label", "name", "title"]);
  const rowValue = pickString(value, ["value", "priceLabel", "amountLabel", "costLabel"]);
  if (!label || !rowValue) return null;

  return {
    id: pickString(value, ["id", "key", "code"]) || `pricing-row-${index + 1}`,
    label,
    value: rowValue,
  };
}

export function normalizeTournamentPricingPreviewSnapshot(value: unknown): TournamentPricingPreview | null {
  if (!isRecord(value)) return null;

  const rowsSource =
    (Array.isArray(value.rows) ? value.rows : null)
    || (Array.isArray(value.items) ? value.items : null)
    || (Array.isArray(value.options) ? value.options : null)
    || [];
  const rows = rowsSource
    .map((item, index) => normalizeTournamentPricingPreviewRow(item, index))
    .filter((item): item is TournamentPricingPreviewRow => item !== null);
  const triggerLabel =
    pickString(value, ["triggerLabel", "priceLabel", "label"])
    || rows[0]?.value
    || null;

  if (!triggerLabel && rows.length === 0) return null;

  return {
    triggerLabel: triggerLabel || "энергия",
    rows,
  };
}

export function normalizeTournamentPromoOnlyOfferSnapshot(value: unknown): TournamentPricingPromoOnlyOffer | null {
  if (!isRecord(value)) return null;
  const label = pickString(value, ["label", "name", "title"]);
  const offerValue = pickString(value, ["value", "priceLabel", "amountLabel", "costLabel"]);
  if (!label || !offerValue) return null;

  return {
    id: pickString(value, ["id", "key", "code"]) || "promo-offer",
    label,
    value: offerValue,
  };
}

const PROMO_ONLY_PURCHASABLE_PRODUCT_NAMES = new Set([
  "лето падел спорт",
]);

export function normalizeTournamentProductName(value: string | null | undefined) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPromoOnlyTournamentProduct(productOrName: TournamentVivaProduct | string | null | undefined) {
  const name = typeof productOrName === "string" ? productOrName : productOrName?.name;
  return PROMO_ONLY_PURCHASABLE_PRODUCT_NAMES.has(normalizeTournamentProductName(name));
}

export function hasPromoOnlyTournamentProducts(products: TournamentVivaProduct[] | null | undefined) {
  return Array.isArray(products) && products.some((product) => isPromoOnlyTournamentProduct(product));
}

function formatRubPrice(value: number | null) {
  if (value == null) return "Стоимость уточняется";
  return `${Math.round(value).toLocaleString("ru-RU").replace(/\u00a0/g, " ")} ₽`;
}

function parsePriceLabel(value: string | null | undefined) {
  const label = String(value || "").trim();
  if (!label) return null;

  const withoutCurrency = label
    .replace(/₽/g, "")
    .replace(/руб(?:\.|лей|ля|ль)?/gi, "")
    .replace(/\s*р\.?\s*$/i, "")
    .trim();
  if (!/^\d[\d\s.,\u00a0]*$/.test(withoutCurrency)) return null;

  const compact = withoutCurrency.replace(/[\s\u00a0]/g, "");
  const lastSeparatorIndex = Math.max(compact.lastIndexOf(","), compact.lastIndexOf("."));
  const normalized = lastSeparatorIndex >= 0
    ? (() => {
      const integerPart = compact.slice(0, lastSeparatorIndex).replace(/[.,]/g, "");
      const fractionalPart = compact.slice(lastSeparatorIndex + 1);
      return fractionalPart.length > 0 && fractionalPart.length <= 2
        ? `${integerPart}.${fractionalPart}`
        : compact.replace(/[.,]/g, "");
    })()
    : compact;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null;
}

function getProductRubPrice(product: TournamentVivaProduct) {
  if (typeof product.targetAmount === "number" && Number.isFinite(product.targetAmount)) {
    return Math.max(0, Math.round(product.targetAmount));
  }

  if (typeof product.priceLabel === "string" && product.priceLabel.trim()) {
    const parsed = parsePriceLabel(product.priceLabel);
    if (parsed != null) return parsed;
  }

  if (typeof product.cost === "number" && Number.isFinite(product.cost)) {
    return Math.max(0, Math.round(product.cost / 100));
  }

  return null;
}

function formatProductValueLabel(product: TournamentVivaProduct) {
  const price = getProductRubPrice(product);
  const priceLabel = product.priceLabel || formatRubPrice(price);

  if (product.source === "one-time" || product.source === "client-one-time") {
    return `${priceLabel} / 1 посещение`;
  }

  if (product.isCustomTournamentEnergy || !product.visitsTotal) {
    return priceLabel;
  }

  return `${priceLabel} / ${product.visitsTotal} посещ.`;
}

function formatPromoOnlyProductValueLabel(product: TournamentVivaProduct) {
  const price = getProductRubPrice(product);
  return product.priceLabel || formatRubPrice(price);
}

function compareProducts(left: TournamentVivaProduct, right: TournamentVivaProduct) {
  const leftPrice = getProductRubPrice(left);
  const rightPrice = getProductRubPrice(right);

  if (leftPrice != null && rightPrice != null && leftPrice !== rightPrice) {
    return leftPrice - rightPrice;
  }
  if (leftPrice != null && rightPrice == null) return -1;
  if (leftPrice == null && rightPrice != null) return 1;

  const leftVisits = left.visitsTotal ?? Number.POSITIVE_INFINITY;
  const rightVisits = right.visitsTotal ?? Number.POSITIVE_INFINITY;
  if (leftVisits !== rightVisits) return leftVisits - rightVisits;

  return left.name.localeCompare(right.name, "ru-RU");
}

function dedupeProducts(products: TournamentVivaProduct[]) {
  const seen = new Set<string>();
  const result: TournamentVivaProduct[] = [];

  products.forEach((product) => {
    const key = [
      normalizeTournamentProductName(product.name),
      getProductRubPrice(product) ?? "na",
      product.visitsTotal ?? "na",
      product.source,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    result.push(product);
  });

  return result;
}

export function buildTournamentPromoOnlyOfferFromProducts(products: TournamentVivaProduct[]) {
  const promoProducts = dedupeProducts(
    products.filter((product) => isPromoOnlyTournamentProduct(product)),
  ).sort(compareProducts);

  const product = promoProducts[0];
  if (!product) return null;

  return {
    id: `${product.source}-${product.id}`,
    label: product.name,
    value: formatPromoOnlyProductValueLabel(product),
  } satisfies TournamentPricingPromoOnlyOffer;
}

export function buildTournamentPricingPreviewFromProducts(products: TournamentVivaProduct[]) {
  const eligibleProducts = dedupeProducts(
    products.filter((product) => !isPromoOnlyTournamentProduct(product)),
  ).sort(compareProducts);

  if (eligibleProducts.length === 0) return null;

  const rows = eligibleProducts.map((product) => ({
    id: `${product.source}-${product.id}`,
    label: product.name,
    value: formatProductValueLabel(product),
  }));

  const minimumPrice = eligibleProducts
    .map(getProductRubPrice)
    .find((value): value is number => value != null) ?? null;
  const triggerLabel = minimumPrice != null ? formatRubPrice(minimumPrice) : "энергия";

  return {
    triggerLabel,
    rows,
  } satisfies TournamentPricingPreview;
}

export function buildTournamentPricingPreviewFromCheckout(checkout: TournamentVivaCheckout | null | undefined) {
  if (!checkout) return null;
  return buildTournamentPricingPreviewFromProducts([
    ...checkout.clientSubscriptions,
    ...checkout.oneTimes,
    ...checkout.subscriptions,
  ]);
}
