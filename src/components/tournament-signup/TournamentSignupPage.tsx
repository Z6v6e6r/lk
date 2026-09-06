import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { BookingCancellationDialog } from "../cabinet/BookingCancellationDialog";
import { CommunityTournamentCard } from "../cabinet/community-feed/CommunityTournamentCard";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { Modal } from "../UI/Modal";
import { useAuth } from "../../context/AuthContext";
import {
  SubscriptionUsageShadowPanel,
  useSubscriptionUsageShadow,
} from "../subscriptions/SubscriptionUsageShadowPanel";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import {
  DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH,
  normalizeTournamentSignupDate,
  normalizeTournamentSignupSlug,
} from "../../utils/tournamentSignupEntry";
import {
  apiFetchPadelLiveRatings,
  apiFetchTournamentParticipants,
  type PadelLiveRatingItem,
} from "../../utils/apiClient";
import { getLetterGrade, normalizeLevelGradeLabel } from "../../utils/customFields";
import {
  apiCancelTournamentVivaRegistration,
  apiCreateTournamentVivaTransaction,
  apiFetchTournamentMyRegistration,
  apiFetchTournamentSignupDetail,
  apiFetchTournamentSignupList,
  apiFetchTournamentVivaCheckout,
  apiFetchTournamentVivaMyRegistration,
  apiFetchTournamentVivaPublicCheckout,
  apiResolveTournamentVivaRegistrationBookingId,
  type TournamentRegistrationState,
  type TournamentSignupDetail,
  type TournamentSignupSummary,
  type TournamentVivaCheckout,
  type TournamentVivaProduct,
} from "../../utils/tournamentSignupApi";
import { findTournamentSkinPriceLabel } from "../../utils/tournamentCustomPricing";
import {
  buildTournamentPromoOnlyOfferFromProducts,
  buildTournamentPricingPreviewFromCheckout,
  hasPromoOnlyTournamentProducts,
  isPromoOnlyTournamentProduct,
  normalizeTournamentProductName,
  type TournamentPricingPromoOnlyOffer,
  type TournamentPricingPreview,
} from "../../utils/tournamentPricingPreview";
import {
  getTournamentSignupParticipantsFromPayload,
  normalizeTournamentSignupPublicRoster,
  type TournamentSignupParticipant,
  type TournamentSignupPublicRoster,
} from "../../utils/tournamentSignupRoster";
import { canOfferTournamentRegistration } from "../../utils/tournamentSignupAvailability";
import {
  pickSubscriptionValidityDate,
  resolveSubscriptionUsageDisplay,
} from "../../utils/subscriptionValidity";
import type { CommunityTournamentCard as CommunityTournamentCardData } from "../cabinet/community-feed/feedTypes";
import americanoRulesImage from "../../assets/americano-info.png?inline";

interface TournamentSignupPageProps {
  onBack: () => void;
  initialTournamentId?: string | null;
  initialTournamentSlug?: string | null;
  initialDate?: string | null;
}

type TournamentDetailTab = "roster" | "rules";

type Rgb = { r: number; g: number; b: number };
type LevelGrade = "D" | "D+" | "C" | "C+" | "B" | "B+" | "A";
type TournamentRulesInfographic = {
  alt: string;
  src: string;
  tokens: string[];
};

const TOURNAMENT_DETAIL_TABS: Array<{ id: TournamentDetailTab; label: string }> = [
  { id: "roster", label: "Состав" },
  { id: "rules", label: "Регламент" },
];
const TOURNAMENT_RULES_INFOGRAPHICS: TournamentRulesInfographic[] = [
  {
    alt: "Как проходит Американо. Регламент турнира",
    src: americanoRulesImage,
    tokens: ["американо", "americano"],
  },
];

const ALL_FILTER_VALUE = "__all__";
const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const DEEP_LINK_LOOKUP_DAYS_BEFORE_TODAY = 30;
const DEEP_LINK_LOOKUP_DAYS_AFTER_TODAY = 180;
const TOURNAMENT_SHARE_ORIGIN = "https://padlhub.ru";
const TOURNAMENT_SUMMER_SUBSCRIPTION_URL = "https://padlhub.ru/ab_leto";
const TOURNAMENT_SHARE_SLUG_KEYS = [
  "slug",
  "publicSlug",
  "tournamentSlug",
  "linkSlug",
  "shareSlug",
];
const TOURNAMENT_SHARE_URL_KEYS = [
  "publicUrl",
  "joinUrl",
  "url",
  "link",
];
const TOURNAMENT_SHARE_NESTED_KEYS = [
  "details",
  "metadata",
  "params",
  "publicTournament",
  "sourceTournamentSnapshot",
  "sourceTournament",
  "customTournament",
  "tournament",
  "skin",
  "tournamentSkin",
];
const TOURNAMENT_DESCRIPTION_NESTED_KEYS = [
  "skin",
  "tournamentSkin",
  "customTournament",
  "publicTournament",
  "sourceTournamentSnapshot",
  "sourceTournament",
  "tournament",
  "details",
  "settings",
  "params",
  "metadata",
  "exercise",
];

const TOURNAMENT_SIGNUP_STATION_LABEL_BY_ID: Record<string, string> = {
  "2dac2b9e-e9a7-425e-bca1-35ac182f6349": "Селигерская",
};

const LEVEL_RANGES: Record<LevelGrade, { min: number; max: number }> = {
  D: { min: 1, max: 2 },
  "D+": { min: 2, max: 3 },
  C: { min: 3, max: 3.5 },
  "C+": { min: 3.5, max: 4 },
  B: { min: 4, max: 4.7 },
  "B+": { min: 4.7, max: 5.5 },
  A: { min: 5.5, max: 7 },
};

const LEVEL_RING_COLORS: Record<LevelGrade, { start: Rgb; end: Rgb; badge: Rgb }> = {
  A: {
    start: { r: 150, g: 132, b: 255 },
    end: { r: 126, g: 97, b: 255 },
    badge: { r: 130, g: 100, b: 255 },
  },
  "B+": {
    start: { r: 180, g: 118, b: 246 },
    end: { r: 156, g: 78, b: 227 },
    badge: { r: 160, g: 84, b: 230 },
  },
  B: {
    start: { r: 206, g: 104, b: 220 },
    end: { r: 187, g: 63, b: 193 },
    badge: { r: 191, g: 68, b: 196 },
  },
  "C+": {
    start: { r: 228, g: 98, b: 174 },
    end: { r: 213, g: 53, b: 146 },
    badge: { r: 216, g: 58, b: 149 },
  },
  C: {
    start: { r: 238, g: 102, b: 122 },
    end: { r: 223, g: 62, b: 94 },
    badge: { r: 226, g: 67, b: 99 },
  },
  "D+": {
    start: { r: 243, g: 132, b: 96 },
    end: { r: 234, g: 92, b: 51 },
    badge: { r: 236, g: 99, b: 57 },
  },
  D: {
    start: { r: 248, g: 172, b: 104 },
    end: { r: 239, g: 130, b: 34 },
    badge: { r: 241, g: 138, b: 43 },
  },
};

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getDateFromInput(value?: string | null) {
  return normalizeTournamentSignupDate(value);
}

function normalizeTournamentSlug(value: unknown) {
  return normalizeTournamentSignupSlug(value);
}

function extractTournamentSlugFromUrl(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, TOURNAMENT_SHARE_ORIGIN);
    const byQuery = parsed.searchParams.get("slug") || parsed.searchParams.get("tournamentSlug");
    if (byQuery) return normalizeTournamentSlug(byQuery);

    const parts = parsed.pathname.split("/").filter(Boolean);
    const publicIndex = parts.findIndex((part, index) => (
      part === "public" && parts[index - 1] === "tournaments" && parts[index - 2] === "api"
    ));
    if (publicIndex >= 0) return normalizeTournamentSlug(parts[publicIndex + 1]);
  } catch {
    const match = raw.match(/\/api\/tournaments\/public\/([^/?#]+)/i);
    if (match?.[1]) return normalizeTournamentSlug(match[1]);
  }
  return null;
}

function collectTournamentSlugCandidates(value: unknown, seen = new Set<unknown>()): string[] {
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const candidates = [
    normalizeTournamentSlug(pickString(value, TOURNAMENT_SHARE_SLUG_KEYS)),
    extractTournamentSlugFromUrl(pickString(value, TOURNAMENT_SHARE_URL_KEYS)),
  ].filter((candidate): candidate is string => Boolean(candidate));

  TOURNAMENT_SHARE_NESTED_KEYS.forEach((key) => {
    const nested = value[key];
    if (isRecord(nested)) {
      candidates.push(...collectTournamentSlugCandidates(nested, seen));
    }
  });

  return Array.from(new Set(candidates));
}

function slugifyTournamentTitle(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"`]+/g, "")
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function findTournamentByDeepLink(
  list: TournamentSignupSummary[],
  options: {
    tournamentId?: string | null;
    tournamentSlug?: string | null;
  },
) {
  const targetTournamentId = String(options.tournamentId || "").trim();
  if (targetTournamentId) {
    const byId = list.find((tournament) => {
      const candidates = new Set([
        String(tournament.id || "").trim(),
        String(tournament.exerciseId || "").trim(),
      ]);
      return candidates.has(targetTournamentId);
    });
    if (byId) return byId;
  }

  const targetTournamentSlug = normalizeTournamentSlug(options.tournamentSlug);
  if (!targetTournamentSlug) return null;

  return list.find((tournament) => {
    const slugCandidates = new Set([
      ...collectTournamentSlugCandidates(tournament.raw ?? tournament),
      ...collectTournamentSlugCandidates(tournament),
    ]);
    return slugCandidates.has(targetTournamentSlug);
  }) ?? null;
}

function getDateLabel(date: string | null) {
  if (!date) return "Дата уточняется";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата уточняется";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function getDateParts(date: string | null) {
  const parsed = date ? new Date(`${date}T00:00:00`) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    return { weekday: "", month: "ДАТА", day: "—" };
  }
  return {
    weekday: parsed.toLocaleDateString("ru-RU", { weekday: "long" }),
    month: parsed.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(),
    day: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
  };
}

function sortTournaments(items: TournamentSignupSummary[]) {
  return [...items].sort((left, right) => {
    const leftTs = Date.parse(left.startsAt || "");
    const rightTs = Date.parse(right.startsAt || "");
    const safeLeft = Number.isFinite(leftTs) ? leftTs : Number.MAX_SAFE_INTEGER;
    const safeRight = Number.isFinite(rightTs) ? rightTs : Number.MAX_SAFE_INTEGER;
    return safeLeft - safeRight;
  });
}

function getTournamentTypeFilterValue(tournament: TournamentSignupSummary) {
  return tournament.format || "Турнир";
}

function getTournamentStationLabel(tournament: TournamentSignupSummary | TournamentSignupDetail | null) {
  if (!tournament) return null;
  const direct = (tournament.studioName || "").trim();
  if (direct) return direct;
  if (tournament.studioId) {
    return TOURNAMENT_SIGNUP_STATION_LABEL_BY_ID[tournament.studioId] || "Станция уточняется";
  }
  return "Станция уточняется";
}

function getTournamentStationFilterValue(tournament: TournamentSignupSummary) {
  return getTournamentStationLabel(tournament) || tournament.address || "Станция уточняется";
}

function normalizeTournamentSearchText(value: unknown) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTournamentRulesInfographic(
  tournament: TournamentSignupSummary | TournamentSignupDetail | null,
): TournamentRulesInfographic | null {
  if (!tournament) return null;
  const haystack = normalizeTournamentSearchText([
    tournament.format,
    tournament.title,
  ].filter(Boolean).join(" "));
  if (!haystack) return null;
  return TOURNAMENT_RULES_INFOGRAPHICS.find((item) => (
    item.tokens.some((token) => haystack.includes(normalizeTournamentSearchText(token)))
  )) ?? null;
}

function getStationMapUrl(stationName: string | null, address: string | null) {
  const query = [stationName, address]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(", ");
  return query ? `https://yandex.ru/maps/?text=${encodeURIComponent(query)}` : null;
}

function getUniqueFilterValues(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "ru-RU"));
}

