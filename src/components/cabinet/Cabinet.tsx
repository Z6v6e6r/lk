import { useState, useEffect, useRef, useMemo, useCallback, type CSSProperties } from "react";
import { UserProfile } from "./UserProfile";
import {
  apiCancelBooking,
  apiCreateReferralSubscriptionInvite,
  apiCleanupPadelGameByOrganizer,
  apiFetchProfile,
  apiFetchBookings,
  apiFetchExerciseById,
  apiFetchSubscriptioName,
  apiFetchSubscriptions,
  apiFetchPadelChatsByPhone,
  apiFetchPadelGamesByPhone,
  apiFetchPadelGamesByBookingReferences,
  apiLeavePadelGameAsCurrentUser,
  apiReleaseSubscriptionBookingClaim,
  apiFetchTournamentHistory,
  apiVerifyBookingCancellation,
  apiUpdatePadelGameRecord,
  isTournamentExerciseCategory,
  resolveExerciseCancellationState,
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
import { Advertisement } from "./Advertisement";
import { CommunitiesSectionLoader } from "./CommunitiesSectionLoader";
import { SupportChatWidget } from "./SupportChatWidget";
import {
  BookingCancellationDialog,
  type BookingCancellationExecutionResult,
} from "./BookingCancellationDialog";
import {
  buildSyntheticCabinetGameFromBooking,
  isSyntheticCabinetBookingGame,
} from "./syntheticBookingGame";
import {
  buildUniqueGameLookup,
  resolveUniqueGameForKeys,
} from "./gameBookingLinkResolver";
import { TournamentDetailsModal } from "./TournamentDetailsModal";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { Modal } from "../UI/Modal";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  hasTournamentHostingAccess,
  normalizeLevelGradeLabel,
} from "../../utils/customFields";
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
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import {
  buildReferralSubscriptionUrl,
  hydrateReferralSubscriptionsWithNames,
  resolveReferralRenewalOwnerCandidate,
  resolveReferralSubscriptionWindow,
  resolveReferralShareOwnerCandidate,
} from "../../utils/referralSubscription";
import type { BookingCancellationAction } from "../../utils/bookingCancellation";
import { forceAppRefresh } from "../../utils/forceAppRefresh";
import { consumeCabinetFlashNotice } from "../../utils/cabinetFlashNotice";
import {
  EXERCISE_CATEGORY_OPEN_GAME,
  isExerciseConvertibleToGameFromBooking,
  resolveExerciseCategoryFromValue,
} from "../../utils/exerciseCategory";

const SHOW_COLLECT_FRIENDS_BUTTON = false;
const GROUP_TRAININGS_URL = "https://padlhub.ru/group";
const GAME_FIND_PATH = (PUBLIC_GAME_FIND_PATH || "/finde_game").replace(/\/+$/, "") || "/finde_game";
const REFERRAL_SUBSCRIPTIONS_FETCH_OPTIONS = {
  includeFinished: true,
  size: 100,
};

type QuickAction = {
  icon: string;
  label: string;
  href: string;
};

const QUICK_ACTIONS: QuickAction[] = [
  { icon: "🎾", label: "Играть", href: GAME_FIND_PATH },
  { icon: "👥", label: "Групповые тренировки", href: GROUP_TRAININGS_URL },
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
const ACTIVE_RESULT_WINDOW_LIMIT = 20;
const RESULT_ENTRY_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;
const GAME_REMOVED_STATUS_MARKERS = ["CANCEL", "DELETE", "REMOV", "ARCHIV", "VOID", "MISSING", "NOT_FOUND"] as const;
const GAME_REMOVED_METADATA_FLAGS = [
  "deletedInViva",
  "vivaDeleted",
  "removedFromViva",
  "vivaRemoved",
  "bookingDeleted",
  "bookingRemoved",
  "bookingMissing",
  "exerciseMissing",
  "cancelledInViva",
  "canceledInViva",
] as const;

type ExerciseCancellationCheckState = "active" | "cancelled" | "unknown";

type ExactGameLinkState =
  | { state: "loading" }
  | { state: "none" }
  | { state: "unique"; gameId: string }
  | { state: "ambiguous" }
  | { state: "error" };

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

type GameCancelState = "idle" | "confirm";

type ResultPromptStationModalState = {
  stationTitle: string;
  address: string | null;
  courtTitle: string | null;
  mapUrl: string | null;
};

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

function normalizePlayerRatingLabel(
  value: string | null | undefined,
  numericFallback: number | null = null,
): string | null {
  return normalizeLevelGradeLabel(value, numericFallback);
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

function formatGameResultDateTimeLabel(
  dateValue: string | null | undefined,
  timeFrom: string | null | undefined,
  timeTo: string | null | undefined,
): string {
  const parsed = dateValue ? new Date(`${dateValue}T00:00:00`) : null;
  const dateText = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "Дата уточняется";
  const from = String(timeFrom || "").trim();
  const to = String(timeTo || "").trim();
  if (from && to) return `${dateText}, ${from}—${to}`;
  if (from) return `${dateText}, ${from}`;
  return dateText;
}

function formatGameResultLevelLabel(game: PadelGameRecord): string {
  if (game.settings?.ratingGame === false) return "Без уровня";
  const min = String(game.settings?.minRating || "").trim();
  const max = String(game.settings?.maxRating || "").trim();
  if (min && max) return `от ${min} до ${max}`;
  if (min) return `от ${min}`;
  if (max) return `до ${max}`;
  return "Уровень уточняется";
}

function formatGameResultStationLabel(
  game: PadelGameRecord,
  stationTitle: string,
  locationTitle: string,
): string {
  const fallbackStation = String(locationTitle || "")
    .split("•")[0]
    ?.trim() || "";
  const station = stationTitle || pickStringFromRecord(game.metadata, ["studioName", "stationName"]) || fallbackStation;
  return station || "Станция уточняется";
}

function formatGameResultCourtLabel(
  game: PadelGameRecord,
  courtTitle: string,
  locationTitle: string,
): string {
  const directCourt = String(courtTitle || "").trim();
  if (directCourt) return directCourt;
  const metadataCourt = pickStringFromRecord(game.metadata, ["roomName", "courtName", "courtTitle"]);
  if (metadataCourt) return metadataCourt;
  const fallbackParts = String(locationTitle || "")
    .split("•")
    .map((item) => item.trim())
    .filter(Boolean);
  if (fallbackParts.length > 1) return fallbackParts.slice(1).join(" • ");
  if (fallbackParts.length === 1) return fallbackParts[0];
  return "Корт уточняется";
}

function formatGameResultStationAddress(game: PadelGameRecord): string | null {
  const address = pickStringFromRecord(game.booking, [
    "address",
    "studioAddress",
    "stationAddress",
    "fullAddress",
    "location",
    "street",
  ]) ?? pickStringFromRecord(game.metadata, [
    "address",
    "studioAddress",
    "stationAddress",
    "fullAddress",
    "studioLocation",
    "location",
    "street",
  ]);
  return String(address || "").trim() || null;
}

function getGameResultMapUrl(stationTitle: string, locationTitle: string): string | null {
  const query = [stationTitle, locationTitle]
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== "Станция уточняется" && item !== "Корт уточняется")
    .join(", ");
  return query ? `https://yandex.ru/maps/?text=${encodeURIComponent(query)}` : null;
}

function renderGameResultInfoIcon(type: "date" | "location" | "level") {
  if (type === "date") {
    return (
      <span className="game-created-result-info-icon" aria-hidden="true">
        <svg viewBox="0 0 12 12" focusable="false">
          <path d="M3.2 1.1v1.4M8.8 1.1v1.4M1.5 4.2h9M2.2 2.1h7.6c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.2c-.6 0-1.1-.5-1.1-1.1V3.2c0-.6.5-1.1 1.1-1.1Z" />
        </svg>
      </span>
    );
  }

  if (type === "location") {
    return (
      <span className="game-created-result-info-icon" aria-hidden="true">
        <svg viewBox="0 0 12 12" focusable="false">
          <path d="M6 1.1a3.7 3.7 0 0 0-3.7 3.7c0 2.5 3.1 5.8 3.4 6.1.2.2.4.2.6 0 .3-.3 3.4-3.6 3.4-6.1A3.7 3.7 0 0 0 6 1.1Zm0 5.1a1.4 1.4 0 1 1 0-2.8 1.4 1.4 0 0 1 0 2.8Z" />
        </svg>
      </span>
    );
  }

  return (
    <span className="game-created-result-info-icon" aria-hidden="true">
      <svg viewBox="0 0 12 12" focusable="false">
        <path d="M2 10.7H1.3V6.6H2c.5 0 .8.3.8.8v2.5c0 .4-.3.8-.8.8Zm4.4 0h-.8V4.2h.8c.4 0 .7.4.7.8v4.9c0 .4-.3.8-.7.8Zm4.3 0H10V1.5h.7c.5 0 .8.3.8.8v7.6c0 .4-.3.8-.8.8Z" />
      </svg>
    </span>
  );
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

function isSinglesFormat(value: unknown): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "singles"
    || normalized.includes("1x1")
    || normalized.includes("1х1")
    || normalized.includes("1 на 1");
}

function isSinglesCourtName(value: unknown): boolean {
  return /сингл|single|1\s*[xх]\s*1|1\s*на\s*1/i.test(String(value || ""));
}

function isSinglesGameCard(game: PadelGameRecord): boolean {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (isSinglesFormat(metadata?.gameFormat ?? metadata?.format)) return true;
  const splitPayment = metadata && isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
  const splitShareCount = pickNumberValue(splitPayment, ["shareCount"]);
  if (splitShareCount === 2) return true;
  return [
    game.booking?.roomName,
    pickStringFromRecord(metadata, ["roomName", "courtName", "courtTitle"]),
  ].some((value) => isSinglesCourtName(value));
}

function resolveGameCardPlayersCount(game: PadelGameRecord): number {
  if (isSinglesGameCard(game)) return MAX_SINGLES_PLAYERS;

  const inviteMaxPlayers = game.invite?.maxPlayers;
  if (typeof inviteMaxPlayers === "number" && Number.isFinite(inviteMaxPlayers) && inviteMaxPlayers > 0) {
    return Math.max(1, Math.floor(inviteMaxPlayers));
  }

  const metadata = game.metadata;
  const metadataPlayersLimit = pickNumberValue(isRecord(metadata) ? metadata : null, ["maxPlayers", "playersLimit"]);
  if (metadataPlayersLimit !== null && metadataPlayersLimit > 0) {
    return Math.max(1, Math.floor(metadataPlayersLimit));
  }
  const metadataGameFormat =
    metadata && typeof metadata.gameFormat === "string"
      ? metadata.gameFormat.trim().toLowerCase()
      : "";
  if (isSinglesFormat(metadataGameFormat)) {
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
  if (matchResult) {
    const sets = matchResult.sets;
    if (Array.isArray(sets) && sets.length > 0) return true;
    const status = String(matchResult.status || "").trim();
    if (status || matchResult.submittedAt || matchResult.confirmedAt) {
      return true;
    }
  }

  const topLevelStatus = String(game.resultLifecycleState ?? game.resultStatus ?? "").trim();
  return Boolean(topLevelStatus || game.resultId || game.lastResultAt);
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
      return appendCurrentAuthModeToNavigableUrl(normalized).toString();
    }

    if (!isLocalHostname(parsed.hostname)) {
      return appendCurrentAuthModeToNavigableUrl(parsed).toString();
    }
    const publicOrigin = resolvePublicGamesOrigin(current);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return appendCurrentAuthModeToNavigableUrl(normalized).toString();
  } catch {
    return raw;
  }
}

