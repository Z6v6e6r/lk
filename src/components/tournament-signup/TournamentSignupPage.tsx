import { type CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { AuthForm } from "../auth/AuthForm";
import { CommunityTournamentCard } from "../cabinet/community-feed/CommunityTournamentCard";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { useAuth } from "../../context/AuthContext";
import { apiFetchPadelLiveRatings, type PadelLiveRatingItem } from "../../utils/apiClient";
import { getLetterGrade } from "../../utils/customFields";
import {
  apiCancelTournamentVivaRegistration,
  apiCreateTournamentVivaTransaction,
  apiFetchTournamentMyRegistration,
  apiFetchTournamentSignupDetail,
  apiFetchTournamentSignupList,
  apiFetchTournamentVivaCheckout,
  apiFetchTournamentVivaMyRegistration,
  type TournamentRegistrationState,
  type TournamentSignupDetail,
  type TournamentSignupSummary,
  type TournamentVivaCheckout,
  type TournamentVivaProduct,
} from "../../utils/tournamentSignupApi";
import { findTournamentSkinPriceLabel } from "../../utils/tournamentCustomPricing";
import type { CommunityTournamentCard as CommunityTournamentCardData } from "../cabinet/community-feed/feedTypes";

interface TournamentSignupPageProps {
  onBack: () => void;
  initialTournamentId?: string | null;
  initialDate?: string | null;
}

type TournamentDetailTab = "roster" | "rules" | "result";

type TournamentSignupParticipant = {
  id: string;
  name: string;
  level: string | null;
  ratingNumeric: number | null;
  phone: string | null;
  avatarUrl: string | null;
  role: string | null;
};

type Rgb = { r: number; g: number; b: number };
type LevelGrade = "D" | "D+" | "C" | "C+" | "B" | "B+" | "A";

const TOURNAMENT_DETAIL_TABS: Array<{ id: TournamentDetailTab; label: string }> = [
  { id: "roster", label: "Состав" },
  { id: "rules", label: "Регламент" },
  { id: "result", label: "Результат" },
];

const ALL_FILTER_VALUE = "__all__";
const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TOURNAMENT_SHARE_ORIGIN = "https://padlhub.ru";
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
  const raw = String(value || "").trim();
  if (!raw) return null;
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function normalizeTournamentSlug(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim().toLowerCase() || null;
  } catch {
    return raw.toLowerCase();
  }
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

function getRegistrationText(registration: TournamentRegistrationState | null) {
  if (!registration || registration.status === "NONE") return null;
  if (registration.status === "PAYMENT_PENDING") return "Ожидаем оплату";
  if (registration.status === "REGISTERED") {
    return registration.placeNumber
      ? `Вы записаны, место ${registration.placeNumber}`
      : "Вы записаны на турнир";
  }
  return registration.waitlistNumber
    ? `Вы в листе ожидания, позиция ${registration.waitlistNumber}`
    : "Вы в листе ожидания";
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

function getTournamentStationFilterValue(tournament: TournamentSignupSummary) {
  return tournament.studioName || tournament.address || "Станция уточняется";
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
  if (product.isCustomTournamentEnergy || !product.visitsTotal) return "";
  return ` / ${product.visitsTotal} посещ.`;
}

function formatTournamentPaymentProductRemainingVisits(product: TournamentVivaProduct) {
  if (product.isCustomTournamentEnergy) return "";
  const visitsRemaining = getTournamentPaymentProductRemainingVisits(product);
  if (visitsRemaining == null) return "";
  return `${visitsRemaining} посещ.`;
}

const PAYMENT_HOLD_MS = 20 * 60 * 1000;
const PAYMENT_STORAGE_PREFIX = "padlhub:tournament-payment:";

function getPaymentStorageKey(exerciseId: string) {
  return `${PAYMENT_STORAGE_PREFIX}${exerciseId}`;
}

function formatPaymentCountdown(ms: number) {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  return "энергия";
}

function pickFirstArray(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
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
  const grade = numericGrade && isLevelGrade(numericGrade)
    ? numericGrade
    : getNormalizedLevelGrade(value);
  if (grade) {
    const degree = getLevelDegree(grade, numeric);
    return degree ? `${grade}${formatSuperscript(degree)}` : grade;
  }

  const normalized = String(value || "").trim().toUpperCase();
  const token = normalized.match(/^([A-D])\s*([1-4])?(\+)?$/);
  if (!token) return normalized || null;
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
  const pathname = currentUrl?.pathname?.includes("tournaments")
    ? currentUrl.pathname
    : "/tournaments";
  const shareUrl = new URL(pathname, origin);
  shareUrl.searchParams.set("tournamentId", tournamentId);
  if (date) shareUrl.searchParams.set("date", date);
  if (slug) shareUrl.searchParams.set("slug", slug);
  return shareUrl.toString();
}

function normalizeParticipant(item: unknown, index: number): TournamentSignupParticipant | null {
  if (!isRecord(item)) return null;
  const client = isRecord(item.client) ? item.client : isRecord(item.user) ? item.user : isRecord(item.player) ? item.player : null;
  const source = client || item;
  const firstName = pickString(source, ["firstName", "firstname", "givenName"]);
  const lastName = pickString(source, ["lastName", "lastname", "familyName"]);
  const name =
    pickString(source, ["name", "displayName", "fullName"])
    || [firstName, lastName].filter(Boolean).join(" ").trim()
    || pickString(item, ["clientName", "playerName", "participantName"])
    || "Игрок";
  const id =
    pickString(source, ["id", "clientId", "userId", "uuid"])
    || pickString(item, ["id", "clientId", "userId", "bookingId"])
    || `participant-${index}`;
  const status = String(pickString(item, ["status", "state", "registrationStatus"]) || "").toUpperCase();
  if (status === "CANCELLED" || status === "CANCELED") return null;

  return {
    id,
    name,
    level:
      pickString(source, ["level", "rating", "grade", "ratingLabel", "levelLabel", "levelLetter"])
      || pickString(item, ["level", "rating", "grade", "ratingLabel", "levelLabel", "levelLetter"]),
    ratingNumeric:
      pickNumber(source, ["ratingNumeric", "numericRating", "levelNumeric"])
      ?? pickNumber(item, ["ratingNumeric", "numericRating", "levelNumeric"]),
    phone:
      normalizePhone(pickString(source, ["phone", "phoneNumber", "phoneNorm"]))
      || normalizePhone(pickString(item, ["phone", "phoneNumber", "phoneNorm"])),
    avatarUrl:
      pickString(source, ["avatarUrl", "avatar", "photo", "imageUrl"])
      || pickString(item, ["avatarUrl", "avatar", "photo", "imageUrl"]),
    role: pickString(item, ["role", "participantRole"]),
  };
}

function getTournamentParticipants(tournament: TournamentSignupSummary | TournamentSignupDetail | null): TournamentSignupParticipant[] {
  const raw = tournament?.raw;
  const directItems = pickFirstArray(raw, ["participants", "players", "clients", "registrations", "bookings"]);
  const nestedItems = isRecord(raw) && isRecord(raw.registration)
    ? pickFirstArray(raw.registration, ["participants", "players", "clients"])
    : [];
  return [...directItems, ...nestedItems]
    .map(normalizeParticipant)
    .filter((item): item is TournamentSignupParticipant => item !== null);
}

function toCommunityTournamentCard(tournament: TournamentSignupSummary): CommunityTournamentCardData {
  const participants = tournament.participantsCount ?? 0;
  const maxParticipants = tournament.maxParticipants ?? 0;
  const isFull = maxParticipants > 0 && participants >= maxParticipants;
  const spotsLeft = maxParticipants > 0 ? Math.max(0, maxParticipants - participants) : null;
  const progress = maxParticipants > 0 ? participants / maxParticipants : 0;

  return {
    id: tournament.id,
    badgeLabel: tournament.format || "Турнир",
    title: tournament.title,
    subtitle: tournament.studioName || "PadelHub",
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
    stationLabel: tournament.studioName || tournament.address || "Станция уточняется",
    tournamentTypeLabel: tournament.format || "Турнир",
    ratingLabel: tournament.levelLabel || undefined,
    genderLabel: undefined,
    slotsLabel: maxParticipants > 0 ? `${participants}/${maxParticipants} мест` : `${participants} участников`,
    ctaLabel: "Открыть",
    trainerName: tournament.trainerName || "PadelHub",
    trainerAvatarUrl: tournament.trainerAvatarUrl || undefined,
    profileHandle: tournament.address || tournament.studioName || "Расписание турниров",
    publicUrl: tournament.publicUrl || undefined,
    waitlistCount: tournament.waitlistCount ?? 0,
    spotsLeft,
    priceLabel: resolveTournamentCardPriceLabel(tournament),
  };
}

export default function TournamentSignupPage({
  onBack,
  initialTournamentId,
  initialDate,
}: TournamentSignupPageProps) {
  const { isAuthenticated } = useAuth();
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
  const [selectedId, setSelectedId] = useState<string | null>(initialTournamentId ?? null);
  const [detail, setDetail] = useState<TournamentSignupDetail | null>(null);
  const [registration, setRegistration] = useState<TournamentRegistrationState | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<TournamentVivaCheckout | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<TournamentDetailTab>("roster");
  const [typeFilter, setTypeFilter] = useState(ALL_FILTER_VALUE);
  const [stationFilter, setStationFilter] = useState(ALL_FILTER_VALUE);
  const [liveRatings, setLiveRatings] = useState<Map<string, PadelLiveRatingItem>>(() => new Map());
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [inviteSharing, setInviteSharing] = useState(false);
  const [inviteFeedback, setInviteFeedback] = useState<"shared" | "copied" | null>(null);

  const selectedDate = dates[dateIndex] ?? dates[DAYS_BEFORE_TODAY] ?? new Date();
  const selectedDateStr = formatDate(selectedDate);
  const selectedTournament = selectedId
    ? items.find((item) => item.id === selectedId) ?? detail
    : null;
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

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    const result = await apiFetchTournamentSignupList({ date: selectedDateStr });
    if (result.error) {
      setError(result.error.message || "Не удалось загрузить турниры");
      setItems([]);
    } else {
      setItems(sortTournaments(result.data ?? []));
    }
    setLoadingList(false);
  }, [selectedDateStr]);

  const loadDetail = useCallback(async (tournamentId: string) => {
    setLoadingDetail(true);
    setError(null);
    const detailResult = await apiFetchTournamentSignupDetail(tournamentId);
    const [registrationResult, vivaRegistrationResult] = isAuthenticated
      ? await Promise.all([
          apiFetchTournamentMyRegistration(tournamentId),
          apiFetchTournamentVivaMyRegistration(tournamentId),
        ])
      : [null, null];

    if (detailResult.error) {
      setError(detailResult.error.message || "Не удалось открыть турнир");
      setDetail(null);
    } else {
      setDetail(detailResult.data ?? null);
    }
    setRegistration(
      mergeStoredPendingPayment(
        tournamentId,
        vivaRegistrationResult?.data ?? registrationResult?.data ?? detailResult.data?.registration ?? null,
      ),
    );
    setLoadingDetail(false);
  }, [isAuthenticated]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRegistration(null);
      setCheckout(null);
      setAuthRequired(false);
      setActiveDetailTab("roster");
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, selectedId]);

  useEffect(() => {
    if (!isAuthenticated || !selectedId) return;
    void loadDetail(selectedId);
  }, [isAuthenticated, loadDetail, selectedId]);

  useEffect(() => {
    setInviteFeedback(null);
    setInviteSharing(false);
  }, [selectedId]);

  useEffect(() => {
    if (registration?.status !== "PAYMENT_PENDING") return;
    setNowTs(Date.now());
    const timer = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [registration?.status, registration?.paymentExpiresAt]);

  const completeVivaRegistration = async (nextCheckout: TournamentVivaCheckout, product: TournamentVivaProduct) => {
    if (!selectedId) return;
    setActionLoading(true);
    setError(null);
    try {
      const result = await apiCreateTournamentVivaTransaction({
        exerciseId: selectedId,
        studioId: nextCheckout.studioId,
        clientId: nextCheckout.profile.id,
        profile: nextCheckout.profile,
        clientPhone: normalizePhone(nextCheckout.profile.phone) || nextCheckout.profile.phone,
        product,
        customPricing: nextCheckout.customPricing,
        tournament: detail?.raw ?? selectedTournament?.raw ?? selectedTournament,
        exercise: nextCheckout.exercise,
      });
      if (result.error || !result.data) {
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
        storePendingPayment(selectedId, nextRegistration);
        setRegistration(nextRegistration);
        if (!navigateToExternalUrl(result.data.paymentUrl)) {
          setError("Не удалось открыть страницу оплаты");
        }
        return;
      }
      setCheckout(null);
      clearStoredPendingPayment(selectedId);
      await loadDetail(selectedId);
      await loadList();
    } finally {
      setActionLoading(false);
    }
  };

  const performRegister = async () => {
    if (!selectedId || actionLoading) return;
    setActionLoading(true);
    setError(null);
    setCheckout(null);
    const tournamentPayload = detail?.raw ?? selectedTournament?.raw ?? selectedTournament;
    const result = await apiFetchTournamentVivaCheckout(selectedId, {
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
  };

  const handleRegister = async () => {
    if (!isAuthenticated) {
      setAuthRequired(true);
      setError(null);
      return;
    }
    await performRegister();
  };

  const handleCancel = async () => {
    if (!selectedId || actionLoading) return;
    if (!isAuthenticated) {
      setAuthRequired(true);
      setError(null);
      return;
    }
    const accepted = window.confirm("Отменить запись на турнир?");
    if (!accepted) return;

    setActionLoading(true);
    setError(null);
    const result = await apiCancelTournamentVivaRegistration(selectedId, registration?.bookingId, {
      placeNumber: registration?.placeNumber ?? null,
    });
    if (result.error) {
      setError(result.error.message || "Не удалось отменить запись");
    } else {
      clearStoredPendingPayment(selectedId);
      setRegistration(result.data ?? null);
      await loadDetail(selectedId);
      await loadList();
    }
    setActionLoading(false);
  };

  const handlePayPendingRegistration = () => {
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

  const registrationText = getRegistrationText(registration);
  const registrationStatusText = isAuthenticated
    ? (registrationText || "Вы пока не записаны")
    : "Войдите, чтобы увидеть вашу запись";
  const isPaymentPending = registration?.status === "PAYMENT_PENDING";
  const paymentExpiresAtTs = isPaymentPending && registration?.paymentExpiresAt
    ? Date.parse(registration.paymentExpiresAt)
    : null;
  const paymentRemainingMs = paymentExpiresAtTs && Number.isFinite(paymentExpiresAtTs)
    ? paymentExpiresAtTs - nowTs
    : null;
  const paymentCountdownText = paymentRemainingMs == null
    ? "до 20 минут"
    : formatPaymentCountdown(paymentRemainingMs);
  const paymentExpired = paymentRemainingMs != null && paymentRemainingMs <= 0;
  const canPayPending = Boolean(isPaymentPending && registration?.paymentUrl);
  const canCancel = Boolean(registration?.canCancel && registration.status !== "NONE");
  const canRegister =
    !canCancel &&
    detail?.status !== "CANCELLED" &&
    detail?.status !== "CLOSED" &&
    registration?.canRegister !== false;
  const detailDateParts = getDateParts(selectedTournament?.date ?? null);
  const detailStartTime = formatClock(selectedTournament?.startsAt ?? null);
  const detailEndTime = formatClock(selectedTournament?.endsAt ?? null);
  const detailTimeLabel = detailStartTime && detailEndTime
    ? `${detailStartTime} • ${detailEndTime}`
    : selectedTournament?.timeLabel || "Время уточняется";
  const detailParticipants = useMemo(
    () => getTournamentParticipants(detail || selectedTournament),
    [detail, selectedTournament],
  );
  const detailTournamentTypeLabel = selectedTournament?.format || "Турнир";
  const detailMaxParticipants = selectedTournament?.maxParticipants ?? 0;
  const detailParticipantCount = Math.max(detailParticipants.length, selectedTournament?.participantsCount ?? 0);
  const detailTrainerName = detail?.trainerName || selectedTournament?.trainerName || null;
  const detailTrainerAvatarUrl = detail?.trainerAvatarUrl || selectedTournament?.trainerAvatarUrl || null;
  const purchasableSubscriptionProducts = checkout ? [...checkout.oneTimes, ...checkout.subscriptions] : [];

  useEffect(() => {
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
  }, [detailParticipants, selectedId]);

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
              onClick={() => void loadList()}
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

          {loadingList && <div className="tournament-signup-muted">Загрузка...</div>}
          {!loadingList && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingList && !error && items.length === 0 && (
            <div className="tournament-signup-muted">На выбранную дату турниров нет</div>
          )}
          {!loadingList && !error && items.length > 0 && filteredItems.length === 0 && (
            <div className="tournament-signup-muted">По выбранным фильтрам турниров нет</div>
          )}

          <div className="tournament-signup-list">
            {filteredItems.map((tournament) => (
              <CommunityTournamentCard
                key={tournament.id}
                card={toCommunityTournamentCard(tournament)}
                onOpen={() => {
                  setCheckout(null);
                  setSelectedId(tournament.id);
                }}
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
                <button className="tournament-signup-ghost" type="button" onClick={() => setAuthRequired(false)}>
                  Закрыть
                </button>
              </div>
              <AuthForm
                onLogin={() => {
                  setAuthRequired(false);
                  void performRegister();
                }}
              />
            </div>
          )}
          {loadingDetail && <div className="tournament-signup-muted">Загрузка турнира...</div>}
          {!loadingDetail && error && <div className="tournament-signup-error">{error}</div>}
          {!loadingDetail && selectedTournament && (
            <>
              <div className="details-card tournament-signup-details-card">
                <div className="details-row">
                  <div>
                    <div className="details-date details-date-capitalize">{getDateLabel(selectedTournament.date)}</div>
                    <div className="details-time">{detailTimeLabel}</div>
                    <div className="details-time details-time-strong">{selectedTournament.title}</div>
                    <div className="details-time">{detailTournamentTypeLabel}</div>
                    <div className="details-time">{selectedTournament.studioName || selectedTournament.address || "Станция уточняется"}</div>
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
                        <div className="details-roster-title">Исполнитель</div>
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
                              <div className="details-roster-sub">Исполнитель турнира</div>
                            </div>
                          </div>
                          <span className="details-roster-badge">Исполнитель</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="section-cta section-cta-secondary details-organizer-invite"
                        onClick={() => {
                          void handleInviteFriend();
                        }}
                        disabled={inviteSharing}
                      >
                        {inviteSharing
                          ? "Готовим ссылку..."
                          : inviteFeedback === "shared"
                            ? "Ссылка отправлена"
                            : inviteFeedback === "copied"
                              ? "Ссылка скопирована"
                              : "Пригласить друга"}
                      </button>
                    </div>
                  )}

                  <div className="details-roster-card">
                    <div className="details-roster-head">
                      <div className="details-roster-title">Участники турнира</div>
                      <div className="details-roster-count">
                        {detailMaxParticipants > 0 ? `${detailParticipantCount}/${detailMaxParticipants}` : detailParticipantCount}
                      </div>
                    </div>
                    {detailParticipants.length === 0 ? (
                      <div className="game-empty">Состав пока не сформирован</div>
                    ) : (
                      <div className="details-roster-list">
                        {detailParticipants.map((participant, index) => {
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
                        })}
                      </div>
                    )}
                  </div>

                  <div className="tournament-signup-registration">
                    <div>
                      <span>Статус записи</span>
                      <strong>{registrationStatusText}</strong>
                      {registration?.message && <p>{registration.message}</p>}
                      {isPaymentPending && (
                        <div className={`tournament-signup-payment-hold${paymentExpired ? " is-expired" : ""}`}>
                          <span>{paymentExpired ? "Время оплаты истекло" : "Место удерживается"}</span>
                          <strong>{paymentCountdownText}</strong>
                        </div>
                      )}
                      {isPaymentPending && !registration?.paymentUrl && (
                        <p>Ссылка на оплату пока не найдена. Обновите статус или отмените запись.</p>
                      )}
                    </div>
                    <div>
                      <span>Участники</span>
                      <strong>
                        {selectedTournament.participantsCount ?? 0}
                        {selectedTournament.maxParticipants != null ? `/${selectedTournament.maxParticipants}` : ""}
                      </strong>
                      {selectedTournament.waitlistCount != null && <p>В ожидании: {selectedTournament.waitlistCount}</p>}
                    </div>
                  </div>

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
                    {canRegister && (
                      <button className="section-cta" type="button" onClick={() => void handleRegister()} disabled={actionLoading}>
                        {actionLoading ? "Записываем..." : "Записаться"}
                      </button>
                    )}
                    {canCancel && (
                      <button className="tournament-signup-danger" type="button" onClick={() => void handleCancel()} disabled={actionLoading}>
                        {actionLoading ? "Отменяем..." : "Отменить запись"}
                      </button>
                    )}
                  </div>

                  {checkout && (
                    <div className="tournament-signup-auth">
                      <div className="tournament-signup-auth-head">
                        <strong>
                          Выберите способ записи · Баланс депозита: {formatMoneyMinor(checkout.profile.deposit)}
                        </strong>
                        <button className="tournament-signup-ghost" type="button" onClick={() => setCheckout(null)}>
                          Закрыть
                        </button>
                      </div>
                      <div className="tournament-signup-payment-options">
                        {checkout.clientSubscriptions.length > 0 && (
                          <div className="tournament-signup-payment-group">
                            <div className="tournament-signup-payment-title">Действующий абонемент</div>
                            {checkout.clientSubscriptions.map((product) => (
                              <button
                                key={`${product.source}-${product.id}`}
                                className="tournament-signup-payment-option"
                                type="button"
                                onClick={() => void completeVivaRegistration(checkout, product)}
                                disabled={actionLoading}
                              >
                                <span>{product.name}</span>
                                <strong>{formatTournamentPaymentProductRemainingVisits(product)}</strong>
                              </button>
                            ))}
                          </div>
                        )}
                        {purchasableSubscriptionProducts.length > 0 && (
                          <div className="tournament-signup-payment-group">
                            <div className="tournament-signup-payment-title">Приобрести новый абонемент</div>
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
                    </div>
                  )}
                </>
              )}

              {activeDetailTab === "rules" && (
                <div className="details-result-card">
                  <div className="details-result-header">
                    <div className="details-result-title">Регламент</div>
                    <span className="details-result-status pending">{selectedTournament.format || "Турнир"}</span>
                  </div>
                  <div className="tournament-signup-facts">
                    {selectedTournament.studioName && <div><span>Клуб</span><strong>{selectedTournament.studioName}</strong></div>}
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

              {activeDetailTab === "result" && (
                <div className="details-result-card">
                  <div className="details-result-header">
                    <div className="details-result-title">Результат турнира</div>
                    <span className="details-result-status pending">Ожидается</span>
                  </div>
                  <div className="game-empty">Результат появится после завершения турнира</div>
                </div>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