function formatClock(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  const matched = value.match(/\d{2}:\d{2}/)?.[0];
  return matched || "";
}

function formatMoneyMinor(value: number | null) {
  if (value == null) return "Стоимость уточняется";
  return `${(value / 100).toLocaleString("ru-RU")} ₽`;
}

function readTournamentPaymentNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getTournamentPaymentProductRemainingVisits(product: TournamentVivaProduct) {
  const raw = product.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const payload = raw as Record<string, unknown>;
    const direct = [
      payload.visitsLeft,
      payload.availableVisits,
      payload.remainingVisits,
      payload.visitsRemaining,
      payload.left,
      payload.balance,
    ];
    for (const value of direct) {
      const parsed = readTournamentPaymentNumber(value);
      if (parsed != null) return parsed;
    }

    const nested = payload.subscription;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const nestedPayload = nested as Record<string, unknown>;
      const nestedValues = [
        nestedPayload.visitsLeft,
        nestedPayload.availableVisits,
        nestedPayload.remainingVisits,
        nestedPayload.visitsRemaining,
        nestedPayload.left,
        nestedPayload.balance,
      ];
      for (const value of nestedValues) {
        const parsed = readTournamentPaymentNumber(value);
        if (parsed != null) return parsed;
      }
    }
  }
  return product.visitsTotal;
}

function formatTournamentPaymentProductPrice(product: TournamentVivaProduct) {
  return product.priceLabel || formatMoneyMinor(product.cost);
}

function formatTournamentPaymentProductVisits(product: TournamentVivaProduct) {
  if (product.source === "one-time" || product.source === "client-one-time") return " / 1 посещение";
  if (product.isCustomTournamentEnergy || !product.visitsTotal) return "";
  return ` / ${product.visitsTotal} посещ.`;
}

function formatTournamentPaymentProductValidity(product: TournamentVivaProduct) {
  return resolveSubscriptionUsageDisplay({
    subscriptionName: product.name,
    validityDate: pickSubscriptionValidityDate(product.raw),
    raw: product.raw,
  })?.label || "срок уточняется";
}

const SUMMER_SUBSCRIPTION_PRODUCT_NAMES = new Set([
  "лето падел дружба",
  "лето падел спорт",
]);

function isPromoOnlyPurchasableProduct(product: TournamentVivaProduct) {
  return isPromoOnlyTournamentProduct(product);
}

function getTournamentCheckoutProducts(checkout: TournamentVivaCheckout) {
  return [
    ...checkout.clientSubscriptions,
    ...checkout.oneTimes,
    ...checkout.subscriptions,
  ];
}

function findMatchingTournamentPaymentProduct(
  checkout: TournamentVivaCheckout,
  product: TournamentVivaProduct,
) {
  const products = getTournamentCheckoutProducts(checkout);
  return products.find((candidate) => candidate.source === product.source && candidate.id === product.id)
    ?? products.find((candidate) => candidate.isCustomTournamentEnergy && product.isCustomTournamentEnergy)
    ?? products.find((candidate) => candidate.id === product.id)
    ?? products.find((candidate) => (
      normalizeTournamentProductName(candidate.name) === normalizeTournamentProductName(product.name)
      && candidate.source === product.source
    ))
    ?? (products.length === 1 ? products[0] : null);
}

function shouldShowSubscriptionHint(product: TournamentVivaProduct) {
  if (!SUMMER_SUBSCRIPTION_PRODUCT_NAMES.has(normalizeTournamentProductName(product.name))) return false;
  const visits = getTournamentPaymentProductRemainingVisits(product) ?? product.visitsTotal;
  return visits === 30;
}

const PAYMENT_HOLD_MS = 20 * 60 * 1000;
const PAYMENT_STORAGE_PREFIX = "padlhub:tournament-payment:";

function getPaymentStorageKey(exerciseId: string) {
  return `${PAYMENT_STORAGE_PREFIX}${exerciseId}`;
}

function readStoredPendingPayment(exerciseId: string) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(getPaymentStorageKey(exerciseId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      paymentUrl?: unknown;
      paymentExpiresAt?: unknown;
      bookingId?: unknown;
    };
    const paymentUrl = typeof parsed.paymentUrl === "string" && parsed.paymentUrl.trim()
      ? parsed.paymentUrl.trim()
      : null;
    const paymentExpiresAt = typeof parsed.paymentExpiresAt === "string" && parsed.paymentExpiresAt.trim()
      ? parsed.paymentExpiresAt.trim()
      : null;
    const bookingId = typeof parsed.bookingId === "string" && parsed.bookingId.trim()
      ? parsed.bookingId.trim()
      : null;
    if (!paymentUrl && !paymentExpiresAt && !bookingId) return null;
    return { paymentUrl, paymentExpiresAt, bookingId };
  } catch {
    return null;
  }
}

