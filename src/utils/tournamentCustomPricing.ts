export const TOURNAMENT_ENERGY_PRODUCT_NAME = "Энергия турниры";
export const TOURNAMENT_CUSTOM_ENERGY_PRODUCT_ID = "custom-tournament-energy";
export const TOURNAMENT_CUSTOM_ENERGY_PRODUCT_NAME = TOURNAMENT_ENERGY_PRODUCT_NAME;
export const TOURNAMENT_ENERGY_BASE_AMOUNT = 20000;

export interface TournamentCustomPricing {
  priceLabel: string;
  amount: number;
  baseAmount: number;
  discountAmount: number;
  productName: string;
}

export interface TournamentCustomPricingProductFields {
  priceLabel?: string | null;
  baseAmount?: number | null;
  discountAmount?: number | null;
  targetAmount?: number | null;
  isCustomTournamentEnergy?: boolean;
}

interface TournamentVivaProductLike extends TournamentCustomPricingProductFields {
  id: string;
  name: string;
  type: string;
  raw?: unknown;
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

function pickRecord(value: unknown, keys: string[]) {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function normalizeProductName(value: string) {
  return value.trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

function pickPriceLabelFromSkinLikeRecord(value: unknown) {
  return pickString(value, ["priceLabel", "priceText", "costLabel", "costText"]);
}

export function findTournamentSkinPriceLabel(value: unknown, seen = new Set<unknown>()): string | null {
  if (!isRecord(value) || seen.has(value)) return null;
  seen.add(value);

  const explicitSkinPriceLabel = pickString(value, ["skinPriceLabel", "skinPriceText"]);
  if (explicitSkinPriceLabel) return explicitSkinPriceLabel;

  const directSkin = pickRecord(value, ["skin", "tournamentSkin"]);
  const directSkinPriceLabel = pickPriceLabelFromSkinLikeRecord(directSkin);
  if (directSkinPriceLabel) return directSkinPriceLabel;

  const fallbackSkin = pickRecord(value, ["customTournament", "publicTournament"]);
  const fallbackSkinPriceLabel = pickPriceLabelFromSkinLikeRecord(fallbackSkin);
  if (fallbackSkinPriceLabel) return fallbackSkinPriceLabel;

  const nested = [
    value.raw,
    value.details,
    value.payload,
    value.data,
    value.exercise,
    value.tournament,
    value.sourceTournament,
    value.sourceTournamentSnapshot,
    value.baseTournament,
  ];

  for (const item of nested) {
    const nestedPriceLabel = findTournamentSkinPriceLabel(item, seen);
    if (nestedPriceLabel) return nestedPriceLabel;
  }

  return null;
}

export function parseTournamentSkinPriceLabel(value: string | null | undefined) {
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

export function formatTournamentRubPrice(value: number) {
  return `${Math.round(value).toLocaleString("ru-RU").replace(/\u00a0/g, " ")} ₽`;
}

export function resolveTournamentCustomPricing(
  payloads: unknown[],
  fallbackSkinPriceLabel?: string | null,
): TournamentCustomPricing | null {
  const rawPriceLabel =
    (fallbackSkinPriceLabel?.trim() || null)
    ?? payloads.map((payload) => findTournamentSkinPriceLabel(payload)).find((label): label is string => Boolean(label))
    ?? null;
  const amount = parseTournamentSkinPriceLabel(rawPriceLabel);
  if (amount == null) return null;

  return {
    priceLabel: formatTournamentRubPrice(amount),
    amount,
    baseAmount: TOURNAMENT_ENERGY_BASE_AMOUNT,
    discountAmount: Math.max(0, TOURNAMENT_ENERGY_BASE_AMOUNT - amount),
    productName: TOURNAMENT_CUSTOM_ENERGY_PRODUCT_NAME,
  };
}

export function isTournamentEnergyProductName(value: string | null | undefined) {
  const normalized = normalizeProductName(String(value || ""));
  const target = normalizeProductName(TOURNAMENT_ENERGY_PRODUCT_NAME);
  return normalized === target || normalized.includes(target);
}

export function applyTournamentCustomPricingToEnergyProduct<T extends { name: string }>(
  products: T[],
  pricing: TournamentCustomPricing,
): (T & Required<TournamentCustomPricingProductFields>) | null {
  const product = products.find((item) => isTournamentEnergyProductName(item.name));
  if (!product) return null;

  return {
    ...product,
    priceLabel: pricing.priceLabel,
    baseAmount: pricing.baseAmount,
    discountAmount: pricing.discountAmount,
    targetAmount: pricing.amount,
    isCustomTournamentEnergy: true,
  };
}

export function toTournamentRubMinorAmount(value: number) {
  return Math.max(0, Math.round(value * 100));
}

export function buildTournamentCustomEnergyProduct(pricing: TournamentCustomPricing) {
  return {
    id: TOURNAMENT_CUSTOM_ENERGY_PRODUCT_ID,
    name: TOURNAMENT_CUSTOM_ENERGY_PRODUCT_NAME,
    type: "SUBSCRIPTION" as const,
    cost: toTournamentRubMinorAmount(pricing.amount),
    visitsTotal: null,
    source: "custom-tournament-energy" as const,
    raw: {
      productName: TOURNAMENT_CUSTOM_ENERGY_PRODUCT_NAME,
      customPricing: pricing,
    },
    priceLabel: pricing.priceLabel,
    baseAmount: pricing.baseAmount,
    discountAmount: pricing.discountAmount,
    targetAmount: pricing.amount,
    isCustomTournamentEnergy: true,
  };
}

export function buildTournamentCustomEnergyDiscountReason(
  tournamentTitle: string | null | undefined,
  tournamentDateLabel: string | null | undefined,
) {
  const title = String(tournamentTitle || "").trim();
  const dateLabel = String(tournamentDateLabel || "").trim();
  return [
    "Участие в турнире",
    title ? `«${title}»` : null,
    dateLabel || null,
  ].filter(Boolean).join(" ");
}

export function buildTournamentVivaTransactionProductPayload(
  product: TournamentVivaProductLike,
  exerciseId: string,
) {
  const payload: Record<string, unknown> = {
    id: product.id,
    name: product.name,
    type: product.type,
    count: 1,
    bookingRequests: [
      {
        exerciseId,
        client: null,
        comment: null,
        marketingAttribution: {},
      },
    ],
  };

  const raw = isRecord(product.raw) ? product.raw : null;
  const clientSubscriptionId = pickString(raw, ["clientSubscriptionId", "subscriptionId"]);
  const subscriptionId = pickString(raw, ["subscriptionId"]);

  if (clientSubscriptionId && product.type === "SUBSCRIPTION") {
    payload.clientSubscriptionId = clientSubscriptionId;
  }

  if (subscriptionId && product.type === "SUBSCRIPTION") {
    payload.subscriptionId = subscriptionId;
  }

  if (typeof product.discountAmount === "number" && Number.isFinite(product.discountAmount)) {
    payload.discountAmount = product.discountAmount;
  }

  return payload;
}
