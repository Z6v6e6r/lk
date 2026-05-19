import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Booking,
  GamePlayFormat,
  GameCourtOption,
  GameTimeSlot,
  PadelGameChatMessage,
  PadelGamePlayer,
  PadelGameRecord,
  PadelGameRecordPayload,
  PadelSplitPaymentPromoConfig,
  Subscription,
  Studio,
  StudioGameModes,
} from "../../utils/apiClient";
import {
  apiCheckMasterServicePromoCode,
  apiFetchMasterServicePromoDiscounts,
  apiFetchBookings,
  apiFetchMasterServiceGameModes,
  apiCreatePadelGameRecord,
  apiCreatePadelSplitGamePayment,
  apiFetchSubscriptions,
  apiFetchPadelChatsByPhone,
  apiFetchPadelGameChatMessages,
  apiFetchPadelGameRecord,
  apiFetchPadelGamesByPhone,
  apiMarkPadelGameChatRead,
  apiPayMasterService,
  apiSearchPadelPlayers,
  apiUpdatePadelGameRecord,
  apiSendPadelGameChatMessage,
  apiFetchMasterServicePrice,
  apiFetchMasterServiceTimeslots,
  apiFetchOnboardingStations,
  apiFetchPadelLiveRatings,
  apiFetchPadelSplitPaymentPromoConfig,
  apiFetchProfile,
  apiSaveOnboardingLevel,
  DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG,
} from "../../utils/apiClient";
import {
  apiAddCommunityMember,
  apiArchiveCommunityFeedPost,
  apiCreateCommunityFeedPost,
  apiFetchCommunities,
  apiJoinCommunityByInvite,
} from "../../utils/communityApi";
import { Modal } from "../UI/Modal";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { ChatIcon } from "../cabinet/community-feed/CommunityIcons";
import {
  PAYMENT_REF_QUERY_KEY,
  enqueuePendingPaymentSync,
  extractBookingIdsFromUrl,
  getPendingPaidGameDraft,
  processPendingPaymentSyncQueue,
  savePendingPaidGameDraft,
  type PendingPaidGameDraft,
} from "../../utils/paymentSync";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import type { GamesCreateFromBookingData } from "../../types/gamesOverlay";
import {
  CABINET_URL,
  GAMES_BUNDLE_URL,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";
import { trackAnalyticsEvent } from "../../utils/analytics";
import { shareOrCopyGameInvitePayload } from "../../utils/gameInviteClipboard";
import { addGameToCalendar } from "../../utils/calendarEvent";
import logoHabBlack from "../../assets/logo hab black.svg";
import logoHabWhite from "../../assets/logo hab white.svg";

interface GamesPageProps {
  onBack: () => void;
  openChat?: boolean;
  openGameId?: string | null;
  createFromBooking?: GamesCreateFromBookingData | null;
  publicCreateEntry?: boolean;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
}

type Step = "create" | "place" | "time" | "details" | "chat";
type GamePaymentMode = "self" | "split";
type SplitShareCount = 2 | 4;

const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"];

const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const MAX_DOUBLES_PLAYERS = 4;
const MAX_SINGLES_PLAYERS = 2;
const DETAILS_TEAM_SLOTS_COUNT = 4;
const MAX_MATCH_RESULT_SETS = 5;
const MAX_MATCH_RESULT_ATTACHMENTS = 6;
const MATCH_RESULT_IMAGE_MAX_SIDE = 1600;
const MATCH_RESULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHAT_READ_STORAGE_KEY_PREFIX = "padlhub.chat.lastRead.v1";
const PUBLIC_GAMES_ORIGIN_FALLBACK = "https://padlhub.ru";
const INVITE_JOIN_PATH = PUBLIC_INVITE_PATH;
const CHAT_MESSAGE_BG_PALETTE = [
  "#f5efff",
  "#eaf4ff",
  "#e9fbf3",
  "#fff5e8",
  "#fceef5",
  "#edf2ff",
];
const MATCH_RESULT_RATING_DEFAULT_PARAMS = {
  K: 0.3,
  D: 3,
  B: 0.3,
  minRating: 1,
  maxRating: 7,
  round: 5,
};
const ENABLE_GAME_COMMUNITY_AUTOPUBLISH = true;
const ENABLE_SPLIT_GAME_PAYMENT = true;
const SPLIT_PAYMENT_DEADLINE_MINUTES = 25;
const SPLIT_PAYMENT_UNLOCK_TAP_COUNT = 8;
const SPLIT_PAYMENT_UNLOCK_RESET_MS = 6000;
const SPLIT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const SPLIT_OPEN_GAME_DIRECTION_ID = 4588;

function resolveSplitShareAmount(
  shareCount: SplitShareCount,
  config: PadelSplitPaymentPromoConfig,
  durationMinutes = 60,
): number {
  const baseAmount = shareCount === 4
    ? config.shareAmounts.fourPlayers
    : config.shareAmounts.twoTeams;
  return Math.round(baseAmount * Math.max(durationMinutes, 1) / 60);
}

function resolveSplitBaseShareAmount(config: PadelSplitPaymentPromoConfig, durationMinutes = 60): number {
  return Math.round(config.baseShareAmount * Math.max(durationMinutes, 1) / 60);
}

function isSplitSubscriptionStatusActive(status: string | null | undefined): boolean {
  const normalized = String(status || "").trim().toUpperCase();
  if (!normalized) return true;
  const blockedMarkers = [
    "EXPIRED",
    "CANCEL",
    "BLOCK",
    "ARCHIVE",
    "INACTIVE",
    "SUSPEND",
    "FINISH",
    "TERMINAT",
    "ENDED",
    "ЗАВЕРШ",
    "ОТМЕН",
    "ПРОСРОЧ",
  ];
  return !blockedMarkers.some((marker) => normalized.includes(marker));
}

function hasSplitSubscriptionBalance(subscription: Subscription): boolean {
  const hasVisitsValue = Number.isFinite(subscription.visitsLeft);
  const hasMinutesValue = Number.isFinite(subscription.availableMinutes);
  const visitsLeft = hasVisitsValue ? subscription.visitsLeft : null;
  const minutesLeft = hasMinutesValue ? subscription.availableMinutes : null;

  if (visitsLeft != null && visitsLeft > 0) return true;
  if (minutesLeft != null && minutesLeft > 0) return true;
  if (visitsLeft != null && minutesLeft != null) return false;
  if (visitsLeft != null) return visitsLeft > 0;
  if (minutesLeft != null) return minutesLeft > 0;
  return true;
}

function buildComparableIdSet(values: Array<string | number | null | undefined>): Set<string> {
  return new Set(
    values
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
}

function hasIdIntersection(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) return true;
  }
  return false;
}

function subscriptionMatchesSplitCategory(
  subscription: Subscription,
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
): boolean {
  if (subscription.hasTypeLimitation) {
    const allowedTypes = new Set(
      (subscription.availableTypes || [])
        .map((item) => normalizeComparableId(item?.id))
        .filter((value): value is string => Boolean(value)),
    );
    if (allowedTypes.size === 0 || !hasIdIntersection(allowedTypes, requiredExerciseTypeIds)) {
      return false;
    }
  }

  if (subscription.hasDirectionLimitation) {
    const allowedDirections = new Set(
      (subscription.availableDirections || [])
        .map((item) => normalizeComparableId(item?.id))
        .filter((value): value is string => Boolean(value)),
    );
    if (allowedDirections.size === 0 || !hasIdIntersection(allowedDirections, requiredDirectionIds)) {
      return false;
    }
  }

  return true;
}

function filterSplitEligibleSubscriptions(
  subscriptions: Subscription[],
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
): Subscription[] {
  return subscriptions.filter((subscription) => {
    if (!isSplitSubscriptionStatusActive(subscription.status)) return false;
    if (!hasSplitSubscriptionBalance(subscription)) return false;
    return subscriptionMatchesSplitCategory(
      subscription,
      requiredExerciseTypeIds,
      requiredDirectionIds,
    );
  });
}

function buildSplitSubscriptionStatusLabel(subscriptions: Subscription[]): string {
  const primary = subscriptions[0];
  if (!primary) return "Найдено доступных абонементов: 0";

  const name = typeof primary.name === "string" ? primary.name.trim() : "";
  const visitsLeft = Number.isFinite(primary.visitsLeft)
    ? Math.max(0, Math.floor(primary.visitsLeft))
    : null;
  const extraCount = Math.max(0, subscriptions.length - 1);
  const extraLabel = extraCount > 0 ? ` · еще ${extraCount}` : "";

  if (name && visitsLeft != null) {
    return `Абонемент «${name}» · осталось посещений: ${visitsLeft}${extraLabel}`;
  }
  if (name) {
    return `Абонемент «${name}»${extraLabel}`;
  }
  if (visitsLeft != null) {
    return `Найден абонемент · осталось посещений: ${visitsLeft}${extraLabel}`;
  }
  return `Найдено доступных абонементов: ${subscriptions.length}`;
}

function splitConfigListAllows(
  allowedIds: string[],
  includeTokens: string[],
  id: string | null | undefined,
  name: string | null | undefined,
): boolean {
  const idSet = new Set(
    allowedIds
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
  const normalizedId = normalizeComparableId(id);
  if (idSet.size > 0 && normalizedId && idSet.has(normalizedId)) {
    return true;
  }

  const normalizedName = normalizeComparableName(name);
  const tokens = includeTokens
    .map((value) => normalizeComparableName(value))
    .filter((value): value is string => Boolean(value));
  if (tokens.length > 0 && normalizedName && tokens.some((token) => normalizedName.includes(token))) {
    return true;
  }
  return idSet.size === 0 && tokens.length === 0;
}

function isSplitPaymentPromoAvailableForSelection(params: {
  config: PadelSplitPaymentPromoConfig;
  date: Date | null;
  studioId: string | null;
  studioName: string | null;
  roomId: string | null;
  roomName: string | null;
}): boolean {
  if (!ENABLE_SPLIT_GAME_PAYMENT || params.config.enabled !== true) {
    return false;
  }
  if (!params.date) {
    return false;
  }

  const promoActiveTo = params.config.activeTo?.trim();
  if (promoActiveTo) {
    const selectedDate = formatDateLocalIso(params.date);
    if (selectedDate > promoActiveTo) {
      return false;
    }
  }

  const stationAllowed = splitConfigListAllows(
    params.config.stationIds,
    params.config.stationNameIncludes,
    params.studioId,
    params.studioName,
  );
  if (!stationAllowed) return false;

  return splitConfigListAllows(
    params.config.roomIds,
    params.config.roomNameIncludes,
    params.roomId,
    params.roomName,
  );
}

function resolveSplitPaymentPromoConfigForSelection(params: {
  config: PadelSplitPaymentPromoConfig;
  date: Date | null;
  studioId: string | null;
  studioName: string | null;
  roomId: string | null;
  roomName: string | null;
}): PadelSplitPaymentPromoConfig {
  const candidates = params.config.promos?.length ? params.config.promos : [params.config];
  return (
    candidates.find((candidate) =>
      isSplitPaymentPromoAvailableForSelection({
        ...params,
        config: candidate,
      }),
    ) ?? params.config
  );
}

type CommunityAutopublishTarget = {
  id: string;
  name: string;
  logo: string | null;
  isOrganizerMember: boolean;
  isStationCommunity: boolean;
};

type CommunityAutopublishTargetsBundle = {
  stationTarget: CommunityAutopublishTarget | null;
  memberTargets: CommunityAutopublishTarget[];
  defaultSelectedIds: string[];
};

type CommunityAutopublishSelectionState = {
  selectedCommunityIds: string[];
  stationCommunityId: string | null;
  selectionTouched: boolean;
};

type CommunityAutopublishSelectionSnapshot = {
  stationTarget: CommunityAutopublishTarget | null;
  memberTargets: CommunityAutopublishTarget[];
  selectedCommunityIds: string[];
  selectionTouched: boolean;
};

function getCommunityAutopublishPayload(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;

  if (isRecordObject(metadata.communityAutoPublish)) {
    return metadata.communityAutoPublish;
  }

  if (isRecordObject(metadata.communityAutoPublishDev)) {
    return metadata.communityAutoPublishDev;
  }

  return null;
}

function buildCommunityAutopublishSelectionState(
  snapshot: CommunityAutopublishSelectionSnapshot,
): CommunityAutopublishSelectionState {
  const selectableIds = new Set<string>([
    ...(snapshot.stationTarget?.isOrganizerMember ? [snapshot.stationTarget.id] : []),
    ...snapshot.memberTargets
      .filter((target) => target.isOrganizerMember)
      .map((target) => target.id),
  ]);
  const normalizedSelectedIds = Array.from(new Set(
    snapshot.selectedCommunityIds
      .map((communityId) => communityId.trim())
      .filter((communityId) => selectableIds.has(communityId)),
  ));

  return {
    selectedCommunityIds: normalizedSelectedIds,
    stationCommunityId: snapshot.stationTarget?.id ?? null,
    selectionTouched: snapshot.selectionTouched,
  };
}

function buildCommunityAutopublishMetadataFields(
  payload: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!payload) return {};

  return {
    communityAutoPublish: payload,
    communityAutoPublishDev: payload,
  };
}

function extractGameCustomTitle(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const value = typeof metadata.gameTitle === "string" ? metadata.gameTitle.trim() : "";
  return value || null;
}

function extractGameParticipantComment(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  const value = typeof metadata.participantComment === "string" ? metadata.participantComment.trim() : "";
  return value || null;
}

function extractGameJoinPrice(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata) return null;
  if (typeof metadata.joinPrice === "number" && Number.isFinite(metadata.joinPrice)) {
    const normalized = Math.max(0, Math.round(metadata.joinPrice));
    return normalized > 0 ? String(normalized) : null;
  }
  const raw = typeof metadata.joinPrice === "string" ? metadata.joinPrice.trim() : "";
  const digits = raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  return digits || null;
}

function buildGameOptionalMetadataFields(params: {
  gameTitle: string;
  participantComment: string;
  joinPrice: string;
}): Record<string, unknown> {
  const title = params.gameTitle.trim();
  const participantComment = params.participantComment.trim();
  const joinPrice = params.joinPrice.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");

  return {
    ...(title ? { gameTitle: title } : {}),
    ...(participantComment ? { participantComment } : {}),
    ...(joinPrice ? { joinPrice } : {}),
  };
}

function formatGameJoinPriceLabel(value: string | null): string | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return `${formatPrice(parsed)} ₽`;
}

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function formatCourtsLabel(count: number): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  let word = "кортов";

  if (mod100 < 11 || mod100 > 14) {
    if (mod10 === 1) word = "корт";
    else if (mod10 >= 2 && mod10 <= 4) word = "корта";
  }

  return `Панорамик: ${count} ${word}`;
}

function extractCourtOrder(name: string): number | null {
  const bySign = name.match(/№\s*(\d+)/i);
  if (bySign) {
    const value = Number.parseInt(bySign[1], 10);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

function formatDateLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
}

function resolvePublicGamesOrigin(current: URL): string {
  const isLocalHost = isLocalHostname(current.hostname);

  if (!isLocalHost) {
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

  return PUBLIC_GAMES_ORIGIN_FALLBACK;
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

function normalizeInviteUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (typeof window === "undefined") return raw;

  try {
    const currentUrl = new URL(window.location.href);
    const parsed = new URL(raw, currentUrl.origin);
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

    const publicOrigin = resolvePublicGamesOrigin(currentUrl);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return normalized.toString();
  } catch {
    return raw;
  }
}

function buildBaseRedirectUrl(
  fromDate: string,
  extraParams: Record<string, string | null | undefined> = {},
): string | null {
  if (typeof window === "undefined") return null;
  try {
    const currentUrl = new URL(window.location.href);
    const fallbackOrigin = resolvePublicGamesOrigin(currentUrl);
    const cabinetBase = (CABINET_URL || "").trim();
    const url = cabinetBase
      ? new URL(cabinetBase, fallbackOrigin)
      : new URL(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`, fallbackOrigin);
    const instanceNameRaw =
      currentUrl.searchParams.get("instanceName")
      || url.searchParams.get("instanceName")
      || "PadlTerekhovo";
    const instanceName = instanceNameRaw.trim() || "PadlTerekhovo";
    url.searchParams.set(`${instanceName}_date`, fromDate);
    url.searchParams.set("instanceName", instanceName);
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value == null || !key.trim()) return;
      url.searchParams.set(key, value);
    });
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return (CABINET_URL || "").trim() || window.location.href || null;
  }
}

function buildInviteFallbackUrl(gameId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = resolveInviteCabinetBaseUrl();
    if (!url) return null;
    url.searchParams.set("joinGame", gameId);
    return `${url.origin}${url.pathname}?${url.searchParams.toString()}`;
  } catch {
    return null;
  }
}

function resolveGameInviteUrl(game: PadelGameRecord | null | undefined): string | null {
  if (!game) return null;
  return normalizeInviteUrl(game.inviteUrl) ?? buildInviteFallbackUrl(game.id);
}

function generatePaymentRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
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
    // fallback to current window navigation below
  }

  try {
    window.location.assign(target);
    return true;
  } catch {
    // fallback to anchor click below
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

function trackGameRecordCreateEvent(
  type: "requested" | "success" | "failed",
  payload: Record<string, unknown>,
) {
  const eventName = `game_record_create_${type}`;
  trackAnalyticsEvent(eventName, payload);
}

type MatchSnapshot = {
  studioName: string | null;
  roomName: string | null;
  date: string | null;
  timeFrom: string | null;
  timeTo: string | null;
  durationMinutes: number | null;
  amount: number | null;
};

type PromoStateSnapshot = {
  code: string;
  discountAmount: number | null;
  paymentAmount: number | null;
};

type TeamSlotStoredRef = {
  id?: string | null;
  phone?: string | null;
  name?: string | null;
};

type EditableMatchResultSet = {
  left: string;
  right: string;
};

type MatchResultPairingOption = {
  key: string;
  label: string;
  nextSlots: Array<PadelGamePlayer | null>;
  isCurrent: boolean;
};

type MatchResultSetPairingSlots = Array<PadelGamePlayer | null>;

type MatchResultSetPairingStored = {
  setIndex: number;
  teamSlots: Array<TeamSlotStoredRef | null>;
};

type MatchResultAttachment = {
  id: string;
  name: string;
  type: string;
  size: number | null;
  dataUrl: string;
  createdAt: string;
  source: "camera" | "gallery";
};

type MatchResultPhotoLogoVariant = "white" | "black";

type GameLeaveEvent = {
  playerId: string | null;
  playerPhone: string | null;
  playerName: string | null;
  leftAt: string;
  reason: string | null;
  byId: string | null;
  byPhone: string | null;
  byName: string | null;
};

type BookingLookupContext = {
  bookingIds: string[];
  slotIds: string[];
  exerciseIds: string[];
  studioId: string | null;
  studioName: string | null;
  roomId: string | null;
  roomName: string | null;
  date: string | null;
  timeFrom: string | null;
  timeTo: string | null;
};

type VivaPaymentCheckResult = {
  paid: boolean | null;
  paymentUrl: string | null;
  cancelled: boolean;
  matchedBookings: Booking[];
};

type MatchResultRatingImpactEntry = {
  id: string | null;
  name: string;
  phoneNorm: string | null;
  team: "A" | "B" | null;
  before: number;
  expected: number;
  actual: number;
  delta: number;
  after: number;
  gradeAfter: string | null;
};

type MatchResultRatingParams = {
  K: number;
  D: number;
  B: number;
  minRating: number;
  maxRating: number;
  round: number;
};

type MatchResultVivaSyncStatus = "PENDING" | "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

type MatchResultVivaSyncFailure = {
  id: string | null;
  phone: string | null;
  name: string | null;
  reason: string | null;
};

type MatchResultVivaSyncState = {
  status: MatchResultVivaSyncStatus | null;
  attempts: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  totalPlayers: number;
  syncedPlayers: number;
  failures: MatchResultVivaSyncFailure[];
};

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundToPrecision(value: number, precision: number): number {
  const safePrecision = Number.isFinite(precision) ? Math.max(0, Math.floor(precision)) : 5;
  return Number(value.toFixed(safePrecision));
}

function formatRatingValue(value: number, precision = 5): string {
  const rounded = roundToPrecision(value, precision);
  if (Object.is(rounded, -0)) return "0";
  return rounded.toFixed(precision).replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
}

function normalizeRatingNumeric(value: unknown): number | null {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return null;
  if (numeric < 1 || numeric > 7) return null;
  return numeric;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function mapRatingGradeToNumeric(grade: unknown): number | null {
  const normalized = String(grade || "").trim().toUpperCase();
  if (normalized === "D") return 2.0;
  if (normalized === "D+") return 2.5;
  if (normalized === "C") return 3.0;
  if (normalized === "C+") return 3.5;
  if (normalized === "B") return 4.2;
  if (normalized === "B+") return 5.0;
  if (normalized === "A") return 6.0;
  return null;
}

function mapNumericToRatingGrade(value: unknown): string | null {
  const numeric = toFiniteNumber(value);
  if (numeric == null) return null;
  if (numeric < 2) return "D";
  if (numeric < 3) return "D+";
  if (numeric < 3.5) return "C";
  if (numeric < 4) return "C+";
  if (numeric < 4.7) return "B";
  if (numeric < 5.5) return "B+";
  return "A";
}

function ratingFromAny(value: unknown, fallback = 2.5): number {
  const numeric = normalizeRatingNumeric(value);
  if (numeric != null) return numeric;
  const mapped = mapRatingGradeToNumeric(value);
  if (mapped != null) return mapped;
  return fallback;
}

function teamRatingPower(ratings: number[]): number {
  const normalized = ratings.filter((value) => Number.isFinite(value));
  if (normalized.length === 0) return 2.5;
  if (normalized.length === 2) {
    const [first, second] = normalized;
    const denominator = first + second;
    if (denominator > 0) {
      return (first * first + second * second) / denominator;
    }
  }
  return normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
}

function resolveMatchResultRatingParams(value: unknown): MatchResultRatingParams {
  const payload = isRecordObject(value) ? value : {};
  const defaults = MATCH_RESULT_RATING_DEFAULT_PARAMS;
  const K = toFiniteNumber(payload.K) ?? defaults.K;
  const D = toFiniteNumber(payload.D) ?? defaults.D;
  const B = toFiniteNumber(payload.B) ?? defaults.B;
  const minRating = toFiniteNumber(payload.minRating) ?? defaults.minRating;
  const maxRating = toFiniteNumber(payload.maxRating) ?? defaults.maxRating;
  const round = toFiniteNumber(payload.round) ?? defaults.round;
  return {
    K,
    D,
    B,
    minRating,
    maxRating,
    round: Math.max(0, Math.floor(round)),
  };
}

function normalizeMatchResultRatingImpact(payload: unknown): MatchResultRatingImpactEntry[] {
  if (!Array.isArray(payload)) return [];
  const result: MatchResultRatingImpactEntry[] = [];

  payload.forEach((item) => {
    if (!isRecordObject(item)) return;
    const before = toFiniteNumber(item.before);
    const after = toFiniteNumber(item.after);
    if (before == null || after == null) return;
    const deltaRaw = toFiniteNumber(item.delta);
    const delta = deltaRaw ?? roundToPrecision(after - before, MATCH_RESULT_RATING_DEFAULT_PARAMS.round);
    const teamRaw = typeof item.team === "string" ? item.team.trim().toUpperCase() : "";
    const expected = toFiniteNumber(item.expected) ?? 0;
    const actual = toFiniteNumber(item.actual) ?? 0;

    result.push({
      id: typeof item.id === "string" ? item.id.trim() || null : null,
      name: typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : "Игрок",
      phoneNorm: normalizePhoneForGame(
        typeof item.phoneNorm === "string" ? item.phoneNorm : null,
      ),
      team: teamRaw === "A" || teamRaw === "B" ? teamRaw : null,
      before,
      expected,
      actual,
      delta,
      after,
      gradeAfter: typeof item.gradeAfter === "string" && item.gradeAfter.trim()
        ? item.gradeAfter.trim().toUpperCase()
        : mapNumericToRatingGrade(after),
    });
  });

  return result;
}

function normalizeMatchResultVivaSync(payload: unknown): MatchResultVivaSyncState | null {
  if (!isRecordObject(payload)) return null;

  const rawStatus = typeof payload.status === "string"
    ? payload.status.trim().toUpperCase()
    : "";
  const status: MatchResultVivaSyncStatus | null =
    rawStatus === "PENDING"
    || rawStatus === "SUCCESS"
    || rawStatus === "PARTIAL_SUCCESS"
    || rawStatus === "FAILED"
      ? rawStatus
      : null;

  const attempts = Math.max(
    0,
    Math.floor(toFiniteNumber(payload.attempts) ?? toFiniteNumber(payload.attemptCount) ?? 0),
  );
  const lastAttemptAt = typeof payload.lastAttemptAt === "string" ? payload.lastAttemptAt : null;
  const lastSuccessAt = typeof payload.lastSuccessAt === "string" ? payload.lastSuccessAt : null;
  const lastError = typeof payload.lastError === "string" ? payload.lastError.trim() || null : null;
  const totalPlayers = Math.max(
    0,
    Math.floor(toFiniteNumber(payload.totalPlayers) ?? toFiniteNumber(payload.totalCount) ?? 0),
  );
  const syncedPlayers = Math.max(
    0,
    Math.floor(toFiniteNumber(payload.syncedPlayers) ?? toFiniteNumber(payload.successCount) ?? 0),
  );
  const rawFailures = Array.isArray(payload.failures)
    ? payload.failures
    : Array.isArray(payload.failedPlayers)
      ? payload.failedPlayers
      : [];
  const failures = rawFailures
    .map((item) => {
      if (!isRecordObject(item)) return null;
      return {
        id: typeof item.id === "string" ? item.id.trim() || null : null,
        phone: typeof item.phone === "string" ? normalizePhoneForGame(item.phone) : null,
        name: typeof item.name === "string" ? item.name.trim() || null : null,
        reason: typeof item.reason === "string"
          ? item.reason.trim() || null
          : typeof item.error === "string"
            ? item.error.trim() || null
            : null,
      };
    })
    .filter((item): item is MatchResultVivaSyncFailure => Boolean(item));

  if (
    !status
    && attempts === 0
    && !lastAttemptAt
    && !lastSuccessAt
    && !lastError
    && totalPlayers === 0
    && syncedPlayers === 0
    && failures.length === 0
  ) {
    return null;
  }

  return {
    status,
    attempts,
    lastAttemptAt,
    lastSuccessAt,
    lastError,
    totalPlayers,
    syncedPlayers,
    failures,
  };
}

function buildMatchResultRatingImpact(
  teamAPlayers: PadelGamePlayer[],
  teamBPlayers: PadelGamePlayer[],
  scoreA: number,
  scoreB: number,
  paramsRaw: unknown,
): MatchResultRatingImpactEntry[] {
  if (teamAPlayers.length === 0 || teamBPlayers.length === 0) return [];
  const params = resolveMatchResultRatingParams(paramsRaw);

  const currentA = teamAPlayers.map((player) => ratingFromAny(player.ratingNumeric ?? player.rating, 2.5));
  const currentB = teamBPlayers.map((player) => ratingFromAny(player.ratingNumeric ?? player.rating, 2.5));

  const actualA = 1 / (1 + Math.exp(-params.B * (scoreA - scoreB)));
  const actualB = 1 / (1 + Math.exp(-params.B * (scoreB - scoreA)));
  const powerA = teamRatingPower(currentA);
  const powerB = teamRatingPower(currentB);

  const applyDeltas = (
    players: PadelGamePlayer[],
    ratings: number[],
    opponentPower: number,
    actual: number,
    team: "A" | "B",
  ): MatchResultRatingImpactEntry[] => players.map((player, index) => {
    const before = Number(ratings[index]);
    const expected = 1 / (1 + Math.pow(10, (opponentPower - before) / params.D));
    const delta = roundToPrecision(params.K * (actual - expected), params.round);
    const after = roundToPrecision(
      clampNumber(before + delta, params.minRating, params.maxRating),
      params.round,
    );
    return {
      id: player.id ?? null,
      name: player.name || "Игрок",
      phoneNorm: normalizePhoneForGame(player.phone),
      team,
      before,
      expected: roundToPrecision(expected, params.round),
      actual: roundToPrecision(actual, params.round),
      delta,
      after,
      gradeAfter: mapNumericToRatingGrade(after),
    };
  });

  return [
    ...applyDeltas(teamAPlayers, currentA, powerB, actualA, "A"),
    ...applyDeltas(teamBPlayers, currentB, powerA, actualB, "B"),
  ];
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeMatchResultStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

function isPendingMatchResultStatus(value: unknown): boolean {
  const normalized = normalizeMatchResultStatus(value);
  return normalized === "PENDING_CONFIRMATION" || normalized === "PENDING_DISPUTE";
}

function isConfirmedMatchResultStatus(value: unknown): boolean {
  return normalizeMatchResultStatus(value) === "CONFIRMED";
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getMatchResultDisputeDeadlineAt(
  submittedAt: string | null | undefined,
  explicitDeadlineAt?: string | null | undefined,
): string | null {
  const explicitTs = parseIsoTimestamp(explicitDeadlineAt);
  if (explicitTs != null) {
    return new Date(explicitTs).toISOString();
  }

  const submittedTs = parseIsoTimestamp(submittedAt);
  if (submittedTs == null) return null;
  return new Date(submittedTs + MATCH_RESULT_DISPUTE_WINDOW_MS).toISOString();
}

function formatMatchResultTimeLeft(valueMs: number): string {
  const safeMs = Math.max(0, valueMs);
  const totalMinutes = Math.ceil(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${Math.max(1, totalMinutes)} мин`;
  }

  return `${hours} ч ${String(minutes).padStart(2, "0")} мин`;
}

function normalizeScoreInput(value: string): string {
  return value.replace(/\D/g, "").slice(0, 2);
}

function normalizeEditableScoreSets(rawSets: EditableMatchResultSet[]): EditableMatchResultSet[] {
  const normalized = rawSets.map((item) => ({
    left: normalizeScoreInput(item.left),
    right: normalizeScoreInput(item.right),
  }));

  if (normalized.length === 0) {
    return [{ left: "", right: "" }];
  }

  while (
    normalized.length > 1
    && normalized[normalized.length - 1].left === ""
    && normalized[normalized.length - 1].right === ""
    && normalized[normalized.length - 2].left === ""
    && normalized[normalized.length - 2].right === ""
  ) {
    normalized.pop();
  }

  const last = normalized[normalized.length - 1];
  if (
    last
    && last.left !== ""
    && last.right !== ""
    && normalized.length < MAX_MATCH_RESULT_SETS
  ) {
    normalized.push({ left: "", right: "" });
  }

  return normalized.slice(0, MAX_MATCH_RESULT_SETS);
}

function isDataImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value.trim());
}

function isAttachmentImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  if (!normalized) return false;
  if (isDataImageUrl(normalized)) return true;
  if (/^https?:\/\//i.test(normalized)) return true;
  if (/^\//.test(normalized)) return true;
  return false;
}

function normalizeMatchResultAttachments(raw: unknown): MatchResultAttachment[] {
  if (!Array.isArray(raw)) return [];
  const normalized: MatchResultAttachment[] = [];
  const seenIds = new Set<string>();

  raw.forEach((item, index) => {
    if (isAttachmentImageUrl(item)) {
      const id = `photo-${index + 1}`;
      if (seenIds.has(id)) return;
      seenIds.add(id);
      normalized.push({
        id,
        name: `Фото ${index + 1}`,
        type: "image/jpeg",
        size: null,
        dataUrl: item.trim(),
        createdAt: new Date().toISOString(),
        source: "gallery",
      });
      return;
    }

    if (!isRecordObject(item)) return;
    const dataUrl = isAttachmentImageUrl(item.dataUrl)
      ? item.dataUrl.trim()
      : isAttachmentImageUrl(item.url)
        ? item.url.trim()
        : null;
    if (!dataUrl) return;

    const idRaw = typeof item.id === "string" ? item.id.trim() : "";
    const id = idRaw || `photo-${index + 1}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    normalized.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : `Фото ${index + 1}`,
      type: typeof item.type === "string" && item.type.trim() ? item.type.trim() : "image/jpeg",
      size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : null,
      dataUrl,
      createdAt:
        typeof item.createdAt === "string" && item.createdAt.trim()
          ? item.createdAt.trim()
          : new Date().toISOString(),
      source:
        item.source === "camera" || item.source === "gallery"
          ? item.source
          : "gallery",
    });
  });

  return normalized.slice(0, MAX_MATCH_RESULT_ATTACHMENTS);
}

function normalizeGameLeaveEvents(raw: unknown): GameLeaveEvent[] {
  if (!Array.isArray(raw)) return [];
  const normalized: GameLeaveEvent[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    if (!isRecordObject(item)) return;

    const leftAtRaw =
      (typeof item.leftAt === "string" && item.leftAt.trim())
      || (typeof item.createdAt === "string" && item.createdAt.trim())
      || (typeof item.updatedAt === "string" && item.updatedAt.trim())
      || "";
    if (!leftAtRaw) return;

    const leftAtTs = Date.parse(leftAtRaw);
    if (!Number.isFinite(leftAtTs)) return;
    const leftAt = new Date(leftAtTs).toISOString();

    const playerId = typeof item.playerId === "string"
      ? item.playerId.trim() || null
      : typeof item.id === "string"
        ? item.id.trim() || null
        : null;
    const playerPhone = normalizePhoneForGame(
      typeof item.playerPhone === "string"
        ? item.playerPhone
        : typeof item.phone === "string"
          ? item.phone
          : null,
    );
    const playerName = typeof item.playerName === "string" && item.playerName.trim()
      ? item.playerName.trim()
      : typeof item.name === "string" && item.name.trim()
        ? item.name.trim()
        : null;

    const byId = typeof item.byId === "string"
      ? item.byId.trim() || null
      : typeof item.actorId === "string"
        ? item.actorId.trim() || null
        : null;
    const byPhone = normalizePhoneForGame(
      typeof item.byPhone === "string"
        ? item.byPhone
        : typeof item.actorPhone === "string"
          ? item.actorPhone
          : null,
    );
    const byName = typeof item.byName === "string" && item.byName.trim()
      ? item.byName.trim()
      : typeof item.actorName === "string" && item.actorName.trim()
        ? item.actorName.trim()
        : null;
    const reason = typeof item.reason === "string" && item.reason.trim()
      ? item.reason.trim().toUpperCase()
      : null;

    const dedupeKey = [
      playerPhone || playerId || playerName || `idx-${index}`,
      leftAt,
      reason || "",
    ].join("|");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    normalized.push({
      playerId,
      playerPhone,
      playerName,
      leftAt,
      reason,
      byId,
      byPhone,
      byName,
    });
  });

  return normalized.sort((left, right) => Date.parse(right.leftAt) - Date.parse(left.leftAt));
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("file_read_failed"));
    };
    reader.onerror = () => reject(new Error("file_read_failed"));
    reader.readAsDataURL(file);
  });
}

async function optimizeImageDataUrl(
  dataUrl: string,
  sourceMime: string,
  maxSide = MATCH_RESULT_IMAGE_MAX_SIDE,
): Promise<string> {
  if (typeof window === "undefined") return dataUrl;
  if (!isDataImageUrl(dataUrl)) return dataUrl;

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        resolve(dataUrl);
        return;
      }

      const scale = Math.min(1, maxSide / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(dataUrl);
        return;
      }
      ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
      const targetMime = /^image\/(png|webp|jpeg|jpg)$/i.test(sourceMime) ? sourceMime : "image/jpeg";
      try {
        const result = canvas.toDataURL(targetMime, 0.84);
        resolve(result || dataUrl);
      } catch {
        resolve(dataUrl);
      }
    };
    image.onerror = () => resolve(dataUrl);
    image.src = dataUrl;
  });
}

function formatMatchResultPhotoScore(sets: EditableMatchResultSet[]): string | null {
  const completedSets = sets.filter((setItem) => setItem.left !== "" && setItem.right !== "");
  if (completedSets.length === 0) return null;
  return completedSets.map((setItem) => `${setItem.left}:${setItem.right}`).join(" · ");
}

async function resolveMatchResultPhotoLogoVariant(
  imageSrc: string,
): Promise<MatchResultPhotoLogoVariant> {
  const normalizedSrc = imageSrc.trim();
  if (typeof window === "undefined" || !normalizedSrc) return "white";

  return new Promise((resolve) => {
    const image = new Image();
    if (!isDataImageUrl(normalizedSrc)) {
      image.crossOrigin = "anonymous";
    }

    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;
      if (!width || !height) {
        resolve("white");
        return;
      }

      const sourceWidth = Math.max(1, Math.round(width * 0.28));
      const sourceHeight = Math.max(1, Math.round(height * 0.28));
      const sourceX = Math.max(0, width - sourceWidth);
      const sourceY = Math.max(0, height - sourceHeight);
      const targetWidth = Math.max(1, Math.min(96, sourceWidth));
      const targetHeight = Math.max(1, Math.min(96, sourceHeight));

      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) {
        resolve("white");
        return;
      }

      try {
        ctx.drawImage(
          image,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          targetWidth,
          targetHeight,
        );

        const { data } = ctx.getImageData(0, 0, targetWidth, targetHeight);
        let luminanceTotal = 0;
        let alphaTotal = 0;

        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3] / 255;
          if (alpha <= 0) continue;

          const luminance =
            (0.2126 * data[index]) + (0.7152 * data[index + 1]) + (0.0722 * data[index + 2]);
          luminanceTotal += luminance * alpha;
          alphaTotal += alpha;
        }

        if (alphaTotal <= 0) {
          resolve("white");
          return;
        }

        const averageLuminance = luminanceTotal / alphaTotal;
        resolve(averageLuminance >= 170 ? "black" : "white");
      } catch {
        resolve("white");
      }
    };

    image.onerror = () => resolve("white");
    image.src = normalizedSrc;
  });
}

async function loadCanvasImage(src: string): Promise<HTMLImageElement | null> {
  const normalizedSrc = src.trim();
  if (!normalizedSrc) return null;

  return new Promise((resolve) => {
    const image = new Image();
    if (!isDataImageUrl(normalizedSrc)) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = normalizedSrc;
  });
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

function downloadBlob(blob: Blob, fileName: string) {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function resolveFittedFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  initialSize: number,
  minSize: number,
  fontWeight: number,
) {
  let fontSize = Math.max(minSize, initialSize);
  while (fontSize > minSize) {
    ctx.font = `${fontWeight} ${fontSize}px Arial`;
    if (ctx.measureText(text).width <= maxWidth) break;
    fontSize -= 1;
  }
  return fontSize;
}

async function createMatchResultPhotoBlob(options: {
  photoSrc: string;
  logoSrc: string;
  logoVariant: MatchResultPhotoLogoVariant;
  scoreText: string | null;
}): Promise<Blob | null> {
  if (typeof document === "undefined") return null;

  const [photoImage, logoImage] = await Promise.all([
    loadCanvasImage(options.photoSrc),
    loadCanvasImage(options.logoSrc),
  ]);
  if (!photoImage || !logoImage) return null;

  const width = photoImage.naturalWidth || photoImage.width;
  const height = photoImage.naturalHeight || photoImage.height;
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(photoImage, 0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, height * 0.28, 0, height);
  if (options.logoVariant === "black") {
    gradient.addColorStop(0.28, "rgba(255, 255, 255, 0.03)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0.78)");
  } else {
    gradient.addColorStop(0.28, "rgba(10, 15, 25, 0.02)");
    gradient.addColorStop(1, "rgba(10, 15, 25, 0.62)");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  const padding = clampNumber(Math.round(width * 0.042), 24, 60);
  const gap = clampNumber(Math.round(width * 0.018), 12, 22);
  const logoWidth = clampNumber(Math.round(width * 0.16), 54, 124);
  const logoHeight = logoImage.naturalWidth
    ? Math.round((logoWidth / logoImage.naturalWidth) * (logoImage.naturalHeight || logoWidth))
    : logoWidth;
  const textColor = options.logoVariant === "black" ? "#111827" : "#FFFFFF";
  const labelColor = options.logoVariant === "black"
    ? "rgba(15, 23, 42, 0.7)"
    : "rgba(255, 255, 255, 0.76)";
  const shadowColor = options.logoVariant === "black"
    ? "rgba(255, 255, 255, 0.32)"
    : "rgba(0, 0, 0, 0.38)";
  const scoreText = options.scoreText || "Счёт не внесён";
  const scoreInitialFontSize = options.scoreText
    ? clampNumber(Math.round(width * 0.064), 28, 76)
    : clampNumber(Math.round(width * 0.034), 18, 34);
  const scoreMinFontSize = options.scoreText ? 18 : 14;
  const scoreMaxWidth = Math.max(100, width - (padding * 2) - logoWidth - gap);
  const labelFontSize = clampNumber(Math.round(width * 0.016), 11, 22);
  const scoreFontSize = resolveFittedFontSize(
    ctx,
    scoreText,
    scoreMaxWidth,
    scoreInitialFontSize,
    scoreMinFontSize,
    800,
  );
  const labelY = height - padding - scoreFontSize - Math.max(14, Math.round(scoreFontSize * 0.34));
  const scoreY = height - padding;
  const logoX = width - padding - logoWidth;
  const logoY = height - padding - logoHeight + 4;

  ctx.save();
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = labelColor;
  ctx.font = `700 ${labelFontSize}px Arial`;
  ctx.fillText("РЕЗУЛЬТАТ МАТЧА", padding, labelY);

  ctx.fillStyle = textColor;
  ctx.shadowColor = shadowColor;
  ctx.shadowBlur = Math.round(width * 0.015);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;
  ctx.font = `800 ${scoreFontSize}px Arial`;
  ctx.fillText(scoreText, padding, scoreY, scoreMaxWidth);
  ctx.restore();

  ctx.drawImage(logoImage, logoX, logoY, logoWidth, logoHeight);

  return canvasToBlob(canvas);
}

function toDateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const directDate = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directDate?.[1]) return directDate[1];
  const fromIso = value.match(/(\d{4}-\d{2}-\d{2})T/);
  if (fromIso?.[1]) return fromIso[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDateLocalIso(parsed);
}

function toTimeKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const direct = value.match(/^(\d{2}:\d{2})/);
  if (direct?.[1]) return direct[1];
  const fromIso = value.match(/T(\d{2}:\d{2})/);
  if (fromIso?.[1]) return fromIso[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${String(parsed.getHours()).padStart(2, "0")}:${String(parsed.getMinutes()).padStart(2, "0")}`;
}

function buildMatchSnapshotFromPayload(payload: PadelGameRecordPayload): MatchSnapshot {
  const date =
    toDateKey(payload.booking.date) ??
    toDateKey(payload.booking.timeFromIso) ??
    toDateKey(payload.booking.timeToIso);
  const timeFrom = toTimeKey(payload.booking.timeFrom) ?? toTimeKey(payload.booking.timeFromIso);
  const timeTo = toTimeKey(payload.booking.timeTo) ?? toTimeKey(payload.booking.timeToIso);

  return {
    studioName: payload.booking.studioName ?? null,
    roomName: payload.booking.roomName ?? null,
    date,
    timeFrom,
    timeTo,
    durationMinutes: payload.booking.durationMinutes ?? null,
    amount: payload.payment.amount ?? null,
  };
}

function buildMatchSnapshotFromRecord(record: PadelGameRecord): MatchSnapshot | null {
  if (!record.booking && !record.payment) return null;
  const booking = record.booking;
  return {
    studioName: booking?.studioName ?? null,
    roomName: booking?.roomName ?? null,
    date: toDateKey(booking?.date),
    timeFrom: toTimeKey(booking?.timeFrom),
    timeTo: toTimeKey(booking?.timeTo),
    durationMinutes: booking?.durationMinutes ?? null,
    amount: record.payment?.amount ?? null,
  };
}

function extractPromoStateSnapshot(
  metadata: unknown,
  paymentAmountValue: unknown,
): PromoStateSnapshot | null {
  if (!isRecordObject(metadata)) return null;
  const code = typeof metadata.promoCode === "string" ? metadata.promoCode.trim() : "";
  if (!code) return null;

  return {
    code,
    discountAmount: toFiniteNumber(metadata.promoDiscount),
    paymentAmount: toFiniteNumber(paymentAmountValue),
  };
}

function mergeMatchSnapshots(current: MatchSnapshot | null, incoming: MatchSnapshot | null) {
  if (!incoming) return current;
  if (!current) return incoming;
  return {
    studioName: incoming.studioName ?? current.studioName,
    roomName: incoming.roomName ?? current.roomName,
    date: incoming.date ?? current.date,
    timeFrom: incoming.timeFrom ?? current.timeFrom,
    timeTo: incoming.timeTo ?? current.timeTo,
    durationMinutes: incoming.durationMinutes ?? current.durationMinutes,
    amount: incoming.amount ?? current.amount,
  };
}

function upsertPadelGameRecord(
  current: PadelGameRecord[],
  incoming: PadelGameRecord,
): PadelGameRecord[] {
  const mergedIncoming = mergePadelGameRecord(null, incoming);
  const normalizedIncomingInvite = normalizeInviteUrl(incoming.inviteUrl);
  const existingIndex = current.findIndex((item) => item.id === incoming.id);
  if (existingIndex < 0) {
    return [{ ...mergedIncoming, inviteUrl: normalizedIncomingInvite }, ...current];
  }

  const existing = current[existingIndex];
  const merged = mergePadelGameRecord(existing, incoming);

  const next = [...current];
  next[existingIndex] = merged;
  return next;
}

function notifyGameRecordsUpdated(records: PadelGameRecord[], source: string): void {
  if (typeof window === "undefined" || records.length === 0) return;
  window.dispatchEvent(new CustomEvent("lk-games-updated", {
    detail: {
      records,
      source,
    },
  }));
}

function mergePadelGamePlayers(
  current: PadelGamePlayer[] = [],
  incoming: PadelGamePlayer[] = [],
): PadelGamePlayer[] {
  const merged = new Map<string, PadelGamePlayer>();

  [...current, ...incoming].forEach((player, index) => {
    const key = getPadelPlayerIdentityKey(player) || `player:${index}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, player);
      return;
    }
    merged.set(key, {
      ...existing,
      ...player,
      id: player.id ?? existing.id,
      name: player.name || existing.name,
      phone: player.phone ?? existing.phone,
      photo: player.photo ?? existing.photo,
      rating: player.rating ?? existing.rating,
      ratingNumeric: player.ratingNumeric ?? existing.ratingNumeric,
      source: player.source ?? existing.source,
      status: player.status ?? existing.status,
    });
  });

  return Array.from(merged.values());
}

function mergePadelGameRecord(
  current: PadelGameRecord | null | undefined,
  incoming: PadelGameRecord,
): PadelGameRecord {
  const normalizedIncomingInvite = normalizeInviteUrl(incoming.inviteUrl);
  if (!current) {
    return {
      ...incoming,
      inviteUrl: normalizedIncomingInvite,
    };
  }

  const normalizedExistingInvite = normalizeInviteUrl(current.inviteUrl);
  return {
    ...current,
    ...incoming,
    inviteUrl: normalizedIncomingInvite ?? normalizedExistingInvite,
    status: incoming.status ?? current.status,
    organizer: incoming.organizer || current.organizer
      ? {
          ...(current.organizer ?? {}),
          ...(incoming.organizer ?? {}),
          id: incoming.organizer?.id ?? current.organizer?.id ?? null,
          name: incoming.organizer?.name ?? current.organizer?.name ?? null,
          phone: incoming.organizer?.phone ?? current.organizer?.phone ?? null,
          photo: incoming.organizer?.photo ?? current.organizer?.photo ?? null,
          rating: incoming.organizer?.rating ?? current.organizer?.rating ?? null,
          ratingNumeric: incoming.organizer?.ratingNumeric ?? current.organizer?.ratingNumeric ?? null,
        }
      : null,
    settings: incoming.settings ?? current.settings ?? null,
    participants: mergePadelGamePlayers(current.participants ?? [], incoming.participants ?? []),
    waitlist: mergePadelGamePlayers(current.waitlist ?? [], incoming.waitlist ?? []),
    chatUrl: incoming.chatUrl ?? current.chatUrl ?? null,
    metadata: incoming.metadata ?? current.metadata ?? null,
    booking: incoming.booking ?? current.booking ?? null,
    payment: incoming.payment ?? current.payment ?? null,
  };
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

function AvatarWithInitialsFallback({
  src,
  alt,
  imageClassName,
  fallbackClassName,
  fallbackText,
  fallbackStyle,
}: {
  src: string | null | undefined;
  alt: string;
  imageClassName: string;
  fallbackClassName: string;
  fallbackText: string;
  fallbackStyle?: CSSProperties;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const normalizedSrc = (src || "").trim();
  const showImage = Boolean(normalizedSrc) && !imageFailed;

  useEffect(() => {
    setImageFailed(false);
  }, [normalizedSrc]);

  if (showImage) {
    return (
      <img
        className={imageClassName}
        src={normalizedSrc}
        alt={alt}
        onError={() => setImageFailed(true)}
      />
    );
  }

  return (
    <div className={fallbackClassName} style={fallbackStyle}>
      {fallbackText}
    </div>
  );
}

function getPadelPlayerIdentityKey(player: PadelGamePlayer | null | undefined): string {
  if (!player) return "";
  const byPhone = normalizePhoneForGame(player.phone);
  if (byPhone) return `phone:${byPhone}`;
  const byId = (player.id || "").trim();
  if (byId) return `id:${byId}`;
  const byName = (player.name || "").trim().toLowerCase();
  if (byName) return `name:${byName}`;
  return "";
}

type EnrichedPadelPlayerData = {
  id: string | null;
  phone: string | null;
  name: string | null;
  photo: string | null;
  rating: string | null;
  ratingNumeric: number | null;
};

function getPadelPlayerLookupKeys(player: {
  id?: string | null;
  phone?: string | null;
  name?: string | null;
}) {
  const keys: string[] = [];
  const id = (player.id || "").trim();
  const phone = normalizePhoneForGame(player.phone);
  const name = (player.name || "").trim().toLowerCase();
  if (id) keys.push(`id:${id}`);
  if (phone) keys.push(`phone:${phone}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function mergePadelPlayerFreshData(
  player: PadelGamePlayer,
  fresh: EnrichedPadelPlayerData | undefined,
): PadelGamePlayer {
  if (!fresh) return player;
  const freshRatingNumeric = normalizeRatingNumeric(fresh.ratingNumeric);
  const nextRating =
    (fresh.rating || "").trim()
    || (freshRatingNumeric != null ? mapNumericToRatingGrade(freshRatingNumeric) : "")
    || player.rating
    || null;
  const nextPlayer: PadelGamePlayer = {
    ...player,
    id: fresh.id ?? player.id,
    phone: fresh.phone ?? player.phone,
    name: fresh.name?.trim() || player.name,
    photo: fresh.photo ?? player.photo ?? null,
    rating: nextRating,
    ratingNumeric: freshRatingNumeric ?? player.ratingNumeric ?? null,
  };
  return (
    nextPlayer.id === player.id
    && nextPlayer.phone === player.phone
    && nextPlayer.name === player.name
    && nextPlayer.photo === (player.photo ?? null)
    && nextPlayer.rating === (player.rating ?? null)
    && nextPlayer.ratingNumeric === (player.ratingNumeric ?? null)
  ) ? player : nextPlayer;
}

function mergePadelOrganizerFreshData(
  organizer: PadelGameRecord["organizer"],
  fresh: EnrichedPadelPlayerData | undefined,
) {
  if (!organizer || !fresh) return organizer;
  const freshRatingNumeric = normalizeRatingNumeric(fresh.ratingNumeric);
  const nextRating =
    (fresh.rating || "").trim()
    || (freshRatingNumeric != null ? mapNumericToRatingGrade(freshRatingNumeric) : "")
    || organizer.rating
    || null;
  const nextOrganizer = {
    ...organizer,
    // Keep organizer identity and display name from game payload whenever present.
    id: organizer.id ?? fresh.id ?? null,
    phone: organizer.phone ?? fresh.phone ?? null,
    name: organizer.name || fresh.name?.trim() || null,
    photo: organizer.photo ?? fresh.photo ?? null,
    rating: nextRating,
    ratingNumeric: freshRatingNumeric ?? organizer.ratingNumeric ?? null,
  };
  return (
    nextOrganizer.id === organizer.id
    && nextOrganizer.phone === organizer.phone
    && nextOrganizer.name === organizer.name
    && nextOrganizer.photo === (organizer.photo ?? null)
    && nextOrganizer.rating === (organizer.rating ?? null)
    && nextOrganizer.ratingNumeric === (organizer.ratingNumeric ?? null)
  ) ? organizer : nextOrganizer;
}

function dedupePlayersByIdentity(
  players: Array<PadelGamePlayer | null | undefined>,
): PadelGamePlayer[] {
  const map = new Map<string, PadelGamePlayer>();
  players.forEach((player, index) => {
    if (!player) return;
    const key = getPadelPlayerIdentityKey(player) || `slot-${index}`;
    if (map.has(key)) return;
    map.set(key, player);
  });
  return Array.from(map.values());
}

function buildPadelPlayersRefreshKey(
  gameId: string | null | undefined,
  participants: PadelGamePlayer[],
  waitlist: PadelGamePlayer[],
  organizer: PadelGameRecord["organizer"] | null | undefined,
) {
  const encodePlayer = (player: PadelGamePlayer | null | undefined) => {
    if (!player) return "";
    return [
      getPadelPlayerIdentityKey(player),
    ].join("|");
  };

  const organizerKey = organizer
    ? [
      (organizer.id || "").trim(),
      normalizePhoneForGame(organizer.phone) || "",
    ].join("|")
    : "";

  return [
    gameId || "",
    organizerKey,
    participants.map((player) => encodePlayer(player)).join(";"),
    waitlist.map((player) => encodePlayer(player)).join(";"),
  ].join("::");
}

function areTeamSlotsEqualByIdentity(
  left: Array<PadelGamePlayer | null | undefined>,
  right: Array<PadelGamePlayer | null | undefined>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((player, index) => (
    getPadelPlayerIdentityKey(player) === getPadelPlayerIdentityKey(right[index])
  ));
}

function cloneTeamSlots(
  slots: Array<PadelGamePlayer | null | undefined>,
): MatchResultSetPairingSlots {
  return Array.from({ length: DETAILS_TEAM_SLOTS_COUNT }, (_, index) => slots[index] ?? null);
}

function buildStoredTeamSlotsRefs(
  slots: Array<PadelGamePlayer | null | undefined>,
): Array<TeamSlotStoredRef | null> {
  return cloneTeamSlots(slots).map<TeamSlotStoredRef | null>((player) => {
    if (!player) return null;
    return {
      id: player.id ?? null,
      phone: normalizePhoneForGame(player.phone),
      name: player.name || null,
    };
  });
}

function createEmptyMatchResultSetPairings(): Array<MatchResultSetPairingSlots | null> {
  return Array.from({ length: MAX_MATCH_RESULT_SETS }, () => null);
}

function buildMatchResultSetPairingsPayload(
  pairings: Array<MatchResultSetPairingSlots | null>,
): MatchResultSetPairingStored[] {
  return pairings
    .map<MatchResultSetPairingStored | null>((teamSlots, setIndex) => {
      if (!teamSlots || !teamSlots.some(Boolean)) return null;
      return {
        setIndex,
        teamSlots: buildStoredTeamSlotsRefs(teamSlots),
      };
    })
    .filter((item): item is MatchResultSetPairingStored => Boolean(item));
}

function materializeCompletedMatchResultSetPairings(
  pairings: Array<MatchResultSetPairingSlots | null>,
  completedSetCount: number,
): Array<MatchResultSetPairingSlots | null> {
  const nextPairings = pairings.map((teamSlots) => (
    teamSlots ? cloneTeamSlots(teamSlots) : null
  ));
  const safeCompletedSetCount = Math.max(0, Math.min(MAX_MATCH_RESULT_SETS, completedSetCount));
  let lastKnownPairing: MatchResultSetPairingSlots | null = null;

  for (let setIndex = 0; setIndex < safeCompletedSetCount; setIndex += 1) {
    const currentPairing = nextPairings[setIndex];
    if (currentPairing && currentPairing.some(Boolean)) {
      lastKnownPairing = cloneTeamSlots(currentPairing);
      continue;
    }

    if (!lastKnownPairing) continue;
    nextPairings[setIndex] = cloneTeamSlots(lastKnownPairing);
  }

  return nextPairings;
}

function buildVisibleMatchResultSetPairings(
  pairings: Array<MatchResultSetPairingSlots | null>,
  visibleSetCount: number,
  fallbackSlots?: Array<PadelGamePlayer | null | undefined>,
): Array<MatchResultSetPairingSlots | null> {
  const nextPairings = materializeCompletedMatchResultSetPairings(
    Array.from({ length: visibleSetCount }, (_, index) => (
      pairings[index] ? cloneTeamSlots(pairings[index]) : null
    )),
    visibleSetCount,
  );

  if (nextPairings.some((teamSlots) => teamSlots && teamSlots.some(Boolean))) {
    return nextPairings;
  }

  const fallbackPairing = fallbackSlots ? cloneTeamSlots(fallbackSlots) : null;
  if (!fallbackPairing || !fallbackPairing.some(Boolean)) {
    return nextPairings;
  }

  return Array.from({ length: visibleSetCount }, () => cloneTeamSlots(fallbackPairing));
}

function formatMatchResultPairTeamLabel(
  slots: Array<PadelGamePlayer | null | undefined>,
  slotIndexes: number[],
): string | null {
  const names = slotIndexes
    .map((slotIndex) => slots[slotIndex]?.name?.trim() || null)
    .filter((value): value is string => Boolean(value));
  if (names.length === 0) return null;
  return names.join(" + ");
}

function getMatchResultPairTeamPlayers(
  slots: Array<PadelGamePlayer | null | undefined>,
  slotIndexes: number[],
): PadelGamePlayer[] {
  return slotIndexes
    .map((slotIndex) => slots[slotIndex] ?? null)
    .filter((player): player is PadelGamePlayer => Boolean(player));
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

function normalizePhoneForGame(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function getCommunityActorLevelScore(
  numericRating: number | null,
  letterGrade: string | null | undefined,
): number {
  if (typeof numericRating === "number" && Number.isFinite(numericRating)) {
    return Math.max(1.5, Math.min(6, numericRating));
  }

  const normalizedGrade = String(letterGrade || "").trim().toUpperCase();
  const matchedIndex = RATING_LABELS.findIndex((item) => item === normalizedGrade);
  if (matchedIndex >= 0) {
    return matchedIndex + 1.5;
  }

  return 3.2;
}

function buildCommunityGamePostBody(game: PadelGameRecord) {
  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const participantComment = extractGameParticipantComment(
    metadata,
  );
  const joinPriceLabel = formatGameJoinPriceLabel(extractGameJoinPrice(metadata));
  const date = game.booking?.date
    ? new Date(`${game.booking.date}T00:00:00`).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "long",
      })
    : "ближайшая дата";
  const timeFrom = game.booking?.timeFrom ?? "—:—";
  const timeTo = game.booking?.timeTo ?? "—:—";
  const location = [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(", ");

  return [
    [date, `${timeFrom} - ${timeTo}`, location].filter(Boolean).join(" • "),
    joinPriceLabel ? `Стоимость присоединения: ${joinPriceLabel}` : null,
    participantComment ? `Комментарий: ${participantComment}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCommunityGamePreviewLabel(game: PadelGameRecord) {
  return [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(" • ") || "Матч сообщества";
}

function isCommunityMemberForAutopublish(
  community: {
    members: Array<{
      id: string | null;
      phone: string | null;
    }>;
  },
  profileId: string | null,
  profilePhoneNorm: string | null,
) {
  const normalizedProfileId = (profileId || "").trim();
  return community.members.some((member) => {
    const byId = Boolean(normalizedProfileId && member.id && member.id === normalizedProfileId);
    const byPhone = Boolean(
      profilePhoneNorm
      && member.phone
      && normalizePhoneForGame(member.phone) === profilePhoneNorm,
    );
    return byId || byPhone;
  });
}

function getCommunityAutopublishInitials(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  const initials = parts
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "C";
}

function getCommunityAutopublishPalette(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    start: `hsla(${hue}, 70%, 54%, 0.95)`,
    end: `hsla(${(hue + 38) % 360}, 78%, 48%, 0.92)`,
  };
}

function normalizeCommunityStationToken(value: unknown): string | null {
  const normalized = normalizeComparableName(value);
  if (!normalized) return null;

  const compact = normalized
    .replace(/\b(хаб|hub|padel|падел|club|клуб|community|сообщество|станция)\b/gi, " ")
    .replace(/[^a-zа-я0-9\s]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return compact || normalized;
}

function findStationCommunityForAutopublish<T extends { name: string }>(
  communities: T[],
  stationName: string | null,
): T | null {
  const stationToken = normalizeCommunityStationToken(stationName);
  if (!stationToken) return null;

  const stationWords = stationToken.split(" ").filter((part) => part.length > 2);
  let bestMatch: T | null = null;
  let bestScore = 0;

  communities.forEach((community) => {
    const communityToken = normalizeCommunityStationToken(community.name);
    if (!communityToken) return;

    let score = 0;
    if (communityToken === stationToken) {
      score = 5;
    } else if (communityToken.includes(stationToken) || stationToken.includes(communityToken)) {
      score = 4;
    } else {
      const communityWords = new Set(communityToken.split(" ").filter((part) => part.length > 2));
      let overlap = 0;
      stationWords.forEach((word) => {
        if (communityWords.has(word)) overlap += 1;
      });
      if (overlap >= 2) score = 3;
      else if (overlap === 1) score = 2;
    }

    if (!score) return;
    if (!bestMatch || score > bestScore) {
      bestMatch = community;
      bestScore = score;
      return;
    }

    if (bestScore === score && community.name.length < bestMatch.name.length) {
      bestMatch = community;
    }
  });

  return bestMatch;
}

function extractCommunityAutopublishPostsMap(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, string> {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload) {
    return {};
  }
  const posts = isRecordObject(payload.posts) ? payload.posts : null;
  if (!posts) return {};

  const next: Record<string, string> = {};
  Object.entries(posts).forEach(([communityId, postId]) => {
    const normalizedCommunityId = communityId.trim();
    const normalizedPostId = typeof postId === "string" ? postId.trim() : "";
    if (!normalizedCommunityId || !normalizedPostId) return;
    next[normalizedCommunityId] = normalizedPostId;
  });
  return next;
}

function extractCommunityAutopublishSelectionState(
  metadata: Record<string, unknown> | null | undefined,
): CommunityAutopublishSelectionState {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload) {
    return {
      selectedCommunityIds: [],
      stationCommunityId: null,
      selectionTouched: false,
    };
  }
  const selectedCommunityIds = Array.isArray(payload.selectedCommunityIds)
    ? Array.from(new Set(
        payload.selectedCommunityIds
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter(Boolean),
      ))
    : [];
  const stationCommunityId = typeof payload.stationCommunityId === "string"
    ? payload.stationCommunityId.trim() || null
    : null;
  const selectionTouched = typeof payload.selectionTouched === "boolean"
    ? payload.selectionTouched
    : selectedCommunityIds.length > 0;

  return {
    selectedCommunityIds,
    stationCommunityId,
    selectionTouched,
  };
}

function extractCommunityAutopublishSavedCommunities(
  metadata: Record<string, unknown> | null | undefined,
): Array<{
  communityId: string;
  communityName: string;
  postId: string | null;
  status: string;
  error: string | null;
}> {
  const payload = getCommunityAutopublishPayload(metadata);
  if (!payload || !Array.isArray(payload.communities)) {
    return [];
  }

  return payload.communities
    .map((value) => {
      if (!isRecordObject(value)) return null;
      const communityId = typeof value.communityId === "string" ? value.communityId.trim() : "";
      const communityName = typeof value.communityName === "string" ? value.communityName.trim() : "";
      if (!communityId) return null;

      return {
        communityId,
        communityName: communityName || communityId,
        postId: typeof value.postId === "string" ? value.postId.trim() || null : null,
        status: typeof value.status === "string" ? value.status.trim().toUpperCase() : "PENDING",
        error: typeof value.error === "string" ? value.error.trim() || null : null,
      };
    })
    .filter((value): value is {
      communityId: string;
      communityName: string;
      postId: string | null;
      status: string;
      error: string | null;
    } => Boolean(value));
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

function writeChatReadMap(phoneNorm: string, map: Record<string, number>) {
  if (typeof window === "undefined" || !phoneNorm) return;
  try {
    window.localStorage.setItem(getChatReadStorageKey(phoneNorm), JSON.stringify(map));
  } catch {
    // Ignore storage errors
  }
}

function addMinutesToTime(timeValue: string, minutesToAdd: number): string {
  const [hoursRaw, minutesRaw] = timeValue.split(":");
  const hours = Number.parseInt(hoursRaw ?? "", 10);
  const minutes = Number.parseInt(minutesRaw ?? "", 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return timeValue;

  const dayMinutes = 24 * 60;
  const total = hours * 60 + minutes + minutesToAdd;
  const normalized = ((total % dayMinutes) + dayMinutes) % dayMinutes;
  const nextHours = String(Math.floor(normalized / 60)).padStart(2, "0");
  const nextMinutes = String(normalized % 60).padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}

function mergeChatMessages(
  current: PadelGameChatMessage[],
  incoming: PadelGameChatMessage[],
): PadelGameChatMessage[] {
  const keyFor = (message: PadelGameChatMessage) => {
    const sender = message.sender?.phoneNorm || message.sender?.id || "unknown";
    return `${message.createdTs}|${sender}|${message.text}`;
  };

  const bucket = new Map<string, PadelGameChatMessage>();
  [...current, ...incoming].forEach((message) => {
    bucket.set(keyFor(message), message);
  });

  return Array.from(bucket.values()).sort((left, right) => left.createdTs - right.createdTs);
}

function formatChatTime(value: string | null, fallbackTs: number): string {
  const parsed = resolveChatDate(value, fallbackTs);
  if (!parsed) return "";
  return parsed.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function resolveChatDate(value: string | null, fallbackTs: number): Date | null {
  if (value) {
    const parsedByValue = new Date(value);
    if (!Number.isNaN(parsedByValue.getTime())) {
      return parsedByValue;
    }
  }

  if (Number.isFinite(fallbackTs) && fallbackTs > 0) {
    const parsedByTs = new Date(fallbackTs);
    if (!Number.isNaN(parsedByTs.getTime())) {
      return parsedByTs;
    }
  }

  return null;
}

function getChatDateKey(value: string | null, fallbackTs: number): string {
  const parsed = resolveChatDate(value, fallbackTs);
  if (!parsed) return "";
  const year = parsed.getFullYear();
  const month = `${parsed.getMonth() + 1}`.padStart(2, "0");
  const day = `${parsed.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatChatDateLabel(value: string | null, fallbackTs: number): string {
  const parsed = resolveChatDate(value, fallbackTs);
  if (!parsed) return "";
  const label = parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function getChatSenderStableKey(message: PadelGameChatMessage): string {
  const phone = normalizePhoneForGame(message.sender?.phoneNorm ?? null);
  if (phone) return `phone:${phone}`;
  const senderId = (message.sender?.id || "").trim();
  if (senderId) return `id:${senderId}`;
  const senderName = (message.sender?.name || "").trim().toLowerCase();
  if (senderName) return `name:${senderName}`;
  return "unknown";
}

function pickChatSenderColor(senderKey: string): string {
  if (!senderKey) return CHAT_MESSAGE_BG_PALETTE[0];
  let hash = 0;
  for (let index = 0; index < senderKey.length; index += 1) {
    hash = (hash * 33 + senderKey.charCodeAt(index)) | 0;
  }
  const safeIndex = Math.abs(hash) % CHAT_MESSAGE_BG_PALETTE.length;
  return CHAT_MESSAGE_BG_PALETTE[safeIndex] ?? CHAT_MESSAGE_BG_PALETTE[0];
}

function normalizeBookingId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function parseBookingIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value
      .map((item) => normalizeBookingId(item))
      .filter((item): item is string => Boolean(item))));
  }

  if (typeof value === "string") {
    return Array.from(new Set(value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)));
  }

  return [];
}

function collectBookingIdsForVivaCheck(
  game: PadelGameRecord | null | undefined,
  fallbackPaymentUrlRaw?: string | null,
): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingId(value);
    if (normalized) bucket.add(normalized);
  };
  const pushMany = (value: unknown) => {
    parseBookingIdsFromUnknown(value).forEach((id) => bucket.add(id));
  };

  const metadata =
    game?.metadata && typeof game.metadata === "object"
      ? game.metadata as Record<string, unknown>
      : null;

  if (metadata) {
    pushMany(metadata.bookingIds);
    push(metadata.bookingId);
    pushMany(metadata.booking_ids);
    push(metadata.booking_id);
  }

  const paymentUrlCandidates = [
    game?.payment?.paymentUrl ?? null,
    fallbackPaymentUrlRaw ?? null,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  paymentUrlCandidates.forEach((urlValue) => {
    try {
      const parsed = new URL(urlValue);
      extractBookingIdsFromUrl(parsed).forEach((bookingId) => push(bookingId));
      return;
    } catch {
      // fallback below
    }

    try {
      if (typeof window === "undefined") return;
      const parsed = new URL(urlValue, window.location.origin);
      extractBookingIdsFromUrl(parsed).forEach((bookingId) => push(bookingId));
    } catch {
      // ignore invalid URL candidates
    }
  });

  return Array.from(bucket);
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
  if (unpaidMarkers.some((marker) => token.includes(marker))) {
    return false;
  }

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
  if (paidMarkers.some((marker) => token.includes(marker))) {
    return true;
  }

  return null;
}

function isGamePaidForCommunityAutopublish(game: PadelGameRecord | null | undefined): boolean {
  if (!game) return false;
  if (game.payment?.paid === true) return true;
  return detectPaidStateByStatusToken(game.status) === true;
}

function resolveBookingPaidState(booking: Booking): boolean | null {
  const cardStatus = detectPaidStateByStatusToken(
    booking.transactionStatus?.cardPaymentStatus?.status ?? null,
  );
  if (cardStatus != null) return cardStatus;

  const cardOriginalStatus = detectPaidStateByStatusToken(
    booking.transactionStatus?.cardPaymentStatus?.originalStatus ?? null,
  );
  if (cardOriginalStatus != null) return cardOriginalStatus;

  return detectPaidStateByStatusToken(booking.transactionStatus?.transactionStatus ?? null);
}

function resolvePaidStateByBookings(bookings: Booking[]): boolean | null {
  const resolved = bookings
    .map((booking) => resolveBookingPaidState(booking))
    .filter((state): state is boolean => state !== null);

  if (resolved.length === 0) return null;
  if (resolved.includes(true)) return true;
  return false;
}

function resolveCancelledStateByBookings(bookings: Booking[]): boolean {
  return bookings.some((booking) => booking.isCancelled === true);
}

function normalizeComparableId(value: unknown): string | null {
  const normalized = normalizeBookingId(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeComparableName(value: unknown): string | null {
  const normalized = normalizeBookingId(value);
  if (!normalized) return null;
  return normalized.toLowerCase().replace(/\s+/g, " ");
}

function findStudioByPreset(
  studios: Studio[],
  presetStudioId: string | null | undefined,
  presetStudioName: string | null | undefined,
): Studio | null {
  const presetIds = [presetStudioId, presetStudioName]
    .map((value) => normalizeComparableId(value))
    .filter((value): value is string => Boolean(value));

  for (const presetId of presetIds) {
    const byId = studios.find((item) => normalizeComparableId(item.id) === presetId);
    if (byId) return byId;
  }

  const normalizedName = normalizeComparableName(presetStudioName);
  if (!normalizedName) return null;

  const exactByName = studios.find((item) => normalizeComparableName(item.name) === normalizedName);
  if (exactByName) return exactByName;

  return studios.find((item) => {
    const comparableName = normalizeComparableName(item.name);
    const comparableAddress = normalizeComparableName(item.address);
    return Boolean(
      (comparableName && comparableName.includes(normalizedName))
      || (comparableAddress && comparableAddress.includes(normalizedName)),
    );
  }) ?? null;
}

function pickStringFromRecord(source: unknown, keys: string[]): string | null {
  if (!isRecordObject(source)) return null;
  for (const key of keys) {
    const normalized = normalizeBookingId(source[key]);
    if (normalized) return normalized;
  }
  return null;
}

function extractSlotIdsFromBooking(booking: Booking): string[] {
  const bucket = new Set<string>();
  const push = (value: unknown) => {
    const normalized = normalizeBookingId(value);
    if (normalized) bucket.add(normalized);
  };

  push((booking as unknown as { slotId?: unknown }).slotId);
  push((booking as unknown as { timeSlotId?: unknown }).timeSlotId);

  const bookingAsRecord = booking as unknown as Record<string, unknown>;
  if (isRecordObject(bookingAsRecord.exercise)) {
    push(bookingAsRecord.exercise.slotId);
    push(bookingAsRecord.exercise.timeSlotId);
  }

  return Array.from(bucket);
}

function resolveBookingExerciseId(booking: Booking): string | null {
  const bookingAsRecord = booking as unknown as Record<string, unknown>;
  const fromTopLevel = pickStringFromRecord(bookingAsRecord, [
    "exerciseId",
    "vivaExerciseId",
    "exercise_id",
    "viva_exercise_id",
  ]);
  if (fromTopLevel) return fromTopLevel;
  return pickStringFromRecord(bookingAsRecord.exercise, [
    "id",
    "exerciseId",
    "vivaExerciseId",
  ]);
}

function resolveBookingPaymentUrl(booking: Booking): string | null {
  const fromCard = normalizeBookingId(booking.transactionStatus?.cardPaymentStatus?.paymentUrl ?? null);
  if (fromCard) return fromCard;
  const bookingAsRecord = booking as unknown as Record<string, unknown>;
  return pickStringFromRecord(bookingAsRecord, ["paymentUrl", "paymentLink", "url"]);
}

function buildBookingLookupContext(
  game: PadelGameRecord | null | undefined,
  fallbackPaymentUrlRaw: string | null | undefined,
  fallbackSnapshot: MatchSnapshot | null | undefined,
): BookingLookupContext {
  const metadata = isRecordObject(game?.metadata) ? game?.metadata : null;
  const booking = game?.booking && isRecordObject(game.booking)
    ? game.booking as Record<string, unknown>
    : null;

  const bookingIds = collectBookingIdsForVivaCheck(game, fallbackPaymentUrlRaw);

  const slotIdsBucket = new Set<string>();
  const exerciseIdsBucket = new Set<string>();
  const pushId = (bucket: Set<string>, value: unknown) => {
    parseBookingIdsFromUnknown(value).forEach((item) => {
      const normalized = normalizeBookingId(item);
      if (normalized) bucket.add(normalized);
    });
  };

  if (booking) {
    pushId(slotIdsBucket, booking.slotId);
    pushId(slotIdsBucket, booking.timeSlotId);
    pushId(slotIdsBucket, booking.slot_id);
    pushId(exerciseIdsBucket, booking.vivaExerciseId);
    pushId(exerciseIdsBucket, booking.exerciseId);
  }

  if (metadata) {
    pushId(slotIdsBucket, metadata.slotId);
    pushId(slotIdsBucket, metadata.timeSlotId);
    pushId(slotIdsBucket, metadata.slot_id);
    pushId(slotIdsBucket, metadata.time_slot_id);
    pushId(exerciseIdsBucket, metadata.vivaExerciseId);
    pushId(exerciseIdsBucket, metadata.exerciseId);
    pushId(exerciseIdsBucket, metadata.viva_exercise_id);
    pushId(exerciseIdsBucket, metadata.exercise_id);
  }

  return {
    bookingIds,
    slotIds: Array.from(slotIdsBucket),
    exerciseIds: Array.from(exerciseIdsBucket),
    studioId:
      normalizeBookingId(booking?.studioId) ??
      normalizeBookingId(metadata?.studioId) ??
      null,
    studioName:
      normalizeBookingId(booking?.studioName) ??
      normalizeBookingId(metadata?.studioName) ??
      fallbackSnapshot?.studioName ??
      null,
    roomId:
      normalizeBookingId(booking?.roomId) ??
      normalizeBookingId(metadata?.roomId) ??
      null,
    roomName:
      normalizeBookingId(booking?.roomName) ??
      normalizeBookingId(metadata?.roomName) ??
      fallbackSnapshot?.roomName ??
      null,
    date:
      toDateKey(
        normalizeBookingId(booking?.date) ??
        normalizeBookingId(metadata?.date) ??
        fallbackSnapshot?.date ??
        null,
      ) ??
      null,
    timeFrom:
      toTimeKey(
        normalizeBookingId(booking?.timeFrom) ??
        normalizeBookingId(metadata?.timeFrom) ??
        fallbackSnapshot?.timeFrom ??
        null,
      ) ??
      null,
    timeTo:
      toTimeKey(
        normalizeBookingId(booking?.timeTo) ??
        normalizeBookingId(metadata?.timeTo) ??
        fallbackSnapshot?.timeTo ??
        null,
      ) ??
      null,
  };
}

function matchBookingsByLookupContext(
  bookings: Booking[],
  context: BookingLookupContext,
): Booking[] {
  if (!Array.isArray(bookings) || bookings.length === 0) return [];

  const bookingIdsSet = new Set(
    context.bookingIds
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (bookingIdsSet.size > 0) {
    const byBookingIds = bookings.filter((item) => {
      const normalizedId = normalizeComparableId(item.id);
      return Boolean(normalizedId && bookingIdsSet.has(normalizedId));
    });
    if (byBookingIds.length > 0) return byBookingIds;
  }

  const exerciseIdsSet = new Set(
    context.exerciseIds
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (exerciseIdsSet.size > 0) {
    const byExercise = bookings.filter((item) => {
      const normalizedExercise = normalizeComparableId(resolveBookingExerciseId(item));
      return Boolean(normalizedExercise && exerciseIdsSet.has(normalizedExercise));
    });
    if (byExercise.length > 0) return byExercise;
  }

  const slotIdsSet = new Set(
    context.slotIds
      .map((value) => normalizeComparableId(value))
      .filter((value): value is string => Boolean(value)),
  );
  if (slotIdsSet.size > 0) {
    const bySlot = bookings.filter((item) => {
      const slotIds = extractSlotIdsFromBooking(item)
        .map((value) => normalizeComparableId(value))
        .filter((value): value is string => Boolean(value));
      return slotIds.some((slotId) => slotIdsSet.has(slotId));
    });
    if (bySlot.length > 0) return bySlot;
  }

  if (!context.date || !context.timeFrom) return [];

  const targetDate = context.date;
  const targetFrom = context.timeFrom;
  const targetTo = context.timeTo;
  const targetStudioId = normalizeComparableId(context.studioId);
  const targetRoomId = normalizeComparableId(context.roomId);
  const targetStudioName = normalizeComparableName(context.studioName);
  const targetRoomName = normalizeComparableName(context.roomName);

  return bookings.filter((item) => {
    const bookingDate = toDateKey(item.exercise?.timeFrom ?? null);
    const bookingFrom = toTimeKey(item.exercise?.timeFrom ?? null);
    const bookingTo = toTimeKey(item.exercise?.timeTo ?? null);
    if (!bookingDate || !bookingFrom) return false;
    if (bookingDate !== targetDate || bookingFrom !== targetFrom) return false;
    if (targetTo && bookingTo && bookingTo !== targetTo) return false;

    const bookingStudioId = normalizeComparableId(item.exercise?.studio?.id ?? null);
    const bookingRoomId = normalizeComparableId(item.exercise?.room?.id ?? null);
    const bookingStudioName = normalizeComparableName(item.exercise?.studio?.name ?? null);
    const bookingRoomName = normalizeComparableName(item.exercise?.room?.name ?? null);

    const studioMatches = targetStudioId && bookingStudioId
      ? targetStudioId === bookingStudioId
      : targetStudioName && bookingStudioName
        ? targetStudioName === bookingStudioName
        : true;
    const roomMatches = targetRoomId && bookingRoomId
      ? targetRoomId === bookingRoomId
      : targetRoomName && bookingRoomName
        ? targetRoomName === bookingRoomName
        : true;
    return studioMatches && roomMatches;
  });
}

function isGameCancelledStatus(statusRaw: string | null | undefined): boolean {
  const status = String(statusRaw || "").trim().toUpperCase();
  return Boolean(status && status.includes("CANCEL"));
}

function findGameRecordByBookingData(
  games: PadelGameRecord[],
  bookingData: GamesCreateFromBookingData | null | undefined,
): PadelGameRecord | null {
  if (!bookingData) return null;
  const targetBookingId = normalizeComparableId(bookingData.bookingId);
  const targetExerciseId = normalizeComparableId(bookingData.exerciseId);
  const targetDate = toDateKey(bookingData.date ?? null);
  const targetFrom = toTimeKey(bookingData.timeFrom ?? null);
  const targetStudioId = normalizeComparableId(bookingData.studioId);
  const targetRoomId = normalizeComparableId(bookingData.roomId);

  for (const game of games) {
    if (!game || isGameCancelledStatus(game.status)) continue;
    if (targetBookingId) {
      const bookingIds = collectBookingIdsForVivaCheck(game, game.payment?.paymentUrl ?? null);
      const hasBooking = bookingIds.some((value) => normalizeComparableId(value) === targetBookingId);
      if (hasBooking) return game;
    }

    if (targetExerciseId) {
      const metadata = isRecordObject(game.metadata) ? game.metadata : null;
      const booking = game.booking && isRecordObject(game.booking)
        ? game.booking as Record<string, unknown>
        : null;
      const gameExerciseId =
        normalizeComparableId(booking?.vivaExerciseId) ??
        normalizeComparableId(booking?.exerciseId) ??
        normalizeComparableId(metadata?.vivaExerciseId) ??
        normalizeComparableId(metadata?.exerciseId);
      if (gameExerciseId && gameExerciseId === targetExerciseId) return game;
    }

    if (!targetDate || !targetFrom) continue;
    const gameDate = toDateKey(game.booking?.date ?? null);
    const gameFrom = toTimeKey(game.booking?.timeFrom ?? null);
    if (!gameDate || !gameFrom || gameDate !== targetDate || gameFrom !== targetFrom) continue;

    const gameBooking = game.booking && isRecordObject(game.booking)
      ? game.booking as Record<string, unknown>
      : null;
    const gameStudioId = normalizeComparableId(gameBooking?.studioId ?? null);
    const gameRoomId = normalizeComparableId(gameBooking?.roomId ?? null);

    const studioMatches = targetStudioId && gameStudioId ? targetStudioId === gameStudioId : true;
    const roomMatches = targetRoomId && gameRoomId ? targetRoomId === gameRoomId : true;
    if (studioMatches && roomMatches) return game;
  }

  return null;
}

function isSinglesCourtName(roomName: string): boolean {
  return /сингл|single|1\s*на\s*1|1x1/i.test(roomName);
}

function matchesCourtNameByGameFormat(roomName: string, format: GamePlayFormat): boolean {
  if (format === "singles") {
    return isSinglesCourtName(roomName);
  }
  return !isSinglesCourtName(roomName);
}

interface StudioMapPoint extends Studio {
  lat: number;
  lng: number;
}

type LeafletPoint = [number, number];

interface LeafletMap {
  setView: (center: LeafletPoint, zoom: number) => void;
  invalidateSize: () => void;
  fitBounds: (bounds: LeafletPoint[], options: { padding: [number, number]; maxZoom: number }) => void;
  remove: () => void;
}

interface LeafletLayerGroup {
  addTo: (map: LeafletMap) => LeafletLayerGroup;
  clearLayers: () => void;
}

interface LeafletMarker {
  bindTooltip: (text: string, options: { direction: string; offset: [number, number] }) => LeafletMarker;
  on: (event: "click", handler: () => void) => LeafletMarker;
  addTo: (group: LeafletLayerGroup) => LeafletMarker;
}

interface LeafletCircleLayer {
  addTo: (group: LeafletLayerGroup) => void;
}

interface LeafletTileLayer {
  addTo: (map: LeafletMap) => void;
}

interface LeafletModule {
  map: (
    host: HTMLDivElement,
    options: { zoomControl: boolean; attributionControl: boolean },
  ) => LeafletMap;
  tileLayer: (
    url: string,
    options: { maxZoom: number },
  ) => LeafletTileLayer;
  layerGroup: () => LeafletLayerGroup;
  circleMarker: (
    point: LeafletPoint,
    options: {
      radius: number;
      color: string;
      fillColor: string;
      fillOpacity: number;
      weight: number;
    },
  ) => LeafletMarker;
  circle: (
    point: LeafletPoint,
    options: {
      radius: number;
      color: string;
      fillColor: string;
      fillOpacity: number;
      weight: number;
    },
  ) => LeafletCircleLayer;
}

const NEAREST_MAP_STUDIOS_LIMIT = 5;

let leafletLoader: Promise<LeafletModule> | null = null;

function toFloat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function hasValidCoordinates(lat: unknown, lng: unknown): lat is number {
  const parsedLat = toFloat(lat);
  const parsedLng = toFloat(lng);
  if (parsedLat === null || parsedLng === null) return false;
  return Math.abs(parsedLat) <= 90 && Math.abs(parsedLng) <= 180;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function distanceBetweenPointsMeters(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
) {
  const earthRadius = 6371000;
  const dLat = toRadians(toLat - fromLat);
  const dLng = toRadians(toLng - fromLng);
  const lat1 = toRadians(fromLat);
  const lat2 = toRadians(toLat);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function pickNearestStudiosForViewport(
  studios: StudioMapPoint[],
  userLocation: { lat: number; lng: number },
  limit: number,
) {
  if (studios.length <= limit) return studios;
  return studios
    .map((studio) => ({
      studio,
      distance: distanceBetweenPointsMeters(
        userLocation.lat,
        userLocation.lng,
        studio.lat,
        studio.lng,
      ),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, limit))
    .map((entry) => entry.studio);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function geocodeStudio(studio: Studio, signal: AbortSignal) {
  const parts = [studio.address, studio.city, studio.country, studio.name]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", parts.join(", "));

  const response = await fetch(url.toString(), {
    method: "GET",
    signal,
    headers: { "Accept-Language": "ru" },
  });
  if (!response.ok) return null;

  const payload = (await response.json().catch(() => null)) as Array<{
    lat?: string;
    lon?: string;
  }> | null;
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first) return null;

  const lat = toFloat(first.lat);
  const lng = toFloat(first.lon);
  if (!hasValidCoordinates(lat, lng) || lat === null || lng === null) return null;
  return { lat, lng };
}

function loadLeaflet() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("window is undefined"));
  }

  const readLeaflet = () => (window as Window & { L?: LeafletModule }).L ?? null;
  const withLeaflet = window as Window & { L?: LeafletModule };
  if (withLeaflet.L) return Promise.resolve(withLeaflet.L);
  if (leafletLoader) return leafletLoader;

  leafletLoader = new Promise((resolve, reject) => {
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }

    const existing = document.getElementById("leaflet-js");
    if (existing) {
      existing.addEventListener("load", () => {
        const leaflet = readLeaflet();
        if (leaflet) {
          resolve(leaflet);
          return;
        }
        reject(new Error("Leaflet script registered without global"));
      });
      existing.addEventListener("error", () => reject(new Error("Leaflet script load failed")));
      return;
    }

    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.onload = () => {
      const leaflet = readLeaflet();
      if (leaflet) {
        resolve(leaflet);
        return;
      }
      reject(new Error("Leaflet script registered without global"));
    };
    script.onerror = () => reject(new Error("Leaflet script load failed"));
    document.body.appendChild(script);
  });

  return leafletLoader;
}

function getGeoErrorMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Разрешите доступ к геопозиции в браузере";
    case error.POSITION_UNAVAILABLE:
      return "Местоположение недоступно";
    case error.TIMEOUT:
      return "Не удалось определить местоположение (таймаут)";
    default:
      return "Не удалось определить местоположение";
  }
}

export default function GamesPage({
  onBack,
  openGameId = null,
  openChat = false,
  createFromBooking = null,
  publicCreateEntry = false,
  presetStudioId = null,
  presetStudioName = null,
}: GamesPageProps) {
  const [step, setStep] = useState<Step>("create");
  const [studios, setStudios] = useState<Studio[]>([]);
  const [timeslots, setTimeslots] = useState<GameTimeSlot[]>([]);
  const [loadingTimeslots, setLoadingTimeslots] = useState(false);
  const [timeslotsError, setTimeslotsError] = useState<string | null>(null);
  const [studiosQuery, setStudiosQuery] = useState("");
  const [studio, setStudio] = useState<Studio | null>(null);
  const [gameFormat, setGameFormat] = useState<GamePlayFormat>("doubles");
  const [studioGameModes, setStudioGameModes] = useState<StudioGameModes | null>(null);
  const [studioGameModesStudioId, setStudioGameModesStudioId] = useState<string | null>(null);
  const [loadingStudioGameModes, setLoadingStudioGameModes] = useState(false);
  const [duration, setDuration] = useState(60);
  const [dateIndex, setDateIndex] = useState(TODAY_DATE_INDEX);
  const [time, setTime] = useState<string | null>(null);
  const [courtId, setCourtId] = useState<string | null>(null);
  const [slotPrice, setSlotPrice] = useState<number | null>(null);
  const [loadingSlotPrice, setLoadingSlotPrice] = useState(false);
  const [loadingPay, setLoadingPay] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<GamePaymentMode>("self");
  const [splitPaymentTesterUnlocked, setSplitPaymentTesterUnlocked] = useState(false);
  const [splitShareCount, setSplitShareCount] = useState<SplitShareCount>(4);
  const [splitPaymentPromoConfig, setSplitPaymentPromoConfig] =
    useState<PadelSplitPaymentPromoConfig>(DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG);
  const [promoModalOpen, setPromoModalOpen] = useState(false);
  const [promoCodeDraft, setPromoCodeDraft] = useState("");
  const [promoCodeApplied, setPromoCodeApplied] = useState<string | null>(null);
  const [promoDiscountAmount, setPromoDiscountAmount] = useState<number | null>(null);
  const [promoPricePreview, setPromoPricePreview] = useState<number | null>(null);
  const [promoStatusMessage, setPromoStatusMessage] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [splitSubscriptionsLoading, setSplitSubscriptionsLoading] = useState(false);
  const [splitSubscriptionsError, setSplitSubscriptionsError] = useState<string | null>(null);
  const [splitSubscriptions, setSplitSubscriptions] = useState<Subscription[]>([]);
  const [applyingPromo, setApplyingPromo] = useState(false);
  const [ratingGame, setRatingGame] = useState(true);
  const [minRating, setMinRating] = useState(1);
  const [maxRating, setMaxRating] = useState(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const [gameTitleDraft, setGameTitleDraft] = useState("");
  const [gameParticipantCommentDraft, setGameParticipantCommentDraft] = useState("");
  const [gameJoinPriceDraft, setGameJoinPriceDraft] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<PadelGameChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatRefreshing, setChatRefreshing] = useState(false);
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatReadMap, setChatReadMap] = useState<Record<string, number>>({});
  const [chatUnreadByGame, setChatUnreadByGame] = useState<Record<string, number>>({});
  const [gameRecordId, setGameRecordId] = useState<string | null>(null);
  const [gameRecordStatus, setGameRecordStatus] = useState<string | null>(null);
  const [gamePaymentUrl, setGamePaymentUrl] = useState<string | null>(null);
  const [gamePaid, setGamePaid] = useState<boolean | null>(null);
  const [gameSnapshot, setGameSnapshot] = useState<MatchSnapshot | null>(null);
  const [, setCheckingGameStatus] = useState(false);
  const [retryingPayment, setRetryingPayment] = useState(false);
  const [creatingFromBooking, setCreatingFromBooking] = useState(false);
  const [cancellingUnpaidGame, setCancellingUnpaidGame] = useState(false);
  const [confirmCancelUnpaidGame, setConfirmCancelUnpaidGame] = useState(false);
  const [gameRecordError, setGameRecordError] = useState<string | null>(null);
  const [gameRosterError, setGameRosterError] = useState<string | null>(null);
  const [gameDetailsMetaError, setGameDetailsMetaError] = useState<string | null>(null);
  const [updatingGameRoster, setUpdatingGameRoster] = useState(false);
  const [updatingGameMeta, setUpdatingGameMeta] = useState(false);
  const [, setRestoringPaidGame] = useState(false);
  const [participants, setParticipants] = useState<PadelGamePlayer[]>([]);
  const [waitlistPlayers, setWaitlistPlayers] = useState<PadelGamePlayer[]>([]);
  const [waitlistEnabled, setWaitlistEnabled] = useState(true);
  const [loadingStudios, setLoadingStudios] = useState(false);
  const [studiosError, setStudiosError] = useState<string | null>(null);
  const [communityGames, setCommunityGames] = useState<PadelGameRecord[]>([]);
  const [activeGameRecordStore, setActiveGameRecordStore] = useState<PadelGameRecord | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profilePhone, setProfilePhone] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("Организатор");
  const [profileGrade, setProfileGrade] = useState("D+");
  const [profileRatingNumeric, setProfileRatingNumeric] = useState<number | null>(null);
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [communityAutopublishStationTarget, setCommunityAutopublishStationTarget] =
    useState<CommunityAutopublishTarget | null>(null);
  const [communityAutopublishMemberTargets, setCommunityAutopublishMemberTargets] =
    useState<CommunityAutopublishTarget[]>([]);
  const [selectedCommunityAutopublishIds, setSelectedCommunityAutopublishIds] = useState<string[]>([]);
  const [detailsSelectedCommunityUnpublishIds, setDetailsSelectedCommunityUnpublishIds] = useState<string[]>([]);
  const [communityAutopublishLoading, setCommunityAutopublishLoading] = useState(false);
  const [communityAutopublishError, setCommunityAutopublishError] = useState<string | null>(null);
  const [ringFraction, setRingFraction] = useState(0);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [detailsServiceInfoVisible, setDetailsServiceInfoVisible] = useState(false);
  const [detailsPaymentHintOpen, setDetailsPaymentHintOpen] = useState(false);
  const [detailsActiveTab, setDetailsActiveTab] = useState<"game" | "result">("game");
  const [detailsMatchResultAttachments, setDetailsMatchResultAttachments] = useState<MatchResultAttachment[]>([]);
  const [detailsMatchResultAttachmentsLoading, setDetailsMatchResultAttachmentsLoading] = useState(false);
  const [sharingMatchResultPhoto, setSharingMatchResultPhoto] = useState(false);
  const [detailsMatchResultPhotoLogoVariants, setDetailsMatchResultPhotoLogoVariants] = useState<
    Record<string, MatchResultPhotoLogoVariant>
  >({});
  const [detailsTeamSlots, setDetailsTeamSlots] = useState<Array<PadelGamePlayer | null>>(
    Array.from({ length: DETAILS_TEAM_SLOTS_COUNT }, () => null),
  );
  const [detailsTeamMenuSlotIndex, setDetailsTeamMenuSlotIndex] = useState<number | null>(null);
  const [detailsMatchResultSets, setDetailsMatchResultSets] = useState<EditableMatchResultSet[]>([
    { left: "", right: "" },
  ]);
  const [detailsMatchResultSetPairings, setDetailsMatchResultSetPairings] = useState<
    Array<MatchResultSetPairingSlots | null>
  >(() => createEmptyMatchResultSetPairings());
  const [detailsPairComposerSetIndex, setDetailsPairComposerSetIndex] = useState<number | null>(null);
  const [detailsMatchResultStatus, setDetailsMatchResultStatus] = useState<string | null>(null);
  const [detailsMatchResultSubmittedBy, setDetailsMatchResultSubmittedBy] = useState<{
    id: string | null;
    phone: string | null;
    name: string | null;
  } | null>(null);
  const [detailsMatchResultSubmittedAt, setDetailsMatchResultSubmittedAt] = useState<string | null>(null);
  const [detailsMatchResultDisputeDeadlineAt, setDetailsMatchResultDisputeDeadlineAt] = useState<string | null>(null);
  const [detailsMatchResultConfirmedBy, setDetailsMatchResultConfirmedBy] = useState<{
    id: string | null;
    phone: string | null;
    name: string | null;
  } | null>(null);
  const [detailsMatchResultConfirmedAt, setDetailsMatchResultConfirmedAt] = useState<string | null>(null);
  const [detailsMatchResultRatingImpact, setDetailsMatchResultRatingImpact] = useState<MatchResultRatingImpactEntry[]>([]);
  const [detailsMatchResultDisputedBy, setDetailsMatchResultDisputedBy] = useState<{
    id: string | null;
    phone: string | null;
    name: string | null;
  } | null>(null);
  const [detailsMatchResultDisputedAt, setDetailsMatchResultDisputedAt] = useState<string | null>(null);
  const [retryingMatchResultVivaSync, setRetryingMatchResultVivaSync] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [locatingUser, setLocatingUser] = useState(false);
  const [userLocationError, setUserLocationError] = useState<string | null>(null);
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
  } | null>(null);
  const [matchResultNowTs, setMatchResultNowTs] = useState(() => Date.now());
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [geocodedCoords, setGeocodedCoords] = useState<Record<string, { lat: number; lng: number }>>({});
  const [avatarError, setAvatarError] = useState(false);
  const mapHostRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<LeafletMap | null>(null);
  const mapMarkersRef = useRef<LeafletLayerGroup | null>(null);
  const timeDateRowRef = useRef<HTMLDivElement | null>(null);
  const geocodingIdsRef = useRef<Set<string>>(new Set());
  const userLocationRequestedRef = useRef(false);
  const autoLocationAttemptedRef = useRef(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const detailsRevealTapStateRef = useRef<{ count: number; timeoutId: number | null }>({
    count: 0,
    timeoutId: null,
  });
  const splitSubscriptionRequestRef = useRef(0);
  const splitPaymentUnlockTapStateRef = useRef<{ count: number; timeoutId: number | null }>({
    count: 0,
    timeoutId: null,
  });
  const detailsCameraInputRef = useRef<HTMLInputElement | null>(null);
  const detailsGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const publicCreateEntryHandledRef = useRef(false);
  const publicCreatePresetHandledRef = useRef(false);
  const openedGameInitKeyRef = useRef<string | null>(null);
  const splitJoinPriceAutofilledRef = useRef(false);
  const communityAutopublishSelectionTouchedRef = useRef(false);
  const detailsRatingsRefreshKeyRef = useRef<string | null>(null);
  const selectedCommunityAutopublishIdsRef = useRef<string[]>([]);
  const communityAutopublishSyncInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const communityAutopublishRepairAttemptRef = useRef<string | null>(null);
  const previousStudioIdRef = useRef<string | null>(null);
  const previousResolvedGameFormatRef = useRef<GamePlayFormat | null>(null);
  const previousPromoSelectionKeyRef = useRef<string | null>(null);
  const autoConfirmingMatchResultRef = useRef<string | null>(null);
  const clearPromoState = useCallback((options?: { clearDraft?: boolean }) => {
    setPromoModalOpen(false);
    if (options?.clearDraft !== false) {
      setPromoCodeDraft("");
    }
    setPromoCodeApplied(null);
    setPromoDiscountAmount(null);
    setPromoPricePreview(null);
    setPromoStatusMessage(null);
    setPromoError(null);
    setApplyingPromo(false);
  }, []);
  useEffect(() => {
    if (!ENABLE_SPLIT_GAME_PAYMENT) return;

    let alive = true;
    apiFetchPadelSplitPaymentPromoConfig()
      .then((result) => {
        if (!alive || !result.data) return;
        setSplitPaymentPromoConfig(result.data);
      })
      .catch(() => {
        if (!alive) return;
        setSplitPaymentPromoConfig({ ...DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG, enabled: false });
      });

    return () => {
      alive = false;
    };
  }, []);
  const restorePromoState = useCallback((metadata: unknown, paymentAmountValue: unknown) => {
    const snapshot = extractPromoStateSnapshot(metadata, paymentAmountValue);
    if (!snapshot) return;

    setPromoModalOpen(false);
    setPromoCodeDraft(snapshot.code);
    setPromoCodeApplied(snapshot.code);
    setPromoDiscountAmount(snapshot.discountAmount);
    setPromoPricePreview(snapshot.paymentAmount);
    setPromoStatusMessage(
      snapshot.discountAmount != null
        ? (
          snapshot.discountAmount > 0
            ? `Промокод применен. Скидка ${formatPrice(snapshot.discountAmount)} ₽`
            : "Промокод применен, но для выбранного слота скидка не начислена"
        )
        : `Промокод ${snapshot.code} применен`,
    );
    setPromoError(null);
    setApplyingPromo(false);
  }, []);

  const dates = useMemo(() => {
    const base = new Date();
    const totalDays = DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1;
    return Array.from({ length: totalDays }).map((_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + (i - DAYS_BEFORE_TODAY));
      return d;
    });
  }, []);

  useEffect(() => {
    if (!publicCreateEntry || publicCreateEntryHandledRef.current) return;
    publicCreateEntryHandledRef.current = true;
    setStep("place");
  }, [publicCreateEntry]);

  useEffect(() => {
    if (step !== "place") return;

    let alive = true;
    setLoadingStudios(true);
    setStudiosError(null);

    apiFetchOnboardingStations()
      .then((res) => {
        if (!alive) return;
        const nextStudios = Array.isArray(res.data) ? res.data : [];
        setStudios(nextStudios);
        setStudio((prev) =>
          prev && nextStudios.some((station) => station.id === prev.id) ? prev : null,
        );
        if (res.error) {
          setStudiosError(res.error.message || "Не удалось загрузить станции");
        }
      })
      .catch(() => {
        if (!alive) return;
        setStudios([]);
        setStudiosError("Не удалось загрузить станции");
      })
      .finally(() => {
        if (alive) setLoadingStudios(false);
      });

    return () => {
      alive = false;
    };
  }, [step]);

  useEffect(() => {
    if (!publicCreateEntry || publicCreatePresetHandledRef.current) return;

    const hasPreset = Boolean(
      normalizeBookingId(presetStudioId) || normalizeBookingId(presetStudioName),
    );
    if (!hasPreset) {
      publicCreatePresetHandledRef.current = true;
      return;
    }

    if (step !== "place" || loadingStudios) return;

    if (studios.length === 0) {
      publicCreatePresetHandledRef.current = true;
      if (presetStudioName) {
        setStudiosQuery((prev) => prev || presetStudioName);
      }
      return;
    }

    publicCreatePresetHandledRef.current = true;
    const matchedStudio = findStudioByPreset(studios, presetStudioId, presetStudioName);
    if (!matchedStudio) {
      if (presetStudioName) {
        setStudiosQuery((prev) => prev || presetStudioName);
      }
      return;
    }

    setStudio(matchedStudio);
    setStudiosQuery("");
    setStep("time");
  }, [
    publicCreateEntry,
    presetStudioId,
    presetStudioName,
    step,
    loadingStudios,
    studios,
  ]);

  useEffect(() => {
    apiFetchProfile().then((res) => {
      if (!res.data) return;
      const fullName = [res.data.firstName, res.data.lastName]
        .filter(Boolean)
        .join(" ");
      setProfileId(res.data.id ?? null);
      setProfilePhone(res.data.phone ?? null);
      setProfileName(fullName || "Организатор");
      setProfilePhoto(res.data.photo ?? null);

      const explicitGrade = getCustomFieldValue(
        res.data,
        CUSTOM_FIELD_IDS.lkPadelLevel,
      );
      const numericValue = parseNumericLevel(
        getCustomFieldValue(res.data, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
      );
      const gradeFallback: Record<string, number> = {
        D: 2.0,
        "D+": 2.5,
        C: 3.0,
        "C+": 3.5,
        B: 4.2,
        "B+": 5.0,
        A: 6.0,
      };
      const numeric =
        numericValue ??
        (explicitGrade && gradeFallback[explicitGrade]
          ? gradeFallback[explicitGrade]
          : null);
      const fraction =
        numeric != null
          ? Math.max(0, Math.min(1, numeric - Math.floor(numeric)))
          : 0;
      setProfileRatingNumeric(numeric);
      setRingFraction(fraction);
      if (explicitGrade) {
        setProfileGrade(explicitGrade);
      } else if (numeric !== null) {
        setProfileGrade(getLetterGrade(numeric));
      }

      setParticipants([
        {
          id: res.data.id ?? null,
          name: fullName || "Организатор",
          phone: res.data.phone ?? null,
          photo: res.data.photo ?? null,
          rating: explicitGrade ?? (numeric !== null ? getLetterGrade(numeric) : null),
          ratingNumeric: numeric,
          source: "ORGANIZER",
          status: "CONFIRMED",
        },
      ]);
    });
  }, []);

  useEffect(() => {
    const phone = (profilePhone || "").trim();
    if (!phone) return;

    let alive = true;

    apiFetchPadelGamesByPhone(phone, profileId, true)
      .then((result) => {
        if (!alive) return;
        setCommunityGames(Array.isArray(result.data?.games) ? result.data.games : []);
      })
      .catch(() => {
        if (!alive) return;
        setCommunityGames([]);
      });

    return () => {
      alive = false;
    };
  }, [profilePhone, profileId]);

  const profilePhoneNorm = useMemo(
    () => normalizePhoneForGame(profilePhone),
    [profilePhone],
  );

  useEffect(() => {
    if (!profilePhoneNorm) {
      setChatReadMap({});
      return;
    }
    setChatReadMap(readChatReadMap(profilePhoneNorm));
  }, [profilePhoneNorm]);

  const updateChatReadState = useCallback(
    (gameId: string, readTsRaw: number) => {
      const normalizedId = gameId.trim();
      const readTs = Number.isFinite(readTsRaw) ? Math.floor(readTsRaw) : 0;
      if (!normalizedId || readTs <= 0) return;

      setChatReadMap((prev) => {
        const prevTs = prev[normalizedId] ?? 0;
        const nextTs = Math.max(prevTs, readTs);
        if (nextTs === prevTs) return prev;
        const next = { ...prev, [normalizedId]: nextTs };
        if (profilePhoneNorm) {
          writeChatReadMap(profilePhoneNorm, next);
        }
        return next;
      });

      setChatUnreadByGame((prev) => {
        if (!prev[normalizedId]) return prev;
        const next = { ...prev };
        delete next[normalizedId];
        return next;
      });
    },
    [profilePhoneNorm],
  );

  const markChatAsRead = useCallback(
    async (gameId: string, readTsRaw: number) => {
      if (!profilePhoneNorm) return;
      const readTs = Number.isFinite(readTsRaw) ? Math.floor(readTsRaw) : 0;
      if (!gameId.trim() || readTs <= 0) return;

      const response = await apiMarkPadelGameChatRead({
        gameId,
        phone: profilePhoneNorm,
        lastReadTs: readTs,
      });

      const resolvedTs = response.data?.read?.lastReadTs ?? readTs;
      if (!response.error && resolvedTs > 0) {
        updateChatReadState(gameId, resolvedTs);
      }
    },
    [profilePhoneNorm, updateChatReadState],
  );

  const refreshUnreadChats = useCallback(async () => {
    if (!profilePhoneNorm) {
      setChatUnreadByGame({});
      return;
    }

    const gameIds = new Set(communityGames.map((item) => item.id).filter(Boolean));
    if (gameRecordId) {
      gameIds.add(gameRecordId);
    }
    if (gameIds.size === 0) {
      setChatUnreadByGame({});
      return;
    }

    const summaryResult = await apiFetchPadelChatsByPhone(profilePhoneNorm);
    if (!summaryResult.data) return;

    const nextUnread: Record<string, number> = {};
    summaryResult.data.chats.forEach((chat) => {
      if (!gameIds.has(chat.gameId)) return;
      if (!Number.isFinite(chat.lastMessageTs) || chat.lastMessageTs <= 0) return;

      const lastReadTs = chatReadMap[chat.gameId] ?? 0;
      const senderPhone = normalizePhoneForGame(chat.lastMessageSenderPhone);
      const isMine = Boolean(senderPhone && senderPhone === profilePhoneNorm);
      if (!isMine && chat.lastMessageTs > lastReadTs) {
        nextUnread[chat.gameId] = 1;
      }
    });

    setChatUnreadByGame(nextUnread);
  }, [chatReadMap, communityGames, gameRecordId, profilePhoneNorm]);

  const resolveGamePaymentByVivaBookings = useCallback(async (
    game: PadelGameRecord | null | undefined,
    fallbackPaymentUrlRaw: string | null | undefined,
    fallbackSnapshot: MatchSnapshot | null | undefined,
  ): Promise<VivaPaymentCheckResult> => {
    const lookup = buildBookingLookupContext(game, fallbackPaymentUrlRaw, fallbackSnapshot);
    const hasLookupSignal = lookup.bookingIds.length > 0
      || lookup.slotIds.length > 0
      || lookup.exerciseIds.length > 0
      || Boolean(lookup.date && lookup.timeFrom);
    if (!hasLookupSignal) {
      return { paid: null, paymentUrl: null, cancelled: false, matchedBookings: [] };
    }

    const activeBookingsResult = await apiFetchBookings(false);
    let matchedBookings = matchBookingsByLookupContext(activeBookingsResult.data?.content ?? [], lookup);

    if (matchedBookings.length === 0) {
      const historyBookingsResult = await apiFetchBookings(true);
      matchedBookings = matchBookingsByLookupContext(historyBookingsResult.data?.content ?? [], lookup);
    }

    const paid = matchedBookings.length > 0 ? resolvePaidStateByBookings(matchedBookings) : null;
    const cancelled = matchedBookings.length > 0 ? resolveCancelledStateByBookings(matchedBookings) : false;
    const paymentUrl = matchedBookings
      .map((item) => resolveBookingPaymentUrl(item))
      .find((value): value is string => Boolean(value))
      ?? null;

    return {
      paid,
      paymentUrl,
      cancelled,
      matchedBookings,
    };
  }, []);

  useEffect(() => {
    if (!profilePhoneNorm) return;
    let cancelled = false;

    const run = async () => {
      await refreshUnreadChats();
      if (cancelled) return;
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
  }, [profilePhoneNorm, refreshUnreadChats]);

  const filteredStudios = studios.filter((s) => {
    if (!studiosQuery.trim()) return true;
    const q = studiosQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      s.address.toLowerCase().includes(q) ||
      s.city.toLowerCase().includes(q)
    );
  });

  const studiosByCity = useMemo(() => {
    const groups = new Map<string, Studio[]>();
    filteredStudios.forEach((item) => {
      const city = item.city.trim() || "Другой город";
      const current = groups.get(city) ?? [];
      current.push(item);
      groups.set(city, current);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b, "ru"));
  }, [filteredStudios]);

  const mapStudios = useMemo<StudioMapPoint[]>(() => {
    return filteredStudios.flatMap((item) => {
      const fallback = geocodedCoords[item.id];
      const latSource = hasValidCoordinates(item.lat, item.lng) ? toFloat(item.lat) : fallback?.lat ?? null;
      const lngSource = hasValidCoordinates(item.lat, item.lng) ? toFloat(item.lng) : fallback?.lng ?? null;
      if (latSource === null || lngSource === null) return [];
      return [{ ...item, lat: latSource, lng: lngSource }];
    });
  }, [filteredStudios, geocodedCoords]);

  const durationScopedSlots = useMemo<GameTimeSlot[]>(() => {
    if (timeslots.length === 0) return [];
    return timeslots.filter(
      (slot) => slot.durationMinutes == null || slot.durationMinutes >= duration,
    );
  }, [timeslots, duration]);

  const availableCourts = useMemo<GameCourtOption[]>(() => {
    if (durationScopedSlots.length === 0) return [];
    const scoped = time
      ? durationScopedSlots.filter((slot) => slot.time === time)
      : durationScopedSlots;
    const map = new Map<string, GameCourtOption>();
    scoped.forEach((slot) => {
      const current = map.get(slot.roomId);
      if (!current) {
        map.set(slot.roomId, {
          id: slot.roomId,
          name: slot.roomName || "Корт",
          price: slot.price ?? null,
        });
        return;
      }
      if (current.price == null && slot.price != null) {
        map.set(slot.roomId, { ...current, price: slot.price });
      }
    });
    return Array.from(map.values()).sort((a, b) => {
      const aOrder = extractCourtOrder(a.name);
      const bOrder = extractCourtOrder(b.name);
      if (aOrder !== null && bOrder !== null) return aOrder - bOrder;
      if (aOrder !== null) return -1;
      if (bOrder !== null) return 1;
      return a.name.localeCompare(b.name, "ru");
    });
  }, [durationScopedSlots, time]);

  const availableTimeSlots = useMemo<string[]>(() => {
    if (durationScopedSlots.length === 0) return [];
    const scoped = courtId
      ? durationScopedSlots.filter((slot) => slot.roomId === courtId)
      : durationScopedSlots;
    const unique = Array.from(new Set(scoped.map((slot) => slot.time)));
    return unique.sort((a, b) => a.localeCompare(b, "ru"));
  }, [durationScopedSlots, courtId]);
  const studioId = studio?.id ?? null;
  const studioMasterServiceId = studio?.masterServiceId ?? null;
  const studioName = studio?.name ?? "Станция";
  const studioSubServiceIds = useMemo(() => studio?.subServiceIds ?? [], [studio?.subServiceIds]);
  const studioPreferredSubServiceId = studio?.preferredSubServiceId ?? null;
  const currentStudioGameModes = studioGameModesStudioId === studioId ? studioGameModes : null;
  const supportsSinglesMode = Boolean(currentStudioGameModes?.singles?.subServiceIds.length);
  const supportsDoublesMode = Boolean(
    currentStudioGameModes?.doubles?.subServiceIds.length || !studioId || !currentStudioGameModes,
  );
  const resolvedGameFormat: GamePlayFormat = supportsDoublesMode
    ? (gameFormat === "singles" && supportsSinglesMode ? "singles" : "doubles")
    : (supportsSinglesMode ? "singles" : "doubles");
  const selectedGameModeConfig = useMemo(
    () => (resolvedGameFormat === "singles"
      ? (currentStudioGameModes?.singles ?? null)
      : (currentStudioGameModes?.doubles ?? null)),
    [resolvedGameFormat, currentStudioGameModes],
  );
  const activeModeSubServiceIds = useMemo(
    () => (
      selectedGameModeConfig?.subServiceIds.length
        ? selectedGameModeConfig.subServiceIds
        : (studioSubServiceIds.length
            ? studioSubServiceIds
            : (studioPreferredSubServiceId ? [studioPreferredSubServiceId] : []))
    ),
    [selectedGameModeConfig?.subServiceIds, studioSubServiceIds, studioPreferredSubServiceId],
  );
  const activeModePreferredSubServiceId =
    selectedGameModeConfig?.preferredSubServiceId
    ?? studioPreferredSubServiceId
    ?? activeModeSubServiceIds[0]
    ?? null;
  const activeModePreferredRoomIds = useMemo(
    () => selectedGameModeConfig?.preferredRoomIds ?? [],
    [selectedGameModeConfig?.preferredRoomIds],
  );
  const isSinglesGame = resolvedGameFormat === "singles";
  const createMaxPlayers = isSinglesGame ? MAX_SINGLES_PLAYERS : MAX_DOUBLES_PLAYERS;
  const createInviteSlotsCount = Math.max(0, createMaxPlayers - 1);
  const effectiveRatingGame = !isSinglesGame && ratingGame;

  useEffect(() => {
    if (!studioId) {
      setStudioGameModes(null);
      setStudioGameModesStudioId(null);
      setLoadingStudioGameModes(false);
      return;
    }

    let alive = true;
    setStudioGameModesStudioId(null);
    setLoadingStudioGameModes(true);

    apiFetchMasterServiceGameModes({
      studioId,
      masterServiceId: studioMasterServiceId,
    })
      .then((res) => {
        if (!alive) return;
        const nextModes = res.data ?? { doubles: null, singles: null };
        setStudioGameModes(nextModes);
        setStudioGameModesStudioId(studioId);
        setGameFormat((prev) => {
          if (prev === "singles" && nextModes.singles?.subServiceIds.length) return "singles";
          if (nextModes.doubles?.subServiceIds.length) return "doubles";
          if (nextModes.singles?.subServiceIds.length) return "singles";
          return "doubles";
        });
      })
      .catch(() => {
        if (!alive) return;
        setStudioGameModes({ doubles: null, singles: null });
        setStudioGameModesStudioId(studioId);
        setGameFormat("doubles");
      })
      .finally(() => {
        if (alive) setLoadingStudioGameModes(false);
      });

    return () => {
      alive = false;
    };
  }, [studioId, studioMasterServiceId]);

  useEffect(() => {
    const previousStudioId = previousStudioIdRef.current;
    if (previousStudioId === studioId) return;
    previousStudioIdRef.current = studioId;

    if (previousStudioId == null && studioId == null) return;

    setCourtId(null);
    setTime(null);
    setTimeslots([]);
    setTimeslotsError(null);
    setSlotPrice(null);
    setPayError(null);
    clearPromoState();
    setGameFormat("doubles");
  }, [studioId, clearPromoState]);

  useEffect(() => {
    const previousGameFormat = previousResolvedGameFormatRef.current;
    previousResolvedGameFormatRef.current = resolvedGameFormat;
    if (previousGameFormat === null || previousGameFormat === resolvedGameFormat) return;

    setCourtId(null);
    setTime(null);
    setTimeslots([]);
    setTimeslotsError(null);
    setSlotPrice(null);
    setPayError(null);
    clearPromoState();
  }, [resolvedGameFormat, clearPromoState]);

  useEffect(() => {
    if (!courtId) return;
    if (availableCourts.some((court) => court.id === courtId)) return;
    setCourtId(null);
  }, [availableCourts, courtId]);

  useEffect(() => {
    if (!time) return;
    if (availableTimeSlots.includes(time)) return;
    setTime(null);
  }, [availableTimeSlots, time]);

  useEffect(() => {
    if (!timeDateRowRef.current) return;
    const activeButton = timeDateRowRef.current.querySelector<HTMLButtonElement>(
      `[data-date-index="${dateIndex}"]`,
    );
    if (!activeButton) return;
    activeButton.scrollIntoView({
      behavior: "smooth",
      inline: "center",
      block: "nearest",
    });
  }, [dateIndex, step]);

  useEffect(() => {
    if (step !== "time" || !studioId) return;
    const targetDate = dates[dateIndex];
    if (!targetDate) return;

    let alive = true;
    setLoadingTimeslots(true);
    setTimeslotsError(null);

    apiFetchMasterServiceTimeslots(formatDateLocalIso(targetDate), {
      studioId,
      masterServiceId: studioMasterServiceId,
      preferredSubServiceId: activeModePreferredSubServiceId,
      preferredSubServiceIds: activeModeSubServiceIds,
      preferredRoomIds: activeModePreferredRoomIds,
    })
      .then((res) => {
        if (!alive) return;
        const roomSet = new Set(activeModePreferredRoomIds);
        const nextSlots = (Array.isArray(res.data) ? res.data : []).filter((slot) => {
          if (roomSet.size > 0) {
            return roomSet.has(slot.roomId);
          }
          return matchesCourtNameByGameFormat(slot.roomName, resolvedGameFormat);
        });
        setTimeslots(nextSlots);
        if (res.error) {
          setTimeslotsError(res.error.message || "Не удалось загрузить расписание кортов");
        }
      })
      .catch(() => {
        if (!alive) return;
        setTimeslots([]);
        setTimeslotsError("Не удалось загрузить расписание кортов");
      })
      .finally(() => {
        if (alive) setLoadingTimeslots(false);
      });

    return () => {
      alive = false;
    };
  }, [
    step,
    studioId,
    studioMasterServiceId,
    activeModePreferredSubServiceId,
    activeModeSubServiceIds,
    activeModePreferredRoomIds,
    resolvedGameFormat,
    dateIndex,
    dates,
  ]);

  const requestUserLocation = useCallback(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setUserLocationError("Геолокация не поддерживается");
      return;
    }

    userLocationRequestedRef.current = true;
    setLocatingUser(true);
    setUserLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocatingUser(false);
      },
      (error) => {
        setLocatingUser(false);
        setUserLocationError(getGeoErrorMessage(error));
        userLocationRequestedRef.current = false;
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60_000,
      },
    );
  }, []);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;
    if (userLocation || locatingUser || autoLocationAttemptedRef.current) return;
    autoLocationAttemptedRef.current = true;
    requestUserLocation();
  }, [step, mapOpen, userLocation, locatingUser, requestUserLocation]);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;

    const missing = filteredStudios.filter((item) => {
      if (hasValidCoordinates(item.lat, item.lng)) return false;
      if (geocodedCoords[item.id]) return false;
      if (geocodingIdsRef.current.has(item.id)) return false;
      return true;
    });

    if (missing.length === 0) {
      setGeocodeLoading(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setGeocodeLoading(true);

    (async () => {
      for (const item of missing) {
        geocodingIdsRef.current.add(item.id);
        const coords = await geocodeStudio(item, controller.signal).catch(() => null);
        if (cancelled) return;
        if (coords) {
          setGeocodedCoords((prev) => (prev[item.id] ? prev : { ...prev, [item.id]: coords }));
        }
        await delay(150);
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setGeocodeLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [step, mapOpen, filteredStudios, geocodedCoords]);

  useEffect(() => {
    if (step !== "place" || !mapOpen) return;
    const host = mapHostRef.current;
    if (!host) return;

    let cancelled = false;
    setMapLoading(true);
    setMapError(null);

    loadLeaflet()
      .then((L) => {
        if (cancelled) return;

        if (!mapInstanceRef.current) {
          mapInstanceRef.current = L.map(host, {
            zoomControl: true,
            attributionControl: false,
          });
          L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
          }).addTo(mapInstanceRef.current);
          mapMarkersRef.current = L.layerGroup().addTo(mapInstanceRef.current);
        }

        const map = mapInstanceRef.current;
        if (!mapMarkersRef.current) {
          mapMarkersRef.current = L.layerGroup().addTo(map);
        }
        const markers = mapMarkersRef.current;
        markers.clearLayers();

        if (mapStudios.length === 0 && !userLocation) {
          map.setView([55.751244, 37.618423], 10);
          window.setTimeout(() => map.invalidateSize(), 0);
          setMapLoading(false);
          return;
        }

        const bounds: Array<[number, number]> = [];
        const studiosForViewport = userLocation
          ? pickNearestStudiosForViewport(
              mapStudios,
              { lat: userLocation.lat, lng: userLocation.lng },
              NEAREST_MAP_STUDIOS_LIMIT,
            )
          : mapStudios;
        mapStudios.forEach((item) => {
          const selected = item.id === studio?.id;
          const marker = L.circleMarker([item.lat, item.lng], {
            radius: selected ? 9 : 7,
            color: selected ? "#7353d9" : "#4b5563",
            fillColor: selected ? "#7353d9" : "#ffffff",
            fillOpacity: 1,
            weight: 2,
          });
          marker.bindTooltip(item.name, { direction: "top", offset: [0, -8] });
          marker.on("click", () => {
            setStudio(item);
            setStep("time");
            setMapOpen(false);
          });
          marker.addTo(markers);
        });

        studiosForViewport.forEach((item) => {
          bounds.push([item.lat, item.lng]);
        });

        if (userLocation) {
          const meMarker = L.circleMarker([userLocation.lat, userLocation.lng], {
            radius: 8,
            color: "#0284c7",
            fillColor: "#0ea5e9",
            fillOpacity: 1,
            weight: 2,
          });
          meMarker.bindTooltip("Вы здесь", { direction: "top", offset: [0, -8] });
          meMarker.addTo(markers);
          if (Number.isFinite(userLocation.accuracy) && userLocation.accuracy > 0) {
            L.circle([userLocation.lat, userLocation.lng], {
              radius: userLocation.accuracy,
              color: "#0ea5e9",
              fillColor: "#38bdf8",
              fillOpacity: 0.14,
              weight: 1,
            }).addTo(markers);
          }
          bounds.push([userLocation.lat, userLocation.lng]);
        }

        if (bounds.length === 1) {
          map.setView(bounds[0], 12);
        } else {
          map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
        }

        window.setTimeout(() => map.invalidateSize(), 0);
        setMapLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMapError("Не удалось загрузить карту");
        setMapLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, mapOpen, mapStudios, studio?.id, userLocation]);

  useEffect(() => {
    if (step === "place" && mapOpen) return;
    autoLocationAttemptedRef.current = false;
    userLocationRequestedRef.current = false;
    if (!mapInstanceRef.current) return;
    mapInstanceRef.current.remove();
    mapInstanceRef.current = null;
    mapMarkersRef.current = null;
  }, [step, mapOpen]);

  useEffect(() => {
    const requestedGameId = openGameId?.trim() || "";
    if (!requestedGameId) return;
    const requestedOpenStep: Step = openChat ? "chat" : "details";
    const requestedOpenKey = `${requestedGameId}:${requestedOpenStep}`;
    if (openedGameInitKeyRef.current === requestedOpenKey) return;
    openedGameInitKeyRef.current = requestedOpenKey;

    setGameRecordError(null);
    setGameRosterError(null);
    setGameRecordId(requestedGameId);
    setGameRecordStatus(null);
    setInviteLink(null);
    setGameSnapshot(null);
    setActiveGameRecordStore((prev) => {
      if (prev?.id === requestedGameId) return prev;
      return communityGames.find((game) => game.id === requestedGameId) ?? null;
    });
    setChatMessages([]);
    setChatError(null);
    setChatDraft("");
    setConfirmCancelUnpaidGame(false);
    setStep(requestedOpenStep);
  }, [openGameId, openChat]);

  useEffect(() => {
    const activeId = (gameRecordId || "").trim();
    if (!activeId) {
      setActiveGameRecordStore(null);
      return;
    }
    setActiveGameRecordStore((prev) => {
      if (prev?.id === activeId) return prev;
      return communityGames.find((game) => game.id === activeId) ?? null;
    });
  }, [gameRecordId, communityGames]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const paymentRef = url.searchParams.get(PAYMENT_REF_QUERY_KEY)?.trim() || "";
    if (!paymentRef) return;
    const bookingIdsFromUrl = extractBookingIdsFromUrl(url);
    const parsedDraft: PendingPaidGameDraft | null = getPendingPaidGameDraft(paymentRef);

    let alive = true;
    setRestoringPaidGame(true);
    setGameRecordError(null);

    if (parsedDraft) {
      const draftSnapshot = buildMatchSnapshotFromPayload(parsedDraft.payload);
      setGameSnapshot(draftSnapshot);
      setGamePaymentUrl(parsedDraft.payload.payment?.paymentUrl ?? null);
      setGamePaid(parsedDraft.payload.payment?.paid ?? null);
      restorePromoState(parsedDraft.payload.metadata, parsedDraft.payload.payment?.amount ?? null);
    }

    const cleanupUrl = () => {
      url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
      const search = url.searchParams.toString();
      const nextUrl = `${url.pathname}${search ? `?${search}` : ""}`;
      window.history.replaceState({}, "", nextUrl);
    };

    const applyResolvedRecord = (record: PadelGameRecord, draftPayload: PadelGameRecordPayload | null) => {
      const createdId = record.id;
      const draftSnapshot = draftPayload ? buildMatchSnapshotFromPayload(draftPayload) : null;
      const fallbackInviteUrl = buildInviteFallbackUrl(createdId);
      const nextInviteLink =
        record.inviteUrl ??
        draftPayload?.invite?.inviteUrl ??
        fallbackInviteUrl ??
        null;
      const recordSnapshot = buildMatchSnapshotFromRecord(record);

      setGameRecordId(createdId);
      setGameRecordStatus(record.status ?? draftPayload?.status ?? "PAID");
      setInviteLink(normalizeInviteUrl(nextInviteLink));
      setGameSnapshot((prev) =>
        mergeMatchSnapshots(mergeMatchSnapshots(prev, draftSnapshot), recordSnapshot),
      );
      if (record.payment?.paymentUrl) {
        setGamePaymentUrl(record.payment.paymentUrl);
      } else if (draftPayload?.payment?.paymentUrl) {
        setGamePaymentUrl(draftPayload.payment.paymentUrl);
      }
      if (record.payment?.paid !== undefined && record.payment?.paid !== null) {
        setGamePaid(record.payment.paid);
      } else if (draftPayload?.payment?.paid !== undefined) {
        setGamePaid(draftPayload.payment.paid ?? null);
      }
      if (record.payment?.amount != null) {
        setSlotPrice(record.payment.amount);
      } else if (draftPayload?.payment?.amount != null) {
        setSlotPrice(draftPayload.payment.amount);
      }
      restorePromoState(
        record.metadata ?? draftPayload?.metadata ?? null,
        record.payment?.amount ?? draftPayload?.payment?.amount ?? null,
      );

      if (draftPayload) {
        const fallbackRecord: PadelGameRecord = {
          id: createdId,
          inviteUrl: normalizeInviteUrl(nextInviteLink),
          status: record.status ?? draftPayload.status ?? "PAID",
          organizer: {
            id: draftPayload.organizer.id ?? null,
            name: draftPayload.organizer.name ?? null,
            phone: draftPayload.organizer.phone ?? null,
            photo: draftPayload.organizer.photo ?? null,
            rating: draftPayload.organizer.rating ?? null,
          },
          settings: {
            ratingGame: draftPayload.settings?.ratingGame ?? null,
            minRating: draftPayload.settings?.minRating ?? null,
            maxRating: draftPayload.settings?.maxRating ?? null,
            isPrivate: draftPayload.settings?.isPrivate ?? null,
          },
          participants: Array.isArray(draftPayload.participants)
            ? draftPayload.participants
            : [],
          waitlist: Array.isArray(draftPayload.waitlist)
            ? draftPayload.waitlist
            : [],
          chatUrl: null,
          metadata: draftPayload.metadata ?? null,
          booking: draftSnapshot
            ? {
                studioName: draftSnapshot.studioName,
                roomName: draftSnapshot.roomName,
                date: draftSnapshot.date,
                timeFrom: draftSnapshot.timeFrom,
                timeTo: draftSnapshot.timeTo,
                durationMinutes: draftSnapshot.durationMinutes,
              }
            : null,
          payment: {
            amount: record.payment?.amount ?? draftPayload.payment.amount ?? null,
            paymentUrl: record.payment?.paymentUrl ?? draftPayload.payment.paymentUrl ?? null,
            paid: record.payment?.paid ?? draftPayload.payment.paid ?? null,
          },
        };
        const nextRecord: PadelGameRecord = {
          ...fallbackRecord,
          ...record,
          organizer: record.organizer ?? fallbackRecord.organizer,
          settings: record.settings ?? fallbackRecord.settings,
          participants:
            record.participants && record.participants.length > 0
              ? record.participants
              : fallbackRecord.participants,
          waitlist:
            record.waitlist && record.waitlist.length > 0
              ? record.waitlist
              : fallbackRecord.waitlist,
          metadata: record.metadata ?? fallbackRecord.metadata,
          chatUrl: record.chatUrl ?? fallbackRecord.chatUrl,
          booking: record.booking ?? fallbackRecord.booking,
          payment: record.payment ?? fallbackRecord.payment,
        };
        upsertGameRecordInStores(nextRecord, { communityMode: "upsert" });
        notifyGameRecordsUpdated([nextRecord], "games_payment_callback");
        void runPaidGameCommunityMembershipAndPublication(nextRecord, "payment_callback");
        setParticipants(
          Array.isArray(draftPayload.participants)
            ? draftPayload.participants
            : [],
        );
        setWaitlistPlayers(
          Array.isArray(draftPayload.waitlist)
            ? draftPayload.waitlist
            : [],
        );
        setWaitlistEnabled(draftPayload.invite?.waitlistEnabled !== false);
      } else {
        upsertGameRecordInStores(record, { communityMode: "upsert" });
        notifyGameRecordsUpdated([record], "games_payment_callback");
        void runPaidGameCommunityMembershipAndPublication(record, "payment_callback");
      }

      setStep("details");
    };

    (async () => {
      enqueuePendingPaymentSync(paymentRef, bookingIdsFromUrl, "games_callback");

      const syncResult = await processPendingPaymentSyncQueue({
        forcePaymentRef: paymentRef,
        forceBookingIds: bookingIdsFromUrl,
        source: "games_callback",
        keepalive: true,
        maxItems: 1,
      });
      if (!alive) return;

      const resolvedItem = syncResult.resolved.find((item) => item.paymentRef === paymentRef)
        ?? syncResult.resolved[0]
        ?? null;
      if (resolvedItem?.record?.id) {
        applyResolvedRecord(resolvedItem.record, parsedDraft?.payload ?? null);
      } else {
        const failedItem = syncResult.failed.find((item) => item.paymentRef === paymentRef)
          ?? syncResult.failed[0]
          ?? null;
        setGameRecordError(
          failedItem?.error
            || (parsedDraft
              ? "Не удалось синхронизировать оплату игры"
              : "Не найдена игра после оплаты: отсутствуют данные черновика"),
        );
      }

      cleanupUrl();
      setRestoringPaidGame(false);
    })();

    return () => {
      alive = false;
    };
  }, []);

  const selectedCourt = availableCourts.find((c) => c.id === courtId);
  const selectedCourtName = selectedCourt?.name ?? null;
  const selectedDate = dates[dateIndex];
  const selectedSlot = useMemo<GameTimeSlot | null>(() => {
    if (!courtId || !time) return null;
    const candidates = durationScopedSlots.filter(
      (slot) => slot.roomId === courtId && slot.time === time,
    );
    if (candidates.length === 0) return null;
    const byDuration = candidates.find((slot) => slot.durationMinutes === duration);
    if (byDuration) return byDuration;
    const withSubService = candidates.find((slot) => slot.subServiceIds.length > 0);
    return withSubService ?? candidates[0];
  }, [durationScopedSlots, courtId, time, duration]);
  const selectedSlotId = selectedSlot?.id ?? null;
  const selectedSlotSubServiceIds = useMemo(
    () => selectedSlot?.subServiceIds ?? [],
    [selectedSlot?.subServiceIds],
  );
  const resolvedSelectedSubServiceIds = useMemo(
    () =>
      selectedSlotSubServiceIds.length > 0
        ? selectedSlotSubServiceIds
        : activeModeSubServiceIds,
    [selectedSlotSubServiceIds, activeModeSubServiceIds],
  );
  const promoSelectionKey = [
    studioId ?? "",
    selectedDate ? formatDateLocalIso(selectedDate) : "",
    courtId ?? "",
    time ?? "",
    String(duration),
    selectedSlotId ?? "",
    [...resolvedSelectedSubServiceIds].sort().join(","),
  ].join("|");
  const bookingPreset = useMemo(() => {
    const bookingId = normalizeBookingId(createFromBooking?.bookingId);
    const date = toDateKey(createFromBooking?.date ?? null);
    const timeFrom = toTimeKey(createFromBooking?.timeFrom ?? null);
    const timeTo = toTimeKey(createFromBooking?.timeTo ?? null);
    const durationFromPayload =
      typeof createFromBooking?.durationMinutes === "number" && Number.isFinite(createFromBooking.durationMinutes)
        ? Math.max(1, Math.round(createFromBooking.durationMinutes))
        : null;
    const durationFromTime = (() => {
      if (!timeFrom || !timeTo) return null;
      const [fromHourRaw, fromMinuteRaw] = timeFrom.split(":");
      const [toHourRaw, toMinuteRaw] = timeTo.split(":");
      const fromHour = Number.parseInt(fromHourRaw || "", 10);
      const fromMinute = Number.parseInt(fromMinuteRaw || "", 10);
      const toHour = Number.parseInt(toHourRaw || "", 10);
      const toMinute = Number.parseInt(toMinuteRaw || "", 10);
      if (!Number.isFinite(fromHour) || !Number.isFinite(fromMinute)) return null;
      if (!Number.isFinite(toHour) || !Number.isFinite(toMinute)) return null;
      const fromTotal = fromHour * 60 + fromMinute;
      const toTotal = toHour * 60 + toMinute;
      const delta = toTotal > fromTotal ? toTotal - fromTotal : null;
      return delta && delta > 0 ? delta : null;
    })();
    const durationMinutes = durationFromPayload ?? durationFromTime ?? 60;
    const studioId = createFromBooking?.studioId?.trim() || "";
    const roomId = createFromBooking?.roomId?.trim() || "";
    const studioName = createFromBooking?.studioName?.trim() || "Станция";
    const roomName = createFromBooking?.roomName?.trim() || "Корт";
    const slotId = createFromBooking?.slotId?.trim() || null;
    const exerciseId = createFromBooking?.exerciseId?.trim() || null;
    const directionName = createFromBooking?.directionName?.trim() || null;
    const paymentUrl = createFromBooking?.paymentUrl?.trim() || null;
    const paid = createFromBooking?.paid === true
      ? true
      : createFromBooking?.paid === false
        ? false
        : false;
    const amount = typeof createFromBooking?.amount === "number" && Number.isFinite(createFromBooking.amount)
      ? Math.max(0, Math.round(createFromBooking.amount))
      : null;
    const isMode = Boolean(bookingId);
    const canCreateFromPreset = Boolean(
      bookingId
      && date
      && timeFrom
      && timeTo
      && studioId
      && roomId,
    );

    return {
      isMode,
      canCreateFromPreset,
      bookingId,
      date,
      timeFrom,
      timeTo,
      durationMinutes,
      studioId,
      studioName,
      roomId,
      roomName,
      slotId,
      exerciseId,
      directionName,
      paymentUrl,
      paid,
      amount,
    };
  }, [createFromBooking]);
  const isBookingPresetMode = bookingPreset.isMode;
  const bookingPresetDateValue = bookingPreset.date ? new Date(`${bookingPreset.date}T00:00:00`) : null;
  const bookingPresetDateLabel = bookingPresetDateValue
    ? bookingPresetDateValue.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "";
  const bookingPresetTimeRange = bookingPreset.timeFrom && bookingPreset.timeTo
    ? `${bookingPreset.timeFrom} - ${bookingPreset.timeTo}`
    : null;
  const bookingPresetMeta = [
    bookingPresetTimeRange,
    `${bookingPreset.durationMinutes} мин`,
    bookingPreset.roomName,
  ].filter(Boolean).join(" · ");
  const communityAutopublishStationName = useMemo(() => {
    const rawName = isBookingPresetMode ? bookingPreset.studioName : studioName;
    return rawName?.trim() || null;
  }, [bookingPreset.studioName, isBookingPresetMode, studioName]);
  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "";
  const badgeMonth = selectedDate
    ? selectedDate
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : "";
  const badgeDay = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "2-digit" })
    : "";

  useEffect(() => {
    if (!studioId || !selectedDate || !courtId || !time || !selectedSlotId) {
      setSlotPrice(null);
      setLoadingSlotPrice(false);
      return;
    }

    let alive = true;
    setLoadingSlotPrice(true);
    setSlotPrice(null);

    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const fromDate = formatDateLocalIso(selectedDate);

    apiFetchMasterServicePrice({
      date: fromDate,
      fromTime,
      toTime,
      studioId,
      roomId: courtId,
      subServiceIds: resolvedSelectedSubServiceIds,
      masterServiceId: studioMasterServiceId,
    })
      .then((res) => {
        if (!alive) return;
        if (typeof res.data === "number") {
          setSlotPrice(res.data);
          return;
        }
        setSlotPrice(null);
      })
      .catch(() => {
        if (!alive) return;
        setSlotPrice(null);
      })
      .finally(() => {
        if (alive) setLoadingSlotPrice(false);
      });

    return () => {
      alive = false;
    };
  }, [
    studioId,
    studioMasterServiceId,
    selectedDate,
    courtId,
    time,
    duration,
    selectedSlotId,
    resolvedSelectedSubServiceIds,
  ]);

  useEffect(() => {
    const previousPromoSelectionKey = previousPromoSelectionKeyRef.current;
    previousPromoSelectionKeyRef.current = promoSelectionKey;
    if (previousPromoSelectionKey == null || previousPromoSelectionKey === promoSelectionKey) return;
    clearPromoState();
  }, [promoSelectionKey, clearPromoState]);

  const ratingSubLabel = effectiveRatingGame
    ? "Игра на уровень, результаты игры изменяет уровень участников"
    : "Дружеская игра не влияет на уровень участников";
  const minPercent = (minRating / (RATING_LABELS.length - 1)) * 100;
  const maxPercent = (maxRating / (RATING_LABELS.length - 1)) * 100;

  const initials = profileName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const ringSegments = 135;
  const filledSegments = Math.round(ringFraction * ringSegments);
  const selectedGameFormatLabel = resolvedGameFormat === "singles" ? "1 на 1" : "2 на 2";
  const noFormatSlots = !loadingTimeslots && !timeslotsError && timeslots.length === 0;
  const noDurationSlots =
    !loadingTimeslots &&
    !timeslotsError &&
    timeslots.length > 0 &&
    durationScopedSlots.length === 0;
  const noTimeSlotsForSelection =
    !loadingTimeslots &&
    !timeslotsError &&
    !noFormatSlots &&
    !noDurationSlots &&
    availableTimeSlots.length === 0;
  const noCourtsForSelection =
    !loadingTimeslots &&
    !timeslotsError &&
    !noFormatSlots &&
    !noDurationSlots &&
    availableCourts.length === 0;
  const isPlaceStepComplete = isBookingPresetMode ? bookingPreset.canCreateFromPreset : Boolean(studio);
  const isTimeStepComplete = isBookingPresetMode
    ? bookingPreset.canCreateFromPreset
    : Boolean(studio && selectedDate && selectedCourt && selectedSlot && time);
  const canContinueGameCreation = isBookingPresetMode
    ? bookingPreset.canCreateFromPreset
    : Boolean(isPlaceStepComplete && isTimeStepComplete);
  const canProceedToPayment = Boolean(studio && selectedDate && selectedCourt && selectedSlot && time);
  const showInlinePaymentSection = !isBookingPresetMode && canProceedToPayment;
  const basePaymentAmount = slotPrice ?? selectedSlot?.price ?? selectedCourt?.price ?? null;
  const paymentAmount = promoPricePreview ?? basePaymentAmount;
  const activeSplitPaymentPromoConfig = resolveSplitPaymentPromoConfigForSelection({
    config: splitPaymentPromoConfig,
    date: selectedDate,
    studioId,
    studioName,
    roomId: courtId,
    roomName: selectedCourtName,
  });
  const splitPaymentAvailable = ENABLE_SPLIT_GAME_PAYMENT && splitPaymentTesterUnlocked;
  const splitPaymentSelected = splitPaymentAvailable && paymentMode === "split";
  const paymentModeSubLabel = splitPaymentSelected
    ? "Разделить оплату на 4-ых"
    : splitPaymentTesterUnlocked
      ? "Тестовый режим активирован · оплачу игру один"
      : "Оплачу игру один";
  const splitShareAmount = paymentAmount != null && paymentAmount > 0
    ? Math.max(0, Math.round(paymentAmount / Math.max(splitShareCount, 1)))
    : resolveSplitShareAmount(splitShareCount, activeSplitPaymentPromoConfig, duration);
  const splitPaymentSummary = `${formatPrice(splitShareAmount)} ₽ × ${splitShareCount}`;
  const splitRequiredTypeIds = useMemo(
    () => buildComparableIdSet([
      SPLIT_OPEN_GAME_EXERCISE_TYPE_ID,
      DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.vivaExerciseTypeId,
      activeSplitPaymentPromoConfig.vivaExerciseTypeId,
    ]),
    [activeSplitPaymentPromoConfig.vivaExerciseTypeId],
  );
  const splitRequiredDirectionIds = useMemo(
    () => buildComparableIdSet([
      SPLIT_OPEN_GAME_DIRECTION_ID,
      DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.vivaDirectionId,
      activeSplitPaymentPromoConfig.vivaDirectionId,
    ]),
    [activeSplitPaymentPromoConfig.vivaDirectionId],
  );
  const splitHasEligibleSubscriptions = splitSubscriptions.length > 0;
  const normalizedGameTitle = gameTitleDraft.trim();
  const normalizedGameParticipantComment = gameParticipantCommentDraft.trim();
  const normalizedGameJoinPrice = gameJoinPriceDraft.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  const splitJoinPriceAutoAmount = paymentAmount != null && paymentAmount > 0
    ? Math.max(0, Math.round(paymentAmount / 4))
    : 0;
  const splitJoinPriceAutoValue = splitJoinPriceAutoAmount > 0 ? String(splitJoinPriceAutoAmount) : "";
  const hasSelectedCommunityAutopublish = selectedCommunityAutopublishIds.length > 0;
  const showPublicationFields = !isPrivate || hasSelectedCommunityAutopublish;
  const publicationFieldsNote = !isPrivate
    ? (
      hasSelectedCommunityAutopublish
        ? "Открытая игра будет опубликована в общем списке и в выбранных сообществах. Любой участник выбранного сообщества сможет присоединиться к игре."
        : "Открытая игра будет опубликована в общем списке и доступна другим игрокам для присоединения."
    )
    : "Указанная игра будет опубликована в сообществе, любой участник выбранного сообщества сможет присоединиться к игре.";
  const paymentTitle = loadingPay
    ? "Оплатить · подготовка..."
    : loadingSlotPrice
      ? "Оплатить · расчет..."
    : paymentAmount != null && paymentAmount > 0
      ? `Оплатить · ${formatPrice(paymentAmount)} ₽`
      : "Оплатить · — ₽";
  const paymentSubmitTitle = splitPaymentSelected
    ? (
      loadingPay
        ? "Оплатить участие · подготовка..."
        : splitHasEligibleSubscriptions
          ? `Оплатить 1/4 стоимости · ${formatPrice(splitShareAmount)} ₽`
          : `Оплатить участие · ${formatPrice(splitShareAmount)} ₽`
    )
    : paymentTitle;
  const paymentStationCourt = studio && selectedCourt
    ? `${studio.name} · ${selectedCourt.name}`
    : "Выберите станцию и корт";
  const paymentTimeRange = time
    ? `${time} - ${addMinutesToTime(time, duration)} · ${duration} мин`
    : "Выберите время начала";
  const paymentContinueTitle = "Продолжить создание игры";
  const paymentBookingAmount = loadingSlotPrice
    ? "Сумма брони · расчет..."
    : paymentAmount != null && paymentAmount > 0
      ? `Сумма брони · ${formatPrice(paymentAmount)} ₽`
      : "Сумма брони · — ₽";
  const splitSubscriptionsLabel = splitPaymentSelected
    ? (
      splitSubscriptionsLoading
        ? "Проверяем доступные абонементы для split-оплаты..."
          : splitSubscriptionsError
            ? splitSubscriptionsError
            : splitSubscriptions.length > 0
            ? buildSplitSubscriptionStatusLabel(splitSubscriptions)
            : "Подходящий абонемент не найден, доступна оплата 1/4 стоимости."
    )
    : null;
  const splitPaymentAvailabilityLabel = splitPaymentSelected ? splitSubscriptionsLabel : null;
  const splitPaymentAvailabilityLabelIsError = splitPaymentSelected ? Boolean(splitSubscriptionsError) : false;
  const loadSplitSubscriptions = useCallback(async () => {
    const requestId = splitSubscriptionRequestRef.current + 1;
    splitSubscriptionRequestRef.current = requestId;
    setSplitSubscriptionsLoading(true);
    setSplitSubscriptionsError(null);

    try {
      const result = await apiFetchSubscriptions();
      if (splitSubscriptionRequestRef.current !== requestId) return;
      if (result.error) {
        setSplitSubscriptions([]);
        setSplitSubscriptionsError(result.error.message || "Не удалось получить абонементы");
        return;
      }

      const subscriptions = Array.isArray(result.data?.content) ? result.data.content : [];
      const eligible = filterSplitEligibleSubscriptions(subscriptions, splitRequiredTypeIds, splitRequiredDirectionIds);
      setSplitSubscriptions(eligible);
      setSplitSubscriptionsError(null);
    } catch {
      if (splitSubscriptionRequestRef.current !== requestId) return;
      setSplitSubscriptions([]);
      setSplitSubscriptionsError("Не удалось получить абонементы");
    } finally {
      if (splitSubscriptionRequestRef.current === requestId) {
        setSplitSubscriptionsLoading(false);
      }
    }
  }, [splitRequiredTypeIds, splitRequiredDirectionIds]);
  const handlePaymentModeSwitchTap = useCallback(() => {
    if (!splitPaymentTesterUnlocked) {
      const tapState = splitPaymentUnlockTapStateRef.current;
      tapState.count += 1;

      if (tapState.timeoutId != null && typeof window !== "undefined") {
        window.clearTimeout(tapState.timeoutId);
        tapState.timeoutId = null;
      }

      if (tapState.count >= SPLIT_PAYMENT_UNLOCK_TAP_COUNT) {
        tapState.count = 0;
        setSplitPaymentTesterUnlocked(true);
        setPromoStatusMessage("Тестовый режим split-оплаты активирован");
        setPromoError(null);
        setPaymentMode((current) => {
          const nextMode = current === "split" ? "self" : "split";
          if (nextMode === "split") {
            setSplitShareCount(4);
          }
          return nextMode;
        });
        return;
      }

      if (typeof window !== "undefined") {
        tapState.timeoutId = window.setTimeout(() => {
          splitPaymentUnlockTapStateRef.current.count = 0;
          splitPaymentUnlockTapStateRef.current.timeoutId = null;
        }, SPLIT_PAYMENT_UNLOCK_RESET_MS);
      }
      return;
    }

    setPaymentMode((current) => {
      const nextMode = current === "split" ? "self" : "split";
      if (nextMode === "split") {
        setSplitShareCount(4);
      }
      return nextMode;
    });
  }, [splitPaymentTesterUnlocked]);
  useEffect(() => {
    if (!splitPaymentSelected) return;
    void loadSplitSubscriptions();
  }, [splitPaymentSelected, loadSplitSubscriptions]);
  useEffect(() => {
    if (paymentMode === "split" && !splitPaymentAvailable) {
      setPaymentMode("self");
    }
  }, [paymentMode, splitPaymentAvailable]);
  useEffect(() => {
    if (splitPaymentSelected) {
      splitJoinPriceAutofilledRef.current = true;
      setGameJoinPriceDraft(splitJoinPriceAutoValue);
      return;
    }

    if (splitJoinPriceAutofilledRef.current) {
      setGameJoinPriceDraft("");
      splitJoinPriceAutofilledRef.current = false;
    }
  }, [splitPaymentSelected, splitJoinPriceAutoValue]);
  useEffect(() => {
    if (loadingPay) return;
    if (!promoCodeApplied || promoDiscountAmount == null || basePaymentAmount == null) return;
    const nextPreview = Math.max(basePaymentAmount - promoDiscountAmount, 0);
    setPromoPricePreview((current) => (current === nextPreview ? current : nextPreview));
  }, [promoCodeApplied, promoDiscountAmount, basePaymentAmount, loadingPay]);
  const gameStatusUpper = (gameRecordStatus ?? "").trim().toUpperCase();
  const paidByStatus = gameStatusUpper.includes("PAID") || gameStatusUpper.includes("PAYED");
  const unpaidByStatus =
    gameStatusUpper.includes("PENDING") ||
    gameStatusUpper.includes("UNPAID") ||
    gameStatusUpper.includes("NOT_PAID");
  const isGamePaid = gamePaid ?? (paidByStatus ? true : unpaidByStatus ? false : null);
  const detailsDateKey = gameSnapshot?.date ?? (selectedDate ? formatDateLocalIso(selectedDate) : null);
  const detailsDateValue = detailsDateKey ? new Date(`${detailsDateKey}T00:00:00`) : null;
  const detailsDateLabel = detailsDateValue
    ? detailsDateValue.toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      })
    : "Дата не указана";
  const detailsBadgeMonth = detailsDateValue
    ? detailsDateValue
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : badgeMonth;
  const detailsBadgeDay = detailsDateValue
    ? detailsDateValue.toLocaleDateString("ru-RU", { day: "2-digit" })
    : badgeDay;
  const detailsTimeFrom = gameSnapshot?.timeFrom ?? time ?? null;
  const detailsDurationMinutes = gameSnapshot?.durationMinutes ?? duration;
  const detailsTimeTo =
    gameSnapshot?.timeTo ??
    (detailsTimeFrom ? addMinutesToTime(detailsTimeFrom, detailsDurationMinutes) : null);
  const detailsStudioName = gameSnapshot?.studioName ?? studio?.name ?? "Станция";
  const detailsRoomName = gameSnapshot?.roomName ?? selectedCourt?.name ?? "Корт";
  const detailsAmount = gameSnapshot?.amount ?? paymentAmount;
  const upsertGameRecordInStores = useCallback((
    incoming: PadelGameRecord,
    options?: { communityMode?: "upsert" | "if_exists" | "skip" },
  ) => {
    const communityMode = options?.communityMode ?? "if_exists";
    if (communityMode !== "skip") {
      setCommunityGames((prev) => {
        if (communityMode === "if_exists" && !prev.some((item) => item.id === incoming.id)) {
          return prev;
        }
        return upsertPadelGameRecord(prev, incoming);
      });
    }
    setActiveGameRecordStore((prev) => {
      const activeId = (gameRecordId || "").trim();
      if (activeId && incoming.id === activeId) {
        return prev ? mergePadelGameRecord(prev, incoming) : incoming;
      }
      if (prev && prev.id === incoming.id) {
        return mergePadelGameRecord(prev, incoming);
      }
      return prev;
    });
  }, [gameRecordId]);
  const removeGameRecordFromStores = useCallback((targetId: string) => {
    const normalizedId = targetId.trim();
    if (!normalizedId) return;
    setCommunityGames((prev) => prev.filter((item) => item.id !== normalizedId));
    setActiveGameRecordStore((prev) => (prev?.id === normalizedId ? null : prev));
  }, []);
  const activeGameRecord = useMemo(
    () => {
      if (!gameRecordId) return null;
      if (activeGameRecordStore?.id === gameRecordId) return activeGameRecordStore;
      return communityGames.find((item) => item.id === gameRecordId) ?? null;
    },
    [activeGameRecordStore, communityGames, gameRecordId],
  );
  const activeGameMetadata = isRecordObject(activeGameRecord?.metadata) ? activeGameRecord.metadata : null;
  const detailsGameTitle = extractGameCustomTitle(activeGameMetadata) ?? normalizedGameTitle ?? null;
  const detailsGameParticipantComment = extractGameParticipantComment(activeGameMetadata)
    ?? normalizedGameParticipantComment
    ?? null;
  const currentGameUnreadCount = gameRecordId ? (chatUnreadByGame[gameRecordId] ?? 0) : 0;
  const currentChatReadTs = gameRecordId ? (chatReadMap[gameRecordId] ?? 0) : 0;
  const matchesCurrentUserByIdentity = useCallback((
    idRaw: string | null | undefined,
    phoneRaw: string | null | undefined,
  ) => {
    const normalizedProfileId = (profileId || "").trim();
    const normalizedEntityId = (idRaw || "").trim();
    if (normalizedProfileId && normalizedEntityId && normalizedProfileId === normalizedEntityId) {
      return true;
    }
    const normalizedEntityPhone = normalizePhoneForGame(phoneRaw ?? null);
    return Boolean(profilePhoneNorm && normalizedEntityPhone && normalizedEntityPhone === profilePhoneNorm);
  }, [profileId, profilePhoneNorm]);
  const isCurrentUserOrganizerOfGame = useCallback((game: PadelGameRecord | null | undefined) => {
    if (!game) return false;
    if (matchesCurrentUserByIdentity(game.organizer?.id ?? null, game.organizer?.phone ?? null)) {
      return true;
    }

    const organizerFromParticipants = (game.participants ?? []).find((player) => {
      const source = String(player.source || "").trim().toUpperCase();
      return source === "ORGANIZER";
    });
    if (
      organizerFromParticipants
      && matchesCurrentUserByIdentity(organizerFromParticipants.id, organizerFromParticipants.phone)
    ) {
      return true;
    }

    const metadata = isRecordObject(game.metadata) ? game.metadata : null;
    const metadataOrganizerId =
      metadata && typeof metadata.organizerId === "string"
        ? metadata.organizerId
        : null;
    const metadataOrganizerPhone =
      metadata && typeof metadata.organizerPhone === "string"
        ? metadata.organizerPhone
        : null;
    return matchesCurrentUserByIdentity(metadataOrganizerId, metadataOrganizerPhone);
  }, [matchesCurrentUserByIdentity]);
  const isCurrentUserOrganizerOfActiveGame = useMemo(
    () => isCurrentUserOrganizerOfGame(activeGameRecord),
    [activeGameRecord, isCurrentUserOrganizerOfGame],
  );
  const canCurrentUserInviteInDetails = isGamePaid !== false
    && isCurrentUserOrganizerOfActiveGame
    && !isGameCancelledStatus(gameRecordStatus)
    && Boolean(inviteLink);
  const detailsMaxPlayers = useMemo(() => {
    const maxPlayers = activeGameRecord?.invite?.maxPlayers;
    if (typeof maxPlayers === "number" && Number.isFinite(maxPlayers) && maxPlayers > 0) {
      return Math.max(1, Math.floor(maxPlayers));
    }
    return MAX_DOUBLES_PLAYERS;
  }, [activeGameRecord?.invite?.maxPlayers]);
  const detailsTeamPairIndexes = useMemo(() => {
    if (detailsMaxPlayers <= 2) return [[0, 1]];
    return [[0, 1], [2, 3]];
  }, [detailsMaxPlayers]);
  const detailsTeamSubtitle = detailsMaxPlayers <= 2
    ? "1 пара по 2 игрока"
    : "2 пары по 2 игрока";
  const detailsOrganizerPlayer = useMemo<PadelGamePlayer | null>(() => {
    if (activeGameRecord?.organizer) {
      const organizerIsCurrentUser = matchesCurrentUserByIdentity(
        activeGameRecord.organizer.id ?? null,
        activeGameRecord.organizer.phone ?? null,
      );
      const resolvedNumeric = organizerIsCurrentUser
        ? normalizeRatingNumeric(profileRatingNumeric ?? activeGameRecord.organizer.ratingNumeric)
        : normalizeRatingNumeric(activeGameRecord.organizer.ratingNumeric);
      const resolvedRating = organizerIsCurrentUser
        ? (profileGrade
          ?? activeGameRecord.organizer.rating
          ?? (resolvedNumeric != null ? mapNumericToRatingGrade(resolvedNumeric) : null))
        : (activeGameRecord.organizer.rating
          ?? (resolvedNumeric != null ? mapNumericToRatingGrade(resolvedNumeric) : null));
      return {
        id: activeGameRecord.organizer.id ?? null,
        name: activeGameRecord.organizer.name || "Организатор",
        phone: activeGameRecord.organizer.phone ?? null,
        photo: activeGameRecord.organizer.photo ?? null,
        rating: resolvedRating ?? null,
        ratingNumeric: resolvedNumeric ?? null,
        source: "ORGANIZER",
        status: "CONFIRMED",
      };
    }
    const organizerFallback = (activeGameRecord?.participants ?? []).find((player) => {
      const source = String(player.source || "").trim().toUpperCase();
      return source === "ORGANIZER";
    }) ?? null;
    if (!organizerFallback) return null;
    const organizerIsCurrentUser = matchesCurrentUserByIdentity(
      organizerFallback.id,
      organizerFallback.phone,
    );
    const resolvedNumeric = organizerIsCurrentUser
      ? normalizeRatingNumeric(profileRatingNumeric ?? organizerFallback.ratingNumeric)
      : normalizeRatingNumeric(organizerFallback.ratingNumeric);
    const resolvedRating = organizerIsCurrentUser
      ? (profileGrade
        ?? organizerFallback.rating
        ?? (resolvedNumeric != null ? mapNumericToRatingGrade(resolvedNumeric) : null))
      : (organizerFallback.rating
        ?? (resolvedNumeric != null ? mapNumericToRatingGrade(resolvedNumeric) : null));
    return {
      ...organizerFallback,
      rating: resolvedRating ?? null,
      ratingNumeric: resolvedNumeric ?? null,
    };
  }, [
    activeGameRecord?.organizer,
    activeGameRecord?.participants,
    matchesCurrentUserByIdentity,
    profileGrade,
    profileRatingNumeric,
  ]);
  const isCurrentUserOrganizerByDetails = useMemo(
    () => matchesCurrentUserByIdentity(detailsOrganizerPlayer?.id, detailsOrganizerPlayer?.phone),
    [detailsOrganizerPlayer?.id, detailsOrganizerPlayer?.phone, matchesCurrentUserByIdentity],
  );
  const detailsOrganizerPayload = useMemo(
    () => ({
      id: activeGameRecord?.organizer?.id ?? detailsOrganizerPlayer?.id ?? null,
      name: activeGameRecord?.organizer?.name ?? detailsOrganizerPlayer?.name ?? "Организатор",
      phone: activeGameRecord?.organizer?.phone ?? detailsOrganizerPlayer?.phone ?? null,
      photo: activeGameRecord?.organizer?.photo ?? detailsOrganizerPlayer?.photo ?? null,
      rating: activeGameRecord?.organizer?.rating ?? detailsOrganizerPlayer?.rating ?? null,
      ratingNumeric:
        activeGameRecord?.organizer?.ratingNumeric
        ?? detailsOrganizerPlayer?.ratingNumeric
        ?? null,
    }),
    [
      activeGameRecord?.organizer,
      detailsOrganizerPlayer,
    ],
  );
  const detailsMetadata = useMemo<Record<string, unknown>>(
    () => (isRecordObject(activeGameRecord?.metadata) ? activeGameRecord.metadata : {}),
    [activeGameRecord?.metadata],
  );
  const detailsCommunityAutopublishSelectionState = useMemo(
    () => extractCommunityAutopublishSelectionState(detailsMetadata),
    [detailsMetadata],
  );
  const detailsCommunityAutopublishPostsMap = useMemo(
    () => extractCommunityAutopublishPostsMap(detailsMetadata),
    [detailsMetadata],
  );
  const detailsSavedCommunityAutopublishEntries = useMemo(
    () => extractCommunityAutopublishSavedCommunities(detailsMetadata),
    [detailsMetadata],
  );
  const detailsPendingCommunityAutopublishIds = useMemo(
    () => detailsCommunityAutopublishSelectionState.selectedCommunityIds.filter((communityId) => (
      !detailsCommunityAutopublishPostsMap[communityId]
    )),
    [detailsCommunityAutopublishPostsMap, detailsCommunityAutopublishSelectionState],
  );
  const detailsSelectedCommunityUnpublishIdsSet = useMemo(
    () => new Set(detailsSelectedCommunityUnpublishIds),
    [detailsSelectedCommunityUnpublishIds],
  );
  const detailsPublishedCommunityCards = useMemo(() => {
    const targetById = new Map<string, CommunityAutopublishTarget>([
      ...(communityAutopublishStationTarget ? [[communityAutopublishStationTarget.id, communityAutopublishStationTarget] as const] : []),
      ...communityAutopublishMemberTargets.map((target) => [target.id, target] as const),
    ]);
    const savedById = new Map(
      detailsSavedCommunityAutopublishEntries.map((entry) => [entry.communityId, entry] as const),
    );
    const orderedCommunityIds = Array.from(new Set([
      ...detailsCommunityAutopublishSelectionState.selectedCommunityIds.filter((communityId) => (
        Boolean(detailsCommunityAutopublishPostsMap[communityId])
      )),
      ...detailsSavedCommunityAutopublishEntries
        .filter((entry) => Boolean(entry.postId))
        .map((entry) => entry.communityId),
      ...Object.keys(detailsCommunityAutopublishPostsMap),
    ]));

    return orderedCommunityIds
      .map((communityId) => {
        const postId = detailsCommunityAutopublishPostsMap[communityId]?.trim()
          || savedById.get(communityId)?.postId
          || null;
        if (!postId) return null;

        const target = targetById.get(communityId) ?? null;
        const savedEntry = savedById.get(communityId) ?? null;
        return {
          key: `published:${communityId}`,
          communityId,
          postId,
          name: target?.name ?? savedEntry?.communityName ?? communityId,
          logo: target?.logo ?? null,
          selected: detailsSelectedCommunityUnpublishIdsSet.has(communityId),
        };
      })
      .filter((card): card is {
        key: string;
        communityId: string;
        postId: string;
        name: string;
        logo: string | null;
        selected: boolean;
      } => Boolean(card));
  }, [
    communityAutopublishMemberTargets,
    communityAutopublishStationTarget,
    detailsCommunityAutopublishPostsMap,
    detailsCommunityAutopublishSelectionState.selectedCommunityIds,
    detailsSavedCommunityAutopublishEntries,
    detailsSelectedCommunityUnpublishIdsSet,
  ]);
  const detailsMatchResultVivaSync = useMemo<MatchResultVivaSyncState | null>(() => {
    const rawMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : null;
    if (!rawMatchResult) return null;
    return normalizeMatchResultVivaSync(
      rawMatchResult.vivaSync
      ?? rawMatchResult.viva_sync
      ?? rawMatchResult.vivaStatus,
    );
  }, [detailsMetadata]);
  const detailsOrganizerKey = useMemo(
    () => getPadelPlayerIdentityKey(detailsOrganizerPlayer) || null,
    [detailsOrganizerPlayer],
  );
  const detailsSourceParticipants = useMemo<PadelGamePlayer[]>(() => (
    activeGameRecord?.participants && activeGameRecord.participants.length > 0
      ? activeGameRecord.participants
      : participants
  ), [activeGameRecord?.participants, participants]);
  const detailsOrganizerInMatch = useMemo(() => {
    if (typeof detailsMetadata.organizerInMatch === "boolean") {
      return detailsMetadata.organizerInMatch;
    }
    if (!detailsOrganizerKey) {
      return detailsSourceParticipants.length === 0;
    }
    return detailsSourceParticipants.some((player) => (
      getPadelPlayerIdentityKey(player) === detailsOrganizerKey
    )) || detailsSourceParticipants.length === 0;
  }, [detailsMetadata, detailsOrganizerKey, detailsSourceParticipants]);
  useEffect(() => {
    setDetailsSelectedCommunityUnpublishIds([]);
  }, [activeGameRecord?.id, detailsPublishedCommunityCards.length]);
  const detailsParticipants = useMemo<PadelGamePlayer[]>(() => {
    const map = new Map<string, PadelGamePlayer>();

    if (detailsOrganizerPlayer && detailsOrganizerInMatch) {
      const organizerKey = getPadelPlayerIdentityKey(detailsOrganizerPlayer) || "organizer";
      map.set(organizerKey, {
        ...detailsOrganizerPlayer,
        source: "ORGANIZER",
        status: "CONFIRMED",
      });
    }

    detailsSourceParticipants.forEach((player) => {
      const key = getPadelPlayerIdentityKey(player)
        || `participant-${map.size + 1}`;
      if (!detailsOrganizerInMatch && detailsOrganizerKey && key === detailsOrganizerKey) {
        return;
      }
      const existing = map.get(key);
      const normalized: PadelGamePlayer = {
        ...player,
        source: existing?.source ?? player.source ?? "INVITE_LINK",
        status: player.status ?? existing?.status ?? "CONFIRMED",
      };
      if (!existing || normalized.source === "ORGANIZER") {
        map.set(key, normalized);
      }
    });

    return Array.from(map.values()).slice(0, detailsMaxPlayers);
  }, [
    detailsSourceParticipants,
    detailsOrganizerInMatch,
    detailsOrganizerKey,
    detailsOrganizerPlayer,
    detailsMaxPlayers,
  ]);
  const detailsWaitlist = useMemo<PadelGamePlayer[]>(() => {
    const sourceWaitlist =
      activeGameRecord?.waitlist && activeGameRecord.waitlist.length > 0
        ? activeGameRecord.waitlist
        : waitlistPlayers;
    const participantKeys = new Set(
      detailsParticipants
        .map((player) => getPadelPlayerIdentityKey(player))
        .filter(Boolean),
    );

    return sourceWaitlist.filter((player) => {
      const key = getPadelPlayerIdentityKey(player);
      return !key || !participantKeys.has(key);
    });
  }, [activeGameRecord?.waitlist, waitlistPlayers, detailsParticipants]);
  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !activeGameRecord?.id) {
      return;
    }

    const sourceParticipants =
      activeGameRecord?.participants && activeGameRecord.participants.length > 0
        ? activeGameRecord.participants
        : participants;
    const sourceWaitlist =
      activeGameRecord?.waitlist && activeGameRecord.waitlist.length > 0
        ? activeGameRecord.waitlist
        : waitlistPlayers;

    const uniquePlayers = new Map<string, PadelGamePlayer>();
    const addPlayer = (player: PadelGamePlayer | null | undefined) => {
      if (!player) return;
      const keys = getPadelPlayerLookupKeys(player);
      if (keys.length === 0) return;
      if (!uniquePlayers.has(keys[0])) {
        uniquePlayers.set(keys[0], player);
      }
    };

    sourceParticipants.forEach(addPlayer);
    sourceWaitlist.forEach(addPlayer);
    if (activeGameRecord?.organizer) {
      addPlayer({
        id: activeGameRecord.organizer.id ?? null,
        name: activeGameRecord.organizer.name || "Организатор",
        phone: activeGameRecord.organizer.phone ?? null,
        photo: activeGameRecord.organizer.photo ?? null,
        rating: activeGameRecord.organizer.rating ?? null,
        ratingNumeric: activeGameRecord.organizer.ratingNumeric ?? null,
        source: "ORGANIZER",
        status: "CONFIRMED",
      });
    }
    if (profilePhoneNorm || profileId || profileName) {
      addPlayer({
        id: profileId ?? null,
        name: profileName || "Игрок",
        phone: profilePhoneNorm ?? profilePhone ?? null,
        photo: profilePhoto ?? null,
        rating: profileGrade ?? null,
        ratingNumeric: profileRatingNumeric ?? null,
        status: "CONFIRMED",
      });
    }

    const players = Array.from(uniquePlayers.values());
    if (players.length === 0) return;

    const refreshKey = buildPadelPlayersRefreshKey(
      activeGameRecord.id,
      sourceParticipants,
      sourceWaitlist,
      activeGameRecord.organizer,
    );
    if (detailsRatingsRefreshKeyRef.current === refreshKey) {
      return;
    }
    detailsRatingsRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    void (async () => {
      const liveRatingsResult = await apiFetchPadelLiveRatings(
        players.map((player) => ({
          clientId: (player.id || "").trim() || null,
          phone: (player.id || "").trim() ? null : normalizePhoneForGame(player.phone),
          name: player.name || null,
          rating: player.rating ?? null,
          ratingNumeric: normalizeRatingNumeric(player.ratingNumeric),
        })),
      );

      const enrichedByKey = new Map<string, EnrichedPadelPlayerData>();
      const upsertEnriched = (value: EnrichedPadelPlayerData) => {
        getPadelPlayerLookupKeys(value).forEach((key) => {
          const current = enrichedByKey.get(key);
          enrichedByKey.set(key, {
            id: value.id ?? current?.id ?? null,
            phone: value.phone ?? current?.phone ?? null,
            name: value.name ?? current?.name ?? null,
            photo: value.photo ?? current?.photo ?? null,
            rating: value.rating ?? current?.rating ?? null,
            ratingNumeric: value.ratingNumeric ?? current?.ratingNumeric ?? null,
          });
        });
      };

      players.forEach((player) => {
        upsertEnriched({
          id: player.id ?? null,
          phone: normalizePhoneForGame(player.phone),
          name: player.name,
          photo: player.photo ?? null,
          rating: player.rating ?? null,
          ratingNumeric: normalizeRatingNumeric(player.ratingNumeric),
        });
      });

      (liveRatingsResult.data ?? []).forEach((item) => {
        upsertEnriched({
          id: item.clientId ?? null,
          phone: normalizePhoneForGame(item.phoneNorm),
          name: item.name ?? null,
          photo: null,
          rating: item.rating || mapNumericToRatingGrade(item.ratingNumeric) || null,
          ratingNumeric: normalizeRatingNumeric(item.ratingNumeric),
        });
      });

      const playersMissingRating = players.filter((player) => {
        const fresh = getPadelPlayerLookupKeys(player)
          .map((key) => enrichedByKey.get(key))
          .find(Boolean);
        return !fresh?.rating && fresh?.ratingNumeric == null;
      });

      if (playersMissingRating.length > 0) {
        const searchResults = await Promise.all(
          playersMissingRating.slice(0, 12).map(async (player) => {
            const query = (player.id || "").trim()
              || normalizePhoneForGame(player.phone)
              || player.name.trim();
            if (!query) return null;
            const result = await apiSearchPadelPlayers(query, 8);
            const playerKeys = new Set(getPadelPlayerLookupKeys(player));
            const match = result.data.find((candidate) => (
              getPadelPlayerLookupKeys(candidate).some((key) => playerKeys.has(key))
            )) ?? null;
            if (!match) return null;
            return {
              id: match.id ?? null,
              phone: normalizePhoneForGame(match.phone),
              name: match.name ?? null,
              photo: match.photo ?? null,
              rating: match.rating || mapNumericToRatingGrade(match.ratingNumeric) || null,
              ratingNumeric: normalizeRatingNumeric(match.ratingNumeric),
            } satisfies EnrichedPadelPlayerData;
          }),
        );

        searchResults.forEach((item) => {
          if (item) upsertEnriched(item);
        });
      }

      if (cancelled) return;

      const enrichPlayerArray = (list: PadelGamePlayer[]) => {
        let changed = false;
        const next = list.map((player) => {
          const fresh = getPadelPlayerLookupKeys(player)
            .map((key) => enrichedByKey.get(key))
            .find(Boolean);
          const merged = mergePadelPlayerFreshData(player, fresh);
          if (merged !== player) changed = true;
          return merged;
        });
        return changed ? next : list;
      };

      if (activeGameRecord?.id) {
        const nextOrganizer = mergePadelOrganizerFreshData(
          activeGameRecord.organizer,
          activeGameRecord.organizer
            ? getPadelPlayerLookupKeys(activeGameRecord.organizer).map((key) => enrichedByKey.get(key)).find(Boolean)
            : undefined,
        );
        const nextParticipants = Array.isArray(activeGameRecord.participants)
          ? enrichPlayerArray(activeGameRecord.participants)
          : activeGameRecord.participants;
        const nextWaitlist = Array.isArray(activeGameRecord.waitlist)
          ? enrichPlayerArray(activeGameRecord.waitlist)
          : activeGameRecord.waitlist;
        if (
          nextOrganizer !== activeGameRecord.organizer
          || nextParticipants !== activeGameRecord.participants
          || nextWaitlist !== activeGameRecord.waitlist
        ) {
          upsertGameRecordInStores(
            {
              ...activeGameRecord,
              organizer: nextOrganizer,
              participants: nextParticipants,
              waitlist: nextWaitlist,
            },
            { communityMode: "if_exists" },
          );
        }
      }

      if (!(activeGameRecord?.participants && activeGameRecord.participants.length > 0)) {
        setParticipants((prev) => enrichPlayerArray(prev));
      }
      if (!(activeGameRecord?.waitlist && activeGameRecord.waitlist.length > 0)) {
        setWaitlistPlayers((prev) => enrichPlayerArray(prev));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeGameRecord?.id,
    activeGameRecord?.organizer,
    activeGameRecord?.participants,
    activeGameRecord?.waitlist,
    participants,
    profileGrade,
    profileId,
    profileName,
    profilePhone,
    profilePhoneNorm,
    profilePhoto,
    profileRatingNumeric,
    step,
    upsertGameRecordInStores,
    waitlistPlayers,
  ]);
  useEffect(() => {
    if (step === "details" || step === "chat") return;
    detailsRatingsRefreshKeyRef.current = null;
  }, [step, activeGameRecord?.id]);
  const chatSenderPhotoByIdentity = useMemo(() => {
    const map = new Map<string, string>();

    const upsertPlayer = (player: PadelGamePlayer | null | undefined) => {
      if (!player) return;
      const photo = (player.photo || "").trim();
      if (!photo) return;

      const byPhone = normalizePhoneForGame(player.phone);
      if (byPhone) {
        map.set(`phone:${byPhone}`, photo);
      }

      const byId = (player.id || "").trim();
      if (byId) {
        map.set(`id:${byId}`, photo);
      }

      const byName = (player.name || "").trim().toLowerCase();
      if (byName) {
        map.set(`name:${byName}`, photo);
      }
    };

    upsertPlayer(detailsOrganizerPlayer);
    detailsParticipants.forEach((player) => upsertPlayer(player));
    detailsWaitlist.forEach((player) => upsertPlayer(player));
    participants.forEach((player) => upsertPlayer(player));
    waitlistPlayers.forEach((player) => upsertPlayer(player));

    if (profilePhoto) {
      if (profilePhoneNorm) {
        map.set(`phone:${profilePhoneNorm}`, profilePhoto);
      }
      if (profileId?.trim()) {
        map.set(`id:${profileId.trim()}`, profilePhoto);
      }
      if (profileName?.trim()) {
        map.set(`name:${profileName.trim().toLowerCase()}`, profilePhoto);
      }
    }

    return map;
  }, [
    detailsOrganizerPlayer,
    detailsParticipants,
    detailsWaitlist,
    participants,
    waitlistPlayers,
    profilePhoto,
    profilePhoneNorm,
    profileId,
    profileName,
  ]);
  const chatRenderItems = useMemo(() => {
    const items: Array<
      | { kind: "day"; key: string; label: string }
      | { kind: "message"; key: string; message: PadelGameChatMessage }
    > = [];

    let previousDayKey = "";
    chatMessages.forEach((message, index) => {
      const dayKey = getChatDateKey(message.createdAt, message.createdTs);
      if (dayKey && dayKey !== previousDayKey) {
        items.push({
          kind: "day",
          key: `day-${dayKey}`,
          label: formatChatDateLabel(message.createdAt, message.createdTs),
        });
        previousDayKey = dayKey;
      }

      const senderKey = getChatSenderStableKey(message);
      items.push({
        kind: "message",
        key: `msg-${message.createdTs}-${senderKey}-${index}`,
        message,
      });
    });

    return items;
  }, [chatMessages]);
  const canManagePlayersInDetails = Boolean(
    gameRecordId && (isCurrentUserOrganizerOfActiveGame || isCurrentUserOrganizerByDetails),
  );
  const detailsHasFreeSlots = detailsParticipants.length < detailsMaxPlayers;
  const isDetailsOrganizerPlayer = useCallback((player: PadelGamePlayer | null | undefined) => {
    const organizerKey = getPadelPlayerIdentityKey(detailsOrganizerPlayer);
    const playerKey = getPadelPlayerIdentityKey(player);
    return Boolean(organizerKey && playerKey && organizerKey === playerKey);
  }, [detailsOrganizerPlayer]);
  const canCurrentUserSendChat = useMemo(() => {
    const myPhone = normalizePhoneForGame(profilePhone);
    if (!myPhone) return false;
    if (!activeGameRecord) return true;

    const phones = new Set<string>();
    const pushPhone = (value: string | null | undefined) => {
      const normalized = normalizePhoneForGame(value);
      if (normalized) {
        phones.add(normalized);
      }
    };
    const pushFromUnknownArray = (value: unknown) => {
      if (!Array.isArray(value)) return;
      value.forEach((item) => {
        if (typeof item === "string") {
          pushPhone(item);
        }
      });
    };

    pushPhone(activeGameRecord.organizer?.phone ?? null);
    activeGameRecord.participants?.forEach((player) => pushPhone(player.phone));
    activeGameRecord.waitlist?.forEach((player) => pushPhone(player.phone));

    const metadata = activeGameRecord.metadata;
    if (metadata) {
      pushFromUnknownArray(metadata.allRelatedPhones);
      pushFromUnknownArray(metadata.participantPhones);
      pushFromUnknownArray(metadata.waitlistPhones);
      pushFromUnknownArray(metadata.invitedPhones);
    }

    if (phones.size === 0) return true;
    return phones.has(myPhone);
  }, [activeGameRecord, profilePhone]);
  const isCurrentUserPlayer = useCallback((player: PadelGamePlayer | null | undefined) => {
    if (!player) return false;
    const normalizedProfileId = (profileId || "").trim();
    const playerId = (player.id || "").trim();
    if (normalizedProfileId && playerId && normalizedProfileId === playerId) {
      return true;
    }
    const playerPhoneNorm = normalizePhoneForGame(player.phone);
    return Boolean(profilePhoneNorm && playerPhoneNorm && profilePhoneNorm === playerPhoneNorm);
  }, [profileId, profilePhoneNorm]);
  const detailsLeaveEvents = useMemo(
    () => normalizeGameLeaveEvents(
      detailsMetadata.leaveEvents
      ?? detailsMetadata.playerLeaveEvents
      ?? detailsMetadata.leftPlayers
      ?? [],
    ),
    [detailsMetadata],
  );
  const detailsCurrentUserParticipant = useMemo(
    () => detailsParticipants.find((player) => isCurrentUserPlayer(player)) ?? null,
    [detailsParticipants, isCurrentUserPlayer],
  );
  const isCurrentUserConfirmedParticipant = Boolean(detailsCurrentUserParticipant);
  const isCurrentUserInWaitlist = useMemo(
    () => detailsWaitlist.some((player) => isCurrentUserPlayer(player)),
    [detailsWaitlist, isCurrentUserPlayer],
  );
  const hasCurrentUserIdentityInDetails = Boolean((profileId || "").trim() || profilePhoneNorm);
  const isDetailsWaitlistEnabled = activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled;
  const canCurrentUserJoinGameInDetails = Boolean(
    gameRecordId
    && !isCurrentUserOrganizerByDetails
    && !updatingGameRoster
    && !updatingGameMeta
    && hasCurrentUserIdentityInDetails
    && !isCurrentUserConfirmedParticipant
    && !isCurrentUserInWaitlist
    && (detailsHasFreeSlots || isDetailsWaitlistEnabled),
  );
  const canCurrentUserLeaveGameInDetails = Boolean(
    gameRecordId
    && !isCurrentUserOrganizerByDetails
    && !updatingGameRoster
    && !updatingGameMeta
    && (isCurrentUserConfirmedParticipant || detailsWaitlist.some((player) => isCurrentUserPlayer(player))),
  );
  const detailsTeamSlotKeys = useMemo(
    () => detailsTeamSlots.map((player) => getPadelPlayerIdentityKey(player) || null),
    [detailsTeamSlots],
  );
  const detailsCurrentUserTeamSlotIndex = useMemo(
    () => detailsTeamSlots.findIndex((player) => isCurrentUserPlayer(player)),
    [detailsTeamSlots, isCurrentUserPlayer],
  );
  const detailsCurrentUserTeamIndex = detailsCurrentUserTeamSlotIndex < 0
    ? null
    : (detailsCurrentUserTeamSlotIndex < 2 ? 1 : 2);
  const detailsMatchStartAt = useMemo(() => {
    if (!detailsDateKey || !detailsTimeFrom) return null;
    const timeValue = /^\d{2}:\d{2}$/.test(detailsTimeFrom) ? `${detailsTimeFrom}:00` : detailsTimeFrom;
    const parsed = new Date(`${detailsDateKey}T${timeValue}`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }, [detailsDateKey, detailsTimeFrom]);
  const isDetailsMatchStarted = detailsMatchStartAt
    ? Date.now() >= detailsMatchStartAt.getTime()
    : false;
  const canCurrentUserAccessResultTab = isCurrentUserOrganizerByDetails || isCurrentUserConfirmedParticipant;

  useEffect(() => {
    setDetailsActiveTab(isDetailsMatchStarted && canCurrentUserAccessResultTab ? "result" : "game");
  }, [activeGameRecord?.id, isDetailsMatchStarted, canCurrentUserAccessResultTab]);

  useEffect(() => {
    if (detailsActiveTab === "result" && !canCurrentUserAccessResultTab) {
      setDetailsActiveTab("game");
    }
  }, [detailsActiveTab, canCurrentUserAccessResultTab]);

  useEffect(() => {
    const participantByKey = new Map<string, PadelGamePlayer>();
    const participantById = new Map<string, string>();
    const participantByPhone = new Map<string, string>();
    const participantByName = new Map<string, string>();

    detailsParticipants.forEach((player) => {
      const key = getPadelPlayerIdentityKey(player);
      if (!key) return;
      participantByKey.set(key, player);
      const id = (player.id || "").trim();
      if (id) participantById.set(id, key);
      const phone = normalizePhoneForGame(player.phone);
      if (phone) participantByPhone.set(phone, key);
      const name = (player.name || "").trim().toLowerCase();
      if (name) participantByName.set(name, key);
    });

    const resolvePlayerKey = (value: unknown): string | null => {
      if (typeof value === "string") {
        const byString = value.trim();
        if (participantByKey.has(byString)) return byString;
        const byId = participantById.get(byString);
        if (byId) return byId;
        const byPhone = participantByPhone.get(normalizePhoneForGame(byString) || "");
        if (byPhone) return byPhone;
      }

      if (isRecordObject(value)) {
        const maybeId = typeof value.id === "string" ? value.id.trim() : "";
        if (maybeId && participantById.has(maybeId)) return participantById.get(maybeId) ?? null;

        const maybePhone = typeof value.phone === "string"
          ? normalizePhoneForGame(value.phone)
          : null;
        if (maybePhone && participantByPhone.has(maybePhone)) {
          return participantByPhone.get(maybePhone) ?? null;
        }

        const maybeName = typeof value.name === "string" ? value.name.trim().toLowerCase() : "";
        if (maybeName && participantByName.has(maybeName)) {
          return participantByName.get(maybeName) ?? null;
        }
      }

      return null;
    };

    const rawTeamSlots = Array.isArray(detailsMetadata.teamSlots) ? detailsMetadata.teamSlots : [];
    const parsedKeys = Array.from({ length: DETAILS_TEAM_SLOTS_COUNT }, (_, index) =>
      resolvePlayerKey(rawTeamSlots[index]),
    );

    const nextSlotKeys: Array<string | null> = Array.from(
      { length: DETAILS_TEAM_SLOTS_COUNT },
      () => null,
    );
    const usedKeys = new Set<string>();

    if (detailsOrganizerInMatch && detailsOrganizerKey && participantByKey.has(detailsOrganizerKey)) {
      nextSlotKeys[0] = detailsOrganizerKey;
      usedKeys.add(detailsOrganizerKey);
    }

    parsedKeys.forEach((key, index) => {
      if (!key) return;
      if (!participantByKey.has(key)) return;
      if (usedKeys.has(key)) return;
      if (detailsOrganizerKey && key === detailsOrganizerKey) return;
      if (detailsOrganizerInMatch && index === 0 && detailsOrganizerKey) return;
      nextSlotKeys[index] = key;
      usedKeys.add(key);
    });

    setDetailsTeamSlots(
      nextSlotKeys.map((key) => (key ? participantByKey.get(key) ?? null : null)),
    );
    setDetailsTeamMenuSlotIndex(null);
    setDetailsPairComposerSetIndex(null);

    const toPerson = (value: unknown) => {
      if (!isRecordObject(value)) return null;
      return {
        id: typeof value.id === "string" ? value.id.trim() || null : null,
        phone:
          typeof value.phone === "string"
            ? normalizePhoneForGame(value.phone)
            : typeof value.phoneNorm === "string"
              ? normalizePhoneForGame(value.phoneNorm)
              : null,
        name: typeof value.name === "string" ? value.name.trim() || null : null,
      };
    };

    const rawMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : null;
    if (!rawMatchResult) {
      setDetailsMatchResultSets([{ left: "", right: "" }]);
      setDetailsMatchResultSetPairings(createEmptyMatchResultSetPairings());
      setDetailsMatchResultStatus(null);
      setDetailsMatchResultSubmittedBy(null);
      setDetailsMatchResultSubmittedAt(null);
      setDetailsMatchResultDisputeDeadlineAt(null);
      setDetailsMatchResultConfirmedBy(null);
      setDetailsMatchResultConfirmedAt(null);
      setDetailsMatchResultRatingImpact([]);
      setDetailsMatchResultDisputedBy(null);
      setDetailsMatchResultDisputedAt(null);
      setDetailsMatchResultAttachments([]);
      setGameDetailsMetaError(null);
      return;
    }

    const parsedSets = Array.isArray(rawMatchResult.sets)
      ? rawMatchResult.sets
          .map((item) => {
            if (!isRecordObject(item)) return null;
            const leftNumber = Number(item.left);
            const rightNumber = Number(item.right);
            if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return null;
            return {
              left: String(Math.max(0, Math.floor(leftNumber))),
              right: String(Math.max(0, Math.floor(rightNumber))),
            };
          })
          .filter((item): item is EditableMatchResultSet => Boolean(item))
      : [];
    const parsedSetPairings = createEmptyMatchResultSetPairings();
    const rawSetPairings = Array.isArray(rawMatchResult.setPairings)
      ? rawMatchResult.setPairings
      : Array.isArray(rawMatchResult.pairings)
        ? rawMatchResult.pairings
        : [];

    rawSetPairings.forEach((item, rawIndex) => {
      let setIndex = rawIndex;
      let rawTeamSlots: unknown = item;

      if (isRecordObject(item)) {
        const setIndexRaw = toFiniteNumber(item.setIndex);
        const setNumberRaw = toFiniteNumber(item.setNumber);
        const explicitSetIndex = (setIndexRaw != null && Number.isInteger(setIndexRaw))
          ? setIndexRaw
          : (
            setNumberRaw != null && Number.isInteger(setNumberRaw)
              ? setNumberRaw - 1
              : rawIndex
          );
        setIndex = explicitSetIndex;
        rawTeamSlots = Array.isArray(item.teamSlots)
          ? item.teamSlots
          : Array.isArray(item.slots)
            ? item.slots
            : null;
      }

      if (!Array.isArray(rawTeamSlots)) return;
      if (setIndex < 0 || setIndex >= MAX_MATCH_RESULT_SETS) return;

      const resolvedSlots = cloneTeamSlots(
        rawTeamSlots.map((value) => {
          const key = resolvePlayerKey(value);
          return key ? participantByKey.get(key) ?? null : null;
        }),
      );

      if (!resolvedSlots.some(Boolean)) return;
      parsedSetPairings[setIndex] = resolvedSlots;
    });
    const normalizedSetPairings = materializeCompletedMatchResultSetPairings(
      parsedSetPairings,
      parsedSets.length,
    );

    const normalizedStatus = normalizeMatchResultStatus(rawMatchResult.status);
    const submittedAt = typeof rawMatchResult.submittedAt === "string" ? rawMatchResult.submittedAt : null;

    setDetailsMatchResultSets(
      normalizeEditableScoreSets(parsedSets.length > 0 ? parsedSets : [{ left: "", right: "" }]),
    );
    setDetailsMatchResultSetPairings(normalizedSetPairings);
    setDetailsMatchResultStatus(normalizedStatus || null);
    setDetailsMatchResultSubmittedBy(toPerson(rawMatchResult.submittedBy));
    setDetailsMatchResultSubmittedAt(submittedAt);
    setDetailsMatchResultDisputeDeadlineAt(
      getMatchResultDisputeDeadlineAt(
        submittedAt,
        typeof rawMatchResult.disputeDeadlineAt === "string"
          ? rawMatchResult.disputeDeadlineAt
          : typeof rawMatchResult.reviewDeadlineAt === "string"
            ? rawMatchResult.reviewDeadlineAt
            : null,
      ),
    );
    setDetailsMatchResultConfirmedBy(toPerson(rawMatchResult.confirmedBy));
    setDetailsMatchResultConfirmedAt(
      typeof rawMatchResult.confirmedAt === "string" ? rawMatchResult.confirmedAt : null,
    );
    setDetailsMatchResultRatingImpact(normalizeMatchResultRatingImpact(rawMatchResult.ratingImpact));
    setDetailsMatchResultDisputedBy(toPerson(rawMatchResult.disputedBy));
    setDetailsMatchResultDisputedAt(
      typeof rawMatchResult.disputedAt === "string" ? rawMatchResult.disputedAt : null,
    );
    setDetailsMatchResultAttachments(
      normalizeMatchResultAttachments(
        rawMatchResult.photos
        ?? rawMatchResult.attachments
        ?? rawMatchResult.images
        ?? [],
      ),
    );
    setGameDetailsMetaError(null);
  }, [detailsMetadata, detailsParticipants, detailsOrganizerInMatch, detailsOrganizerKey, gameRecordId]);

  useEffect(() => {
    if (!isPendingMatchResultStatus(detailsMatchResultStatus)) return;

    setMatchResultNowTs(Date.now());
    const intervalId = window.setInterval(() => {
      setMatchResultNowTs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [detailsMatchResultStatus]);

  useEffect(() => {
    let cancelled = false;

    if (detailsMatchResultAttachments.length === 0) {
      setDetailsMatchResultPhotoLogoVariants({});
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const resolvedVariants = await Promise.all(
        detailsMatchResultAttachments.map(async (attachment) => ([
          attachment.id,
          await resolveMatchResultPhotoLogoVariant(attachment.dataUrl),
        ] as const)),
      );

      if (cancelled) return;
      setDetailsMatchResultPhotoLogoVariants(Object.fromEntries(resolvedVariants));
    })();

    return () => {
      cancelled = true;
    };
  }, [detailsMatchResultAttachments]);

  const detailsCompletedMatchResultSets = useMemo(
    () => detailsMatchResultSets.filter((setItem) => setItem.left !== "" && setItem.right !== ""),
    [detailsMatchResultSets],
  );
  const detailsLastCompletedMatchResultSetIndex = detailsCompletedMatchResultSets.length - 1;
  const isMatchResultSubmittedByCurrentUser = useMemo(() => {
    if (!detailsMatchResultSubmittedBy) return false;
    const submittedId = (detailsMatchResultSubmittedBy.id || "").trim();
    const profileIdValue = (profileId || "").trim();
    if (submittedId && profileIdValue && submittedId === profileIdValue) {
      return true;
    }
    const submittedPhone = normalizePhoneForGame(detailsMatchResultSubmittedBy.phone);
    return Boolean(submittedPhone && profilePhoneNorm && submittedPhone === profilePhoneNorm);
  }, [detailsMatchResultSubmittedBy, profileId, profilePhoneNorm]);
  const detailsSubmittedByPlayer = useMemo(() => {
    if (!detailsMatchResultSubmittedBy) return null;
    return (
      detailsParticipants.find((player) => {
        const submittedId = (detailsMatchResultSubmittedBy.id || "").trim();
        const playerId = (player.id || "").trim();
        if (submittedId && playerId && submittedId === playerId) return true;
        const submittedPhone = normalizePhoneForGame(detailsMatchResultSubmittedBy.phone);
        const playerPhone = normalizePhoneForGame(player.phone);
        if (submittedPhone && playerPhone && submittedPhone === playerPhone) return true;
        return false;
      }) ?? null
    );
  }, [detailsMatchResultSubmittedBy, detailsParticipants]);
  const detailsSubmittedByTeamIndex = useMemo(() => {
    if (!detailsSubmittedByPlayer) return null;
    const slotIndex = detailsTeamSlots.findIndex((player) =>
      getPadelPlayerIdentityKey(player) === getPadelPlayerIdentityKey(detailsSubmittedByPlayer),
    );
    if (slotIndex < 0) return null;
    return slotIndex < 2 ? 1 : 2;
  }, [detailsTeamSlots, detailsSubmittedByPlayer]);
  const isMatchResultPendingReview = useMemo(
    () => isPendingMatchResultStatus(detailsMatchResultStatus),
    [detailsMatchResultStatus],
  );
  const isMatchResultAgreed = useMemo(
    () => (
      isConfirmedMatchResultStatus(detailsMatchResultStatus)
      || Boolean(detailsMatchResultConfirmedAt || detailsMatchResultConfirmedBy)
    ),
    [detailsMatchResultConfirmedAt, detailsMatchResultConfirmedBy, detailsMatchResultStatus],
  );
  const detailsMatchResultDisputeDeadlineTs = useMemo(
    () => parseIsoTimestamp(detailsMatchResultDisputeDeadlineAt),
    [detailsMatchResultDisputeDeadlineAt],
  );
  const detailsMatchResultDisputeTimeLeftMs = useMemo(() => {
    if (detailsMatchResultDisputeDeadlineTs == null) return null;
    return Math.max(0, detailsMatchResultDisputeDeadlineTs - matchResultNowTs);
  }, [detailsMatchResultDisputeDeadlineTs, matchResultNowTs]);
  const canEditMatchResult = isDetailsMatchStarted
    && isCurrentUserConfirmedParticipant
    && !isMatchResultPendingReview
    && !isMatchResultAgreed;
  const canSubmitMatchResult = canEditMatchResult
    && detailsCompletedMatchResultSets.length > 0
    && !updatingGameMeta;
  const canDisputeMatchResult = isDetailsMatchStarted
    && isCurrentUserConfirmedParticipant
    && isMatchResultPendingReview
    && !isMatchResultSubmittedByCurrentUser
    && detailsCurrentUserTeamIndex != null
    && detailsSubmittedByTeamIndex != null
    && detailsCurrentUserTeamIndex !== detailsSubmittedByTeamIndex
    && (detailsMatchResultDisputeTimeLeftMs == null || detailsMatchResultDisputeTimeLeftMs > 0)
    && !updatingGameMeta;
  const detailsTeamMenuOptions = useMemo(() => {
    if (detailsTeamMenuSlotIndex == null) return [] as PadelGamePlayer[];
    const availablePlayers = new Map<string, PadelGamePlayer>();

    const pushAvailablePlayer = (player: PadelGamePlayer | null | undefined) => {
      const playerKey = getPadelPlayerIdentityKey(player);
      if (!player || !playerKey) return;
      if (availablePlayers.has(playerKey)) return;
      availablePlayers.set(playerKey, player);
    };

    if (detailsTeamMenuSlotIndex === 0) {
      detailsParticipants.forEach((player) => {
        if (detailsOrganizerKey && getPadelPlayerIdentityKey(player) === detailsOrganizerKey) return;
        pushAvailablePlayer(player);
      });
      if (detailsOrganizerInMatch) {
        detailsWaitlist.forEach((player) => pushAvailablePlayer(player));
      } else if (detailsOrganizerPlayer && detailsHasFreeSlots) {
        pushAvailablePlayer({
          ...detailsOrganizerPlayer,
          source: "ORGANIZER",
          status: "CONFIRMED",
        });
      }
    } else {
      detailsParticipants.forEach((player) => pushAvailablePlayer(player));
      detailsWaitlist.forEach((player) => pushAvailablePlayer(player));
    }

    const usedKeys = new Set<string>(
      detailsTeamSlotKeys
        .map((key, index) => (index === detailsTeamMenuSlotIndex ? null : key))
        .filter((value): value is string => Boolean(value)),
    );

    return Array.from(availablePlayers.values()).filter((player) => {
      const playerKey = getPadelPlayerIdentityKey(player);
      if (!playerKey) return false;
      if (detailsTeamMenuSlotIndex !== 0 && usedKeys.has(playerKey)) return false;
      if (detailsTeamMenuSlotIndex !== 0 && detailsOrganizerKey && playerKey === detailsOrganizerKey) {
        return false;
      }
      return true;
    });
  }, [
    detailsHasFreeSlots,
    detailsOrganizerInMatch,
    detailsOrganizerPlayer,
    detailsTeamMenuSlotIndex,
    detailsTeamSlotKeys,
    detailsParticipants,
    detailsWaitlist,
    detailsOrganizerKey,
  ]);
  const detailsPairingOptions = useMemo(() => {
    if (detailsMaxPlayers <= 2) return [] as MatchResultPairingOption[];

    const uniquePlayers = dedupePlayersByIdentity(detailsTeamSlots);
    if (uniquePlayers.length !== DETAILS_TEAM_SLOTS_COUNT) {
      return [] as MatchResultPairingOption[];
    }

    const anchorPlayer = detailsTeamSlots[0] ?? uniquePlayers[0] ?? null;
    const anchorKey = getPadelPlayerIdentityKey(anchorPlayer);
    if (!anchorPlayer || !anchorKey) return [] as MatchResultPairingOption[];

    const otherPlayers = uniquePlayers.filter((player) => getPadelPlayerIdentityKey(player) !== anchorKey);
    if (otherPlayers.length !== DETAILS_TEAM_SLOTS_COUNT - 1) {
      return [] as MatchResultPairingOption[];
    }

    return otherPlayers.map((partner) => {
      const partnerKey = getPadelPlayerIdentityKey(partner);
      const remainingPlayers = uniquePlayers.filter((player) => {
        const playerKey = getPadelPlayerIdentityKey(player);
        return playerKey !== anchorKey && playerKey !== partnerKey;
      });
      const nextSlots: Array<PadelGamePlayer | null> = [
        anchorPlayer,
        partner,
        remainingPlayers[0] ?? null,
        remainingPlayers[1] ?? null,
      ];
      const leftPairLabel = `${anchorPlayer.name || "Игрок"} + ${partner.name || "Игрок"}`;
      const rightPairLabel = `${remainingPlayers[0]?.name || "Игрок"} + ${remainingPlayers[1]?.name || "Игрок"}`;

      return {
        key: `${anchorKey}-${partnerKey || "partner"}`,
        label: `${leftPairLabel} / ${rightPairLabel}`,
        nextSlots,
        isCurrent: areTeamSlotsEqualByIdentity(nextSlots, detailsTeamSlots),
      };
    });
  }, [detailsMaxPlayers, detailsTeamSlots]);

  useEffect(() => {
    if (detailsPairComposerSetIndex == null) return;

    const canKeepOpen = (
      detailsPairComposerSetIndex === detailsLastCompletedMatchResultSetIndex
      && detailsPairComposerSetIndex + 1 < detailsMatchResultSets.length
      && detailsPairingOptions.length > 1
      && !isMatchResultPendingReview
      && !isMatchResultAgreed
    );

    if (!canKeepOpen) {
      setDetailsPairComposerSetIndex(null);
    }
  }, [
    detailsPairComposerSetIndex,
    detailsLastCompletedMatchResultSetIndex,
    detailsMatchResultSets.length,
    detailsPairingOptions.length,
    isMatchResultPendingReview,
    isMatchResultAgreed,
  ]);

  const handleDetailsServiceInfoTap = useCallback(() => {
    const tapState = detailsRevealTapStateRef.current;
    tapState.count += 1;

    if (tapState.timeoutId != null && typeof window !== "undefined") {
      window.clearTimeout(tapState.timeoutId);
      tapState.timeoutId = null;
    }

    if (tapState.count >= 4) {
      tapState.count = 0;
      setDetailsServiceInfoVisible((prev) => !prev);
      return;
    }

    if (typeof window !== "undefined") {
      tapState.timeoutId = window.setTimeout(() => {
        detailsRevealTapStateRef.current.count = 0;
        detailsRevealTapStateRef.current.timeoutId = null;
      }, 1400);
    }
  }, []);

  useEffect(() => {
    if (step !== "details") return;
    setDetailsServiceInfoVisible(false);
    setDetailsPaymentHintOpen(false);
    const tapState = detailsRevealTapStateRef.current;
    tapState.count = 0;
    if (tapState.timeoutId != null && typeof window !== "undefined") {
      window.clearTimeout(tapState.timeoutId);
      tapState.timeoutId = null;
    }
  }, [step, gameRecordId]);

  useEffect(() => {
    if (!detailsPaymentHintOpen) return;
    const timer = window.setTimeout(() => {
      setDetailsPaymentHintOpen(false);
    }, 2200);
    return () => {
      window.clearTimeout(timer);
    };
  }, [detailsPaymentHintOpen]);

  useEffect(() => () => {
    const tapState = detailsRevealTapStateRef.current;
    if (tapState.timeoutId != null && typeof window !== "undefined") {
      window.clearTimeout(tapState.timeoutId);
    }
  }, []);
  useEffect(() => () => {
    const tapState = splitPaymentUnlockTapStateRef.current;
    if (tapState.timeoutId != null && typeof window !== "undefined") {
      window.clearTimeout(tapState.timeoutId);
    }
  }, []);
  useEffect(() => () => {
    splitSubscriptionRequestRef.current += 1;
  }, []);

  const resolveCurrentClientProfile = useCallback(async () => {
    if (profileId && profilePhone) {
      return {
        clientId: profileId,
        clientPhone: profilePhone,
      };
    }

    const profileResult = await apiFetchProfile();
    const nextClientId = profileResult.data?.id ?? profileId ?? null;
    const nextClientPhone = profileResult.data?.phone ?? profilePhone ?? null;
    if (nextClientId) setProfileId(nextClientId);
    if (nextClientPhone) setProfilePhone(nextClientPhone);

    return {
      clientId: nextClientId,
      clientPhone: nextClientPhone,
    };
  }, [profileId, profilePhone]);

  const fetchCommunityAutopublishTargets = useCallback(async (): Promise<CommunityAutopublishTargetsBundle> => {
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH) {
      return {
        stationTarget: null,
        memberTargets: [],
        defaultSelectedIds: [],
      };
    }

    const { clientId, clientPhone } = await resolveCurrentClientProfile();
    const normalizedPhone = normalizePhoneForGame(clientPhone);
    const response = await apiFetchCommunities({
      clientId,
      phone: normalizedPhone,
      forceFresh: true,
    });
    const communities = response.data?.communities ?? [];
    const stationCommunity = findStationCommunityForAutopublish(communities, communityAutopublishStationName);

    const stationTarget = stationCommunity
      ? {
          id: stationCommunity.id,
          name: stationCommunity.name,
          logo: stationCommunity.logo ?? null,
          isOrganizerMember: isCommunityMemberForAutopublish(stationCommunity, clientId, normalizedPhone),
          isStationCommunity: true,
        }
      : null;

    const memberTargets = communities
      .filter((community) => isCommunityMemberForAutopublish(community, clientId, normalizedPhone))
      .filter((community) => community.id !== stationTarget?.id)
      .map((community) => ({
        id: community.id,
        name: community.name,
        logo: community.logo ?? null,
        isOrganizerMember: true,
        isStationCommunity: false,
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));

    return {
      stationTarget,
      memberTargets,
      defaultSelectedIds: [],
    };
  }, [communityAutopublishStationName, resolveCurrentClientProfile]);

  const resolveCurrentCommunityActor = useCallback(async () => {
    const profileResult = await apiFetchProfile();
    const profileData = profileResult.data;

    if (profileData) {
      const fullName = [profileData.firstName, profileData.lastName].filter(Boolean).join(" ").trim() || "Игрок";
      const explicitGrade = getCustomFieldValue(profileData, CUSTOM_FIELD_IDS.lkPadelLevel);
      const numericValue = parseNumericLevel(
        getCustomFieldValue(profileData, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
      );
      const levelScore = getCommunityActorLevelScore(numericValue, explicitGrade);

      setProfileId(profileData.id ?? null);
      setProfilePhone(profileData.phone ?? null);
      setProfileName(fullName || "Организатор");
      setProfilePhoto(profileData.photo ?? null);
      setProfileGrade(explicitGrade ?? getLetterGrade(levelScore));
      setProfileRatingNumeric(numericValue);

      return {
        id: profileData.id ?? null,
        phone: profileData.phone ?? null,
        name: fullName,
        avatar: profileData.photo ?? null,
        role: "MEMBER" as const,
        levelScore,
        levelLabel: explicitGrade ?? getLetterGrade(levelScore),
      };
    }

    const { clientId, clientPhone } = await resolveCurrentClientProfile();
    const fallbackLevelScore = getCommunityActorLevelScore(profileRatingNumeric, profileGrade);
    return {
      id: clientId ?? null,
      phone: clientPhone ?? null,
      name: profileName || "Игрок",
      avatar: profilePhoto ?? null,
      role: "MEMBER" as const,
      levelScore: fallbackLevelScore,
      levelLabel: profileGrade || getLetterGrade(fallbackLevelScore),
    };
  }, [
    profileGrade,
    profileName,
    profilePhone,
    profilePhoto,
    profileRatingNumeric,
    resolveCurrentClientProfile,
  ]);

  const ensureOrganizerJoinedToStationCommunity = useCallback(async (
    game: PadelGameRecord | null | undefined,
  ) => {
    if (!game?.id || !isGamePaidForCommunityAutopublish(game)) return null;

    const stationName = game.booking?.studioName?.trim() || null;
    if (!stationName) return null;

    const { clientId, clientPhone } = await resolveCurrentClientProfile();
    const normalizedPhone = normalizePhoneForGame(clientPhone);
    if (!clientId && !normalizedPhone) return null;

    const response = await apiFetchCommunities({
      clientId,
      phone: normalizedPhone,
      forceFresh: true,
    });
    const communities = response.data?.communities ?? [];
    const stationCommunity = findStationCommunityForAutopublish(communities, stationName);
    if (!stationCommunity?.id) return null;

    if (isCommunityMemberForAutopublish(stationCommunity, clientId, normalizedPhone)) {
      return stationCommunity.id;
    }

    const actor = await resolveCurrentCommunityActor();
    let joinResponse = await apiAddCommunityMember(stationCommunity.id, {
      member: actor,
    });

    if (
      !joinResponse.data?.community
      && (stationCommunity.inviteCode || stationCommunity.inviteLink)
    ) {
      joinResponse = await apiJoinCommunityByInvite({
        inviteCode: stationCommunity.inviteCode ?? null,
        inviteLink: stationCommunity.inviteLink ?? null,
        member: actor,
      });
    }

    if (joinResponse.data?.community) {
      setCommunityAutopublishStationTarget((current) => {
        if (current?.id !== stationCommunity.id) return current;
        return {
          ...current,
          isOrganizerMember: true,
        };
      });
      return stationCommunity.id;
    }

    return null;
  }, [resolveCurrentClientProfile, resolveCurrentCommunityActor]);

  const toggleCommunityAutopublishSelection = useCallback((communityId: string) => {
    const normalizedCommunityId = communityId.trim();
    if (!normalizedCommunityId) return;

    communityAutopublishSelectionTouchedRef.current = true;
    setSelectedCommunityAutopublishIds((current) => {
      const next = current.includes(normalizedCommunityId)
        ? current.filter((item) => item !== normalizedCommunityId)
        : [...current, normalizedCommunityId];
      selectedCommunityAutopublishIdsRef.current = next;
      return next;
    });
  }, []);
  const getCurrentCommunityAutopublishSelectionState = useCallback(
    () => buildCommunityAutopublishSelectionState({
      stationTarget: communityAutopublishStationTarget,
      memberTargets: communityAutopublishMemberTargets,
      selectedCommunityIds: selectedCommunityAutopublishIdsRef.current,
      selectionTouched: communityAutopublishSelectionTouchedRef.current,
    }),
    [communityAutopublishMemberTargets, communityAutopublishStationTarget],
  );

  const publishGameToMemberCommunitiesDev = useCallback(async (
    game: PadelGameRecord | null | undefined,
    source:
      | "direct_create"
      | "booking_create"
      | "payment_callback"
      | "existing_open"
      | "payment_status_sync" = "direct_create",
  ) => {
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH || !game?.id) return;
    if (String(game.status || "").trim().toUpperCase().includes("CANCEL")) return;
    if (!isGamePaidForCommunityAutopublish(game)) return;

    let targetsBundle: CommunityAutopublishTargetsBundle = {
      stationTarget: null,
      memberTargets: [],
      defaultSelectedIds: [],
    };
    try {
      targetsBundle = await fetchCommunityAutopublishTargets();
    } catch {
      // fall back to persisted selection below
    }
    const selectableTargets = [
      ...(targetsBundle.stationTarget?.isOrganizerMember ? [targetsBundle.stationTarget] : []),
      ...targetsBundle.memberTargets.filter((target) => target.isOrganizerMember),
    ];
    const selectableTargetMap = new Map(selectableTargets.map((target) => [target.id, target]));
    const baseMetadata = isRecordObject(game.metadata) ? { ...game.metadata } : {};
    const savedSelectionState = extractCommunityAutopublishSelectionState(baseMetadata);
    const savedCommunities = extractCommunityAutopublishSavedCommunities(baseMetadata);
    const savedCommunityMap = new Map(
      savedCommunities.map((entry) => [entry.communityId, entry] as const),
    );
    const liveSelectionState = getCurrentCommunityAutopublishSelectionState();
    const fallbackSelectedIds = liveSelectionState.selectionTouched
      || liveSelectionState.selectedCommunityIds.length > 0
      ? liveSelectionState.selectedCommunityIds
      : targetsBundle.defaultSelectedIds;
    const selectedTargetIds = Array.from(new Set((
      savedSelectionState.selectionTouched || savedSelectionState.selectedCommunityIds.length > 0
        ? savedSelectionState.selectedCommunityIds
        : fallbackSelectedIds
    )
      .map((communityId) => communityId.trim())
      .filter(Boolean)));
    const targets = selectedTargetIds
      .map((communityId) => (
        selectableTargetMap.get(communityId)
        ?? (() => {
          const savedCommunity = savedCommunityMap.get(communityId);
          if (!savedCommunity) return null;
          return {
            id: savedCommunity.communityId,
            name: savedCommunity.communityName,
            logo: null,
            isOrganizerMember: true,
            isStationCommunity: savedCommunity.communityId === savedSelectionState.stationCommunityId,
          } satisfies CommunityAutopublishTarget;
        })()
        ?? {
          id: communityId,
          name: communityId,
          logo: null,
          isOrganizerMember: true,
          isStationCommunity: communityId === savedSelectionState.stationCommunityId,
        }
      ));
    if (targets.length === 0) return;

    const existingPostsByCommunityId = extractCommunityAutopublishPostsMap(baseMetadata);
    const actor = await resolveCurrentCommunityActor();
    const nowIso = new Date().toISOString();
    const effectiveSelectionTouched = savedSelectionState.selectionTouched
      || liveSelectionState.selectionTouched;

    const nextEntries: Array<{
      communityId: string;
      communityName: string;
      postId: string | null;
      status: "PUBLISHED" | "FAILED";
      error: string | null;
    }> = [];
    let hasNewPublication = false;

    for (const target of targets) {
      const existingPostId = existingPostsByCommunityId[target.id] ?? null;
      if (existingPostId) {
        nextEntries.push({
          communityId: target.id,
          communityName: target.name,
          postId: existingPostId,
          status: "PUBLISHED",
          error: null,
        });
        continue;
      }

      const response = await apiCreateCommunityFeedPost(target.id, {
        member: actor,
        kind: "GAME",
        title: extractGameCustomTitle(baseMetadata) ?? "Приглашение в игру",
        body: buildCommunityGamePostBody(game),
        imageUrl: null,
        previewLabel: buildCommunityGamePreviewLabel(game),
        ctaLabel: "Открыть игру",
        relatedGameId: game.id,
        relatedTournamentId: null,
      });

      if (response.data?.id) {
        hasNewPublication = true;
        nextEntries.push({
          communityId: target.id,
          communityName: target.name,
          postId: response.data.id,
          status: "PUBLISHED",
          error: null,
        });
      } else {
        nextEntries.push({
          communityId: target.id,
          communityName: target.name,
          postId: null,
          status: "FAILED",
          error: response.error?.message ?? "Не удалось опубликовать игру в ленте сообщества",
        });
      }
    }

    const nextMetadata = {
      ...baseMetadata,
      ...buildCommunityAutopublishMetadataFields({
        enabled: true,
        source,
        mode: "selected_communities",
        lastAttemptAt: nowIso,
        selectionTouched: effectiveSelectionTouched,
        stationCommunityId: savedSelectionState.stationCommunityId
          ?? targetsBundle.stationTarget?.id
          ?? liveSelectionState.stationCommunityId
          ?? null,
        selectedCommunityIds: selectedTargetIds,
        posts: nextEntries.reduce<Record<string, string>>((acc, entry) => {
          if (entry.postId) {
            acc[entry.communityId] = entry.postId;
          }
          return acc;
        }, { ...existingPostsByCommunityId }),
        communities: nextEntries,
      }),
    };

    upsertGameRecordInStores({ ...game, metadata: nextMetadata }, { communityMode: "if_exists" });

    if (!hasNewPublication && Object.keys(existingPostsByCommunityId).length > 0) {
      return;
    }

    const updateResult = await apiUpdatePadelGameRecord(game.id, {
      metadata: nextMetadata,
    });

    const updatedRecord = updateResult.data;
    if (updatedRecord?.id) {
      upsertGameRecordInStores(updatedRecord, { communityMode: "if_exists" });
    }
  }, [
    fetchCommunityAutopublishTargets,
    getCurrentCommunityAutopublishSelectionState,
    resolveCurrentCommunityActor,
    upsertGameRecordInStores,
  ]);

  const syncPaidGameCommunityMembershipAndPublication = useCallback(async (
    game: PadelGameRecord | null | undefined,
    source:
      | "direct_create"
      | "booking_create"
      | "payment_callback"
      | "existing_open"
      | "payment_status_sync",
  ) => {
    if (!game) return;
    await ensureOrganizerJoinedToStationCommunity(game);
    await publishGameToMemberCommunitiesDev(game, source);
  }, [ensureOrganizerJoinedToStationCommunity, publishGameToMemberCommunitiesDev]);
  const runPaidGameCommunityMembershipAndPublication = useCallback((
    game: PadelGameRecord | null | undefined,
    source:
      | "direct_create"
      | "booking_create"
      | "payment_callback"
      | "existing_open"
      | "payment_status_sync",
  ) => {
    const normalizedGameId = game?.id?.trim() || "";
    if (!normalizedGameId) {
      return Promise.resolve();
    }

    const inFlight = communityAutopublishSyncInFlightRef.current.get(normalizedGameId);
    if (inFlight) {
      return inFlight;
    }

    const task = syncPaidGameCommunityMembershipAndPublication(game, source);
    communityAutopublishSyncInFlightRef.current.set(normalizedGameId, task);
    void task.finally(() => {
      if (communityAutopublishSyncInFlightRef.current.get(normalizedGameId) === task) {
        communityAutopublishSyncInFlightRef.current.delete(normalizedGameId);
      }
    });
    return task;
  }, [syncPaidGameCommunityMembershipAndPublication]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !activeGameRecord?.id) {
      communityAutopublishRepairAttemptRef.current = null;
      return;
    }
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH) return;
    if (String(activeGameRecord.status || "").trim().toUpperCase().includes("CANCEL")) return;
    if (!isGamePaidForCommunityAutopublish(activeGameRecord)) return;
    if (detailsPendingCommunityAutopublishIds.length === 0) return;

    const attemptKey = `${activeGameRecord.id}:${detailsPendingCommunityAutopublishIds.join(",")}`;
    if (communityAutopublishRepairAttemptRef.current === attemptKey) return;
    communityAutopublishRepairAttemptRef.current = attemptKey;
    setGameDetailsMetaError(null);

    void runPaidGameCommunityMembershipAndPublication(activeGameRecord, "existing_open")
      .catch(() => {
        setGameDetailsMetaError("Не удалось автоматически опубликовать игру в выбранные сообщества");
      });
  }, [
    step,
    activeGameRecord,
    detailsPendingCommunityAutopublishIds,
    runPaidGameCommunityMembershipAndPublication,
  ]);

  useEffect(() => {
    communityAutopublishSelectionTouchedRef.current = false;
    selectedCommunityAutopublishIdsRef.current = [];
    setSelectedCommunityAutopublishIds([]);
  }, [communityAutopublishStationName]);

  useEffect(() => {
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH) return;

    let alive = true;
    setCommunityAutopublishLoading(true);
    setCommunityAutopublishError(null);

    fetchCommunityAutopublishTargets()
      .then((targetsBundle) => {
        if (!alive) return;
        setCommunityAutopublishStationTarget(targetsBundle.stationTarget);
        setCommunityAutopublishMemberTargets(targetsBundle.memberTargets);
        const availableIds = new Set<string>([
          ...(targetsBundle.stationTarget?.isOrganizerMember ? [targetsBundle.stationTarget.id] : []),
          ...targetsBundle.memberTargets
            .filter((target) => target.isOrganizerMember)
            .map((target) => target.id),
        ]);
        setSelectedCommunityAutopublishIds((current) => {
          const preserved = current.filter((communityId) => availableIds.has(communityId));
          if (communityAutopublishSelectionTouchedRef.current) {
            selectedCommunityAutopublishIdsRef.current = preserved;
            return preserved;
          }
          const defaults = targetsBundle.defaultSelectedIds.filter((communityId) => availableIds.has(communityId));
          const next = preserved.length > 0 ? preserved : defaults;
          selectedCommunityAutopublishIdsRef.current = next;
          return next;
        });
      })
      .catch(() => {
        if (!alive) return;
        setCommunityAutopublishStationTarget(null);
        setCommunityAutopublishMemberTargets([]);
        selectedCommunityAutopublishIdsRef.current = [];
        setSelectedCommunityAutopublishIds([]);
        setCommunityAutopublishError("Не удалось получить список сообществ для автопубликации.");
      })
      .finally(() => {
        if (alive) setCommunityAutopublishLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [fetchCommunityAutopublishTargets]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !gameRecordId) return;

    let alive = true;
    const run = async () => {
      setCheckingGameStatus(true);
      try {
        const result = await apiFetchPadelGameRecord(gameRecordId);
        if (!alive) return;

        const fetchedRecord = result.data ?? null;
        if (fetchedRecord) {
          if (fetchedRecord.status) {
            setGameRecordStatus(fetchedRecord.status);
          }
          setInviteLink(resolveGameInviteUrl(fetchedRecord));
          if (fetchedRecord.payment?.amount != null) {
            setSlotPrice(fetchedRecord.payment.amount);
          }
          if (fetchedRecord.payment?.paymentUrl) {
            setGamePaymentUrl(fetchedRecord.payment.paymentUrl);
          }
          if (fetchedRecord.payment?.paid !== undefined && fetchedRecord.payment?.paid !== null) {
            setGamePaid(fetchedRecord.payment.paid);
          }
          const snapshotFromRecord = buildMatchSnapshotFromRecord(fetchedRecord);
          setGameSnapshot((prev) => mergeMatchSnapshots(prev, snapshotFromRecord));
          upsertGameRecordInStores(fetchedRecord, { communityMode: "if_exists" });
          if (!result.error) {
            setGameRecordError(null);
          }

          const vivaStatus = await resolveGamePaymentByVivaBookings(
            fetchedRecord,
            fetchedRecord.payment?.paymentUrl ?? null,
            snapshotFromRecord,
          );
          if (!alive) return;
          if (vivaStatus.cancelled) {
            setGamePaid(false);
            setInviteLink(null);
            setGamePaymentUrl(vivaStatus.paymentUrl ?? fetchedRecord.payment?.paymentUrl ?? null);
            const nextRecord: PadelGameRecord = {
              ...fetchedRecord,
              status: "CANCELLED",
              payment: {
                amount: fetchedRecord.payment?.amount ?? null,
                paymentUrl: vivaStatus.paymentUrl ?? fetchedRecord.payment?.paymentUrl ?? null,
                paid: false,
              },
            };
            upsertGameRecordInStores(nextRecord, { communityMode: "if_exists" });
            setGameRecordStatus("CANCELLED");

            const fetchedStatusUpper = String(fetchedRecord.status || "").trim().toUpperCase();
            if (!fetchedStatusUpper.includes("CANCEL")) {
              void apiUpdatePadelGameRecord(fetchedRecord.id, {
                status: "CANCELLED",
                payment: {
                  amount: fetchedRecord.payment?.amount ?? null,
                  paymentUrl: vivaStatus.paymentUrl ?? fetchedRecord.payment?.paymentUrl ?? null,
                  paymentMethod: "WIDGET",
                  paid: false,
                },
              });
            }
            return;
          }
          if (vivaStatus.paymentUrl && !fetchedRecord.payment?.paymentUrl) {
            setGamePaymentUrl(vivaStatus.paymentUrl);
          }
          const resolvedPaymentUrl = vivaStatus.paymentUrl ?? fetchedRecord.payment?.paymentUrl ?? null;
          const paidByStatus = detectPaidStateByStatusToken(fetchedRecord.status) === true;
          const effectivePaid = vivaStatus.paid === true || fetchedRecord.payment?.paid === true || paidByStatus;
          if (vivaStatus.paid !== null || effectivePaid) {
            setGamePaid(vivaStatus.paid ?? effectivePaid);
            const nextRecord: PadelGameRecord = {
              ...fetchedRecord,
              status: effectivePaid
                ? "PAID"
                : (fetchedRecord.status ?? "PAYMENT_PENDING"),
              payment: {
                amount: fetchedRecord.payment?.amount ?? null,
                paymentUrl: resolvedPaymentUrl,
                paid: effectivePaid
                  ? true
                  : vivaStatus.paid,
              },
            };
            upsertGameRecordInStores(nextRecord, { communityMode: "if_exists" });
            if (effectivePaid) {
              setGameRecordStatus((prev) => {
                const statusUpper = String(prev || "").trim().toUpperCase();
                if (statusUpper.includes("PAID") || statusUpper.includes("PAYED")) {
                  return prev;
                }
                return "PAID";
              });

              const shouldPatchRecord = (
                fetchedRecord.payment?.paid !== true
                || !paidByStatus
                || (resolvedPaymentUrl && fetchedRecord.payment?.paymentUrl !== resolvedPaymentUrl)
              );
              let recordForPublish = nextRecord;
              if (shouldPatchRecord) {
                const patchResult = await apiUpdatePadelGameRecord(fetchedRecord.id, {
                  status: "PAID",
                  payment: {
                    amount: fetchedRecord.payment?.amount ?? null,
                    paymentUrl: resolvedPaymentUrl,
                    paymentMethod: "WIDGET",
                    paid: true,
                    paidAt: new Date().toISOString(),
                  },
                });
                if (!alive) return;
                if (patchResult.data?.id) {
                  recordForPublish = mergePadelGameRecord(nextRecord, patchResult.data as PadelGameRecord);
                  upsertGameRecordInStores(recordForPublish, { communityMode: "if_exists" });
                }
              }
              void runPaidGameCommunityMembershipAndPublication(recordForPublish, "payment_status_sync");
            }
          }
          return;
        }

        if (result.error) {
          setGameRecordError(result.error.message || "Не удалось получить статус оплаты игры");
        }
      } catch {
        if (!alive) return;
        setGameRecordError("Не удалось получить статус оплаты игры");
      } finally {
        if (alive) setCheckingGameStatus(false);
      }
    };

    void run();

    return () => {
      alive = false;
    };
  }, [
    step,
    gameRecordId,
    resolveGamePaymentByVivaBookings,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  const communityAutopublishSelectedIdsSet = useMemo(
    () => new Set(selectedCommunityAutopublishIds),
    [selectedCommunityAutopublishIds],
  );
  const renderCommunityAutopublishAvatar = (community: { name: string; logo: string | null }) => {
    const palette = getCommunityAutopublishPalette(community.name);
    return (
      <AvatarWithInitialsFallback
        src={community.logo}
        alt={community.name}
        imageClassName="game-autopublish-card-avatar-image"
        fallbackClassName="game-autopublish-card-avatar-fallback"
        fallbackText={getCommunityAutopublishInitials(community.name)}
        fallbackStyle={{
          "--community-gradient-start": palette.start,
          "--community-gradient-end": palette.end,
        } as CSSProperties}
      />
    );
  };
  const buildCommunityAutopublishMetadata = useCallback(() => {
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH) return null;
    const selectionState = getCurrentCommunityAutopublishSelectionState();
    const targetById = new Map<string, CommunityAutopublishTarget>([
      ...(communityAutopublishStationTarget ? [[communityAutopublishStationTarget.id, communityAutopublishStationTarget] as const] : []),
      ...communityAutopublishMemberTargets.map((target) => [target.id, target] as const),
    ]);

    return {
      enabled: true,
      mode: "selected_communities",
      selectionTouched: selectionState.selectionTouched,
      stationCommunityId: selectionState.stationCommunityId,
      selectedCommunityIds: selectionState.selectedCommunityIds,
      posts: {},
      communities: selectionState.selectedCommunityIds.map((communityId) => {
        const target = targetById.get(communityId);
        return {
          communityId,
          communityName: target?.name ?? communityId,
          postId: null,
          status: "PENDING",
          error: null,
        };
      }),
    };
  }, [
    communityAutopublishMemberTargets,
    communityAutopublishStationTarget,
    getCurrentCommunityAutopublishSelectionState,
  ]);
  const validateGamePublicationFields = useCallback(() => {
    if (!showPublicationFields) return true;
    if (!normalizedGameTitle) {
      const errorMessage = "Укажите название игры.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }
    if (!normalizedGameParticipantComment) {
      const errorMessage = "Добавьте комментарий для участников.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }
    if (splitPaymentSelected && !normalizedGameJoinPrice) {
      const errorMessage = "Не удалось рассчитать стоимость присоединения для раздельной оплаты.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }
    if (!splitPaymentSelected && !normalizedGameJoinPrice) {
      const errorMessage = "Укажите стоимость присоединения к игре перед публикацией в сообщества.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }

    return true;
  }, [
    showPublicationFields,
    normalizedGameTitle,
    normalizedGameParticipantComment,
    splitPaymentSelected,
    normalizedGameJoinPrice,
  ]);
  const communityAutopublishCards = useMemo(() => {
    const cards: Array<{
      key: string;
      communityId: string | null;
      name: string;
      logo: string | null;
      badge: string;
      subtitle: string;
      selected: boolean;
      selectable: boolean;
    }> = [];

    if (communityAutopublishStationTarget) {
      cards.push({
        key: `station:${communityAutopublishStationTarget.id}`,
        communityId: communityAutopublishStationTarget.id,
        name: communityAutopublishStationTarget.name,
        logo: communityAutopublishStationTarget.logo ?? null,
        badge: "Станция",
        subtitle: communityAutopublishLoading
          ? "Проверяем сообщество станции..."
          : communityAutopublishStationTarget.isOrganizerMember
            ? "Сообщество станции"
            : "Организатор не состоит в сообществе станции",
        selected: communityAutopublishSelectedIdsSet.has(communityAutopublishStationTarget.id),
        selectable: communityAutopublishStationTarget.isOrganizerMember && !communityAutopublishLoading,
      });
    } else {
      cards.push({
        key: `station-placeholder:${communityAutopublishStationName ?? "empty"}`,
        communityId: null,
        name: communityAutopublishStationName ?? "Станция",
        logo: null,
        badge: "Станция",
        subtitle: communityAutopublishLoading
          ? "Проверяем сообщество станции..."
          : communityAutopublishStationName
            ? "Сообщество станции не найдено"
            : "Сначала выберите станцию",
        selected: false,
        selectable: false,
      });
    }

    communityAutopublishMemberTargets.forEach((community) => {
      cards.push({
        key: `member:${community.id}`,
        communityId: community.id,
        name: community.name,
        logo: community.logo ?? null,
        badge: "Сообщество",
        subtitle: "Сообщество организатора",
        selected: communityAutopublishSelectedIdsSet.has(community.id),
        selectable: !communityAutopublishLoading,
      });
    });

    return cards;
  }, [
    communityAutopublishLoading,
    communityAutopublishMemberTargets,
    communityAutopublishSelectedIdsSet,
    communityAutopublishStationName,
    communityAutopublishStationTarget,
  ]);

  const handleApplyPromoCode = useCallback(async () => {
    if (!studioId || !selectedDate || !courtId || !time || !selectedSlotId) {
      setPromoError("Сначала выберите дату, время и корт");
      return;
    }

    const normalizedPromoCode = promoCodeDraft.trim();
    if (!normalizedPromoCode) {
      setPromoError("Введите промокод");
      return;
    }

    setApplyingPromo(true);
    setPromoError(null);
    setPromoStatusMessage(null);

    const fromDate = formatDateLocalIso(selectedDate);
    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const baseAmount = slotPrice ?? selectedSlot?.price ?? selectedCourt?.price ?? null;

    try {
      const profile = await resolveCurrentClientProfile();
      if (!profile.clientId) {
        setPromoError("Не удалось определить профиль для проверки промокода");
        return;
      }

      const checkResult = await apiCheckMasterServicePromoCode({
        date: fromDate,
        fromTime,
        toTime,
        studioId,
        roomId: courtId,
        subServiceIds: resolvedSelectedSubServiceIds,
        masterServiceId: studioMasterServiceId,
        promoCode: normalizedPromoCode,
      });
      if (checkResult.error) {
        setPromoError(checkResult.error.message || "Промокод не прошел проверку");
        return;
      }

      const discountsResult = await apiFetchMasterServicePromoDiscounts({
        date: fromDate,
        fromTime,
        toTime,
        studioId,
        roomId: courtId,
        subServiceIds: resolvedSelectedSubServiceIds,
        masterServiceId: studioMasterServiceId,
        clientId: profile.clientId,
        promoCode: normalizedPromoCode,
      });
      if (discountsResult.error || !discountsResult.data) {
        setPromoError(discountsResult.error?.message || "Не удалось рассчитать скидку по промокоду");
        return;
      }

      const nextDiscount = Math.max(0, discountsResult.data.discount || 0);
      setPromoCodeApplied(normalizedPromoCode);
      setPromoDiscountAmount(nextDiscount);
      setPromoPricePreview(baseAmount != null ? Math.max(baseAmount - nextDiscount, 0) : null);
      setPromoStatusMessage(
        nextDiscount > 0
          ? `Промокод применен. Скидка ${formatPrice(nextDiscount)} ₽`
          : "Промокод применен, но для выбранного слота скидка не начислена",
      );
      setPromoModalOpen(false);
    } catch {
      setPromoError("Не удалось применить промокод");
    } finally {
      setApplyingPromo(false);
    }
  }, [
    studioId,
    selectedDate,
    courtId,
    time,
    selectedSlotId,
    promoCodeDraft,
    duration,
    slotPrice,
    selectedSlot?.price,
    selectedCourt?.price,
    resolvedSelectedSubServiceIds,
    studioMasterServiceId,
    resolveCurrentClientProfile,
  ]);

  const handleSplitGamePay = useCallback(async (preferredPaymentMode?: "subscription" | "one_time") => {
    if (!studioId || !selectedDate || !courtId || !time || !selectedSlotId) return;
    if (!validateGamePublicationFields()) return;
    if (!splitPaymentAvailable) {
      setPaymentMode("self");
      setPayError("Раздельная оплата сейчас недоступна");
      return;
    }

    setLoadingPay(true);
    setPayError(null);
    setGameRecordError(null);

    const fromDate = formatDateLocalIso(selectedDate);
    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const subServiceIds = resolvedSelectedSubServiceIds;
    const paymentRef = generatePaymentRef();
    const baseRedirectUrl = buildBaseRedirectUrl(fromDate, {
      [PAYMENT_REF_QUERY_KEY]: paymentRef,
      splitPayment: "organizer",
    });

    const profile = await resolveCurrentClientProfile();
    const clientId = profile.clientId;
    const clientPhone = profile.clientPhone;

    const shareAmount = resolveSplitShareAmount(splitShareCount, activeSplitPaymentPromoConfig, duration);
    const baseShareAmount = resolveSplitBaseShareAmount(activeSplitPaymentPromoConfig, duration);
    const discountAmount = Math.max(baseShareAmount - shareAmount, 0);
    const resolvedPaymentMode = preferredPaymentMode ?? (splitHasEligibleSubscriptions ? "subscription" : "one_time");
    const resolvedTotalAmount = paymentAmount != null && Number.isFinite(paymentAmount)
      ? Math.max(0, Math.round(paymentAmount))
      : null;
    const paymentResult = await apiCreatePadelSplitGamePayment({
      date: fromDate,
      fromTime,
      toTime,
      activeTo: null,
      studioId,
      roomId: courtId,
      studioName,
      roomName: selectedCourtName ?? null,
      clientId,
      clientPhone,
      paymentRef,
      paymentMode: resolvedPaymentMode,
      baseRedirectUrl,
      successUrl: baseRedirectUrl,
      failUrl: baseRedirectUrl,
      shareCount: splitShareCount,
      shareAmount,
      totalAmount: resolvedTotalAmount,
      oneTimeBaseAmount: DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.baseShareAmount,
      shareAmountIncludesDuration: true,
      durationMinutes: duration,
      maxClientsCount: splitShareCount,
      spot: 1,
      vivaDirectionId: SPLIT_OPEN_GAME_DIRECTION_ID,
      vivaExerciseTypeId: SPLIT_OPEN_GAME_EXERCISE_TYPE_ID,
    });

    if (paymentResult.error || !paymentResult.data) {
      setPayError(paymentResult.error?.message ?? "Не удалось сформировать split-оплату");
      setLoadingPay(false);
      return;
    }

    const normalizedParticipants = participants.length > 0
      ? participants
      : [
          {
            id: clientId ?? null,
            name: profileName || "Организатор",
            phone: clientPhone ?? null,
            photo: profilePhoto ?? null,
            rating: profileGrade ?? null,
            ratingNumeric: profileRatingNumeric,
            source: "ORGANIZER" as const,
            status: "CONFIRMED" as const,
          },
        ];
    const organizerPlayer =
      normalizedParticipants.find((player) => player.source === "ORGANIZER") ??
      normalizedParticipants[0] ?? {
        id: clientId ?? null,
        name: profileName || "Организатор",
        phone: clientPhone ?? null,
        photo: profilePhoto ?? null,
        rating: profileGrade ?? null,
        ratingNumeric: profileRatingNumeric,
      };
    const resolvedBookingIds = paymentResult.data.bookingId ? [paymentResult.data.bookingId] : [];
    const resolvedPaymentAmount = paymentResult.data.toPay ?? shareAmount;
    const paidAt = new Date().toISOString();
    const organizerPaymentStatus = paymentResult.data.paymentUrl ? "PAYMENT_PENDING" : "PAID";
    const splitDeadlineAt =
      paymentResult.data.deadlineAt ??
      new Date(Date.now() + SPLIT_PAYMENT_DEADLINE_MINUTES * 60 * 1000).toISOString();
    const resolvedDirectionId = paymentResult.data.directionId ?? SPLIT_OPEN_GAME_DIRECTION_ID;
    const resolvedExerciseTypeId = paymentResult.data.exerciseTypeId ?? SPLIT_OPEN_GAME_EXERCISE_TYPE_ID;
    const resolvedSplitShareAmount = paymentResult.data.shareAmount ?? shareAmount;
    const resolvedSplitShareAmountMinor = paymentResult.data.shareAmountMinor ?? Math.round(resolvedSplitShareAmount * 100);
    const resolvedBaseShareAmount = paymentResult.data.baseShareAmount ?? baseShareAmount;
    const resolvedBaseShareAmountMinor = paymentResult.data.baseShareAmountMinor ?? Math.round(resolvedBaseShareAmount * 100);
    const resolvedDiscountAmount = paymentResult.data.discountAmount ?? discountAmount;
    const resolvedDiscountAmountMinor = paymentResult.data.discountAmountMinor ?? Math.round(resolvedDiscountAmount * 100);
    const resolvedSplitTotalAmount = paymentResult.data.totalAmount ?? resolvedTotalAmount;
    const resolvedOneTimeBaseAmount = paymentResult.data.oneTimeBaseAmount
      ?? DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.baseShareAmount;
    const splitMetadata = {
      enabled: true,
      mode: "group_booking",
      shareCount: splitShareCount,
      shareAmount: resolvedSplitShareAmount,
      shareAmountMinor: resolvedSplitShareAmountMinor,
      baseShareAmount: resolvedBaseShareAmount,
      baseShareAmountMinor: resolvedBaseShareAmountMinor,
      discountAmount: resolvedDiscountAmount,
      discountAmountMinor: resolvedDiscountAmountMinor,
      deadlineAt: splitDeadlineAt,
      assembleDeadlineAt: paymentResult.data.assembleDeadlineAt,
      status: "ACTIVE",
      vivaExerciseId: paymentResult.data.exerciseId,
      organizerBookingId: paymentResult.data.bookingId,
      productId: paymentResult.data.productId,
      directionId: resolvedDirectionId,
      exerciseTypeId: resolvedExerciseTypeId,
      totalAmount: resolvedSplitTotalAmount,
      oneTimeBaseAmount: resolvedOneTimeBaseAmount,
      selectedPaymentMode: paymentResult.data.selectedPaymentMode ?? resolvedPaymentMode,
      paymentModes: paymentResult.data.paymentModes,
      subscriptionProductId: paymentResult.data.subscriptionProductId,
      subscriptionProductName: paymentResult.data.subscriptionProductName,
      oneTimeProductId: paymentResult.data.oneTimeProductId,
      oneTimeProductName: paymentResult.data.oneTimeProductName,
      payments: [
        {
          role: "ORGANIZER",
          status: organizerPaymentStatus,
          paymentRef,
          clientId: clientId ?? organizerPlayer.id ?? null,
          phone: clientPhone ?? organizerPlayer.phone ?? null,
          phoneNorm: normalizePhoneForGame(clientPhone ?? organizerPlayer.phone ?? null),
          bookingId: paymentResult.data.bookingId,
          transactionId: paymentResult.data.transactionId,
          paymentUrl: paymentResult.data.paymentUrl,
          amount: resolvedPaymentAmount,
          amountMinor: paymentResult.data.toPayMinor,
          paidAt: organizerPaymentStatus === "PAID" ? paidAt : null,
          spot: paymentResult.data.spot ?? 1,
        },
      ],
    };

    const payload: PadelGameRecordPayload = {
      paymentRef,
      tenantKey: null,
      status: paymentResult.data.paymentUrl || resolvedPaymentAmount > 0 ? "PAYMENT_PENDING" : "PAID",
      organizer: {
        id: clientId ?? organizerPlayer.id ?? null,
        name: profileName || organizerPlayer.name || "Организатор",
        phone: clientPhone ?? organizerPlayer.phone ?? null,
        photo: profilePhoto ?? organizerPlayer.photo ?? null,
        rating: profileGrade ?? organizerPlayer.rating ?? null,
        ratingNumeric: profileRatingNumeric ?? organizerPlayer.ratingNumeric ?? null,
      },
      booking: {
        studioId,
        studioName,
        masterServiceId: studioMasterServiceId,
        subServiceIds,
        roomId: courtId,
        roomName: selectedCourtName ?? "Корт",
        date: fromDate,
        timeFrom: fromTime,
        timeTo: toTime,
        timeFromIso: `${fromDate}T${fromTime}:00+03:00`,
        timeToIso: `${fromDate}T${toTime}:00+03:00`,
        durationMinutes: duration,
        slotId: selectedSlotId,
        bookingIds: resolvedBookingIds,
      },
      payment: {
        amount: resolvedPaymentAmount,
        paymentUrl: paymentResult.data.paymentUrl,
        paymentMethod: "WIDGET",
        baseRedirectUrl,
        paid: !paymentResult.data.paymentUrl && resolvedPaymentAmount <= 0,
        ...(paymentResult.data.paymentUrl ? {} : { paidAt }),
        paymentRef,
        bookingIds: resolvedBookingIds,
      },
      settings: {
        ratingGame: effectiveRatingGame,
        minRating: effectiveRatingGame ? (RATING_LABELS[minRating] ?? null) : null,
        maxRating: effectiveRatingGame ? (RATING_LABELS[maxRating] ?? null) : null,
        isPrivate,
        payMode: "split",
      },
      invite: {
        inviteUrl: null,
        waitlistEnabled: true,
        maxPlayers: splitShareCount,
      },
      participants: normalizedParticipants.slice(0, splitShareCount),
      waitlist: waitlistPlayers,
      metadata: {
        paymentRef,
        bookingIds: resolvedBookingIds,
        source: "games_split_widget",
        gameFormat: resolvedGameFormat,
        ...buildGameOptionalMetadataFields({
          gameTitle: gameTitleDraft,
          participantComment: gameParticipantCommentDraft,
          joinPrice: gameJoinPriceDraft,
        }),
        splitPayment: splitMetadata,
        ...buildCommunityAutopublishMetadataFields(buildCommunityAutopublishMetadata()),
      },
    };

    if (!paymentResult.data.paymentUrl && resolvedPaymentAmount <= 0) {
      const directCreateResult = await apiCreatePadelGameRecord({
        ...payload,
        status: "PAID",
        payment: {
          ...payload.payment,
          paid: true,
          paidAt,
        },
      });

      if (!directCreateResult.data?.id) {
        setPayError(directCreateResult.error?.message || "Не удалось создать split-игру");
        setLoadingPay(false);
        return;
      }

      const createdRecord = directCreateResult.data;
      const fallbackInviteUrl = buildInviteFallbackUrl(createdRecord.id);
      upsertGameRecordInStores(createdRecord, { communityMode: "upsert" });
      notifyGameRecordsUpdated([createdRecord], "games_split_direct_create");
      void runPaidGameCommunityMembershipAndPublication(createdRecord, "direct_create");
      setGameRecordId(createdRecord.id);
      setGameRecordStatus(createdRecord.status ?? "PAID");
      setInviteLink(resolveGameInviteUrl(createdRecord) ?? fallbackInviteUrl);
      setGamePaymentUrl(null);
      setGamePaid(true);
      setGameSnapshot(
        mergeMatchSnapshots(
          buildMatchSnapshotFromPayload(payload),
          buildMatchSnapshotFromRecord(createdRecord),
        ),
      );
      setConfirmCancelUnpaidGame(false);
      setLoadingPay(false);
      setStep("details");
      return;
    }

    if (paymentResult.data.paymentUrl) {
      savePendingPaidGameDraft(paymentRef, payload, resolvedBookingIds);
      enqueuePendingPaymentSync(paymentRef, resolvedBookingIds, "split_pay_click");

      if (!navigateToExternalUrl(paymentResult.data.paymentUrl)) {
        setPayError("Не удалось открыть страницу оплаты");
        setLoadingPay(false);
      }
      return;
    }

    setPayError("Не удалось получить ссылку split-оплаты");
    setLoadingPay(false);
  }, [
    studioId,
    studioMasterServiceId,
    studioName,
    selectedDate,
    courtId,
    selectedCourtName,
    time,
    duration,
    profileName,
    profileGrade,
    profileRatingNumeric,
    profilePhoto,
    gameTitleDraft,
    gameParticipantCommentDraft,
    gameJoinPriceDraft,
    effectiveRatingGame,
    minRating,
    maxRating,
    isPrivate,
    participants,
    waitlistPlayers,
    selectedSlotId,
    resolvedSelectedSubServiceIds,
    splitPaymentAvailable,
    activeSplitPaymentPromoConfig,
    splitShareCount,
    splitHasEligibleSubscriptions,
    resolvedGameFormat,
    buildCommunityAutopublishMetadata,
    validateGamePublicationFields,
    resolveCurrentClientProfile,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  const handleMasterServicePay = useCallback(async () => {
    if (!studioId || !selectedDate || !courtId || !time || !selectedSlotId) return;
    if (!validateGamePublicationFields()) return;

    setLoadingPay(true);
    setPayError(null);
    setGameRecordError(null);

    const fromDate = formatDateLocalIso(selectedDate);
    const fromTime = time;
    const toTime = addMinutesToTime(fromTime, duration);
    const subServiceIds = resolvedSelectedSubServiceIds;
    const paymentRef = generatePaymentRef();
    const baseRedirectUrl = buildBaseRedirectUrl(fromDate, {
      [PAYMENT_REF_QUERY_KEY]: paymentRef,
    });

    const profile = await resolveCurrentClientProfile();
    const clientId = profile.clientId;
    const clientPhone = profile.clientPhone;

    const paymentResult = await apiPayMasterService({
      date: fromDate,
      fromTime,
      toTime,
      studioId,
      roomId: courtId,
      subServiceIds,
      masterServiceId: studioMasterServiceId,
      clientId,
      clientPhone,
      baseRedirectUrl,
      promoCode: promoCodeApplied,
    });

    if (paymentResult.data?.toPay && paymentResult.data.toPay > 0) {
      setSlotPrice(paymentResult.data.toPay);
    }

    const normalizedParticipants = participants.length > 0
      ? participants
      : [
          {
            id: clientId ?? null,
            name: profileName || "Организатор",
            phone: clientPhone ?? null,
            photo: profilePhoto ?? null,
            rating: profileGrade ?? null,
            ratingNumeric: profileRatingNumeric,
            source: "ORGANIZER" as const,
            status: "CONFIRMED" as const,
          },
        ];
    const organizerPlayer =
      normalizedParticipants.find((player) => player.source === "ORGANIZER") ??
      normalizedParticipants[0] ?? {
        id: clientId ?? null,
        name: profileName || "Организатор",
        phone: clientPhone ?? null,
        photo: profilePhoto ?? null,
        rating: profileGrade ?? null,
        ratingNumeric: profileRatingNumeric,
      };
    const bookingIdsFromPaymentResult = parseBookingIdsFromUnknown(paymentResult.data?.bookingIds);
    let bookingIdsFromPaymentUrl: string[] = [];
    try {
      if (paymentResult.data?.paymentUrl) {
        const paymentUrl = new URL(paymentResult.data.paymentUrl);
        bookingIdsFromPaymentUrl = extractBookingIdsFromUrl(paymentUrl);
      }
    } catch {
      bookingIdsFromPaymentUrl = [];
    }
    const resolvedBookingIds = Array.from(new Set([
      ...bookingIdsFromPaymentResult,
      ...bookingIdsFromPaymentUrl,
    ]));
    const resolvedPaymentAmount = paymentResult.data?.toPay ?? paymentAmount ?? 0;

    if (paymentResult.data && !paymentResult.data.paymentUrl && resolvedPaymentAmount <= 0) {
      const paidAt = new Date().toISOString();
      const directPayload: PadelGameRecordPayload = {
        paymentRef,
        tenantKey: null,
        status: "PAID",
        organizer: {
          id: clientId ?? organizerPlayer.id ?? null,
          name: profileName || organizerPlayer.name || "Организатор",
          phone: clientPhone ?? organizerPlayer.phone ?? null,
          photo: profilePhoto ?? organizerPlayer.photo ?? null,
          rating: profileGrade ?? organizerPlayer.rating ?? null,
          ratingNumeric: profileRatingNumeric ?? organizerPlayer.ratingNumeric ?? null,
        },
        booking: {
          studioId,
          studioName,
          masterServiceId: studioMasterServiceId,
          subServiceIds,
          roomId: courtId,
          roomName: selectedCourtName ?? "Корт",
          date: fromDate,
          timeFrom: fromTime,
          timeTo: toTime,
          timeFromIso: `${fromDate}T${fromTime}:00+03:00`,
          timeToIso: `${fromDate}T${toTime}:00+03:00`,
          durationMinutes: duration,
          slotId: selectedSlotId,
          bookingIds: resolvedBookingIds,
        },
        payment: {
          amount: resolvedPaymentAmount,
          paymentUrl: null,
          paymentMethod: "WIDGET",
          baseRedirectUrl,
          paid: true,
          paidAt,
          paymentRef,
          bookingIds: resolvedBookingIds,
        },
        settings: {
          ratingGame: effectiveRatingGame,
          minRating: effectiveRatingGame ? (RATING_LABELS[minRating] ?? null) : null,
          maxRating: effectiveRatingGame ? (RATING_LABELS[maxRating] ?? null) : null,
          isPrivate,
          payMode: "self",
        },
        invite: {
          inviteUrl: null,
          waitlistEnabled,
          maxPlayers: createMaxPlayers,
        },
        participants: normalizedParticipants.slice(0, createMaxPlayers),
        waitlist: waitlistPlayers,
        metadata: {
          paymentRef,
          bookingIds: resolvedBookingIds,
          source: "games_widget_zero_pay",
          promoCode: promoCodeApplied,
          promoDiscount: promoDiscountAmount,
          gameFormat: resolvedGameFormat,
          ...buildGameOptionalMetadataFields({
            gameTitle: gameTitleDraft,
            participantComment: gameParticipantCommentDraft,
            joinPrice: gameJoinPriceDraft,
          }),
          ...buildCommunityAutopublishMetadataFields(buildCommunityAutopublishMetadata()),
        },
      };

      trackGameRecordCreateEvent("requested", {
        stage: "direct_paid",
        paymentRef,
        status: "PAID",
        url: "/lk/games",
      });

      const directCreateResult = await apiCreatePadelGameRecord(directPayload);
      if (!directCreateResult.data?.id) {
        trackGameRecordCreateEvent("failed", {
          stage: "direct_paid",
          paymentRef,
          status: directCreateResult.status ?? null,
          url: "/lk/games",
          message: directCreateResult.error?.message || "unknown",
        });
        setPayError(directCreateResult.error?.message || "Не удалось создать игру по бесплатной брони");
        setLoadingPay(false);
        return;
      }

      trackGameRecordCreateEvent("success", {
        stage: "direct_paid",
        paymentRef,
        gameId: directCreateResult.data.id,
        status: directCreateResult.status ?? null,
        url: "/lk/games",
      });

      const createdRecord = directCreateResult.data;
      const fallbackInviteUrl = buildInviteFallbackUrl(createdRecord.id);
      upsertGameRecordInStores(createdRecord, { communityMode: "upsert" });
      notifyGameRecordsUpdated([createdRecord], "games_direct_create");
      void runPaidGameCommunityMembershipAndPublication(createdRecord, "direct_create");
      setGameRecordId(createdRecord.id);
      setGameRecordStatus(createdRecord.status ?? "PAID");
      setInviteLink(resolveGameInviteUrl(createdRecord) ?? fallbackInviteUrl);
      setGamePaymentUrl(createdRecord.payment?.paymentUrl ?? null);
      setGamePaid(createdRecord.payment?.paid ?? true);
      setGameSnapshot(
        mergeMatchSnapshots(
          buildMatchSnapshotFromPayload(directPayload),
          buildMatchSnapshotFromRecord(createdRecord),
        ),
      );
      setConfirmCancelUnpaidGame(false);
      setLoadingPay(false);
      setStep("details");
      return;
    }

    if (paymentResult.data?.paymentUrl) {
      const draftPayload: PadelGameRecordPayload = {
        paymentRef,
        tenantKey: null,
        status: "PAYMENT_PENDING",
        organizer: {
          id: clientId ?? organizerPlayer.id ?? null,
          name: profileName || organizerPlayer.name || "Организатор",
          phone: clientPhone ?? organizerPlayer.phone ?? null,
          photo: profilePhoto ?? organizerPlayer.photo ?? null,
          rating: profileGrade ?? organizerPlayer.rating ?? null,
          ratingNumeric: profileRatingNumeric ?? organizerPlayer.ratingNumeric ?? null,
        },
        booking: {
          studioId,
          studioName,
          masterServiceId: studioMasterServiceId,
          subServiceIds,
          roomId: courtId,
          roomName: selectedCourtName ?? "Корт",
          date: fromDate,
          timeFrom: fromTime,
          timeTo: toTime,
          timeFromIso: `${fromDate}T${fromTime}:00+03:00`,
          timeToIso: `${fromDate}T${toTime}:00+03:00`,
          durationMinutes: duration,
          slotId: selectedSlotId,
          bookingIds: resolvedBookingIds,
        },
        payment: {
          amount: resolvedPaymentAmount,
          paymentUrl: paymentResult.data.paymentUrl,
          paymentMethod: "WIDGET",
          baseRedirectUrl,
          paid: false,
          paymentRef,
          bookingIds: resolvedBookingIds,
        },
        settings: {
          ratingGame: effectiveRatingGame,
          minRating: effectiveRatingGame ? (RATING_LABELS[minRating] ?? null) : null,
          maxRating: effectiveRatingGame ? (RATING_LABELS[maxRating] ?? null) : null,
          isPrivate,
          payMode: "self",
        },
        invite: {
          inviteUrl: null,
          waitlistEnabled,
          maxPlayers: createMaxPlayers,
        },
        participants: normalizedParticipants.slice(0, createMaxPlayers),
        waitlist: waitlistPlayers,
        metadata: {
          paymentRef,
          bookingIds: resolvedBookingIds,
          source: "games_widget",
          promoCode: promoCodeApplied,
          promoDiscount: promoDiscountAmount,
          gameFormat: resolvedGameFormat,
          ...buildGameOptionalMetadataFields({
            gameTitle: gameTitleDraft,
            participantComment: gameParticipantCommentDraft,
            joinPrice: gameJoinPriceDraft,
          }),
          ...buildCommunityAutopublishMetadataFields(buildCommunityAutopublishMetadata()),
        },
      };

      savePendingPaidGameDraft(paymentRef, draftPayload, resolvedBookingIds);
      enqueuePendingPaymentSync(paymentRef, resolvedBookingIds, "pay_click");

      if (!navigateToExternalUrl(paymentResult.data.paymentUrl)) {
        setPayError("Не удалось открыть страницу оплаты");
        setLoadingPay(false);
      }
      return;
    }

    setPayError(paymentResult.error?.message ?? "Не удалось сформировать ссылку на оплату");
    setLoadingPay(false);
  }, [
    studioId,
    studioMasterServiceId,
    studioName,
    selectedDate,
    courtId,
    selectedCourtName,
    time,
    duration,
    profileName,
    profileGrade,
    profileRatingNumeric,
    profilePhoto,
    paymentAmount,
    gameTitleDraft,
    gameParticipantCommentDraft,
    gameJoinPriceDraft,
    effectiveRatingGame,
    minRating,
    maxRating,
    isPrivate,
    participants,
    waitlistEnabled,
    waitlistPlayers,
    selectedSlotId,
    resolvedSelectedSubServiceIds,
    promoCodeApplied,
    promoDiscountAmount,
    createMaxPlayers,
    resolvedGameFormat,
    buildCommunityAutopublishMetadata,
    validateGamePublicationFields,
    resolveCurrentClientProfile,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  useEffect(() => {
    setPayError(null);
  }, [studioId, selectedDate, courtId, time, duration, selectedSlotId]);

  useEffect(() => {
    if (isGamePaid === true) {
      setRetryingPayment(false);
      setConfirmCancelUnpaidGame(false);
    }
  }, [isGamePaid]);

  useEffect(() => {
    if (step !== "details") {
      setConfirmCancelUnpaidGame(false);
    }
  }, [step, gameRecordId]);

  const handleCreateGameFromBooking = useCallback(async () => {
    if (!isBookingPresetMode || creatingFromBooking) return;

    if (!bookingPreset.canCreateFromPreset || !bookingPreset.bookingId || !bookingPreset.date
      || !bookingPreset.timeFrom || !bookingPreset.timeTo) {
      setGameRecordError("Недостаточно данных брони для создания сборной игры");
      return;
    }

    setCreatingFromBooking(true);
    setGameRecordError(null);
    setGameRosterError(null);

    try {
      const existing = findGameRecordByBookingData(
        activeGameRecordStore
          ? upsertPadelGameRecord(communityGames, activeGameRecordStore)
          : communityGames,
        createFromBooking,
      );
      if (existing) {
        setGameRecordId(existing.id);
        setGameRecordStatus(existing.status ?? null);
        setInviteLink(resolveGameInviteUrl(existing));
        setGamePaymentUrl(existing.payment?.paymentUrl ?? null);
        setGamePaid(existing.payment?.paid ?? null);
        setGameSnapshot(buildMatchSnapshotFromRecord(existing));
        setConfirmCancelUnpaidGame(false);
        void runPaidGameCommunityMembershipAndPublication(existing, "existing_open");
        setStep("details");
        return;
      }

      let clientId = profileId;
      let clientPhone = profilePhone;
      if (!clientId || !clientPhone) {
        const profileResult = await apiFetchProfile();
        clientId = profileResult.data?.id ?? null;
        clientPhone = profileResult.data?.phone ?? null;
        if (profileResult.data?.id) setProfileId(profileResult.data.id);
        if (profileResult.data?.phone) setProfilePhone(profileResult.data.phone);
      }

      const normalizedParticipants = participants.length > 0
        ? participants
        : [
            {
              id: clientId ?? null,
              name: profileName || "Организатор",
              phone: clientPhone ?? null,
              photo: profilePhoto ?? null,
              rating: profileGrade ?? null,
              ratingNumeric: profileRatingNumeric,
              source: "ORGANIZER" as const,
              status: "CONFIRMED" as const,
            },
          ];
      const organizerPlayer = normalizedParticipants[0];

      const payload: PadelGameRecordPayload = {
        tenantKey: null,
        status: bookingPreset.paid ? "PAID" : "PAYMENT_PENDING",
        organizer: {
          id: clientId ?? organizerPlayer?.id ?? null,
          name: profileName || organizerPlayer?.name || "Организатор",
          phone: clientPhone ?? organizerPlayer?.phone ?? null,
          photo: profilePhoto ?? organizerPlayer?.photo ?? null,
          rating: profileGrade ?? organizerPlayer?.rating ?? null,
          ratingNumeric: profileRatingNumeric ?? organizerPlayer?.ratingNumeric ?? null,
        },
        booking: {
          studioId: bookingPreset.studioId,
          studioName: bookingPreset.studioName,
          masterServiceId: null,
          subServiceIds: [],
          roomId: bookingPreset.roomId,
          roomName: bookingPreset.roomName,
          date: bookingPreset.date,
          timeFrom: bookingPreset.timeFrom,
          timeTo: bookingPreset.timeTo,
          timeFromIso: `${bookingPreset.date}T${bookingPreset.timeFrom}:00+03:00`,
          timeToIso: `${bookingPreset.date}T${bookingPreset.timeTo}:00+03:00`,
          durationMinutes: bookingPreset.durationMinutes,
          slotId: bookingPreset.slotId,
          bookingIds: [bookingPreset.bookingId],
        },
        payment: {
          amount: bookingPreset.amount,
          paymentUrl: bookingPreset.paymentUrl,
          paymentMethod: "WIDGET",
          paid: bookingPreset.paid,
          paidAt: bookingPreset.paid ? new Date().toISOString() : null,
          bookingIds: [bookingPreset.bookingId],
        },
        settings: {
          ratingGame: effectiveRatingGame,
          minRating: effectiveRatingGame ? (RATING_LABELS[minRating] ?? null) : null,
          maxRating: effectiveRatingGame ? (RATING_LABELS[maxRating] ?? null) : null,
          isPrivate,
          payMode: "self",
        },
        invite: {
          inviteUrl: null,
          waitlistEnabled,
          maxPlayers: createMaxPlayers,
        },
        participants: normalizedParticipants.slice(0, createMaxPlayers),
        waitlist: [],
        metadata: {
          source: "cabinet_booking_convert",
          bookingId: bookingPreset.bookingId,
          bookingIds: [bookingPreset.bookingId],
          slotId: bookingPreset.slotId,
          vivaExerciseId: bookingPreset.exerciseId,
          exerciseId: bookingPreset.exerciseId,
          directionName: bookingPreset.directionName,
          gameFormat: resolvedGameFormat,
          ...buildGameOptionalMetadataFields({
            gameTitle: gameTitleDraft,
            participantComment: gameParticipantCommentDraft,
            joinPrice: gameJoinPriceDraft,
          }),
          ...buildCommunityAutopublishMetadataFields(buildCommunityAutopublishMetadata()),
        },
      };

      const createResult = await apiCreatePadelGameRecord(payload);
      if (!createResult.data?.id) {
        setGameRecordError(createResult.error?.message || "Не удалось создать сборную игру");
        return;
      }

      const createdRecord = createResult.data;
      upsertGameRecordInStores(createdRecord, { communityMode: "upsert" });
      notifyGameRecordsUpdated([createdRecord], "games_booking_create");
      void runPaidGameCommunityMembershipAndPublication(createdRecord, "booking_create");
      setGameRecordId(createdRecord.id);
      setGameRecordStatus(createdRecord.status ?? payload.status ?? null);
      setInviteLink(resolveGameInviteUrl(createdRecord));
      setGamePaymentUrl(createdRecord.payment?.paymentUrl ?? payload.payment.paymentUrl ?? null);
      setGamePaid(createdRecord.payment?.paid ?? payload.payment.paid ?? null);
      setGameSnapshot(
        mergeMatchSnapshots(
          buildMatchSnapshotFromPayload(payload),
          buildMatchSnapshotFromRecord(createdRecord),
        ),
      );
      setConfirmCancelUnpaidGame(false);
      setStep("details");
    } finally {
      setCreatingFromBooking(false);
    }
  }, [
    isBookingPresetMode,
    creatingFromBooking,
    bookingPreset,
    communityGames,
    createFromBooking,
    activeGameRecordStore,
    profileId,
    profilePhone,
    participants,
    profileName,
    profilePhoto,
    profileGrade,
    profileRatingNumeric,
    gameTitleDraft,
    gameParticipantCommentDraft,
    gameJoinPriceDraft,
    effectiveRatingGame,
    minRating,
    maxRating,
    isPrivate,
    waitlistEnabled,
    createMaxPlayers,
    resolvedGameFormat,
    buildCommunityAutopublishMetadata,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  const handleCreateGame = () => {
    if (loadingPay) return;
    if (!validateGamePublicationFields()) return;

    if (isBookingPresetMode) {
      void handleCreateGameFromBooking();
      return;
    }

    if (!studio) {
      setStep("place");
      return;
    }
    if (!canProceedToPayment) {
      setStep("time");
      return;
    }

    void handleMasterServicePay();
  };

  const handleCopyInvite = async () => {
    if (!inviteLink) return;
    try {
      await shareOrCopyGameInvitePayload(inviteLink, activeGameRecord, {
        includePreviewImage: true,
        preferNativeShare: false,
      });
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1600);
    } catch {
      setInviteCopied(false);
    }
  };

  const loadChatMessages = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (!gameRecordId || !profilePhone) return;

      if (mode === "initial") {
        setChatLoading(true);
        setChatError(null);
      } else {
        setChatRefreshing(true);
      }

      const result = await apiFetchPadelGameChatMessages({
        gameId: gameRecordId,
        phone: profilePhone,
        limit: 100,
      });

      if (result.data) {
        setChatMessages((prev) => mergeChatMessages(prev, result.data?.messages ?? []));
        const lastMessage = result.data.messages[result.data.messages.length - 1];
        if (lastMessage?.createdTs) {
          void markChatAsRead(gameRecordId, lastMessage.createdTs);
        }
      } else if (result.error) {
        setChatError(result.error.message || "Не удалось загрузить чат");
      }

      if (mode === "initial") {
        setChatLoading(false);
      } else {
        setChatRefreshing(false);
      }
    },
    [gameRecordId, markChatAsRead, profilePhone],
  );

  useEffect(() => {
    if (step !== "chat" || !gameRecordId || !profilePhone) return;
    let alive = true;

    loadChatMessages("initial").catch(() => {
      if (!alive) return;
      setChatError("Не удалось загрузить чат");
      setChatLoading(false);
    });

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadChatMessages("refresh");
    }, 7000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [step, gameRecordId, profilePhone, loadChatMessages]);

  useEffect(() => {
    if (step !== "chat") return;
    if (!chatBottomRef.current) return;
    chatBottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [step, chatMessages.length]);

  const handleSendChatMessage = useCallback(async () => {
    const text = chatDraft.trim();
    if (!text || !gameRecordId || !profilePhone || chatSending) return;

    setChatSending(true);
    setChatError(null);

    const sendResult = await apiSendPadelGameChatMessage({
      gameId: gameRecordId,
      senderPhone: profilePhone,
      senderName: profileName,
      senderId: profileId,
      text,
    });

    const sentMessage = sendResult.data;
    if (sentMessage) {
      setChatMessages((prev) => mergeChatMessages(prev, [sentMessage]));
      setChatDraft("");
      void markChatAsRead(gameRecordId, sentMessage.createdTs || Date.now());
    } else {
      setChatError(sendResult.error?.message || "Не удалось отправить сообщение");
    }

    setChatSending(false);
  }, [
    chatDraft,
    chatSending,
    gameRecordId,
    markChatAsRead,
    profileId,
    profileName,
    profilePhone,
  ]);

  const handleRetryPayment = useCallback(async () => {
    if (retryingPayment) return;
    setRetryingPayment(true);
    setGameRecordError(null);

    try {
      const vivaStatus = await resolveGamePaymentByVivaBookings(
        activeGameRecord,
        gamePaymentUrl,
        gameSnapshot,
      );
      if (vivaStatus.cancelled) {
        if (gameRecordId) {
          void apiUpdatePadelGameRecord(gameRecordId, { status: "CANCELLED" });
        }
        if (activeGameRecord) {
          upsertGameRecordInStores({
            ...activeGameRecord,
            status: "CANCELLED",
            payment: {
              amount: activeGameRecord.payment?.amount ?? detailsAmount ?? null,
              paymentUrl: vivaStatus.paymentUrl ?? gamePaymentUrl ?? activeGameRecord.payment?.paymentUrl ?? null,
              paid: false,
            },
          }, { communityMode: "if_exists" });
        }
        setGamePaid(false);
        setGameRecordStatus("CANCELLED");
        setInviteLink(null);
        setGameRecordError("Бронь отменена");
        setRetryingPayment(false);
        return;
      }
      if (vivaStatus.paid === true) {
        const nextPaymentUrl = vivaStatus.paymentUrl ?? gamePaymentUrl ?? activeGameRecord?.payment?.paymentUrl ?? null;
        const paidAt = new Date().toISOString();
        const fallbackInvite = gameRecordId
          ? buildInviteFallbackUrl(gameRecordId)
          : (activeGameRecord ? buildInviteFallbackUrl(activeGameRecord.id) : null);
        const paidRecord = activeGameRecord
          ? {
            ...activeGameRecord,
            status: "PAID",
            payment: {
              amount: activeGameRecord.payment?.amount ?? detailsAmount ?? null,
              paymentUrl: nextPaymentUrl,
              paid: true,
            },
          }
          : null;

        setGamePaid(true);
        setGameRecordStatus((prev) => {
          const statusUpper = String(prev || "").trim().toUpperCase();
          if (statusUpper.includes("PAID") || statusUpper.includes("PAYED")) return prev;
          return "PAID";
        });
        if (paidRecord) {
          upsertGameRecordInStores(paidRecord, { communityMode: "if_exists" });
        }
        if (fallbackInvite) {
          setInviteLink((prev) => prev ?? fallbackInvite);
        }
        if (nextPaymentUrl) {
          setGamePaymentUrl(nextPaymentUrl);
        }

        if (gameRecordId) {
          const patchResult = await apiUpdatePadelGameRecord(gameRecordId, {
            status: "PAID",
            payment: {
              amount: activeGameRecord?.payment?.amount ?? detailsAmount ?? null,
              paymentUrl: nextPaymentUrl,
              paymentMethod: "WIDGET",
              paid: true,
              paidAt,
            },
          });
          if (patchResult.data?.id) {
            const mergedPatchedRecord = mergePadelGameRecord(paidRecord, patchResult.data as PadelGameRecord);
            upsertGameRecordInStores(mergedPatchedRecord, { communityMode: "if_exists" });
            void runPaidGameCommunityMembershipAndPublication(mergedPatchedRecord, "payment_status_sync");
          } else if (paidRecord) {
            void runPaidGameCommunityMembershipAndPublication(paidRecord, "payment_status_sync");
          }
        } else if (paidRecord) {
          void runPaidGameCommunityMembershipAndPublication(paidRecord, "payment_status_sync");
        }

        setRetryingPayment(false);
        return;
      }

      const paymentUrlToOpen =
        vivaStatus.paymentUrl ??
        gamePaymentUrl ??
        activeGameRecord?.payment?.paymentUrl ??
        null;
      if (!paymentUrlToOpen) {
        setGameRecordError("Ссылка на оплату не найдена");
        setRetryingPayment(false);
        return;
      }

      if (!navigateToExternalUrl(paymentUrlToOpen)) {
        setGameRecordError("Не удалось открыть страницу оплаты");
        setRetryingPayment(false);
      }
    } catch {
      setGameRecordError("Не удалось проверить статус оплаты брони");
      setRetryingPayment(false);
    }
  }, [
    retryingPayment,
    resolveGamePaymentByVivaBookings,
    activeGameRecord,
    gamePaymentUrl,
    gameSnapshot,
    gameRecordId,
    detailsAmount,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  const handleCancelUnpaidGame = useCallback(async () => {
    if (!gameRecordId || cancellingUnpaidGame) return;

    setCancellingUnpaidGame(true);
    setGameRecordError(null);

    const cancelResult = await apiUpdatePadelGameRecord(gameRecordId, {
      status: "CANCELLED",
    });

    if (cancelResult.data?.id || !cancelResult.error) {
      const cancelledId = gameRecordId;
      removeGameRecordFromStores(cancelledId);
      setGameRecordId(null);
      setGameRecordStatus("CANCELLED");
      setInviteLink(null);
      setGamePaymentUrl(null);
      setGamePaid(false);
      setGameSnapshot(null);
      setConfirmCancelUnpaidGame(false);
      setCancellingUnpaidGame(false);
      setStep("create");
      return;
    }

    setGameRecordError(cancelResult.error?.message || "Не удалось отменить бронь");
    setCancellingUnpaidGame(false);
  }, [gameRecordId, cancellingUnpaidGame, removeGameRecordFromStores]);

  const toggleDetailsCommunityUnpublishSelection = useCallback((communityId: string) => {
    const normalizedCommunityId = communityId.trim();
    if (!normalizedCommunityId) return;

    setDetailsSelectedCommunityUnpublishIds((current) => (
      current.includes(normalizedCommunityId)
        ? current.filter((item) => item !== normalizedCommunityId)
        : [...current, normalizedCommunityId]
    ));
  }, []);

  const handleUnpublishSelectedGameCommunities = useCallback(async () => {
    if (!activeGameRecord?.id || !isCurrentUserOrganizerOfActiveGame || updatingGameMeta) {
      return;
    }

    const baseMetadata = isRecordObject(activeGameRecord.metadata)
      ? { ...activeGameRecord.metadata }
      : {};
    const currentAutopublishPayload = getCommunityAutopublishPayload(baseMetadata);
    if (!currentAutopublishPayload) {
      return;
    }

    const currentPostsByCommunityId = extractCommunityAutopublishPostsMap(baseMetadata);
    const communityIdsToUnpublish = Array.from(new Set(
      detailsSelectedCommunityUnpublishIds
        .map((communityId) => communityId.trim())
        .filter((communityId) => Boolean(currentPostsByCommunityId[communityId])),
    ));
    if (communityIdsToUnpublish.length === 0) {
      return;
    }

    const savedCommunities = extractCommunityAutopublishSavedCommunities(baseMetadata);
    const savedCommunityById = new Map(savedCommunities.map((entry) => [entry.communityId, entry] as const));
    const targetById = new Map<string, CommunityAutopublishTarget>([
      ...(communityAutopublishStationTarget ? [[communityAutopublishStationTarget.id, communityAutopublishStationTarget] as const] : []),
      ...communityAutopublishMemberTargets.map((target) => [target.id, target] as const),
    ]);
    const getCommunityLabel = (communityId: string) => (
      targetById.get(communityId)?.name
      ?? savedCommunityById.get(communityId)?.communityName
      ?? communityId
    );

    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      const actor = await resolveCurrentCommunityActor();
      const archiveResults = await Promise.all(
        communityIdsToUnpublish.map(async (communityId) => {
          const postId = currentPostsByCommunityId[communityId] ?? "";
          const response = await apiArchiveCommunityFeedPost(communityId, postId, {
            member: actor,
          });
          return {
            communityId,
            postId,
            ok: Boolean(response.data?.archived && !response.error),
          };
        }),
      );

      const archivedCommunityIds = archiveResults
        .filter((item) => item.ok)
        .map((item) => item.communityId);
      const failedCommunityIds = archiveResults
        .filter((item) => !item.ok)
        .map((item) => item.communityId);

      if (archivedCommunityIds.length === 0) {
        setGameDetailsMetaError("Не удалось снять публикацию из выбранных сообществ");
        return;
      }

      const currentSelectionState = extractCommunityAutopublishSelectionState(baseMetadata);
      const nextPostsByCommunityId = { ...currentPostsByCommunityId };
      archivedCommunityIds.forEach((communityId) => {
        delete nextPostsByCommunityId[communityId];
      });

      const nextAutopublishPayload = {
        ...currentAutopublishPayload,
        selectionTouched: true,
        lastAttemptAt: new Date().toISOString(),
        selectedCommunityIds: currentSelectionState.selectedCommunityIds.filter((communityId) => (
          !archivedCommunityIds.includes(communityId)
        )),
        posts: nextPostsByCommunityId,
        communities: Object.keys(nextPostsByCommunityId).map((communityId) => {
          const savedEntry = savedCommunityById.get(communityId);
          return {
            communityId,
            communityName: getCommunityLabel(communityId),
            postId: nextPostsByCommunityId[communityId] ?? savedEntry?.postId ?? null,
            status: savedEntry?.status ?? "PUBLISHED",
            error: null,
          };
        }),
      };

      const nextMetadata = {
        ...baseMetadata,
        ...buildCommunityAutopublishMetadataFields(nextAutopublishPayload),
      };

      const updateResult = await apiUpdatePadelGameRecord(activeGameRecord.id, {
        metadata: nextMetadata,
      });

      if (updateResult.data?.id) {
        upsertGameRecordInStores(updateResult.data as PadelGameRecord, { communityMode: "if_exists" });
        setDetailsSelectedCommunityUnpublishIds((current) => current.filter((communityId) => (
          !archivedCommunityIds.includes(communityId)
        )));
        if (failedCommunityIds.length > 0) {
          setGameDetailsMetaError(`Не удалось снять публикацию из: ${failedCommunityIds.map(getCommunityLabel).join(", ")}`);
        }
        return;
      }

      setGameDetailsMetaError(
        updateResult.error?.message
        || "Публикация снята, но не удалось сохранить обновленное состояние игры",
      );
    } catch {
      setGameDetailsMetaError("Не удалось снять публикацию из выбранных сообществ");
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    activeGameRecord,
    communityAutopublishMemberTargets,
    communityAutopublishStationTarget,
    detailsSelectedCommunityUnpublishIds,
    isCurrentUserOrganizerOfActiveGame,
    resolveCurrentCommunityActor,
    updatingGameMeta,
    upsertGameRecordInStores,
  ]);

  const saveDetailsMetadata = useCallback(async (
    nextMetadata: Record<string, unknown>,
    fallbackErrorMessage: string,
  ) => {
    if (!gameRecordId) return false;

    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      const updateResult = await apiUpdatePadelGameRecord(gameRecordId, {
        organizer: detailsOrganizerPayload,
        participants: detailsParticipants,
        waitlist: detailsWaitlist,
        invite: {
          waitlistEnabled: activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled,
          maxPlayers: activeGameRecord?.invite?.maxPlayers ?? detailsMaxPlayers,
        },
        metadata: nextMetadata,
      });

      if (updateResult.data?.id) {
        upsertGameRecordInStores(updateResult.data as PadelGameRecord, { communityMode: "if_exists" });
        return true;
      }

      setGameDetailsMetaError(updateResult.error?.message || fallbackErrorMessage);
      return false;
    } catch {
      setGameDetailsMetaError(fallbackErrorMessage);
      return false;
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    gameRecordId,
    detailsOrganizerPayload,
    detailsParticipants,
    detailsWaitlist,
    activeGameRecord?.invite?.maxPlayers,
    activeGameRecord?.invite?.waitlistEnabled,
    waitlistEnabled,
    detailsMaxPlayers,
    upsertGameRecordInStores,
  ]);

  const buildDraftMatchResultMetadata = useCallback((options?: {
    photos?: MatchResultAttachment[];
    setPairings?: Array<MatchResultSetPairingSlots | null>;
  }): Record<string, unknown> | null => {
    const existingMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : {};
    const completedSets = detailsCompletedMatchResultSets
      .map((setItem) => ({
        left: Number.parseInt(setItem.left, 10),
        right: Number.parseInt(setItem.right, 10),
      }))
      .filter((setItem) => Number.isFinite(setItem.left) && Number.isFinite(setItem.right));
    const nextPhotos = options?.photos ?? detailsMatchResultAttachments;
    const nextSetPairings = options?.setPairings ?? detailsMatchResultSetPairings;
    const setPairingsPayload = buildMatchResultSetPairingsPayload(
      materializeCompletedMatchResultSetPairings(nextSetPairings, completedSets.length),
    );

    if (
      Object.keys(existingMatchResult).length === 0
      && completedSets.length === 0
      && nextPhotos.length === 0
      && setPairingsPayload.length === 0
    ) {
      return null;
    }

    const nextMatchResult: Record<string, unknown> = {
      ...existingMatchResult,
      photos: nextPhotos,
    };
    delete nextMatchResult.setPairings;
    delete nextMatchResult.pairings;

    if (completedSets.length > 0) {
      nextMatchResult.sets = completedSets;
    } else {
      delete nextMatchResult.sets;
    }

    if (setPairingsPayload.length > 0) {
      nextMatchResult.setPairings = setPairingsPayload;
    }

    return nextMatchResult;
  }, [
    detailsCompletedMatchResultSets,
    detailsMatchResultAttachments,
    detailsMatchResultSetPairings,
    detailsMetadata.matchResult,
  ]);

  const patchGameRoster = useCallback(async (
    nextParticipantsRaw: PadelGamePlayer[],
    nextWaitlistRaw: PadelGamePlayer[],
    options?: {
      metadata?: Record<string, unknown>;
      fallbackErrorMessage?: string;
    },
  ) => {
    if (!gameRecordId) return;

    const normalizePlayers = (
      players: PadelGamePlayer[],
      fallbackStatus: PadelGamePlayer["status"],
    ) => {
      const map = new Map<string, PadelGamePlayer>();
      players.forEach((player) => {
        const key = getPadelPlayerIdentityKey(player) || `player-${map.size + 1}`;
        if (map.has(key)) return;
        map.set(key, {
          ...player,
          status: player.status ?? fallbackStatus,
        });
      });
      return Array.from(map.values());
    };

    const normalizedParticipants = normalizePlayers(nextParticipantsRaw, "CONFIRMED")
      .slice(0, detailsMaxPlayers);
    const participantKeys = new Set(
      normalizedParticipants
        .map((player) => getPadelPlayerIdentityKey(player))
        .filter(Boolean),
    );
    const normalizedWaitlist = normalizePlayers(nextWaitlistRaw, "WAITLIST")
      .filter((player) => {
        const key = getPadelPlayerIdentityKey(player);
        return !key || !participantKeys.has(key);
      });
    setUpdatingGameRoster(true);
    setGameRosterError(null);
    try {
      const payload: Parameters<typeof apiUpdatePadelGameRecord>[1] = {
        organizer: detailsOrganizerPayload,
        participants: normalizedParticipants,
        waitlist: normalizedWaitlist,
        invite: {
          waitlistEnabled: activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled,
          maxPlayers: activeGameRecord?.invite?.maxPlayers ?? detailsMaxPlayers,
        },
      };
      if (options?.metadata) {
        payload.metadata = options.metadata;
      }

      const updateResult = await apiUpdatePadelGameRecord(gameRecordId, payload);

      if (updateResult.data?.id) {
        const normalizedRecord = updateResult.data as PadelGameRecord;
        const mergedRecord = mergePadelGameRecord(activeGameRecord, normalizedRecord);
        const recordWithRoster: PadelGameRecord = {
          ...mergedRecord,
          participants: normalizedParticipants,
          waitlist: normalizedWaitlist,
        };
        upsertGameRecordInStores(recordWithRoster, { communityMode: "if_exists" });
        setParticipants(normalizedParticipants);
        setWaitlistPlayers(normalizedWaitlist);
        setGameRosterError(null);
        return true;
      } else {
        setGameRosterError(
          updateResult.error?.message
          || options?.fallbackErrorMessage
          || "Не удалось обновить список игроков",
        );
        return false;
      }
    } catch {
      setGameRosterError(options?.fallbackErrorMessage || "Не удалось обновить список игроков");
      return false;
    } finally {
      setUpdatingGameRoster(false);
    }
  }, [
    gameRecordId,
    detailsMaxPlayers,
    detailsOrganizerPayload,
    activeGameRecord,
    activeGameRecord?.invite?.maxPlayers,
    activeGameRecord?.invite?.waitlistEnabled,
    upsertGameRecordInStores,
    waitlistEnabled,
  ]);

  const buildStoredTeamSlots = useCallback((slots: Array<PadelGamePlayer | null>) => (
    buildStoredTeamSlotsRefs(slots)
  ), []);

  const buildDetailsRosterMetadata = useCallback((
    nextParticipants: PadelGamePlayer[],
    nextWaitlist: PadelGamePlayer[],
    options?: {
      organizerInMatch?: boolean;
      teamSlots?: Array<PadelGamePlayer | null>;
      setPairings?: Array<MatchResultSetPairingSlots | null>;
      extraMetadata?: Record<string, unknown>;
    },
  ): Record<string, unknown> => {
    const participantPhones = nextParticipants
      .map((player) => normalizePhoneForGame(player.phone))
      .filter((value): value is string => Boolean(value));
    const waitlistPhones = nextWaitlist
      .map((player) => normalizePhoneForGame(player.phone))
      .filter((value): value is string => Boolean(value));
    const organizerPhone = normalizePhoneForGame(detailsOrganizerPayload.phone);
    const draftMatchResult = buildDraftMatchResultMetadata({
      setPairings: options?.setPairings,
    });

    return {
      ...detailsMetadata,
      ...(draftMatchResult ? { matchResult: draftMatchResult } : {}),
      ...(options?.extraMetadata ?? {}),
      organizerInMatch: options?.organizerInMatch ?? detailsOrganizerInMatch,
      teamSlots: buildStoredTeamSlots(options?.teamSlots ?? detailsTeamSlots),
      participantPhones,
      waitlistPhones,
      allRelatedPhones: Array.from(new Set([
        organizerPhone,
        ...participantPhones,
        ...waitlistPhones,
      ].filter((value): value is string => Boolean(value)))),
    };
  }, [
    detailsMetadata,
    detailsOrganizerInMatch,
    detailsOrganizerPayload.phone,
    buildDraftMatchResultMetadata,
    detailsTeamSlots,
    buildStoredTeamSlots,
  ]);

  const buildNextSetPairingsForTeamSlots = useCallback((
    nextSlots: Array<PadelGamePlayer | null>,
    options?: {
      basePairings?: Array<MatchResultSetPairingSlots | null>;
    },
  ): Array<MatchResultSetPairingSlots | null> => {
    const nextPairings = (options?.basePairings ?? detailsMatchResultSetPairings).map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const targetSetIndex = detailsLastCompletedMatchResultSetIndex + 1;
    if (targetSetIndex < 0 || targetSetIndex >= MAX_MATCH_RESULT_SETS) {
      return nextPairings;
    }

    if (!canEditMatchResult || areTeamSlotsEqualByIdentity(nextSlots, detailsTeamSlots)) {
      return nextPairings;
    }

    for (let setIndex = 0; setIndex < targetSetIndex; setIndex += 1) {
      if (nextPairings[setIndex]?.some(Boolean)) continue;
      nextPairings[setIndex] = cloneTeamSlots(detailsTeamSlots);
    }
    nextPairings[targetSetIndex] = cloneTeamSlots(nextSlots);
    return nextPairings;
  }, [
    canEditMatchResult,
    detailsLastCompletedMatchResultSetIndex,
    detailsMatchResultSetPairings,
    detailsTeamSlots,
  ]);

  const persistTeamSlots = useCallback(async (
    nextSlots: Array<PadelGamePlayer | null>,
    options?: {
      setPairings?: Array<MatchResultSetPairingSlots | null>;
    },
  ) => {
    const nextSetPairings = options?.setPairings ?? buildNextSetPairingsForTeamSlots(nextSlots);
    const nextMetadata = buildDetailsRosterMetadata(detailsParticipants, detailsWaitlist, {
      teamSlots: nextSlots,
      setPairings: nextSetPairings,
    });

    return saveDetailsMetadata(nextMetadata, "Не удалось обновить состав команд");
  }, [
    buildDetailsRosterMetadata,
    buildNextSetPairingsForTeamSlots,
    detailsParticipants,
    detailsWaitlist,
    saveDetailsMetadata,
  ]);

  const handleTeamSlotPick = useCallback(async (
    slotIndex: number,
    player: PadelGamePlayer | null,
  ) => {
    if (slotIndex < 0 || slotIndex >= DETAILS_TEAM_SLOTS_COUNT) return;
    if (updatingGameMeta) return;
    if (!canManagePlayersInDetails) return;

    const organizerKey = detailsOrganizerKey;
    const targetKey = getPadelPlayerIdentityKey(player);
    const playerForSlot = player
      ? {
          ...player,
          status: "CONFIRMED" as const,
        }
      : null;

    if (slotIndex === 0 && playerForSlot && targetKey) {
      if (detailsOrganizerInMatch) {
        if (!organizerKey || targetKey === organizerKey) {
          setDetailsTeamMenuSlotIndex(null);
          return;
        }

        const previousSlots = [...detailsTeamSlots];
        const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
          teamSlots ? cloneTeamSlots(teamSlots) : null
        ));
        const nextParticipants = detailsParticipants
          .filter((item) => getPadelPlayerIdentityKey(item) !== organizerKey);
        const promotedAlreadyInMatch = nextParticipants.some(
          (item) => getPadelPlayerIdentityKey(item) === targetKey,
        );
        const normalizedParticipants = promotedAlreadyInMatch
          ? nextParticipants
          : [...nextParticipants, playerForSlot];
        const normalizedWaitlist = detailsWaitlist.filter(
          (item) => getPadelPlayerIdentityKey(item) !== targetKey,
        );
        const nextSlots = [...detailsTeamSlots];
        nextSlots.forEach((slotPlayer, index) => {
          if (index === 0) return;
          if (getPadelPlayerIdentityKey(slotPlayer) === targetKey) {
            nextSlots[index] = null;
          }
        });
        nextSlots[0] = playerForSlot;
        const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots);

        setDetailsTeamSlots(nextSlots);
        setDetailsMatchResultSetPairings(nextSetPairings);
        setDetailsTeamMenuSlotIndex(null);
        const nextMetadata = buildDetailsRosterMetadata(normalizedParticipants, normalizedWaitlist, {
          organizerInMatch: false,
          teamSlots: nextSlots,
          setPairings: nextSetPairings,
        });
        const saved = await patchGameRoster(normalizedParticipants, normalizedWaitlist, {
          metadata: nextMetadata,
          fallbackErrorMessage: "Не удалось обновить состав игроков",
        });
        if (!saved) {
          setDetailsTeamSlots(previousSlots);
          setDetailsMatchResultSetPairings(previousSetPairings);
        }
        return;
      }

      if (organizerKey && targetKey === organizerKey) {
        if (!detailsHasFreeSlots) {
          setGameDetailsMetaError("Сначала освободите место в составе, чтобы вернуть организатора в матч");
          setDetailsTeamMenuSlotIndex(null);
          return;
        }

        const previousSlots = [...detailsTeamSlots];
        const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
          teamSlots ? cloneTeamSlots(teamSlots) : null
        ));
        const organizerPlayerForSlot: PadelGamePlayer = {
          ...playerForSlot,
          source: "ORGANIZER",
          status: "CONFIRMED",
        };
        const normalizedParticipants = detailsParticipants.some(
          (item) => getPadelPlayerIdentityKey(item) === organizerKey,
        )
          ? detailsParticipants
          : [organizerPlayerForSlot, ...detailsParticipants];
        const nextSlots = [...detailsTeamSlots];
        nextSlots[0] = organizerPlayerForSlot;
        const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots);

        setDetailsTeamSlots(nextSlots);
        setDetailsMatchResultSetPairings(nextSetPairings);
        setDetailsTeamMenuSlotIndex(null);
        const nextMetadata = buildDetailsRosterMetadata(normalizedParticipants, detailsWaitlist, {
          organizerInMatch: true,
          teamSlots: nextSlots,
          setPairings: nextSetPairings,
        });
        const saved = await patchGameRoster(normalizedParticipants, detailsWaitlist, {
          metadata: nextMetadata,
          fallbackErrorMessage: "Не удалось вернуть организатора в состав",
        });
        if (!saved) {
          setDetailsTeamSlots(previousSlots);
          setDetailsMatchResultSetPairings(previousSetPairings);
        }
        return;
      }
    }

    const previousSlots = [...detailsTeamSlots];
    const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const nextSlots = [...detailsTeamSlots];
    const previousSlotPlayer = detailsTeamSlots[slotIndex] ?? null;
    const previousSlotKey = getPadelPlayerIdentityKey(previousSlotPlayer);
    const targetFromWaitlist = Boolean(targetKey && detailsWaitlist.some((item) => (
      getPadelPlayerIdentityKey(item) === targetKey
    )));
    if (playerForSlot) {
      nextSlots.forEach((slotPlayer, index) => {
        const slotKey = getPadelPlayerIdentityKey(slotPlayer);
        if (!targetKey || !slotKey) return;
        if (index !== slotIndex && slotKey === targetKey) {
          nextSlots[index] = null;
        }
      });
    }
    nextSlots[slotIndex] = playerForSlot;
    if (detailsOrganizerInMatch && detailsOrganizerPlayer) {
      nextSlots[0] = detailsOrganizerPlayer;
    }
    const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots);

    setDetailsTeamSlots(nextSlots);
    setDetailsMatchResultSetPairings(nextSetPairings);
    setDetailsTeamMenuSlotIndex(null);
    if (playerForSlot && targetKey && targetFromWaitlist) {
      const shouldDemotePreviousSlot = Boolean(
        previousSlotPlayer
        && previousSlotKey
        && previousSlotKey !== targetKey
        && !detailsHasFreeSlots,
      );
      const normalizedParticipantsBase = detailsParticipants.filter((item) => {
        const itemKey = getPadelPlayerIdentityKey(item);
        if (itemKey === targetKey) return false;
        if (shouldDemotePreviousSlot && itemKey && itemKey === previousSlotKey) return false;
        return true;
      });
      const normalizedParticipants = normalizedParticipantsBase.some((item) => (
        getPadelPlayerIdentityKey(item) === targetKey
      ))
        ? normalizedParticipantsBase
        : [...normalizedParticipantsBase, playerForSlot];
      const normalizedWaitlistBase = detailsWaitlist.filter((item) => (
        getPadelPlayerIdentityKey(item) !== targetKey
      ));
      const normalizedWaitlist = shouldDemotePreviousSlot && previousSlotPlayer
        ? [
            ...normalizedWaitlistBase,
            {
              ...previousSlotPlayer,
              status: "WAITLIST" as const,
            },
          ]
        : normalizedWaitlistBase;
      const nextMetadata = buildDetailsRosterMetadata(normalizedParticipants, normalizedWaitlist, {
        teamSlots: nextSlots,
        setPairings: nextSetPairings,
      });
      const saved = await patchGameRoster(normalizedParticipants, normalizedWaitlist, {
        metadata: nextMetadata,
        fallbackErrorMessage: "Не удалось добавить игрока из листа ожидания",
      });
      if (!saved) {
        setDetailsTeamSlots(previousSlots);
        setDetailsMatchResultSetPairings(previousSetPairings);
      }
      return;
    }

    const saved = await persistTeamSlots(nextSlots, { setPairings: nextSetPairings });
    if (!saved) {
      setDetailsTeamSlots(previousSlots);
      setDetailsMatchResultSetPairings(previousSetPairings);
    }
  }, [
    updatingGameMeta,
    canManagePlayersInDetails,
    detailsHasFreeSlots,
    detailsOrganizerInMatch,
    detailsOrganizerKey,
    detailsOrganizerPlayer,
    detailsMatchResultSetPairings,
    detailsParticipants,
    detailsTeamSlots,
    detailsWaitlist,
    buildDetailsRosterMetadata,
    buildNextSetPairingsForTeamSlots,
    patchGameRoster,
    setGameDetailsMetaError,
    persistTeamSlots,
  ]);

  const handleTeamSlotTap = useCallback((slotIndex: number) => {
    if (slotIndex < 0 || slotIndex >= DETAILS_TEAM_SLOTS_COUNT) return;
    if (updatingGameMeta) return;

    if (canManagePlayersInDetails) {
      setDetailsTeamMenuSlotIndex((prev) => (prev === slotIndex ? null : slotIndex));
      return;
    }

    if (!isCurrentUserConfirmedParticipant || !detailsCurrentUserParticipant) return;
    if (slotIndex === 0 && detailsOrganizerInMatch) return;
    if (detailsCurrentUserTeamSlotIndex >= 0) return;
    if (detailsTeamSlots[slotIndex]) return;

    const nextSlots = [...detailsTeamSlots];
    nextSlots[slotIndex] = detailsCurrentUserParticipant;
    if (detailsOrganizerInMatch && detailsOrganizerPlayer) {
      nextSlots[0] = detailsOrganizerPlayer;
    }
    const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots);
    setDetailsTeamSlots(nextSlots);
    setDetailsMatchResultSetPairings(nextSetPairings);
    void persistTeamSlots(nextSlots, { setPairings: nextSetPairings }).then((saved) => {
      if (saved) return;
      setDetailsTeamSlots(detailsTeamSlots);
      setDetailsMatchResultSetPairings(previousSetPairings);
    });
  }, [
    updatingGameMeta,
    canManagePlayersInDetails,
    detailsOrganizerInMatch,
    detailsOrganizerPlayer,
    detailsMatchResultSetPairings,
    isCurrentUserConfirmedParticipant,
    detailsCurrentUserParticipant,
    detailsCurrentUserTeamSlotIndex,
    detailsTeamSlots,
    buildNextSetPairingsForTeamSlots,
    persistTeamSlots,
  ]);

  const handleQuickPairingApply = useCallback(async (
    nextSlots: Array<PadelGamePlayer | null>,
  ) => {
    if (!canEditMatchResult || updatingGameMeta) return;
    const targetSetIndex = detailsLastCompletedMatchResultSetIndex + 1;
    if (targetSetIndex < 0 || targetSetIndex >= MAX_MATCH_RESULT_SETS) return;

    if (areTeamSlotsEqualByIdentity(nextSlots, detailsTeamSlots)) {
      setDetailsPairComposerSetIndex(null);
      return;
    }

    const previousSlots = [...detailsTeamSlots];
    const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const nextSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    nextSetPairings[targetSetIndex] = cloneTeamSlots(nextSlots);
    setDetailsTeamMenuSlotIndex(null);
    setDetailsMatchResultSetPairings(nextSetPairings);
    setDetailsTeamSlots(nextSlots);
    const saved = await persistTeamSlots(nextSlots, { setPairings: nextSetPairings });
    if (!saved) {
      setDetailsMatchResultSetPairings(previousSetPairings);
      setDetailsTeamSlots(previousSlots);
      return;
    }

    setDetailsPairComposerSetIndex(null);
  }, [
    canEditMatchResult,
    detailsLastCompletedMatchResultSetIndex,
    detailsMatchResultSetPairings,
    updatingGameMeta,
    detailsTeamSlots,
    persistTeamSlots,
  ]);

  const handleMatchResultInputChange = useCallback((
    setIndex: number,
    side: "left" | "right",
    value: string,
  ) => {
    if (!canEditMatchResult || updatingGameMeta) return;
    setDetailsMatchResultSets((prev) => {
      const next = prev.map((setItem) => ({ ...setItem }));
      if (!next[setIndex]) {
        next[setIndex] = { left: "", right: "" };
      }
      next[setIndex][side] = normalizeScoreInput(value);
      return normalizeEditableScoreSets(next);
    });
  }, [canEditMatchResult, updatingGameMeta]);

  const persistMatchResultAttachments = useCallback(async (
    nextAttachments: MatchResultAttachment[],
    fallbackErrorMessage: string,
  ) => {
    if (!gameRecordId) return true;
    const draftMatchResult = buildDraftMatchResultMetadata({
      photos: nextAttachments,
    });

    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      ...(draftMatchResult ? { matchResult: draftMatchResult } : {}),
    };

    return saveDetailsMetadata(nextMetadata, fallbackErrorMessage);
  }, [gameRecordId, buildDraftMatchResultMetadata, detailsMetadata, saveDetailsMetadata]);

  const handleMatchResultAttachmentFiles = useCallback(async (
    files: FileList | null,
    source: "camera" | "gallery",
  ) => {
    if (!files || files.length === 0) return;
    if (
      !isCurrentUserConfirmedParticipant
      || isMatchResultPendingReview
      || isMatchResultAgreed
      || updatingGameMeta
    ) return;

    const available = Math.max(0, MAX_MATCH_RESULT_ATTACHMENTS - detailsMatchResultAttachments.length);
    if (available <= 0) {
      setGameDetailsMetaError(`Можно прикрепить не более ${MAX_MATCH_RESULT_ATTACHMENTS} фото`);
      return;
    }

    const imageFiles = Array.from(files)
      .filter((file) => /^image\//i.test(file.type))
      .slice(0, available);

    if (imageFiles.length === 0) {
      setGameDetailsMetaError("Выберите фотографию в формате изображения");
      return;
    }

    setDetailsMatchResultAttachmentsLoading(true);
    setGameDetailsMetaError(null);
    try {
      const prepared = await Promise.all(
        imageFiles.map(async (file): Promise<MatchResultAttachment | null> => {
          try {
            const rawDataUrl = await readFileAsDataUrl(file);
            const optimizedDataUrl = await optimizeImageDataUrl(rawDataUrl, file.type);
            return {
              id: generatePaymentRef(),
              name: file.name || `photo-${Date.now()}`,
              type: file.type || "image/jpeg",
              size: Number.isFinite(file.size) ? file.size : null,
              dataUrl: optimizedDataUrl,
              createdAt: new Date().toISOString(),
              source,
            };
          } catch {
            return null;
          }
        }),
      );

      const nextItems = prepared.filter((item): item is MatchResultAttachment => item !== null);
      if (nextItems.length === 0) {
        setGameDetailsMetaError("Не удалось загрузить фото");
        return;
      }

      const previousAttachments = [...detailsMatchResultAttachments];
      const nextAttachments = [...previousAttachments, ...nextItems].slice(0, MAX_MATCH_RESULT_ATTACHMENTS);
      setDetailsMatchResultAttachments(nextAttachments);
      const saved = await persistMatchResultAttachments(nextAttachments, "Не удалось сохранить фото матча");
      if (!saved) {
        setDetailsMatchResultAttachments(previousAttachments);
      }

      if (files.length > imageFiles.length) {
        setGameDetailsMetaError(
          `Добавлено ${nextItems.length} фото. Лимит: ${MAX_MATCH_RESULT_ATTACHMENTS}`,
        );
      }
    } catch {
      setGameDetailsMetaError("Не удалось обработать фото");
    } finally {
      setDetailsMatchResultAttachmentsLoading(false);
    }
  }, [
    isCurrentUserConfirmedParticipant,
    isMatchResultAgreed,
    isMatchResultPendingReview,
    updatingGameMeta,
    detailsMatchResultAttachments,
    persistMatchResultAttachments,
  ]);

  const handleRemoveMatchResultAttachment = useCallback(async (attachmentId: string) => {
    if (!attachmentId.trim()) return;
    if (updatingGameMeta) return;
    const previousAttachments = [...detailsMatchResultAttachments];
    const nextAttachments = previousAttachments.filter((item) => item.id !== attachmentId);
    setDetailsMatchResultAttachments(nextAttachments);
    const saved = await persistMatchResultAttachments(nextAttachments, "Не удалось удалить фото матча");
    if (!saved) {
      setDetailsMatchResultAttachments(previousAttachments);
    }
  }, [updatingGameMeta, detailsMatchResultAttachments, persistMatchResultAttachments]);

  const handleShareMatchResultPhoto = useCallback(async () => {
    const primaryAttachment = detailsMatchResultAttachments[0] ?? null;
    if (!primaryAttachment?.dataUrl) {
      setGameDetailsMetaError("Добавьте фото матча, чтобы поделиться результатом");
      return;
    }

    setSharingMatchResultPhoto(true);
    setGameDetailsMetaError(null);

    try {
      const logoVariant = detailsMatchResultPhotoLogoVariants[primaryAttachment.id] ?? "white";
      const blob = await createMatchResultPhotoBlob({
        photoSrc: primaryAttachment.dataUrl,
        logoSrc: logoVariant === "black" ? logoHabBlack : logoHabWhite,
        logoVariant,
        scoreText: formatMatchResultPhotoScore(detailsMatchResultSets),
      });
      if (!blob) {
        throw new Error("match_result_blob_failed");
      }

      const fileName = `padlhub-match-result-${detailsDateKey || Date.now()}.png`;
      const shareFile = typeof File !== "undefined"
        ? new File([blob], fileName, {
          type: "image/png",
          lastModified: Date.now(),
        })
        : null;

      if (
        shareFile
        && typeof navigator !== "undefined"
        && typeof navigator.share === "function"
      ) {
        const shareData: ShareData = {
          files: [shareFile],
          title: "Результат матча",
        };

        if (typeof navigator.canShare !== "function" || navigator.canShare(shareData)) {
          await navigator.share(shareData);
          return;
        }
      }

      downloadBlob(blob, fileName);
    } catch (error) {
      const errorName = error instanceof DOMException ? error.name : "";
      if (errorName === "AbortError") return;
      setGameDetailsMetaError("Не удалось подготовить картинку результата");
    } finally {
      setSharingMatchResultPhoto(false);
    }
  }, [
    detailsDateKey,
    detailsMatchResultAttachments,
    detailsMatchResultPhotoLogoVariants,
    detailsMatchResultSets,
    setGameDetailsMetaError,
  ]);

  const syncMatchResultToViva = useCallback(async (
    ratingImpact: MatchResultRatingImpactEntry[],
    baseMetadata: Record<string, unknown>,
    options?: {
      liveRatingsWarning?: string | null;
      persistErrorMessage?: string;
    },
  ) => {
    const baseMatchResult = isRecordObject(baseMetadata.matchResult)
      ? baseMetadata.matchResult
      : {};
    const previousSync = normalizeMatchResultVivaSync(
      baseMatchResult.vivaSync
      ?? baseMatchResult.viva_sync
      ?? null,
    );
    const attemptAt = new Date().toISOString();
    const attemptNumber = Math.max(0, previousSync?.attempts ?? 0) + 1;

    const buildSyncMetadata = (
      status: MatchResultVivaSyncStatus,
      syncedPlayers: number,
      totalPlayers: number,
      failures: MatchResultVivaSyncFailure[],
      lastError: string | null,
    ): MatchResultVivaSyncState => ({
      status,
      attempts: attemptNumber,
      lastAttemptAt: attemptAt,
      lastSuccessAt: status === "SUCCESS"
        ? attemptAt
        : previousSync?.lastSuccessAt ?? null,
      lastError,
      totalPlayers,
      syncedPlayers,
      failures,
    });

    const persistSyncState = async (
      syncState: MatchResultVivaSyncState,
      persistFallbackMessage: string,
    ) => {
      const nextMetadata: Record<string, unknown> = {
        ...baseMetadata,
        matchResult: {
          ...baseMatchResult,
          vivaSync: syncState,
        },
      };

      return saveDetailsMetadata(nextMetadata, persistFallbackMessage);
    };

    if (ratingImpact.length === 0) {
      const syncState = buildSyncMetadata(
        "FAILED",
        0,
        0,
        [],
        "Нет данных результата для отправки в Viva",
      );
      const saved = await persistSyncState(
        syncState,
        options?.persistErrorMessage || "Не удалось сохранить статус отправки результата в Viva",
      );
      return {
        syncState,
        saved,
        uiMessage: saved
          ? "Не удалось определить игроков для отправки результата в Viva"
          : "Не удалось определить игроков для Viva, и статус попытки не сохранился",
      };
    }

    const clientIdByPhone = new Map<string, string>();
    const upsertClientId = (player: PadelGamePlayer | null | undefined) => {
      if (!player) return;
      const normalizedPhone = normalizePhoneForGame(player.phone);
      const normalizedClientId = (player.id || "").trim();
      if (!normalizedPhone || !normalizedClientId) return;
      clientIdByPhone.set(normalizedPhone, normalizedClientId);
    };
    detailsParticipants.forEach((player) => upsertClientId(player));
    detailsWaitlist.forEach((player) => upsertClientId(player));
    detailsTeamSlots.forEach((player) => upsertClientId(player));
    if (profilePhoneNorm && profileId) {
      clientIdByPhone.set(profilePhoneNorm, profileId);
    }

    const failures: MatchResultVivaSyncFailure[] = [];
    const vivaUpdateMap = new Map<string, {
      clientId: string;
      phone: string | null;
      name: string | null;
      levelLetter: string;
      levelNumeric: number;
    }>();

    ratingImpact.forEach((item) => {
      const normalizedPhone = normalizePhoneForGame(item.phoneNorm);
      const directClientId = (item.id || "").trim();
      const clientId = directClientId || (normalizedPhone ? (clientIdByPhone.get(normalizedPhone) || "") : "");

      if (!clientId) {
        failures.push({
          id: item.id ?? null,
          phone: normalizedPhone,
          name: item.name || null,
          reason: "Не найден clientId для отправки в Viva",
        });
        return;
      }

      const levelLetter = item.gradeAfter || mapNumericToRatingGrade(item.after) || "";
      const levelNumeric = roundToPrecision(item.after, MATCH_RESULT_RATING_DEFAULT_PARAMS.round);
      const key = `${clientId}|${normalizedPhone || ""}`;
      vivaUpdateMap.set(key, {
        clientId,
        phone: normalizedPhone,
        name: item.name || null,
        levelLetter,
        levelNumeric,
      });
    });

    const vivaUpdates = Array.from(vivaUpdateMap.values());
    if (vivaUpdates.length > 0) {
      const settled = await Promise.allSettled(
        vivaUpdates.map((entry) => apiSaveOnboardingLevel(entry)),
      );

      settled.forEach((result, index) => {
        const entry = vivaUpdates[index];
        if (!entry) return;

        if (result.status === "rejected") {
          failures.push({
            id: entry.clientId,
            phone: entry.phone,
            name: entry.name,
            reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
          return;
        }

        if (result.value.error || result.value.data?.ok === false) {
          failures.push({
            id: entry.clientId,
            phone: entry.phone,
            name: entry.name,
            reason: result.value.error?.message || "Viva вернула неуспешный ответ",
          });
        }
      });
    }

    const totalPlayers = ratingImpact.length;
    const syncedPlayers = Math.max(0, totalPlayers - failures.length);
    const failedNames = Array.from(new Set(
      failures
        .map((item) => item.name?.trim() || item.phone || null)
        .filter((item): item is string => Boolean(item)),
    ));
    const failedNamesSuffix = failedNames.length > 0
      ? `: ${failedNames.slice(0, 2).join(", ")}${failedNames.length > 2 ? ` и ещё ${failedNames.length - 2}` : ""}`
      : "";
    const lastError = failures.length === 0
      ? null
      : syncedPlayers > 0
        ? `Viva обновлена не для всех игроков (${syncedPlayers}/${totalPlayers})${failedNamesSuffix}`
        : `Не удалось обновить Viva для игроков${failedNamesSuffix}`;
    const syncState = buildSyncMetadata(
      failures.length === 0
        ? "SUCCESS"
        : syncedPlayers > 0
          ? "PARTIAL_SUCCESS"
          : "FAILED",
      syncedPlayers,
      totalPlayers,
      failures,
      lastError,
    );
    const saved = await persistSyncState(
      syncState,
      options?.persistErrorMessage || "Не удалось сохранить статус отправки результата в Viva",
    );

    let uiMessage = lastError;
    if (!uiMessage && options?.liveRatingsWarning) {
      uiMessage = options.liveRatingsWarning;
    } else if (uiMessage && options?.liveRatingsWarning) {
      uiMessage = `${uiMessage}. ${options.liveRatingsWarning}`;
    }

    if (!saved) {
      uiMessage = uiMessage
        ? `${uiMessage}. Статус попытки не сохранён`
        : "Не удалось сохранить статус отправки результата в Viva";
    }

    return {
      syncState,
      saved,
      uiMessage,
    };
  }, [
    detailsParticipants,
    detailsTeamSlots,
    detailsWaitlist,
    profileId,
    profilePhoneNorm,
    saveDetailsMetadata,
  ]);

  const handleSubmitMatchResult = useCallback(async () => {
    if (!canSubmitMatchResult) return;
    const completedSets = detailsCompletedMatchResultSets
      .map((setItem) => ({
        left: Number.parseInt(setItem.left, 10),
        right: Number.parseInt(setItem.right, 10),
      }))
      .filter((setItem) => Number.isFinite(setItem.left) && Number.isFinite(setItem.right));

    if (completedSets.length === 0) {
      setGameDetailsMetaError("Введите хотя бы один завершенный сет");
      return;
    }

    const setPairings = buildMatchResultSetPairingsPayload(detailsMatchResultSetPairings);
    const submittedAt = new Date().toISOString();
    const disputeDeadlineAt = getMatchResultDisputeDeadlineAt(submittedAt);
    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      matchResult: {
        sets: completedSets,
        ...(setPairings.length > 0 ? { setPairings } : {}),
        photos: detailsMatchResultAttachments,
        status: "PENDING_DISPUTE",
        vivaSync: null,
        submittedAt,
        disputeDeadlineAt,
        submittedBy: {
          id: profileId ?? null,
          phone: normalizePhoneForGame(profilePhone),
          name: profileName || null,
        },
      },
    };

    const saved = await saveDetailsMetadata(nextMetadata, "Не удалось отправить результат на согласование");
    if (!saved) return;

    setDetailsMatchResultStatus("PENDING_DISPUTE");
    setDetailsMatchResultSubmittedAt(submittedAt);
    setDetailsMatchResultDisputeDeadlineAt(disputeDeadlineAt);
    setDetailsMatchResultSubmittedBy({
      id: profileId ?? null,
      phone: normalizePhoneForGame(profilePhone),
      name: profileName || null,
    });
    setDetailsMatchResultConfirmedBy(null);
    setDetailsMatchResultConfirmedAt(null);
    setDetailsMatchResultRatingImpact([]);
    setDetailsMatchResultDisputedBy(null);
    setDetailsMatchResultDisputedAt(null);
  }, [
    canSubmitMatchResult,
    detailsCompletedMatchResultSets,
    detailsMatchResultAttachments,
    detailsMatchResultSetPairings,
    detailsMetadata,
    profileId,
    profileName,
    profilePhone,
    saveDetailsMetadata,
  ]);

  const finalizeMatchResultAgreement = useCallback(async (options?: {
    confirmedAt?: string | null;
    confirmedBy?: {
      id: string | null;
      phone: string | null;
      name: string | null;
    } | null;
    autoConfirmed?: boolean;
    persistErrorMessage?: string;
  }) => {
    const completedSets = detailsCompletedMatchResultSets
      .map((setItem) => ({
        left: Number.parseInt(setItem.left, 10),
        right: Number.parseInt(setItem.right, 10),
      }))
      .filter((setItem) => Number.isFinite(setItem.left) && Number.isFinite(setItem.right));

    if (completedSets.length === 0) {
      setGameDetailsMetaError("Нет заполненных сетов для согласования");
      return false;
    }

    const scoreA = completedSets.reduce((total, setItem) => total + setItem.left, 0);
    const scoreB = completedSets.reduce((total, setItem) => total + setItem.right, 0);
    const setPairings = buildMatchResultSetPairingsPayload(detailsMatchResultSetPairings);
    const hydratePlayerForRating = (player: PadelGamePlayer | null | undefined): PadelGamePlayer | null => {
      if (!player) return null;
      if (!matchesCurrentUserByIdentity(player.id, player.phone)) return player;
      const normalizedNumeric = normalizeRatingNumeric(profileRatingNumeric ?? player.ratingNumeric);
      return {
        ...player,
        ratingNumeric: normalizedNumeric,
        rating:
          profileGrade
          ?? player.rating
          ?? (normalizedNumeric != null ? mapNumericToRatingGrade(normalizedNumeric) : null),
      };
    };
    const teamAPlayersBase = dedupePlayersByIdentity(
      detailsTeamSlots.slice(0, 2).map((player) => hydratePlayerForRating(player)),
    );
    const teamBPlayersBase = dedupePlayersByIdentity(
      detailsTeamSlots.slice(2, 4).map((player) => hydratePlayerForRating(player)),
    );

    const allPlayersForLive = dedupePlayersByIdentity([...teamAPlayersBase, ...teamBPlayersBase]);
    const liveRatingsResult = await apiFetchPadelLiveRatings(
      allPlayersForLive.map((player) => ({
        clientId: (player.id || "").trim() || null,
        phone: normalizePhoneForGame(player.phone),
        name: player.name || null,
        rating: player.rating ?? null,
        ratingNumeric: normalizeRatingNumeric(player.ratingNumeric),
      })),
    );

    const liveByClientId = new Map<string, { rating: string | null; ratingNumeric: number | null }>();
    const liveByPhone = new Map<string, { rating: string | null; ratingNumeric: number | null }>();
    (liveRatingsResult.data ?? []).forEach((item) => {
      const clientId = (item.clientId || "").trim();
      const phoneNorm = normalizePhoneForGame(item.phoneNorm);
      const ratingNumeric = normalizeRatingNumeric(item.ratingNumeric);
      const rating = item.rating || (ratingNumeric != null ? mapNumericToRatingGrade(ratingNumeric) : null);
      const value = { rating, ratingNumeric };
      if (clientId) liveByClientId.set(clientId, value);
      if (phoneNorm) liveByPhone.set(phoneNorm, value);
    });

    const hydrateLiveRating = (player: PadelGamePlayer): PadelGamePlayer => {
      const clientId = (player.id || "").trim();
      const phoneNorm = normalizePhoneForGame(player.phone);
      const fromClient = clientId ? liveByClientId.get(clientId) : undefined;
      const fromPhone = phoneNorm ? liveByPhone.get(phoneNorm) : undefined;
      const resolved = fromClient ?? fromPhone;
      if (!resolved) return player;
      return {
        ...player,
        ratingNumeric: resolved.ratingNumeric ?? player.ratingNumeric ?? null,
        rating: resolved.rating ?? player.rating ?? null,
      };
    };

    const teamAPlayers = teamAPlayersBase.map((player) => hydrateLiveRating(player));
    const teamBPlayers = teamBPlayersBase.map((player) => hydrateLiveRating(player));

    const ratingImpact = buildMatchResultRatingImpact(
      teamAPlayers,
      teamBPlayers,
      scoreA,
      scoreB,
      detailsMetadata.matchResult,
    );

    const confirmedAt = options?.confirmedAt?.trim()
      || detailsMatchResultDisputeDeadlineAt
      || new Date().toISOString();
    const confirmedBy = options?.confirmedBy ?? null;
    const disputeDeadlineAt = detailsMatchResultDisputeDeadlineAt
      || getMatchResultDisputeDeadlineAt(detailsMatchResultSubmittedAt);
    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      matchResult: {
        sets: completedSets,
        ...(setPairings.length > 0 ? { setPairings } : {}),
        photos: detailsMatchResultAttachments,
        status: "CONFIRMED",
        vivaSync: null,
        submittedAt: detailsMatchResultSubmittedAt,
        disputeDeadlineAt,
        submittedBy: detailsMatchResultSubmittedBy,
        confirmedAt,
        ratingImpact,
        confirmedBy,
        autoConfirmed: options?.autoConfirmed === true,
        confirmedReason: options?.autoConfirmed === true ? "DISPUTE_TIMEOUT" : "MANUAL",
        disputedBy: null,
        disputedAt: null,
      },
    };

    const saved = await saveDetailsMetadata(
      nextMetadata,
      options?.persistErrorMessage || "Не удалось согласовать результат",
    );
    if (!saved) return false;

    setDetailsMatchResultStatus("CONFIRMED");
    setDetailsMatchResultDisputeDeadlineAt(disputeDeadlineAt);
    setDetailsMatchResultConfirmedAt(confirmedAt);
    setDetailsMatchResultConfirmedBy(confirmedBy);
    setDetailsMatchResultRatingImpact(ratingImpact);
    setDetailsMatchResultDisputedBy(null);
    setDetailsMatchResultDisputedAt(null);
    const vivaSyncResult = await syncMatchResultToViva(ratingImpact, nextMetadata, {
      liveRatingsWarning: liveRatingsResult.error
        ? "Актуальные рейтинги Viva перед расчетом получить не удалось, использованы значения из игры"
        : null,
    });
    if (vivaSyncResult.uiMessage) {
      setGameDetailsMetaError(vivaSyncResult.uiMessage);
    }
    return true;
  }, [
    detailsCompletedMatchResultSets,
    detailsMatchResultSetPairings,
    detailsTeamSlots,
    detailsMatchResultAttachments,
    detailsMatchResultDisputeDeadlineAt,
    detailsMatchResultSubmittedAt,
    detailsMatchResultSubmittedBy,
    detailsMetadata,
    matchesCurrentUserByIdentity,
    profileGrade,
    profileRatingNumeric,
    saveDetailsMetadata,
    setGameDetailsMetaError,
    syncMatchResultToViva,
  ]);

  useEffect(() => {
    if (!gameRecordId) return;
    if (!isMatchResultPendingReview) return;
    if (detailsMatchResultDisputeTimeLeftMs == null || detailsMatchResultDisputeTimeLeftMs > 0) return;
    if (updatingGameMeta) return;

    const autoConfirmKey = `${gameRecordId}:${detailsMatchResultSubmittedAt || detailsMatchResultDisputeDeadlineAt || "pending"}`;
    if (autoConfirmingMatchResultRef.current === autoConfirmKey) return;
    autoConfirmingMatchResultRef.current = autoConfirmKey;

    void finalizeMatchResultAgreement({
      confirmedAt: detailsMatchResultDisputeDeadlineAt,
      confirmedBy: null,
      autoConfirmed: true,
      persistErrorMessage: "Не удалось автоматически согласовать результат",
    }).then((saved) => {
      if (!saved) {
        autoConfirmingMatchResultRef.current = null;
      }
    }).catch(() => {
      autoConfirmingMatchResultRef.current = null;
      setGameDetailsMetaError("Не удалось автоматически согласовать результат");
    });
  }, [
    detailsMatchResultDisputeDeadlineAt,
    detailsMatchResultDisputeTimeLeftMs,
    detailsMatchResultSubmittedAt,
    finalizeMatchResultAgreement,
    gameRecordId,
    isMatchResultPendingReview,
    setGameDetailsMetaError,
    updatingGameMeta,
  ]);

  const handleRetryMatchResultVivaSync = useCallback(async () => {
    if (retryingMatchResultVivaSync || updatingGameMeta) return;
    if (!isMatchResultAgreed) return;

    const ratingImpact = detailsMatchResultRatingImpact.length > 0
      ? detailsMatchResultRatingImpact
      : normalizeMatchResultRatingImpact(
        isRecordObject(detailsMetadata.matchResult)
          ? detailsMetadata.matchResult.ratingImpact
          : null,
      );

    setRetryingMatchResultVivaSync(true);
    setGameDetailsMetaError(null);
    try {
      const vivaSyncResult = await syncMatchResultToViva(ratingImpact, detailsMetadata);
      if (vivaSyncResult.uiMessage) {
        setGameDetailsMetaError(vivaSyncResult.uiMessage);
      }
    } finally {
      setRetryingMatchResultVivaSync(false);
    }
  }, [
    detailsMatchResultRatingImpact,
    detailsMetadata,
    isMatchResultAgreed,
    retryingMatchResultVivaSync,
    setGameDetailsMetaError,
    syncMatchResultToViva,
    updatingGameMeta,
  ]);

  const handleDisputeMatchResult = useCallback(async () => {
    if (!canDisputeMatchResult) return;

    const completedSets = detailsCompletedMatchResultSets
      .map((setItem) => ({
        left: Number.parseInt(setItem.left, 10),
        right: Number.parseInt(setItem.right, 10),
      }))
      .filter((setItem) => Number.isFinite(setItem.left) && Number.isFinite(setItem.right));

    if (completedSets.length === 0) {
      setGameDetailsMetaError("Нет заполненных сетов для оспаривания");
      return;
    }

    const setPairings = buildMatchResultSetPairingsPayload(detailsMatchResultSetPairings);
    const disputedAt = new Date().toISOString();
    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      matchResult: {
        sets: completedSets,
        ...(setPairings.length > 0 ? { setPairings } : {}),
        photos: detailsMatchResultAttachments,
        status: "DISPUTED",
        vivaSync: null,
        submittedAt: detailsMatchResultSubmittedAt,
        disputeDeadlineAt: detailsMatchResultDisputeDeadlineAt,
        submittedBy: detailsMatchResultSubmittedBy,
        disputedAt,
        disputedBy: {
          id: profileId ?? null,
          phone: normalizePhoneForGame(profilePhone),
          name: profileName || null,
        },
      },
    };

    const saved = await saveDetailsMetadata(nextMetadata, "Не удалось оспорить результат");
    if (!saved) return;

    setDetailsMatchResultStatus("DISPUTED");
    setDetailsMatchResultDisputeDeadlineAt(detailsMatchResultDisputeDeadlineAt);
    setDetailsMatchResultDisputedAt(disputedAt);
    setDetailsMatchResultDisputedBy({
      id: profileId ?? null,
      phone: normalizePhoneForGame(profilePhone),
      name: profileName || null,
    });
    setDetailsMatchResultConfirmedBy(null);
    setDetailsMatchResultConfirmedAt(null);
    setDetailsMatchResultRatingImpact([]);
  }, [
    canDisputeMatchResult,
    detailsCompletedMatchResultSets,
    detailsMatchResultAttachments,
    detailsMatchResultSetPairings,
    detailsMatchResultDisputeDeadlineAt,
    detailsMatchResultSubmittedAt,
    detailsMatchResultSubmittedBy,
    detailsMetadata,
    profileId,
    profileName,
    profilePhone,
    saveDetailsMetadata,
  ]);

  const handleRemoveParticipantFromDetails = useCallback((player: PadelGamePlayer, index: number) => {
    if (!canManagePlayersInDetails || updatingGameRoster) return;
    if (isDetailsOrganizerPlayer(player)) {
      setGameRosterError("Организатора нельзя удалить из игры");
      return;
    }

    const nextParticipants = detailsParticipants.filter((_, playerIndex) => playerIndex !== index);
    void patchGameRoster(nextParticipants, detailsWaitlist);
  }, [
    canManagePlayersInDetails,
    updatingGameRoster,
    isDetailsOrganizerPlayer,
    detailsParticipants,
    detailsWaitlist,
    patchGameRoster,
  ]);

  const handleReturnOrganizerToMatchFromDetails = useCallback(async () => {
    if (!canManagePlayersInDetails || updatingGameRoster) return;
    if (!detailsOrganizerPlayer || detailsOrganizerInMatch) return;
    if (!detailsHasFreeSlots) {
      setGameRosterError("Сначала освободите место в составе, чтобы вернуть организатора в матч");
      return;
    }

    const organizerPlayerForSlot: PadelGamePlayer = {
      ...detailsOrganizerPlayer,
      source: "ORGANIZER",
      status: "CONFIRMED",
    };
    const organizerKey = getPadelPlayerIdentityKey(organizerPlayerForSlot);
    const nextParticipants = dedupePlayersByIdentity([
      organizerPlayerForSlot,
      ...detailsParticipants.filter((player) => {
        if (!organizerKey) return !isDetailsOrganizerPlayer(player);
        return getPadelPlayerIdentityKey(player) !== organizerKey;
      }),
    ]);
    const nextWaitlist = detailsWaitlist.filter((player) => {
      if (!organizerKey) return !isDetailsOrganizerPlayer(player);
      return getPadelPlayerIdentityKey(player) !== organizerKey;
    });
    const previousSlots = [...detailsTeamSlots];
    const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const nextSlots = [...detailsTeamSlots];
    nextSlots[0] = organizerPlayerForSlot;
    const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots);

    setDetailsTeamSlots(nextSlots);
    setDetailsMatchResultSetPairings(nextSetPairings);
    setDetailsTeamMenuSlotIndex(null);
    const nextMetadata = buildDetailsRosterMetadata(nextParticipants, nextWaitlist, {
      organizerInMatch: true,
      teamSlots: nextSlots,
      setPairings: nextSetPairings,
    });
    const saved = await patchGameRoster(nextParticipants, nextWaitlist, {
      metadata: nextMetadata,
      fallbackErrorMessage: "Не удалось вернуть организатора в состав",
    });
    if (!saved) {
      setDetailsTeamSlots(previousSlots);
      setDetailsMatchResultSetPairings(previousSetPairings);
    }
  }, [
    canManagePlayersInDetails,
    updatingGameRoster,
    detailsOrganizerPlayer,
    detailsOrganizerInMatch,
    detailsHasFreeSlots,
    detailsParticipants,
    detailsWaitlist,
    detailsTeamSlots,
    detailsMatchResultSetPairings,
    isDetailsOrganizerPlayer,
    buildNextSetPairingsForTeamSlots,
    buildDetailsRosterMetadata,
    patchGameRoster,
  ]);

  const handleMoveParticipantToWaitlistFromDetails = useCallback((player: PadelGamePlayer, index: number) => {
    if (!canManagePlayersInDetails || updatingGameRoster) return;
    if (!isDetailsWaitlistEnabled) {
      setGameRosterError("Лист ожидания закрыт для этой игры");
      return;
    }
    if (isDetailsOrganizerPlayer(player)) {
      setGameRosterError("Организатора нельзя переместить в лист ожидания");
      return;
    }

    const nextParticipants = detailsParticipants.filter((_, playerIndex) => playerIndex !== index);
    const nextWaitlist = dedupePlayersByIdentity([
      ...detailsWaitlist,
      {
        ...player,
        status: "WAITLIST" as const,
      },
    ]);
    void patchGameRoster(nextParticipants, nextWaitlist);
  }, [
    canManagePlayersInDetails,
    updatingGameRoster,
    isDetailsWaitlistEnabled,
    isDetailsOrganizerPlayer,
    detailsParticipants,
    detailsWaitlist,
    patchGameRoster,
  ]);

  const handleAddWaitlistPlayerToDetails = useCallback((player: PadelGamePlayer, index: number) => {
    if (!canManagePlayersInDetails || updatingGameRoster) return;
    if (!detailsHasFreeSlots) {
      setGameRosterError(`Все места заняты (${detailsMaxPlayers}/${detailsMaxPlayers})`);
      return;
    }

    const nextParticipants = [
      ...detailsParticipants,
      {
        ...player,
        status: "CONFIRMED" as const,
      },
    ];
    const nextWaitlist = detailsWaitlist.filter((_, waitlistIndex) => waitlistIndex !== index);
    void patchGameRoster(nextParticipants, nextWaitlist);
  }, [
    canManagePlayersInDetails,
    updatingGameRoster,
    detailsHasFreeSlots,
    detailsMaxPlayers,
    detailsParticipants,
    detailsWaitlist,
    patchGameRoster,
  ]);

  const handleLeaveCurrentUserFromDetails = useCallback(async () => {
    if (!canCurrentUserLeaveGameInDetails || !gameRecordId) return;

    const currentPlayer =
      detailsParticipants.find((player) => isCurrentUserPlayer(player))
      ?? detailsWaitlist.find((player) => isCurrentUserPlayer(player))
      ?? null;
    if (!currentPlayer) {
      setGameRosterError("Вы не состоите в этой игре");
      return;
    }
    if (isDetailsOrganizerPlayer(currentPlayer)) {
      setGameRosterError("Организатор не может покинуть игру");
      return;
    }

    if (typeof window !== "undefined") {
      const accepted = window.confirm("Покинуть игру? Вы потеряете место в составе.");
      if (!accepted) return;
    }

    const nextParticipants = detailsParticipants.filter((player) => !isCurrentUserPlayer(player));
    const nextWaitlist = detailsWaitlist.filter((player) => !isCurrentUserPlayer(player));
    const leftAt = new Date().toISOString();
    const nextLeaveEvents = [
      ...normalizeGameLeaveEvents(detailsMetadata.leaveEvents),
      {
        playerId: currentPlayer.id ?? null,
        playerPhone: normalizePhoneForGame(currentPlayer.phone),
        playerName: currentPlayer.name || profileName || "Игрок",
        leftAt,
        reason: "SELF",
        byId: profileId ?? currentPlayer.id ?? null,
        byPhone: profilePhoneNorm ?? normalizePhoneForGame(currentPlayer.phone),
        byName: profileName || currentPlayer.name || "Игрок",
      } satisfies GameLeaveEvent,
    ];

    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      leaveEvents: nextLeaveEvents,
      lastLeaveUpdateAt: leftAt,
      participantPhones: nextParticipants
        .map((player) => normalizePhoneForGame(player.phone))
        .filter((value): value is string => Boolean(value)),
      waitlistPhones: nextWaitlist
        .map((player) => normalizePhoneForGame(player.phone))
        .filter((value): value is string => Boolean(value)),
    };

    const leftPlayerKey = getPadelPlayerIdentityKey(currentPlayer);
    const updated = await patchGameRoster(nextParticipants, nextWaitlist, {
      metadata: nextMetadata,
      fallbackErrorMessage: "Не удалось покинуть игру",
    });
    if (!updated) return;

    if (leftPlayerKey) {
      setDetailsTeamSlots((prev) =>
        prev.map((slotPlayer) =>
          getPadelPlayerIdentityKey(slotPlayer) === leftPlayerKey ? null : slotPlayer,
        ),
      );
    }
    setDetailsTeamMenuSlotIndex(null);
  }, [
    canCurrentUserLeaveGameInDetails,
    gameRecordId,
    detailsParticipants,
    detailsWaitlist,
    isCurrentUserPlayer,
    isDetailsOrganizerPlayer,
    detailsMetadata,
    profileName,
    profileId,
    profilePhoneNorm,
    patchGameRoster,
  ]);

  const handleJoinCurrentUserFromDetails = useCallback(async () => {
    if (!canCurrentUserJoinGameInDetails || !gameRecordId) return;

    const normalizedProfileId = (profileId || "").trim() || null;
    const normalizedPhone = profilePhoneNorm ?? normalizePhoneForGame(profilePhone);
    if (!normalizedProfileId && !normalizedPhone) {
      setGameRosterError("Не удалось определить ваш профиль. Обновите страницу и попробуйте снова.");
      return;
    }

    if (!detailsHasFreeSlots && !isDetailsWaitlistEnabled) {
      setGameRosterError("Свободных мест нет, лист ожидания закрыт.");
      return;
    }

    const joinPlayerBase: PadelGamePlayer = {
      id: normalizedProfileId,
      name: profileName || "Игрок",
      phone: normalizedPhone,
      photo: profilePhoto ?? null,
      rating: profileGrade ?? null,
      ratingNumeric: profileRatingNumeric ?? null,
      source: "INVITE_LINK",
      status: detailsHasFreeSlots ? "CONFIRMED" : "WAITLIST",
    };

    const nextParticipants = dedupePlayersByIdentity([
      ...detailsParticipants.filter((player) => !isCurrentUserPlayer(player)),
      ...(detailsHasFreeSlots
        ? [{ ...joinPlayerBase, status: "CONFIRMED" as const }]
        : []),
    ]);
    const nextWaitlist = dedupePlayersByIdentity([
      ...detailsWaitlist.filter((player) => !isCurrentUserPlayer(player)),
      ...(!detailsHasFreeSlots
        ? [{ ...joinPlayerBase, status: "WAITLIST" as const }]
        : []),
    ]);
    const nextMetadata = buildDetailsRosterMetadata(nextParticipants, nextWaitlist);

    await patchGameRoster(nextParticipants, nextWaitlist, {
      metadata: nextMetadata,
      fallbackErrorMessage: detailsHasFreeSlots
        ? "Не удалось присоединиться к игре"
        : "Не удалось добавиться в лист ожидания",
    });
  }, [
    canCurrentUserJoinGameInDetails,
    gameRecordId,
    profileId,
    profilePhoneNorm,
    profilePhone,
    detailsHasFreeSlots,
    isDetailsWaitlistEnabled,
    profileName,
    profilePhoto,
    profileGrade,
    profileRatingNumeric,
    detailsParticipants,
    detailsWaitlist,
    isCurrentUserPlayer,
    buildDetailsRosterMetadata,
    patchGameRoster,
  ]);

  const handleOpenCabinetFromDetails = useCallback(() => {
    const fallbackCabinetUrl = (CABINET_URL || "").trim();
    if (typeof window !== "undefined") {
      try {
        const currentUrl = new URL(window.location.href);
        const fromQuery = (
          currentUrl.searchParams.get("cabinetUrl")
          || currentUrl.searchParams.get("returnUrl")
          || ""
        ).trim();
        if (fromQuery) {
          window.location.href = new URL(fromQuery, currentUrl.origin).toString();
          return;
        }
      } catch {
        // fallback below
      }
      if (fallbackCabinetUrl) {
        window.location.href = fallbackCabinetUrl;
        return;
      }
    }
    onBack();
  }, [onBack]);

  if (step === "place") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Выберите место</div>
        </div>

        <div className="game-search">
          <input
            className="game-input"
            placeholder="Найти станцию"
            value={studiosQuery}
            onChange={(e) => setStudiosQuery(e.target.value)}
          />
        </div>

        <div className="game-stack">
          <button
            className="game-card"
            onClick={() => setMapOpen((prev) => !prev)}
            type="button"
          >
            <div className="game-card-row">
              <div>
                <div className="game-card-title">Найти на карте</div>
                <div className="game-card-sub">Клубы рядом с вами</div>
              </div>
              <span className="game-card-arrow">›</span>
            </div>
          </button>
          {mapOpen && (
            <div className="game-map">
              <div ref={mapHostRef} className="game-map-canvas"></div>
              <button
                className="game-map-locate"
                onClick={requestUserLocation}
                type="button"
                disabled={locatingUser}
              >
                {locatingUser ? "Ищем вас..." : "Мое местоположение"}
              </button>
              {mapLoading && <div className="game-map-overlay">Загружаем карту...</div>}
              {!mapLoading && mapError && <div className="game-map-overlay">{mapError}</div>}
              {!mapLoading && !mapError && mapStudios.length === 0 && !userLocation && (
                <div className="game-map-overlay">Координаты станций не найдены</div>
              )}
              {geocodeLoading && !mapError && (
                <div className="game-map-hint">Уточняем координаты...</div>
              )}
              {userLocationError && !mapError && (
                <div className="game-map-hint game-map-hint-error">{userLocationError}</div>
              )}
            </div>
          )}
        </div>

        <div className="game-section">
          <div className="game-section-title">
            {studiosQuery.trim() ? "Результаты поиска" : "Станции по городам"}
          </div>
          {loadingStudios && <div className="game-empty">Загрузка...</div>}
          {!loadingStudios && studiosError && <div className="game-empty">{studiosError}</div>}
          {!loadingStudios && !studiosError && studiosByCity.length === 0 && (
            <div className="game-empty">Ничего не найдено</div>
          )}
          {!loadingStudios &&
            !studiosError &&
            studiosByCity.map(([city, cityStudios]) => (
              <div key={city} className="game-city-group">
                <div className="game-city-title">{city}</div>
                <div className="game-city-cards">
                  {cityStudios.map((s) => (
                    <button
                      key={s.id}
                      className={`game-card ${studio?.id === s.id ? "selected" : ""}`}
                      onClick={() => {
                        setStudio(s);
                        setStep("time");
                      }}
                      type="button"
                    >
                      <div className="game-card-title">{s.name}</div>
                      {s.address && <div className="game-card-sub">{s.address}</div>}
                      <div className="game-card-sub">
                        {typeof s.panoramicCourtsCount === "number"
                          ? formatCourtsLabel(s.panoramicCourtsCount)
                          : "Панорамик: —"}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </div>
    );
  }

  if (step === "time") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Дата и время</div>
        </div>

        {studio && (loadingStudioGameModes || supportsSinglesMode) && (
          <div className="game-section">
            <div className="game-section-title">Формат игры</div>
            <div className="duration-row">
              <button
                className={`duration-chip ${resolvedGameFormat === "doubles" ? "active" : ""}`}
                onClick={() => setGameFormat("doubles")}
                type="button"
                disabled={loadingStudioGameModes || !supportsDoublesMode}
              >
                Игра 2 на 2
              </button>
              <button
                className={`duration-chip ${resolvedGameFormat === "singles" ? "active" : ""}`}
                onClick={() => setGameFormat("singles")}
                type="button"
                disabled={loadingStudioGameModes || !supportsSinglesMode}
              >
                Игра 1 на 1
              </button>
            </div>
          </div>
        )}

        <div className="game-section">
          <div className="game-section-title">Продолжительность</div>
          <div className="duration-row">
            {[60, 90, 120].map((d) => (
              <button
                key={d}
                className={`duration-chip ${duration === d ? "active" : ""}`}
                onClick={() => setDuration(d)}
                type="button"
              >
                {d} мин
              </button>
            ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Дата и время начала игры</div>
          <div className="date-row" ref={timeDateRowRef}>
            {dates.map((d, i) => {
              const monthLabel = d
                .toLocaleDateString("ru-RU", { month: "short" })
                .replace(".", "")
                .trim()
                .slice(0, 3)
                .toUpperCase();
              const weekdayLabel = d
                .toLocaleDateString("ru-RU", { weekday: "short" })
                .replace(".", "")
                .toUpperCase();
              const dayLabel = d.toLocaleDateString("ru-RU", { day: "2-digit" });

              return (
                <div key={d.toISOString()} className="date-item">
                  <div className="date-weekday">{weekdayLabel}</div>
                  <button
                    className={`date-chip ${dateIndex === i ? "active" : ""}`}
                    data-date-index={i}
                    onClick={() => {
                      setDateIndex(i);
                      setTime(null);
                    }}
                    type="button"
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
          <div className="time-grid">
            {loadingTimeslots && <div className="game-empty">Загрузка времени...</div>}
            {!loadingTimeslots && timeslotsError && (
              <div className="game-empty">{timeslotsError}</div>
            )}
            {noFormatSlots && (
              <div className="game-empty">
                {`На выбранную дату нет свободных слотов для игры ${selectedGameFormatLabel}`}
              </div>
            )}
            {noDurationSlots && (
              <div className="game-empty">Для выбранной продолжительности нет свободных слотов</div>
            )}
            {noTimeSlotsForSelection && (
              <div className="game-empty">Нет доступного времени для выбранного корта</div>
            )}
            {!loadingTimeslots &&
              availableTimeSlots.map((slot) => (
                <button
                  key={slot}
                  className={`time-chip ${time === slot ? "active" : ""}`}
                  onClick={() => setTime(slot)}
                  type="button"
                >
                  {slot}
                </button>
              ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Корты</div>
          <div className="game-stack">
            {loadingTimeslots && <div className="game-empty">Загрузка кортов...</div>}
            {!loadingTimeslots && timeslotsError && (
              <div className="game-empty">{timeslotsError}</div>
            )}
            {noFormatSlots && (
              <div className="game-empty">
                {resolvedGameFormat === "singles"
                  ? "Сингл-корты недоступны на выбранную дату"
                  : "Корты 2 на 2 недоступны на выбранную дату"}
              </div>
            )}
            {noDurationSlots && (
              <div className="game-empty">Для выбранной продолжительности корты недоступны</div>
            )}
            {noCourtsForSelection && (
              <div className="game-empty">Нет доступных кортов для выбранного времени</div>
            )}
            {!loadingTimeslots &&
              availableCourts.map((court) => (
                <button
                  key={court.id}
                  className={`game-card ${courtId === court.id ? "selected" : ""}`}
                  onClick={() => {
                    setCourtId(court.id);
                  }}
                  type="button"
                >
                  <div className="game-card-title">{court.name}</div>
                </button>
              ))}
          </div>
        </div>

        <button
          className={`game-submit game-submit-booking ${canProceedToPayment ? "active" : ""}`}
          onClick={() => {
            if (!canProceedToPayment) return;
            setStep("create");
          }}
          type="button"
          disabled={!canProceedToPayment}
        >
          <span className="game-submit-main">{paymentContinueTitle}</span>
          <span className="game-submit-price">{paymentBookingAmount}</span>
          <span className="game-submit-meta">{paymentStationCourt}</span>
          <span className="game-submit-meta">{paymentTimeRange}</span>
        </button>
      </div>
    );
  }

  if (step === "chat") {
    const chatTitle = detailsGameTitle || detailsRoomName || "Чат игры";
    const chatSubtitle = [
      detailsStudioName || null,
      detailsDateKey || null,
      detailsTimeFrom && detailsTimeTo ? `${detailsTimeFrom} - ${detailsTimeTo}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const canSendChatMessage = Boolean(
      chatDraft.trim() && !chatSending && profilePhone && canCurrentUserSendChat,
    );
    const chatPlaceholder = !profilePhone
      ? "Нет телефона профиля"
      : canCurrentUserSendChat
        ? "Введите сообщение"
        : "В чат могут писать только участники игры";

    return (
      <div className="app-container game-container game-chat-container">
        <div className="page-header">
          <button
            className="page-back"
            onClick={() => setStep(gameRecordId ? "details" : "create")}
            type="button"
          >
            ← Назад
          </button>
          <div className="page-title">Чат игры</div>
        </div>

        <div className="game-section game-chat-meta">
          <div className="game-card-title">{chatTitle}</div>
          <div className="game-card-sub">{chatSubtitle || "Матч"}</div>
          {detailsGameParticipantComment && (
            <div className="game-card-sub">{detailsGameParticipantComment}</div>
          )}
        </div>

        <div className="game-section game-chat-section">
          {chatLoading && <div className="game-empty">Загрузка чата...</div>}
          {!chatLoading && chatMessages.length === 0 && (
            <div className="game-empty">Сообщений пока нет. Напишите первым.</div>
          )}
          {!chatLoading && (
            <div className="game-chat-list">
              {chatRenderItems.map((item) => {
                if (item.kind === "day") {
                  return (
                    <div key={item.key} className="game-chat-day-separator">
                      {item.label}
                    </div>
                  );
                }

                const message = item.message;
                const senderPhone = normalizePhoneForGame(message.sender?.phoneNorm ?? null);
                const myPhone = normalizePhoneForGame(profilePhone);
                const isMine = Boolean(senderPhone && myPhone && senderPhone === myPhone);
                const isUnread = !isMine && message.createdTs > currentChatReadTs;
                const senderName = (message.sender?.name || (isMine ? "Вы" : "Игрок")).trim() || "Игрок";
                const senderId = (message.sender?.id || "").trim();
                const senderNameKey = senderName.toLowerCase();
                const senderKey = getChatSenderStableKey(message);
                const senderColor = pickChatSenderColor(senderKey);
                const senderPhoto = (
                  (isMine && profilePhoto)
                  || (senderPhone ? chatSenderPhotoByIdentity.get(`phone:${senderPhone}`) : null)
                  || (senderId ? chatSenderPhotoByIdentity.get(`id:${senderId}`) : null)
                  || (senderNameKey ? chatSenderPhotoByIdentity.get(`name:${senderNameKey}`) : null)
                  || null
                );
                const senderInitials = getPlayerInitials(senderName) || "•";

                return (
                  <div key={item.key} className={`game-chat-row ${isMine ? "mine" : ""}`}>
                    {!isMine && (
                      <div className="game-chat-avatar-wrap">
                        <AvatarWithInitialsFallback
                          src={senderPhoto}
                          alt={senderName}
                          imageClassName="game-chat-avatar"
                          fallbackClassName="game-chat-avatar game-chat-avatar-fallback"
                          fallbackText={senderInitials}
                        />
                      </div>
                    )}

                    <div
                      className={`game-chat-message ${isMine ? "mine" : ""} ${isUnread ? "unread" : ""}`}
                      style={{ "--chat-user-bg": senderColor } as CSSProperties}
                    >
                      <div className="game-chat-author">{senderName}</div>
                      <div className="game-chat-text">{message.text}</div>
                      <div className="game-chat-time">
                        {isUnread && <span className="game-chat-unread-dot">●</span>}
                        {formatChatTime(message.createdAt, message.createdTs)}
                      </div>
                    </div>

                    {isMine && (
                      <div className="game-chat-avatar-wrap">
                        <AvatarWithInitialsFallback
                          src={senderPhoto}
                          alt={senderName}
                          imageClassName="game-chat-avatar"
                          fallbackClassName="game-chat-avatar game-chat-avatar-fallback"
                          fallbackText={senderInitials}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>
          )}
          {chatError && <div className="game-empty game-pay-error">{chatError}</div>}
          {chatRefreshing && !chatLoading && (
            <div className="game-chat-refresh">Обновляем сообщения...</div>
          )}
        </div>

        <div className="game-chat-input-row">
          <input
            className="game-input game-chat-input"
            placeholder={chatPlaceholder}
            value={chatDraft}
            onChange={(event) => setChatDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void handleSendChatMessage();
              }
            }}
            disabled={!profilePhone || !canCurrentUserSendChat || chatSending}
          />
          <button
            className="section-cta game-chat-send"
            type="button"
            onClick={() => {
              void handleSendChatMessage();
            }}
            disabled={!canSendChatMessage}
          >
            {chatSending ? "..." : "Отпр."}
          </button>
        </div>
        {!canCurrentUserSendChat && profilePhone && (
          <div className="game-chat-note">Чтобы писать в чат, нужно вступить в игру.</div>
        )}
      </div>
    );
  }

  if (step === "details") {
    const paymentStatusLabel = isGamePaid === true ? "Оплачено" : "Не оплачено";
    const paymentStatusClass = isGamePaid === true ? "paid" : "unpaid";
    const paymentStatusIcon = (
      <svg className="details-payment-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect
          x="3.5"
          y="6.5"
          width="17"
          height="11"
          rx="2.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M6.6 9.5h1.1M16.3 14.5h1.1"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="1.8"
        />
      </svg>
    );
    const isPendingDisputeWindowExpired = isMatchResultPendingReview
      && detailsMatchResultDisputeTimeLeftMs != null
      && detailsMatchResultDisputeTimeLeftMs <= 0;
    const matchResultStatusLabel = isMatchResultAgreed
      ? "Согласовано"
      : isMatchResultPendingReview
        ? (isPendingDisputeWindowExpired ? "Согласуется" : "На оспаривании")
        : detailsMatchResultStatus === "DISPUTED"
          ? "Оспорен"
          : "Черновик";
    const matchResultStatusClass = isMatchResultAgreed
      ? "confirmed"
      : isMatchResultPendingReview
        ? "pending"
        : detailsMatchResultStatus === "DISPUTED"
          ? "disputed"
          : "draft";
    const matchResultSubmittedMeta = detailsMatchResultSubmittedBy?.name
      ? `${detailsMatchResultSubmittedBy.name}${detailsMatchResultSubmittedAt ? ` · ${new Date(detailsMatchResultSubmittedAt).toLocaleString("ru-RU")}` : ""}`
      : null;
    const matchResultDisputeDeadlineMeta = detailsMatchResultDisputeDeadlineAt
      ? new Date(detailsMatchResultDisputeDeadlineAt).toLocaleString("ru-RU")
      : null;
    const matchResultAgreementMeta = detailsMatchResultConfirmedAt
      ? (
        detailsMatchResultConfirmedBy?.name
          ? `${detailsMatchResultConfirmedBy.name} · ${new Date(detailsMatchResultConfirmedAt).toLocaleString("ru-RU")}`
          : new Date(detailsMatchResultConfirmedAt).toLocaleString("ru-RU")
      )
      : null;
    const matchResultDisputedMeta = detailsMatchResultDisputedBy?.name
      ? `${detailsMatchResultDisputedBy.name}${detailsMatchResultDisputedAt ? ` · ${new Date(detailsMatchResultDisputedAt).toLocaleString("ru-RU")}` : ""}`
      : null;
    const matchResultPendingNote = isMatchResultPendingReview && matchResultDisputeDeadlineMeta
      ? (
        detailsMatchResultDisputeTimeLeftMs != null && detailsMatchResultDisputeTimeLeftMs > 0
          ? `До ${matchResultDisputeDeadlineMeta} результат можно оспорить. Затем он согласуется автоматически.`
          : "Срок на оспаривание истек. Согласуем результат автоматически."
      )
      : null;
    const matchResultSetsForDisplay = isMatchResultAgreed
      ? detailsCompletedMatchResultSets
      : detailsMatchResultSets;
    const matchResultSetPairingsForDisplay = buildVisibleMatchResultSetPairings(
      detailsMatchResultSetPairings,
      matchResultSetsForDisplay.length,
      detailsTeamSlots,
    );
    const hasAnyMatchResultScoreInput = detailsMatchResultSets.some((setItem) => (
      setItem.left.trim() !== "" || setItem.right.trim() !== ""
    ));
    const shouldHandleMatchResultFromFooter = detailsActiveTab === "result"
      && !isMatchResultPendingReview
      && !isMatchResultAgreed
      && canEditMatchResult;
    const shouldSubmitMatchResultFromFooter = shouldHandleMatchResultFromFooter && hasAnyMatchResultScoreInput;
    const canCurrentUserOpenDetailsChat = Boolean(
      gameRecordId
      && canCurrentUserSendChat
      && (isCurrentUserConfirmedParticipant || isCurrentUserOrganizerByDetails),
    );
    const shouldRenderDetailsFooterSubmit = shouldHandleMatchResultFromFooter
      || isCurrentUserConfirmedParticipant
      || isCurrentUserOrganizerByDetails;
    const detailsFooterSubmitDisabled = shouldHandleMatchResultFromFooter && updatingGameMeta;
    const detailsFooterSubmitLabel = shouldHandleMatchResultFromFooter
      ? (
        updatingGameMeta
          ? "Сохраняем..."
          : hasAnyMatchResultScoreInput
            ? "Отправить на согласование"
            : "Внести результат"
      )
      : "Отлично";
    const canUploadMatchResultPhotos = isCurrentUserConfirmedParticipant
      && !isMatchResultPendingReview
      && !isMatchResultAgreed
      && !updatingGameMeta
      && !detailsMatchResultAttachmentsLoading;
    const detailsPrimaryMatchPhotoAttachment = detailsMatchResultAttachments[0] ?? null;
    const detailsPrimaryMatchPhoto = detailsPrimaryMatchPhotoAttachment?.dataUrl ?? null;
    const detailsPrimaryMatchPhotoLogoVariant = detailsPrimaryMatchPhotoAttachment
      ? (detailsMatchResultPhotoLogoVariants[detailsPrimaryMatchPhotoAttachment.id] ?? "white")
      : "white";
    const detailsPrimaryMatchPhotoLogo = detailsPrimaryMatchPhotoLogoVariant === "black"
      ? logoHabBlack
      : logoHabWhite;
    const detailsSecondaryMatchPhotos = detailsMatchResultAttachments.slice(1);
    const matchResultPhotoScore = formatMatchResultPhotoScore(detailsMatchResultSets);
    const canShareMatchResult = Boolean(detailsPrimaryMatchPhoto)
      && !detailsMatchResultAttachmentsLoading
      && !sharingMatchResultPhoto;
    const fallbackRatingImpactRows = (() => {
      if (!isMatchResultAgreed) return [] as MatchResultRatingImpactEntry[];
      if (detailsMatchResultRatingImpact.length > 0) return [] as MatchResultRatingImpactEntry[];
      if (detailsCompletedMatchResultSets.length === 0) return [] as MatchResultRatingImpactEntry[];

      const scoreA = detailsCompletedMatchResultSets.reduce(
        (total, setItem) => total + Number.parseInt(setItem.left, 10),
        0,
      );
      const scoreB = detailsCompletedMatchResultSets.reduce(
        (total, setItem) => total + Number.parseInt(setItem.right, 10),
        0,
      );
      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) {
        return [] as MatchResultRatingImpactEntry[];
      }

      let teamAPlayers = dedupePlayersByIdentity(detailsTeamSlots.slice(0, 2));
      let teamBPlayers = dedupePlayersByIdentity(detailsTeamSlots.slice(2, 4));

      if (teamAPlayers.length === 0 || teamBPlayers.length === 0) {
        const fallbackParticipants = dedupePlayersByIdentity(detailsParticipants.slice(0, detailsMaxPlayers));
        if (fallbackParticipants.length >= 2) {
          const middle = Math.ceil(fallbackParticipants.length / 2);
          teamAPlayers = fallbackParticipants.slice(0, middle);
          teamBPlayers = fallbackParticipants.slice(middle);
        }
      }

      return buildMatchResultRatingImpact(
        teamAPlayers,
        teamBPlayers,
        scoreA,
        scoreB,
        detailsMetadata.matchResult,
      );
    })();
    const matchResultRatingImpactRows = [
      ...(detailsMatchResultRatingImpact.length > 0
        ? detailsMatchResultRatingImpact
        : fallbackRatingImpactRows),
    ].sort((left, right) => {
      const leftTeamOrder = left.team === "A" ? 0 : left.team === "B" ? 1 : 2;
      const rightTeamOrder = right.team === "A" ? 0 : right.team === "B" ? 1 : 2;
      if (leftTeamOrder !== rightTeamOrder) return leftTeamOrder - rightTeamOrder;
      return left.name.localeCompare(right.name, "ru-RU");
    });
    const isMatchResultVivaSynced = detailsMatchResultVivaSync?.status === "SUCCESS";
    const canRetryVivaMatchResultSync = isMatchResultAgreed
      && matchResultRatingImpactRows.length > 0
      && !updatingGameMeta
      && !retryingMatchResultVivaSync
      && !isMatchResultVivaSynced;
    const useStartedMatchDetailsLayout = isDetailsMatchStarted;
    const detailsTeamCardTitle = useStartedMatchDetailsLayout ? "Команды" : "Команда";
    const detailsTeamEditorBlock = (
      <div className="details-team-card">
        <div className="details-team-header">
          <div className="details-team-title">{detailsTeamCardTitle}</div>
          <div className="details-team-subtitle">{detailsTeamSubtitle}</div>
        </div>
        <div className={`details-team-pairs${detailsMaxPlayers <= 2 ? " details-team-pairs-singles" : ""}`}>
          {detailsTeamPairIndexes.map((slotIndexes, pairIndex) => {
            return (
              <div key={`pair-${pairIndex}`} className="details-team-pair">
                {useStartedMatchDetailsLayout && (
                  <div className="details-team-pair-label">{`Команда ${pairIndex + 1}`}</div>
                )}
                <div className="details-team-pair-slots">
                  {slotIndexes.map((slotIndex) => {
                    const slotPlayer = detailsTeamSlots[slotIndex];
                    const slotLevelLabel = normalizePlayerRatingLabel(slotPlayer?.rating ?? null);
                    const slotLevelProgress = getPlayerRatingProgress(slotLevelLabel);
                    const slotRingProgressDeg = slotLevelProgress != null
                      ? `${Math.max(0, Math.min(360, Math.round(slotLevelProgress * 360)))}deg`
                      : "0deg";
                    const slotIsOrganizerLocked =
                      slotIndex === 0 && detailsOrganizerInMatch && Boolean(detailsOrganizerPlayer);
                    const slotDisabled = updatingGameMeta
                      || (slotIsOrganizerLocked && !canManagePlayersInDetails)
                      || (!canManagePlayersInDetails
                        && (!isCurrentUserConfirmedParticipant || (slotIndex === 0 && detailsOrganizerInMatch)));
                    return (
                      <div key={`team-slot-${slotIndex}`} className="details-team-slot-wrap">
                        <button
                          type="button"
                          className={`details-team-slot${slotPlayer ? "" : " empty"}${slotIsOrganizerLocked ? " locked" : ""}`}
                          onClick={() => {
                            void handleTeamSlotTap(slotIndex);
                          }}
                          disabled={slotDisabled}
                        >
                          <div
                            className={`details-team-slot-ring${slotLevelLabel ? " has-level" : ""}`}
                            style={{ "--player-ring-progress": slotRingProgressDeg } as CSSProperties}
                          >
                            <AvatarWithInitialsFallback
                              src={slotPlayer?.photo}
                              alt={slotPlayer?.name || "Игрок"}
                              imageClassName="details-team-slot-avatar"
                              fallbackClassName="details-team-slot-avatar details-team-slot-avatar-fallback"
                              fallbackText={getPlayerInitials(slotPlayer?.name || "") || "+"}
                            />
                          </div>
                          {slotLevelLabel && (
                            <div className="details-team-slot-level">{slotLevelLabel}</div>
                          )}
                        </button>
                        <div className="details-team-slot-name">
                          {slotPlayer?.name || "Свободно"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        {detailsTeamMenuSlotIndex != null && canManagePlayersInDetails && (
          <div className="details-team-picker">
            <div className="details-team-picker-title">
              {`Слот ${detailsTeamMenuSlotIndex + 1}: выберите игрока`}
            </div>
            <div className="details-team-picker-list">
              {detailsTeamMenuOptions.map((player) => {
                const playerKey = getPadelPlayerIdentityKey(player) || `${player.name}-${player.phone}`;
                const isWaitlistPlayer = detailsWaitlist.some((item) => (
                  getPadelPlayerIdentityKey(item) === getPadelPlayerIdentityKey(player)
                ));
                return (
                  <button
                    key={playerKey}
                    type="button"
                    className="details-team-picker-item"
                    onClick={() => {
                      void handleTeamSlotPick(detailsTeamMenuSlotIndex, player);
                    }}
                    disabled={updatingGameMeta}
                  >
                    {player.name || "Игрок"}
                    {isWaitlistPlayer ? " · лист ожидания" : ""}
                  </button>
                );
              })}
              {detailsTeamMenuSlotIndex !== 0 && detailsTeamSlots[detailsTeamMenuSlotIndex] && (
                <button
                  type="button"
                  className="details-team-picker-item danger"
                  onClick={() => {
                    void handleTeamSlotPick(detailsTeamMenuSlotIndex, null);
                  }}
                  disabled={updatingGameMeta}
                >
                  Очистить слот
                </button>
              )}
            </div>
          </div>
        )}
        {!canManagePlayersInDetails && isCurrentUserConfirmedParticipant && detailsCurrentUserTeamSlotIndex < 0 && (
          <div className="details-team-note">
            Выберите свободный слот в команде
          </div>
        )}
        {!canManagePlayersInDetails && isCurrentUserConfirmedParticipant && detailsCurrentUserTeamSlotIndex >= 0 && (
          <div className="details-team-note">
            Слот закреплен. Менять состав может только организатор.
          </div>
        )}
      </div>
    );
    const matchInfoSection = (
      <div className="game-section">
        {gameRecordError && <div className="game-empty game-pay-error">{gameRecordError}</div>}
        <div className="details-card">
          <div className="details-row">
            <div className="details-main">
              <div className="details-main-info">
                <div className="details-date details-date-capitalize">{detailsDateLabel}</div>
                <div className="details-time">
                  {detailsTimeFrom && detailsTimeTo
                    ? `${detailsTimeFrom} • ${detailsTimeTo}`
                    : "Время не указано"}
                </div>
                <div className="details-time details-time-strong">{detailsRoomName}</div>
                <div className="details-time">{detailsStudioName}</div>
                {detailsGameTitle && (
                  <div className="details-match-custom-title">{detailsGameTitle}</div>
                )}
              </div>
              {detailsGameParticipantComment && (
                <div className="details-match-comment" aria-label="Комментарий к игре">
                  <span className="details-match-comment-quote" aria-hidden="true">“</span>
                  <span>{detailsGameParticipantComment}</span>
                  <span className="details-match-comment-quote" aria-hidden="true">”</span>
                </div>
              )}
            </div>
            <div className="details-right-stack">
              <CalendarDateBadge
                monthLabel={detailsBadgeMonth}
                dayLabel={detailsBadgeDay}
                badgeClassName="game-created-date-badge"
                disabled={!activeGameRecord?.booking?.date || (!activeGameRecord?.booking?.timeFrom && !activeGameRecord?.booking?.timeTo)}
                onClick={() => addGameToCalendar(activeGameRecord)}
              />
              <button
                type="button"
                className={`details-payment-indicator ${paymentStatusClass}`}
                aria-label={paymentStatusLabel}
                onClick={() => {
                  setDetailsPaymentHintOpen((prev) => !prev);
                }}
              >
                {paymentStatusIcon}
              </button>
              {detailsPaymentHintOpen && (
                <div className={`details-payment-tooltip ${paymentStatusClass}`}>
                  {paymentStatusLabel}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
    const detailsPlayersBlock = (
      <>
        {detailsOrganizerPlayer && !detailsOrganizerInMatch && (
          <div className="details-roster-card details-organizer-card">
            <div className="details-roster-head">
              <div className="details-roster-title">Организатор</div>
            </div>
            <div className="details-roster-list">
              <div className="details-roster-row">
                <div className="details-roster-player">
                  <AvatarWithInitialsFallback
                    src={detailsOrganizerPlayer.photo}
                    alt={detailsOrganizerPlayer.name || "Организатор"}
                    imageClassName="details-roster-avatar"
                    fallbackClassName="details-roster-avatar details-roster-avatar-fallback"
                    fallbackText={getPlayerInitials(detailsOrganizerPlayer.name || "Организатор") || "О"}
                  />
                <div className="details-roster-meta">
                  <div className="details-roster-name">{detailsOrganizerPlayer.name || "Организатор"}</div>
                  <div className="details-roster-sub">
                    {detailsOrganizerPlayer.rating ? `Уровень: ${detailsOrganizerPlayer.rating}` : "Вне состава"}
                  </div>
                </div>
              </div>
              {canManagePlayersInDetails ? (
                <button
                  type="button"
                  className="details-roster-action details-roster-return-organizer"
                  onClick={() => {
                    void handleReturnOrganizerToMatchFromDetails();
                  }}
                  disabled={updatingGameRoster || !detailsHasFreeSlots}
                  title={detailsHasFreeSlots ? "Вернуть организатора в состав" : "Сначала освободите место в составе"}
                >
                  Вернуться в игру
                </button>
              ) : (
                <span className="details-roster-badge">Организатор</span>
              )}
              </div>
            </div>
          </div>
        )}

        <div className="details-roster-card">
          <div className="details-roster-head">
            <div className="details-roster-title">Игроки в матче</div>
            <div className="details-roster-count">
              {`${detailsParticipants.length}/${detailsMaxPlayers}`}
            </div>
          </div>
          {gameRosterError && <div className="game-empty game-pay-error">{gameRosterError}</div>}
          {detailsParticipants.length === 0 ? (
            <div className="game-empty">Пока нет подтвержденных игроков</div>
          ) : (
            <div className="details-roster-list">
              {detailsParticipants.map((player, index) => {
                const playerKey = getPadelPlayerIdentityKey(player) || `participant-${index}`;
                const isOrganizer = isDetailsOrganizerPlayer(player);
                return (
                  <div className="details-roster-row" key={playerKey}>
                    <div className="details-roster-player">
                      <AvatarWithInitialsFallback
                        src={player.photo}
                        alt={player.name || "Игрок"}
                        imageClassName="details-roster-avatar"
                        fallbackClassName="details-roster-avatar details-roster-avatar-fallback"
                        fallbackText={getPlayerInitials(player.name) || "+"}
                      />
                      <div className="details-roster-meta">
                        <div className="details-roster-name">{player.name || "Игрок"}</div>
                        <div className="details-roster-sub">
                          {player.rating ? `Уровень: ${player.rating}` : "Без уровня"}
                        </div>
                      </div>
                    </div>

                    {isOrganizer ? (
                      <span className="details-roster-badge">Организатор</span>
                    ) : (
                      canManagePlayersInDetails ? (
                        <div className="details-roster-actions">
                          <button
                            type="button"
                            className="details-roster-action details-roster-move-waitlist"
                            onClick={() => handleMoveParticipantToWaitlistFromDetails(player, index)}
                            disabled={updatingGameRoster || !isDetailsWaitlistEnabled}
                            title={isDetailsWaitlistEnabled ? "Переместить в лист ожидания" : "Лист ожидания закрыт"}
                          >
                            В лист ожидания
                          </button>
                          <button
                            type="button"
                            className="details-roster-action details-roster-remove"
                            onClick={() => handleRemoveParticipantFromDetails(player, index)}
                            disabled={updatingGameRoster}
                          >
                            Удалить
                          </button>
                        </div>
                      ) : (
                        isCurrentUserPlayer(player) && (
                          <button
                            type="button"
                            className="details-roster-action details-roster-leave"
                            onClick={() => {
                              void handleLeaveCurrentUserFromDetails();
                            }}
                            disabled={!canCurrentUserLeaveGameInDetails}
                          >
                            Покинуть игру
                          </button>
                        )
                      )
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {detailsWaitlist.length > 0 && (
            <div className="details-roster-waitlist">
              <div className="details-roster-subtitle">Лист ожидания</div>
              <div className="details-roster-list">
                {detailsWaitlist.map((player, index) => {
                  const playerKey = getPadelPlayerIdentityKey(player) || `waitlist-${index}`;
                  return (
                    <div className="details-roster-row" key={playerKey}>
                      <div className="details-roster-player">
                        <AvatarWithInitialsFallback
                          src={player.photo}
                          alt={player.name || "Игрок"}
                          imageClassName="details-roster-avatar"
                          fallbackClassName="details-roster-avatar details-roster-avatar-fallback"
                          fallbackText={getPlayerInitials(player.name) || "+"}
                        />
                        <div className="details-roster-meta">
                          <div className="details-roster-name">{player.name || "Игрок"}</div>
                          <div className="details-roster-sub">Ожидает подтверждения</div>
                        </div>
                      </div>

                      {canManagePlayersInDetails ? (
                        <button
                          type="button"
                          className="details-roster-action details-roster-add"
                          onClick={() => handleAddWaitlistPlayerToDetails(player, index)}
                          disabled={updatingGameRoster || !detailsHasFreeSlots}
                          title={detailsHasFreeSlots ? "Добавить в игру" : "Нет свободных мест"}
                        >
                          +
                        </button>
                      ) : (
                        isCurrentUserPlayer(player) && (
                          <button
                            type="button"
                            className="details-roster-action details-roster-leave"
                            onClick={() => {
                              void handleLeaveCurrentUserFromDetails();
                            }}
                            disabled={!canCurrentUserLeaveGameInDetails}
                          >
                            Покинуть лист
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {detailsLeaveEvents.length > 0 && (
            <div className="details-roster-leaves">
              <div className="details-roster-subtitle">Игроки покинули игру</div>
              <div className="details-roster-leave-list">
                {detailsLeaveEvents.map((item, index) => {
                  const playerName = item.playerName?.trim() || "Игрок";
                  const leftAtLabel = new Date(item.leftAt).toLocaleString("ru-RU");
                  const actionLabel = item.reason === "ORGANIZER_REMOVED"
                    ? "удален из игры"
                    : "покинул игру";
                  const key = `${item.playerPhone || item.playerId || playerName}-${item.leftAt}-${index}`;
                  return (
                    <div className="details-roster-leave-row" key={key}>
                      <span className="details-roster-leave-name">{`${playerName} ${actionLabel}`}</span>
                      <span className="details-roster-leave-time">{leftAtLabel}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </>
    );
    const matchResultRatingImpactBlock = isMatchResultAgreed && matchResultRatingImpactRows.length > 0 ? (
      <div className="details-rating-impact">
        <div className="details-rating-impact-title">Изменение рейтинга</div>
        <div className="details-rating-impact-list">
          {matchResultRatingImpactRows.map((item, index) => {
            const deltaClass = item.delta > 0
              ? "positive"
              : item.delta < 0
                ? "negative"
                : "neutral";
            const deltaLabel = item.delta > 0
              ? `+${formatRatingValue(item.delta)}`
              : formatRatingValue(item.delta);
            const teamLabel = item.team === "A"
              ? useStartedMatchDetailsLayout
                ? "Команда 1"
                : "Пара 1"
              : item.team === "B"
                ? useStartedMatchDetailsLayout
                  ? "Команда 2"
                  : "Пара 2"
                : null;
            const rowKey = item.phoneNorm
              || item.id
              || `${item.name}-${item.team || "u"}-${index}`;
            return (
              <div key={rowKey} className="details-rating-impact-row">
                <div className="details-rating-impact-player">
                  <div className="details-rating-impact-name">
                    {item.name || "Игрок"}
                    {teamLabel && <span className="details-rating-impact-team">{teamLabel}</span>}
                  </div>
                  <div className="details-rating-impact-values">
                    {`${formatRatingValue(item.before)} → ${formatRatingValue(item.after)}${item.gradeAfter ? ` · ${item.gradeAfter}` : ""}`}
                  </div>
                </div>
                <div className={`details-rating-impact-delta ${deltaClass}`}>
                  {deltaLabel}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ) : null;
    const matchResultPhotosBlock = (
      <div className="details-result-photos">
        <div className="details-result-photo-head">
          <div className="details-result-photo-title">Фото матча</div>
          <div className="details-result-photo-actions">
            <button
              type="button"
              className="details-result-photo-btn icon-only"
              onClick={() => detailsCameraInputRef.current?.click()}
              disabled={!canUploadMatchResultPhotos}
              aria-label="Сделать фото"
              title="Сделать фото"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <path
                  d="M8.5 6.5L9.7 5.1C10 4.73 10.16 4.55 10.36 4.42C10.54 4.31 10.74 4.22 10.95 4.16C11.18 4.1 11.43 4.1 11.93 4.1H12.07C12.57 4.1 12.82 4.1 13.05 4.16C13.26 4.22 13.46 4.31 13.64 4.42C13.84 4.55 14 4.73 14.3 5.1L15.5 6.5H17C18.4 6.5 19.1 6.5 19.64 6.77C20.11 7.01 20.49 7.39 20.73 7.86C21 8.4 21 9.1 21 10.5V15.5C21 16.9 21 17.6 20.73 18.14C20.49 18.61 20.11 18.99 19.64 19.23C19.1 19.5 18.4 19.5 17 19.5H7C5.6 19.5 4.9 19.5 4.36 19.23C3.89 18.99 3.51 18.61 3.27 18.14C3 17.6 3 16.9 3 15.5V10.5C3 9.1 3 8.4 3.27 7.86C3.51 7.39 3.89 7.01 4.36 6.77C4.9 6.5 5.6 6.5 7 6.5H8.5Z"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </button>
            <button
              type="button"
              className="details-result-photo-btn icon-only"
              onClick={() => detailsGalleryInputRef.current?.click()}
              disabled={!canUploadMatchResultPhotos}
              aria-label="Из галереи"
              title="Из галереи"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <rect
                  x="3.5"
                  y="4.5"
                  width="17"
                  height="15"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <circle cx="9" cy="10" r="1.5" fill="currentColor" />
                <path
                  d="M6.5 17L11 12.5L13.8 15.3L15.5 13.6L18.5 16.6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        <input
          ref={detailsCameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: "none" }}
          onChange={(event) => {
            void handleMatchResultAttachmentFiles(event.target.files, "camera");
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={detailsGalleryInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            void handleMatchResultAttachmentFiles(event.target.files, "gallery");
            event.currentTarget.value = "";
          }}
        />
        {detailsPrimaryMatchPhoto && (
          <div className="details-result-photo-stage">
            <img
              src={detailsPrimaryMatchPhoto}
              alt={detailsPrimaryMatchPhotoAttachment?.name || "Фото матча"}
              className="details-result-photo-stage-image"
            />
            <div className={`details-result-photo-overlay ${detailsPrimaryMatchPhotoLogoVariant}`}>
              <div className="details-result-photo-score">
                <div className="details-result-photo-score-label">Результат матча</div>
                <div className={`details-result-photo-score-value${matchResultPhotoScore ? "" : " empty"}`}>
                  {matchResultPhotoScore || "Счёт не внесён"}
                </div>
              </div>
              <img
                src={detailsPrimaryMatchPhotoLogo}
                alt="Padel Hub"
                className="details-result-photo-logo"
              />
            </div>
            <button
              type="button"
              className="details-result-photo-remove featured"
              onClick={() => {
                if (!detailsPrimaryMatchPhotoAttachment) return;
                void handleRemoveMatchResultAttachment(detailsPrimaryMatchPhotoAttachment.id);
              }}
              disabled={!canUploadMatchResultPhotos}
              aria-label="Удалить основное фото"
            >
              ×
            </button>
          </div>
        )}
        {detailsMatchResultAttachmentsLoading && (
          <div className="details-result-meta">Загружаем фото...</div>
        )}
        {detailsSecondaryMatchPhotos.length > 0 && (
          <div className="details-result-photo-grid">
            {detailsSecondaryMatchPhotos.map((attachment, index) => (
              <div key={attachment.id || `${attachment.name}-${index}`} className="details-result-photo-item">
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name || `Фото ${index + 2}`}
                  className="details-result-photo-preview"
                />
                <button
                  type="button"
                  className="details-result-photo-remove"
                  onClick={() => handleRemoveMatchResultAttachment(attachment.id)}
                  disabled={!canUploadMatchResultPhotos}
                  aria-label="Удалить фото"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {detailsPrimaryMatchPhoto && (
          <button
            type="button"
            className="section-cta section-cta-secondary details-result-share"
            onClick={() => {
              void handleShareMatchResultPhoto();
            }}
            disabled={!canShareMatchResult}
          >
            {sharingMatchResultPhoto ? "Готовим файл..." : "Поделиться результатом"}
          </button>
        )}
      </div>
    );
    const detailsTabs: Array<{ key: "game" | "result"; label: string; disabled?: boolean }> = isDetailsMatchStarted
      ? [
        { key: "result", label: "Результат", disabled: !canCurrentUserAccessResultTab },
        { key: "game", label: "Игра" },
      ]
      : [
        { key: "game", label: "Игра" },
        { key: "result", label: "Результат", disabled: !canCurrentUserAccessResultTab },
      ];

    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={onBack} type="button">
            ← Назад
          </button>
          <div className="page-title">Детали матча</div>
        </div>
        {matchInfoSection}

        <div className="game-section">
          <div className="details-tabs" role="tablist" aria-label="Разделы матча">
            {detailsTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={detailsActiveTab === tab.key}
                aria-disabled={tab.disabled ? true : undefined}
                className={`details-tab ${detailsActiveTab === tab.key ? "active" : ""}${tab.disabled ? " is-disabled" : ""}`}
                onClick={() => {
                  if (tab.disabled) return;
                  setDetailsActiveTab(tab.key);
                }}
                disabled={Boolean(tab.disabled)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="game-section">
          {detailsActiveTab === "game" && (
            <>
              {gameDetailsMetaError && <div className="game-empty game-pay-error">{gameDetailsMetaError}</div>}
              {detailsPlayersBlock}
              {detailsTeamEditorBlock}

              {isCurrentUserOrganizerOfActiveGame && detailsPublishedCommunityCards.length > 0 && (
                <div className="team-card game-autopublish-panel">
                  <div className="game-card-title">Снять с публикации</div>
                  <div className="game-autopublish-row" role="group" aria-label="Выбор сообществ для снятия публикации">
                    {detailsPublishedCommunityCards.map((community) => (
                      <label
                        key={community.key}
                        className={`team-member game-autopublish-card${community.selected ? " is-selected" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="game-autopublish-card-input"
                          checked={community.selected}
                          disabled={updatingGameMeta}
                          onChange={() => {
                            if (updatingGameMeta) return;
                            toggleDetailsCommunityUnpublishSelection(community.communityId);
                          }}
                        />
                        <span className="game-autopublish-card-check" aria-hidden="true" />
                        <div className="game-autopublish-card-avatar">
                          {renderCommunityAutopublishAvatar({
                            name: community.name,
                            logo: community.logo,
                          })}
                        </div>
                        <div className="game-autopublish-card-name">{community.name}</div>
                      </label>
                    ))}
                  </div>
                  <div className="game-autopublish-panel-meta">
                    Выберите сообщества, где игра больше не должна отображаться в ленте.
                  </div>
                  <button
                    className="section-cta details-cancel-danger"
                    type="button"
                    disabled={updatingGameMeta || detailsSelectedCommunityUnpublishIds.length === 0}
                    onClick={() => {
                      void handleUnpublishSelectedGameCommunities();
                    }}
                  >
                    {updatingGameMeta ? "Снимаем публикацию..." : "Снять с публикации"}
                  </button>
                </div>
              )}
            </>
          )}

          {detailsActiveTab === "result" && (
            <div className="details-result-card">
              <div className="details-result-header">
                <div className="details-result-title">Результаты матча</div>
                <span className={`details-result-status ${matchResultStatusClass}`}>
                  {matchResultStatusLabel}
                </span>
              </div>

              {matchResultSubmittedMeta && (
                <div className="details-result-meta">
                  {`Отправил: ${matchResultSubmittedMeta}`}
                </div>
              )}
              {matchResultDisputeDeadlineMeta && isMatchResultPendingReview && (
                <div className="details-result-meta">
                  {detailsMatchResultDisputeTimeLeftMs != null && detailsMatchResultDisputeTimeLeftMs > 0
                    ? `На оспаривание: ${formatMatchResultTimeLeft(detailsMatchResultDisputeTimeLeftMs)}`
                    : "Окно оспаривания завершилось"}
                </div>
              )}
              {matchResultDisputeDeadlineMeta && isMatchResultPendingReview && (
                <div className="details-result-meta">
                  {`Оспорить можно до: ${matchResultDisputeDeadlineMeta}`}
                </div>
              )}
              {matchResultAgreementMeta && (
                <div className="details-result-meta">
                  {detailsMatchResultConfirmedBy?.name
                    ? `Согласовал: ${matchResultAgreementMeta}`
                    : `Согласовано автоматически: ${matchResultAgreementMeta}`}
                </div>
              )}
              {matchResultDisputedMeta && (
                <div className="details-result-meta">
                  {`Оспорил: ${matchResultDisputedMeta}`}
                </div>
              )}

              {isMatchResultAgreed && isMatchResultVivaSynced && (
                <div className="details-result-meta">Уровень обновлен</div>
              )}

              {canRetryVivaMatchResultSync && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-retry-sync"
                  onClick={() => {
                    void handleRetryMatchResultVivaSync();
                  }}
                  disabled={retryingMatchResultVivaSync || updatingGameMeta}
                >
                  {retryingMatchResultVivaSync ? "Отправляем..." : "Отправить результаты повторно"}
                </button>
              )}

              {!isDetailsMatchStarted && (
                <div className="details-result-note">
                  Ввод результатов игры будет доступен после ее начала.
                </div>
              )}
              {matchResultPendingNote && (
                <div className="details-result-note">
                  {matchResultPendingNote}
                </div>
              )}

              <div className="details-result-sets">
                {matchResultSetsForDisplay.map((setItem, index) => {
                  const setPairing = matchResultSetPairingsForDisplay[index] ?? null;
                  const previousSetPairing = index > 0
                    ? (matchResultSetPairingsForDisplay[index - 1] ?? null)
                  : null;
                const isEditableStartPairing = canEditMatchResult && index === 0;
                const setPairingSlotsForDisplay = isEditableStartPairing
                  ? cloneTeamSlots(detailsTeamSlots)
                  : setPairing;
                const setPairingTeamAPlayers = setPairingSlotsForDisplay
                  ? getMatchResultPairTeamPlayers(setPairingSlotsForDisplay, [0, 1])
                  : [];
                const setPairingTeamBPlayers = setPairingSlotsForDisplay
                  ? getMatchResultPairTeamPlayers(setPairingSlotsForDisplay, [2, 3])
                  : [];
                const setPairingTeamALabel = setPairingSlotsForDisplay
                  ? formatMatchResultPairTeamLabel(setPairingSlotsForDisplay, [0, 1])
                  : null;
                const setPairingTeamBLabel = setPairingSlotsForDisplay
                  ? formatMatchResultPairTeamLabel(setPairingSlotsForDisplay, [2, 3])
                  : null;
                const shouldShowSetPairingBlock = Boolean(
                  (setPairingTeamALabel || setPairingTeamBLabel || isEditableStartPairing)
                  && (isEditableStartPairing || !canEditMatchResult || index < detailsCompletedMatchResultSets.length)
                  && (
                    isEditableStartPairing
                    ||
                    !previousSetPairing
                    || !areTeamSlotsEqualByIdentity(setPairingSlotsForDisplay ?? [], previousSetPairing)
                  )
                );
                const setPairingBlockTitle = index === 0
                  ? "Стартовый состав"
                  : `Новый состав перед сетом ${index + 1}`;
                const renderResultPairingPlayer = (
                  slotIndex: number,
                  playerIndex: number,
                  teamKey: "a" | "b",
                ) => {
                  const player = setPairingSlotsForDisplay?.[slotIndex] ?? null;
                  if (!player && !isEditableStartPairing) return null;
                  const playerLevelLabel = normalizePlayerRatingLabel(player?.rating ?? null);
                  const playerLevelProgress = getPlayerRatingProgress(playerLevelLabel);
                  const playerRingProgressDeg = playerLevelProgress != null
                    ? `${Math.max(0, Math.min(360, Math.round(playerLevelProgress * 360)))}deg`
                    : "0deg";
                  const playerKey = getPadelPlayerIdentityKey(player) || `set-${index}-${teamKey}-${playerIndex}`;
                  const slotIsOrganizerLocked =
                    slotIndex === 0 && detailsOrganizerInMatch && Boolean(detailsOrganizerPlayer);
                  const slotDisabled = updatingGameMeta
                    || (slotIsOrganizerLocked && !canManagePlayersInDetails)
                    || (!canManagePlayersInDetails
                      && (!isCurrentUserConfirmedParticipant || (slotIndex === 0 && detailsOrganizerInMatch)));
                  const playerContent = (
                    <>
                      <div
                        className={`details-result-set-pairing-player-ring${playerLevelLabel ? " has-level" : ""}`}
                        style={{ "--player-ring-progress": playerRingProgressDeg } as CSSProperties}
                      >
                        <AvatarWithInitialsFallback
                          src={player?.photo}
                          alt={player?.name || "Игрок"}
                          imageClassName="details-result-set-pairing-player-avatar"
                          fallbackClassName="details-result-set-pairing-player-avatar details-result-set-pairing-player-avatar-fallback"
                          fallbackText={getPlayerInitials(player?.name || "") || "+"}
                        />
                      </div>
                      {playerLevelLabel && (
                        <div className="details-result-set-pairing-player-level">{playerLevelLabel}</div>
                      )}
                      <div className="details-result-set-pairing-player-name">{player?.name || "Свободно"}</div>
                    </>
                  );

                  if (isEditableStartPairing) {
                    return (
                      <button
                        key={`slot-${slotIndex}`}
                        type="button"
                        className={`details-result-set-pairing-player details-result-set-pairing-player-action${player ? "" : " empty"}${slotIsOrganizerLocked ? " locked" : ""}`}
                        onClick={() => {
                          void handleTeamSlotTap(slotIndex);
                        }}
                        disabled={slotDisabled}
                      >
                        {playerContent}
                      </button>
                    );
                  }

                  return (
                    <div key={playerKey} className="details-result-set-pairing-player">
                      {playerContent}
                    </div>
                  );
                };

                return (
                  <div className="details-result-set-row" key={`set-${index + 1}`}>
                    {shouldShowSetPairingBlock && (
                      <div className="details-result-set-pairing">
                        <div className="details-result-set-pairing-head">{setPairingBlockTitle}</div>
                        <div className="details-result-set-pairing-cards">
                          {(setPairingTeamALabel || isEditableStartPairing) && (
                            <div className="details-result-set-pairing-card">
                              <div className="details-result-set-pairing-card-title">Команда 1</div>
                              <div
                                className={`details-result-set-pairing-card-players${!isEditableStartPairing && setPairingTeamAPlayers.length === 1 ? " is-solo" : ""}`}
                              >
                                {[0, 1].map((slotIndex, playerIndex) =>
                                  renderResultPairingPlayer(slotIndex, playerIndex, "a"),
                                )}
                              </div>
                            </div>
                          )}
                          {(setPairingTeamBLabel || isEditableStartPairing) && (
                            <div className="details-result-set-pairing-card">
                              <div className="details-result-set-pairing-card-title">Команда 2</div>
                              <div
                                className={`details-result-set-pairing-card-players${!isEditableStartPairing && setPairingTeamBPlayers.length === 1 ? " is-solo" : ""}`}
                              >
                                {[2, 3].map((slotIndex, playerIndex) =>
                                  renderResultPairingPlayer(slotIndex, playerIndex, "b"),
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                        {isEditableStartPairing && detailsTeamMenuSlotIndex != null && canManagePlayersInDetails && (
                          <div className="details-team-picker details-result-team-picker">
                            <div className="details-team-picker-title">
                              {`Слот ${detailsTeamMenuSlotIndex + 1}: выберите игрока`}
                            </div>
                            <div className="details-team-picker-list">
                              {detailsTeamMenuOptions.map((player) => {
                                const playerKey = getPadelPlayerIdentityKey(player) || `${player.name}-${player.phone}`;
                                const isWaitlistPlayer = detailsWaitlist.some((item) => (
                                  getPadelPlayerIdentityKey(item) === getPadelPlayerIdentityKey(player)
                                ));
                                return (
                                  <button
                                    key={playerKey}
                                    type="button"
                                    className="details-team-picker-item"
                                    onClick={() => {
                                      void handleTeamSlotPick(detailsTeamMenuSlotIndex, player);
                                    }}
                                    disabled={updatingGameMeta}
                                  >
                                    {player.name || "Игрок"}
                                    {isWaitlistPlayer ? " · лист ожидания" : ""}
                                  </button>
                                );
                              })}
                              {detailsTeamMenuSlotIndex !== 0 && detailsTeamSlots[detailsTeamMenuSlotIndex] && (
                                <button
                                  type="button"
                                  className="details-team-picker-item danger"
                                  onClick={() => {
                                    void handleTeamSlotPick(detailsTeamMenuSlotIndex, null);
                                  }}
                                  disabled={updatingGameMeta}
                                >
                                  Очистить слот
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    <span className="details-result-set-label">{`Сет ${index + 1}`}</span>
                    <div className="details-result-score-row">
                      <input
                        className="details-result-input"
                        type="text"
                        inputMode="numeric"
                        value={setItem.left}
                        disabled={!canEditMatchResult || updatingGameMeta}
                        onChange={(event) => {
                          handleMatchResultInputChange(index, "left", event.target.value);
                        }}
                      />
                      <span className="details-result-separator">-</span>
                      <input
                        className="details-result-input"
                        type="text"
                        inputMode="numeric"
                        value={setItem.right}
                        disabled={!canEditMatchResult || updatingGameMeta}
                        onChange={(event) => {
                          handleMatchResultInputChange(index, "right", event.target.value);
                        }}
                      />
                    </div>
                  {index === detailsLastCompletedMatchResultSetIndex
                    && index + 1 < detailsMatchResultSets.length
                    && detailsPairingOptions.length > 1
                    && canEditMatchResult
                    && !isMatchResultPendingReview
                    && !isMatchResultAgreed && (
                      <div className="details-result-pair-change">
                        <button
                          type="button"
                          className="details-result-pair-toggle"
                          onClick={() => {
                            setDetailsPairComposerSetIndex((prev) => (prev === index ? null : index));
                          }}
                          disabled={updatingGameMeta}
                        >
                          {detailsPairComposerSetIndex === index
                            ? "Скрыть варианты пар"
                            : `Поменять составы пар перед сетом ${index + 2}`}
                        </button>
                        {detailsPairComposerSetIndex === index && (
                          <div className="details-result-pair-options">
                            {detailsPairingOptions.map((option) => (
                              <button
                                key={option.key}
                                type="button"
                                className={`details-result-pair-option${option.isCurrent ? " active" : ""}`}
                                onClick={() => {
                                  void handleQuickPairingApply(option.nextSlots);
                                }}
                                disabled={updatingGameMeta || option.isCurrent}
                              >
                                <span className="details-result-pair-option-title">
                                  {option.isCurrent ? "Текущие пары" : "Пары на следующий сет"}
                                </span>
                                <span className="details-result-pair-option-label">{option.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              </div>

              {matchResultPhotosBlock}

              {matchResultRatingImpactBlock}

              {!isMatchResultAgreed && detailsCompletedMatchResultSets.length > 0 && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-submit"
                  onClick={() => {
                    void handleSubmitMatchResult();
                  }}
                  disabled={!canSubmitMatchResult}
                >
                  {updatingGameMeta ? "Сохраняем..." : "Отправить на согласование"}
                </button>
              )}
              {canDisputeMatchResult && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-dispute"
                  onClick={() => {
                    void handleDisputeMatchResult();
                  }}
                  disabled={updatingGameMeta}
                >
                  {updatingGameMeta ? "Сохраняем..." : "Оспорить результат"}
                </button>
              )}
            </div>
          )}

          {!isCurrentUserConfirmedParticipant && !isCurrentUserOrganizerByDetails && (
            <div className="details-action-row">
              <button
                className="section-cta"
                type="button"
                onClick={() => {
                  void handleJoinCurrentUserFromDetails();
                }}
                disabled={!canCurrentUserJoinGameInDetails}
              >
                {isCurrentUserInWaitlist
                  ? "Вы в листе ожидания"
                  : updatingGameRoster
                    ? "Сохраняем..."
                    : detailsHasFreeSlots
                      ? "Присоединиться к игре"
                      : isDetailsWaitlistEnabled
                        ? "В лист ожидания"
                        : "Нет мест"}
              </button>
              <button
                className="section-cta section-cta-secondary"
                type="button"
                onClick={handleOpenCabinetFromDetails}
              >
                Вернуться в личный кабинет
              </button>
            </div>
          )}

          {isGamePaid !== true && (
            <>
              <button
                className="section-cta"
                onClick={() => {
                  void handleRetryPayment();
                }}
                type="button"
                disabled={retryingPayment}
              >
                {retryingPayment ? "Проверяем оплату..." : "Оплатить"}
              </button>
              {isCurrentUserOrganizerOfActiveGame && !confirmCancelUnpaidGame && (
                <button
                  className="section-cta section-cta-secondary"
                  onClick={() => setConfirmCancelUnpaidGame(true)}
                  type="button"
                  disabled={cancellingUnpaidGame}
                >
                  Отменить бронь
                </button>
              )}
              {isCurrentUserOrganizerOfActiveGame && confirmCancelUnpaidGame && (
                <div className="details-cancel-actions">
                  <button
                    className="section-cta section-cta-secondary"
                    onClick={() => setConfirmCancelUnpaidGame(false)}
                    type="button"
                    disabled={cancellingUnpaidGame}
                  >
                    Не отменять
                  </button>
                  <button
                    className="section-cta details-cancel-danger"
                    onClick={() => {
                      void handleCancelUnpaidGame();
                    }}
                    type="button"
                    disabled={cancellingUnpaidGame}
                  >
                    {cancellingUnpaidGame ? "Отменяем..." : "Да, отменить бронь"}
                  </button>
                </div>
              )}
            </>
          )}

          {!isMatchResultAgreed && (canCurrentUserInviteInDetails || canCurrentUserOpenDetailsChat) && (
            <div className="details-action-row">
              {canCurrentUserInviteInDetails && (
                <button
                  className="section-cta details-action-invite"
                  onClick={handleCopyInvite}
                  type="button"
                  disabled={!inviteLink}
                >
                  {inviteCopied ? "Ссылка скопирована" : "Пригласить в игру"}
                </button>
              )}

              {canCurrentUserOpenDetailsChat && (
                <button
                  className="details-chat-stat-btn"
                  onClick={() => {
                    setChatMessages([]);
                    setChatError(null);
                    setStep("chat");
                  }}
                  type="button"
                  aria-label="Открыть чат игры"
                >
                  <ChatIcon className="details-chat-stat-icon" />
                  <span>Чат игры</span>
                  {currentGameUnreadCount > 0 && (
                    <span className="game-chat-unread-badge">{currentGameUnreadCount}</span>
                  )}
                </button>
              )}
            </div>
          )}

          {detailsServiceInfoVisible && (
            <div className="details-service-block">
              {inviteLink && <div className="invite-status">{inviteLink}</div>}
              {gameRecordId && (
                <div className="game-empty">
                  Игра #{gameRecordId}
                  {gameRecordStatus ? ` · ${gameRecordStatus}` : ""}
                </div>
              )}
            </div>
          )}
        </div>

        {shouldRenderDetailsFooterSubmit && (
          <button
            className={`game-submit ${detailsFooterSubmitDisabled ? "" : "active"}`}
            onClick={() => {
              if (shouldHandleMatchResultFromFooter) {
                if (!shouldSubmitMatchResultFromFooter) {
                  setGameDetailsMetaError("Введите счёт первого сета");
                  return;
                }
                void handleSubmitMatchResult();
                return;
              }
              onBack();
            }}
            type="button"
            disabled={detailsFooterSubmitDisabled}
          >
            {detailsFooterSubmitLabel}
          </button>
        )}
        <button
          type="button"
          className="details-debug-trigger"
          aria-label="Показать служебную информацию"
          onClick={handleDetailsServiceInfoTap}
        />
      </div>
    );
  }

  return (
    <div className="app-container game-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">
          Закрыть
        </button>
        <div className="page-title">Создание игры</div>
      </div>

      <div className="game-stack">
        <button
          className={`game-card game-card-place-step game-card-step1 ${isBookingPresetMode ? "disabled" : ""}`}
          onClick={() => {
            if (isBookingPresetMode) return;
            setStep("place");
          }}
          type="button"
          disabled={isBookingPresetMode}
        >
          <span className="game-card-step-corner">Шаг 1</span>
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {isBookingPresetMode
                  ? bookingPreset.studioName
                  : (studio ? studio.name : "Выберите станцию")}
              </div>
              {isBookingPresetMode && (
                <div className="game-card-sub">Станция фиксирована по брони</div>
              )}
              {!isBookingPresetMode && studio && (
                <div className="game-card-sub">{studio.address}</div>
              )}
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        <button
          className={`game-card game-card-place-step ${
            (isBookingPresetMode || studio) ? "" : "disabled"
          } ${isBookingPresetMode ? "disabled" : ""}`}
          onClick={() => {
            if (isBookingPresetMode || !studio) return;
            setStep("time");
          }}
          type="button"
          disabled={isBookingPresetMode || !studio}
        >
          <span className="game-card-step-corner">Шаг 2</span>
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {isBookingPresetMode
                  ? (bookingPresetDateLabel ? `Забронировано на ${bookingPresetDateLabel}` : "Бронь выбрана")
                  : (time && selectedDate ? `Забронировано на ${dateLabel}` : "Выбери корт и время")}
              </div>
              {isBookingPresetMode && (
                <div className="game-card-sub">{bookingPresetMeta}</div>
              )}
              {!isBookingPresetMode && time && selectedCourt && (
                <div className="game-card-sub">{`${time}, ${duration} мин · ${selectedCourt.name}`}</div>
              )}
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        {!isSinglesGame && (
          <div className="game-toggle-row">
            <div>
              <div className="game-toggle-title">Игра на уровень</div>
              <div className="game-toggle-sub">{ratingSubLabel}</div>
            </div>
            <button
              className={`switch ${ratingGame ? "on" : ""}`}
              onClick={() => setRatingGame((v) => !v)}
              type="button"
              aria-label="toggle rating"
            >
              <span />
            </button>
          </div>
        )}

        {effectiveRatingGame && (
          <div className="rating-card">
            <div className="game-card-title">Допустимый уровень соперников</div>
            <div className="rating-slider">
              <div
                className="rating-rail"
                style={
                  {
                    "--min": `${minPercent}%`,
                    "--max": `${maxPercent}%`,
                  } as CSSProperties
                }
              />
              <input
                className="rating-range rating-range-min"
                type="range"
                min={0}
                max={RATING_LABELS.length - 1}
                value={minRating}
                onChange={(e) =>
                  setMinRating(Math.min(Number(e.target.value), maxRating))
                }
              />
              <input
                className="rating-range rating-range-max"
                type="range"
                min={0}
                max={RATING_LABELS.length - 1}
                value={maxRating}
                onChange={(e) =>
                  setMaxRating(Math.max(Number(e.target.value), minRating))
                }
              />
              <div className="rating-labels">
                {RATING_LABELS.map((label, idx) => (
                  <span
                    key={label}
                    className={idx >= minRating && idx <= maxRating ? "active" : ""}
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {!isBookingPresetMode && (
          <div className="team-card">
            <div className="game-card-title">Команда</div>
            <div className="team-row">
              <div className="team-member">
                <div className="team-avatar-wrapper">
                  <svg className="team-avatar-ring" viewBox="0 0 60 60">
                    <circle
                      cx="30"
                      cy="30"
                      r="27"
                      fill="none"
                      stroke="#e5e7eb"
                      strokeWidth="4"
                    />
                    {Array.from({ length: ringSegments }, (_, idx) => {
                      const i = idx + 1;
                      const t = i / ringSegments;
                      const power = Math.pow(t, 3);
                      const segmentLength = 127 / ringSegments;
                      const start = idx * segmentLength;
                      const r = Math.round(180 + power * (53 - 180));
                      const g = Math.round(150 + power * (63 - 150));
                      const b = Math.round(255 + power * (185 - 255));
                      const isActive = idx < filledSegments;
                      return (
                        <circle
                          key={i}
                          cx="30"
                          cy="30"
                          r="27"
                          fill="none"
                          stroke={isActive ? `rgb(${r},${g},${b})` : "transparent"}
                          strokeWidth={isActive ? 0.3 + power * 10 : 0}
                          strokeDasharray={`${segmentLength} 169`}
                          strokeDashoffset={-start}
                          strokeLinecap="butt"
                          transform="rotate(90 30 30)"
                        />
                      );
                    })}
                  </svg>
                  {profilePhoto && !avatarError ? (
                    <img
                      src={profilePhoto}
                      alt="Аватар"
                      className="team-avatar-img"
                      onError={() => setAvatarError(true)}
                    />
                  ) : (
                    <div className="team-avatar-fallback">
                      {initials || "Вы"}
                    </div>
                  )}
                  <div className="team-avatar-badge">{profileGrade}</div>
              </div>
              <div className="team-name">{profileName}</div>
              <span className="team-badge">Вы</span>
            </div>
              {Array.from({ length: createInviteSlotsCount }, (_, index) => index + 1).map((i) => (
                <div key={i} className="team-member empty">
                  <div className="team-avatar">+</div>
                  <div className="team-name">Слот</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="game-toggle-row">
          <div>
            <div className="game-toggle-title">
              {isPrivate ? "Приватная" : "Открытая игра"}
            </div>
            <div className="game-toggle-sub">
              {isPrivate
                ? "Присоединиться смогут только те, у кого есть ссылка"
                : "Игра будет опубликована в общем списке и доступна другим игрокам для присоединения."}
            </div>
          </div>
          <button
            className={`switch ${!isPrivate ? "on" : ""}`}
            onClick={() => setIsPrivate((v) => !v)}
            type="button"
            aria-label="toggle game visibility"
            aria-pressed={!isPrivate}
          >
            <span />
          </button>
        </div>
        {!isBookingPresetMode && (
          <div className="game-toggle-row">
            <div>
              <div className="game-toggle-title">Тип оплаты</div>
              <div className="game-toggle-sub">{paymentModeSubLabel}</div>
            </div>
            <button
              className={`switch ${splitPaymentSelected ? "on" : ""}`}
              onClick={handlePaymentModeSwitchTap}
              type="button"
              aria-label="toggle payment mode"
            >
              <span />
            </button>
          </div>
        )}
        {splitPaymentAvailabilityLabel && (
          <div className={`game-empty${splitPaymentAvailabilityLabelIsError ? " game-pay-error" : ""}`}>
            {splitPaymentAvailabilityLabel}
          </div>
        )}

        {ENABLE_GAME_COMMUNITY_AUTOPUBLISH && (
          <div className="team-card game-autopublish-panel">
            <div className="game-card-title">Публикация в сообщества</div>
            <div className="game-autopublish-row" role="group" aria-label="Выбор сообществ для публикации">
              {communityAutopublishCards.map((community) => (
                <label
                  key={community.key}
                  className={`team-member game-autopublish-card${community.selected ? " is-selected" : ""}${community.selectable ? "" : " is-disabled"}`}
                >
                  <input
                    type="checkbox"
                    className="game-autopublish-card-input"
                    checked={community.selected}
                    disabled={!community.selectable}
                    onChange={() => {
                      if (!community.communityId || !community.selectable) return;
                      toggleCommunityAutopublishSelection(community.communityId);
                    }}
                  />
                  <span className="game-autopublish-card-check" aria-hidden="true" />
                  <div className="game-autopublish-card-avatar">
                    {renderCommunityAutopublishAvatar({
                      name: community.name,
                      logo: community.logo,
                    })}
                  </div>
                  <div className="game-autopublish-card-name">{community.name}</div>
                </label>
              ))}
            </div>
            {!communityAutopublishLoading
            && !communityAutopublishError
            && communityAutopublishCards.every((community) => !community.selectable) && (
              <div className="game-autopublish-panel-meta">
                Подходящие сообщества пока не найдены. Игра создастся без автопубликации в ленту.
              </div>
            )}
            {communityAutopublishError && (
              <div className="game-autopublish-panel-error">{communityAutopublishError}</div>
            )}
          </div>
        )}

        {showPublicationFields && (
          <div className="team-card game-publish-fields">
            <div className="game-publish-fields-note">
              {publicationFieldsNote}
            </div>
            <div className="game-card-title">Данные для публикации</div>
            <div className="game-publish-fields-stack">
              <label className="game-publish-field">
                <span className="game-publish-field-label">Название игры</span>
                <input
                  type="text"
                  className="game-input"
                  placeholder="Например, вечерний матч на счёт"
                  value={gameTitleDraft}
                  onChange={(event) => setGameTitleDraft(event.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <label className="game-publish-field">
                <span className="game-publish-field-label">Комментарий для участников</span>
                <textarea
                  className="game-input game-textarea"
                  placeholder="Что важно знать участникам перед матчем"
                  value={gameParticipantCommentDraft}
                  onChange={(event) => setGameParticipantCommentDraft(event.target.value)}
                  maxLength={280}
                  rows={4}
                  required
                />
              </label>
              <label className="game-publish-field">
                <span className="game-publish-field-label">Стоимость присоединения к игре</span>
                <input
                  type="text"
                  className="game-input"
                  placeholder={splitPaymentSelected ? "Рассчитывается автоматически" : "Например, 2000"}
                  value={gameJoinPriceDraft}
                  onChange={(event) => {
                    if (splitPaymentSelected) return;
                    const nextValue = event.target.value.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
                    setGameJoinPriceDraft(nextValue);
                  }}
                  inputMode="numeric"
                  maxLength={8}
                  readOnly={splitPaymentSelected}
                />
              </label>
            </div>
          </div>
        )}

        {showInlinePaymentSection && (
          <div className="game-payment-stack">
            {splitPaymentAvailable && splitPaymentSelected && (
              <div className="game-split-payment-panel">
                <div className="game-split-payment-summary">
                  <span>{splitPaymentSummary}</span>
                </div>
              </div>
            )}
            {splitPaymentSelected && splitHasEligibleSubscriptions && (
              <button
                className="section-cta section-cta-secondary"
                onClick={() => {
                  void handleSplitGamePay("subscription");
                }}
                type="button"
                disabled={!canProceedToPayment || loadingPay || splitSubscriptionsLoading}
              >
                {loadingPay ? "Списать с абонемента · подготовка..." : "Списать с абонемента"}
              </button>
            )}
            <button
              className={`game-submit game-submit-booking game-submit-inline ${canProceedToPayment ? "active" : ""}`}
              onClick={() => {
                if (splitPaymentSelected) {
                  void handleSplitGamePay(splitHasEligibleSubscriptions ? "one_time" : undefined);
                } else {
                  void handleMasterServicePay();
                }
              }}
              type="button"
              disabled={!canProceedToPayment || loadingPay}
            >
              <span className="game-submit-main">{paymentSubmitTitle}</span>
              <span className="game-submit-meta">{paymentStationCourt}</span>
              <span className="game-submit-meta">{paymentTimeRange}</span>
            </button>
            {!splitPaymentSelected && (
              <>
                <button
                  className={`game-promo-trigger ${promoCodeApplied ? "applied" : ""}`}
                  onClick={() => {
                    setPromoError(null);
                    setPromoModalOpen(true);
                  }}
                  type="button"
                >
                  у меня есть промокод
                </button>
                {promoCodeApplied && (
                  <div className="game-promo-status">
                    {promoStatusMessage || `Промокод ${promoCodeApplied} применен`}
                    {promoDiscountAmount != null
                      && promoDiscountAmount > 0
                      && basePaymentAmount != null
                      && promoPricePreview != null && (
                        <span className="game-promo-status-amount">
                          Было {formatPrice(basePaymentAmount)} ₽, стало {formatPrice(promoPricePreview)} ₽
                        </span>
                      )}
                  </div>
                )}
              </>
            )}
            {payError && <div className="game-empty game-pay-error">{payError}</div>}
          </div>
        )}

        {isBookingPresetMode && (
          <button
            className={`section-cta ${inviteLink ? "" : "section-cta-secondary"}`}
            onClick={handleCopyInvite}
            type="button"
            disabled={!inviteLink}
          >
            {inviteCopied
              ? "Ссылка скопирована"
              : (inviteLink ? "Скопировать ссылку приглашения" : "Ссылка появится после создания")}
          </button>
        )}
      </div>

      {isBookingPresetMode && (
        <button
          className={`game-submit ${canContinueGameCreation && !loadingPay ? "active" : ""}`}
          onClick={handleCreateGame}
          type="button"
          disabled={!canContinueGameCreation || loadingPay || creatingFromBooking}
        >
          {creatingFromBooking ? "Создаем..." : "Создать"}
        </button>
      )}
      {isBookingPresetMode && gameRecordError && (
        <div className="game-empty game-pay-error">{gameRecordError}</div>
      )}

      <Modal
        isOpen={promoModalOpen}
        onClose={() => {
          setPromoModalOpen(false);
          setPromoError(null);
        }}
        title="Промокод"
      >
        <div className="game-promo-modal">
          <div className="game-promo-note">
            Введите промокод для выбранного слота, затем нажмите «Применить».
          </div>
          <input
            className="game-input"
            type="text"
            value={promoCodeDraft}
            onChange={(e) => {
              setPromoCodeDraft(e.target.value);
              setPromoError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !applyingPromo) {
                e.preventDefault();
                void handleApplyPromoCode();
              }
            }}
            placeholder="Введите промокод"
            autoFocus
          />
          {promoError && <div className="game-empty game-pay-error game-promo-feedback">{promoError}</div>}
          {!promoError && promoCodeApplied && promoStatusMessage && (
            <div className="game-promo-status game-promo-feedback">{promoStatusMessage}</div>
          )}
          <button
            className="section-cta"
            onClick={() => {
              void handleApplyPromoCode();
            }}
            type="button"
            disabled={applyingPromo || !canProceedToPayment}
          >
            {applyingPromo ? "Применяем..." : "Применить"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