function storePendingPayment(exerciseId: string, registration: TournamentRegistrationState) {
  if (typeof window === "undefined" || registration.status !== "PAYMENT_PENDING") return;
  const paymentUrl = registration.paymentUrl?.trim() || null;
  const paymentExpiresAt =
    registration.paymentExpiresAt?.trim()
    || new Date(Date.now() + PAYMENT_HOLD_MS).toISOString();
  try {
    window.localStorage.setItem(
      getPaymentStorageKey(exerciseId),
      JSON.stringify({
        paymentUrl,
        paymentExpiresAt,
        bookingId: registration.bookingId ?? null,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // localStorage can be unavailable in embedded/private contexts.
  }
}

function clearStoredPendingPayment(exerciseId: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(getPaymentStorageKey(exerciseId));
  } catch {
    // no-op
  }
}

function mergeStoredPendingPayment(
  exerciseId: string,
  registration: TournamentRegistrationState | null,
): TournamentRegistrationState | null {
  if (!registration) return null;
  if (registration.status !== "PAYMENT_PENDING") {
    clearStoredPendingPayment(exerciseId);
    return registration;
  }

  const stored = readStoredPendingPayment(exerciseId);
  const merged = {
    ...registration,
    paymentUrl: registration.paymentUrl?.trim() || stored?.paymentUrl || null,
    paymentExpiresAt:
      registration.paymentExpiresAt?.trim()
      || stored?.paymentExpiresAt
      || new Date(Date.now() + PAYMENT_HOLD_MS).toISOString(),
    bookingId: registration.bookingId ?? stored?.bookingId ?? null,
  };
  storePendingPayment(exerciseId, merged);
  return merged;
}

function navigateToExternalUrl(urlRaw: string): boolean {
  if (typeof window === "undefined") return false;
  const target = urlRaw.trim();
  if (!target) return false;

  try {
    if (window.top && window.top !== window) {
      window.top.location.href = target;
      return true;
    }
  } catch {
    // Use current frame below when top navigation is blocked.
  }

  try {
    window.location.assign(target);
    return true;
  } catch {
    // Use an anchor click as a last resort inside embedded pages.
  }

  try {
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.target = "_self";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  }
  return null;
}

function pickNumber(value: unknown, keys: string[]): number | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = Number(raw.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function normalizeMoneyRubLabel(value: number | null) {
  if (value == null) return null;
  const rubles = value >= 10000 ? value / 100 : value;
  return `${Math.round(rubles).toLocaleString("ru-RU")} ₽`;
}

function parseCustomRubPriceLabel(value: string) {
  const withoutCurrency = value
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
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCustomRubPriceLabel(value: string) {
  const label = value.trim();
  if (!label || label.includes("₽")) return label;
  const parsed = parseCustomRubPriceLabel(label);
  return parsed === null
    ? label
    : `${Math.round(parsed).toLocaleString("ru-RU")} ₽`;
}

function resolveTournamentCardPriceLabel(tournament: TournamentSignupSummary) {
  const raw = isRecord(tournament.raw) ? tournament.raw : {};
  const skin = pickRecord(raw, ["skin", "tournamentSkin", "customTournament", "publicTournament"]) ?? {};
  const skinPriceLabel = pickString(skin, ["priceLabel", "priceText", "costLabel", "costText"]);
  if (skinPriceLabel) return normalizeCustomRubPriceLabel(skinPriceLabel);

  const skinPrice = pickNumber(skin, ["price", "amount", "cost", "customPrice", "customCost"]);
  const source = pickRecord(raw, ["sourceTournamentSnapshot", "sourceTournament", "tournament", "exercise", "baseTournament"]) ?? raw;
  const sourcePrice = pickNumber(source, ["price", "amount", "cost"]);
  if (skinPrice != null && sourcePrice != null && Math.round(skinPrice) !== Math.round(sourcePrice)) {
    return normalizeMoneyRubLabel(skinPrice);
  }
  if (skinPrice != null && sourcePrice == null && tournament.priceLabel) {
    return normalizeMoneyRubLabel(skinPrice) || tournament.priceLabel;
  }
  const fallbackPriceLabel = normalizeCustomRubPriceLabel(String(tournament.priceLabel || "").trim());
  if (fallbackPriceLabel) return fallbackPriceLabel;
  return "энергия";
}

function collectTournamentDescriptionRecords(
  value: unknown,
  seen = new Set<unknown>(),
): Record<string, unknown>[] {
  if (!isRecord(value) || seen.has(value)) return [];
  seen.add(value);

  const records: Record<string, unknown>[] = [value];
  TOURNAMENT_DESCRIPTION_NESTED_KEYS.forEach((key) => {
    const nested = value[key];
    if (isRecord(nested)) {
      records.push(...collectTournamentDescriptionRecords(nested, seen));
    }
  });
  return records;
}

function resolveTournamentDescription(
  detail: TournamentSignupDetail | null,
  tournament: TournamentSignupSummary | TournamentSignupDetail | null,
): string | null {
  const detailDescription = String(detail?.description || "").trim();
  if (detailDescription) return detailDescription;

  for (const source of [detail?.raw, tournament?.raw, tournament]) {
    for (const record of collectTournamentDescriptionRecords(source)) {
      const value = pickString(record, [
        "description",
        "body",
        "text",
        "details",
        "desc",
        "skinDescription",
      ]);
      if (value) return value;
    }
  }

  return null;
}

function getInitials(value: string) {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] || "")
    .join("")
    .toUpperCase() || "И";
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function toRgbCss(color: Rgb) {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function isLevelGrade(value: string): value is LevelGrade {
  return value in LEVEL_RANGES;
}

function getNormalizedLevelGrade(value: string | null | undefined): LevelGrade | null {
  const normalized = String(value || "").trim().toUpperCase();
  const match = normalized.match(/^([A-D])\s*(\+)?/);
  if (!match) return null;
  const grade = `${match[1]}${match[2] || ""}`;
  return isLevelGrade(grade) ? grade : null;
}

function getLevelRangeProgress(grade: LevelGrade | null, numeric: number | null) {
  const range = grade ? LEVEL_RANGES[grade] : null;
  if (!range || numeric == null) return 0;
  const clamped = Math.max(range.min, Math.min(range.max, numeric));
  return (clamped - range.min) / (range.max - range.min);
}

function getLevelDegree(grade: LevelGrade | null, numeric: number | null) {
  if (!grade || numeric == null) return null;
  const progress = getLevelRangeProgress(grade, numeric);
  return Math.max(1, Math.min(4, Math.floor(progress * 4) + 1));
}

function formatSuperscript(value: number | string) {
  const superscripts: Record<string, string> = {
    "1": "¹",
    "2": "²",
    "3": "³",
    "4": "⁴",
  };
  return String(value).split("").map((char) => superscripts[char] || char).join("");
}

function normalizeLevelLabel(value: string | null | undefined, numeric: number | null) {
  const numericGrade = numeric != null ? getLetterGrade(numeric) : null;
  const normalizedGrade = normalizeLevelGradeLabel(value, numeric);
  const grade = numericGrade && isLevelGrade(numericGrade)
    ? numericGrade
    : (normalizedGrade && isLevelGrade(normalizedGrade) ? normalizedGrade : getNormalizedLevelGrade(value));
  if (grade) {
    const degree = getLevelDegree(grade, numeric);
    return degree ? `${grade}${formatSuperscript(degree)}` : grade;
  }

  const normalized = String(value || "").trim().toUpperCase();
  const token = normalized.match(/^([A-D])\s*([1-4])?(\+)?$/);
  if (!token) return null;
  return `${token[1]}${token[3] || ""}${token[2] ? formatSuperscript(token[2]) : ""}`;
}

function getLiveRatingKey(clientId: string | null | undefined, phone: string | null | undefined, name: string | null | undefined) {
  const safeClientId = String(clientId || "").trim();
  if (safeClientId) return `id:${safeClientId}`;
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm) return `phone:${phoneNorm}`;
  const safeName = String(name || "").trim().toLowerCase();
  return safeName ? `name:${safeName}` : "";
}

function getPlayerLiveRating(
  participant: TournamentSignupParticipant,
  liveRatings: Map<string, PadelLiveRatingItem>,
) {
  const keys = [
    getLiveRatingKey(participant.id, null, null),
    getLiveRatingKey(null, participant.phone, null),
    getLiveRatingKey(null, null, participant.name),
  ].filter(Boolean);
  for (const key of keys) {
    const item = liveRatings.get(key);
    if (item) return item;
  }
  return null;
}

function getPlayerLevelMeta(
  participant: TournamentSignupParticipant,
  liveRating: PadelLiveRatingItem | null,
) {
  const numeric = liveRating?.ratingNumeric ?? participant.ratingNumeric;
  const rawLevel = liveRating?.rating || participant.level;
  const label = normalizeLevelLabel(rawLevel, numeric);
  const numericGrade = numeric != null ? getLetterGrade(numeric) : null;
  const gradeKey = numericGrade && isLevelGrade(numericGrade)
    ? numericGrade
    : getNormalizedLevelGrade(rawLevel);
  const palette = gradeKey ? LEVEL_RING_COLORS[gradeKey] : null;
  const progress = getLevelRangeProgress(gradeKey, numeric);
  const progressDeg = Math.max(16, Math.round(progress * 360));
  const badgeRgb = palette?.badge ?? { r: 123, g: 87, b: 246 };
  const badgeBrightness = (badgeRgb.r * 299 + badgeRgb.g * 587 + badgeRgb.b * 114) / 1000;

  return {
    label,
    ringStyle: label
      ? {
        background: `conic-gradient(from 180deg, ${palette ? toRgbCss(palette.start) : "#8e69ff"} 0deg, ${palette ? toRgbCss(palette.end) : "#6c4ef8"} ${progressDeg}deg, #e7e2ff ${progressDeg}deg, #e7e2ff 360deg)`,
      } satisfies CSSProperties
      : undefined,
    badgeStyle: label
      ? {
        backgroundColor: toRgbCss(badgeRgb),
        color: badgeBrightness > 155 ? "#1A1A1A" : "#FFFFFF",
      } satisfies CSSProperties
      : undefined,
  };
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

function copyPlainTextFallback(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (copyPlainTextFallback(text)) {
    return;
  }

  throw new Error("Clipboard API is not available");
}

function buildTournamentShareUrl(
  tournament: TournamentSignupSummary | TournamentSignupDetail | null,
  fallbackDate: string | null,
): string | null {
  if (!tournament || typeof window === "undefined") return null;
  const tournamentId = String(tournament.id || "").trim();
  if (!tournamentId) return null;

  let currentUrl: URL | null = null;
  try {
    currentUrl = new URL(window.location.href);
  } catch {
    // fallback below
  }

  const currentTournamentId = String(currentUrl?.searchParams.get("tournamentId") || "").trim();
  const fromCurrentSlug = currentTournamentId === tournamentId
    ? normalizeTournamentSlug(
      currentUrl?.searchParams.get("slug")
      || currentUrl?.searchParams.get("tournamentSlug"),
    )
    : null;
  const fromRawSlug = collectTournamentSlugCandidates(tournament.raw)[0] ?? null;
  const fromPublicUrlSlug = extractTournamentSlugFromUrl(tournament.publicUrl) ?? null;
  const slug = fromCurrentSlug || fromRawSlug || fromPublicUrlSlug || slugifyTournamentTitle(tournament.title);

  const date =
    getDateFromInput(tournament.date)
    || getDateFromInput(tournament.startsAt)
    || getDateFromInput(currentUrl?.searchParams.get("date"))
    || getDateFromInput(fallbackDate);

  const origin = currentUrl && !isLocalHostname(currentUrl.hostname)
    ? currentUrl.origin
    : TOURNAMENT_SHARE_ORIGIN;
  const shareUrl = new URL(DEFAULT_PUBLIC_TOURNAMENT_SIGNUP_PATH, origin);
  shareUrl.searchParams.set("tournamentId", tournamentId);
  if (date) shareUrl.searchParams.set("date", date);
  if (slug) shareUrl.searchParams.set("slug", slug);
  return appendCurrentAuthModeToNavigableUrl(shareUrl).toString();
}

function getTournamentParticipants(tournament: TournamentSignupSummary | TournamentSignupDetail | null): TournamentSignupParticipant[] {
  return getTournamentSignupParticipantsFromPayload(tournament?.raw);
}

function toCommunityTournamentCard(
  tournament: TournamentSignupSummary,
  pricingPreview: TournamentPricingPreview | null,
  pricingPreviewLoading: boolean,
  hasFriendlySubscriptionTag: boolean,
  summerSubscriptionOffer: TournamentPricingPromoOnlyOffer | null,
  publicRoster: TournamentSignupPublicRoster | null,
): CommunityTournamentCardData {
  const participants = publicRoster?.participantsCount ?? tournament.participantsCount ?? 0;
  const maxParticipants = tournament.maxParticipants ?? 0;
  const isFull = maxParticipants > 0 && participants >= maxParticipants;
  const spotsLeft = maxParticipants > 0 ? Math.max(0, maxParticipants - participants) : null;
  const progress = maxParticipants > 0 ? participants / maxParticipants : 0;

  return {
    id: tournament.id,
    badgeLabel: tournament.format || "Турнир",
    title: tournament.title,
    subtitle: getTournamentStationLabel(tournament) || "PadelHub",
    metaText: tournament.address || "",
    progress,
    imageUrl: "",
    isJoined: tournament.status === "REGISTERED",
    isFull,
    date: tournament.date || tournament.startsAt || new Date().toISOString(),
    level: tournament.levelLabel || undefined,
    participants,
    maxParticipants,
    startTime: formatClock(tournament.startsAt) || tournament.timeLabel,
    endTime: formatClock(tournament.endsAt) || undefined,
    stationLabel: getTournamentStationLabel(tournament) || tournament.address || "Станция уточняется",
    tournamentTypeLabel: tournament.format || "Турнир",
    ratingLabel: tournament.levelLabel || undefined,
    genderLabel: undefined,
    slotsLabel: maxParticipants > 0 ? `${participants}/${maxParticipants} мест` : `${participants} участников`,
    ctaLabel: "Открыть",
    trainerName: tournament.trainerName || "PadelHub",
    trainerAvatarUrl: tournament.trainerAvatarUrl || undefined,
    profileHandle: tournament.address || getTournamentStationLabel(tournament) || "Расписание турниров",
    publicUrl: tournament.publicUrl || undefined,
    waitlistCount: publicRoster?.waitlistCount ?? tournament.waitlistCount ?? 0,
    spotsLeft,
    priceLabel: pricingPreview?.triggerLabel || resolveTournamentCardPriceLabel(tournament),
    pricePopover: pricingPreview,
    pricePopoverLoading: pricingPreviewLoading,
    hasFriendlySubscriptionTag,
    summerSubscriptionOffer,
  };
}

function shouldRequestTournamentPricingPreview(tournament: TournamentSignupSummary) {
  return !tournament.storedPricingPreview && !tournament.storedSummerSubscriptionOffer;
}

function buildStoredTournamentPricingState(items: TournamentSignupSummary[]) {
  const pricingPreviewByExerciseId: Record<string, TournamentPricingPreview | null> = {};
  const friendlySubscriptionTagByExerciseId: Record<string, boolean> = {};
  const summerSubscriptionOfferByExerciseId: Record<string, TournamentPricingPromoOnlyOffer | null> = {};

  items.forEach((item) => {
    const exerciseId = String(item.exerciseId || "").trim();
    if (!exerciseId) return;
    if (item.storedPricingPreview) {
      pricingPreviewByExerciseId[exerciseId] = item.storedPricingPreview;
    }
    if (item.storedHasFriendlySubscriptionTag) {
      friendlySubscriptionTagByExerciseId[exerciseId] = true;
    }
    if (item.storedSummerSubscriptionOffer) {
      summerSubscriptionOfferByExerciseId[exerciseId] = item.storedSummerSubscriptionOffer;
    }
  });

  return {
    pricingPreviewByExerciseId,
    friendlySubscriptionTagByExerciseId,
    summerSubscriptionOfferByExerciseId,
  };
}

export default function TournamentSignupPage({
  onBack,
  initialTournamentId,
  initialTournamentSlug,
  initialDate,
}: TournamentSignupPageProps) {
  const { isAuthenticated } = useAuth();
  const subscriptionUsageShadow = useSubscriptionUsageShadow();
  const subscriptionUsageShadowEnabled = subscriptionUsageShadow.enabled;
  const subscriptionUsageShadowPreview = subscriptionUsageShadow.preview;
  const subscriptionUsageShadowReject = subscriptionUsageShadow.reject;
  const targetTournamentId = String(initialTournamentId || "").trim() || null;
  const targetTournamentSlug = normalizeTournamentSlug(initialTournamentSlug);
  const targetDeepLinkKey = targetTournamentId || targetTournamentSlug || "";
  const dates = useMemo(() => {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    return Array.from({ length: DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1 }).map((_, index) => {
      const next = new Date(base);
      next.setDate(base.getDate() + index - DAYS_BEFORE_TODAY);
      return next;
    });
  }, []);
  const initialDateKey = getDateFromInput(initialDate);
  const initialDateIndex = dates.findIndex((date) => formatDate(date) === initialDateKey);

  const [dateIndex, setDateIndex] = useState(initialDateIndex >= 0 ? initialDateIndex : DAYS_BEFORE_TODAY);
  const [items, setItems] = useState<TournamentSignupSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(targetTournamentId);
  const [detail, setDetail] = useState<TournamentSignupDetail | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [deepLinkLookupPending, setDeepLinkLookupPending] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelDialogBookingId, setCancelDialogBookingId] = useState<string | null>(null);
  const [deepLinkMessage, setDeepLinkMessage] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<TournamentVivaCheckout | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<TournamentDetailTab>("roster");
  const [typeFilter, setTypeFilter] = useState(ALL_FILTER_VALUE);
  const [stationFilter, setStationFilter] = useState(ALL_FILTER_VALUE);
  const [liveRatings, setLiveRatings] = useState<Map<string, PadelLiveRatingItem>>(() => new Map());
  const [inviteSharing, setInviteSharing] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<"shared" | "copied" | null>(null);
  const [confirmingSubscriptionProductKey, setConfirmingSubscriptionProductKey] = useState<string | null>(null);
  const [subscriptionConfirmationNotice, setSubscriptionConfirmationNotice] = useState<string | null>(null);
  const [registrationResolvedFor, setRegistrationResolvedFor] = useState<string | null>(null);
  const [checkoutPreparedFor, setCheckoutPreparedFor] = useState<string | null>(null);
  const [pendingPaymentProduct, setPendingPaymentProduct] = useState<TournamentVivaProduct | null>(null);
  const [isPurchasableListOpen, setPurchasableListOpen] = useState(false);
  const [isStationModalOpen, setStationModalOpen] = useState(false);
  const [pricingPreviewByExerciseId, setPricingPreviewByExerciseId] = useState<Record<string, TournamentPricingPreview | null>>({});
  const [pricingPreviewLoadingByExerciseId, setPricingPreviewLoadingByExerciseId] = useState<Record<string, boolean>>({});
  const [friendlySubscriptionTagByExerciseId, setFriendlySubscriptionTagByExerciseId] = useState<Record<string, boolean>>({});
  const [summerSubscriptionOfferByExerciseId, setSummerSubscriptionOfferByExerciseId] = useState<
    Record<string, TournamentPricingPromoOnlyOffer | null>
  >({});
  const [publicRosterByExerciseId, setPublicRosterByExerciseId] = useState<Record<string, TournamentSignupPublicRoster>>({});
  const deepLinkLookupKeyRef = useRef<string>("");
  const deepLinkAutoOpenKeyRef = useRef<string>("");
  const requestedPricingPreviewIdsRef = useRef<Set<string>>(new Set());
  const publicRosterByExerciseIdRef = useRef<Record<string, TournamentSignupPublicRoster>>({});
  const publicRosterRequestsRef = useRef<Map<string, Promise<TournamentSignupPublicRoster | null>>>(new Map());
  const publicRosterDetailAbortRef = useRef<AbortController | null>(null);
  const listRequestIdRef = useRef(0);
  const listForegroundRequestIdRef = useRef(0);
  const listMountedRef = useRef(true);

  const selectedDate = dates[dateIndex] ?? dates[DAYS_BEFORE_TODAY] ?? new Date();
  const selectedDateStr = formatDate(selectedDate);
  const selectedListTournament = selectedId
    ? items.find((item) => item.id === selectedId) ?? null
    : null;
  const selectedTournament = selectedListTournament ?? detail;
  const selectedExerciseId = detail?.exerciseId ?? selectedListTournament?.exerciseId ?? selectedId;
  const previewSubscriptionDiscount = useCallback(async (eventId: string) => {
    await subscriptionUsageShadowPreview({
      action: "BOOK_TOURNAMENT",
      target: { targetKind: "EVENT_AGGREGATE", eventId },
    });
  }, [subscriptionUsageShadowPreview]);
  const typeFilterOptions = useMemo(
    () => getUniqueFilterValues(items.map(getTournamentTypeFilterValue)),
    [items],
  );
  const stationFilterOptions = useMemo(
    () => getUniqueFilterValues(items.map(getTournamentStationFilterValue)),
    [items],
  );
  const filteredItems = useMemo(
    () => items.filter((item) => (
      (typeFilter === ALL_FILTER_VALUE || getTournamentTypeFilterValue(item) === typeFilter)
      && (stationFilter === ALL_FILTER_VALUE || getTournamentStationFilterValue(item) === stationFilter)
    )),
    [items, stationFilter, typeFilter],
  );

  useEffect(() => {
    publicRosterByExerciseIdRef.current = publicRosterByExerciseId;
  }, [publicRosterByExerciseId]);

  useEffect(() => () => {
    publicRosterDetailAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (selectedId) return;
    publicRosterDetailAbortRef.current?.abort();
    publicRosterDetailAbortRef.current = null;
  }, [selectedId]);

  useEffect(() => {
    deepLinkLookupKeyRef.current = "";
    deepLinkAutoOpenKeyRef.current = "";
    setDeepLinkMessage(null);
    if (targetTournamentId) {
      setSelectedId(targetTournamentId);
      return;
    }
    if (targetTournamentSlug) {
      setSelectedId(null);
    }
  }, [targetTournamentId, targetTournamentSlug]);

  useEffect(() => {
    if (!initialDateKey) return;
    const nextIndex = dates.findIndex((date) => formatDate(date) === initialDateKey);
    if (nextIndex >= 0) {
      setDateIndex(nextIndex);
    }
  }, [dates, initialDateKey]);

  useEffect(() => {
    if (initialDateKey || !targetDeepLinkKey || !detail) return;
    const nextDateKey = getDateFromInput(detail.date) || getDateFromInput(detail.startsAt);
    if (!nextDateKey) return;
    const nextIndex = dates.findIndex((date) => formatDate(date) === nextDateKey);
    if (nextIndex >= 0) {
      setDateIndex(nextIndex);
    }
  }, [dates, detail, initialDateKey, targetDeepLinkKey]);

  const loadPublicRoster = useCallback(async (
    exerciseId: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ) => {
    const normalizedExerciseId = String(exerciseId || "").trim();
    if (!normalizedExerciseId) return null;

    const cachedRoster = publicRosterByExerciseIdRef.current[normalizedExerciseId] ?? null;
    if (cachedRoster && !options.force) return cachedRoster;

    const inFlight = publicRosterRequestsRef.current.get(normalizedExerciseId);
    if (inFlight) return inFlight;

    const requestPromise = apiFetchTournamentParticipants(normalizedExerciseId, {
      auth: false,
      retries: 0,
      signal: options.signal,
    })
      .then((result) => {
        if (!result.data) return cachedRoster;
        const roster = normalizeTournamentSignupPublicRoster(result.data);
        setPublicRosterByExerciseId((current) => ({
          ...current,
          [normalizedExerciseId]: roster,
        }));
        return roster;
      });

    publicRosterRequestsRef.current.set(normalizedExerciseId, requestPromise);
    try {
      return await requestPromise;
    } finally {
      if (publicRosterRequestsRef.current.get(normalizedExerciseId) === requestPromise) {
        publicRosterRequestsRef.current.delete(normalizedExerciseId);
      }
    }
  }, []);

  const loadList = useCallback(async (options: {
    requestRefresh?: boolean;
    background?: boolean;
  } = {}): Promise<void> => {
    const requestId = listRequestIdRef.current + 1;
    listRequestIdRef.current = requestId;
    if (!options.background) {
      listForegroundRequestIdRef.current = requestId;
      setLoadingList(true);
      setError(null);
    }
    const result = await apiFetchTournamentSignupList({
      date: selectedDateStr,
      refresh: options.requestRefresh ? "if-stale" : null,
    });
    if (!listMountedRef.current) return;
    if (requestId !== listRequestIdRef.current) {
      if (!options.background && listForegroundRequestIdRef.current === requestId) {
        setLoadingList(false);
      }
      return;
    }

    if (result.error) {
      if (!options.background) {
        setError(result.error.message || "Не удалось загрузить турниры");
        setItems([]);
      }
    } else {
      const sortedItems = sortTournaments(result.data ?? []);
      const storedPricingState = buildStoredTournamentPricingState(sortedItems);
      setItems(sortedItems);
      setPricingPreviewByExerciseId((current) => ({
        ...current,
        ...storedPricingState.pricingPreviewByExerciseId,
      }));
      setFriendlySubscriptionTagByExerciseId((current) => ({
        ...current,
        ...storedPricingState.friendlySubscriptionTagByExerciseId,
      }));
      setSummerSubscriptionOfferByExerciseId((current) => ({
        ...current,
        ...storedPricingState.summerSubscriptionOfferByExerciseId,
      }));
    }
    if (!options.background && listForegroundRequestIdRef.current === requestId) {
      setLoadingList(false);
    }
  }, [selectedDateStr]);

  const refreshTournamentList = useCallback(async () => {
    await loadList({ requestRefresh: !subscriptionUsageShadowEnabled });
  }, [loadList, subscriptionUsageShadowEnabled]);

  const loadDetail = useCallback(async (tournamentId: string) => {
    setLoadingDetail(true);
    setError(null);
    setRegistrationResolvedFor(null);
    const detailResult = await apiFetchTournamentSignupDetail(tournamentId);
    const fallbackExerciseId = items.find((item) => item.id === tournamentId)?.exerciseId ?? tournamentId;
    const exerciseId = detailResult.data?.exerciseId || fallbackExerciseId;
    publicRosterDetailAbortRef.current?.abort();
    const rosterAbortController = new AbortController();
    publicRosterDetailAbortRef.current = rosterAbortController;
    void loadPublicRoster(exerciseId, { signal: rosterAbortController.signal }).finally(() => {
      if (publicRosterDetailAbortRef.current === rosterAbortController) {
        publicRosterDetailAbortRef.current = null;
      }
    });
    const [registrationResult, vivaRegistrationResult] = isAuthenticated && !subscriptionUsageShadowEnabled
      ? await Promise.all([
          apiFetchTournamentMyRegistration(tournamentId),
          apiFetchTournamentVivaMyRegistration(exerciseId),
        ])
      : [null, null];

    if (detailResult.error) {
      setError(detailResult.error.message || "Не удалось открыть турнир");
      setDetail(null);
    } else {
      setDetail(detailResult.data ?? null);
    }
    const resolvedRegistration = mergeStoredPendingPayment(
      exerciseId,
      vivaRegistrationResult?.data ?? registrationResult?.data ?? detailResult.data?.registration ?? null,
    );
    setRegistration(resolvedRegistration);
    setRegistrationResolvedFor(`${tournamentId}:${exerciseId}`);
    setLoadingDetail(false);
  }, [isAuthenticated, items, loadPublicRoster, subscriptionUsageShadowEnabled]);

  const ensurePricingPreviewLoaded = useCallback(async (tournament: TournamentSignupSummary | null | undefined) => {
    if (subscriptionUsageShadowEnabled) return;
    if (!tournament) return;

    const exerciseId = String(tournament.exerciseId || "").trim();
    if (!exerciseId) return;

    const requestedPricingPreviewIds = requestedPricingPreviewIdsRef.current;
    if (requestedPricingPreviewIds.has(exerciseId)) return;
    requestedPricingPreviewIds.add(exerciseId);

    setPricingPreviewLoadingByExerciseId((current) => (
      current[exerciseId]
        ? current
        : { ...current, [exerciseId]: true }
    ));

    const tournamentPayload = tournament.raw ?? tournament;
    const result = await apiFetchTournamentVivaPublicCheckout(exerciseId, {
      tournament: tournamentPayload,
      skinPriceLabel: findTournamentSkinPriceLabel(tournamentPayload),
    });

    if (result.error) {
      requestedPricingPreviewIds.delete(exerciseId);
      setPricingPreviewLoadingByExerciseId((current) => ({ ...current, [exerciseId]: false }));
      return;
    }

    const products = result.data ? getTournamentCheckoutProducts(result.data) : [];
    setPricingPreviewByExerciseId((current) => ({
      ...current,
      [exerciseId]: result.data ? buildTournamentPricingPreviewFromCheckout(result.data) : null,
    }));
    setFriendlySubscriptionTagByExerciseId((current) => ({
      ...current,
      [exerciseId]: hasPromoOnlyTournamentProducts(products),
    }));
    setSummerSubscriptionOfferByExerciseId((current) => ({
      ...current,
      [exerciseId]: buildTournamentPromoOnlyOfferFromProducts(products),
    }));
    setPricingPreviewLoadingByExerciseId((current) => ({ ...current, [exerciseId]: false }));
  }, [subscriptionUsageShadowEnabled]);

  useEffect(() => {
    listMountedRef.current = true;
    void refreshTournamentList();
    return () => {
      listMountedRef.current = false;
      listRequestIdRef.current += 1;
    };
  }, [refreshTournamentList]);

  useEffect(() => {
    if (!targetDeepLinkKey || selectedId) return;

    const targetTournament = findTournamentByDeepLink(items, {
      tournamentId: targetTournamentId,
      tournamentSlug: targetTournamentSlug,
    });
    if (!targetTournament) return;

    const autoOpenKey = `${targetDeepLinkKey}:${targetTournament.id}`;
    if (deepLinkAutoOpenKeyRef.current === autoOpenKey) return;
    deepLinkAutoOpenKeyRef.current = autoOpenKey;

    const targetDateKey = getDateFromInput(targetTournament.date) || getDateFromInput(targetTournament.startsAt);
    if (targetDateKey) {
      const nextIndex = dates.findIndex((date) => formatDate(date) === targetDateKey);
      if (nextIndex >= 0) {
        setDateIndex(nextIndex);
      }
    }

    setDeepLinkMessage(null);
    setSelectedId(targetTournament.id);
  }, [
    dates,
    items,
    selectedId,
    targetDeepLinkKey,
    targetTournamentId,
    targetTournamentSlug,
  ]);

  useEffect(() => {
    if (targetTournamentId || !targetTournamentSlug || selectedId || loadingList || deepLinkLookupPending) return;
    if (findTournamentByDeepLink(items, { tournamentSlug: targetTournamentSlug })) return;
    if (deepLinkLookupKeyRef.current === targetDeepLinkKey) return;

    deepLinkLookupKeyRef.current = targetDeepLinkKey;
    let alive = true;
    setDeepLinkLookupPending(true);
    setDeepLinkMessage("Ищем турнир по ссылке...");

    void (async () => {
      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const dateFrom = new Date(today);
        dateFrom.setDate(today.getDate() - DEEP_LINK_LOOKUP_DAYS_BEFORE_TODAY);

        const dateTo = new Date(today);
        dateTo.setDate(today.getDate() + DEEP_LINK_LOOKUP_DAYS_AFTER_TODAY);

        const result = await apiFetchTournamentSignupList({
          from: formatDate(dateFrom),
          to: formatDate(dateTo),
        });
        if (!alive) return;

        const resolvedTournament = findTournamentByDeepLink(
          sortTournaments(result.data ?? []),
          { tournamentSlug: targetTournamentSlug },
        );

        if (!resolvedTournament) {
          setDeepLinkMessage("Турнир по ссылке не найден");
          return;
        }

        const targetDateKey = getDateFromInput(resolvedTournament.date) || getDateFromInput(resolvedTournament.startsAt);
        if (targetDateKey) {
          const nextIndex = dates.findIndex((date) => formatDate(date) === targetDateKey);
          if (nextIndex >= 0) {
            setDateIndex(nextIndex);
          }
        }

        setDeepLinkMessage(null);
        setSelectedId((current) => current || resolvedTournament.id);
      } catch {
        if (!alive) return;
        setDeepLinkMessage("Не удалось открыть турнир по ссылке");
      } finally {
        if (alive) setDeepLinkLookupPending(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [
    dates,
    deepLinkLookupPending,
    items,
    loadingList,
    selectedId,
    targetDeepLinkKey,
    targetTournamentId,
    targetTournamentSlug,
  ]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRegistration(null);
      setCheckout(null);
      setAuthRequired(false);
      setPendingPaymentProduct(null);
      setConfirmingSubscriptionProductKey(null);
      setSubscriptionConfirmationNotice(null);
      setRegistrationResolvedFor(null);
      setActiveDetailTab("roster");
      setPurchasableListOpen(false);
      setStationModalOpen(false);
      return;
    }
    setCheckout(null);
    setCheckoutPreparedFor(null);
    setPendingPaymentProduct(null);
    setConfirmingSubscriptionProductKey(null);
    setSubscriptionConfirmationNotice(null);
    setRegistrationResolvedFor(null);
    setPurchasableListOpen(false);
    setStationModalOpen(false);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    setInviteFeedback(null);
    setInviteSharing(false);
  }, [selectedId]);

  const completeVivaRegistration = useCallback(async (nextCheckout: TournamentVivaCheckout, product: TournamentVivaProduct) => {
    if (!selectedId || !selectedExerciseId || actionLoading) return;
    if (subscriptionUsageShadowEnabled) {
      await previewSubscriptionDiscount(selectedExerciseId);
      return;
    }
    if (!isAuthenticated || !nextCheckout.profile) {
      setPendingPaymentProduct(product);
      setAuthRequired(true);
      setError(null);
      return;
    }

    const profile = nextCheckout.profile;
    const subscriptionProductKey = product.source === "client-subscription"
      ? `${product.source}:${product.id}`
      : null;
    setActionLoading(true);
    setError(null);
    setSubscriptionConfirmationNotice(null);
    setConfirmingSubscriptionProductKey(subscriptionProductKey);
    try {
      const result = await apiCreateTournamentVivaTransaction({
        exerciseId: selectedExerciseId,
        studioId: nextCheckout.studioId,
        clientId: profile.id,
        profile,
        clientPhone: normalizePhone(profile.phone) || profile.phone,
        product,
        customPricing: nextCheckout.customPricing,
        tournament: detail?.raw ?? selectedTournament?.raw ?? selectedTournament,
        exercise: nextCheckout.exercise,
      });
      if (result.error || !result.data) {
        if (result.status === 202 && subscriptionProductKey) {
          setError(null);
          setSubscriptionConfirmationNotice(
            "Viva приняла запись. Подтверждение может занять до минуты — состав обновится автоматически.",
          );
          setCheckout(null);
          await loadPublicRoster(selectedExerciseId, { force: true });
          await loadDetail(selectedId);
          await loadList();
          return;
        }
        setError(result.error?.message || "Не удалось создать запись через Viva");
        return;
      }
      if (result.data.paymentUrl) {
        const nextRegistration: TournamentRegistrationState = {
          status: "PAYMENT_PENDING",
          bookingId: result.data.bookingId,
          placeNumber: null,
          waitlistNumber: null,
          canRegister: false,
          canCancel: true,
          message: "Запись создана в Viva, ожидается оплата.",
          paymentUrl: result.data.paymentUrl,
          paymentExpiresAt: result.data.paymentExpiresAt ?? new Date(Date.now() + PAYMENT_HOLD_MS).toISOString(),
        };
        storePendingPayment(selectedExerciseId, nextRegistration);
        setRegistration(nextRegistration);
        if (!navigateToExternalUrl(result.data.paymentUrl)) {
          setError("Не удалось открыть страницу оплаты");
        }
        return;
      }
      setCheckout(null);
      clearStoredPendingPayment(selectedExerciseId);
      await loadPublicRoster(selectedExerciseId, { force: true });
      await loadDetail(selectedId);
      await loadList();
    } finally {
      setConfirmingSubscriptionProductKey(null);
      setActionLoading(false);
    }
  }, [
    actionLoading,
    detail,
    isAuthenticated,
    loadDetail,
    loadList,
    loadPublicRoster,
    previewSubscriptionDiscount,
    selectedExerciseId,
    selectedId,
    selectedTournament,
    subscriptionUsageShadowEnabled,
  ]);

  const loadCheckout = useCallback(async (mode: "auth" | "public") => {
    if (!selectedId || !selectedExerciseId || actionLoading) return;
    if (subscriptionUsageShadowEnabled) {
      setCheckout(null);
      return;
    }
    setActionLoading(true);
    setError(null);
    setCheckout(null);
    const tournamentPayload = detail?.raw ?? selectedTournament?.raw ?? selectedTournament;
    const fetchCheckout = mode === "auth"
      ? apiFetchTournamentVivaCheckout
      : apiFetchTournamentVivaPublicCheckout;
    const result = await fetchCheckout(selectedExerciseId, {
      tournament: tournamentPayload,
      skinPriceLabel: findTournamentSkinPriceLabel(tournamentPayload),
    });
    setActionLoading(false);

    if (result.error || !result.data) {
      setError(result.error?.message || "Не удалось подготовить запись через Viva");
      return;
    }

    const availableProducts = [
      ...result.data.oneTimes,
      ...result.data.subscriptions,
      ...result.data.clientSubscriptions,
    ];
    if (availableProducts.length === 0) {
      if (mode === "public") {
        setCheckout(result.data);
        return;
      }
      setError(
        result.data.customPricing
          ? "Для кастомной цены в Viva не найден продукт «Энергия турниры»"
          : result.data.purchasedProducts.length > 0
          ? "У клиента есть подходящий продукт, но для списания нужен отдельный Viva-пейлоад. Покупаемые услуги для этого турнира не найдены."
          : "Для этого турнира в Viva нет доступных услуг или абонементов для покупки",
      );
      return;
    }
    setCheckout(result.data);
  }, [
    actionLoading,
    detail,
    selectedExerciseId,
    selectedId,
    selectedTournament,
    subscriptionUsageShadowEnabled,
  ]);

  const handleCancel = async () => {
    if (!selectedId || !selectedExerciseId || actionLoading) return;
    if (subscriptionUsageShadowEnabled) {
      subscriptionUsageShadowReject("DEV-shadow не изменяет существующие записи");
      return;
    }
    if (!isAuthenticated) {
      setAuthRequired(true);
      setError(null);
      return;
    }

    setActionLoading(true);
    setError(null);
    const result = await apiResolveTournamentVivaRegistrationBookingId(selectedExerciseId, registration?.bookingId, {
      placeNumber: registration?.placeNumber ?? null,
    });
    if (result.error) {
      setError(result.error.message || "Не удалось отменить запись");
    } else {
      setCancelDialogBookingId(result.data);
    }
    setActionLoading(false);
  };

  const handlePayPendingRegistration = () => {
    if (subscriptionUsageShadowEnabled) {
      subscriptionUsageShadowReject("DEV-shadow не открывает оплату");
      return;
    }
    const paymentUrl = registration?.paymentUrl?.trim();
    if (!paymentUrl) {
      setError("Ссылка на оплату пока не найдена. Обновите статус записи.");
      return;
    }
    if (!navigateToExternalUrl(paymentUrl)) {
      setError("Не удалось открыть страницу оплаты");
    }
  };

  const handleInviteFriend = useCallback(async () => {
    if (!selectedTournament) return;

    const shareUrl = buildTournamentShareUrl(selectedTournament, selectedDateStr);
    if (!shareUrl) {
      setError("Ссылка на этот турнир пока недоступна.");
      return;
    }

    const tournamentTitle = selectedTournament.title || "Турнир PadelHub";
    const inviteText = `Присоединяйся к турниру «${tournamentTitle}»`;
    const shareMessage = `${inviteText}\n${shareUrl}`;

    setError(null);
    setInviteSharing(true);
    setInviteFeedback(null);

    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        try {
          await navigator.share({
            text: shareMessage,
          });
          setInviteFeedback("shared");
          window.setTimeout(() => setInviteFeedback((current) => (current === "shared" ? null : current)), 1600);
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }

      await writeTextToClipboard(shareMessage);
      setInviteFeedback("copied");
      window.setTimeout(() => setInviteFeedback((current) => (current === "copied" ? null : current)), 1600);
    } catch {
      setError("Не удалось поделиться ссылкой на турнир.");
    } finally {
      setInviteSharing(false);
    }
  }, [selectedDateStr, selectedTournament]);

  const canPayPending = Boolean(registration?.status === "PAYMENT_PENDING" && registration?.paymentUrl);
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  const canRegister = !subscriptionConfirmationNotice
    && canOfferTournamentRegistration(detail?.status, registration);
  const detailDateParts = getDateParts(selectedTournament?.date ?? null);
  const detailStartTime = formatClock(selectedTournament?.startsAt ?? null);
  const detailEndTime = formatClock(selectedTournament?.endsAt ?? null);
  const detailTimeLabel = detailStartTime && detailEndTime
    ? `${detailStartTime} • ${detailEndTime}`
    : selectedTournament?.timeLabel || "Время уточняется";
  const detailStationLabel = getTournamentStationLabel(selectedTournament) || "Станция уточняется";
  const detailStationMapUrl = getStationMapUrl(detailStationLabel, selectedTournament?.address ?? null);
  const detailPublicRoster = selectedExerciseId ? publicRosterByExerciseId[selectedExerciseId] ?? null : null;
  const detailParticipants = useMemo(
    () => detailPublicRoster?.participants ?? getTournamentParticipants(detail || selectedTournament),
    [detail, detailPublicRoster, selectedTournament],
  );
  const detailTournamentTypeLabel = selectedTournament?.format || "Турнир";
  const detailRulesInfographic = getTournamentRulesInfographic(selectedTournament);
  const detailMaxParticipants = selectedTournament?.maxParticipants ?? 0;
  const detailParticipantCount = detailPublicRoster?.participantsCount
    ?? Math.max(detailParticipants.length, selectedTournament?.participantsCount ?? 0);
  const detailTrainerName = detail?.trainerName || selectedTournament?.trainerName || null;
  const detailTrainerAvatarUrl = detail?.trainerAvatarUrl || selectedTournament?.trainerAvatarUrl || null;
  const detailDescription = resolveTournamentDescription(detail, selectedTournament);
  const inviteFriendLabel = inviteSharing
    ? "Готовим ссылку..."
    : inviteFeedback === "shared"
      ? "Ссылка отправлена"
      : inviteFeedback === "copied"
        ? "Ссылка скопирована"
        : "Пригласи друга";
  const purchasableSubscriptionProducts = checkout
    ? [...checkout.oneTimes, ...checkout.subscriptions]
      .filter((product) => !isPromoOnlyPurchasableProduct(product))
    : [];

  useEffect(() => {
    if (!selectedId || !selectedExerciseId) {
      setCheckoutPreparedFor(null);
      return;
    }
    if (subscriptionUsageShadowEnabled) {
      setCheckout(null);
      setCheckoutPreparedFor(null);
      return;
    }
    const registrationResolutionKey = `${selectedId}:${selectedExerciseId}`;
    if (registrationResolvedFor !== registrationResolutionKey) {
      setCheckout(null);
      setCheckoutPreparedFor(null);
      return;
    }
    if (!canRegister) {
      setCheckout(null);
      setCheckoutPreparedFor(null);
      return;
    }
    const mode = isAuthenticated ? "auth" : "public";
    const checkoutKey = `${selectedId}:${selectedExerciseId}:${mode}`;
    if (checkoutPreparedFor === checkoutKey && checkout) return;
    if (actionLoading) return;
    setCheckoutPreparedFor(checkoutKey);
    void loadCheckout(mode);
  }, [
    actionLoading,
    canRegister,
    checkout,
    checkoutPreparedFor,
    isAuthenticated,
    loadCheckout,
    registrationResolvedFor,
    selectedExerciseId,
    selectedId,
    subscriptionUsageShadowEnabled,
  ]);

  useEffect(() => {
    if (subscriptionUsageShadowEnabled) return;
    if (!pendingPaymentProduct || !isAuthenticated || !checkout?.profile || actionLoading) return;
    const matchedProduct = findMatchingTournamentPaymentProduct(checkout, pendingPaymentProduct);
    if (!matchedProduct) {
      setPendingPaymentProduct(null);
      setError("После входа выбранный способ оплаты не найден. Выберите способ записи ещё раз.");
      return;
    }
    setPendingPaymentProduct(null);
    void completeVivaRegistration(checkout, matchedProduct);
  }, [
    actionLoading,
    checkout,
    completeVivaRegistration,
    isAuthenticated,
    pendingPaymentProduct,
    subscriptionUsageShadowEnabled,
  ]);

  useEffect(() => {
    if (subscriptionUsageShadowEnabled) {
      setLiveRatings(new Map());
      return;
    }
    if (!selectedId || detailParticipants.length === 0) {
      setLiveRatings(new Map());
      return;
    }

    let cancelled = false;
    const players = detailParticipants.map((participant) => ({
      clientId: participant.id,
      phone: participant.phone,
      name: participant.name,
      rating: participant.level,
      ratingNumeric: participant.ratingNumeric,
    }));

    void apiFetchPadelLiveRatings(players).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setLiveRatings(new Map());
        return;
      }
      const next = new Map<string, PadelLiveRatingItem>();
      result.data.forEach((item) => {
        const keys = [
          getLiveRatingKey(item.clientId, null, null),
          getLiveRatingKey(null, item.phoneNorm, null),
          getLiveRatingKey(null, null, item.name),
        ].filter(Boolean);
        keys.forEach((key) => next.set(key, item));
      });
      setLiveRatings(next);
    });

    return () => {
      cancelled = true;
    };
  }, [detailParticipants, selectedId, subscriptionUsageShadowEnabled]);

  return (
    <div className="tournament-signup-page">
      <header className="tournament-signup-header">
        <button className="page-back" onClick={selectedId ? () => setSelectedId(null) : onBack} type="button">
          ← Назад
        </button>
        <div className="tournament-signup-header-title">
          <div className="page-title">Запись на турниры</div>
        </div>
      </header>

      {!selectedId && (
        <section className="tournament-signup-section">
          <div className="date-row">
            {dates.map((date, index) => {
              const monthLabel = date
                .toLocaleDateString("ru-RU", { month: "short" })
                .replace(".", "")
                .trim()
                .slice(0, 3)
                .toUpperCase();
              const weekdayLabel = date
                .toLocaleDateString("ru-RU", { weekday: "short" })
                .replace(".", "")
                .toUpperCase();
              const dayLabel = date.toLocaleDateString("ru-RU", { day: "2-digit" });

              return (
                <div key={date.toISOString()} className="date-item">
                  <div className="date-weekday">{weekdayLabel}</div>
                  <button
                    className={`date-chip ${dateIndex === index ? "active" : ""}`}
                    data-date-index={index}
                    type="button"
                    onClick={() => {
                      setDateIndex(index);
                      setTypeFilter(ALL_FILTER_VALUE);
                      setStationFilter(ALL_FILTER_VALUE);
                    }}
                  >
                    <div className="booking-date-badge">
                      <div className="booking-date-badge-month">{monthLabel}</div>
                      <div className="booking-date-badge-day">{dayLabel}</div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>

          <div className="tournament-signup-filterbar">
            <label className="tournament-signup-filter">
              <span>Тип</span>
              <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
                <option value={ALL_FILTER_VALUE}>Все типы</option>
                {typeFilterOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>

            <label className="tournament-signup-filter">
              <span>Станция</span>
              <select value={stationFilter} onChange={(event) => setStationFilter(event.target.value)}>
                <option value={ALL_FILTER_VALUE}>Все станции</option>
                {stationFilterOptions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>

            <button
              className="tournament-signup-refresh"
              type="button"
              onClick={() => void refreshTournamentList()}
              disabled={loadingList}
              aria-label="Обновить турниры"
              title="Обновить"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 6v5h-5" />
                <path d="M4 18v-5h5" />
                <path d="M18.2 9A7 7 0 0 0 6.4 6.3L4 8.5" />
                <path d="M5.8 15A7 7 0 0 0 17.6 17.7L20 15.5" />
              </svg>
            </button>
          </div>

          {deepLinkMessage && <div className="tournament-signup-muted">{deepLinkMessage}</div>}
          {loadingList && <div className="tournament-signup-muted">Загрузка...</div>}
          {!loadingList && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingList && !deepLinkLookupPending && !deepLinkMessage && !error && items.length === 0 && (
            <div className="tournament-signup-muted">На выбранную дату турниров нет</div>
          )}
          {!loadingList && !deepLinkLookupPending && !deepLinkMessage && !error && items.length > 0 && filteredItems.length === 0 && (
            <div className="tournament-signup-muted">По выбранным фильтрам турниров нет</div>
          )}

          <div className="tournament-signup-list">
            {filteredItems.map((tournament) => (
              <CommunityTournamentCard
                key={tournament.id}
                card={toCommunityTournamentCard(
                  tournament,
                  pricingPreviewByExerciseId[tournament.exerciseId] ?? null,
                  Boolean(pricingPreviewLoadingByExerciseId[tournament.exerciseId]),
                  Boolean(friendlySubscriptionTagByExerciseId[tournament.exerciseId]),
                  summerSubscriptionOfferByExerciseId[tournament.exerciseId] ?? null,
                  publicRosterByExerciseId[tournament.exerciseId] ?? null,
                )}
                onOpen={() => {
                  setCheckout(null);
                  setSelectedId(tournament.id);
                }}
                onRequestPriceDetails={shouldRequestTournamentPricingPreview(tournament)
                  ? () => {
                    void ensurePricingPreviewLoaded(tournament);
                  }
                  : undefined}
              />
            ))}
          </div>
        </section>
      )}

      {selectedId && (
        <section className="tournament-signup-section tournament-signup-detail">
          {authRequired && (
            <div className="tournament-signup-auth">
              <div className="tournament-signup-auth-head">
                <strong>Вход для записи</strong>
                <button
                  className="tournament-signup-ghost"
                  type="button"
                  onClick={() => {
                    setAuthRequired(false);
                    setPendingPaymentProduct(null);
                  }}
                >
                  Закрыть
                </button>
              </div>
              <AuthForm
                allowPhoneLogin={false}
                onLogin={() => {
                  setAuthRequired(false);
                }}
              />
            </div>
          )}
          {loadingDetail && <div className="tournament-signup-muted">Загрузка турнира...</div>}
          {!loadingDetail && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingDetail && subscriptionConfirmationNotice && (
            <div className="tournament-signup-notice" role="status" aria-live="polite">
              {subscriptionConfirmationNotice}
            </div>
          )}
          {!loadingDetail && selectedTournament && (
            <>
              {!subscriptionUsageShadowEnabled
                && cancelDialogBookingId
                && selectedExerciseId
                && selectedId && (
                <BookingCancellationDialog
                  bookingId={cancelDialogBookingId}
                  isOpen={Boolean(cancelDialogBookingId)}
                  title="Отмена записи на турнир"
                  onClose={() => setCancelDialogBookingId(null)}
                  onSuccessClose={() => {
                    clearStoredPendingPayment(selectedExerciseId);
                    setCancelDialogBookingId(null);
                    void loadDetail(selectedId);
                    void loadList();
                  }}
                  executeAction={async (action) => {
                    const result = await apiCancelTournamentVivaRegistration(
                      selectedExerciseId,
                      cancelDialogBookingId,
                      {
                        placeNumber: registration?.placeNumber ?? null,
                        refundMethod: action.refundMethod,
                      },
                    );
                    return {
                      ok: !result.error,
                      message: result.error?.message || result.data?.message || action.successMessage,
                    };
                  }}
                />
              )}
              <div className="details-card tournament-signup-details-card">
                <div className="details-row">
                  <div className="details-main">
                    <div className="details-date details-date-capitalize">{getDateLabel(selectedTournament.date)}</div>
                    <div className="details-time">{detailTimeLabel}</div>
                    <div className="details-time">
                      <button
                        type="button"
                        className="tournament-signup-station-link"
                        onClick={() => setStationModalOpen(true)}
                      >
                        {detailStationLabel}
                      </button>
                    </div>
                    <div className="details-time details-time-strong">{selectedTournament.title}</div>
                    <div className="details-time">{detailTournamentTypeLabel}</div>
                  </div>
                  <CalendarDateBadge
                    monthLabel={detailDateParts.month}
                    dayLabel={detailDateParts.day}
                    weekdayLabel={detailDateParts.weekday}
                    badgeClassName="game-created-date-badge"
                    disabled
                  />
                </div>
              </div>

              <div className="details-tabs" role="tablist" aria-label="Разделы турнира">
                {TOURNAMENT_DETAIL_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={activeDetailTab === tab.id}
                    className={`details-tab ${activeDetailTab === tab.id ? "active" : ""}`}
                    onClick={() => setActiveDetailTab(tab.id)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {activeDetailTab === "roster" && (
                <>
                  {detailTrainerName && (
                    <div className="details-roster-card details-organizer-card">
                      <div className="details-roster-head">
                        <div className="details-roster-title">Организатор</div>
                      </div>
                      <div className="details-roster-list">
                        <div className="details-roster-row">
                          <div className="details-roster-player">
                            {detailTrainerAvatarUrl ? (
                              <img src={detailTrainerAvatarUrl} alt={detailTrainerName} className="details-roster-avatar" />
                            ) : (
                              <span className="details-roster-avatar details-roster-avatar-fallback">{getInitials(detailTrainerName)}</span>
                            )}
                            <div className="details-roster-meta">
                              <div className="details-roster-name">{detailTrainerName}</div>
                            </div>
                          </div>
                          <span className="details-roster-badge">Организатор</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {detailDescription && (
                    <div className="details-match-comment tournament-signup-description" aria-label="Описание турнира">
                      <span className="details-match-comment-quote" aria-hidden="true">“</span>
                      <span>{detailDescription}</span>
                      <span className="details-match-comment-quote" aria-hidden="true">”</span>
                    </div>
                  )}

                  <div className="details-roster-card">
                    <div className="details-roster-head">
                      <div className="details-roster-title">Участники турнира</div>
                      <div className="details-roster-count">
                        {detailMaxParticipants > 0 ? `${detailParticipantCount}/${detailMaxParticipants}` : detailParticipantCount}
                      </div>
                    </div>
                    <div className="details-roster-list">
                      {detailParticipants.length === 0 ? (
                        <div className="game-empty">Стань первым участником</div>
                      ) : (
                        detailParticipants.map((participant, index) => {
                          const liveRating = getPlayerLiveRating(participant, liveRatings);
                          const levelMeta = getPlayerLevelMeta(participant, liveRating);

                          return (
                            <div className="details-roster-row" key={`${participant.id}-${index}`}>
                              <div className="details-roster-player">
                                <div
                                  className={`details-roster-avatar-wrap${levelMeta.label ? " has-level" : ""}`}
                                  style={levelMeta.ringStyle}
                                >
                                  {participant.avatarUrl ? (
                                    <img src={participant.avatarUrl} alt={participant.name} className="details-roster-avatar" />
                                  ) : (
                                    <span className="details-roster-avatar details-roster-avatar-fallback">{getInitials(participant.name)}</span>
                                  )}
                                  {levelMeta.label && (
                                    <span className="details-roster-avatar-level" style={levelMeta.badgeStyle}>
                                      {levelMeta.label}
                                    </span>
                                  )}
                                </div>
                                <div className="details-roster-meta">
                                  <div className="details-roster-name">{participant.name}</div>
                                  <div className="details-roster-sub">
                                    {levelMeta.label ? `Уровень ${levelMeta.label}` : "Уровень уточняется"}
                                  </div>
                                </div>
                              </div>
                              {participant.role && <span className="details-roster-badge">{participant.role}</span>}
                            </div>
                          );
                        })
                      )}
                      <button
                        type="button"
                        className="details-roster-row details-roster-row-invite"
                        onClick={() => {
                          void handleInviteFriend();
                        }}
                        disabled={inviteSharing}
                      >
                        <span className="details-roster-player">
                          <span className="details-roster-avatar-wrap details-roster-avatar-wrap-invite" aria-hidden="true">
                            <span className="details-roster-avatar details-roster-avatar-invite-plus">+</span>
                          </span>
                          <span className="details-roster-meta">
                            <span className="details-roster-name">{inviteFriendLabel}</span>
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>

                  <div className="tournament-signup-register-stack">
                    {subscriptionUsageShadowEnabled && isAuthenticated && selectedExerciseId && (
                      <div className="tournament-signup-auth">
                        <div className="tournament-signup-auth-head">
                          <strong>
                            <span className="tournament-signup-auth-title">Проверка годовой подписки</span>
                          </strong>
                        </div>
                        <SubscriptionUsageShadowPanel controller={subscriptionUsageShadow} />
                        <button
                          type="button"
                          className="section-cta"
                          onClick={() => void previewSubscriptionDiscount(selectedExerciseId)}
                          disabled={subscriptionUsageShadow.busy}
                        >
                          {subscriptionUsageShadow.busy
                            ? "Проверяем скидку 50%…"
                            : "Проверить скидку 50% без записи и оплаты"}
                        </button>
                      </div>
                    )}
                    {!subscriptionUsageShadowEnabled && canRegister && (
                      <div className="tournament-signup-auth">
                        <div className="tournament-signup-auth-head">
                          <strong>
                            <span className="tournament-signup-auth-title">Выбери способ записи</span>
                          </strong>
                        </div>
                        {checkout ? (
                          <div className="tournament-signup-payment-options">
                            {checkout.clientSubscriptions.length > 0 && (
                              <div className="tournament-signup-payment-group">
                                {checkout.clientSubscriptions.map((product) => {
                                  const productKey = `${product.source}:${product.id}`;
                                  const isConfirming = confirmingSubscriptionProductKey === productKey;
                                  return (
                                    <button
                                      key={productKey}
                                      className="tournament-signup-payment-option tournament-signup-payment-option-subscription"
                                      type="button"
                                      onClick={() => void completeVivaRegistration(checkout, product)}
                                      disabled={actionLoading}
                                    >
                                      <span>
                                        {product.name}
                                        {product.lk1MoneyDiscountCandidate === true && (
                                          <>
                                            <br />
                                            <span className="tournament-signup-payment-option-note">
                                              Потребуется оплата со скидкой. Посещение не списывается.
                                            </span>
                                          </>
                                        )}
                                      </span>
                                      <div className="tournament-signup-payment-option-meta">
                                        <strong>
                                          {isConfirming
                                            ? "Подтверждаем запись…"
                                            : formatTournamentPaymentProductValidity(product)}
                                        </strong>
                                        {!isConfirming && shouldShowSubscriptionHint(product) && (
                                          <span className="tournament-signup-payment-option-note">подписка</span>
                                        )}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                            {purchasableSubscriptionProducts.length > 0 && (
                              <div className="tournament-signup-payment-group">
                                <button
                                  type="button"
                                  className="tournament-signup-payment-purchase-toggle"
                                  onClick={() => setPurchasableListOpen((current) => !current)}
                                  disabled={actionLoading}
                                >
                                  {isPurchasableListOpen ? "Скрыть абонементы" : "Записаться разово или по абонементу"}
                                </button>
                                {isPurchasableListOpen && (
                                  <div className="tournament-signup-payment-purchase-list">
                                    {purchasableSubscriptionProducts.map((product) => (
                                      <button
                                        key={`${product.source}-${product.id}`}
                                        className="tournament-signup-payment-option"
                                        type="button"
                                        onClick={() => void completeVivaRegistration(checkout, product)}
                                        disabled={actionLoading}
                                      >
                                        <span>{product.name}</span>
                                        <strong>
                                          {formatTournamentPaymentProductPrice(product)}
                                          {formatTournamentPaymentProductVisits(product)}
                                        </strong>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            {isAuthenticated ? (
                              purchasableSubscriptionProducts.length > 0 && (
                                <div className="tournament-signup-payment-group">
                                  <button
                                    type="button"
                                    className="tournament-signup-payment-subscription-link"
                                    onClick={() => {
                                      if (!navigateToExternalUrl(TOURNAMENT_SUMMER_SUBSCRIPTION_URL)) {
                                        setError("Не удалось открыть страницу подписки. Попробуйте снова.");
                                      }
                                    }}
                                    disabled={actionLoading}
                                  >
                                    Записаться по подписке
                                  </button>
                                </div>
                              )
                            ) : (
                              <div className="tournament-signup-payment-group">
                                <button
                                  type="button"
                                  className="tournament-signup-payment-purchase-toggle"
                                  onClick={() => {
                                    setPendingPaymentProduct(null);
                                    setAuthRequired(true);
                                    setError(null);
                                  }}
                                  disabled={actionLoading}
                                >
                                  Войти и записаться по подписке
                                </button>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="tournament-signup-muted">
                            {actionLoading ? "Подбираем способы записи..." : "Способы записи пока недоступны"}
                          </div>
                        )}
                      </div>
                    )}

                    {!subscriptionUsageShadowEnabled && (canPayPending || canCancel) && (
                      <div className="tournament-signup-actions">
                        {canPayPending && (
                          <button
                            className="section-cta"
                            type="button"
                            onClick={handlePayPendingRegistration}
                            disabled={actionLoading}
                          >
                            Оплатить
                          </button>
                        )}
                        {canCancel && (
                          <button
                            className="tournament-signup-danger"
                            type="button"
                            onClick={() => void handleCancel()}
                            disabled={actionLoading}
                          >
                            {actionLoading ? "Отменяем..." : "Отменить запись"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}

              {activeDetailTab === "rules" && (
                <div className="details-result-card">
                  <div className="details-result-header">
                    <div className="details-result-title">Регламент</div>
                    <span className="details-result-status pending">{selectedTournament.format || "Турнир"}</span>
                  </div>
                  {detailRulesInfographic && (
                    <img
                      className="tournament-regulation-infographic"
                      src={detailRulesInfographic.src}
                      alt={detailRulesInfographic.alt}
                      loading="lazy"
                    />
                  )}
                  <div className="tournament-signup-facts">
                    {(selectedTournament.studioName || getTournamentStationLabel(selectedTournament)) && (
                      <div><span>Клуб</span><strong>{getTournamentStationLabel(selectedTournament)}</strong></div>
                    )}
                    {selectedTournament.address && <div><span>Адрес</span><strong>{selectedTournament.address}</strong></div>}
                    {selectedTournament.format && <div><span>Формат</span><strong>{selectedTournament.format}</strong></div>}
                    {selectedTournament.levelLabel && <div><span>Уровень</span><strong>{selectedTournament.levelLabel}</strong></div>}
                    {selectedTournament.priceLabel && <div><span>Стоимость</span><strong>{selectedTournament.priceLabel}</strong></div>}
                  </div>
                  {detail?.description && <p className="tournament-signup-copy">{detail.description}</p>}
                  {detail?.rules ? (
                    <p className="tournament-signup-copy">{detail.rules}</p>
                  ) : (
                    <div className="game-empty">Регламент пока не опубликован</div>
                  )}
                </div>
              )}

              <Modal
                isOpen={isStationModalOpen}
                onClose={() => setStationModalOpen(false)}
                title={detailStationLabel}
                variant="dialog"
                bodyClassName="tournament-signup-station-modal"
              >
                <div className="tournament-signup-station-facts">
                  <div className="tournament-signup-station-fact">
                    <span>Станция</span>
                    <strong>{detailStationLabel}</strong>
                  </div>
                  {selectedTournament.address && (
                    <div className="tournament-signup-station-fact">
                      <span>Адрес</span>
                      <strong>{selectedTournament.address}</strong>
                    </div>
                  )}
                </div>
                {detailStationMapUrl && (
                  <a
                    className="section-cta tournament-signup-station-map"
                    href={detailStationMapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Открыть на карте
                  </a>
                )}
              </Modal>
            </>
          )}
        </section>
      )}
    </div>
  );
}
