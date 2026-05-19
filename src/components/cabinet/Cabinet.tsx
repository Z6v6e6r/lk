import { useState, useEffect, useRef, useMemo, useCallback, type CSSProperties } from "react";
import { UserProfile } from "./UserProfile";
import {
  apiCancelBooking,
  apiFetchProfile,
  apiFetchBookings,
  apiFetchExercisesByDate,
  apiFetchExercisesByVisibleDate,
  apiFetchSubscriptions,
  apiFetchPadelChatsByPhone,
  apiFetchPadelGamesByPhone,
  apiFetchTournamentHistory,
  apiUpdatePadelGameRecord,
} from "../../utils/apiClient";
import type {
  Booking,
  UserProfileType,
  BookingsResponse,
  SubscriptionResponse,
  Subscription,
  PadelGameRecord,
  PadelGamePlayer,
  TournamentHistoryRecord,
} from "../../utils/apiClient";
import type { OpenGamesOptions } from "../../types/gamesOverlay";
import type { OpenLevelsInfoOptions } from "../../types/levelsInfoOverlay";
import type { OpenTournamentsOptions } from "../../types/tournamentsOverlay";
import { useAuth } from "../../context/AuthContext";
import { ButtonModule } from "./ButtonModele";
import { ProfileEditForm } from "./ProfileEditForm";
import { BookingsContainer } from "./BookingsContainer";
import { BookingHistory } from "./BookingHistory";
import { SubscriptionsContainer } from "./SubscriptionsContainer";
import { SubscriptionInformation } from "./SubscriptionInformation";
import { BuySupscription } from "./BuySubscription";
import { Advertisement } from "./Advertisement";
import { CommunitiesSectionLoader } from "./CommunitiesSectionLoader";
import { SupportChatWidget } from "./SupportChatWidget";
import { TournamentDetailsModal } from "./TournamentDetailsModal";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { CUSTOM_FIELD_IDS, getCustomFieldValue, hasTournamentHostingAccess } from "../../utils/customFields";
import {
  identifyAnalyticsUser,
  trackAnalyticsEvent,
  trackCabinetVisit,
  trackClientError,
} from "../../utils/analytics";
import {
  CABINET_URL,
  COMMUNITIES_BUNDLE_URL,
  GAMES_BUNDLE_URL,
  IS_DEV_RELEASE_CHANNEL,
  PUBLIC_COMMUNITY_JOIN_PATH,
  PUBLIC_GAME_FIND_PATH,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";
import { shareOrCopyGameInvitePayload } from "../../utils/gameInviteClipboard";
import { addGameToCalendar } from "../../utils/calendarEvent";
import { resolveHashActionTarget, retriggerHashAction } from "../../utils/hashActions";

const SHOW_COLLECT_FRIENDS_BUTTON = false;
const GROUP_TRAININGS_HASH = "#9Rzqf";
const GAME_FIND_PATH = (PUBLIC_GAME_FIND_PATH || "/finde_game").replace(/\/+$/, "") || "/finde_game";

type QuickAction = {
  icon: string;
  label: string;
  href: string;
};

const QUICK_ACTIONS: QuickAction[] = [
  { icon: "🎾", label: "Играть", href: GAME_FIND_PATH },
  { icon: "👥", label: "Групповые тренировки", href: GROUP_TRAININGS_HASH },
  { icon: "🏆", label: "Турниры", href: "https://padlhub.ru/tournaments" },
  { icon: "🎯", label: "Индивидуальные тренировки", href: "https://padlhub.ru/indi_lk" },
];

const CABINET_LOAD_ERROR_TEXT =
  "Не удалось загрузить личный кабинет, попробуйте подключиться к WiFi сети и загрузить кабинет повторно.";
const MAX_SINGLES_PLAYERS = 2;
const MAX_GAME_PLAYERS = 4;
const COMMUNITY_JOIN_PATH =
  (PUBLIC_COMMUNITY_JOIN_PATH || "/community_join").replace(/\/+$/, "") || "/community_join";
const INVITE_JOIN_PATH = PUBLIC_INVITE_PATH;
const CHAT_READ_STORAGE_KEY_PREFIX = "padlhub.chat.lastRead.v1";
const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"];
const TOURNAMENT_DIRECTION_ID = 2617;
const TOURNAMENT_LOOKBACK_DAYS = 7;
const TOURNAMENT_LOOKAHEAD_DAYS = 14;
const DEV_TOURNAMENT_SCAN_DELAY_MS = 3000;
const ACTIVE_RESULT_WINDOW_LIMIT = 20;
const RESULT_ENTRY_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CabinetProps {
  onOpenGames: (options?: OpenGamesOptions) => void;
  onOpenTournaments: (options?: OpenTournamentsOptions) => void;
  onOpenLevelsInfo: (options?: OpenLevelsInfoOptions) => void;
  onOpenOnboarding: (data: {
    profile: UserProfileType;
    gamesLink: string;
    trainingLink: string;
    tournamentsLink: string;
  }) => void;
  initialCommunityInviteCode?: string | null;
  initialCommunityInviteLink?: string | null;
  inviteEntryCabinetUrl?: string | null;
}

type ProfileUpdatedEventDetail = {
  levelLetter?: string;
  levelNumeric?: string;
};

type GamesUpdatedEventDetail = {
  record?: PadelGameRecord | null;
  records?: PadelGameRecord[];
  source?: string;
};

type GameCancelState = "idle" | "confirm" | "done";
type InlineGameResultScore = { left: string; right: string };

function applyOnboardingLevels(
  source: UserProfileType,
  detail: ProfileUpdatedEventDetail,
): UserProfileType {
  const nextCustomFields = [...(source.customFields || [])];

  const upsertField = (fieldId: string, value: string | undefined) => {
    if (!value) return;
    const index = nextCustomFields.findIndex((field) => field.id === fieldId);
    if (index >= 0) {
      nextCustomFields[index] = { ...nextCustomFields[index], value: [value] };
      return;
    }
    nextCustomFields.push({
      id: fieldId,
      name: "",
      value: [value],
    });
  };

  upsertField(CUSTOM_FIELD_IDS.lkPadelLevel, detail.levelLetter);
  upsertField(CUSTOM_FIELD_IDS.lkPadelLevelNumeric, detail.levelNumeric);

  return { ...source, customFields: nextCustomFields };
}

function getPlayerInitials(name: string | null | undefined): string {
  const value = (name || "").trim();
  if (!value) return "";
  return value
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function normalizePlayerRatingLabel(value: string | null | undefined): string | null {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;

  if (RATING_LABELS.includes(raw)) {
    return raw;
  }

  const compact = raw.replace(/\s+/g, "");
  if (RATING_LABELS.includes(compact)) {
    return compact;
  }

  const numeric = Number.parseFloat(raw.replace(",", "."));
  if (Number.isFinite(numeric)) {
    const index = Math.max(0, Math.min(RATING_LABELS.length - 1, Math.round(numeric) - 1));
    return RATING_LABELS[index] ?? null;
  }

  return null;
}

function getPlayerRatingProgress(label: string | null): number | null {
  if (!label) return null;
  const index = RATING_LABELS.findIndex((item) => item === label);
  if (index < 0) return null;
  if (RATING_LABELS.length <= 1) return 1;
  return (index + 1) / RATING_LABELS.length;
}

function getDateBadge(dateValue: string | null | undefined) {
  if (!dateValue) return { month: "—", day: "—", weekday: "—" };
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return { month: "—", day: "—", weekday: "—" };
  return {
    month: parsed
      .toLocaleDateString("ru-RU", { month: "short" })
      .replace(".", "")
      .toUpperCase(),
    day: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
    weekday: parsed
      .toLocaleDateString("ru-RU", { weekday: "short" })
      .replace(".", "")
      .toUpperCase(),
  };
}

function isGamePaidRecord(game: PadelGameRecord): boolean {
  if (game.payment?.paid != null) return game.payment.paid === true;
  const statusUpper = String(game.status || "").trim().toUpperCase();
  if (!statusUpper) return false;
  if (statusUpper.includes("PAID") || statusUpper.includes("PAYED")) return true;
  if (
    statusUpper.includes("PENDING")
    || statusUpper.includes("UNPAID")
    || statusUpper.includes("NOT_PAID")
  ) return false;
  return false;
}

function isGameExplicitlyUnpaidRecord(game: PadelGameRecord): boolean {
  if (game.payment?.paid === false) return true;
  const statusUpper = String(game.status || "").trim().toUpperCase();
  if (!statusUpper) return false;
  return Boolean(
    statusUpper.includes("PENDING")
    || statusUpper.includes("UNPAID")
    || statusUpper.includes("NOT_PAID")
    || statusUpper.includes("DRAFT")
  );
}

function resolveGameCardPlayersCount(game: PadelGameRecord): number {
  const inviteMaxPlayers = game.invite?.maxPlayers;
  if (typeof inviteMaxPlayers === "number" && Number.isFinite(inviteMaxPlayers) && inviteMaxPlayers > 0) {
    return Math.max(1, Math.floor(inviteMaxPlayers));
  }

  const metadata = game.metadata;
  const metadataGameFormat =
    metadata && typeof metadata.gameFormat === "string"
      ? metadata.gameFormat.trim().toLowerCase()
      : "";
  if (metadataGameFormat === "singles") {
    return MAX_SINGLES_PLAYERS;
  }

  return MAX_GAME_PLAYERS;
}

function getGameEndTimestamp(game: PadelGameRecord): number {
  const date = game.booking?.date;
  const rawTime = game.booking?.timeTo ?? game.booking?.timeFrom;
  if (rawTime) {
    const directParsed = new Date(rawTime).getTime();
    if (Number.isFinite(directParsed)) return directParsed;
  }
  if (!date || !rawTime) return Number.POSITIVE_INFINITY;
  const normalizedTime = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${date}T${normalizedTime}`).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function getGameStartTimestamp(game: PadelGameRecord): number {
  const date = game.booking?.date;
  const rawTime = game.booking?.timeFrom ?? game.booking?.timeTo;
  if (rawTime) {
    const directParsed = new Date(rawTime).getTime();
    if (Number.isFinite(directParsed)) return directParsed;
  }
  if (!date || !rawTime) return Number.POSITIVE_INFINITY;
  const normalizedTime = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${date}T${normalizedTime}`).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getGameDateKey(game: PadelGameRecord): string | null {
  const rawDate = String(game.booking?.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
    return rawDate.slice(0, 10);
  }

  const startTs = getGameStartTimestamp(game);
  if (!Number.isFinite(startTs)) return null;
  const parsed = new Date(startTs);
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function hasEnteredMatchResult(game: PadelGameRecord): boolean {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const matchResult = metadata && isRecord(metadata.matchResult) ? metadata.matchResult : null;
  if (!matchResult) return false;
  const sets = matchResult.sets;
  if (Array.isArray(sets) && sets.length > 0) return true;
  const status = String(matchResult.status || "").trim();
  return Boolean(status || matchResult.submittedAt || matchResult.confirmedAt);
}

function shouldShowInlineResultEntry(game: PadelGameRecord): boolean {
  if (String(game.status || "").toUpperCase().includes("CANCEL")) return false;
  if (hasEnteredMatchResult(game)) return false;
  const startTs = getGameStartTimestamp(game);
  if (
    getGameDateKey(game) === getTodayDateKey()
    && Number.isFinite(startTs)
    && startTs <= Date.now()
  ) {
    return true;
  }

  const endTs = getGameEndTimestamp(game);
  const now = Date.now();
  return Number.isFinite(endTs) && endTs < now && now - endTs <= RESULT_ENTRY_GRACE_WINDOW_MS;
}

function normalizeScoreInput(value: string): string {
  return value.replace(/[^\d]/g, "").slice(0, 2);
}

function getPlayerIdentityKey(player: PadelGamePlayer | null | undefined): string | null {
  if (!player) return null;
  const id = String(player.id || "").trim();
  if (id) return `id:${id}`;
  const phone = normalizePhoneForGame(player.phone);
  if (phone) return `phone:${phone}`;
  const name = String(player.name || "").trim().toLowerCase();
  return name ? `name:${name}` : null;
}

function resolveStoredTeamSlots(
  game: PadelGameRecord,
  fallbackPlayers: Array<PadelGamePlayer | null>,
): Array<PadelGamePlayer | null> {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const rawSlots = Array.isArray(metadata?.teamSlots) ? metadata.teamSlots : [];
  if (rawSlots.length === 0) return fallbackPlayers;

  const playersByKey = new Map<string, PadelGamePlayer>();
  fallbackPlayers.forEach((player, index) => {
    const key = getPlayerIdentityKey(player) || `slot:${index}`;
    if (player) playersByKey.set(key, player);
  });

  const resolveSlot = (value: unknown): PadelGamePlayer | null => {
    if (!value) return null;
    if (isRecord(value)) {
      const id = pickStringValue(value, ["id"]);
      const phone = normalizePhoneForGame(pickStringValue(value, ["phone", "phoneNorm"]));
      const name = pickStringValue(value, ["name"])?.toLowerCase() ?? null;
      return (
        (id ? playersByKey.get(`id:${id}`) : null)
        ?? (phone ? playersByKey.get(`phone:${phone}`) : null)
        ?? (name ? playersByKey.get(`name:${name}`) : null)
        ?? null
      );
    }
    if (typeof value === "string") {
      const raw = value.trim();
      return playersByKey.get(raw) ?? playersByKey.get(`id:${raw}`) ?? playersByKey.get(`phone:${normalizePhoneForGame(raw)}`) ?? null;
    }
    return null;
  };

  return Array.from({ length: MAX_GAME_PLAYERS }, (_, index) => resolveSlot(rawSlots[index]) ?? fallbackPlayers[index] ?? null);
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

function resolvePublicGamesOrigin(current: URL): string {
  if (!isLocalHostname(current.hostname)) {
    return current.origin;
  }

  const fromBundle = (GAMES_BUNDLE_URL || "").trim();
  if (fromBundle) {
    try {
      const parsed = new URL(fromBundle);
      if (!isLocalHostname(parsed.hostname)) {
        return parsed.origin;
      }
    } catch {
      // fallback below
    }
  }

  return "https://padlhub.ru";
}

function resolveInviteCabinetBaseUrl(): URL | null {
  const cabinetUrl = (CABINET_URL || "").trim();
  let parsedCabinetUrl: URL | null = null;

  if (cabinetUrl) {
    try {
      parsedCabinetUrl = new URL(cabinetUrl);
      if (parsedCabinetUrl.pathname.includes("/lk_dev")) {
        return parsedCabinetUrl;
      }
    } catch {
      // fallback below
    }
  }

  try {
    const inviteUrl = new URL(INVITE_JOIN_PATH, PUBLIC_INVITE_ORIGIN);
    if (inviteUrl.hostname === "padlhub.su") {
      inviteUrl.hostname = "padlhub.ru";
    }
    return inviteUrl;
  } catch {
    return parsedCabinetUrl;
  }
}

function normalizePublicGamesUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (typeof window === "undefined") return raw;

  try {
    const current = new URL(window.location.href);
    const parsed = new URL(raw, current.origin);
    const hasJoinGame = Boolean(parsed.searchParams.get("joinGame")?.trim());

    if (hasJoinGame) {
      const normalized = resolveInviteCabinetBaseUrl();
      if (!normalized) return parsed.toString();
      parsed.searchParams.forEach((paramValue, key) => {
        const normalizedKey = key.trim().toLowerCase();
        if (normalizedKey === "cabineturl" || normalizedKey === "returnurl") return;
        normalized.searchParams.set(key, paramValue);
      });
      return normalized.toString();
    }

    if (!isLocalHostname(parsed.hostname)) {
      return parsed.toString();
    }
    const publicOrigin = resolvePublicGamesOrigin(current);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return normalized.toString();
  } catch {
    return raw;
  }
}

function resolveQuickActionHref(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "#";
  if (!raw.startsWith("#")) return raw;

  try {
    const normalized = new URL(CABINET_URL);
    normalized.hash = raw;
    return normalized.toString();
  } catch {
    return raw;
  }
}

function resolvePublicGamesCabinetUrl(current: URL): string | null {
  if (current.pathname.includes("/lk_dev")) {
    return new URL("/lk_dev", current.origin).toString();
  }
  const configured = (CABINET_URL || "").trim();
  return configured || null;
}

function resolveFindGameHref(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  if (typeof window === "undefined") return raw;

  try {
    const current = new URL(window.location.href);
    const parsed = new URL(raw, current.origin);
    const normalizedFindPath = GAME_FIND_PATH.replace(/\/+$/, "") || "/finde_game";
    const parsedPath = parsed.pathname.replace(/\/+$/, "") || "/";
    if (parsedPath !== normalizedFindPath) {
      return parsed.toString();
    }

    const resolvedCabinetUrl = resolvePublicGamesCabinetUrl(current);
    if (resolvedCabinetUrl) {
      parsed.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }

    if (!isLocalHostname(parsed.hostname)) {
      return parsed.toString();
    }
    const publicOrigin = resolvePublicGamesOrigin(current);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return normalized.toString();
  } catch {
    return raw;
  }
}

function shouldShowCommunitiesSection(options?: {
  initialInviteCode?: string | null;
  initialInviteLink?: string | null;
}) {
  const hasConfiguredBundle = Boolean((COMMUNITIES_BUNDLE_URL || "").trim());
  if (import.meta.env.DEV) return true;

  const hasInitialInvite = Boolean(
    options?.initialInviteCode?.trim() || options?.initialInviteLink?.trim(),
  );
  if (typeof window === "undefined") return hasInitialInvite || hasConfiguredBundle;

  const pathname = window.location.pathname.replace(/\/+$/, "");
  if (hasInitialInvite) return true;
  if (pathname.endsWith(COMMUNITY_JOIN_PATH) || pathname.includes("/community/invite/")) return true;
  return hasConfiguredBundle;
}

function buildInviteFallbackUrl(gameId: string): string | null {
  const id = gameId.trim();
  if (!id) return null;
  if (typeof window === "undefined") return null;
  try {
    const url = resolveInviteCabinetBaseUrl();
    if (!url) return null;
    url.searchParams.set("joinGame", id);
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

function resolveGameInviteUrl(game: PadelGameRecord): string | null {
  return (
    normalizePublicGamesUrl(game.inviteUrl) ??
    buildInviteFallbackUrl(game.id)
  );
}

function normalizePhoneForGame(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function extractGameCustomTitle(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const value = typeof metadata.gameTitle === "string" ? metadata.gameTitle.trim() : "";
  return value || null;
}

function toDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const matched = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return matched?.[1] ?? null;
}

function toTimeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const matched = value.match(/T?(\d{2}:\d{2})/);
  return matched?.[1] ?? null;
}

function resolveDurationMinutes(
  fromIso: string | null | undefined,
  toIso: string | null | undefined,
): number | null {
  if (!fromIso || !toIso) return null;
  const fromTs = Date.parse(fromIso);
  const toTs = Date.parse(toIso);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return null;
  return Math.round((toTs - fromTs) / 60000);
}

function pickStringFromUnknown(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function pickStringFromRecord(source: unknown, keys: string[]): string | null {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const normalized = pickStringFromUnknown(record[key]);
    if (normalized) return normalized;
  }
  return null;
}

function detectPaidStateByStatusToken(value: string | null | undefined): boolean | null {
  const token = String(value || "").trim().toUpperCase();
  if (!token) return null;

  const unpaidMarkers = [
    "PENDING",
    "CREATED",
    "WAIT",
    "UNPAID",
    "NOT_PAID",
    "FAILED",
    "DECLINED",
    "CANCEL",
    "EXPIRED",
    "ERROR",
    "REFUND",
    "CHARGEBACK",
  ];
  if (unpaidMarkers.some((marker) => token.includes(marker))) return false;

  const paidMarkers = [
    "PAID",
    "PAYED",
    "SUCCESS",
    "SUCCEEDED",
    "CAPTURED",
    "COMPLETED",
    "DONE",
    "CONFIRMED",
    "APPROVED",
  ];
  if (paidMarkers.some((marker) => token.includes(marker))) return true;

  return null;
}

function resolveBookingPaidState(booking: Booking): boolean | null {
  const cardStatus = detectPaidStateByStatusToken(booking.transactionStatus?.cardPaymentStatus?.status ?? null);
  if (cardStatus != null) return cardStatus;

  const cardOriginalStatus = detectPaidStateByStatusToken(
    booking.transactionStatus?.cardPaymentStatus?.originalStatus ?? null,
  );
  if (cardOriginalStatus != null) return cardOriginalStatus;

  return detectPaidStateByStatusToken(booking.transactionStatus?.transactionStatus ?? null);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mergeCabinetGameRecords(
  current: PadelGameRecord[],
  incomingRecords: PadelGameRecord[],
): PadelGameRecord[] {
  const next = [...current];
  incomingRecords.forEach((record) => {
    if (!record?.id) return;
    const existingIndex = next.findIndex((item) => item.id === record.id);
    if (existingIndex < 0) {
      next.unshift(record);
      return;
    }
    next[existingIndex] = {
      ...next[existingIndex],
      ...record,
      booking: record.booking ?? next[existingIndex].booking,
      payment: record.payment ?? next[existingIndex].payment,
      settings: record.settings ?? next[existingIndex].settings,
      invite: record.invite ?? next[existingIndex].invite,
      metadata: record.metadata ?? next[existingIndex].metadata,
      participants: record.participants ?? next[existingIndex].participants,
      waitlist: record.waitlist ?? next[existingIndex].waitlist,
    };
  });
  return next;
}

function pickNumberValue(source: Record<string, unknown> | null, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseFloat(value.replace(",", ".").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickStringValue(source: Record<string, unknown> | null, keys: string[]): string | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized) return normalized;
  }
  return null;
}

function getSplitPaymentMetadata(game: PadelGameRecord | null | undefined): Record<string, unknown> | null {
  const metadata = isRecord(game?.metadata) ? game.metadata : null;
  return metadata && isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
}

function isSplitPaymentGame(game: PadelGameRecord | null | undefined): boolean {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;
  const splitPayment = getSplitPaymentMetadata(game);
  return Boolean(splitPayment?.enabled);
}

function formatRubPrice(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function getSplitJoinPriceText(game: PadelGameRecord | null | undefined): string | null {
  if (!isSplitPaymentGame(game)) return null;
  const splitPayment = getSplitPaymentMetadata(game);
  const shareAmountMinor = pickNumberValue(splitPayment, ["shareAmountMinor", "amountMinor", "toPayMinor"]);
  const shareAmount =
    pickNumberValue(splitPayment, ["shareAmount", "amount", "toPay"])
    ?? (shareAmountMinor !== null ? shareAmountMinor / 100 : null);
  return formatRubPrice(shareAmount);
}

function getSplitCancelDeadlineAt(game: PadelGameRecord | null | undefined): string | null {
  if (!isSplitPaymentGame(game)) return null;
  const splitPayment = getSplitPaymentMetadata(game);
  const deadlineAt = pickStringValue(splitPayment, ["deadlineAt", "cancelAt", "expiresAt", "expires_at"]);
  if (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt))) return null;
  return deadlineAt;
}

function formatCountdown(deadlineAt?: string | null, nowMs = Date.now()): string | null {
  if (!deadlineAt) return null;
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) return null;
  const totalMinutes = Math.max(0, Math.ceil((deadlineMs - nowMs) / 60000));
  if (totalMinutes <= 0) return "0 мин";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  return `${minutes} мин`;
}

function normalizeBookingLikeId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parseBookingIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((item) => normalizeBookingLikeId(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  if (typeof value === "string") {
    return Array.from(new Set(
      value
        .split(",")
        .map((item) => normalizeBookingLikeId(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  return [];
}

function toBookingDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const matched = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  if (matched) return matched[1];

  if (/[T ]\d{2}:\d{2}/.test(trimmed)) {
    const parsedTs = Date.parse(trimmed);
    if (Number.isFinite(parsedTs)) {
      const parsed = new Date(parsedTs);
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, "0");
      const d = String(parsed.getDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

function toBookingTimeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  const plainTimeMatched = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (plainTimeMatched) {
    const hh = String(Number.parseInt(plainTimeMatched[1], 10)).padStart(2, "0");
    const mm = plainTimeMatched[2];
    return `${hh}:${mm}`;
  }

  if (/[T ]\d{2}:\d{2}/.test(trimmed)) {
    const parsedTs = Date.parse(trimmed);
    if (Number.isFinite(parsedTs)) {
      const parsed = new Date(parsedTs);
      const hh = String(parsed.getHours()).padStart(2, "0");
      const mm = String(parsed.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
  }

  const fallbackMatched = trimmed.match(/T?(\d{2}:\d{2})/);
  return fallbackMatched?.[1] ?? null;
}

function normalizeSlotName(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function isGameCancelledStatus(value: string | null | undefined): boolean {
  const status = String(value || "").trim().toUpperCase();
  return Boolean(status && status.includes("CANCEL"));
}

function collectGameBookingIds(game: PadelGameRecord): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingLikeId(value);
    if (normalized) bucket.add(normalized);
  };
  const pushMany = (value: unknown) => {
    parseBookingIdsFromUnknown(value).forEach((item) => bucket.add(item));
  };

  if (isRecord(game.metadata)) {
    pushMany(game.metadata.bookingIds);
    push(game.metadata.bookingId);
    pushMany(game.metadata.booking_ids);
    push(game.metadata.booking_id);
  }

  const gameAny = game as unknown as Record<string, unknown>;
  if (isRecord(gameAny.booking)) {
    pushMany(gameAny.booking.bookingIds);
    push(gameAny.booking.bookingId);
  }
  if (isRecord(gameAny.payment)) {
    pushMany(gameAny.payment.bookingIds);
    push(gameAny.payment.bookingId);
  }

  return Array.from(bucket);
}

function collectGameExerciseIds(game: PadelGameRecord): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingLikeId(value);
    if (normalized) bucket.add(normalized);
  };

  if (isRecord(game.metadata)) {
    push(game.metadata.exerciseId);
    push(game.metadata.exercise_id);
    push(game.metadata.vivaExerciseId);
    push(game.metadata.viva_exercise_id);
  }

  const gameAny = game as unknown as Record<string, unknown>;
  if (isRecord(gameAny.booking)) {
    push(gameAny.booking.exerciseId);
    push(gameAny.booking.exercise_id);
    push(gameAny.booking.vivaExerciseId);
    push(gameAny.booking.viva_exercise_id);
  }

  return Array.from(bucket);
}

function buildGameSlotKey(game: PadelGameRecord): string | null {
  const date = toBookingDateKey(game.booking?.date ?? null);
  const timeFrom = toBookingTimeKey(game.booking?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(game.booking?.timeTo ?? null);
  const studioName = normalizeSlotName(game.booking?.studioName ?? null);
  const roomName = normalizeSlotName(game.booking?.roomName ?? null);
  if (!date || !timeFrom || !timeTo || !studioName || !roomName) return null;
  return [date, timeFrom, timeTo, studioName, roomName].join("|");
}

function buildGameSlotIdKey(game: PadelGameRecord): string | null {
  const gameAny = game as unknown as Record<string, unknown>;
  const booking = isRecord(gameAny.booking) ? gameAny.booking : null;
  const date = toBookingDateKey(game.booking?.date ?? null);
  const timeFrom = toBookingTimeKey(game.booking?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(game.booking?.timeTo ?? null);
  const studioId = normalizeBookingLikeId(booking?.studioId ?? null);
  const roomId = normalizeBookingLikeId(booking?.roomId ?? null);
  if (!date || !timeFrom || !timeTo || !studioId || !roomId) return null;
  return [date, timeFrom, timeTo, studioId, roomId].join("|");
}

function buildBookingSlotKey(booking: Booking): string | null {
  const date = toBookingDateKey(booking.exercise?.timeFrom ?? null);
  const timeFrom = toBookingTimeKey(booking.exercise?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(booking.exercise?.timeTo ?? null);
  const studioName = normalizeSlotName(booking.exercise?.studio?.name ?? null);
  const roomName = normalizeSlotName(booking.exercise?.room?.name ?? null);
  if (!date || !timeFrom || !timeTo || !studioName || !roomName) return null;
  return [date, timeFrom, timeTo, studioName, roomName].join("|");
}

function buildBookingSlotIdKey(booking: Booking): string | null {
  const date = toBookingDateKey(booking.exercise?.timeFrom ?? null);
  const timeFrom = toBookingTimeKey(booking.exercise?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(booking.exercise?.timeTo ?? null);
  const studioId = normalizeBookingLikeId(booking.exercise?.studio?.id ?? null);
  const roomId = normalizeBookingLikeId(booking.exercise?.room?.id ?? null);
  if (!date || !timeFrom || !timeTo || !studioId || !roomId) return null;
  return [date, timeFrom, timeTo, studioId, roomId].join("|");
}

function collectBookingExerciseIds(booking: Booking): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingLikeId(value);
    if (normalized) bucket.add(normalized);
  };

  push(booking.exercise?.id);

  const bookingAny = booking as unknown as Record<string, unknown>;
  push(bookingAny.exerciseId);
  push(bookingAny.exercise_id);
  push(bookingAny.vivaExerciseId);
  push(bookingAny.viva_exercise_id);

  if (isRecord(bookingAny.exercise)) {
    push(bookingAny.exercise.exerciseId);
    push(bookingAny.exercise.exercise_id);
    push(bookingAny.exercise.vivaExerciseId);
    push(bookingAny.exercise.viva_exercise_id);
  }

  return Array.from(bucket);
}

function isTournamentBookingCandidate(booking: Booking): boolean {
  const combinedName = `${booking.exercise?.direction?.name || ""} ${booking.exercise?.type?.name || ""}`
    .trim()
    .toLowerCase();

  if (
    booking.exercise?.direction?.id === TOURNAMENT_DIRECTION_ID
    || booking.exercise?.type?.id === TOURNAMENT_DIRECTION_ID
  ) {
    return true;
  }

  return (
    combinedName.includes("турнир")
    || combinedName.includes("tournament")
    || combinedName.includes("американо")
    || combinedName.includes("americano")
    || combinedName.includes("мексикано")
    || combinedName.includes("mexicano")
    || combinedName.includes("round robin")
    || combinedName.includes("олимп")
  );
}

function isTournamentExercise(exercise: Booking["exercise"] | null | undefined): boolean {
  if (!exercise) return false;

  const combinedName = `${exercise.direction?.name || ""} ${exercise.type?.name || ""}`
    .trim()
    .toLowerCase();

  if (
    exercise.direction?.id === TOURNAMENT_DIRECTION_ID
    || exercise.type?.id === TOURNAMENT_DIRECTION_ID
  ) {
    return true;
  }

  return (
    combinedName.includes("турнир")
    || combinedName.includes("tournament")
    || combinedName.includes("американо")
    || combinedName.includes("americano")
    || combinedName.includes("мексикано")
    || combinedName.includes("mexicano")
    || combinedName.includes("round robin")
    || combinedName.includes("олимп")
  );
}

function formatTournamentDateKey(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: Date, amount: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function isTournamentTrainer(exercise: Booking["exercise"], currentUserId: string | null) {
  if (!exercise || !currentUserId) return false;
  return (exercise.trainers ?? []).some((trainer) => (trainer.id || "").trim() === currentUserId);
}

function getChatReadStorageKey(phoneNorm: string): string {
  return `${CHAT_READ_STORAGE_KEY_PREFIX}.${phoneNorm}`;
}

function readChatReadMap(phoneNorm: string): Record<string, number> {
  if (typeof window === "undefined" || !phoneNorm) return {};
  try {
    const raw = window.localStorage.getItem(getChatReadStorageKey(phoneNorm));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const next: Record<string, number> = {};
    Object.entries(parsed).forEach(([gameId, value]) => {
      const ts = Number(value);
      if (!gameId || !Number.isFinite(ts)) return;
      next[gameId] = Math.max(0, Math.floor(ts));
    });
    return next;
  } catch {
    return {};
  }
}

export function Cabinet({
  onOpenGames,
  onOpenTournaments,
  onOpenLevelsInfo,
  onOpenOnboarding,
  initialCommunityInviteCode,
  initialCommunityInviteLink,
  inviteEntryCabinetUrl,
}: CabinetProps) {
  const cabinetRootRef = useRef<HTMLDivElement | null>(null);
  const profileSectionRef = useRef<HTMLDivElement | null>(null);
  const showCommunitiesSection = shouldShowCommunitiesSection({
    initialInviteCode: initialCommunityInviteCode,
    initialInviteLink: initialCommunityInviteLink,
  });
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [historyBookings, setHistoryBookings] = useState<BookingsResponse | null>(null);
  const [activeBookings, setActiveBookings] = useState<BookingsResponse | null>(null);
  const [loadingHistoryBookings, setLoadingHistoryBookings] = useState(false);
  const [userSubscriptions, setUserSubscriptions] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isBookingHistoryOpen, setIsBookingHistoryOpen] = useState(false);
  const [isSubscriptionInfoOpen, SetSubscriptionInfoOpen] = useState(false);
  const [currenSub, SetCurrenSub] = useState<Subscription | null>(null);
  const [currenSubName, SetCurrenSubName] = useState<string>("Абонемент");
  const [isOpenBuySub, setOpenBuySub] = useState<boolean>(false);
  const [createdGames, setCreatedGames] = useState<PadelGameRecord[]>([]);
  const [loadingCreatedGames, setLoadingCreatedGames] = useState(false);
  const [createdGamesError, setCreatedGamesError] = useState<string | null>(null);
  const [activeGameRecordsTotal, setActiveGameRecordsTotal] = useState(0);
  const [hasLoadedAllActiveRecords, setHasLoadedAllActiveRecords] = useState(false);
  const [loadingMoreActiveRecords, setLoadingMoreActiveRecords] = useState(false);
  const [hasAssignedTournamentAccess, setHasAssignedTournamentAccess] = useState(false);
  const [customTournaments, setCustomTournaments] = useState<TournamentHistoryRecord[]>([]);
  const [selectedTournamentBooking, setSelectedTournamentBooking] = useState<Booking | null>(null);
  const [copiedGameInviteId, setCopiedGameInviteId] = useState<string | null>(null);
  const [, setChatReadMap] = useState<Record<string, number>>({});
  const [chatUnreadByGame, setChatUnreadByGame] = useState<Record<string, number>>({});
  const [gameCancelStateById, setGameCancelStateById] = useState<Record<string, GameCancelState>>({});
  const [gameCancelOkById, setGameCancelOkById] = useState<Record<string, boolean>>({});
  const [cancellingGameId, setCancellingGameId] = useState<string | null>(null);
  const [inlineGameResultScores, setInlineGameResultScores] = useState<Record<string, InlineGameResultScore>>({});
  const [savingInlineGameResultId, setSavingInlineGameResultId] = useState<string | null>(null);
  const [inlineGameResultErrorById, setInlineGameResultErrorById] = useState<Record<string, string>>({});
  const cabinetVisitTrackedRef = useRef(false);
  const onboardingStatusRef = useRef<boolean | null>(null);
  const cancellingGameIdsRef = useRef<Set<string>>(new Set());
  const historyBookingsRequestRef = useRef<Promise<BookingsResponse | null> | null>(null);
  const { logout } = useAuth();

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (window.location.hash !== GROUP_TRAININGS_HASH) return undefined;

    const timeoutId = window.setTimeout(() => {
      retriggerHashAction(GROUP_TRAININGS_HASH);
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      setHistoryBookings(null);
      setLoadingHistoryBookings(false);
      setHasLoadedAllActiveRecords(false);
      setLoadingMoreActiveRecords(false);
      setActiveGameRecordsTotal(0);
      setCustomTournaments([]);
      historyBookingsRequestRef.current = null;
      try {
        const [profileRes, activeRes, subsRes] = await Promise.all([
          apiFetchProfile(),
          apiFetchBookings(false),
          apiFetchSubscriptions(),
        ]);
        if (!isMounted) return;
        if (!profileRes?.data) {
          if (profileRes?.status === 401) {
            trackClientError(
              "cabinet.load_unauthorized",
              new Error("Profile request unauthorized"),
              { status: 401 },
              { handled: true, severity: "warning" },
            );
            trackAnalyticsEvent("cabinet_load_failed", {
              reason: "unauthorized",
              status: 401,
            });
            logout();
            return;
          }
          trackAnalyticsEvent("cabinet_load_failed", {
            reason: "profile_not_loaded",
            status: profileRes?.status ?? null,
          });
          trackClientError(
            "cabinet.profile_not_loaded",
            new Error("Profile payload is empty"),
            { status: profileRes?.status ?? null, message: profileRes?.error?.message ?? null },
            { handled: true, severity: "error" },
          );
          setLoadError(CABINET_LOAD_ERROR_TEXT);
          setLoading(false);
          return;
        }
        setProfile(profileRes.data);
        setActiveBookings(activeRes?.data || null);
        setUserSubscriptions(subsRes?.data || null);
        trackAnalyticsEvent("cabinet_data_loaded", {
          activeBookingsCount: activeRes?.data?.content?.length ?? 0,
          historyBookingsLoaded: false,
          subscriptionsCount: subsRes?.data?.content?.length ?? 0,
        });
      } catch (error) {
        if (isMounted) {
          console.error("Ошибка загрузки:", error);
          trackClientError(
            "cabinet.load_exception",
            error,
            { reloadKey },
            { handled: true, severity: "error" },
          );
          trackAnalyticsEvent("cabinet_load_failed", {
            reason: "network_error",
            error: error instanceof Error ? error.message : String(error),
          });
          setLoadError(CABINET_LOAD_ERROR_TEXT);
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    };
    loadData();
    return () => { isMounted = false; };
  }, [logout, reloadKey]);

  const loadHistoryBookings = useCallback(async (force = false) => {
    if (!force && historyBookings) {
      return historyBookings;
    }
    if (historyBookingsRequestRef.current) {
      return historyBookingsRequestRef.current;
    }

    setLoadingHistoryBookings(true);
    const requestPromise = (async () => {
      try {
        const historyRes = await apiFetchBookings(true);
        if (historyRes?.data) {
          setHistoryBookings(historyRes.data);
          trackAnalyticsEvent("cabinet_history_loaded", {
            historyBookingsCount: historyRes.data.content?.length ?? 0,
            source: force ? "refresh" : "modal",
          });
          return historyRes.data;
        }
        return historyBookings;
      } finally {
        setLoadingHistoryBookings(false);
        historyBookingsRequestRef.current = null;
      }
    })();

    historyBookingsRequestRef.current = requestPromise;
    return requestPromise;
  }, [historyBookings]);

  const loadProfile = useCallback(async (fallbackDetail?: ProfileUpdatedEventDetail) => {
    const data = await apiFetchProfile();
    if (!data?.data) return;

    if (fallbackDetail?.levelLetter || fallbackDetail?.levelNumeric) {
      setProfile(applyOnboardingLevels(data.data, fallbackDetail));
      return;
    }

    setProfile(data.data);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProfileUpdatedEventDetail>).detail;
      if (detail?.levelLetter || detail?.levelNumeric) {
        setProfile((prev) => (prev ? applyOnboardingLevels(prev, detail) : prev));
        void loadProfile(detail);
        return;
      }
      void loadProfile();
    };
    window.addEventListener("lk-profile-updated", handler);
    return () => {
      window.removeEventListener("lk-profile-updated", handler);
    };
  }, [loadProfile]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<GamesUpdatedEventDetail>).detail;
      const records = [
        ...(detail?.record ? [detail.record] : []),
        ...(Array.isArray(detail?.records) ? detail.records : []),
      ].filter((record): record is PadelGameRecord => Boolean(record?.id));

      if (records.length === 0) return;
      setCreatedGames((prev) => mergeCabinetGameRecords(prev, records));
      setCreatedGamesError(null);
    };

    window.addEventListener("lk-games-updated", handler);
    return () => {
      window.removeEventListener("lk-games-updated", handler);
    };
  }, []);

  useEffect(() => {
    if (!profile) return;

    const numericLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
    const letterLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
    const onboardingCompleted = Boolean(numericLevelValue);

    identifyAnalyticsUser({
      clientId: profile.id,
      phone: profile.phone,
      email: profile.email,
      firstName: profile.firstName,
      lastName: profile.lastName,
      middleName: profile.middleName,
      sex: profile.sex,
      birthDate: profile.birthDate,
      onboardingCompleted,
      levelLetter: letterLevelValue,
      levelNumeric: numericLevelValue,
    });

    if (!cabinetVisitTrackedRef.current) {
      const visitCount = trackCabinetVisit({
        clientId: profile.id,
        onboardingCompleted,
      });
      cabinetVisitTrackedRef.current = true;
      trackAnalyticsEvent("cabinet_opened", {
        clientId: profile.id,
        visitCount,
        onboardingCompleted,
      });
    }

    if (onboardingStatusRef.current !== onboardingCompleted) {
      onboardingStatusRef.current = onboardingCompleted;
      trackAnalyticsEvent("onboarding_status_detected", {
        clientId: profile.id,
        onboardingCompleted,
        levelLetter: letterLevelValue ?? null,
        levelNumeric: numericLevelValue ?? null,
      });
    }
  }, [profile]);

  useEffect(() => {
    if (!profile?.id) {
      setHasAssignedTournamentAccess(false);
      return;
    }
    if (hasTournamentHostingAccess(profile)) {
      setHasAssignedTournamentAccess(false);
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;

    const loadAssignedTournamentAccess = async () => {
      const today = new Date();
      const todayKey = formatTournamentDateKey(today);
      const dateKeys = Array.from(
        { length: TOURNAMENT_LOOKBACK_DAYS + TOURNAMENT_LOOKAHEAD_DAYS + 1 },
        (_, index) => formatTournamentDateKey(addDays(today, index - TOURNAMENT_LOOKBACK_DAYS)),
      );

      const results = await Promise.allSettled(
        dateKeys.map((date) => (
          date === todayKey
            ? apiFetchExercisesByVisibleDate(date, {
              includePast: true,
              includeAdjacentDays: true,
            })
            : apiFetchExercisesByDate(date, { includePast: date <= todayKey })
        )),
      );

      if (cancelled) return;

      const hasAssigned = results.some((result) => {
        if (result.status !== "fulfilled") return false;
        const exercises = Array.isArray(result.value.data) ? result.value.data : [];
        return exercises.some((exercise) => (
          isTournamentExercise(exercise) && isTournamentTrainer(exercise, profile.id)
        ));
      });

      setHasAssignedTournamentAccess(hasAssigned);
    };

    const runTournamentAccessScan = () => {
      void loadAssignedTournamentAccess().catch(() => {
        if (!cancelled) {
          setHasAssignedTournamentAccess(false);
        }
      });
    };

    if (IS_DEV_RELEASE_CHANNEL) {
      timeoutId = window.setTimeout(runTournamentAccessScan, DEV_TOURNAMENT_SCAN_DELAY_MS);
    } else {
      runTournamentAccessScan();
    }

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [profile]);

  useEffect(() => {
    const phone = profile?.phone?.trim();
    if (!phone) {
      setCreatedGames([]);
      setActiveGameRecordsTotal(0);
      setHasLoadedAllActiveRecords(false);
      return;
    }

    let alive = true;
    setLoadingCreatedGames(true);
    setCreatedGamesError(null);

    Promise.all([
      apiFetchPadelGamesByPhone(
        phone,
        profile?.id ?? null,
        false,
        {
          limit: ACTIVE_RESULT_WINDOW_LIMIT,
        },
      ),
      apiFetchPadelGamesByPhone(
        phone,
        profile?.id ?? null,
        true,
        {
          limit: ACTIVE_RESULT_WINDOW_LIMIT,
          windowHours: 24,
          needsResult: true,
        },
      ),
    ])
      .then(([activeGamesResult, resultWindowGamesResult]) => {
        if (!alive) return;
        const activeGames = Array.isArray(activeGamesResult.data?.games)
          ? activeGamesResult.data.games
          : [];
        const resultWindowGames = Array.isArray(resultWindowGamesResult.data?.games)
          ? resultWindowGamesResult.data.games
          : [];
        const mergedGames = mergeCabinetGameRecords(activeGames, resultWindowGames);
        setCreatedGames(mergedGames);
        setActiveGameRecordsTotal(Math.max(
          activeGamesResult.data?.total ?? 0,
          resultWindowGamesResult.data?.total ?? 0,
          mergedGames.length,
        ));
        const error = activeGamesResult.error ?? resultWindowGamesResult.error;
        if (error) {
          setCreatedGamesError(error.message || "Не удалось загрузить игры");
        }
      })
      .catch(() => {
        if (!alive) return;
        setCreatedGames([]);
        setActiveGameRecordsTotal(0);
        setCreatedGamesError("Не удалось загрузить игры");
      })
      .finally(() => {
        if (alive) setLoadingCreatedGames(false);
      });

    return () => {
      alive = false;
    };
  }, [profile?.phone, profile?.id]);

  const loadAllActiveRecords = useCallback(async () => {
    const phone = profile?.phone?.trim();
    if (!phone || hasLoadedAllActiveRecords || loadingMoreActiveRecords) {
      return;
    }

    setLoadingMoreActiveRecords(true);
    try {
      const [activeBookingsResult, gamesResult] = await Promise.all([
        apiFetchBookings(false),
        apiFetchPadelGamesByPhone(phone, profile?.id ?? null, true),
      ]);

      if (activeBookingsResult.data) {
        setActiveBookings(activeBookingsResult.data);
      }

      if (gamesResult.data) {
        setCreatedGames(gamesResult.data.games);
        setActiveGameRecordsTotal(gamesResult.data.total);
      }

      if (!activeBookingsResult.error && !gamesResult.error) {
        setHasLoadedAllActiveRecords(true);
      }

      if (gamesResult.error) {
        setCreatedGamesError(gamesResult.error.message || "Не удалось загрузить игры");
      }
    } finally {
      setLoadingMoreActiveRecords(false);
    }
  }, [hasLoadedAllActiveRecords, loadingMoreActiveRecords, profile?.id, profile?.phone]);

  const profilePhoneNorm = useMemo(
    () => normalizePhoneForGame(profile?.phone ?? null),
    [profile?.phone],
  );

  useEffect(() => {
    if (!profilePhoneNorm) {
      setChatReadMap({});
      return;
    }
    setChatReadMap(readChatReadMap(profilePhoneNorm));
  }, [profilePhoneNorm]);

  useEffect(() => {
    if (!profilePhoneNorm) {
      setChatUnreadByGame({});
      return;
    }

    let cancelled = false;
    const run = async () => {
      const latestReadMap = readChatReadMap(profilePhoneNorm);
      if (!cancelled) {
        setChatReadMap(latestReadMap);
      }

      const result = await apiFetchPadelChatsByPhone(profilePhoneNorm);
      if (cancelled || !result.data) return;

      const gameIds = new Set(createdGames.map((game) => game.id).filter(Boolean));
      const nextUnread: Record<string, number> = {};

      result.data.chats.forEach((chat) => {
        if (!gameIds.has(chat.gameId)) return;
        const senderPhone = normalizePhoneForGame(chat.lastMessageSenderPhone);
        const isMine = Boolean(senderPhone && senderPhone === profilePhoneNorm);
        const readTs = latestReadMap[chat.gameId] ?? 0;
        if (!isMine && chat.lastMessageTs > readTs) {
          nextUnread[chat.gameId] = 1;
        }
      });

      if (!cancelled) {
        setChatUnreadByGame(nextUnread);
      }
    };

    void run();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void run();
    }, 12000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [createdGames, profilePhoneNorm]);

  const gameByBookingId = useMemo(() => {
    const map = new Map<string, PadelGameRecord>();
    createdGames.forEach((game) => {
      if (!game || isGameCancelledStatus(game.status)) return;
      collectGameBookingIds(game).forEach((bookingId) => {
        if (!map.has(bookingId)) {
          map.set(bookingId, game);
        }
      });
    });
    return map;
  }, [createdGames]);
  const gameBySlotKey = useMemo(() => {
    const map = new Map<string, PadelGameRecord>();
    createdGames.forEach((game) => {
      if (!game || isGameCancelledStatus(game.status)) return;
      const slotKey = buildGameSlotKey(game);
      if (!slotKey || map.has(slotKey)) return;
      map.set(slotKey, game);
    });
    return map;
  }, [createdGames]);
  const gameByExerciseId = useMemo(() => {
    const map = new Map<string, PadelGameRecord>();
    createdGames.forEach((game) => {
      if (!game || isGameCancelledStatus(game.status)) return;
      collectGameExerciseIds(game).forEach((exerciseId) => {
        if (!map.has(exerciseId)) {
          map.set(exerciseId, game);
        }
      });
    });
    return map;
  }, [createdGames]);
  const gameBySlotIdKey = useMemo(() => {
    const map = new Map<string, PadelGameRecord>();
    createdGames.forEach((game) => {
      if (!game || isGameCancelledStatus(game.status)) return;
      const slotIdKey = buildGameSlotIdKey(game);
      if (!slotIdKey || map.has(slotIdKey)) return;
      map.set(slotIdKey, game);
    });
    return map;
  }, [createdGames]);
  const resolveGameForBooking = useCallback((booking: Booking): PadelGameRecord | null => {
    const bookingId = normalizeBookingLikeId(booking.id);
    if (bookingId) {
      const byId = gameByBookingId.get(bookingId);
      if (byId) return byId;
    }
    const exerciseIds = collectBookingExerciseIds(booking);
    for (const exerciseId of exerciseIds) {
      const byExerciseId = gameByExerciseId.get(exerciseId);
      if (byExerciseId) return byExerciseId;
    }
    const slotIdKey = buildBookingSlotIdKey(booking);
    if (slotIdKey) {
      const bySlotIdKey = gameBySlotIdKey.get(slotIdKey);
      if (bySlotIdKey) return bySlotIdKey;
    }
    const slotKey = buildBookingSlotKey(booking);
    if (!slotKey) return null;
    return gameBySlotKey.get(slotKey) ?? null;
  }, [gameByBookingId, gameByExerciseId, gameBySlotIdKey, gameBySlotKey]);
  const resolveCancelledGameForBooking = useCallback((booking: Booking): PadelGameRecord | null => {
    const bookingId = normalizeBookingLikeId(booking.id);
    if (bookingId) {
      const byId = gameByBookingId.get(bookingId);
      if (byId) return byId;
    }
    const exerciseIds = collectBookingExerciseIds(booking);
    for (const exerciseId of exerciseIds) {
      const byExerciseId = gameByExerciseId.get(exerciseId);
      if (byExerciseId) return byExerciseId;
    }
    return null;
  }, [gameByBookingId, gameByExerciseId]);
  const hasTeamGameForBooking = useCallback((booking: Booking): boolean => {
    return Boolean(resolveGameForBooking(booking));
  }, [resolveGameForBooking]);
  const activeBookingsLoadedCount = activeBookings?.content?.length ?? 0;
  const activeBookingsTotal = activeBookings?.totalElements ?? activeBookingsLoadedCount;
  const hasMoreActiveBookings = activeBookingsTotal > activeBookingsLoadedCount;
  const hasMoreActiveGames = activeGameRecordsTotal > createdGames.length;
  const hasMoreActiveRecords = !hasLoadedAllActiveRecords && (hasMoreActiveBookings || hasMoreActiveGames);
  const allBookings = useMemo(
    () => [
      ...(activeBookings?.content ?? []),
      ...(historyBookings?.content ?? []),
    ],
    [activeBookings?.content, historyBookings?.content],
  );
  const tournamentHistorySourceBookings = useMemo(() => {
    if (!selectedTournamentBooking) return allBookings;
    return allBookings.includes(selectedTournamentBooking) ? allBookings : [...allBookings, selectedTournamentBooking];
  }, [allBookings, selectedTournamentBooking]);
  const tournamentExerciseIds = useMemo(() => {
    const bucket = new Set<string>();
    tournamentHistorySourceBookings.forEach((booking) => {
      if (!isTournamentBookingCandidate(booking)) return;
      collectBookingExerciseIds(booking).forEach((exerciseId) => bucket.add(exerciseId));
    });
    return Array.from(bucket).sort();
  }, [tournamentHistorySourceBookings]);
  useEffect(() => {
    if (tournamentExerciseIds.length === 0) {
      setCustomTournaments([]);
      return;
    }

    let alive = true;
    void Promise.all(
      tournamentExerciseIds.map(async (exerciseId) => {
        const result = await apiFetchTournamentHistory(exerciseId);
        return Array.isArray(result.data) ? result.data : [];
      }),
    ).then((results) => {
      if (!alive) return;
      const next = new Map<string, TournamentHistoryRecord>();
      results.flat().forEach((record) => {
        const normalizedTournamentId = normalizeBookingLikeId(record.tournamentId);
        if (!normalizedTournamentId || next.has(normalizedTournamentId)) return;
        next.set(normalizedTournamentId, record);
      });
      setCustomTournaments(Array.from(next.values()));
    }).catch(() => {
      if (!alive) return;
      setCustomTournaments([]);
    });

    return () => {
      alive = false;
    };
  }, [tournamentExerciseIds]);
  useEffect(() => {
    if (createdGames.length === 0 || allBookings.length === 0) return;

    const cancelledGameIds = new Set<string>();
    allBookings.forEach((booking) => {
      if (!booking.isCancelled) return;
      const game = resolveCancelledGameForBooking(booking);
      if (game?.id) {
        cancelledGameIds.add(game.id);
      }
    });

    if (cancelledGameIds.size === 0) return;

    setCreatedGames((prev) => {
      let changed = false;
      const next = prev.map((game) => {
        if (!cancelledGameIds.has(game.id) || isGameCancelledStatus(game.status)) {
          return game;
        }
        changed = true;
        return {
          ...game,
          status: "CANCELLED",
        };
      });
      return changed ? next : prev;
    });

    const gameIdsToPersist = Array.from(cancelledGameIds).filter(
      (gameId) => !cancellingGameIdsRef.current.has(gameId),
    );
    if (gameIdsToPersist.length === 0) return;

    gameIdsToPersist.forEach((gameId) => {
      cancellingGameIdsRef.current.add(gameId);
    });

    void Promise.all(gameIdsToPersist.map(async (gameId) => {
      const result = await apiUpdatePadelGameRecord(gameId, { status: "CANCELLED" });
      if (result.data?.id) {
        setCreatedGames((prev) => prev.map((game) => (
          game.id === result.data?.id ? (result.data as PadelGameRecord) : game
        )));
        return;
      }
      cancellingGameIdsRef.current.delete(gameId);
    }));
  }, [allBookings, createdGames.length, resolveCancelledGameForBooking]);
  const bookingPaidById = useMemo(() => {
    const next = new Map<string, boolean | null>();
    allBookings.forEach((booking) => {
      const bookingId = normalizeBookingLikeId(booking.id);
      if (!bookingId) return;
      const paidState = resolveBookingPaidState(booking);
      const prev = next.get(bookingId);
      if (prev === true) return;
      if (paidState === true) {
        next.set(bookingId, true);
        return;
      }
      if (prev == null) {
        next.set(bookingId, paidState);
      }
    });
    return next;
  }, [allBookings]);
  const bookingById = useMemo(() => {
    const next = new Map<string, Booking>();
    allBookings.forEach((booking) => {
      const bookingId = normalizeBookingLikeId(booking.id);
      if (!bookingId || next.has(bookingId)) return;
      next.set(bookingId, booking);
    });
    return next;
  }, [allBookings]);
  const tournamentByExerciseId = useMemo(() => {
    const next = new Map<string, TournamentHistoryRecord>();
    customTournaments.forEach((record) => {
      const tournamentId = normalizeBookingLikeId(record.tournamentId);
      if (!tournamentId || next.has(tournamentId)) return;
      next.set(tournamentId, record);
    });
    return next;
  }, [customTournaments]);
  const resolveTournamentForBooking = useCallback((booking: Booking): TournamentHistoryRecord | null => {
    const exerciseIds = collectBookingExerciseIds(booking);
    for (const exerciseId of exerciseIds) {
      const match = tournamentByExerciseId.get(exerciseId);
      if (match) return match;
    }
    return null;
  }, [tournamentByExerciseId]);
  const closeTournamentDetails = useCallback(() => {
    setSelectedTournamentBooking(null);
  }, []);
  const handleOpenTournamentDetails = useCallback((booking: Booking) => {
    setSelectedTournamentBooking(booking);
  }, []);
  const bookingPaidBySlotKey = useMemo(() => {
    const next = new Map<string, boolean | null>();
    allBookings.forEach((booking) => {
      const slotKey = buildBookingSlotKey(booking);
      if (!slotKey) return;
      const paidState = resolveBookingPaidState(booking);
      const prev = next.get(slotKey);
      if (prev === true) return;
      if (paidState === true) {
        next.set(slotKey, true);
        return;
      }
      if (prev == null) {
        next.set(slotKey, paidState);
      }
    });
    return next;
  }, [allBookings]);
  const isGamePaidForInvite = useCallback((game: PadelGameRecord): boolean => {
    if (isGamePaidRecord(game)) return true;

    const bookingIds = collectGameBookingIds(game);
    if (bookingIds.length > 0) {
      const states = bookingIds
        .map((bookingId) => bookingPaidById.get(bookingId))
        .filter((state): state is boolean => state !== null && state !== undefined);
      if (states.includes(true)) return true;
      if (states.length > 0 && states.every((state) => state === false)) return false;
    }

    const slotKey = buildGameSlotKey(game);
    if (slotKey) {
      const slotPaidState = bookingPaidBySlotKey.get(slotKey);
      if (slotPaidState != null) return slotPaidState;
    }

    return !isGameExplicitlyUnpaidRecord(game);
  }, [bookingPaidById, bookingPaidBySlotKey]);

  const resolveBookingForGameCancellation = useCallback((game: PadelGameRecord): Booking | null => {
    const bookingIds = collectGameBookingIds(game);
    for (const bookingId of bookingIds) {
      const booking = bookingById.get(bookingId) ?? null;
      if (booking && !booking.isCancelled) {
        return booking;
      }
    }

    const activeSource = activeBookings?.content ?? [];
    for (const booking of activeSource) {
      if (booking.isCancelled) continue;
      const linkedGame = resolveGameForBooking(booking);
      if (linkedGame?.id === game.id) {
        return booking;
      }
    }

    return null;
  }, [activeBookings?.content, bookingById, resolveGameForBooking]);

  const loadBookings = async () => {
    const shouldRefreshHistory = isBookingHistoryOpen || historyBookings !== null;
    const [activeBookingsData, historyBookingsData, userSubscriptionsData] = await Promise.all([
      apiFetchBookings(false),
      shouldRefreshHistory ? loadHistoryBookings(true) : Promise.resolve(null),
      apiFetchSubscriptions(),
    ]);
    if (activeBookingsData) setActiveBookings(activeBookingsData.data);
    if (userSubscriptionsData.data) setUserSubscriptions(userSubscriptionsData.data);
    trackAnalyticsEvent("cabinet_data_refreshed", {
      activeBookingsCount: activeBookingsData?.data?.content?.length ?? 0,
      historyBookingsCount: historyBookingsData?.content?.length ?? (historyBookings?.content?.length ?? 0),
      historyBookingsLoaded: shouldRefreshHistory,
      subscriptionsCount: userSubscriptionsData?.data?.content?.length ?? 0,
    });
  };

  const openBookingHistory = useCallback(() => {
    setIsBookingHistoryOpen(true);
    void loadAllActiveRecords();
    void loadHistoryBookings();
  }, [loadAllActiveRecords, loadHistoryBookings]);

  const openSubInfo = (sub: Subscription, subName: string) => {
    SetCurrenSub(sub);
    SetCurrenSubName(subName);
    SetSubscriptionInfoOpen(true);
  };

  if (loading) return <div className="loading">Загрузка...</div>;
  if (loadError) {
    return (
      <div className="load-error">
        <div className="load-error-title">Не удалось загрузить личный кабинет</div>
        <div className="load-error-text">Попробуйте подключиться к WiFi сети и загрузить кабинет повторно.</div>
        <button
          className="section-cta"
          type="button"
          onClick={() => {
            trackAnalyticsEvent("cabinet_reload_clicked");
            setReloadKey((v) => v + 1);
          }}
        >
          Повторить
        </button>
      </div>
    );
  }
  if (!profile) return <div className="load-error">{CABINET_LOAD_ERROR_TEXT}</div>;
  const numericLevelValue = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric);
  const hasLevel = numericLevelValue !== undefined && numericLevelValue !== null && numericLevelValue !== "";
  const onboardingLabel = "Определи свой уровень";
  const canHostTournaments = hasTournamentHostingAccess(profile);
  const canOpenTournamentsBlock = canHostTournaments || hasAssignedTournamentAccess;

  const openOnboarding = () => {
    trackAnalyticsEvent("onboarding_open_requested", {
      source: "cabinet",
      clientId: profile.id,
    });
    onOpenOnboarding({
      profile,
      gamesLink: resolveQuickActionHref(QUICK_ACTIONS.find((action) => action.label === "Играть")?.href || "#"),
      trainingLink: resolveQuickActionHref(
        QUICK_ACTIONS.find((action) => action.label === "Групповые тренировки")?.href || "#",
      ),
      tournamentsLink: resolveQuickActionHref(
        QUICK_ACTIONS.find((action) => action.label === "Турниры")?.href || "#",
      ),
    });
  };

  const openLevelsInfo = () => {
    trackAnalyticsEvent("levels_info_open_requested", {
      source: "cabinet_avatar",
      clientId: profile.id,
    });
    onOpenLevelsInfo({ profile });
  };

  const handleCopyInviteFromFeed = async (game: PadelGameRecord) => {
    const url = resolveGameInviteUrl(game) || "";
    if (!url) return;
    try {
      await shareOrCopyGameInvitePayload(url, game, {
        includePreviewImage: true,
        preferNativeShare: false,
      });
      setCopiedGameInviteId(game.id);
      window.setTimeout(() => {
        setCopiedGameInviteId((prev) => (prev === game.id ? null : prev));
      }, 1600);
    } catch {
      setCopiedGameInviteId(null);
    }
  };

  const handleOpenGameChat = (game: PadelGameRecord) => {
    onOpenGames({ gameId: game.id, openChat: true });
  };

  const handleOpenGameDetails = (game: PadelGameRecord) => {
    onOpenGames({ gameId: game.id, openChat: false });
  };

  const handleCancelGameBooking = async (gameId: string, bookingId: string) => {
    if (!gameId || !bookingId || cancellingGameId) return;

    setCancellingGameId(gameId);
    const res = await apiCancelBooking(bookingId);
    const ok = res.status !== null && res.status >= 200 && res.status < 300;

    setGameCancelOkById((prev) => ({ ...prev, [gameId]: ok }));
    setGameCancelStateById((prev) => ({ ...prev, [gameId]: "done" }));
    setCancellingGameId(null);
  };

  const handleCreateTeamGameFromBooking = (booking: Booking) => {
    const exercise = booking.exercise;
    const bookingId = String(booking.id || "").trim();
    if (!bookingId || !exercise?.timeFrom || !exercise?.timeTo) return;

    const date = toDateKey(exercise.timeFrom);
    const timeFrom = toTimeKey(exercise.timeFrom);
    const timeTo = toTimeKey(exercise.timeTo);
    if (!date || !timeFrom || !timeTo) return;

    const paidState = resolveBookingPaidState(booking);
    const amountRub = Number.isFinite(booking.cost) ? Math.max(0, Math.round(booking.cost / 100)) : null;
    const slotId =
      pickStringFromRecord(booking, ["slotId", "timeSlotId", "slot_id", "time_slot_id"]) ??
      pickStringFromRecord(exercise, ["slotId", "timeSlotId", "slot_id", "time_slot_id"]);
    const exerciseId =
      pickStringFromUnknown(exercise.id) ??
      pickStringFromRecord(booking, ["exerciseId", "vivaExerciseId", "exercise_id", "viva_exercise_id"]);
    const durationMinutes = resolveDurationMinutes(exercise.timeFrom, exercise.timeTo);

    onOpenGames({
      createFromBooking: {
        bookingId,
        slotId,
        exerciseId,
        studioId: pickStringFromUnknown(exercise.studio?.id),
        studioName: pickStringFromUnknown(exercise.studio?.name),
        roomId: pickStringFromUnknown(exercise.room?.id),
        roomName: pickStringFromUnknown(exercise.room?.name),
        date,
        timeFrom,
        timeTo,
        durationMinutes,
        amount: amountRub,
        paid: paidState,
        paymentUrl: booking.transactionStatus?.cardPaymentStatus?.paymentUrl ?? null,
        directionName: pickStringFromUnknown(exercise.direction?.name),
      },
    });
  };

  const isCurrentUserOrganizer = (game: PadelGameRecord): boolean => {
    const profileId = (profile?.id || "").trim();
    const organizerId = (game.organizer?.id || "").trim();
    if (profileId && organizerId && profileId === organizerId) {
      return true;
    }
    const organizerPhoneNorm = normalizePhoneForGame(game.organizer?.phone ?? null);
    return Boolean(profilePhoneNorm && organizerPhoneNorm && profilePhoneNorm === organizerPhoneNorm);
  };

  const handleOpenTournaments = (options?: OpenTournamentsOptions) => {
    trackAnalyticsEvent("module_open_requested", {
      module: "tournaments",
      source: "cabinet",
      clientId: profile.id,
      tournamentId: options?.tournamentId ?? null,
    });
    onOpenTournaments(options);
  };

  const handleOpenGamesCreate = () => {
    trackAnalyticsEvent("module_open_requested", {
      module: "games",
      source: "cabinet",
      action: "gather_friends_click",
      clientId: profile.id,
    });
    onOpenGames();
  };

  const handleOpenCabinetHomeFromCommunities = () => {
    cabinetRootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleOpenProfileFromCommunities = () => {
    profileSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleQuickActionPlay = (action: QuickAction) => {
    const resolvedHref = resolveFindGameHref(resolveQuickActionHref(action.href));
    trackAnalyticsEvent("quick_action_click", {
      label: action.label,
      href: resolvedHref,
      clientId: profile.id,
    });
    window.location.href = resolvedHref;
  };

  const handleInlineGameResultScoreChange = (
    gameId: string,
    side: keyof InlineGameResultScore,
    value: string,
  ) => {
    setInlineGameResultScores((current) => ({
      ...current,
      [gameId]: {
        left: current[gameId]?.left ?? "",
        right: current[gameId]?.right ?? "",
        [side]: normalizeScoreInput(value),
      },
    }));
    setInlineGameResultErrorById((current) => {
      if (!current[gameId]) return current;
      const next = { ...current };
      delete next[gameId];
      return next;
    });
  };

  const handleSaveInlineGameResult = async (
    game: PadelGameRecord,
    teamSlots: Array<PadelGamePlayer | null>,
  ) => {
    const score = inlineGameResultScores[game.id] ?? { left: "", right: "" };
    const left = Number.parseInt(score.left, 10);
    const right = Number.parseInt(score.right, 10);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      setInlineGameResultErrorById((current) => ({
        ...current,
        [game.id]: "Введите счёт с обеих сторон",
      }));
      return;
    }

    setSavingInlineGameResultId(game.id);
    setInlineGameResultErrorById((current) => {
      if (!current[game.id]) return current;
      const next = { ...current };
      delete next[game.id];
      return next;
    });

    const storedTeamSlots = teamSlots.map((player) => (
      player
        ? {
            id: player.id ?? null,
            phone: normalizePhoneForGame(player.phone),
            name: player.name || null,
          }
        : null
    ));
    const nextMetadata = {
      ...(isRecord(game.metadata) ? game.metadata : {}),
      teamSlots: storedTeamSlots,
      matchResult: {
        ...(isRecord(game.metadata?.matchResult) ? game.metadata.matchResult : {}),
        sets: [{ left, right }],
        setPairings: [{ setIndex: 0, teamSlots: storedTeamSlots }],
        status: "DRAFT",
        savedAt: new Date().toISOString(),
        savedBy: {
          id: profile?.id ?? null,
          phone: normalizePhoneForGame(profile?.phone ?? null),
          name: [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim() || null,
        },
      },
    };

    try {
      const result = await apiUpdatePadelGameRecord(game.id, { metadata: nextMetadata });
      if (!result.data?.id) {
        setInlineGameResultErrorById((current) => ({
          ...current,
          [game.id]: result.error?.message || "Не удалось сохранить результат",
        }));
        return;
      }

      setCreatedGames((current) => current.map((item) => (
        item.id === game.id ? (result.data as PadelGameRecord) : item
      )));
      setInlineGameResultScores((current) => {
        const next = { ...current };
        delete next[game.id];
        return next;
      });
    } catch {
      setInlineGameResultErrorById((current) => ({
        ...current,
        [game.id]: "Не удалось сохранить результат",
      }));
    } finally {
      setSavingInlineGameResultId(null);
    }
  };

  const renderGameCard = (
    game: PadelGameRecord,
    options?: {
      onBeforeOpen?: () => void;
    },
  ) => {
    const handleBeforeOpen = () => {
      options?.onBeforeOpen?.();
    };
    const openGameDetails = () => {
      handleBeforeOpen();
      handleOpenGameDetails(game);
    };
    const openGameChat = () => {
      handleBeforeOpen();
      handleOpenGameChat(game);
    };
    const stationTitle = String(game.booking?.studioName || "").trim();
    const customTitle = extractGameCustomTitle(isRecord(game.metadata) ? game.metadata : null);
    const cardTitle = customTitle || (stationTitle ? `Игра ${stationTitle}` : "Игра");
    const courtTitle = String(game.booking?.roomName || "").trim();
    const cardLocationTitle = customTitle
      ? [stationTitle, courtTitle].filter(Boolean).join(" • ")
      : courtTitle;
    const badge = getDateBadge(game.booking?.date);
    const timeFrom = game.booking?.timeFrom ?? "—:—";
    const timeTo = game.booking?.timeTo ?? "—:—";
    const ratingTag = game.settings?.ratingGame ? "Игра на уровень" : "Без уровня";
    const durationTag = game.booking?.durationMinutes
      ? `${game.booking.durationMinutes} мин`
      : null;
    const ratingRangeTag =
      game.settings?.minRating && game.settings?.maxRating
        ? `${game.settings.minRating}/${game.settings.maxRating}`
        : null;
    const isCurrentUserPlayer = (player: PadelGamePlayer | null | undefined): boolean => {
      if (!player) return false;
      const normalizedProfileId = (profile?.id || "").trim();
      const playerId = (player.id || "").trim();
      if (normalizedProfileId && playerId && normalizedProfileId === playerId) {
        return true;
      }
      const playerPhoneNorm = normalizePhoneForGame(player.phone);
      return Boolean(profilePhoneNorm && playerPhoneNorm && profilePhoneNorm === playerPhoneNorm);
    };
    const waitlistPlayers = Array.isArray(game.waitlist) ? game.waitlist : [];
    const topLevelWaitlistCount = Array.isArray(game.waitlistPhones)
      ? game.waitlistPhones.reduce((count, phoneValue) => {
          return normalizePhoneForGame(phoneValue) ? count + 1 : count;
        }, 0)
      : 0;
    const metadataWaitlistCount = Array.isArray(game.metadata?.waitlistPhones)
      ? game.metadata.waitlistPhones.reduce((count, phoneValue) => {
          if (typeof phoneValue !== "string") return count;
          return normalizePhoneForGame(phoneValue) ? count + 1 : count;
        }, 0)
      : 0;
    const participantsWaitlistCount = Array.isArray(game.participants)
      ? game.participants.reduce((count, player) => {
          const status = String(player.status || "").trim().toUpperCase();
          return status.includes("WAIT") ? count + 1 : count;
        }, 0)
      : 0;
    const waitlistCount = Math.max(
      waitlistPlayers.length,
      topLevelWaitlistCount,
      metadataWaitlistCount,
      participantsWaitlistCount,
    );
    const isCurrentUserWaitlisted =
      waitlistPlayers.some((player) => isCurrentUserPlayer(player))
      || (Array.isArray(game.waitlistPhones)
        && game.waitlistPhones.some((value) => normalizePhoneForGame(value) === profilePhoneNorm))
      || (Array.isArray(game.participants)
        && game.participants.some((player) => {
          if (!isCurrentUserPlayer(player)) return false;
          const status = String(player.status || "").trim().toUpperCase();
          return status.includes("WAIT");
        }))
      || (Array.isArray(game.metadata?.waitlistPhones)
        && game.metadata.waitlistPhones.some((value) => {
          if (typeof value !== "string") return false;
          return normalizePhoneForGame(value) === profilePhoneNorm;
        }));
    const isOrganizer = isCurrentUserOrganizer(game);
    const showOrganizerWaitlistBadge = isOrganizer && waitlistCount > 0;
    const linkedBooking = resolveBookingForGameCancellation(game);
    const inviteUrl = resolveGameInviteUrl(game);
    const canInvite = Boolean(
      inviteUrl
      && isOrganizer
      && !isGameCancelledStatus(game.status)
      && isGamePaidForInvite(game)
    );
    const canCancelGameBooking = Boolean(
      isOrganizer
      && linkedBooking
      && linkedBooking.cancellationDeadline
      && new Date(linkedBooking.cancellationDeadline) > new Date(),
    );
    const showCancelDeadlineText = Boolean(isOrganizer && linkedBooking && !canCancelGameBooking);
    const cancelState = gameCancelStateById[game.id] ?? "idle";
    const cancelOk = gameCancelOkById[game.id] ?? false;
    const isCancellingThisGame = cancellingGameId === game.id;
    const unreadCount = chatUnreadByGame[game.id] ?? 0;
    const organizerPlayer: PadelGamePlayer | null = game.organizer
      ? {
          id: game.organizer.id ?? null,
          name: game.organizer.name || "Организатор",
          phone: game.organizer.phone ?? null,
          photo: game.organizer.photo ?? null,
          rating: game.organizer.rating ?? null,
          source: "ORGANIZER",
          status: "CONFIRMED",
        }
      : null;
    const participants = game.participants && game.participants.length > 0
      ? game.participants
      : (organizerPlayer ? [organizerPlayer] : []);
    const playersCount = resolveGameCardPlayersCount(game);
    const splitJoinPriceText = getSplitJoinPriceText(game);
    const splitCancelDeadlineAt = getSplitCancelDeadlineAt(game);
    const splitCountdownText = formatCountdown(splitCancelDeadlineAt, Date.now());
    const showSplitJoinInfo = !isOrganizer && !isCurrentUserWaitlisted
      && (playersCount - Math.max(participants.length, 0)) > 0
      && Boolean(splitJoinPriceText || splitCountdownText);
    const playerSlots = Array.from({ length: playersCount }, (_, index) => (
      participants[index] ?? null
    ));
    const teamSlots = resolveStoredTeamSlots(game, playerSlots);
    const showInlineResultEntry = shouldShowInlineResultEntry(game) && participants.some((player) => isCurrentUserPlayer(player));
    const inlineResultScore = inlineGameResultScores[game.id] ?? { left: "", right: "" };
    const inlineResultSaving = savingInlineGameResultId === game.id;
    const inlineResultCanSave = inlineResultScore.left.trim() !== "" && inlineResultScore.right.trim() !== "";
    const inlineResultError = inlineGameResultErrorById[game.id] ?? null;
    const waitlistBadgeLabel = isCurrentUserWaitlisted
      ? "В листе ожидания"
      : showOrganizerWaitlistBadge
        ? `Лист ожидания: ${waitlistCount}`
        : null;

    return (
      <div
        key={game.id}
        className="game-created-card game-created-card-clickable"
        onClick={openGameDetails}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openGameDetails();
          }
        }}
      >
        {waitlistBadgeLabel && (
          <div className="game-created-top-badge-row">
            <span
              className={`game-created-tag game-created-tag-waitlist${isCurrentUserWaitlisted ? " game-created-tag-waitlist-user" : ""}`}
            >
              {waitlistBadgeLabel}
            </span>
          </div>
        )}
        <div className="game-created-head">
          <div className="game-created-head-main">
            <div className="game-created-date">{cardTitle}</div>
            {cardLocationTitle && <div className="game-created-court">{cardLocationTitle}</div>}
            <div className="game-created-time">{`${timeFrom} • ${timeTo}`}</div>
            <div className="game-created-tags">
              <span className={`game-created-tag ${game.settings?.ratingGame ? "game-created-tag-level" : "game-created-tag-neutral"}`}>
                {ratingTag}
              </span>
              {durationTag && <span className="game-created-tag game-created-tag-duration">{durationTag}</span>}
              {ratingRangeTag && <span className="game-created-tag game-created-tag-range">{ratingRangeTag}</span>}
            </div>
          </div>
          <div className="game-created-head-right">
            <CalendarDateBadge
              monthLabel={badge.month}
              dayLabel={badge.day}
              weekdayLabel={badge.weekday}
              badgeClassName="game-created-date-badge"
              buttonClassName="game-created-date-badge-button"
              variant="game-card"
              disabled={!game.booking?.date || (!game.booking?.timeFrom && !game.booking?.timeTo)}
              onClick={() => addGameToCalendar(game)}
            />
          </div>
        </div>
        {!showInlineResultEntry && (
          <div className={`game-created-players${playersCount <= 2 ? " game-created-players-singles" : ""}`}>
            {playerSlots.map((player, index) => {
              const initials = getPlayerInitials(player?.name);
              const levelLabel = normalizePlayerRatingLabel(player?.rating ?? null);
              const levelProgress = getPlayerRatingProgress(levelLabel);
              const ringProgressDeg =
                levelProgress != null ? `${Math.max(0, Math.min(360, Math.round(levelProgress * 360)))}deg` : "0deg";
              return (
                <div key={`${game.id}-slot-${index}`} className="game-created-player">
                  <div
                    className={`game-created-player-ring${levelLabel ? " has-level" : ""}`}
                    style={{ "--player-ring-progress": ringProgressDeg } as CSSProperties}
                  >
                    {player?.photo ? (
                      <img
                        src={player.photo}
                        alt={player.name}
                        className="game-created-player-avatar"
                      />
                    ) : (
                      <div className="game-created-player-avatar game-created-player-fallback">
                        {initials}
                      </div>
                    )}
                  </div>
                  {levelLabel && (
                    <div className="game-created-player-level">
                      {levelLabel}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showInlineResultEntry && (
          <div className="game-created-result-entry">
            <div className="game-created-result-entry-head">
              <span>Команды</span>
              <span>{playersCount <= 2 ? "1 пара по 2 игрока" : "2 пары по 2 игрока"}</span>
            </div>
            <div className={`game-created-result-teams${playersCount <= 2 ? " game-created-result-teams-singles" : ""}`}>
              {[
                { label: "Команда 1", indexes: [0, 1] },
                ...(playersCount <= 2 ? [] : [{ label: "Команда 2", indexes: [2, 3] }]),
              ].map((team) => (
                <div key={team.label} className="game-created-result-team">
                  <div className="game-created-result-team-title">{team.label}</div>
                  <div className="game-created-result-team-players">
                    {team.indexes.map((slotIndex) => {
                      const player = teamSlots[slotIndex] ?? null;
                      const initials = getPlayerInitials(player?.name);
                      const levelLabel = normalizePlayerRatingLabel(player?.rating ?? null);
                      const levelProgress = getPlayerRatingProgress(levelLabel);
                      const ringProgressDeg =
                        levelProgress != null ? `${Math.max(0, Math.min(360, Math.round(levelProgress * 360)))}deg` : "0deg";
                      return (
                        <div key={`${game.id}-result-slot-${slotIndex}`} className="game-created-result-player">
                          <div
                            className={`game-created-player-ring${levelLabel ? " has-level" : ""}`}
                            style={{ "--player-ring-progress": ringProgressDeg } as CSSProperties}
                          >
                            {player?.photo ? (
                              <img
                                src={player.photo}
                                alt={player.name}
                                className="game-created-player-avatar"
                              />
                            ) : (
                              <div className="game-created-player-avatar game-created-player-fallback">
                                {initials}
                              </div>
                            )}
                          </div>
                          {levelLabel && <div className="game-created-player-level">{levelLabel}</div>}
                          <div className="game-created-result-player-name">{player?.name || "Свободно"}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <div className="game-created-result-score">
              <span>Сет 1</span>
              <input
                type="text"
                inputMode="numeric"
                value={inlineResultScore.left}
                onChange={(event) => handleInlineGameResultScoreChange(game.id, "left", event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                disabled={inlineResultSaving}
                aria-label="Счёт первой команды"
              />
              <b>-</b>
              <input
                type="text"
                inputMode="numeric"
                value={inlineResultScore.right}
                onChange={(event) => handleInlineGameResultScoreChange(game.id, "right", event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                disabled={inlineResultSaving}
                aria-label="Счёт второй команды"
              />
            </div>
            {inlineResultError && <div className="game-created-result-error">{inlineResultError}</div>}
            <button
              type="button"
              className="game-created-action game-created-result-save"
              onClick={(event) => {
                event.stopPropagation();
                void handleSaveInlineGameResult(game, teamSlots);
              }}
              onKeyDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              disabled={inlineResultSaving || !inlineResultCanSave}
            >
              {inlineResultSaving ? "Сохраняем..." : "Сохранить результат"}
            </button>
          </div>
        )}

        {!showInlineResultEntry && (
        <div className={`game-created-actions${canInvite ? " game-created-actions-organizer" : " game-created-actions-single"}`}>
          {showSplitJoinInfo && (
            <div className="game-created-split-join-info" aria-label="Условия присоединения к сборной игре">
              {splitJoinPriceText && (
                <div className="game-created-split-join-info-row">
                  <span>Вход</span>
                  <strong>{splitJoinPriceText}</strong>
                </div>
              )}
              {splitCountdownText && (
                <div className="game-created-split-join-info-row">
                  <span>Отмена через</span>
                  <strong>{splitCountdownText}</strong>
                </div>
              )}
            </div>
          )}
          {canInvite && (
            <button
              className="game-created-action game-created-action-invite"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleCopyInviteFromFeed(game);
              }}
            >
              {copiedGameInviteId === game.id ? "Скопировано" : "Пригласить в игру"}
            </button>
          )}
          <button
            className={`game-created-action game-chat-open-btn${canInvite ? " game-created-action-chat-icon" : ""}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openGameChat();
            }}
            aria-label="Открыть чат игры"
            title="Чат"
          >
            {canInvite ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M3.333 10.667H2.667C1.93 10.667 1.333 10.07 1.333 9.333V2.667C1.333 1.93 1.93 1.333 2.667 1.333H9.333C10.07 1.333 10.667 1.93 10.667 2.667V3.333"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M6.667 5.333H13.333C14.07 5.333 14.667 5.93 14.667 6.667V11.333C14.667 12.07 14.07 12.667 13.333 12.667H10L7.333 14.667V12.667H6.667C5.93 12.667 5.333 12.07 5.333 11.333V6.667C5.333 5.93 5.93 5.333 6.667 5.333Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              "Чат"
            )}
            {unreadCount > 0 && (
              <span className="game-chat-unread-badge">{unreadCount}</span>
            )}
          </button>
        </div>
        )}
        {canCancelGameBooking && cancelState === "idle" && linkedBooking && (
          <div className="booking-cancel-row game-created-cancel-row">
            <button
              className="btn-cancel danger"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setGameCancelStateById((prev) => ({ ...prev, [game.id]: "confirm" }));
              }}
            >
              Отменить запись
            </button>
          </div>
        )}
        {cancelState === "confirm" && linkedBooking && (
          <div className="booking-cancel-row game-created-cancel-row">
            <button
              className="btn-cancel outline"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setGameCancelStateById((prev) => ({ ...prev, [game.id]: "idle" }));
              }}
              disabled={isCancellingThisGame}
            >
              Нет
            </button>
            <button
              className="btn-cancel danger"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void handleCancelGameBooking(game.id, linkedBooking.id);
              }}
              disabled={isCancellingThisGame}
            >
              {isCancellingThisGame ? "Отменяем..." : "Да, отменить"}
            </button>
          </div>
        )}
        {cancelState === "done" && (
          <div className="booking-cancel-row game-created-cancel-row">
            <button
              className="btn-cancel primary"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (cancelOk) {
                  void loadBookings();
                  return;
                }
                setGameCancelStateById((prev) => ({ ...prev, [game.id]: "idle" }));
              }}
            >
              {cancelOk ? "Запись отменена, продолжить" : "Ошибка — закрыть"}
            </button>
          </div>
        )}
        {showCancelDeadlineText && (
          <div className="booking-status-text">Отмена возможна только за 24 часа</div>
        )}
      </div>
    );
  };

  const renderActionIcon = (label: string, fallback: string) => {
    if (label === "Играть") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M10.9801 5.82995C10.3851 5.45495 9.69512 5.24995 8.98512 5.24995C6.91512 5.24995 5.23512 6.92995 5.23512 8.99995C5.23512 9.70995 5.43512 10.3949 5.81012 10.9899C5.58012 10.9849 5.34512 10.9599 5.10512 10.9249C3.05012 10.5749 1.39512 8.90995 1.05512 6.84995C0.490117 3.42495 3.41012 0.504949 6.83512 1.06995C8.89512 1.40995 10.5601 3.06495 10.9101 5.11995C10.9501 5.35995 10.9751 5.59995 10.9801 5.82995Z" fill="white"/>
              <path d="M6.68999 10.93C6.24999 10.41 5.98499 9.735 5.98499 9C5.98499 7.345 7.32998 6 8.98498 6C9.71999 6 10.395 6.265 10.915 6.705" fill="white"/>
              <path d="M6.68999 10.93C6.24999 10.41 5.98499 9.735 5.98499 9C5.98499 7.345 7.32998 6 8.98498 6C9.71999 6 10.395 6.265 10.915 6.705C10.7499 9 8.74988 10.75 6.68999 10.93Z" fill="white"/>
            </svg>
          </svg>
        </span>
      );
    }

    if (label === "Турниры") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <path d="M13.625 17.125H12.5C11.95 17.125 11.5 17.575 11.5 18.125V18.25H11C10.795 18.25 10.625 18.42 10.625 18.625C10.625 18.83 10.795 19 11 19H17C17.205 19 17.375 18.83 17.375 18.625C17.375 18.42 17.205 18.25 17 18.25H16.5V18.125C16.5 17.575 16.05 17.125 15.5 17.125H14.375V15.98C14.25 15.995 14.125 16 14 16C13.875 16 13.75 15.995 13.625 15.98V17.125Z" fill="white"/>
            <path d="M17.24 13.82C17.57 13.695 17.86 13.49 18.09 13.26C18.555 12.745 18.86 12.13 18.86 11.41C18.86 10.69 18.295 10.125 17.575 10.125H17.295C16.97 9.46 16.29 9 15.5 9H12.5C11.71 9 11.03 9.46 10.705 10.125H10.425C9.705 10.125 9.14 10.69 9.14 11.41C9.14 12.13 9.445 12.745 9.91 13.26C10.14 13.49 10.43 13.695 10.76 13.82C11.28 15.1 12.53 16 14 16C15.47 16 16.72 15.1 17.24 13.82ZM15.42 12.225L15.11 12.605C15.06 12.66 15.025 12.77 15.03 12.845L15.06 13.335C15.08 13.635 14.865 13.79 14.585 13.68L14.13 13.5C14.06 13.475 13.94 13.475 13.87 13.5L13.415 13.68C13.135 13.79 12.92 13.635 12.94 13.335L12.97 12.845C12.975 12.77 12.94 12.66 12.89 12.605L12.58 12.225C12.385 11.995 12.47 11.74 12.76 11.665L13.235 11.545C13.31 11.525 13.4 11.455 13.44 11.39L13.705 10.98C13.87 10.725 14.13 10.725 14.295 10.98L14.56 11.39C14.6 11.455 14.69 11.525 14.765 11.545L15.24 11.665C15.53 11.74 15.615 11.995 15.42 12.225Z" fill="white"/>
          </svg>
        </span>
      );
    }

    if (label === "Индивидуальные тренировки") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12">
              <rect x="3.6252" y="1.0000" width="4.7496" height="4.7496" rx="2.3748" fill="white"/>
              <rect x="2.4804" y="6.3780" width="7.0392" height="4.6224" rx="2.3112" fill="white"/>
              <rect x="0" y="0" width="12" height="12" fill="white" opacity="0" transform="rotate(-180 6 6)"/>
            </svg>
          </svg>
        </span>
      );
    }

    if (label === "Групповые тренировки") {
      return (
        <span className="quick-action-icon quick-action-icon--svg">
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="0.5" y="0.5" width="27" height="27" rx="0.5" stroke="white" strokeOpacity="0.16"/>
            <svg x="8" y="8" width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M4.50012 0.999939C3.19012 0.999939 2.12512 2.06494 2.12512 3.37494C2.12512 4.65994 3.13012 5.69994 4.44012 5.74494C4.48012 5.73994 4.52012 5.73994 4.55012 5.74494C4.56012 5.74494 4.56512 5.74494 4.57512 5.74494C4.58012 5.74494 4.58012 5.74494 4.58512 5.74494C5.86512 5.69994 6.87012 4.65994 6.87512 3.37494C6.87512 2.06494 5.81012 0.999939 4.50012 0.999939Z" fill="white"/>
              <path d="M7.03998 7.07488C5.64498 6.14488 3.36998 6.14488 1.96498 7.07488C1.32998 7.49988 0.97998 8.07488 0.97998 8.68988C0.97998 9.30488 1.32998 9.87488 1.95998 10.2949C2.65998 10.7649 3.57998 10.9999 4.49998 10.9999C5.41998 10.9999 6.33998 10.7649 7.03998 10.2949C7.66998 9.86988 8.01998 9.29988 8.01998 8.67988C8.01498 8.06488 7.66998 7.49488 7.03998 7.07488Z" fill="white"/>
              <path d="M9.99505 3.66999C10.0751 4.63999 9.38505 5.48999 8.43005 5.60499C8.42505 5.60499 8.42505 5.60499 8.42005 5.60499H8.40505C8.37505 5.60499 8.34505 5.60499 8.32005 5.61499C7.83505 5.63999 7.39005 5.48499 7.05505 5.19999C7.57005 4.73999 7.86505 4.04999 7.80505 3.29999C7.77005 2.89499 7.63005 2.52499 7.42005 2.20999C7.61005 2.11499 7.83005 2.05499 8.05505 2.03499C9.03505 1.94999 9.91005 2.67999 9.99505 3.66999Z" fill="white"/>
              <path d="M10.995 8.29495C10.955 8.77995 10.645 9.19995 10.125 9.48495C9.625 9.75995 8.995 9.88995 8.37 9.87495C8.73 9.54995 8.93999 9.14495 8.97999 8.71495C9.02999 8.09495 8.735 7.49995 8.145 7.02495C7.81 6.75995 7.42 6.54995 6.995 6.39495C8.1 6.07495 9.49 6.28995 10.345 6.97995C10.805 7.34995 11.04 7.81495 10.995 8.29495Z" fill="white"/>
            </svg>
          </svg>
        </span>
      );
    }

    return <span className="quick-action-icon">{fallback}</span>;
  };

  return (
    <div ref={cabinetRootRef} className="app-container">

      {/* Шапка с профилем */}
      <div ref={profileSectionRef}>
        <UserProfile
          profile={profile}
          openEditForm={() => setIsEditOpen(true)}
          onAvatarClick={openLevelsInfo}
        />
      </div>

      {showCommunitiesSection && (
        <CommunitiesSectionLoader
          profile={profile}
          createdGames={createdGames}
          onOpenGames={onOpenGames}
          onOpenTournaments={handleOpenTournaments}
          onOpenHome={handleOpenCabinetHomeFromCommunities}
          onOpenProfile={handleOpenProfileFromCommunities}
          initialInviteCode={initialCommunityInviteCode}
          initialInviteLink={initialCommunityInviteLink}
          inviteEntryCabinetUrl={inviteEntryCabinetUrl}
        />
      )}

      {/* Онбординг */}
      {!hasLevel && (
        <div className="onboarding-section">
          <button
            className="onboarding-btn"
            onClick={openOnboarding}
          >
            {onboardingLabel}
          </button>
        </div>
      )}

      {/* Быстрые действия */}
      <div className="quick-actions">
        {QUICK_ACTIONS.map((action) => {
          const openInOverlay = action.label === "Играть";
          const resolvedHref = resolveQuickActionHref(action.href);
          const hashActionTarget = resolveHashActionTarget(action.href) ?? resolveHashActionTarget(resolvedHref);
          if (openInOverlay) {
            return (
              <button
                key={action.label}
                type="button"
                className="quick-action-card quick-action-card-button"
                onClick={() => handleQuickActionPlay(action)}
              >
                {renderActionIcon(action.label, action.icon)}
                <span className="quick-action-label">{action.label}</span>
              </button>
            );
          }
          if (hashActionTarget) {
            return (
              <button
                key={action.label}
                type="button"
                className="quick-action-card quick-action-card-button"
                onClick={() => {
                  trackAnalyticsEvent("quick_action_click", {
                    label: action.label,
                    href: resolvedHref,
                    clientId: profile.id,
                  });
                  retriggerHashAction(hashActionTarget);
                }}
              >
                {renderActionIcon(action.label, action.icon)}
                <span className="quick-action-label">{action.label}</span>
              </button>
            );
          }
          return (
            <a
              key={action.label}
              href={resolvedHref}
              target="_blank"
              rel="noopener noreferrer"
              className="quick-action-card"
              onClick={() =>
                trackAnalyticsEvent("quick_action_click", {
                  label: action.label,
                  href: resolvedHref,
                  clientId: profile.id,
                })}
            >
              {renderActionIcon(action.label, action.icon)}
              <span className="quick-action-label">{action.label}</span>
            </a>
          );
        })}
      </div>
      {SHOW_COLLECT_FRIENDS_BUTTON && (
        <div className="quick-actions-extra">
          <button className="section-cta" onClick={handleOpenGamesCreate} type="button">
            Собрать друзей
          </button>
        </div>
      )}

      {/* Записи */}
      <BookingsContainer
        activeBookings={activeBookings}
        historyBookings={historyBookings}
        historyLoading={loadingHistoryBookings}
        openHistory={openBookingHistory}
        preloadHistory={() => {
          void loadHistoryBookings();
        }}
        loadBookings={loadBookings}
        hasMoreActiveRecords={hasMoreActiveRecords}
        loadingMoreActiveRecords={loadingMoreActiveRecords}
        onLoadMoreActiveRecords={loadAllActiveRecords}
        gameRecords={createdGames}
        onCreateTeamGame={handleCreateTeamGameFromBooking}
        hasTeamGameForBooking={hasTeamGameForBooking}
        renderGameCard={renderGameCard}
        loadingGameRecords={loadingCreatedGames}
        gameRecordsError={createdGamesError}
        resolveGameForBooking={resolveGameForBooking}
        resolveTournamentForBooking={resolveTournamentForBooking}
        onOpenTournamentDetails={handleOpenTournamentDetails}
      />

      {/* Реклама */}
      <Advertisement profile={profile} />

      {/* Абонементы */}
      <SubscriptionsContainer
        UserSubscriptions={userSubscriptions}
        phone={profile.phone}
        openSubInfo={openSubInfo}
        openBuy={() => setOpenBuySub(true)}
      />

      {/* Турниры */}
      {canOpenTournamentsBlock && (
        <div className="section">
          <div className="section-header">
            <span className="section-title">Турниры</span>
          </div>
          <div className="section-body">
            <p className="section-text">Управляйте турнирами в отдельном модуле.</p>
            <button className="section-cta" onClick={() => handleOpenTournaments()} type="button">
              Перейти в турниры
            </button>
          </div>
        </div>
      )}

      {/* Соцсети */}
      <ButtonModule />

      {/* Модалки */}
      <ProfileEditForm
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        initialData={{
          email: profile.email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          middleName: profile.middleName,
          sex: profile.sex,
          photo: profile.photo,
        }}
        onSaveSuccess={loadProfile}
        showVerifyLevel={hasLevel}
        onVerifyLevel={openOnboarding}
      />
      <BookingHistory
        isOpen={isBookingHistoryOpen}
        onClose={() => setIsBookingHistoryOpen(false)}
        loading={loadingHistoryBookings}
        historyBookings={historyBookings}
        gameRecords={createdGames}
        renderGameCard={renderGameCard}
        resolveGameForBooking={resolveGameForBooking}
        resolveTournamentForBooking={resolveTournamentForBooking}
        onOpenTournamentDetails={(booking) => {
          setIsBookingHistoryOpen(false);
          handleOpenTournamentDetails(booking);
        }}
      />
      <TournamentDetailsModal
        isOpen={selectedTournamentBooking !== null}
        booking={selectedTournamentBooking}
        customTournament={selectedTournamentBooking ? resolveTournamentForBooking(selectedTournamentBooking) : null}
        onClose={closeTournamentDetails}
      />
      <SubscriptionInformation
        isOpen={isSubscriptionInfoOpen}
        onClose={() => SetSubscriptionInfoOpen(false)}
        sub={currenSub}
        subName={currenSubName}
      />
      <BuySupscription
        isOpen={isOpenBuySub}
        onClose={() => setOpenBuySub(false)}
        phone={profile.phone}
      />
      <SupportChatWidget profile={profile} />
    </div>
  );
}
