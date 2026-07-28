export const TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS = {
  academy: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  energy5: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
  ra: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
} as const;

export const TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS = {
  "academy-promo": {
    accent: "АКАДЕМИЯ",
    planStyle: "sport",
    priceLabel: "11 900 ₽",
    productId: "6bda152b-0a9c-4308-82d0-3cd4e6aa680d",
    productName: "Лето.Падел.Академия Акция",
  },
  "friendship-promo": {
    accent: "ДРУЖБА",
    planStyle: "friendship",
    priceLabel: "4 900 ₽",
    productId: "c079dc82-c716-4f0e-b9ad-6aab62fb789e",
    productName: "Лето.Падел.Дружба Акция",
  },
  "sport-promo": {
    accent: "СПОРТ",
    planStyle: "sport",
    priceLabel: "9 900 ₽",
    productId: "9588a577-4cac-4f13-bf7f-72382acb0387",
    productName: "Лето.Падел.Спорт Акция",
  },
  "ra-promo": {
    accent: "РА",
    planStyle: "sport",
    priceLabel: "11 900 ₽",
    productId: "3b4806f1-6f9a-46df-a7d7-45075b4e7274",
    productName: "РА Акция",
  },
} as const;

export type TournamentSubscriptionPromoOfferKey = keyof typeof TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS;

export const TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_OVERRIDE_KEYS = [] as const;

export const TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_TOTAL_LIMITS = {
  academy: 100,
  friendship: 5,
  ra: 5,
  sport: 126,
} as const;

export function resolveTournamentSubscriptionDirectProductId(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (key === "academy" || key === "energy5" || key === "ra") {
    return TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS[key];
  }
  return null;
}

export function resolveTournamentSubscriptionPromoOffer(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS, key)) {
    return null;
  }
  return TOURNAMENT_SUBSCRIPTION_PROMO_OFFERS[key as TournamentSubscriptionPromoOfferKey];
}

export function resolveTournamentSubscriptionCounterDisplayText(value: string | null | undefined) {
  void value;
  return null;
}

export function resolveTournamentSubscriptionCounterDisplayTotalLimit(value: string | null | undefined) {
  const key = String(value || "").trim().toLowerCase();
  if (
    key === "academy"
    || key === "friendship"
    || key === "ra"
    || key === "sport"
  ) {
    return TOURNAMENT_SUBSCRIPTION_COUNTER_DISPLAY_TOTAL_LIMITS[key];
  }
  return null;
}