function resolveQuickActionHref(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "#";
  if (!raw.startsWith("#")) {
    return appendCurrentAuthModeToNavigableUrl(raw).toString();
  }

  try {
    const normalized = new URL(CABINET_URL);
    normalized.hash = raw;
    return appendCurrentAuthModeToNavigableUrl(normalized).toString();
  } catch {
    return raw;
  }
}

function resolveGroupTrainingsHref(value: string): string {
  const raw = value.trim();
  if (!raw) return raw;
  if (typeof window === "undefined") return raw;

  try {
    const current = new URL(window.location.href);
    const parsed = new URL(raw, current.origin);
    const resolvedCabinetUrl = resolvePublicGamesCabinetUrl(current);
    if (resolvedCabinetUrl) {
      parsed.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }
    return appendCurrentAuthModeToNavigableUrl(parsed).toString();
  } catch {
    return raw;
  }
}

function resolvePublicGamesCabinetUrl(current: URL): string | null {
  if (current.pathname.includes("/lk_dev")) {
    return appendCurrentAuthModeToNavigableUrl(new URL("/lk_dev", current.origin)).toString();
  }
  const configured = (CABINET_URL || "").trim();
  return configured ? appendCurrentAuthModeToNavigableUrl(configured).toString() : null;
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
      return appendCurrentAuthModeToNavigableUrl(parsed).toString();
    }
    const publicOrigin = resolvePublicGamesOrigin(current);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return appendCurrentAuthModeToNavigableUrl(normalized).toString();
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
    return appendCurrentAuthModeToNavigableUrl(url).toString();
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

const INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS = [
  "CANCEL",
  "DECLIN",
  "FAIL",
  "ERROR",
  "EXPIRE",
  "REFUND",
  "REJECT",
  "VOID",
  "CLOSE",
  "ARCHIVE",
  "LEFT",
  "REMOV",
] as const;

function normalizeCabinetIdentityId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeCabinetIdentityPhone(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return normalizePhoneForGame(String(value));
}

function isInactiveGameMembershipStatus(value: unknown): boolean {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return false;
  return INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS.some((marker) => status.includes(marker));
}

function getCabinetPlayerIdentityKey(player: PadelGamePlayer): string {
  const id = String(player.id || "").trim();
  if (id) return `id:${id}`;
  const phone = normalizePhoneForGame(player.phone);
  if (phone) return `phone:${phone}`;
  const name = String(player.name || "").trim().toLowerCase();
  return `name:${name}`;
}

function dedupePlayers(players: PadelGamePlayer[]): PadelGamePlayer[] {
  const byKey = new Map<string, PadelGamePlayer>();
  players.forEach((player) => {
    const key = getCabinetPlayerIdentityKey(player);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, player);
      return;
    }
    byKey.set(key, {
      ...existing,
      ...player,
      id: existing.id ?? player.id ?? null,
      phone: existing.phone ?? player.phone ?? null,
      name: existing.name || player.name || "Игрок",
      photo: existing.photo ?? player.photo ?? null,
      rating: existing.rating ?? player.rating ?? null,
      ratingNumeric: existing.ratingNumeric ?? player.ratingNumeric ?? null,
      source: existing.source ?? player.source,
      status: existing.status ?? player.status,
    });
  });
  return Array.from(byKey.values());
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

function pickNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const normalized = pickStringFromUnknown(value);
  if (!normalized) return null;
  const parsed = Number(normalized.replace(",", "."));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
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

function playerMatchesCabinetIdentity(
  player: PadelGamePlayer | null | undefined,
  clientId: string | null,
  phone: string | null,
): boolean {
  if (!player || isInactiveGameMembershipStatus(player.status)) return false;
  const playerId = normalizeCabinetIdentityId(player.id);
  if (clientId && playerId && clientId === playerId) return true;
  const playerPhone = normalizeCabinetIdentityPhone(player.phone);
  return Boolean(phone && playerPhone && phone === playerPhone);
}

function recordListContainsCabinetIdentity(
  value: unknown,
  identity: string | null,
  normalizer: (item: unknown) => string | null,
): boolean {
  if (!identity || !Array.isArray(value)) return false;
  return value.some((item) => normalizer(item) === identity);
}

function splitPaymentItemMatchesCabinetIdentity(
  item: Record<string, unknown>,
  clientId: string | null,
  phone: string | null,
): boolean {
  if (isInactiveGameMembershipStatus(item.status)) return false;
  const itemIds = [item.clientId, item.playerId, item.userId, item.id]
    .map((value) => normalizeCabinetIdentityId(value))
    .filter((value): value is string => Boolean(value));
  if (clientId && itemIds.includes(clientId)) return true;

  const itemPhones = [
    item.clientPhoneNorm,
    item.phoneNorm,
    item.clientPhone,
    item.phone,
    item.phoneNumber,
    item.mobile,
  ]
    .map((value) => normalizeCabinetIdentityPhone(value))
    .filter((value): value is string => Boolean(value));
  return Boolean(phone && itemPhones.includes(phone));
}

function hasActiveSplitPaymentCabinetIdentity(
  game: PadelGameRecord,
  clientId: string | null,
  phone: string | null,
): boolean {
  const splitPayment = getSplitPaymentMetadata(game);
  const payments = Array.isArray(splitPayment?.payments)
    ? splitPayment.payments.filter((item) => isRecord(item))
    : [];
  return payments.some((item) => splitPaymentItemMatchesCabinetIdentity(item, clientId, phone));
}

function isGameRelevantToCabinetIdentity(
  game: PadelGameRecord,
  profileId: string | null | undefined,
  profilePhone: string | null | undefined,
): boolean {
  const clientId = normalizeCabinetIdentityId(profileId);
  const phone = normalizeCabinetIdentityPhone(profilePhone);
  if (!clientId && !phone) return true;

  const organizerId = normalizeCabinetIdentityId(game.organizer?.id);
  if (clientId && organizerId && clientId === organizerId) return true;
  const organizerPhone = normalizeCabinetIdentityPhone(game.organizer?.phone);
  if (phone && organizerPhone && phone === organizerPhone) return true;
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const metadataOrganizerId = normalizeCabinetIdentityId(metadata?.organizerId);
  if (clientId && metadataOrganizerId && clientId === metadataOrganizerId) return true;
  const metadataOrganizerPhone = normalizeCabinetIdentityPhone(
    metadata?.organizerPhoneNorm ?? metadata?.organizerPhone,
  );
  if (phone && metadataOrganizerPhone && phone === metadataOrganizerPhone) return true;

  if ((game.participants ?? []).some((player) => playerMatchesCabinetIdentity(player, clientId, phone))) {
    return true;
  }
  if ((game.waitlist ?? []).some((player) => playerMatchesCabinetIdentity(player, clientId, phone))) {
    return true;
  }

  if (recordListContainsCabinetIdentity(game.participantPhones, phone, normalizeCabinetIdentityPhone)) return true;
  if (recordListContainsCabinetIdentity(game.waitlistPhones, phone, normalizeCabinetIdentityPhone)) return true;
  if (recordListContainsCabinetIdentity(game.invitedPhones, phone, normalizeCabinetIdentityPhone)) return true;
  if (hasActiveSplitPaymentCabinetIdentity(game, clientId, phone)) return true;

  return false;
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

function normalizeBookingLikeId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizePaymentRefLike(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parsePaymentRefsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((item) => normalizePaymentRefLike(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  if (typeof value === "string") {
    return Array.from(new Set(
      value
        .split(",")
        .map((item) => normalizePaymentRefLike(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  return [];
}

function extractPaymentRefFromUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const ref =
      parsed.searchParams.get("phPaymentRef")
      ?? parsed.searchParams.get("paymentRef")
      ?? parsed.searchParams.get("ref");
    return normalizePaymentRefLike(ref);
  } catch {
    const matched = trimmed.match(/[?&](?:phPaymentRef|paymentRef|ref)=([^&#]+)/i);
    if (!matched?.[1]) return null;
    try {
      return normalizePaymentRefLike(decodeURIComponent(matched[1]));
    } catch {
      return normalizePaymentRefLike(matched[1]);
    }
  }
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

function isGameRemovedStatus(value: string | null | undefined): boolean {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return false;
  return GAME_REMOVED_STATUS_MARKERS.some((marker) => status.includes(marker));
}

function isGameMarkedDeletedInViva(game: PadelGameRecord): boolean {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (!metadata) return false;

  return GAME_REMOVED_METADATA_FLAGS.some((key) => {
    const value = metadata[key];
    return value === true || value === "true" || value === 1 || value === "1";
  });
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

  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (metadata) {
    pushMany(metadata.bookingIds);
    push(metadata.bookingId);
    pushMany(metadata.booking_ids);
    push(metadata.booking_id);

    const splitPayment = isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
    if (splitPayment) {
      pushMany(splitPayment.bookingIds);
      push(splitPayment.bookingId);
      pushMany(splitPayment.booking_ids);
      push(splitPayment.booking_id);
      push(splitPayment.organizerBookingId);

      const payments = Array.isArray(splitPayment.payments)
        ? splitPayment.payments.filter((item) => isRecord(item))
        : [];
      payments.forEach((item) => {
        pushMany(item.bookingIds);
        push(item.bookingId);
        pushMany(item.booking_ids);
        push(item.booking_id);
      });
    }
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

function collectGamePaymentRefs(game: PadelGameRecord): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizePaymentRefLike(value);
    if (normalized) bucket.add(normalized);
  };
  const pushMany = (value: unknown) => {
    parsePaymentRefsFromUnknown(value).forEach((item) => bucket.add(item));
  };

  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (metadata) {
    push(metadata.paymentRef);
    const splitPayment = isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
    if (splitPayment) {
      push(splitPayment.paymentRef);
      const payments = Array.isArray(splitPayment.payments)
        ? splitPayment.payments.filter((item) => isRecord(item))
        : [];
      payments.forEach((item) => {
        push(item.paymentRef);
      });
    }
  }

  const gameAny = game as unknown as Record<string, unknown>;
  push(gameAny.paymentRef);
  if (isRecord(gameAny.payment)) {
    push(gameAny.payment.paymentRef);
    pushMany(gameAny.payment.paymentRefs);
    push(extractPaymentRefFromUrl(gameAny.payment.paymentUrl));
    push(extractPaymentRefFromUrl(gameAny.payment.redirectUrl));
    push(extractPaymentRefFromUrl(gameAny.payment.baseRedirectUrl));
  }

  return Array.from(bucket);
}

function collectBookingPaymentRefs(booking: Booking): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizePaymentRefLike(value);
    if (normalized) bucket.add(normalized);
  };

  const bookingAny = booking as unknown as Record<string, unknown>;
  push(bookingAny.paymentRef);
  push(bookingAny.phPaymentRef);

  if (isRecord(bookingAny.transactionStatus)) {
    push(bookingAny.transactionStatus.paymentRef);
    push(bookingAny.transactionStatus.transactionRef);
    push(bookingAny.transactionStatus.transactionId);
    if (isRecord(bookingAny.transactionStatus.cardPaymentStatus)) {
      push(bookingAny.transactionStatus.cardPaymentStatus.paymentRef);
      push(bookingAny.transactionStatus.cardPaymentStatus.paymentId);
      push(bookingAny.transactionStatus.cardPaymentStatus.transactionId);
      push(extractPaymentRefFromUrl(bookingAny.transactionStatus.cardPaymentStatus.paymentUrl));
      push(extractPaymentRefFromUrl(bookingAny.transactionStatus.cardPaymentStatus.redirectUrl));
    }
  }

  if (isRecord(bookingAny.payment)) {
    push(bookingAny.payment.paymentRef);
    push(bookingAny.payment.ref);
    push(extractPaymentRefFromUrl(bookingAny.payment.paymentUrl));
    push(extractPaymentRefFromUrl(bookingAny.payment.redirectUrl));
  }

  return Array.from(bucket);
}

function collectGameExerciseIds(game: PadelGameRecord): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingLikeId(value);
    if (normalized) bucket.add(normalized);
  };

  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (metadata) {
    push(metadata.exerciseId);
    push(metadata.exercise_id);
    push(metadata.vivaExerciseId);
    push(metadata.viva_exercise_id);

    const splitPayment = isRecord(metadata.splitPayment) ? metadata.splitPayment : null;
    if (splitPayment) {
      push(splitPayment.exerciseId);
      push(splitPayment.exercise_id);
      push(splitPayment.vivaExerciseId);
      push(splitPayment.viva_exercise_id);
    }
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

function extractRoomNumberKey(value: unknown): string | null {
  const normalized = normalizeSlotName(value);
  if (!normalized) return null;
  const matched = normalized.match(/\d+/);
  return matched?.[0] ?? null;
}

function buildGameLooseSlotKey(game: PadelGameRecord): string | null {
  const date = toBookingDateKey(game.booking?.date ?? null);
  const timeFrom = toBookingTimeKey(game.booking?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(game.booking?.timeTo ?? null);
  const studioName = normalizeSlotName(game.booking?.studioName ?? null);
  const roomNumber = extractRoomNumberKey(game.booking?.roomName ?? null);
  if (!date || !timeFrom || !timeTo || !studioName || !roomNumber) return null;
  return [date, timeFrom, timeTo, studioName, roomNumber].join("|");
}

function buildBookingLooseSlotKey(booking: Booking): string | null {
  const date = toBookingDateKey(booking.exercise?.timeFrom ?? null);
  const timeFrom = toBookingTimeKey(booking.exercise?.timeFrom ?? null);
  const timeTo = toBookingTimeKey(booking.exercise?.timeTo ?? null);
  const studioName = normalizeSlotName(booking.exercise?.studio?.name ?? null);
  const roomNumber = extractRoomNumberKey(booking.exercise?.room?.name ?? null);
  if (!date || !timeFrom || !timeTo || !studioName || !roomNumber) return null;
  return [date, timeFrom, timeTo, studioName, roomNumber].join("|");
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

  if (isTournamentExerciseCategory(booking.exercise)) {
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
  const [referralUserSubscriptions, setReferralUserSubscriptions] = useState<SubscriptionResponse | null>(null);
  const [referralSubscriptionNamesById, setReferralSubscriptionNamesById] = useState<Record<string, string>>({});
  const [referralInviteUrlByKey, setReferralInviteUrlByKey] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isRefreshingApp, setIsRefreshingApp] = useState(false);
  const [isBookingHistoryOpen, setIsBookingHistoryOpen] = useState(false);
  const [isSubscriptionInfoOpen, SetSubscriptionInfoOpen] = useState(false);
  const [currenSub, SetCurrenSub] = useState<Subscription | null>(null);
  const [currenSubName, SetCurrenSubName] = useState<string>("Абонемент");
  const [createdGames, setCreatedGames] = useState<PadelGameRecord[]>([]);
  const [exactGameLinkStateByBookingId, setExactGameLinkStateByBookingId] = useState<
    Record<string, ExactGameLinkState>
  >({});
  const [loadingCreatedGames, setLoadingCreatedGames] = useState(false);
  const [createdGamesError, setCreatedGamesError] = useState<string | null>(null);
  const [cabinetFlashNotice] = useState<string | null>(() => consumeCabinetFlashNotice());
  const [activeGameRecordsTotal, setActiveGameRecordsTotal] = useState(0);
  const [hasLoadedAllActiveRecords, setHasLoadedAllActiveRecords] = useState(false);
  const [loadingMoreActiveRecords, setLoadingMoreActiveRecords] = useState(false);
  const [customTournaments, setCustomTournaments] = useState<TournamentHistoryRecord[]>([]);
  const [selectedTournamentBooking, setSelectedTournamentBooking] = useState<Booking | null>(null);
  const [copiedGameInviteId, setCopiedGameInviteId] = useState<string | null>(null);
  const [, setChatReadMap] = useState<Record<string, number>>({});
  const [chatUnreadByGame, setChatUnreadByGame] = useState<Record<string, number>>({});
  const [gameCancelStateById, setGameCancelStateById] = useState<Record<string, GameCancelState>>({});
  const [cancellingGameId, setCancellingGameId] = useState<string | null>(null);
  const [archivingGameId, setArchivingGameId] = useState<string | null>(null);
  const [archiveGameErrorById, setArchiveGameErrorById] = useState<Record<string, string>>({});
  const [resultPromptStationModal, setResultPromptStationModal] = useState<ResultPromptStationModalState | null>(null);
  const cabinetVisitTrackedRef = useRef(false);
  const onboardingStatusRef = useRef<boolean | null>(null);
  const cancellingGameIdsRef = useRef<Set<string>>(new Set());
  const exactGameLinkLookupBookingIdsRef = useRef<Set<string>>(new Set());
  const historyPrefetchAttemptedRef = useRef(false);
  const historyBookingsRequestRef = useRef<Promise<BookingsResponse | null> | null>(null);
  const exerciseCancellationCheckRef = useRef<Map<string, Promise<ExerciseCancellationCheckState>>>(new Map());
  const referralSubscriptionNamesRequestRef = useRef(0);
  const referralInviteRequestRef = useRef(0);
  const { logout } = useAuth();

  const activeBookingExerciseIds = useMemo(() => {
    const ids = new Set<string>();
    (activeBookings?.content ?? []).forEach((booking) => {
      if (booking.isCancelled) return;
      collectBookingExerciseIds(booking).forEach((exerciseId) => ids.add(exerciseId));
    });
    return Array.from(ids).sort();
  }, [activeBookings?.content]);

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
      setReferralUserSubscriptions(null);
      historyBookingsRequestRef.current = null;
      try {
        const [profileRes, activeRes, subsRes, referralSubsRes] = await Promise.all([
          apiFetchProfile(),
          apiFetchBookings(false),
          apiFetchSubscriptions(),
          apiFetchSubscriptions(REFERRAL_SUBSCRIPTIONS_FETCH_OPTIONS),
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
        setReferralUserSubscriptions(referralSubsRes?.data || subsRes?.data || null);
        trackAnalyticsEvent("cabinet_data_loaded", {
          activeBookingsCount: activeRes?.data?.content?.length ?? 0,
          historyBookingsLoaded: false,
          subscriptionsCount: subsRes?.data?.content?.length ?? 0,
          referralSubscriptionsCount: referralSubsRes?.data?.content?.length ?? 0,
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

  const referralSubscriptionSource = useMemo(() => {
    const finishedAwareContent = referralUserSubscriptions?.content;
    if (Array.isArray(finishedAwareContent) && finishedAwareContent.length > 0) {
      return finishedAwareContent;
    }
    return Array.isArray(userSubscriptions?.content) ? userSubscriptions.content : [];
  }, [referralUserSubscriptions?.content, userSubscriptions?.content]);

  useEffect(() => {
    const phone = pickStringFromUnknown(profile?.phone);
    const subscriptions = referralSubscriptionSource;

    if (!phone || subscriptions.length === 0) {
      setReferralSubscriptionNamesById((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    const nowMs = Date.now();
    const pending = subscriptions
      .map((subscription) => {
        const subscriptionId = pickStringFromUnknown(subscription.subscriptionId);
        if (!subscriptionId || pickStringFromUnknown(subscription.name)) return null;
        const window = resolveReferralSubscriptionWindow(subscription.expirationDate);
        const renewalWindowEndsAt = window ? Date.parse(window.renewalWindowEndsAt) : NaN;
        if (!Number.isFinite(renewalWindowEndsAt) || nowMs >= renewalWindowEndsAt) return null;
        if (pickStringFromUnknown(referralSubscriptionNamesById[subscriptionId])) return null;
        return subscriptionId;
      })
      .filter((subscriptionId): subscriptionId is string => Boolean(subscriptionId));

    if (pending.length === 0) return;

    let cancelled = false;
    const requestId = referralSubscriptionNamesRequestRef.current + 1;
    referralSubscriptionNamesRequestRef.current = requestId;

    void (async () => {
      try {
        const names = await Promise.all(
          pending.map(async (subscriptionId) => {
            const response = await apiFetchSubscriptioName(subscriptionId, phone);
            const resolvedName = pickStringFromUnknown(response.data?.sertName);
            if (!resolvedName) return null;
            return { subscriptionId, resolvedName };
          }),
        );

        if (cancelled || referralSubscriptionNamesRequestRef.current !== requestId) return;

        setReferralSubscriptionNamesById((current) => {
          let changed = false;
          const next = { ...current };

          names.forEach((entry) => {
            if (!entry || next[entry.subscriptionId] === entry.resolvedName) return;
            next[entry.subscriptionId] = entry.resolvedName;
            changed = true;
          });

          return changed ? next : current;
        });
      } catch {
        // Ignore missing-name lookup errors; referral CTA stays hidden until a name is available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [profile?.phone, referralSubscriptionNamesById, referralSubscriptionSource]);

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
      const relevantRecords = records.filter((record) => (
        isGameRelevantToCabinetIdentity(record, profile?.id ?? null, profile?.phone ?? null)
      ));
      const removedRecordIds = new Set(
        records
          .filter((record) => !relevantRecords.some((item) => item.id === record.id))
          .map((record) => record.id),
      );
      setCreatedGames((prev) => (
        mergeCabinetGameRecords(prev, relevantRecords)
          .filter((record) => !removedRecordIds.has(record.id))
      ));
      setCreatedGamesError(null);
    };

    window.addEventListener("lk-games-updated", handler);
    return () => {
      window.removeEventListener("lk-games-updated", handler);
    };
  }, [profile?.id, profile?.phone]);

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
        const mergedGames = mergeCabinetGameRecords(activeGames, resultWindowGames)
          .filter((game) => isGameRelevantToCabinetIdentity(game, profile?.id ?? null, profile?.phone ?? null));
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
        setCreatedGames(
          gamesResult.data.games.filter((game) => (
            isGameRelevantToCabinetIdentity(game, profile?.id ?? null, profile?.phone ?? null)
          )),
        );
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
  const currentUserSyntheticPlayer = useMemo<PadelGamePlayer | null>(() => {
    const fullName = [profile?.firstName, profile?.lastName].filter(Boolean).join(" ").trim();
    if (!profile?.id && !profilePhoneNorm && !fullName) return null;
    return {
      id: profile?.id ?? null,
      name: fullName || "Игрок",
      phone: profilePhoneNorm ?? null,
      photo: profile?.photo ?? null,
      rating: null,
      ratingNumeric: null,
      source: "MANUAL_PHONE",
      status: "CONFIRMED",
    };
  }, [profile?.firstName, profile?.id, profile?.lastName, profile?.photo, profilePhoneNorm]);

  useEffect(() => {
    exactGameLinkLookupBookingIdsRef.current.clear();
    setExactGameLinkStateByBookingId({});
    historyPrefetchAttemptedRef.current = false;
  }, [profile?.id, profile?.phone]);

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
    }, 20000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [createdGames, profilePhoneNorm]);

  const gameByBookingId = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      collectGameBookingIds,
    );
  }, [createdGames]);
  const gameBySlotKey = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      (game) => [buildGameSlotKey(game)],
    );
  }, [createdGames]);
  const gameByExerciseId = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      collectGameExerciseIds,
    );
  }, [createdGames]);
  const gameByPaymentRef = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      collectGamePaymentRefs,
    );
  }, [createdGames]);
  const gameBySlotIdKey = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      (game) => [buildGameSlotIdKey(game)],
    );
  }, [createdGames]);
  const gameByLooseSlotKey = useMemo(() => {
    return buildUniqueGameLookup(
      createdGames.filter((game) => game && !isGameCancelledStatus(game.status)),
      (game) => [buildGameLooseSlotKey(game)],
    );
  }, [createdGames]);
  const resolveGameLinkForBooking = useCallback((booking: Booking): {
    game: PadelGameRecord | null;
    ambiguous: boolean;
  } => {
    const asLinkResult = (match: { matched: boolean; value: PadelGameRecord | null }) => ({
      game: match.value,
      ambiguous: match.matched && !match.value,
    });
    const bookingId = normalizeBookingLikeId(booking.id);
    if (bookingId) {
      const byId = resolveUniqueGameForKeys(gameByBookingId, [bookingId]);
      if (byId.matched) return asLinkResult(byId);
    }
    const byPaymentRef = resolveUniqueGameForKeys(gameByPaymentRef, collectBookingPaymentRefs(booking));
    if (byPaymentRef.matched) return asLinkResult(byPaymentRef);
    const byExerciseId = resolveUniqueGameForKeys(gameByExerciseId, collectBookingExerciseIds(booking));
    if (byExerciseId.matched) return asLinkResult(byExerciseId);
    const slotIdKey = buildBookingSlotIdKey(booking);
    if (slotIdKey) {
      const bySlotIdKey = resolveUniqueGameForKeys(gameBySlotIdKey, [slotIdKey]);
      if (bySlotIdKey.matched) return asLinkResult(bySlotIdKey);
    }
    const slotKey = buildBookingSlotKey(booking);
    if (slotKey) {
      const bySlotKey = resolveUniqueGameForKeys(gameBySlotKey, [slotKey]);
      if (bySlotKey.matched) return asLinkResult(bySlotKey);
    }
    const looseSlotKey = buildBookingLooseSlotKey(booking);
    if (!looseSlotKey) return { game: null, ambiguous: false };
    const byLooseSlotKey = resolveUniqueGameForKeys(gameByLooseSlotKey, [looseSlotKey]);
    return byLooseSlotKey.matched
      ? asLinkResult(byLooseSlotKey)
      : { game: null, ambiguous: false };
  }, [gameByBookingId, gameByExerciseId, gameByLooseSlotKey, gameByPaymentRef, gameBySlotIdKey, gameBySlotKey]);
  const resolveGameForBooking = useCallback(
    (booking: Booking): PadelGameRecord | null => resolveGameLinkForBooking(booking).game,
    [resolveGameLinkForBooking],
  );
  const isGameLinkAmbiguousForBooking = useCallback(
    (booking: Booking): boolean => resolveGameLinkForBooking(booking).ambiguous,
    [resolveGameLinkForBooking],
  );
  const resolveCancellationGameLink = useCallback((booking: Booking): {
    gameId: string | null;
    blocked: boolean;
  } => {
    const bookingId = normalizeBookingLikeId(booking.id);
    if (!bookingId) return { gameId: null, blocked: true };
    const exactState = exactGameLinkStateByBookingId[bookingId];
    if (exactState?.state === "none") return { gameId: null, blocked: false };
    if (exactState?.state !== "unique") return { gameId: null, blocked: true };
    const game = createdGames.find((item) => (
      item.id === exactState.gameId
      && item.archived !== true
      && !isGameCancelledStatus(item.status)
    ));
    return game
      ? { gameId: game.id, blocked: false }
      : { gameId: null, blocked: true };
  }, [createdGames, exactGameLinkStateByBookingId]);
  const executeBookingCancellation = useCallback(async (
    booking: Booking,
    action: BookingCancellationAction,
  ): Promise<BookingCancellationExecutionResult> => {
    const bookingId = normalizeBookingLikeId(booking.id);
    if (!bookingId) {
      return { ok: false, message: "Не удалось определить запись для безопасной отмены" };
    }

    // The cached lookup is display-only. Re-read every exact reference at the
    // mutation boundary so a newly linked game cannot be bypassed by a stale
    // earlier `none` result.
    const paymentRefs = collectBookingPaymentRefs(booking);
    const exactResult = await apiFetchPadelGamesByBookingReferences(paymentRefs, [bookingId]);
    if (exactResult.error || !exactResult.data?.complete) {
      return {
        ok: false,
        message: "Не удалось безопасно подтвердить связь записи с игрой. Отмена остановлена — повторите позже.",
      };
    }
    const bookingRefs = new Set([bookingId]);
    const paymentRefSet = new Set(paymentRefs);
    const activeLinkedGames = exactResult.data.games.filter((game) => {
      if (game.archived === true || isGameCancelledStatus(game.status)) return false;
      return collectGameBookingIds(game).some((id) => bookingRefs.has(id))
        || collectGamePaymentRefs(game).some((ref) => paymentRefSet.has(ref));
    });
    if (activeLinkedGames.length > 1) {
      return {
        ok: false,
        message: "Найдено несколько игр для одной записи. Отмена остановлена — обратитесь в поддержку.",
      };
    }
    if (activeLinkedGames.length === 1) {
      const leaveResult = await apiLeavePadelGameAsCurrentUser(activeLinkedGames[0].id, {
        refundMethod: action.refundMethod,
      });
      if (leaveResult.error || !leaveResult.data) {
        return {
          ok: false,
          message: leaveResult.error?.message || "Не удалось покинуть игру",
        };
      }
      if (leaveResult.data.state === "RETRY_REQUIRED" || leaveResult.data.state === "IN_PROGRESS") {
        return {
          ok: true,
          state: "RETRY_REQUIRED",
          message: leaveResult.data.message
            || "Бронирование отменено, обновляем состав игры. Это может занять несколько минут.",
        };
      }
      if (leaveResult.data.state !== "DONE") {
        return {
          ok: false,
          message: leaveResult.data.message || "Не удалось подтвердить выход из игры",
        };
      }
      if (action.id === "subscription") {
        const releaseResult = await apiReleaseSubscriptionBookingClaim(bookingId);
        if (releaseResult.error || releaseResult.data?.state !== "RELEASED") {
          return {
            ok: false,
            message: "Запись отменена в Viva, но дневной лимит ещё не синхронизирован. Повторите позже.",
          };
        }
      }
      return { ok: true, state: "DONE", message: action.successMessage };
    }

    // Game-like bookings are never cancelled directly in Viva: a game may be
    // linked concurrently just after the exact lookup. The server leave saga is
    // the only allowed mutation path for that category.
    if (isExerciseConvertibleToGameFromBooking(booking)) {
      return {
        ok: false,
        message: "Для игровой записи не удалось подтвердить серверную игру. Отмена остановлена — обновите список и повторите.",
      };
    }

    const response = await apiCancelBooking(bookingId, action);
    const accepted = response.status !== null && response.status >= 200 && response.status < 300;
    const verifiableConflict = response.status !== null
      && [400, 404, 409, 422].includes(response.status);
    if (!accepted && !verifiableConflict) {
      return {
        ok: false,
        message: response.error?.message || "Не удалось отменить запись",
      };
    }
    const verification = await apiVerifyBookingCancellation(bookingId);
    const cancelled = !verification.error && verification.data?.state === "cancelled";
    if (cancelled && action.id === "subscription") {
      const releaseResult = await apiReleaseSubscriptionBookingClaim(bookingId);
      if (releaseResult.error || releaseResult.data?.state !== "RELEASED") {
        return {
          ok: false,
          message: "Запись отменена в Viva, но дневной лимит ещё не синхронизирован. Повторите позже.",
        };
      }
    }
    return {
      ok: cancelled,
      state: cancelled ? "DONE" : undefined,
      message: cancelled
        ? action.successMessage
        : (verification.error?.message || "Не удалось подтвердить отмену записи"),
    };
  }, []);
  const resolveCancelledGameForBooking = useCallback((booking: Booking): PadelGameRecord | null => {
    const bookingId = normalizeBookingLikeId(booking.id);
    if (bookingId) {
      const byId = resolveUniqueGameForKeys(gameByBookingId, [bookingId]);
      if (byId.matched) return byId.value;
    }
    const byPaymentRef = resolveUniqueGameForKeys(gameByPaymentRef, collectBookingPaymentRefs(booking));
    if (byPaymentRef.matched) return byPaymentRef.value;
    const byExerciseId = resolveUniqueGameForKeys(gameByExerciseId, collectBookingExerciseIds(booking));
    if (byExerciseId.matched) return byExerciseId.value;
    return null;
  }, [gameByBookingId, gameByExerciseId, gameByPaymentRef]);
  const resolveDisplayGameForBooking = useCallback((booking: Booking): PadelGameRecord | null => {
    const linkedGame = resolveGameForBooking(booking);
    if (linkedGame) return linkedGame;

    if (resolveExerciseCategoryFromValue(booking) !== EXERCISE_CATEGORY_OPEN_GAME) return null;

    return buildSyntheticCabinetGameFromBooking(booking, {
      paid: resolveBookingPaidState(booking),
      currentUserPlayer: currentUserSyntheticPlayer,
    });
  }, [currentUserSyntheticPlayer, resolveGameForBooking]);
  const checkExerciseCancellationState = useCallback((exerciseId: string): Promise<ExerciseCancellationCheckState> => {
    const normalizedExerciseId = normalizeBookingLikeId(exerciseId);
    if (!normalizedExerciseId) return Promise.resolve("unknown");

    const cached = exerciseCancellationCheckRef.current.get(normalizedExerciseId);
    if (cached) return cached;

    const next = apiFetchExerciseById(normalizedExerciseId)
      .then((result) => {
        const state = resolveExerciseCancellationState(result.data);
        if (state === true) return "cancelled" as const;
        if (state === false) return "active" as const;
        return "unknown" as const;
      })
      .catch(() => "unknown" as const);

    exerciseCancellationCheckRef.current.set(normalizedExerciseId, next);
    return next;
  }, []);
  const resolveGameExerciseCancellationState = useCallback(async (
    game: PadelGameRecord,
  ): Promise<ExerciseCancellationCheckState> => {
    const exerciseIds = collectGameExerciseIds(game);
    if (exerciseIds.length === 0) return "unknown";

    let hasUnknown = false;
    for (const exerciseId of exerciseIds) {
      const state = await checkExerciseCancellationState(exerciseId);
      if (state === "active") return "active";
      if (state === "unknown") hasUnknown = true;
    }

    return hasUnknown ? "unknown" : "cancelled";
  }, [checkExerciseCancellationState]);

  useEffect(() => {
    if (!profile?.phone) return;
    if (historyPrefetchAttemptedRef.current) return;
    if (historyBookings !== null || loadingHistoryBookings || historyBookingsRequestRef.current) return;
    if (createdGames.length === 0) return;

    const hasActiveCandidates = createdGames.some((game) => (
      !isGameCancelledStatus(game.status)
      && !isGameRemovedStatus(game.status)
    ));
    if (!hasActiveCandidates) return;

    historyPrefetchAttemptedRef.current = true;
    void loadHistoryBookings();
  }, [
    createdGames,
    historyBookings,
    loadHistoryBookings,
    loadingHistoryBookings,
    profile?.phone,
  ]);
  const hasTeamGameForBooking = useCallback((booking: Booking): boolean => {
    return Boolean(
      resolveGameForBooking(booking)
      || isGameLinkAmbiguousForBooking(booking),
    );
  }, [isGameLinkAmbiguousForBooking, resolveGameForBooking]);

  useEffect(() => {
    const bookings = activeBookings?.content ?? [];
    if (bookings.length === 0 || !profile?.phone) {
      exactGameLinkLookupBookingIdsRef.current.clear();
      setExactGameLinkStateByBookingId((current) => (
        Object.keys(current).length === 0 ? current : {}
      ));
      return;
    }

    const lookupBookingIds = exactGameLinkLookupBookingIdsRef.current;
    const currentBookingIds = new Set(
      bookings
        .map((booking) => normalizeBookingLikeId(booking.id))
        .filter((value): value is string => Boolean(value)),
    );
    lookupBookingIds.forEach((bookingId) => {
      if (!currentBookingIds.has(bookingId)) {
        lookupBookingIds.delete(bookingId);
      }
    });
    setExactGameLinkStateByBookingId((current) => {
      const entries = Object.entries(current);
      const nextEntries = entries.filter(([bookingId]) => currentBookingIds.has(bookingId));
      return nextEntries.length === entries.length ? current : Object.fromEntries(nextEntries);
    });

    const exactBookingLookups = bookings
      .filter((booking) => !booking.isCancelled)
      .map((booking) => ({
        booking,
        bookingId: normalizeBookingLikeId(booking.id),
      }))
      .filter((entry): entry is { booking: Booking; bookingId: string } => Boolean(entry.bookingId))
      .filter((entry) => !lookupBookingIds.has(entry.bookingId))
      .map((entry) => ({
        booking: entry.booking,
        bookingId: entry.bookingId,
        paymentRefs: collectBookingPaymentRefs(entry.booking),
      }));

    if (exactBookingLookups.length === 0) return;
    exactBookingLookups.forEach(({ bookingId }) => {
      lookupBookingIds.add(bookingId);
    });
    setExactGameLinkStateByBookingId((current) => ({
      ...current,
      ...Object.fromEntries(exactBookingLookups.map(({ bookingId }) => [bookingId, { state: "loading" }])),
    }));

    let cancelled = false;
    void Promise.allSettled(
      exactBookingLookups.map(({ bookingId, paymentRefs }) => (
        apiFetchPadelGamesByBookingReferences(paymentRefs, [bookingId])
      )),
    ).then((results) => {
      if (cancelled) return;
      const nextStates: Record<string, ExactGameLinkState> = {};
      const recoveredGames: PadelGameRecord[] = [];
      results.forEach((result, index) => {
        const lookup = exactBookingLookups[index];
        if (!lookup) return;
        if (
          result.status !== "fulfilled"
          || result.value.error
          || !result.value.data?.complete
        ) {
          nextStates[lookup.bookingId] = { state: "error" };
          return;
        }
        const bookingRefs = new Set([lookup.bookingId]);
        const paymentRefs = new Set(collectBookingPaymentRefs(lookup.booking));
        const exactActiveCandidates = result.value.data.games.filter((game) => {
          if (game.archived === true || isGameCancelledStatus(game.status)) return false;
          const bookingMatch = collectGameBookingIds(game).some((id) => bookingRefs.has(id));
          const paymentMatch = collectGamePaymentRefs(game).some((ref) => paymentRefs.has(ref));
          return bookingMatch || paymentMatch;
        });
        recoveredGames.push(...exactActiveCandidates);
        if (exactActiveCandidates.length === 0) {
          nextStates[lookup.bookingId] = { state: "none" };
        } else if (exactActiveCandidates.length === 1) {
          nextStates[lookup.bookingId] = {
            state: "unique",
            gameId: exactActiveCandidates[0].id,
          };
        } else {
          nextStates[lookup.bookingId] = { state: "ambiguous" };
        }
      });
      setExactGameLinkStateByBookingId((current) => ({ ...current, ...nextStates }));
      if (recoveredGames.length > 0) {
        setCreatedGames((prev) => mergeCabinetGameRecords(prev, recoveredGames));
      }
    });

    return () => {
      cancelled = true;
      exactBookingLookups.forEach(({ bookingId }) => {
        lookupBookingIds.delete(bookingId);
      });
    };
  }, [activeBookings?.content, profile?.phone]);

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
  useEffect(() => {
    if (createdGames.length === 0 || allBookings.length === 0) return;

    const activeLinkedGameIds = new Set<string>();
    allBookings.forEach((booking) => {
      if (booking.isCancelled) return;
      const linkedGame = resolveGameForBooking(booking);
      if (linkedGame?.id) {
        activeLinkedGameIds.add(linkedGame.id);
      }
    });

    const cancelledGameCandidates = new Map<string, PadelGameRecord>();
    allBookings.forEach((booking) => {
      if (!booking.isCancelled) return;
      const game = resolveCancelledGameForBooking(booking);
      if (game?.id) {
        if (activeLinkedGameIds.has(game.id)) return;
        cancelledGameCandidates.set(game.id, game);
      }
    });

    if (cancelledGameCandidates.size === 0) return;

    let alive = true;
    void (async () => {
      const cancelledGameIds = new Set<string>();
      for (const [gameId, game] of cancelledGameCandidates) {
        const exerciseIds = collectGameExerciseIds(game);
        if (exerciseIds.length > 0) {
          const exerciseState = await resolveGameExerciseCancellationState(game);
          if (!alive) return;
          if (exerciseState !== "cancelled") continue;
        }
        cancelledGameIds.add(gameId);
      }

      if (!alive || cancelledGameIds.size === 0) return;

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

      await Promise.all(gameIdsToPersist.map(async (gameId) => {
        const result = await apiUpdatePadelGameRecord(gameId, { status: "CANCELLED" });
        if (!alive) return;
        if (result.data?.id) {
          setCreatedGames((prev) => prev.map((game) => (
            game.id === result.data?.id ? (result.data as PadelGameRecord) : game
          )));
          return;
        }
        cancellingGameIdsRef.current.delete(gameId);
      }));
    })();

    return () => {
      alive = false;
    };
  }, [
    allBookings,
    createdGames.length,
    resolveCancelledGameForBooking,
    resolveGameExerciseCancellationState,
    resolveGameForBooking,
  ]);
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
  useEffect(() => {
    if (!selectedTournamentBooking || !isTournamentBookingCandidate(selectedTournamentBooking)) {
      return;
    }

    const missingExerciseIds = collectBookingExerciseIds(selectedTournamentBooking)
      .filter((exerciseId, index, array) => array.indexOf(exerciseId) === index)
      .filter((exerciseId) => !tournamentByExerciseId.has(exerciseId));

    if (missingExerciseIds.length === 0) {
      return;
    }

    let alive = true;
    void Promise.all(
      missingExerciseIds.map(async (exerciseId) => {
        const result = await apiFetchTournamentHistory(exerciseId);
        return Array.isArray(result.data) ? result.data : [];
      }),
    ).then((results) => {
      if (!alive) return;
      setCustomTournaments((current) => {
        const next = new Map<string, TournamentHistoryRecord>();
        current.forEach((record) => {
          const normalizedTournamentId = normalizeBookingLikeId(record.tournamentId);
          if (!normalizedTournamentId || next.has(normalizedTournamentId)) return;
          next.set(normalizedTournamentId, record);
        });
        results.flat().forEach((record) => {
          const normalizedTournamentId = normalizeBookingLikeId(record.tournamentId);
          if (!normalizedTournamentId || next.has(normalizedTournamentId)) return;
          next.set(normalizedTournamentId, record);
        });
        return Array.from(next.values());
      });
    }).catch(() => {
      // Tournament details can stay on booking fallback data when history is temporarily unavailable.
    });

    return () => {
      alive = false;
    };
  }, [selectedTournamentBooking, tournamentByExerciseId]);
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

  const referralSubscriptions = useMemo(
    () => hydrateReferralSubscriptionsWithNames(referralSubscriptionSource, referralSubscriptionNamesById),
    [referralSubscriptionNamesById, referralSubscriptionSource],
  );
  const shouldShowReferralHeaderCtas = useMemo(() => {
    if (typeof window === "undefined") return IS_DEV_RELEASE_CHANNEL;
    const pathname = window.location.pathname.replace(/\/+$/, "");
    return (
      pathname.includes("/lk_dev")
      || pathname === "/lk"
      || pathname.startsWith("/lk/")
      || pathname === "/lk_new"
      || pathname.startsWith("/lk_new/")
    );
  }, []);
  const shareOwnerCandidate = useMemo(
    () => (
      shouldShowReferralHeaderCtas
        ? resolveReferralShareOwnerCandidate(referralSubscriptions, profile?.phone ?? null)
        : null
    ),
    [profile?.phone, referralSubscriptions, shouldShowReferralHeaderCtas],
  );
  const renewalOwnerCandidate = useMemo(
    () => (
      shouldShowReferralHeaderCtas
        ? resolveReferralRenewalOwnerCandidate(referralSubscriptions, profile?.phone ?? null)
        : null
    ),
    [profile?.phone, referralSubscriptions, shouldShowReferralHeaderCtas],
  );
  useEffect(() => {
    const phone = profile?.phone?.trim() || "";
    const targets = [
      shareOwnerCandidate ? { candidate: shareOwnerCandidate, mode: "share" as const } : null,
      renewalOwnerCandidate ? { candidate: renewalOwnerCandidate, mode: "renewal" as const } : null,
    ].filter((entry): entry is { candidate: NonNullable<typeof shareOwnerCandidate>; mode: "share" | "renewal" } => Boolean(entry));

    if (!phone || targets.length === 0) {
      setReferralInviteUrlByKey((current) => (Object.keys(current).length > 0 ? {} : current));
      return;
    }

    const pending = targets.filter(({ candidate, mode }) => {
      const key = `${mode}:${candidate.subscriptionId}`;
      return !referralInviteUrlByKey[key];
    });
    if (pending.length === 0) return;

    let cancelled = false;
    const requestId = referralInviteRequestRef.current + 1;
    referralInviteRequestRef.current = requestId;

    void (async () => {
      const resolvedEntries = await Promise.all(
        pending.map(async ({ candidate, mode }) => {
          const result = await apiCreateReferralSubscriptionInvite({
            ownerPhone: phone,
            ownerSubscriptionId: candidate.subscriptionId,
            mode,
          });
          const inviteId = result.data?.inviteId || null;
          const url = buildReferralSubscriptionUrl(inviteId, mode, {
            ownerPhone: phone,
            ownerSubscriptionId: candidate.subscriptionId,
          });
          return url ? { key: `${mode}:${candidate.subscriptionId}`, url } : null;
        }),
      );

      if (cancelled || referralInviteRequestRef.current !== requestId) return;

      setReferralInviteUrlByKey((current) => {
        let changed = false;
        const next = { ...current };

        resolvedEntries.forEach((entry) => {
          if (!entry || next[entry.key] === entry.url) return;
          next[entry.key] = entry.url;
          changed = true;
        });

        return changed ? next : current;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [profile?.phone, referralInviteUrlByKey, renewalOwnerCandidate, shareOwnerCandidate]);
  const shareOffer = useMemo(() => {
    if (!shouldShowReferralHeaderCtas) return null;
    if (!shareOwnerCandidate) return null;
    const url = referralInviteUrlByKey[`share:${shareOwnerCandidate.subscriptionId}`] || null;
    if (!url) return null;

    return {
      subscriptionName: shareOwnerCandidate.subscriptionName,
      url,
    };
  }, [referralInviteUrlByKey, shareOwnerCandidate, shouldShowReferralHeaderCtas]);
  const renewalOffer = useMemo(() => {
    if (!shouldShowReferralHeaderCtas) return null;
    if (!renewalOwnerCandidate) return null;
    const url = referralInviteUrlByKey[`renewal:${renewalOwnerCandidate.subscriptionId}`] || null;
    if (!url) return null;

    return {
      renewalCountdownEndsAt: renewalOwnerCandidate.renewalWindowEndsAt,
      renewalCountdownVisible: renewalOwnerCandidate.renewalWindowActive,
      subscriptionName: renewalOwnerCandidate.subscriptionName,
      url,
    };
  }, [referralInviteUrlByKey, renewalOwnerCandidate, shouldShowReferralHeaderCtas]);

  const handleForceRefresh = useCallback(async () => {
    if (isRefreshingApp) return;
    setIsRefreshingApp(true);
    try {
      await forceAppRefresh();
    } catch (error) {
      trackClientError(
        "cabinet.force_app_refresh_failed",
        error,
        { clientId: profile?.id ?? null },
        { handled: true, severity: "warning" },
      );
      setIsRefreshingApp(false);
    }
  }, [isRefreshingApp, profile?.id]);

  const loadBookings = async () => {
    const shouldRefreshHistory = isBookingHistoryOpen || historyBookings !== null;
    const phone = profile?.phone?.trim() || null;
    const [
      activeBookingsData,
      historyBookingsData,
      userSubscriptionsData,
      referralSubscriptionsData,
      activeGamesResult,
      resultWindowGamesResult,
    ] = await Promise.all([
      apiFetchBookings(false),
      shouldRefreshHistory ? loadHistoryBookings(true) : Promise.resolve(null),
      apiFetchSubscriptions(),
      apiFetchSubscriptions(REFERRAL_SUBSCRIPTIONS_FETCH_OPTIONS),
      phone
        ? apiFetchPadelGamesByPhone(
            phone,
            profile?.id ?? null,
            false,
            { limit: ACTIVE_RESULT_WINDOW_LIMIT },
          )
        : Promise.resolve(null),
      phone
        ? apiFetchPadelGamesByPhone(
            phone,
            profile?.id ?? null,
            true,
            {
              limit: ACTIVE_RESULT_WINDOW_LIMIT,
              windowHours: 24,
              needsResult: true,
            },
          )
        : Promise.resolve(null),
    ]);
    if (activeBookingsData) setActiveBookings(activeBookingsData.data);
    if (userSubscriptionsData.data) setUserSubscriptions(userSubscriptionsData.data);
    setReferralUserSubscriptions(referralSubscriptionsData.data || userSubscriptionsData.data || null);
    if (activeGamesResult?.data || resultWindowGamesResult?.data) {
      const activeGames = activeGamesResult?.data?.games ?? [];
      const resultWindowGames = resultWindowGamesResult?.data?.games ?? [];
      const mergedGames = mergeCabinetGameRecords(activeGames, resultWindowGames)
        .filter((game) => isGameRelevantToCabinetIdentity(
          game,
          profile?.id ?? null,
          profile?.phone ?? null,
        ));
      setCreatedGames(mergedGames);
      setActiveGameRecordsTotal(Math.max(
        activeGamesResult?.data?.total ?? 0,
        resultWindowGamesResult?.data?.total ?? 0,
        mergedGames.length,
      ));
    }
    const gamesError = activeGamesResult?.error ?? resultWindowGamesResult?.error;
    setCreatedGamesError(gamesError?.message ?? null);
    trackAnalyticsEvent("cabinet_data_refreshed", {
      activeBookingsCount: activeBookingsData?.data?.content?.length ?? 0,
      historyBookingsCount: historyBookingsData?.content?.length ?? (historyBookings?.content?.length ?? 0),
      historyBookingsLoaded: shouldRefreshHistory,
      subscriptionsCount: userSubscriptionsData?.data?.content?.length ?? 0,
      referralSubscriptionsCount: referralSubscriptionsData?.data?.content?.length ?? 0,
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
  const canOpenTournamentsBlock = canHostTournaments;

  const openOnboarding = () => {
    trackAnalyticsEvent("onboarding_open_requested", {
      source: "cabinet",
      clientId: profile.id,
    });
    const groupTrainingsAction = QUICK_ACTIONS.find((action) => action.label === "Групповые тренировки");
    onOpenOnboarding({
      profile,
      gamesLink: resolveQuickActionHref(QUICK_ACTIONS.find((action) => action.label === "Играть")?.href || "#"),
      trainingLink: groupTrainingsAction ? resolveGroupTrainingsHref(groupTrainingsAction.href) : "#",
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
    if (isSyntheticCabinetBookingGame(game)) {
      onOpenGames({ gameId: game.id, openChat: false, initialGameRecord: game });
      return;
    }
    onOpenGames({ gameId: game.id, openChat: true });
  };

  const handleOpenGameDetails = (game: PadelGameRecord) => {
    if (isSyntheticCabinetBookingGame(game)) {
      onOpenGames({ gameId: game.id, openChat: false, initialGameRecord: game });
      return;
    }
    onOpenGames({ gameId: game.id, openChat: false });
  };

  const handleCancelGameBooking = async (
    gameId: string,
    bookingId: string,
    action: BookingCancellationAction,
  ): Promise<BookingCancellationExecutionResult> => {
    if (!gameId || !bookingId || cancellingGameId) {
      return {
        ok: false,
        message: "Не удалось отменить запись",
      };
    }

    setCancellingGameId(gameId);
    const cleanupResult = await apiCleanupPadelGameByOrganizer(gameId, {
      force: true,
      dryRun: false,
      limit: 1,
      intent: "cancel_game",
      refundMethod: action.refundMethod ?? undefined,
      cancellationActionId: action.id,
      actorBookingId: bookingId,
    });
    const cleanupItems = Array.isArray(cleanupResult.data?.items)
      ? cleanupResult.data.items
      : [];
    const cleanupItem = cleanupItems.find((item) => (
      normalizeBookingLikeId(item.gameId) === normalizeBookingLikeId(gameId)
    )) ?? null;
    const ok = !cleanupResult.error
      && cleanupItem?.cancelledInLk === true
      && cleanupItem.withVivaErrors !== true;
    const successMessage = cleanupItem?.refundMessage || action.successMessage;

    setCancellingGameId(null);
    if (!ok) {
      return {
        ok: false,
        message: cleanupResult.error?.message
          || "Не удалось подтвердить серверную отмену игры. Запись Viva не изменена этим экраном.",
      };
    }

    if (action.id === "subscription") {
      const releaseResult = await apiReleaseSubscriptionBookingClaim(bookingId);
      if (releaseResult.error || releaseResult.data?.state !== "RELEASED") {
        return {
          ok: false,
          message: "Запись отменена в Viva, но дневной лимит ещё не синхронизирован. Повторите позже.",
        };
      }
    }

    return {
      ok: true,
      message: successMessage,
    };
  };

  const handleArchiveGameFromCabinet = async (gameId: string) => {
    const normalizedGameId = gameId.trim();
    if (!normalizedGameId || archivingGameId) return;

    setArchivingGameId(normalizedGameId);
    setArchiveGameErrorById((current) => {
      if (!current[normalizedGameId]) return current;
      const next = { ...current };
      delete next[normalizedGameId];
      return next;
    });

    try {
      let archivedByCleanup = false;
      const linkedGame = createdGames.find((item) => item.id === normalizedGameId) ?? null;
      const hasExerciseIds = Boolean(linkedGame && collectGameExerciseIds(linkedGame).length > 0);
      const hasBookingIds = Boolean(linkedGame && collectGameBookingIds(linkedGame).length > 0);

      if (hasExerciseIds || hasBookingIds) {
        const cleanupResult = await apiCleanupPadelGameByOrganizer(normalizedGameId, {
          force: true,
          dryRun: false,
          limit: 1,
          intent: "cancel_game",
        });
        const cleanupData = cleanupResult.data;
        const cleanupItems = Array.isArray(cleanupData?.items) ? cleanupData.items : [];
        const cleanupItem = cleanupItems.find((item) => (
          normalizeBookingLikeId(item.gameId) === normalizeBookingLikeId(normalizedGameId)
        )) ?? cleanupItems[0] ?? null;
        const cleanupProcessed = (cleanupData?.processed ?? 0) > 0 || cleanupItem !== null;
        const cleanupSucceeded = cleanupItem?.cancelledInLk === true && cleanupItem?.withVivaErrors !== true;

        if (cleanupProcessed) {
          if (!cleanupSucceeded) {
            setArchiveGameErrorById((current) => ({
              ...current,
              [normalizedGameId]: "Не удалось удалить занятие в Viva",
            }));
            return;
          }
          archivedByCleanup = true;
        }
      }

      if (!archivedByCleanup) {
        const result = await apiUpdatePadelGameRecord(normalizedGameId, { archived: true });
        if (result.error && !result.data?.id) {
          setArchiveGameErrorById((current) => ({
            ...current,
            [normalizedGameId]: result.error?.message || "Не удалось удалить игру из личного кабинета",
          }));
          return;
        }
      }

      setCreatedGames((current) => current.filter((item) => item.id !== normalizedGameId));
      setChatUnreadByGame((current) => {
        if (!current[normalizedGameId]) return current;
        const next = { ...current };
        delete next[normalizedGameId];
        return next;
      });
      setGameCancelStateById((current) => {
        if (!current[normalizedGameId]) return current;
        const next = { ...current };
        delete next[normalizedGameId];
        return next;
      });
      setArchiveGameErrorById((current) => {
        if (!current[normalizedGameId]) return current;
        const next = { ...current };
        delete next[normalizedGameId];
        return next;
      });
    } catch {
      setArchiveGameErrorById((current) => ({
        ...current,
        [normalizedGameId]: "Не удалось удалить игру из личного кабинета",
      }));
    } finally {
      setArchivingGameId((current) => (current === normalizedGameId ? null : current));
    }
  };

  const handleCreateTeamGameFromBooking = (booking: Booking) => {
    if (!isExerciseConvertibleToGameFromBooking(booking)) return;

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
    const typeId = pickNumberFromUnknown(exercise.type?.id);
    const directionId = pickNumberFromUnknown(exercise.direction?.id);

    onOpenGames({
      createFromBooking: {
        bookingId,
        slotId,
        exerciseId,
        typeId,
        typeName: pickStringFromUnknown(exercise.type?.name),
        directionId,
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
      if (isSyntheticCabinetBookingGame(game)) {
        const booking = resolveBookingForGameCancellation(game);
        if (booking && isExerciseConvertibleToGameFromBooking(booking)) {
          handleCreateTeamGameFromBooking(booking);
          return;
        }
      }
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
    const linkedBooking = resolveBookingForGameCancellation(game);
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
    const participants = dedupePlayers(
      game.participants && game.participants.length > 0
        ? game.participants
        : (organizerPlayer ? [organizerPlayer] : []),
    );
    const hasWaitStatus = (statusValue: string | null | undefined): boolean => {
      const status = String(statusValue || "").trim().toUpperCase();
      return status.includes("WAIT");
    };
    const confirmedParticipants = participants.filter((player) => !hasWaitStatus(player.status));
    const isCurrentUserParticipant = confirmedParticipants.some((player) => isCurrentUserPlayer(player));
    const confirmedParticipantIdentityKeys = new Set<string>();
    const confirmedParticipantPhoneSet = new Set<string>();
    confirmedParticipants.forEach((player) => {
      const normalizedId = String(player.id || "").trim();
      if (normalizedId) {
        confirmedParticipantIdentityKeys.add(`id:${normalizedId}`);
      }
      const normalizedPhone = normalizePhoneForGame(player.phone);
      if (normalizedPhone) {
        confirmedParticipantIdentityKeys.add(`phone:${normalizedPhone}`);
        confirmedParticipantPhoneSet.add(normalizedPhone);
      }
    });
    const participantPhonesFromRecord = Array.isArray(game.participantPhones)
      ? game.participantPhones
      : [];
    participantPhonesFromRecord.forEach((value) => {
      const normalizedPhone = normalizePhoneForGame(value);
      if (!normalizedPhone) return;
      confirmedParticipantIdentityKeys.add(`phone:${normalizedPhone}`);
      confirmedParticipantPhoneSet.add(normalizedPhone);
    });
    const waitlistPlayers = Array.isArray(game.waitlist) ? game.waitlist : [];
    const waitlistPlayersWithoutParticipants = waitlistPlayers.filter((player) => {
      const playerId = String(player.id || "").trim();
      if (playerId && confirmedParticipantIdentityKeys.has(`id:${playerId}`)) return false;
      const playerPhone = normalizePhoneForGame(player.phone);
      if (playerPhone && confirmedParticipantIdentityKeys.has(`phone:${playerPhone}`)) return false;
      return true;
    });
    const topLevelWaitlistCount = Array.isArray(game.waitlistPhones)
      ? game.waitlistPhones.reduce((count, phoneValue) => {
          const normalizedPhone = normalizePhoneForGame(phoneValue);
          if (!normalizedPhone || confirmedParticipantPhoneSet.has(normalizedPhone)) return count;
          return count + 1;
        }, 0)
      : 0;
    const metadataWaitlistCount = Array.isArray(game.metadata?.waitlistPhones)
      ? game.metadata.waitlistPhones.reduce((count, phoneValue) => {
          if (typeof phoneValue !== "string") return count;
          const normalizedPhone = normalizePhoneForGame(phoneValue);
          if (!normalizedPhone || confirmedParticipantPhoneSet.has(normalizedPhone)) return count;
          return count + 1;
        }, 0)
      : 0;
    const participantsWaitlistCount = Array.isArray(game.participants)
      ? game.participants.reduce((count, player) => {
          if (!hasWaitStatus(player.status)) return count;
          const playerId = String(player.id || "").trim();
          if (playerId && confirmedParticipantIdentityKeys.has(`id:${playerId}`)) return count;
          const playerPhone = normalizePhoneForGame(player.phone);
          if (playerPhone && confirmedParticipantPhoneSet.has(playerPhone)) return count;
          return count + 1;
        }, 0)
      : 0;
    const waitlistCount = Math.max(
      waitlistPlayersWithoutParticipants.length,
      topLevelWaitlistCount,
      metadataWaitlistCount,
      participantsWaitlistCount,
    );
    const isCurrentUserWaitlisted = !isCurrentUserParticipant && (
      waitlistPlayersWithoutParticipants.some((player) => isCurrentUserPlayer(player))
      || (Array.isArray(game.waitlistPhones)
        && game.waitlistPhones.some((value) => {
          const normalizedPhone = normalizePhoneForGame(value);
          if (!normalizedPhone || confirmedParticipantPhoneSet.has(normalizedPhone)) return false;
          return normalizedPhone === profilePhoneNorm;
        }))
      || (Array.isArray(game.participants)
        && game.participants.some((player) => {
          if (!isCurrentUserPlayer(player)) return false;
          return hasWaitStatus(player.status);
        }))
      || (Array.isArray(game.metadata?.waitlistPhones)
        && game.metadata.waitlistPhones.some((value) => {
          if (typeof value !== "string") return false;
          const normalizedPhone = normalizePhoneForGame(value);
          if (!normalizedPhone || confirmedParticipantPhoneSet.has(normalizedPhone)) return false;
          return normalizedPhone === profilePhoneNorm;
        }))
    );
    const isOrganizer = isCurrentUserOrganizer(game);
    const showOrganizerWaitlistBadge = isOrganizer && waitlistCount > 0;
    const isSyntheticBookingGame = isSyntheticCabinetBookingGame(game);
    const canRecoverSyntheticGame = Boolean(
      isSyntheticBookingGame
      && linkedBooking
      && isExerciseConvertibleToGameFromBooking(linkedBooking),
    );
    const isCancelledForCabinet = Boolean(
      isGameCancelledStatus(game.status)
      || isGameRemovedStatus(game.status)
      || isGameMarkedDeletedInViva(game)
    );
    const inviteUrl = resolveGameInviteUrl(game);
    const canInvite = Boolean(
      inviteUrl
      && isOrganizer
      && !isSyntheticBookingGame
      && !isCancelledForCabinet
      && isGamePaidForInvite(game)
    );
    const canOpenChat = !isSyntheticBookingGame;
    const canCancelGameBooking = Boolean(
      !isCancelledForCabinet
      && isOrganizer
      && linkedBooking
      && linkedBooking.cancellationDeadline
      && new Date(linkedBooking.cancellationDeadline) > new Date(),
    );
    const showCancelDeadlineText = Boolean(
      !isCancelledForCabinet
      && isOrganizer
      && linkedBooking
      && !canCancelGameBooking,
    );
    const showArchiveGameAction = isCancelledForCabinet;
    const cancelState = gameCancelStateById[game.id] ?? "idle";
    const isArchivingThisGame = archivingGameId === game.id;
    const archiveGameError = archiveGameErrorById[game.id] ?? null;
    const unreadCount = chatUnreadByGame[game.id] ?? 0;
    const playersCount = resolveGameCardPlayersCount(game);
    const splitJoinPriceText = getSplitJoinPriceText(game);
    const showSplitJoinInfo = !isOrganizer && !isCurrentUserWaitlisted
      && (playersCount - Math.max(participants.length, 0)) > 0
      && Boolean(splitJoinPriceText);
    const playerSlots = Array.from({ length: playersCount }, (_, index) => (
      participants[index] ?? null
    ));
    const teamSlots = resolveStoredTeamSlots(game, playerSlots);
    const showInlineResultEntry = !isSyntheticBookingGame
      && !isCancelledForCabinet
      && shouldShowInlineResultEntry(game)
      && isCurrentUserParticipant;
    const resultDateTimeLabel = formatGameResultDateTimeLabel(
      game.booking?.date,
      game.booking?.timeFrom,
      game.booking?.timeTo,
    );
    const resultStationLabel = formatGameResultStationLabel(game, stationTitle, cardLocationTitle);
    const resultStationAddress = formatGameResultStationAddress(game);
    const resultCourtLabel = formatGameResultCourtLabel(game, courtTitle, cardLocationTitle);
    const resultMapUrl = getGameResultMapUrl(resultStationLabel, resultStationAddress || resultCourtLabel);
    const resultLevelLabel = formatGameResultLevelLabel(game);
    const resultTagLabel = game.settings?.ratingGame ? "Рейтинговая игра" : "Без рейтинга";
    const resultCalendarDisabled = !game.booking?.date || (!game.booking?.timeFrom && !game.booking?.timeTo);
    const statusBadgeLabel = isCancelledForCabinet ? "Отменена" : null;
    const waitlistBadgeLabel = isCurrentUserWaitlisted
      ? "В листе ожидания"
      : showOrganizerWaitlistBadge
        ? `Лист ожидания: ${waitlistCount}`
        : null;
    const topBadges = [
      ...(statusBadgeLabel
        ? [{ label: statusBadgeLabel, className: "game-created-tag game-created-tag-cancelled" }]
        : []),
      ...(waitlistBadgeLabel
        ? [{
          label: waitlistBadgeLabel,
          className: `game-created-tag game-created-tag-waitlist${isCurrentUserWaitlisted ? " game-created-tag-waitlist-user" : ""}`,
        }]
        : []),
    ];

    return (
      <div
        key={game.id}
        className={`game-created-card game-created-card-clickable${showInlineResultEntry ? " game-created-card--result-prompt" : ""}`}
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
        {topBadges.length > 0 && (
          <div className="game-created-top-badge-row">
            {topBadges.map((item) => (
              <span key={`${game.id}-${item.label}`} className={item.className}>
                {item.label}
              </span>
            ))}
          </div>
        )}
        {!showInlineResultEntry && (
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
        )}
        {!showInlineResultEntry && (
          <div className={`game-created-players${playersCount <= 2 ? " game-created-players-singles" : ""}`}>
            {playerSlots.map((player, index) => {
              const initials = getPlayerInitials(player?.name);
              const levelLabel = normalizePlayerRatingLabel(
                player?.rating ?? null,
                typeof player?.ratingNumeric === "number" && Number.isFinite(player.ratingNumeric)
                  ? player.ratingNumeric
                  : null,
              );
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
          <>
            <div className="game-created-result-prompt-head">
              <div className="game-created-result-prompt-title-block">
                <div className={`game-created-result-prompt-tag${game.settings?.ratingGame ? "" : " game-created-result-prompt-tag--neutral"}`}>
                  <span className="game-created-result-prompt-tag-dot" aria-hidden="true" />
                  <span>{resultTagLabel}</span>
                </div>
                <div className="game-created-result-prompt-title">{cardTitle}</div>
              </div>
              <button
                type="button"
                className="game-created-result-date-badge"
                disabled={resultCalendarDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!resultCalendarDisabled) {
                    addGameToCalendar(game);
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
                aria-label="Добавить игру в календарь"
                title="Добавить в календарь"
              >
                <span className="game-created-result-date-badge-day">{badge.day}</span>
                <span className="game-created-result-date-badge-weekday">{badge.weekday}</span>
              </button>
            </div>

            <div className="game-created-result-prompt-info">
              <div className="game-created-result-info-row">
                {renderGameResultInfoIcon("date")}
                <span>{resultDateTimeLabel}</span>
              </div>
              <div className="game-created-result-info-row game-created-result-info-row--place">
                {renderGameResultInfoIcon("location")}
                <button
                  type="button"
                  className="game-created-result-station-trigger"
                  onClick={(event) => {
                    event.stopPropagation();
                    setResultPromptStationModal({
                      stationTitle: resultStationLabel,
                      address: resultStationAddress,
                      courtTitle: resultCourtLabel,
                      mapUrl: resultMapUrl,
                    });
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  {resultStationLabel}
                </button>
              </div>
              <div className="game-created-result-info-row game-created-result-info-row--court">
                {renderGameResultInfoIcon("location")}
                <span>{resultCourtLabel}</span>
              </div>
              <div className="game-created-result-info-row game-created-result-info-row--level">
                {renderGameResultInfoIcon("level")}
                <span>{resultLevelLabel}</span>
              </div>
            </div>

            <div className="game-created-result-prompt-footer">
              <div className="game-created-result-prompt-footer-row">
                <div className="game-created-result-prompt-avatars" aria-label="Участники">
                  {teamSlots.map((player, index) => {
                    const initials = getPlayerInitials(player?.name);
                    return (
                      <span
                        key={`${game.id}-result-prompt-slot-${index}`}
                        className={`game-created-result-prompt-avatar${player ? "" : " game-created-result-prompt-avatar--empty"}`}
                      >
                        {player?.photo ? (
                          <img src={player.photo} alt={player.name || "Игрок"} />
                        ) : (
                          <span>{player ? initials : ""}</span>
                        )}
                      </span>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="game-created-result-prompt-cta"
                  onClick={(event) => {
                    event.stopPropagation();
                    openGameDetails();
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  Внести результат
                </button>
              </div>
            </div>
          </>
        )}

        {!showInlineResultEntry && (
          <>
            {showArchiveGameAction ? (
              <div className="game-created-actions game-created-actions-single">
                <button
                  className="game-created-action game-created-action-danger"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleArchiveGameFromCabinet(game.id);
                  }}
                  disabled={isArchivingThisGame}
                >
                  {isArchivingThisGame ? "Удаляем..." : "Удалить"}
                </button>
              </div>
            ) : (
              <div className={`game-created-actions${canInvite ? " game-created-actions-organizer" : " game-created-actions-single"}`}>
                {showSplitJoinInfo && (
                  <div className="game-created-split-join-info" aria-label="Условия присоединения к сборной игре">
                    {splitJoinPriceText && (
                      <div className="game-created-split-join-info-row">
                        <span>Вход</span>
                        <strong>{splitJoinPriceText}</strong>
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
                {canRecoverSyntheticGame && linkedBooking ? (
                  <button
                    className="game-created-action game-created-action-invite"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleCreateTeamGameFromBooking(linkedBooking);
                    }}
                  >
                    Настроить и опубликовать
                  </button>
                ) : canOpenChat ? (
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
                ) : (
                  <button
                    className="game-created-action"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      openGameDetails();
                    }}
                  >
                    Подробнее
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {canRecoverSyntheticGame && (
          <div className="booking-status-text">
            Запись есть в Viva, но ещё не добавлена в ЦУП.
          </div>
        )}
        {archiveGameError && (
          <div className="booking-status-text">{archiveGameError}</div>
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
        {showCancelDeadlineText && (
          <div className="booking-status-text">Отмена возможна только за 24 часа</div>
        )}
        {linkedBooking && (
          <BookingCancellationDialog
            bookingId={linkedBooking.id}
            isOpen={cancelState === "confirm"}
            onClose={() => {
              setGameCancelStateById((prev) => ({ ...prev, [game.id]: "idle" }));
            }}
            onSuccessClose={() => {
              window.location.reload();
            }}
            executeAction={(action) => handleCancelGameBooking(game.id, linkedBooking.id, action)}
          />
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
          shareOffer={shareOffer}
          renewalOffer={renewalOffer}
        />
      </div>

      {showCommunitiesSection && (
        <CommunitiesSectionLoader
          profile={profile}
          createdGames={createdGames}
          activeBookingExerciseIds={activeBookingExerciseIds}
          onOpenGames={onOpenGames}
          onOpenTournaments={handleOpenTournaments}
          onOpenLevelsInfo={onOpenLevelsInfo}
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
          const openGroupTrainings = action.label === "Групповые тренировки";
          const resolvedHref = openGroupTrainings
            ? resolveGroupTrainingsHref(action.href)
            : resolveQuickActionHref(action.href);
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
          if (openGroupTrainings) {
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
                  window.location.href = resolvedHref;
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

      {cabinetFlashNotice && (
        <div className="cabinet-flash-notice" role="status">
          {cabinetFlashNotice}
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
        isGameLinkAmbiguousForBooking={isGameLinkAmbiguousForBooking}
        resolveCancellationGameLink={resolveCancellationGameLink}
        executeBookingCancellation={executeBookingCancellation}
        resolveDisplayGameForBooking={resolveDisplayGameForBooking}
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
        onForceRefresh={() => {
          void handleForceRefresh();
        }}
        isRefreshingApp={isRefreshingApp}
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
      <Modal
        isOpen={resultPromptStationModal !== null}
        onClose={() => setResultPromptStationModal(null)}
        title={resultPromptStationModal?.stationTitle || "Станция"}
        variant="dialog"
        bodyClassName="game-created-station-modal"
      >
        <div className="game-created-station-facts">
          <div className="game-created-station-fact">
            <span>Станция</span>
            <strong>{resultPromptStationModal?.stationTitle || "Станция уточняется"}</strong>
          </div>
          {resultPromptStationModal?.courtTitle && (
            <div className="game-created-station-fact">
              <span>Корт</span>
              <strong>{resultPromptStationModal.courtTitle}</strong>
            </div>
          )}
          {resultPromptStationModal?.address && (
            <div className="game-created-station-fact">
              <span>Адрес</span>
              <strong>{resultPromptStationModal.address}</strong>
            </div>
          )}
        </div>
        {resultPromptStationModal?.mapUrl && (
          <a
            className="section-cta game-created-station-map"
            href={resultPromptStationModal.mapUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть на карте
          </a>
        )}
      </Modal>
      <SubscriptionInformation
        isOpen={isSubscriptionInfoOpen}
        onClose={() => SetSubscriptionInfoOpen(false)}
        sub={currenSub}
        subName={currenSubName}
      />
      <SupportChatWidget profile={profile} />
    </div>
  );
}
