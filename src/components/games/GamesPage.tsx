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
  PadelGameResultActionResponse,
  PadelGameResultSessionResponse,
  PadelSplitPaymentPromoConfig,
  Subscription,
  Studio,
  StudioGameModes,
} from "../../utils/apiClient";
import {
  apiCheckMasterServicePromoCode,
  apiCancelPadelSelfRemovalBookings,
  apiFetchMasterServicePromoDiscounts,
  apiFetchBookings,
  apiFetchExerciseById,
  apiFetchMasterServiceGameModes,
  apiCreatePadelGameRecord,
  apiCreatePadelSplitGamePayment,
  apiCreatePadelSplitParticipantPayment,
  apiCancelPadelSplitParticipantBookings,
  apiCleanupPadelGameByOrganizer,
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
  apiFetchTournamentParticipants,
  apiFetchPadelSplitPaymentPromoConfig,
  apiFetchSubscriptioName,
  apiFetchProfile,
  apiAcceptPadelGameResultCorrection,
  apiConfirmPadelGameResult,
  apiDisputePadelGameResult,
  apiExpirePadelGameResult,
  apiFetchPadelGameResultState,
  apiOpenPadelGameResultSession,
  apiSubmitPadelGameResult,
  apiUpdatePadelGameResultSession,
  DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG,
  isPadelGameRecordRelevantToIdentity,
  resolveExerciseCancellationState,
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
  normalizeLevelGradeLabel,
  parseNumericLevel,
} from "../../utils/customFields";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import { pushCabinetFlashNotice } from "../../utils/cabinetFlashNotice";
import type { GamesCreateFromBookingData } from "../../types/gamesOverlay";
import { resolveSplitPaymentOccupancy } from "./splitPaymentOccupancy";
import {
  CABINET_URL,
  GAMES_BUNDLE_URL,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";
import { trackAnalyticsEvent } from "../../utils/analytics";
import { shareOrCopyGameInvitePayload } from "../../utils/gameInviteClipboard";
import { addGameToCalendar } from "../../utils/calendarEvent";
import { resolveSubscriptionUsageDisplay } from "../../utils/subscriptionValidity";
import logoHabBlack from "../../assets/logo hab black.svg";
import logoHabBlackRaw from "../../assets/logo hab black.svg?raw";
import logoHabWhite from "../../assets/logo hab white.svg";
import logoHabWhiteRaw from "../../assets/logo hab white.svg?raw";
import { SummerSubscriptionGallery } from "../UI/SummerSubscriptionGallery";
import {
  excludePlayersAlreadyInRoster,
  playersShareRosterIdentity,
  reconcileRosterWithViva,
  type RosterSyncLeaveEvent,
} from "./rosterSyncReconcile";
import {
  buildGameAllRelatedPhones,
  shouldSkipRecentPaidGameBackgroundSync,
  shouldSkipRecentSplitGameRosterSync,
} from "./recentPaidGameStability";
import {
  appendGameSelfRemovalAuditLog,
  buildGameSelfRemovalAuditEntry,
  type GameSelfRemovalAuditStatus,
  type GameSelfRemovalAuditVerification,
} from "../../utils/gameSelfRemoval";
import { isSyntheticCabinetBookingGame } from "../cabinet/syntheticBookingGame";
import {
  filterSplitEligibleSubscriptions,
  isNoSubscriptionsAvailableError,
  resolveSplitSubscriptionLifecycle,
  resolveSplitSubscriptionUnavailableMessage,
} from "./splitSubscriptionAvailability";
import {
  SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
  resolveSubscriptionCategoryDailyLimitConflictFromBookings,
  resolveSubscriptionCategoryDailyLimitErrorMessage,
  subscriptionPlanAllowsDailyLimitCategory,
  withSubscriptionCategoryDailyLimitResolvedName,
} from "../../utils/subscriptionCategoryDailyLimit";
import {
  isExerciseConvertibleToGameFromBooking,
  resolveExerciseCategoryFromValue,
} from "../../utils/exerciseCategory";

interface GamesPageProps {
  onBack: () => void;
  openChat?: boolean;
  openGameId?: string | null;
  createFromBooking?: GamesCreateFromBookingData | null;
  initialGameRecord?: PadelGameRecord | null;
  publicCreateEntry?: boolean;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
}

type Step = "create" | "place" | "time" | "details" | "chat";
type GamePaymentMode = "self" | "split";
type SplitShareCount = 2 | 4;
type SplitCheckoutMode = "subscription" | "one_time";

const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"];
const PRECISE_RATING_GRADE_OPTIONS = ["D", "C", "B", "A"] as const;
const PRECISE_RATING_LEVEL_OPTIONS = [0, 1, 2, 3, 4] as const;

type PublicCreatePreciseRatingGrade = (typeof PRECISE_RATING_GRADE_OPTIONS)[number];
type PublicCreatePreciseRatingLevel = (typeof PRECISE_RATING_LEVEL_OPTIONS)[number];

type PublicCreatePreciseRatingBound = {
  grade: PublicCreatePreciseRatingGrade;
  level: PublicCreatePreciseRatingLevel;
};

type PublicCreatePreciseRatingRange = {
  min: PublicCreatePreciseRatingBound;
  max: PublicCreatePreciseRatingBound;
};

const PUBLIC_CREATE_COARSE_RATING_BUCKETS: Array<{
  label: typeof RATING_LABELS[number];
  min: PublicCreatePreciseRatingBound;
  max: PublicCreatePreciseRatingBound;
}> = [
  { label: "D", min: { grade: "D", level: 0 }, max: { grade: "D", level: 1 } },
  { label: "D+", min: { grade: "D", level: 2 }, max: { grade: "D", level: 4 } },
  { label: "C", min: { grade: "C", level: 0 }, max: { grade: "C", level: 1 } },
  { label: "C+", min: { grade: "C", level: 2 }, max: { grade: "C", level: 4 } },
  { label: "B", min: { grade: "B", level: 0 }, max: { grade: "B", level: 1 } },
  { label: "B+", min: { grade: "B", level: 2 }, max: { grade: "B", level: 4 } },
  { label: "A", min: { grade: "A", level: 0 }, max: { grade: "A", level: 4 } },
];

const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const MAX_DOUBLES_PLAYERS = 4;
const MAX_SINGLES_PLAYERS = 2;
const SELF_REMOVE_SUCCESS_NOTICE = "Вы вышли из игры. 1 посещение вернули в абонемент.";
const DETAILS_TEAM_SLOTS_COUNT = 4;
const MAX_MATCH_RESULT_ATTACHMENTS = 6;
const MATCH_RESULT_DRAFT_FLUSH_TIMEOUT_MS = 750;
const MATCH_RESULT_IMAGE_MAX_SIDE = 1600;
const MATCH_RESULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MATCH_RESULT_DISPUTE_OVERRIDE_START_TS = Date.parse("2026-05-31T00:00:00+03:00");
const MATCH_RESULT_DISPUTE_OVERRIDE_END_TS = Date.parse("2026-06-10T23:59:59.999+03:00");
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
const SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES = 10;
const SPLIT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const SPLIT_OPEN_GAME_DIRECTION_ID = 4588;
const PUBLIC_CREATE_SUBSCRIPTION_INFO_URL = "https://padlhub.ru/ab_leto";

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

function resolveSplitSubscriptionVisitCharge(durationMinutes: number | null | undefined): number {
  const normalizedDuration = Number.isFinite(durationMinutes)
    ? Math.max(0, Math.floor(Number(durationMinutes)))
    : 0;
  return normalizedDuration >= 90 ? 2 : 1;
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

function subscriptionMatchesSplitStudio(
  subscription: Subscription,
  selectedStudioId: string | null | undefined,
): boolean {
  if (!subscription.hasStudioLimitation) return true;

  const allowedStudios = new Set(
    (subscription.availableStudios || [])
      .map((item) => normalizeComparableId(item?.id))
      .filter((value): value is string => Boolean(value)),
  );
  if (allowedStudios.size === 0) return false;

  const normalizedSelectedStudioId = normalizeComparableId(selectedStudioId);
  if (!normalizedSelectedStudioId) return true;

  return allowedStudios.has(normalizedSelectedStudioId);
}

function subscriptionMatchesSplitCategory(
  subscription: Subscription,
  requiredExerciseTypeIds: Set<string>,
  requiredDirectionIds: Set<string>,
  selectedStudioId: string | null | undefined,
): boolean {
  if (!subscriptionMatchesSplitStudio(subscription, selectedStudioId)) {
    return false;
  }

  const allowedTypes = new Set(
    (subscription.availableTypes || [])
      .map((item) => normalizeComparableId(item?.id))
      .filter((value): value is string => Boolean(value)),
  );
  const hasOpenGameTypeByName = (subscription.availableTypes || []).some((item) => {
    const normalizedName = normalizeComparableName(item?.name);
    return Boolean(normalizedName && normalizedName.includes("открытая игра"));
  });

  // For split-open-game flow we only show subscriptions explicitly allowing open games.
  if (!subscription.hasTypeLimitation) {
    return false;
  }
  if (!hasIdIntersection(allowedTypes, requiredExerciseTypeIds) && !hasOpenGameTypeByName) {
    return false;
  }

  // Direction constraints from subscription list are often stale/non-deterministic
  // for open-game split booking. Keep type check strict and let Viva validate
  // direction on actual booking/payment step.
  void requiredDirectionIds;

  return true;
}

function resolveSplitSubscriptionDisplayName(
  subscription: Subscription,
  subscriptionNamesById: Record<string, string>,
): string {
  const key = normalizeComparableId(subscription.subscriptionId);
  const byLookup = key ? subscriptionNamesById[key] : null;
  const directName = typeof subscription.name === "string" ? subscription.name : null;
  const resolved = String(byLookup || directName || "").trim();
  return resolved || "Абонемент";
}

async function resolveSplitSubscriptionDailyLimitCandidate(
  subscription: Subscription | null,
  subscriptionNamesById: Record<string, string>,
  phone: string | null | undefined,
): Promise<unknown> {
  if (!subscription) return null;

  const subscriptionId = String(subscription.subscriptionId || "").trim();
  const key = normalizeComparableId(subscriptionId);
  let resolvedName = key ? subscriptionNamesById[key] : null;

  if (!resolvedName && subscriptionId && phone) {
    try {
      const response = await apiFetchSubscriptioName(subscriptionId, phone);
      resolvedName = String(response.data?.sertName || "").trim() || null;
    } catch {
      resolvedName = null;
    }
  }

  return withSubscriptionCategoryDailyLimitResolvedName(subscription, resolvedName);
}

function formatSplitSubscriptionValidityLabel(
  subscription: Subscription,
  subscriptionName: string,
  options: { includePrefix?: boolean } = {},
): string | null {
  if (resolveSplitSubscriptionLifecycle(subscription, null) === "NEW_FIRST_USE_CANDIDATE") {
    return "активируется при первой записи";
  }
  return resolveSubscriptionUsageDisplay({
    subscriptionName,
    validityDate: subscription.expirationDate,
    visitsLeft: subscription.visitsLeft,
    validityPrefix: options.includePrefix ? "действует до" : "до",
    visitsPrefix: options.includePrefix ? "осталось" : "",
  })?.label ?? null;
}

function buildSplitSubscriptionStatusLabel(
  subscriptions: Subscription[],
  subscriptionNamesById: Record<string, string>,
  requiredVisits: number,
): string {
  const primary = subscriptions[0];
  if (!primary) return "Найдено доступных абонементов: 0";

  const name = resolveSplitSubscriptionDisplayName(primary, subscriptionNamesById);
  const balanceLabel = formatSplitSubscriptionValidityLabel(primary, name, { includePrefix: true });
  const visitsToWriteLabel = requiredVisits > 1 ? ` · списание: ${requiredVisits} посещ.` : "";
  const extraCount = Math.max(0, subscriptions.length - 1);
  const extraLabel = extraCount > 0 ? ` · еще ${extraCount}` : "";

  if (balanceLabel) {
    return `Абонемент «${name}» · ${balanceLabel}${visitsToWriteLabel}${extraLabel}`;
  }
  return `Абонемент «${name}»${visitsToWriteLabel}${extraLabel}`;
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
  options: { allowStationWithoutMembership?: boolean } = {},
): CommunityAutopublishSelectionState {
  const selectableIds = new Set<string>([
    ...(
      snapshot.stationTarget
      && (snapshot.stationTarget.isOrganizerMember || options.allowStationWithoutMembership)
        ? [snapshot.stationTarget.id]
        : []
    ),
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
      return appendCurrentAuthModeToNavigableUrl(normalized).toString();
    }

    if (!isLocalHostname(parsed.hostname)) {
      return appendCurrentAuthModeToNavigableUrl(parsed).toString();
    }

    const publicOrigin = resolvePublicGamesOrigin(currentUrl);
    const normalized = new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, publicOrigin);
    return appendCurrentAuthModeToNavigableUrl(normalized).toString();
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
    return appendCurrentAuthModeToNavigableUrl(url).toString();
  } catch {
    const fallback = (CABINET_URL || "").trim() || window.location.href || "";
    return fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : null;
  }
}

function navigateToCabinetFromGamesDetails(): boolean {
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
        window.location.href = appendCurrentAuthModeToNavigableUrl(
          new URL(fromQuery, currentUrl.origin),
        ).toString();
        return true;
      }
    } catch {
      // fallback below
    }
    if (fallbackCabinetUrl) {
      window.location.href = appendCurrentAuthModeToNavigableUrl(fallbackCabinetUrl).toString();
      return true;
    }
  }

  return false;
}

function buildInviteFallbackUrl(gameId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = resolveInviteCabinetBaseUrl();
    if (!url) return null;
    url.searchParams.set("joinGame", gameId);
    return appendCurrentAuthModeToNavigableUrl(url).toString();
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

function trackRosterSyncEvent(
  type: "started" | "applied" | "skipped" | "failed",
  payload: Record<string, unknown>,
) {
  trackAnalyticsEvent(`games_roster_sync_${type}`, payload);
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
  memberKey?: string | null;
  id?: string | null;
  phone?: string | null;
  name?: string | null;
};

type EditableMatchResultSet = {
  left: string;
  right: string;
};

type MatchResultLifecycleStatus =
  | "NO_RESULT"
  | "PENDING_REVIEW"
  | "CONFIRMED"
  | "DISPUTED"
  | "CORRECTION_PENDING"
  | "NO_RESULT_EXPIRED";

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

type GameLeaveEvent = RosterSyncLeaveEvent;

type VivaParticipantCancelOutcome = {
  ok: boolean;
  bookingIds: string[];
  summary: Record<string, unknown> | null;
  error: string | null;
};

type SelfRemovalVivaCancellationOutcome = VivaParticipantCancelOutcome & {
  auditStatus: GameSelfRemovalAuditStatus;
  verification: GameSelfRemovalAuditVerification;
  trace: unknown[];
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
  syncSignature: string | null;
  auditEventIds: string[];
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

function clampRatingWheelIndex(value: number): number {
  return clampNumber(Math.round(value), 0, RATING_LABELS.length - 1);
}

function normalizePreciseRatingGrade(value: unknown): PublicCreatePreciseRatingGrade {
  const normalized = String(value || "").trim().toUpperCase();
  if (PRECISE_RATING_GRADE_OPTIONS.includes(normalized as PublicCreatePreciseRatingGrade)) {
    return normalized as PublicCreatePreciseRatingGrade;
  }
  return "D";
}

function normalizePreciseRatingLevel(value: unknown): PublicCreatePreciseRatingLevel {
  const numeric = Math.round(toFiniteNumber(value) ?? 0);
  if (PRECISE_RATING_LEVEL_OPTIONS.includes(numeric as PublicCreatePreciseRatingLevel)) {
    return numeric as PublicCreatePreciseRatingLevel;
  }
  return 0;
}

function comparePreciseRatingBounds(
  left: PublicCreatePreciseRatingBound,
  right: PublicCreatePreciseRatingBound,
): number {
  const gradeDelta = PRECISE_RATING_GRADE_OPTIONS.indexOf(left.grade) - PRECISE_RATING_GRADE_OPTIONS.indexOf(right.grade);
  if (gradeDelta !== 0) return gradeDelta;
  return left.level - right.level;
}

function clonePreciseRatingBound(bound: PublicCreatePreciseRatingBound): PublicCreatePreciseRatingBound {
  return {
    grade: bound.grade,
    level: bound.level,
  };
}

function isSamePreciseRatingRange(
  left: PublicCreatePreciseRatingRange,
  right: PublicCreatePreciseRatingRange,
): boolean {
  return left.min.grade === right.min.grade
    && left.min.level === right.min.level
    && left.max.grade === right.max.grade
    && left.max.level === right.max.level;
}

function normalizePreciseRatingRangeAfterBoundChange(
  range: PublicCreatePreciseRatingRange,
  changedBound: "min" | "max",
): PublicCreatePreciseRatingRange {
  if (comparePreciseRatingBounds(range.min, range.max) <= 0) return range;
  if (changedBound === "min") {
    return {
      min: clonePreciseRatingBound(range.min),
      max: clonePreciseRatingBound(range.min),
    };
  }
  return {
    min: clonePreciseRatingBound(range.max),
    max: clonePreciseRatingBound(range.max),
  };
}

function buildPreciseRatingRangeFromCoarse(
  minIndex: number,
  maxIndex: number,
): PublicCreatePreciseRatingRange {
  const safeMinIndex = clampRatingWheelIndex(Math.min(minIndex, maxIndex));
  const safeMaxIndex = clampRatingWheelIndex(Math.max(minIndex, maxIndex));
  const minBucket = PUBLIC_CREATE_COARSE_RATING_BUCKETS[safeMinIndex] ?? PUBLIC_CREATE_COARSE_RATING_BUCKETS[0];
  const maxBucket = PUBLIC_CREATE_COARSE_RATING_BUCKETS[safeMaxIndex] ?? PUBLIC_CREATE_COARSE_RATING_BUCKETS[PUBLIC_CREATE_COARSE_RATING_BUCKETS.length - 1];
  return {
    min: clonePreciseRatingBound(minBucket.min),
    max: clonePreciseRatingBound(maxBucket.max),
  };
}

function mapPreciseRatingBoundToCoarseIndex(bound: PublicCreatePreciseRatingBound): number {
  const matchedIndex = PUBLIC_CREATE_COARSE_RATING_BUCKETS.findIndex((bucket) => (
    comparePreciseRatingBounds(bound, bucket.min) >= 0
      && comparePreciseRatingBounds(bound, bucket.max) <= 0
  ));
  return matchedIndex >= 0 ? matchedIndex : 0;
}

function formatPreciseRatingBoundLabel(bound: PublicCreatePreciseRatingBound): string {
  return `${bound.grade} ${bound.level}`;
}

function buildPreciseRatingMetadataFields(
  enabled: boolean,
  range: PublicCreatePreciseRatingRange,
  touched: boolean,
): Record<string, unknown> {
  if (!enabled || !touched) return {};

  return {
    ratingRangePrecise: {
      minGrade: range.min.grade,
      minLevel: range.min.level,
      maxGrade: range.max.grade,
      maxLevel: range.max.level,
      minLabel: formatPreciseRatingBoundLabel(range.min),
      maxLabel: formatPreciseRatingBoundLabel(range.max),
      touched: true,
    },
  };
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
  const syncSignature = typeof payload.syncSignature === "string"
    ? payload.syncSignature.trim() || null
    : null;
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
  const rawAuditEventIds = Array.isArray(payload.auditEventIds)
    ? payload.auditEventIds
    : Array.isArray(payload.auditIds)
      ? payload.auditIds
      : [];
  const auditEventIds = rawAuditEventIds
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => item.length > 0);

  if (
    !status
    && attempts === 0
    && !lastAttemptAt
    && !lastSuccessAt
    && !lastError
    && !syncSignature
    && totalPlayers === 0
    && syncedPlayers === 0
    && failures.length === 0
    && auditEventIds.length === 0
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
    syncSignature,
    auditEventIds,
  };
}

function normalizeMatchResultFromActionResponse(
  response: PadelGameResultActionResponse | null | undefined,
): Record<string, unknown> | null {
  if (!response) return null;
  const gameMatchResult = isRecordObject(response.game?.metadata?.matchResult)
    ? response.game.metadata.matchResult
    : null;
  const raw = (
    isRecordObject(response.matchResult)
      ? response.matchResult
      : isRecordObject(response.result)
        ? response.result
        : isRecordObject(response.latestResult)
          ? response.latestResult
          : gameMatchResult
            ? gameMatchResult
          : null
  );
  const status = normalizeMatchResultStatus(raw?.status ?? response.status);
  if (!raw) {
    if (!status) return null;
    return {
      status,
      ...(response.resultId ? { resultId: response.resultId, id: response.resultId } : {}),
      ...(response.disputeDeadlineAt ? { disputeDeadlineAt: response.disputeDeadlineAt } : {}),
    };
  }

  const nextMatchResult: Record<string, unknown> = {
    ...raw,
    ...(status ? { status } : {}),
  };

  if (
    !Array.isArray(nextMatchResult.setPairings)
    && Array.isArray(raw.effectiveSetPairings)
  ) {
    nextMatchResult.setPairings = raw.effectiveSetPairings;
  }

  const rawScore = isRecordObject(raw.score) ? raw.score : null;
  if (!Array.isArray(nextMatchResult.sets) && rawScore) {
    const scoreA = toFiniteNumber(rawScore.teamA ?? rawScore.scoreA ?? rawScore.left ?? rawScore.score1);
    const scoreB = toFiniteNumber(rawScore.teamB ?? rawScore.scoreB ?? rawScore.right ?? rawScore.score2);
    if (scoreA != null && scoreB != null) {
      nextMatchResult.sets = [{ left: scoreA, right: scoreB }];
    }
  }

  if (!nextMatchResult.disputeDeadlineAt && response.disputeDeadlineAt) {
    nextMatchResult.disputeDeadlineAt = response.disputeDeadlineAt;
  }

  return nextMatchResult;
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

function hasSplitPaymentSignal(splitPayment: Record<string, unknown> | null): boolean {
  if (!splitPayment) return false;
  if (splitPayment.enabled === true) return true;
  if (splitPayment.enabled === false) return false;

  const mode = typeof splitPayment.mode === "string" ? splitPayment.mode.trim().toLowerCase() : "";
  if (mode.includes("split") || mode.includes("group")) return true;

  const payments = Array.isArray(splitPayment.payments) ? splitPayment.payments : [];
  if (payments.some((item) => isRecordObject(item))) return true;

  const paymentModes = Array.isArray(splitPayment.paymentModes) ? splitPayment.paymentModes : [];
  if (paymentModes.some((item) => typeof item === "string" && item.trim().length > 0)) return true;

  if (typeof splitPayment.subscriptionProductId === "string" && splitPayment.subscriptionProductId.trim()) return true;
  if (typeof splitPayment.oneTimeProductId === "string" && splitPayment.oneTimeProductId.trim()) return true;

  const shareCount = toFiniteNumber(splitPayment.shareCount);
  const shareAmount = toFiniteNumber(splitPayment.shareAmount ?? splitPayment.amount ?? splitPayment.toPay);
  const totalAmount = toFiniteNumber(splitPayment.totalAmount);
  const oneTimeBaseAmount = toFiniteNumber(splitPayment.oneTimeBaseAmount ?? splitPayment.baseShareAmount);
  if (
    (shareCount === 2 || shareCount === 4)
    && ((shareAmount ?? 0) > 0 || (totalAmount ?? 0) > 0 || (oneTimeBaseAmount ?? 0) > 0)
  ) {
    return true;
  }

  return false;
}

function isInactiveSplitPaymentStatus(statusRaw: unknown): boolean {
  const status = String(statusRaw || "").trim().toUpperCase();
  if (!status) return false;
  const inactiveMarkers = [
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
  ];
  return inactiveMarkers.some((marker) => status.includes(marker));
}

function extractSplitPaymentPhones(splitPayment: Record<string, unknown> | null): string[] {
  if (!splitPayment) return [];
  const payments = Array.isArray(splitPayment.payments)
    ? splitPayment.payments.filter((item) => isRecordObject(item))
    : [];
  const bucket = new Set<string>();

  payments.forEach((item) => {
    if (isInactiveSplitPaymentStatus(item.status)) return;
    const directPhone = normalizePhoneForGame(
      typeof item.phoneNorm === "string"
        ? item.phoneNorm
        : typeof item.clientPhoneNorm === "string"
          ? item.clientPhoneNorm
          : typeof item.phone === "string"
            ? item.phone
            : typeof item.clientPhone === "string"
              ? item.clientPhone
              : null,
    );
    if (directPhone) {
      bucket.add(directPhone);
    }
  });

  return Array.from(bucket);
}

function isSplitPaymentReservationActive(statusRaw: unknown): boolean {
  const status = String(statusRaw || "").trim().toUpperCase();
  if (!status) return true;
  return !isInactiveSplitPaymentStatus(status);
}

function normalizeMatchResultStatus(value: unknown): MatchResultLifecycleStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "PENDING_CONFIRMATION" || normalized === "PENDING_DISPUTE") {
    return "PENDING_REVIEW";
  }
  if (
    normalized === "NO_RESULT"
    || normalized === "PENDING_REVIEW"
    || normalized === "CONFIRMED"
    || normalized === "DISPUTED"
    || normalized === "CORRECTION_PENDING"
    || normalized === "NO_RESULT_EXPIRED"
  ) {
    return normalized;
  }
  return null;
}

function pickMatchResultString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function summarizeMatchResultParticipantRef(value: unknown) {
  if (!isRecordObject(value)) return null;
  const memberKey = normalizeMemberKey(
    pickMatchResultString(value, ["memberKey", "playerKey", "participantKey", "rosterMemberKey"]),
  );
  return {
    memberKey,
    id: pickMatchResultString(value, ["id", "clientId", "uuid"]),
    phone: normalizePhoneForGame(
      pickMatchResultString(value, ["phoneNorm", "phone", "clientPhone", "clientPhoneNorm"]),
    ),
    name: pickMatchResultString(value, ["name", "playerName", "clientName"]),
  };
}

function buildMatchResultParticipantLookupKeys(value: unknown): string[] {
  if (value === null || value === undefined) return [];

  if (typeof value === "string" || typeof value === "number") {
    const rawValue = String(value).trim();
    if (!rawValue) return [];
    const phone = normalizePhoneForGame(rawValue);
    return Array.from(new Set([
      buildPadelPlayerMemberLookupKey(rawValue),
      `id:${rawValue}`,
      phone ? `phone:${phone}` : "",
      `name:${rawValue.toLowerCase()}`,
    ].filter(Boolean)));
  }

  if (!isRecordObject(value)) return [];

  const id = pickMatchResultString(value, ["id", "clientId", "uuid"]);
  const phone = normalizePhoneForGame(
    pickMatchResultString(value, ["phoneNorm", "phone", "clientPhone", "clientPhoneNorm"]),
  );
  const name = pickMatchResultString(value, ["name", "playerName", "clientName"]);
  const memberKey = normalizeMemberKey(
    pickMatchResultString(value, ["memberKey", "playerKey", "participantKey", "rosterMemberKey"]),
  ) || buildFallbackPadelPlayerMemberKey({ id, phone, name });

  return Array.from(new Set([
    buildPadelPlayerMemberLookupKey(memberKey),
    id ? `id:${id}` : "",
    phone ? `phone:${phone}` : "",
    name ? `name:${name.trim().toLowerCase()}` : "",
  ].filter(Boolean)));
}

function normalizeMatchResultRosterPlayer(value: unknown): PadelGamePlayer | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string" || typeof value === "number") {
    const rawValue = String(value).trim();
    if (!rawValue) return null;
    const memberKey = normalizeMemberKey(rawValue) || buildFallbackPadelPlayerMemberKey({ id: rawValue });
    return {
      memberKey,
      id: null,
      name: "Игрок",
      phone: null,
      photo: null,
      rating: null,
      ratingNumeric: null,
    };
  }

  if (!isRecordObject(value)) return null;

  const id = pickMatchResultString(value, ["id", "clientId", "uuid"]);
  const phone = normalizePhoneForGame(
    pickMatchResultString(value, ["phoneNorm", "phone", "clientPhone", "clientPhoneNorm", "mobile"]),
  );
  const name = pickMatchResultString(value, [
    "name",
    "playerName",
    "clientName",
    "fullName",
    "displayName",
  ]);
  const photo = pickMatchResultString(value, ["photo", "avatar", "imageUrl"]);
  const ratingNumeric = normalizeRatingNumeric(
    toFiniteNumber(value.ratingNumeric ?? value.numericRating ?? value.levelNumeric),
  );
  const rating = pickMatchResultString(value, ["rating", "level", "grade", "levelLetter"])
    ?? mapNumericToRatingGrade(ratingNumeric);
  const sourceRaw = pickMatchResultString(value, ["source", "origin", "type"]);
  const statusRaw = pickMatchResultString(value, ["status", "state"]);
  const memberKey = normalizeMemberKey(
    pickMatchResultString(value, ["memberKey", "playerKey", "participantKey", "rosterMemberKey"]),
  ) || buildFallbackPadelPlayerMemberKey({ id, phone, name });

  if (!memberKey && !id && !phone && !name) return null;

  return {
    memberKey,
    id: id ?? null,
    name: name || "Игрок",
    phone: phone ?? null,
    photo: photo ?? null,
    rating: rating ?? null,
    ratingNumeric,
    source: sourceRaw ? (sourceRaw.toUpperCase() as PadelGamePlayer["source"]) : undefined,
    status: statusRaw ? (statusRaw.toUpperCase() as PadelGamePlayer["status"]) : undefined,
  };
}

function extractMatchResultSnapshotPlayers(value: unknown): PadelGamePlayer[] {
  if (!isRecordObject(value)) return [];

  const rawPlayers = [
    ...(Array.isArray(value.members) ? value.members : []),
    ...(Array.isArray(value.playerPool) ? value.playerPool : []),
    ...(Array.isArray(value.players) ? value.players : []),
    ...(Array.isArray(value.roster) ? value.roster : []),
    ...(Array.isArray(value.waitlist) ? value.waitlist : []),
    ...(Array.isArray(value.participants) ? value.participants : []),
    ...(Array.isArray(value.initialTeamSlots) ? value.initialTeamSlots : []),
  ];

  return dedupePlayersByIdentity(
    rawPlayers
      .map((item) => normalizeMatchResultRosterPlayer(item))
      .filter((item): item is PadelGamePlayer => Boolean(item)),
  );
}

function summarizeMatchResultSet(value: unknown) {
  if (!isRecordObject(value)) return null;
  const left = toFiniteNumber(value.left ?? value.teamA ?? value.scoreA ?? value.score1);
  const right = toFiniteNumber(value.right ?? value.teamB ?? value.scoreB ?? value.score2);
  if (left == null || right == null) return null;
  return { left, right };
}

function summarizeMatchResultSetPairing(value: unknown, fallbackIndex: number) {
  const rawSlots = isRecordObject(value)
    ? (
        Array.isArray(value.teamSlots)
          ? value.teamSlots
          : Array.isArray(value.slots)
            ? value.slots
            : []
      )
    : Array.isArray(value)
      ? value
      : [];
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) return null;
  return {
    setIndex: isRecordObject(value)
      ? (toFiniteNumber(value.setIndex) ?? ((toFiniteNumber(value.setNumber) ?? fallbackIndex + 1) - 1))
      : fallbackIndex,
    teamSlots: rawSlots.map(summarizeMatchResultParticipantRef),
  };
}

function summarizeMatchResultAttachment(value: unknown, fallbackIndex: number) {
  if (isRecordObject(value)) {
    return {
      id: pickMatchResultString(value, ["id"]),
      name: pickMatchResultString(value, ["name"]),
      type: pickMatchResultString(value, ["type", "mimeType"]),
      size: toFiniteNumber(value.size),
      createdAt: pickMatchResultString(value, ["createdAt"]),
    };
  }
  if (typeof value === "string" && value.trim()) {
    return { id: `url-${fallbackIndex}`, src: value.trim().slice(0, 96) };
  }
  return null;
}

function summarizeMatchResultRatingImpact(value: unknown, fallbackIndex: number) {
  if (!isRecordObject(value)) return null;
  return {
    id: pickMatchResultString(value, ["id", "clientId"]),
    phone: normalizePhoneForGame(pickMatchResultString(value, ["phoneNorm", "phone"])),
    team: pickMatchResultString(value, ["team"]),
    before: toFiniteNumber(value.before),
    after: toFiniteNumber(value.after),
    index: fallbackIndex,
  };
}

function buildMatchResultSourceKey(
  gameId: string | null | undefined,
  rawMatchResult: Record<string, unknown> | null,
): string {
  const keyPrefix = (gameId || "game").trim() || "game";
  if (!rawMatchResult) return `${keyPrefix}:empty`;

  const status = normalizeMatchResultStatus(rawMatchResult.status) ?? "NO_RESULT";
  const resultId = pickMatchResultString(rawMatchResult, ["id", "_id", "resultId"]);
  const submittedAt = pickMatchResultString(rawMatchResult, ["submittedAt", "createdAt"]);
  const confirmedAt = pickMatchResultString(rawMatchResult, ["confirmedAt"]);
  const disputedAt = pickMatchResultString(rawMatchResult, ["disputedAt"]);
  const disputeDeadlineAt = pickMatchResultString(rawMatchResult, ["disputeDeadlineAt", "reviewDeadlineAt"]);
  const sets = Array.isArray(rawMatchResult.sets)
    ? rawMatchResult.sets.map(summarizeMatchResultSet).filter(Boolean)
    : [];
  const setPairingsRaw = Array.isArray(rawMatchResult.setPairings)
    ? rawMatchResult.setPairings
    : Array.isArray(rawMatchResult.effectiveSetPairings)
      ? rawMatchResult.effectiveSetPairings
    : Array.isArray(rawMatchResult.pairings)
      ? rawMatchResult.pairings
      : [];
  const setPairings = setPairingsRaw
    .map(summarizeMatchResultSetPairing)
    .filter(Boolean);
  const attachmentsRaw = Array.isArray(rawMatchResult.photos)
    ? rawMatchResult.photos
    : Array.isArray(rawMatchResult.attachments)
      ? rawMatchResult.attachments
      : Array.isArray(rawMatchResult.images)
        ? rawMatchResult.images
        : [];
  const attachments = attachmentsRaw
    .map(summarizeMatchResultAttachment)
    .filter(Boolean);
  const ratingImpact = Array.isArray(rawMatchResult.ratingImpact)
    ? rawMatchResult.ratingImpact.map(summarizeMatchResultRatingImpact).filter(Boolean)
    : [];
  const ratingWork = isRecordObject(rawMatchResult.ratingWork)
    ? {
        status: pickMatchResultString(rawMatchResult.ratingWork, ["status"]),
        desiredState: pickMatchResultString(rawMatchResult.ratingWork, ["desiredState"]),
        appliedAt: pickMatchResultString(rawMatchResult.ratingWork, ["appliedAt"]),
        nextAttemptAt: pickMatchResultString(rawMatchResult.ratingWork, ["nextAttemptAt"]),
      }
    : null;
  const hasStoredResult = Boolean(
    resultId
    || submittedAt
    || confirmedAt
    || disputedAt
    || disputeDeadlineAt
    || sets.length
    || setPairings.length
    || attachments.length
    || ratingImpact.length
    || ratingWork?.status
  );

  if (status === "NO_RESULT" && !hasStoredResult) {
    return `${keyPrefix}:empty`;
  }

  return `${keyPrefix}:${JSON.stringify({
    status,
    resultId,
    submittedAt,
    confirmedAt,
    disputedAt,
    disputeDeadlineAt,
    sets,
    setPairings,
    attachments,
    ratingImpact,
    ratingWork,
  })}`;
}

function buildFallbackMatchResultFromGameRecord(
  record: PadelGameRecord | null | undefined,
): Record<string, unknown> | null {
  if (!record) return null;
  const status = normalizeMatchResultStatus(record.resultLifecycleState ?? record.resultStatus);
  if (!status) return null;
  return {
    id: record.resultId ?? null,
    resultId: record.resultId ?? null,
    status,
    submittedAt: record.lastResultAt ?? null,
  };
}

function getMatchResultPairingsArray(
  matchResult: Record<string, unknown> | null | undefined,
): unknown[] {
  if (!matchResult) return [];
  if (Array.isArray(matchResult.setPairings)) return matchResult.setPairings;
  if (Array.isArray(matchResult.effectiveSetPairings)) return matchResult.effectiveSetPairings;
  if (Array.isArray(matchResult.pairings)) return matchResult.pairings;
  return [];
}

function getMatchResultAttachmentsArray(
  matchResult: Record<string, unknown> | null | undefined,
): unknown[] {
  if (!matchResult) return [];
  if (Array.isArray(matchResult.photos)) return matchResult.photos;
  if (Array.isArray(matchResult.attachments)) return matchResult.attachments;
  if (Array.isArray(matchResult.images)) return matchResult.images;
  return [];
}

function mergeMatchResultWithSessionDraft(
  rawMatchResult: Record<string, unknown> | null,
  sessionDraftMatchResult: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!rawMatchResult) return sessionDraftMatchResult;
  if (!sessionDraftMatchResult) return rawMatchResult;

  const mergedMatchResult: Record<string, unknown> = {
    ...sessionDraftMatchResult,
    ...rawMatchResult,
  };

  if (
    (!Array.isArray(rawMatchResult.sets) || rawMatchResult.sets.length === 0)
    && Array.isArray(sessionDraftMatchResult.sets)
    && sessionDraftMatchResult.sets.length > 0
  ) {
    mergedMatchResult.sets = sessionDraftMatchResult.sets;
  }

  if (getMatchResultPairingsArray(rawMatchResult).length === 0) {
    const sessionDraftPairings = getMatchResultPairingsArray(sessionDraftMatchResult);
    if (sessionDraftPairings.length > 0) {
      mergedMatchResult.setPairings = sessionDraftPairings;
    }
  }

  if (getMatchResultAttachmentsArray(rawMatchResult).length === 0) {
    const sessionDraftAttachments = getMatchResultAttachmentsArray(sessionDraftMatchResult);
    if (sessionDraftAttachments.length > 0) {
      mergedMatchResult.attachments = sessionDraftAttachments;
    }
  }

  if (
    !isRecordObject(rawMatchResult.rosterSnapshot)
    && isRecordObject(sessionDraftMatchResult.rosterSnapshot)
  ) {
    mergedMatchResult.rosterSnapshot = sessionDraftMatchResult.rosterSnapshot;
  }

  return mergedMatchResult;
}

function isPendingMatchResultStatus(value: unknown): boolean {
  const normalized = normalizeMatchResultStatus(value);
  return normalized === "PENDING_REVIEW";
}

function isConfirmedMatchResultStatus(value: unknown): boolean {
  return normalizeMatchResultStatus(value) === "CONFIRMED";
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveSplitPaymentItemDeadlineAt(
  item: Record<string, unknown> | null | undefined,
  splitPayment: Record<string, unknown> | null,
): string | null {
  if (!item) return null;
  const directDeadline = typeof item.deadlineAt === "string" ? item.deadlineAt.trim() : "";
  if (directDeadline) return directDeadline;
  const directExpires = typeof item.expiresAt === "string" ? item.expiresAt.trim() : "";
  if (directExpires) return directExpires;
  const participantDeadline = typeof splitPayment?.participantDeadlineAt === "string"
    ? splitPayment.participantDeadlineAt.trim()
    : "";
  if (participantDeadline) return participantDeadline;
  const participantPaymentDeadline = typeof splitPayment?.participantPaymentDeadlineAt === "string"
    ? splitPayment.participantPaymentDeadlineAt.trim()
    : "";
  if (participantPaymentDeadline) return participantPaymentDeadline;
  return null;
}

function resolveSplitPaymentItemDeadlineTs(
  item: Record<string, unknown> | null | undefined,
  splitPayment: Record<string, unknown> | null,
): number | null {
  if (!item) return null;
  const explicitDeadlineTs = parseIsoTimestamp(resolveSplitPaymentItemDeadlineAt(item, splitPayment));
  const createdAtTs = parseIsoTimestamp(
    typeof item.createdAt === "string"
      ? item.createdAt
      : (typeof item.updatedAt === "string" ? item.updatedAt : null),
  );
  const fallbackDeadlineTs = createdAtTs == null
    ? null
    : createdAtTs + SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  if (explicitDeadlineTs != null) {
    return fallbackDeadlineTs == null ? explicitDeadlineTs : Math.min(explicitDeadlineTs, fallbackDeadlineTs);
  }
  return fallbackDeadlineTs;
}

function isSplitPaymentPendingExpired(
  item: Record<string, unknown> | null | undefined,
  splitPayment: Record<string, unknown> | null,
  nowTs = Date.now(),
): boolean {
  if (!item) return false;
  const status = String(item.status || "").trim().toUpperCase();
  if (status !== "PAYMENT_PENDING") return false;
  const deadlineTs = resolveSplitPaymentItemDeadlineTs(item, splitPayment);
  return deadlineTs != null && nowTs >= deadlineTs;
}

function formatSplitPaymentTimeLeft(valueMs: number): string {
  const safeMs = Math.max(0, valueMs);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function getMatchResultDisputeDeadlineAt(
  submittedAt: string | null | undefined,
  explicitDeadlineAt?: string | null | undefined,
  gameDateKey?: string | null | undefined,
): string | null {
  const gameDate = typeof gameDateKey === "string" ? gameDateKey.trim() : "";
  if (gameDate) {
    const gameDateTs = Date.parse(`${gameDate}T00:00:00+03:00`);
    if (
      Number.isFinite(gameDateTs)
      && gameDateTs >= MATCH_RESULT_DISPUTE_OVERRIDE_START_TS
      && gameDateTs <= MATCH_RESULT_DISPUTE_OVERRIDE_END_TS
    ) {
      return new Date(MATCH_RESULT_DISPUTE_OVERRIDE_END_TS).toISOString();
    }
  }

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
  ) {
    normalized.push({ left: "", right: "" });
  }

  return normalized;
}

function validateCompletedMatchResultSets(sets: EditableMatchResultSet[]): string | null {
  if (sets.length === 0) return "Введите хотя бы один завершенный сет";
  const normalizedScores = sets
    .map((setItem) => ({
      left: Number.parseInt(setItem.left, 10),
      right: Number.parseInt(setItem.right, 10),
    }))
    .filter((setItem) => Number.isFinite(setItem.left) && Number.isFinite(setItem.right));

  if (normalizedScores.length === 0) return "Введите хотя бы один завершенный сет";

  const hasDrawSet = normalizedScores.some((setItem) => setItem.left === setItem.right);
  if (hasDrawSet) return "Счет в сете не может быть равным";

  const hasNegativeSet = normalizedScores.some((setItem) => setItem.left < 0 || setItem.right < 0);
  if (hasNegativeSet) return "Счет в сете должен быть неотрицательным";

  const hasEmptyGap = sets.some((setItem, index) => (
    index < normalizedScores.length
    && (setItem.left.trim() === "" || setItem.right.trim() === "")
  ));
  if (hasEmptyGap) return "Заполните оба значения сета или удалите пустую строку";

  return null;
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
  return dedupePlayersByIdentity([...current, ...incoming]);
}

function mergePadelGameMetadata(
  current: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const currentMetadata = isRecordObject(current) ? current : null;
  const incomingMetadata = isRecordObject(incoming) ? incoming : null;
  if (!currentMetadata || !incomingMetadata) {
    return incoming ?? current ?? null;
  }
  return {
    ...currentMetadata,
    ...incomingMetadata,
    ...(
      !isRecordObject(incomingMetadata.matchResult) && isRecordObject(currentMetadata.matchResult)
        ? { matchResult: currentMetadata.matchResult }
        : {}
    ),
  };
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
    resultStatus: incoming.resultStatus ?? current.resultStatus ?? null,
    resultLifecycleState: incoming.resultLifecycleState ?? current.resultLifecycleState ?? null,
    resultId: incoming.resultId ?? current.resultId ?? null,
    lastResultAt: incoming.lastResultAt ?? current.lastResultAt ?? null,
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
    metadata: mergePadelGameMetadata(current.metadata, incoming.metadata),
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

function normalizeMemberKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function buildFallbackPadelPlayerMemberKey(player: {
  id?: string | null;
  phone?: string | null;
  name?: string | null;
} | null | undefined): string | null {
  if (!player) return null;
  const id = (player.id || "").trim();
  if (id) return `id:${id}`;
  const phone = normalizePhoneForGame(player.phone);
  if (phone) return `phone:${phone}`;
  const name = (player.name || "").trim().toLowerCase();
  if (name) return `name:${name}`;
  return null;
}

function buildPadelPlayerMemberLookupKey(memberKey: string | null | undefined): string {
  return memberKey ? `member:${memberKey}` : "";
}

function getPadelPlayerMemberKey(player: {
  memberKey?: string | null;
  id?: string | null;
  phone?: string | null;
  name?: string | null;
} | null | undefined): string {
  if (!player) return "";
  return (
    normalizeMemberKey(player.memberKey)
    || buildFallbackPadelPlayerMemberKey(player)
    || ""
  );
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
  return buildPadelPlayerMemberLookupKey(getPadelPlayerMemberKey(player));
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
  memberKey?: string | null;
  id?: string | null;
  phone?: string | null;
  name?: string | null;
}) {
  const keys: string[] = [];
  const memberKey = getPadelPlayerMemberKey(player);
  const id = (player.id || "").trim();
  const phone = normalizePhoneForGame(player.phone);
  const name = (player.name || "").trim().toLowerCase();
  if (memberKey) keys.push(buildPadelPlayerMemberLookupKey(memberKey));
  if (id) keys.push(`id:${id}`);
  if (phone) keys.push(`phone:${phone}`);
  if (name) keys.push(`name:${name}`);
  return Array.from(new Set(keys.filter(Boolean)));
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
  type PlayerAggregate = {
    player: PadelGamePlayer;
    ids: Set<string>;
    phones: Set<string>;
    names: Set<string>;
  };

  const normalizeName = (value: string | null | undefined): string | null => {
    const normalized = String(value || "")
      .toLowerCase()
      .replace(/ё/g, "е")
      .replace(/[^a-zа-я0-9\s-]/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return normalized || null;
  };
  const isGenericName = (value: string | null | undefined): boolean => {
    const normalized = normalizeName(value);
    return !normalized || normalized === "игрок";
  };
  const preferStatus = (
    current: PadelGamePlayer["status"] | null | undefined,
    incoming: PadelGamePlayer["status"] | null | undefined,
  ): PadelGamePlayer["status"] => {
    const rank = (value: PadelGamePlayer["status"] | null | undefined): number => {
      if (value === "CONFIRMED") return 3;
      if (value === "PENDING") return 2;
      if (value === "WAITLIST") return 1;
      return 0;
    };
    return rank(incoming) > rank(current) ? (incoming ?? "CONFIRMED") : (current ?? "CONFIRMED");
  };
  const mergePlayers = (current: PadelGamePlayer, incoming: PadelGamePlayer): PadelGamePlayer => ({
    ...current,
    memberKey: current.memberKey ?? incoming.memberKey ?? null,
    id: current.id ?? incoming.id ?? null,
    name: isGenericName(current.name) && !isGenericName(incoming.name)
      ? incoming.name
      : (current.name || incoming.name || "Игрок"),
    phone: current.phone ?? incoming.phone ?? null,
    photo: current.photo ?? incoming.photo ?? null,
    rating: current.rating ?? incoming.rating ?? null,
    ratingNumeric: current.ratingNumeric ?? incoming.ratingNumeric ?? null,
    source: current.source ?? incoming.source ?? "INVITE_LINK",
    status: preferStatus(current.status, incoming.status),
  });

  const byId = new Map<string, PlayerAggregate>();
  const byPhone = new Map<string, PlayerAggregate>();
  const byName = new Map<string, PlayerAggregate>();
  const aggregates: PlayerAggregate[] = [];

  players.forEach((player) => {
    if (!player) return;
    const id = normalizeComparableId(player.id);
    const phone = normalizePhoneForGame(player.phone);
    const name = normalizeName(player.name);

    let aggregate: PlayerAggregate | undefined;
    if (id) aggregate = byId.get(id);
    if (!aggregate && phone) aggregate = byPhone.get(phone);
    if (!aggregate && name) {
      const byNameCandidate = byName.get(name);
      if (byNameCandidate) {
        const candidateHasStrongIdentity = byNameCandidate.ids.size > 0 || byNameCandidate.phones.size > 0;
        const incomingHasStrongIdentity = Boolean(id || phone);
        if (!candidateHasStrongIdentity || !incomingHasStrongIdentity) {
          aggregate = byNameCandidate;
        }
      }
    }
    if (!aggregate) {
      aggregate = aggregates.find((candidate) => playersShareRosterIdentity(candidate.player, player));
    }

    if (!aggregate) {
      aggregate = {
        player,
        ids: new Set<string>(),
        phones: new Set<string>(),
        names: new Set<string>(),
      };
      aggregates.push(aggregate);
    } else {
      aggregate.player = mergePlayers(aggregate.player, player);
    }

    if (id) {
      aggregate.ids.add(id);
      byId.set(id, aggregate);
    }
    if (phone) {
      aggregate.phones.add(phone);
      byPhone.set(phone, aggregate);
    }
    if (name) {
      aggregate.names.add(name);
      byName.set(name, aggregate);
    }
  });

  return aggregates.map((aggregate) => aggregate.player);
}

function buildPlayersIdentitySignature(players: PadelGamePlayer[]): string {
  return players
    .map((player) => getPadelPlayerIdentityKey(player))
    .filter(Boolean)
    .sort()
    .join("|");
}

function arePlayersEqualByIdentity(left: PadelGamePlayer[], right: PadelGamePlayer[]): boolean {
  if (left.length !== right.length) return false;
  return buildPlayersIdentitySignature(left) === buildPlayersIdentitySignature(right);
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

function createEmptyMatchResultSetPairings(size = 1): Array<MatchResultSetPairingSlots | null> {
  return Array.from({ length: Math.max(1, size) }, () => null);
}

function buildMatchResultPairingSlotRef(
  player: PadelGamePlayer | null | undefined,
): TeamSlotStoredRef | null {
  if (!player) return null;
  const memberKey = getPadelPlayerMemberKey(player);
  if (!memberKey && !player.name) return null;
  return {
    memberKey: memberKey || null,
    name: player.name || null,
  };
}

function buildMatchResultSetPairingsPayload(
  pairings: Array<MatchResultSetPairingSlots | null>,
): MatchResultSetPairingStored[] {
  return pairings
    .map<MatchResultSetPairingStored | null>((teamSlots, setIndex) => {
      if (!teamSlots || !teamSlots.some(Boolean)) return null;
      return {
        setIndex,
        teamSlots: cloneTeamSlots(teamSlots).map(buildMatchResultPairingSlotRef),
      };
    })
    .filter((item): item is MatchResultSetPairingStored => Boolean(item));
}

function materializeCompletedMatchResultSetPairings(
  pairings: Array<MatchResultSetPairingSlots | null>,
  completedSetCount: number,
): Array<MatchResultSetPairingSlots | null> {
  const safeCompletedSetCount = Math.max(0, completedSetCount);
  const nextPairings = Array.from({ length: Math.max(pairings.length, safeCompletedSetCount, 1) }, (_, index) => (
    pairings[index] ? cloneTeamSlots(pairings[index]) : null
  ));
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
  const explicitPairings = Array.from({ length: visibleSetCount }, (_, index) => (
    pairings[index] ? cloneTeamSlots(pairings[index]) : null
  ));
  const nextPairings = materializeCompletedMatchResultSetPairings(
    explicitPairings,
    visibleSetCount,
  );

  const fallbackPairing = fallbackSlots ? cloneTeamSlots(fallbackSlots) : null;
  const lastExplicitPairingIndex = explicitPairings.reduce((lastIndex, teamSlots, index) => (
    teamSlots && teamSlots.some(Boolean) ? index : lastIndex
  ), -1);

  if (
    lastExplicitPairingIndex >= 0
    && fallbackPairing
    && fallbackPairing.some(Boolean)
    && pairings.length <= visibleSetCount
  ) {
    for (let setIndex = lastExplicitPairingIndex + 1; setIndex < visibleSetCount; setIndex += 1) {
      nextPairings[setIndex] = cloneTeamSlots(fallbackPairing);
    }
  }

  if (nextPairings.some((teamSlots) => teamSlots && teamSlots.some(Boolean))) {
    return nextPairings;
  }

  if (!fallbackPairing || !fallbackPairing.some(Boolean)) {
    return nextPairings;
  }

  return Array.from({ length: visibleSetCount }, () => cloneTeamSlots(fallbackPairing));
}

function buildMatchResultSubmitSetPairingsPayload(
  pairings: Array<MatchResultSetPairingSlots | null>,
  completedSetCount: number,
  fallbackSlots: Array<PadelGamePlayer | null | undefined>,
): MatchResultSetPairingStored[] {
  if (completedSetCount <= 0) return [];
  const visiblePairings = buildVisibleMatchResultSetPairings(
    pairings,
    completedSetCount,
    fallbackSlots,
  );

  return buildMatchResultSetPairingsPayload(visiblePairings);
}

function validateCompletedMatchResultSetPairings(
  pairings: Array<MatchResultSetPairingSlots | null>,
  completedSetCount: number,
  fallbackSlots: Array<PadelGamePlayer | null | undefined>,
): string | null {
  if (completedSetCount <= 0) return null;
  const visiblePairings = buildVisibleMatchResultSetPairings(
    pairings,
    completedSetCount,
    fallbackSlots,
  );

  for (let setIndex = 0; setIndex < completedSetCount; setIndex += 1) {
    const teamSlots = visiblePairings[setIndex] ?? null;
    const memberKeys = Array.from({ length: DETAILS_TEAM_SLOTS_COUNT }, (_, slotIndex) => (
      getPadelPlayerMemberKey(teamSlots?.[slotIndex] ?? null)
    ));
    if (memberKeys.some((memberKey) => !memberKey)) {
      return `Для сета ${setIndex + 1} выберите четырех игроков`;
    }
    if (new Set(memberKeys).size !== DETAILS_TEAM_SLOTS_COUNT) {
      return `В сете ${setIndex + 1} каждый игрок должен быть выбран один раз`;
    }
  }

  return null;
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

function normalizePlayerRatingLabel(
  value: string | null | undefined,
  numericFallback: number | null = null,
): string | null {
  return normalizeLevelGradeLabel(value, numericFallback);
}

function resolvePublicCreateDefaultRatingRange(
  letterGrade: string | null | undefined,
  numericRating: number | null,
): { minRating: number; maxRating: number } | null {
  const normalizedLabel = normalizePlayerRatingLabel(letterGrade, numericRating);
  if (!normalizedLabel) return null;

  const centerIndex = RATING_LABELS.findIndex((item) => item === normalizedLabel);
  if (centerIndex < 0) return null;

  return {
    minRating: clampRatingWheelIndex(centerIndex - 1),
    maxRating: clampRatingWheelIndex(centerIndex + 1),
  };
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
  return normalized
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isGenericComparableName(value: string | null | undefined): boolean {
  const normalized = normalizeComparableName(value);
  if (!normalized) return true;
  return [
    "игрок",
    "организатор",
    "участник",
    "player",
    "participant",
    "organizer",
  ].includes(normalized);
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
  options?: { allowDateFallback?: boolean },
): Booking[] {
  if (!Array.isArray(bookings) || bookings.length === 0) return [];
  const allowDateFallback = options?.allowDateFallback !== false;

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

  if (!allowDateFallback) return [];
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

function resolveGameVivaExerciseId(game: PadelGameRecord | null | undefined): string | null {
  if (!game) return null;
  const booking = game.booking && isRecordObject(game.booking)
    ? game.booking as Record<string, unknown>
    : null;
  const bookingExercise = booking && isRecordObject(booking.exercise)
    ? booking.exercise as Record<string, unknown>
    : null;
  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const splitPayment = metadata && isRecordObject(metadata.splitPayment)
    ? metadata.splitPayment as Record<string, unknown>
    : null;

  return (
    normalizeBookingId(booking?.vivaExerciseId) ??
    normalizeBookingId(booking?.exerciseId) ??
    normalizeBookingId(bookingExercise?.id) ??
    normalizeBookingId(bookingExercise?.vivaExerciseId) ??
    normalizeBookingId(bookingExercise?.exerciseId) ??
    normalizeBookingId(metadata?.vivaExerciseId) ??
    normalizeBookingId(metadata?.exerciseId) ??
    normalizeBookingId(metadata?.viva_exercise_id) ??
    normalizeBookingId(metadata?.exercise_id) ??
    normalizeBookingId(splitPayment?.vivaExerciseId) ??
    normalizeBookingId(splitPayment?.exerciseId) ??
    normalizeBookingId(splitPayment?.viva_exercise_id) ??
    normalizeBookingId(splitPayment?.exercise_id) ??
    null
  );
}

function extractExerciseBookingRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecordObject(payload)) return [];
  const keys = ["payload", "content", "data", "result", "items", "records", "participants", "bookings"];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function normalizeVivaBookingParticipant(raw: unknown): PadelGamePlayer | null {
  if (!isRecordObject(raw)) return null;
  if (raw.isCancelled === true || raw.cancelled === true || raw.canceled === true) return null;

  const client = isRecordObject(raw.client) ? raw.client : null;
  const id =
    normalizeBookingId(client?.id) ??
    normalizeBookingId(raw.clientId) ??
    null;
  const phone = normalizePhoneForGame(
    typeof client?.phone === "string"
      ? client.phone
      : typeof raw.phone === "string"
        ? raw.phone
        : typeof raw.phoneNorm === "string"
          ? raw.phoneNorm
          : null,
  );

  const firstName = typeof client?.firstName === "string" ? client.firstName.trim() : "";
  const lastName = typeof client?.lastName === "string" ? client.lastName.trim() : "";
  const fallbackName =
    (typeof raw.clientName === "string" ? raw.clientName.trim() : "")
    || (typeof raw.playerName === "string" ? raw.playerName.trim() : "")
    || (typeof raw.name === "string" ? raw.name.trim() : "");
  const name = [firstName, lastName].filter(Boolean).join(" ").trim() || fallbackName || "Игрок";

  const ratingRaw = typeof raw.rating === "string" ? raw.rating.trim() : "";
  const rating = ratingRaw && ratingRaw.replace(/\D/g, "").length < 10 ? ratingRaw : null;

  const stateToken = String(raw.status || raw.state || "").trim().toUpperCase();
  const status: PadelGamePlayer["status"] =
    stateToken.includes("WAITLIST") || stateToken.includes("RESERVE")
      ? "WAITLIST"
      : raw.visitConfirmed === false || stateToken.includes("PENDING")
        ? "PENDING"
        : "CONFIRMED";

  if (!id && !phone && !name.trim()) return null;

  return {
    id,
    name,
    phone,
    photo: typeof client?.photo === "string" ? client.photo : null,
    rating,
    ratingNumeric: null,
    source: "ADMIN",
    status,
  };
}

function extractVivaBookingId(raw: unknown): string | null {
  if (!isRecordObject(raw)) return null;
  return (
    normalizeBookingId(raw.id)
    ?? normalizeBookingId(raw.bookingId)
    ?? normalizeBookingId(raw.recordId)
    ?? normalizeBookingId(raw.uuid)
    ?? null
  );
}

function extractVivaBookingPaymentTypes(raw: unknown): string[] {
  if (!isRecordObject(raw)) return [];
  const values = [
    raw.paymentType,
    raw.detailedPaymentType,
    raw.bookingPaymentType,
    raw.transactionStatus,
  ];
  const normalized = values
    .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function hasVivaSubscriptionBookingSignal(raw: unknown): boolean {
  if (!isRecordObject(raw)) return false;
  if (normalizeBookingId(raw.clientSubscriptionId)) return true;
  if (normalizeBookingId(raw.subscriptionId)) return true;

  const paymentTypes = extractVivaBookingPaymentTypes(raw);
  if (paymentTypes.some((value) => value.includes("SUBSCRIPTION"))) return true;
  if (paymentTypes.some((value) => value.includes("ABON"))) return true;

  return false;
}

function isCabinetBookingConvertedGame(game: PadelGameRecord | null | undefined): boolean {
  if (!game) return false;
  const gameId = String(game.id || "").trim().toLowerCase();
  if (gameId.startsWith("viva_")) return true;

  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const source = typeof metadata?.source === "string"
    ? metadata.source.trim().toLowerCase()
    : "";
  return source === "cabinet_booking_convert";
}

function extractVivaBookingClientId(raw: unknown): string | null {
  if (!isRecordObject(raw)) return null;
  const client = isRecordObject(raw.client) ? raw.client : null;
  return (
    normalizeBookingId(client?.id)
    ?? normalizeBookingId(raw.clientId)
    ?? normalizeBookingId(raw.playerId)
    ?? normalizeBookingId(raw.userId)
    ?? null
  );
}

function vivaBookingMatchesPlayer(raw: unknown, player: PadelGamePlayer): boolean {
  if (!isRecordObject(raw)) return false;
  const client = isRecordObject(raw.client) ? raw.client : null;
  const playerId = normalizeComparableId(player.id);
  const playerPhone = normalizePhoneForGame(player.phone);
  const playerName = normalizeComparableName(player.name);

  const bookingIds = [
    client?.id,
    raw.clientId,
    raw.playerId,
    raw.userId,
  ]
    .map((value) => normalizeComparableId(value))
    .filter((value): value is string => Boolean(value));
  if (playerId && bookingIds.includes(playerId)) return true;

  const bookingPhones = [
    client?.phone,
    raw.phone,
    raw.phoneNorm,
    raw.clientPhone,
  ]
    .map((value) => normalizePhoneForGame(typeof value === "string" ? value : null))
    .filter((value): value is string => Boolean(value));
  if (playerPhone && bookingPhones.includes(playerPhone)) return true;

  if (!playerId && !playerPhone && playerName && !isGenericComparableName(playerName)) {
    const firstName = typeof client?.firstName === "string" ? client.firstName.trim() : "";
    const lastName = typeof client?.lastName === "string" ? client.lastName.trim() : "";
    const bookingName = normalizeComparableName(
      [firstName, lastName].filter(Boolean).join(" ")
      || raw.clientName
      || raw.playerName
      || raw.name,
    );
    return Boolean(
      bookingName
      && !isGenericComparableName(bookingName)
      && bookingName === playerName,
    );
  }

  return false;
}

function splitPaymentItemMatchesPlayer(
  item: Record<string, unknown>,
  player: PadelGamePlayer,
): boolean {
  const playerId = normalizeComparableId(player.id);
  const playerPhone = normalizePhoneForGame(player.phone);
  const playerName = normalizeComparableName(player.name);

  const itemIds = [
    item.clientId,
    item.playerId,
    item.userId,
    item.id,
  ]
    .map((value) => normalizeComparableId(value))
    .filter((value): value is string => Boolean(value));
  if (playerId && itemIds.includes(playerId)) return true;

  const itemPhone = normalizePhoneForGame(
    typeof item.phoneNorm === "string"
      ? item.phoneNorm
      : typeof item.clientPhoneNorm === "string"
        ? item.clientPhoneNorm
        : typeof item.phone === "string"
          ? item.phone
          : typeof item.clientPhone === "string"
            ? item.clientPhone
            : null,
  );
  if (playerPhone && itemPhone && playerPhone === itemPhone) return true;

  if (!playerId && !playerPhone && playerName && !isGenericComparableName(playerName)) {
    const itemName = normalizeComparableName(item.playerName ?? item.clientName ?? item.name);
    return Boolean(
      itemName
      && !isGenericComparableName(itemName)
      && itemName === playerName,
    );
  }

  return false;
}

function extractSplitPaymentBookingTargetsForPlayer(
  splitPayment: Record<string, unknown> | null,
  player: PadelGamePlayer,
): Array<{ bookingId: string; clientId: string | null }> {
  if (!splitPayment) return [];
  const payments = Array.isArray(splitPayment.payments)
    ? splitPayment.payments.filter((item) => isRecordObject(item))
    : [];
  const byBookingId = new Map<string, { bookingId: string; clientId: string | null }>();
  const pushBookingTarget = (bookingIdRaw: unknown, clientIdRaw: unknown) => {
    const bookingId = normalizeBookingId(bookingIdRaw);
    if (!bookingId) return;
    const clientId = normalizeBookingId(clientIdRaw);
    const existing = byBookingId.get(bookingId);
    if (existing) {
      if (!existing.clientId && clientId) {
        existing.clientId = clientId;
      }
      return;
    }
    byBookingId.set(bookingId, {
      bookingId,
      clientId,
    });
  };

  payments.forEach((item) => {
    if (!isSplitPaymentReservationActive(item.status)) return;
    if (!splitPaymentItemMatchesPlayer(item, player)) return;

    const itemClientId =
      normalizeBookingId(item.clientId)
      ?? normalizeBookingId(item.playerId)
      ?? normalizeBookingId(item.userId)
      ?? null;
    pushBookingTarget(item.bookingId, itemClientId);
    if (Array.isArray(item.bookingIds)) {
      item.bookingIds.forEach((value) => {
        pushBookingTarget(value, itemClientId);
      });
    }
  });

  return Array.from(byBookingId.values());
}

function markSplitPaymentPlayerLeft(
  splitPayment: Record<string, unknown> | null,
  player: PadelGamePlayer,
  leftAt: string,
  vivaCancellation: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!splitPayment) return null;
  const payments = Array.isArray(splitPayment.payments)
    ? splitPayment.payments.filter((item) => isRecordObject(item))
    : [];
  let changed = false;
  const nextPayments = payments.map((item) => {
    if (!isSplitPaymentReservationActive(item.status) || !splitPaymentItemMatchesPlayer(item, player)) {
      return item;
    }
    changed = true;
    return {
      ...item,
      status: "CANCELLED",
      cancelReason: "PLAYER_LEFT",
      cancelledAt: leftAt,
      leftAt,
      vivaCancellation,
    };
  });

  if (!changed) return splitPayment;
  return {
    ...splitPayment,
    payments: nextPayments,
    lastLeaveUpdateAt: leftAt,
  };
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

function isSinglesFormat(value: unknown): boolean {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "singles"
    || normalized.includes("1x1")
    || normalized.includes("1х1")
    || normalized.includes("1 на 1");
}

function isSinglesCourtName(roomName: unknown): boolean {
  return /сингл|single|1\s*на\s*1|1\s*[xх]\s*1/i.test(String(roomName || ""));
}

function isSinglesGameRecord(game: PadelGameRecord | null | undefined): boolean {
  if (!game) return false;
  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  if (isSinglesFormat(metadata?.gameFormat ?? metadata?.format)) return true;

  const splitPayment = metadata && isRecordObject(metadata.splitPayment)
    ? metadata.splitPayment as Record<string, unknown>
    : null;
  const splitShareCount = toFiniteNumber(splitPayment?.shareCount);
  if (splitShareCount === 2) return true;

  return [
    game.booking?.roomName,
    metadata?.roomName,
    metadata?.courtName,
    metadata?.courtTitle,
  ].some((value) => isSinglesCourtName(value));
}

function resolveGameDetailsMaxPlayers(game: PadelGameRecord | null | undefined): number {
  if (!game) return MAX_DOUBLES_PLAYERS;
  if (isSinglesGameRecord(game)) return MAX_SINGLES_PLAYERS;

  const inviteMaxPlayers = game.invite?.maxPlayers;
  if (typeof inviteMaxPlayers === "number" && Number.isFinite(inviteMaxPlayers) && inviteMaxPlayers > 0) {
    return Math.max(1, Math.floor(inviteMaxPlayers));
  }

  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const metadataMaxPlayers = toFiniteNumber(metadata?.maxPlayers ?? metadata?.playersLimit);
  if (metadataMaxPlayers !== null && metadataMaxPlayers > 0) {
    return Math.max(1, Math.floor(metadataMaxPlayers));
  }

  return MAX_DOUBLES_PLAYERS;
}

function matchesCourtNameByGameFormat(roomName: string, format: GamePlayFormat): boolean {
  if (format === "singles") {
    return isSinglesCourtName(roomName);
  }
  return !isSinglesCourtName(roomName);
}

function resolveSplitShareCountByGameFormat(format: GamePlayFormat): SplitShareCount {
  return format === "singles" ? 2 : 4;
}

function isOutdoorCourtName(roomName: string): boolean {
  return /уличн|outdoor|open\s*air|под\s*открытым\s*небом/i.test(roomName);
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
  getZoom: () => number;
  on: (event: "zoomend", handler: () => void) => void;
  off: (event: "zoomend", handler: () => void) => void;
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

type LeafletDivIcon = object;

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
  divIcon: (options: {
    className: string;
    html: string;
    iconSize: [number, number];
    iconAnchor: [number, number];
    tooltipAnchor?: [number, number];
  }) => LeafletDivIcon;
  marker: (
    point: LeafletPoint,
    options: {
      icon: LeafletDivIcon;
      zIndexOffset?: number;
    },
  ) => LeafletMarker;
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
const STUDIO_MAP_MARKER_LOGO_COVERAGE = 0.85;
const STUDIO_MAP_MARKER_LOGO_ASPECT_RATIO = 1330 / 726;

let leafletLoader: Promise<LeafletModule> | null = null;

interface StudioMapMarkerVisualSpec {
  containerWidth: number;
  containerHeight: number;
  logoWidth: number;
  logoHeight: number;
}

function resolveStudioMapMarkerLogoSize(containerWidth: number, containerHeight: number) {
  const maxLogoWidth = containerWidth * STUDIO_MAP_MARKER_LOGO_COVERAGE;
  const maxLogoHeight = containerHeight * STUDIO_MAP_MARKER_LOGO_COVERAGE;
  const widthByHeight = maxLogoHeight * STUDIO_MAP_MARKER_LOGO_ASPECT_RATIO;

  if (widthByHeight <= maxLogoWidth) {
    return {
      logoWidth: Math.max(1, Math.round(widthByHeight)),
      logoHeight: Math.max(1, Math.round(maxLogoHeight)),
    };
  }

  return {
    logoWidth: Math.max(1, Math.round(maxLogoWidth)),
    logoHeight: Math.max(1, Math.round(maxLogoWidth / STUDIO_MAP_MARKER_LOGO_ASPECT_RATIO)),
  };
}

function resolveStudioMapMarkerVisualSpec(zoom: number, selected: boolean): StudioMapMarkerVisualSpec {
  const safeZoom = Number.isFinite(zoom) ? zoom : 10;
  let baseSpec: Pick<StudioMapMarkerVisualSpec, "containerWidth" | "containerHeight">;
  if (safeZoom <= 5) {
    baseSpec = { containerWidth: 24, containerHeight: 16 };
  } else if (safeZoom <= 7) {
    baseSpec = { containerWidth: 30, containerHeight: 20 };
  } else if (safeZoom <= 9) {
    baseSpec = { containerWidth: 36, containerHeight: 24 };
  } else if (safeZoom <= 11) {
    baseSpec = { containerWidth: 42, containerHeight: 28 };
  } else {
    baseSpec = { containerWidth: 48, containerHeight: 30 };
  }

  if (selected) {
    baseSpec = {
      containerWidth: baseSpec.containerWidth + 6,
      containerHeight: baseSpec.containerHeight + 4,
    };
  }

  return {
    ...baseSpec,
    ...resolveStudioMapMarkerLogoSize(baseSpec.containerWidth, baseSpec.containerHeight),
  };
}

function buildStudioMapMarkerHtml(selected: boolean, spec: StudioMapMarkerVisualSpec) {
  const logoMarkup = selected ? logoHabWhiteRaw : logoHabBlackRaw;
  return `
    <span
      class="game-map-station-marker${selected ? " is-selected" : ""}"
      aria-hidden="true"
      style="width:${spec.containerWidth}px;height:${spec.containerHeight}px"
    >
      <span
        class="game-map-station-marker-logo"
        style="width:${spec.logoWidth}px;height:${spec.logoHeight}px"
      >${logoMarkup}</span>
    </span>
  `;
}

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
  initialGameRecord = null,
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
  const [splitCheckoutMode, setSplitCheckoutMode] = useState<SplitCheckoutMode>("one_time");
  const [selectedSplitSubscriptionId, setSelectedSplitSubscriptionId] = useState<string | null>(null);
  const [splitShareCount, setSplitShareCount] = useState<SplitShareCount>(4);
  const [splitPaymentPromoConfig, setSplitPaymentPromoConfig] =
    useState<PadelSplitPaymentPromoConfig>(DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG);
  const [promoModalOpen, setPromoModalOpen] = useState(false);
  const [outdoorCourtHintOpen, setOutdoorCourtHintOpen] = useState(false);
  const [splitSubscriptionInfoModalOpen, setSplitSubscriptionInfoModalOpen] = useState(false);
  const [promoCodeDraft, setPromoCodeDraft] = useState("");
  const [promoCodeApplied, setPromoCodeApplied] = useState<string | null>(null);
  const [promoDiscountAmount, setPromoDiscountAmount] = useState<number | null>(null);
  const [promoPricePreview, setPromoPricePreview] = useState<number | null>(null);
  const [promoStatusMessage, setPromoStatusMessage] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [splitSubscriptionsLoading, setSplitSubscriptionsLoading] = useState(false);
  const [splitSubscriptionsError, setSplitSubscriptionsError] = useState<string | null>(null);
  const [splitSubscriptions, setSplitSubscriptions] = useState<Subscription[]>([]);
  const [splitSubscriptionNamesById, setSplitSubscriptionNamesById] = useState<Record<string, string>>({});
  const [applyingPromo, setApplyingPromo] = useState(false);
  const [ratingGame, setRatingGame] = useState(true);
  const [minRating, setMinRating] = useState(1);
  const [maxRating, setMaxRating] = useState(4);
  const [publicCreatePreciseRatingRange, setPublicCreatePreciseRatingRange] = useState<PublicCreatePreciseRatingRange>(
    () => buildPreciseRatingRangeFromCoarse(1, 4),
  );
  const [publicCreatePreciseRatingTouched, setPublicCreatePreciseRatingTouched] = useState(false);
  const [publicCreatePreciseRatingModalOpen, setPublicCreatePreciseRatingModalOpen] = useState(false);
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
  const [joiningSplitPayment, setJoiningSplitPayment] = useState(false);
  const [splitPendingNowTs, setSplitPendingNowTs] = useState(() => Date.now());
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
  const [inviteFeedback, setInviteFeedback] = useState<"shared" | "copied" | null>(null);
  const [detailsServiceInfoVisible, setDetailsServiceInfoVisible] = useState(false);
  const [detailsPaymentHintOpen, setDetailsPaymentHintOpen] = useState(false);
  const [detailsActiveTab, setDetailsActiveTab] = useState<"game" | "result">("game");
  const [detailsLeaveHistoryOpen, setDetailsLeaveHistoryOpen] = useState(false);
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
  const [detailsMatchResultSession, setDetailsMatchResultSession] =
    useState<PadelGameResultSessionResponse | null>(null);
  const [detailsPairComposerSetIndex, setDetailsPairComposerSetIndex] = useState<number | null>(null);
  const [detailsMatchResultStatus, setDetailsMatchResultStatus] = useState<MatchResultLifecycleStatus | null>(null);
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
  const [detailsMatchResultViewerRole, setDetailsMatchResultViewerRole] = useState<string | null>(null);
  const [detailsMatchResultDisputedBy, setDetailsMatchResultDisputedBy] = useState<{
    id: string | null;
    phone: string | null;
    name: string | null;
  } | null>(null);
  const [detailsMatchResultDisputedAt, setDetailsMatchResultDisputedAt] = useState<string | null>(null);
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
  const detailsCameraInputRef = useRef<HTMLInputElement | null>(null);
  const detailsGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const publicCreateEntryHandledRef = useRef(false);
  const publicCreatePresetHandledRef = useRef(false);
  const publicCreateRatingRangeTouchedRef = useRef(false);
  const publicCreateDefaultRatingRangeAppliedRef = useRef(false);
  const openedGameInitKeyRef = useRef<string | null>(null);
  const splitJoinPriceAutofilledRef = useRef(false);
  const communityAutopublishSelectionTouchedRef = useRef(false);
  const detailsRatingsRefreshKeyRef = useRef<string | null>(null);
  const selectedCommunityAutopublishIdsRef = useRef<string[]>([]);
  const communityAutopublishSyncInFlightRef = useRef<Map<string, Promise<void>>>(new Map());
  const communityAutopublishRepairAttemptRef = useRef<string | null>(null);
  const splitRelatedPhonesRepairAttemptRef = useRef<string | null>(null);
  const splitTimeoutCleanupInFlightRef = useRef(false);
  const splitTimeoutCleanupAttemptAtRef = useRef<Record<string, number>>({});
  const previousStudioIdRef = useRef<string | null>(null);
  const previousResolvedGameFormatRef = useRef<GamePlayFormat | null>(null);
  const previousPromoSelectionKeyRef = useRef<string | null>(null);
  const autoConfirmingMatchResultRef = useRef<string | null>(null);
  const resultStateFetchKeyRef = useRef<string | null>(null);
  const detailsMatchResultSourceKeyRef = useRef<string | null>(null);
  const detailsMatchResultDraftDirtyRef = useRef(false);
  const detailsMatchResultSessionOpenKeyRef = useRef<string | null>(null);
  const detailsMatchResultSessionSyncKeyRef = useRef<string | null>(null);
  const detailsMatchResultSessionRevisionRef = useRef<number | null>(null);
  const detailsMatchResultSessionContextRef = useRef<string | null>(null);
  const detailsMatchResultSessionConflictRef = useRef(false);
  const detailsMatchResultSessionSaveTimerRef = useRef<number | null>(null);
  const detailsMatchResultSessionSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const detailsMatchResultSubmissionRef = useRef<{
    draftKey: string;
    idempotencyKey: string;
  } | null>(null);
  const initialOpenGameRecord = useMemo(() => {
    const requestedGameId = openGameId?.trim() || "";
    if (!requestedGameId || !initialGameRecord?.id) return null;
    return initialGameRecord.id === requestedGameId ? initialGameRecord : null;
  }, [initialGameRecord, openGameId]);
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
  const resetSelectedTime = useCallback(() => {
    setTime(null);
    setSlotPrice(null);
    setLoadingSlotPrice(false);
    setPayError(null);
  }, []);
  const resetSelectedCourt = useCallback(() => {
    setCourtId(null);
    setSlotPrice(null);
    setLoadingSlotPrice(false);
    setPayError(null);
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
    const activeBookings = activeBookingsResult.data?.content ?? [];
    let historyBookings: Booking[] | null = null;
    const loadHistoryBookings = async () => {
      if (historyBookings) return historyBookings;
      const historyBookingsResult = await apiFetchBookings(true);
      historyBookings = historyBookingsResult.data?.content ?? [];
      return historyBookings;
    };

    let strictMatchedBookings = matchBookingsByLookupContext(activeBookings, lookup, {
      allowDateFallback: false,
    });
    if (strictMatchedBookings.length === 0) {
      strictMatchedBookings = matchBookingsByLookupContext(await loadHistoryBookings(), lookup, {
        allowDateFallback: false,
      });
    }

    let matchedBookings = strictMatchedBookings;
    if (matchedBookings.length === 0) {
      matchedBookings = matchBookingsByLookupContext(activeBookings, lookup, {
        allowDateFallback: true,
      });
      if (matchedBookings.length === 0) {
        matchedBookings = matchBookingsByLookupContext(await loadHistoryBookings(), lookup, {
          allowDateFallback: true,
        });
      }
    }

    const paid = matchedBookings.length > 0 ? resolvePaidStateByBookings(matchedBookings) : null;
    const cancelledByBookings = strictMatchedBookings.length > 0
      ? resolveCancelledStateByBookings(strictMatchedBookings)
      : false;
    let cancelled = cancelledByBookings && lookup.exerciseIds.length === 0;
    if (cancelledByBookings && lookup.exerciseIds.length > 0) {
      for (const exerciseId of lookup.exerciseIds) {
        const exerciseResult = await apiFetchExerciseById(exerciseId);
        const exerciseCancelled = resolveExerciseCancellationState(exerciseResult.data);
        if (exerciseCancelled === false) {
          cancelled = false;
          break;
        }
        if (exerciseCancelled === true) {
          cancelled = true;
          break;
        }
      }
    }
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
    }, 20000);

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
      const aOutdoor = isOutdoorCourtName(a.name);
      const bOutdoor = isOutdoorCourtName(b.name);
      if (aOutdoor !== bOutdoor) return aOutdoor ? -1 : 1;

      const aOrder = extractCourtOrder(a.name);
      const bOrder = extractCourtOrder(b.name);
      if (aOrder !== null && bOrder !== null) {
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.name.localeCompare(b.name, "ru");
      }
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
  const splitShareCountByGameFormat = resolveSplitShareCountByGameFormat(resolvedGameFormat);
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
    let zoomEndHandler: (() => void) | null = null;
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

        const renderMapMarkers = () => {
          markers.clearLayers();
          const zoom = map.getZoom();

          mapStudios.forEach((item) => {
            const selected = item.id === studio?.id;
            const markerSpec = resolveStudioMapMarkerVisualSpec(zoom, selected);
            const tooltipOffsetY = -Math.max(12, Math.round(markerSpec.containerHeight * 0.6));
            const marker = L.marker([item.lat, item.lng], {
              icon: L.divIcon({
                className: "game-map-station-icon",
                html: buildStudioMapMarkerHtml(selected, markerSpec),
                iconSize: [markerSpec.containerWidth, markerSpec.containerHeight],
                iconAnchor: [
                  Math.round(markerSpec.containerWidth / 2),
                  Math.round(markerSpec.containerHeight / 2),
                ],
                tooltipAnchor: [0, tooltipOffsetY],
              }),
              zIndexOffset: selected ? 200 : 0,
            });
            marker.bindTooltip(item.name, { direction: "top", offset: [0, tooltipOffsetY] });
            marker.on("click", () => {
              setStudio(item);
              setStep("time");
              setMapOpen(false);
            });
            marker.addTo(markers);
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
          }
        };

        if (mapStudios.length === 0 && !userLocation) {
          map.setView([55.751244, 37.618423], 10);
          window.setTimeout(() => {
            map.invalidateSize();
            renderMapMarkers();
          }, 0);
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

        studiosForViewport.forEach((item) => {
          bounds.push([item.lat, item.lng]);
        });

        if (userLocation) {
          bounds.push([userLocation.lat, userLocation.lng]);
        }

        if (bounds.length === 1) {
          map.setView(bounds[0], 12);
        } else {
          map.fitBounds(bounds, { padding: [24, 24], maxZoom: 13 });
        }

        zoomEndHandler = () => {
          if (cancelled) return;
          renderMapMarkers();
        };

        map.on("zoomend", zoomEndHandler);
        renderMapMarkers();

        window.setTimeout(() => {
          if (cancelled) return;
          map.invalidateSize();
          renderMapMarkers();
        }, 0);

        setMapLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMapError("Не удалось загрузить карту");
        setMapLoading(false);
      });

    return () => {
      cancelled = true;
      if (zoomEndHandler && mapInstanceRef.current) {
        mapInstanceRef.current.off("zoomend", zoomEndHandler);
      }
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
      if (initialOpenGameRecord?.id === requestedGameId) return initialOpenGameRecord;
      if (prev?.id === requestedGameId) return prev;
      return communityGames.find((game) => game.id === requestedGameId) ?? null;
    });
    setChatMessages([]);
    setChatError(null);
    setChatDraft("");
    setConfirmCancelUnpaidGame(false);
    setStep(requestedOpenStep);
  }, [communityGames, initialOpenGameRecord, openGameId, openChat]);

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
    const typeIdRaw = toFiniteNumber(createFromBooking?.typeId);
    const typeId = typeIdRaw === null ? null : Math.trunc(typeIdRaw);
    const typeName = createFromBooking?.typeName?.trim() || null;
    const directionIdRaw = toFiniteNumber(createFromBooking?.directionId);
    const directionId = directionIdRaw === null ? null : Math.trunc(directionIdRaw);
    const directionName = createFromBooking?.directionName?.trim() || null;
    const paymentUrl = createFromBooking?.paymentUrl?.trim() || null;
    const paid = createFromBooking?.paid === true
      ? true
      : createFromBooking?.paid === false
        ? false
        : null;
    const amount = typeof createFromBooking?.amount === "number" && Number.isFinite(createFromBooking.amount)
      ? Math.max(0, Math.round(createFromBooking.amount))
      : null;
    const isMode = Boolean(bookingId);
    const hasRequiredBookingData = Boolean(
      bookingId
      && date
      && timeFrom
      && timeTo
      && studioId
      && roomId,
    );
    const category = resolveExerciseCategoryFromValue({
      typeId,
      typeName,
      directionId,
      directionName,
    });
    const canCreateFromPreset = Boolean(
      hasRequiredBookingData
      && isExerciseConvertibleToGameFromBooking({
        typeId,
        typeName,
        directionId,
        directionName,
      }),
    );

    return {
      isMode,
      hasRequiredBookingData,
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
      typeId,
      typeName,
      directionId,
      directionName,
      paymentUrl,
      paid,
      amount,
      category,
    };
  }, [createFromBooking]);
  const isBookingPresetMode = bookingPreset.isMode;
  const bookingPresetCategoryError = isBookingPresetMode
    && bookingPreset.hasRequiredBookingData
    && !bookingPreset.canCreateFromPreset
    ? (
        bookingPreset.category
          ? "Из этой брони нельзя создать сборную игру. Конвертация доступна только для открытой игры или аренды корта."
          : "Не удалось определить тип брони. Конвертация доступна только для открытой игры или аренды корта."
      )
    : null;
  const bookingPresetErrorMessage = gameRecordError || bookingPresetCategoryError;
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
  const usePublicCreateWizard = publicCreateEntry && !isBookingPresetMode;
  const communityAutopublishStationName = useMemo(() => {
    const rawName = isBookingPresetMode ? bookingPreset.studioName : studioName;
    return rawName?.trim() || null;
  }, [bookingPreset.studioName, isBookingPresetMode, studioName]);
  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "";
  const selectedDateChipLabel = selectedDate
    ? selectedDate
        .toLocaleDateString("ru-RU", { day: "numeric", month: "short" })
        .replace(".", "")
        .trim()
    : null;
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
    if (!usePublicCreateWizard || step !== "create") return;
    if (typeof window === "undefined") return;

    const resetScrollPosition = () => {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };

    let timeoutId: number | null = null;
    resetScrollPosition();
    const animationFrameId = window.requestAnimationFrame(() => {
      resetScrollPosition();
      timeoutId = window.setTimeout(resetScrollPosition, 80);
    });

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [step, usePublicCreateWizard]);

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
  const publicCreateMinRatingLabel = RATING_LABELS[minRating] ?? "—";
  const publicCreateMaxRatingLabel = RATING_LABELS[maxRating] ?? "—";
  const publicCreateRatingSummaryLabel = "Подойдут игроки уровня";
  const publicCreateLevelSummaryLabel = ratingGame
    ? (
      minRating === maxRating
        ? publicCreateMinRatingLabel
        : `${publicCreateMinRatingLabel} - ${publicCreateMaxRatingLabel}`
    )
    : "Результаты игры не влияют на уровень";
  const publicCreatePreciseRatingSummaryValue = publicCreatePreciseRatingTouched
    ? `${formatPreciseRatingBoundLabel(publicCreatePreciseRatingRange.min)} — ${formatPreciseRatingBoundLabel(publicCreatePreciseRatingRange.max)}`
    : `${publicCreateMinRatingLabel} — ${publicCreateMaxRatingLabel}`;
  const publicCreatePreciseRatingMetadata = useMemo(
    () => buildPreciseRatingMetadataFields(
      Boolean(usePublicCreateWizard && effectiveRatingGame),
      publicCreatePreciseRatingRange,
      publicCreatePreciseRatingTouched,
    ),
    [
      effectiveRatingGame,
      publicCreatePreciseRatingRange,
      publicCreatePreciseRatingTouched,
      usePublicCreateWizard,
    ],
  );

  const applyPublicCreateCoarseRatingRange = useCallback((nextMin: number, nextMax: number) => {
    const safeMin = clampRatingWheelIndex(Math.min(nextMin, nextMax));
    const safeMax = clampRatingWheelIndex(Math.max(nextMin, nextMax));
    setMinRating((current) => (current === safeMin ? current : safeMin));
    setMaxRating((current) => (current === safeMax ? current : safeMax));
    setPublicCreatePreciseRatingTouched(false);
    setPublicCreatePreciseRatingRange((current) => {
      const nextRange = buildPreciseRatingRangeFromCoarse(safeMin, safeMax);
      return isSamePreciseRatingRange(current, nextRange) ? current : nextRange;
    });
  }, []);

  const handlePublicCreateRatingSegmentSelect = useCallback((index: number) => {
    publicCreateRatingRangeTouchedRef.current = true;
    publicCreateDefaultRatingRangeAppliedRef.current = true;
    const normalizedIndex = clampRatingWheelIndex(index);
    if (normalizedIndex <= minRating) {
      applyPublicCreateCoarseRatingRange(normalizedIndex, maxRating);
      return;
    }
    if (normalizedIndex >= maxRating) {
      applyPublicCreateCoarseRatingRange(minRating, normalizedIndex);
      return;
    }

    const distanceToMin = normalizedIndex - minRating;
    const distanceToMax = maxRating - normalizedIndex;
    if (distanceToMin <= distanceToMax) {
      applyPublicCreateCoarseRatingRange(normalizedIndex, maxRating);
    } else {
      applyPublicCreateCoarseRatingRange(minRating, normalizedIndex);
    }
  }, [applyPublicCreateCoarseRatingRange, maxRating, minRating]);

  const handlePublicCreateLevelButtonSelect = useCallback((index: number) => {
    publicCreateRatingRangeTouchedRef.current = true;
    publicCreateDefaultRatingRangeAppliedRef.current = true;
    const normalizedIndex = clampRatingWheelIndex(index);
    if (!ratingGame) {
      setRatingGame(true);
      applyPublicCreateCoarseRatingRange(normalizedIndex, normalizedIndex);
      return;
    }
    if (minRating === maxRating && minRating === normalizedIndex) {
      setRatingGame(false);
      return;
    }
    if (normalizedIndex === minRating) {
      applyPublicCreateCoarseRatingRange(minRating + 1, maxRating);
      return;
    }
    if (normalizedIndex === maxRating) {
      applyPublicCreateCoarseRatingRange(minRating, maxRating - 1);
      return;
    }
    handlePublicCreateRatingSegmentSelect(normalizedIndex);
  }, [
    applyPublicCreateCoarseRatingRange,
    handlePublicCreateRatingSegmentSelect,
    maxRating,
    minRating,
    ratingGame,
  ]);

  useEffect(() => {
    if (!usePublicCreateWizard || !profileId) return;
    if (publicCreateDefaultRatingRangeAppliedRef.current || publicCreateRatingRangeTouchedRef.current) return;

    const defaultRange = resolvePublicCreateDefaultRatingRange(profileGrade, profileRatingNumeric);
    if (!defaultRange) return;

    publicCreateDefaultRatingRangeAppliedRef.current = true;
    setRatingGame(true);
    applyPublicCreateCoarseRatingRange(defaultRange.minRating, defaultRange.maxRating);
  }, [
    applyPublicCreateCoarseRatingRange,
    profileGrade,
    profileId,
    profileRatingNumeric,
    usePublicCreateWizard,
  ]);

  const handlePublicCreatePreciseRatingBoundChange = useCallback((
    bound: "min" | "max",
    field: "grade" | "level",
    rawValue: string,
  ) => {
    publicCreateRatingRangeTouchedRef.current = true;
    publicCreateDefaultRatingRangeAppliedRef.current = true;
    const nextRange = {
      min: clonePreciseRatingBound(publicCreatePreciseRatingRange.min),
      max: clonePreciseRatingBound(publicCreatePreciseRatingRange.max),
    };
    const target = nextRange[bound];
    if (field === "grade") {
      target.grade = normalizePreciseRatingGrade(rawValue);
    } else {
      target.level = normalizePreciseRatingLevel(rawValue);
    }

    const normalizedRange = normalizePreciseRatingRangeAfterBoundChange(nextRange, bound);
    setPublicCreatePreciseRatingRange((current) => (
      isSamePreciseRatingRange(current, normalizedRange) ? current : normalizedRange
    ));
    setPublicCreatePreciseRatingTouched(true);
    setMinRating((current) => {
      const nextIndex = mapPreciseRatingBoundToCoarseIndex(normalizedRange.min);
      return current === nextIndex ? current : nextIndex;
    });
    setMaxRating((current) => {
      const nextIndex = mapPreciseRatingBoundToCoarseIndex(normalizedRange.max);
      return current === nextIndex ? current : nextIndex;
    });
  }, [publicCreatePreciseRatingRange]);

  useEffect(() => {
    if (publicCreatePreciseRatingTouched) return;
    setPublicCreatePreciseRatingRange((current) => {
      const nextRange = buildPreciseRatingRangeFromCoarse(minRating, maxRating);
      return isSamePreciseRatingRange(current, nextRange) ? current : nextRange;
    });
  }, [maxRating, minRating, publicCreatePreciseRatingTouched]);

  useEffect(() => {
    if (ratingGame) return;
    if (!publicCreatePreciseRatingModalOpen) return;
    setPublicCreatePreciseRatingModalOpen(false);
  }, [publicCreatePreciseRatingModalOpen, ratingGame]);

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
  const hasCompleteTimeSelection = Boolean(studio && selectedDate && selectedCourt && selectedSlot && time);
  const isPlaceStepComplete = isBookingPresetMode ? bookingPreset.hasRequiredBookingData : Boolean(studio);
  const isTimeStepComplete = isBookingPresetMode
    ? bookingPreset.hasRequiredBookingData
    : hasCompleteTimeSelection;
  const canContinueGameCreation = isBookingPresetMode
    ? bookingPreset.canCreateFromPreset
    : Boolean(isPlaceStepComplete && isTimeStepComplete);
  const isContinueDisabled = () => !(hasCompleteTimeSelection && paymentMode);
  const canProceedToPayment = !isContinueDisabled();
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
  const splitPaymentAvailable = ENABLE_SPLIT_GAME_PAYMENT;
  const splitPaymentSelected = splitPaymentAvailable && paymentMode === "split";
  const splitSharePartLabel = `1/${splitShareCount}`;
  const splitRequiredSubscriptionVisits = resolveSplitSubscriptionVisitCharge(duration);
  const paymentModeSubLabel = splitPaymentSelected
    ? `Разделить оплату на ${splitShareCount === 2 ? "двоих" : "четверых"}`
    : "Оплачу игру один";
  const splitShareAmount = paymentAmount != null && paymentAmount > 0
    ? Math.max(0, Math.round(paymentAmount / Math.max(splitShareCount, 1)))
    : resolveSplitShareAmount(splitShareCount, activeSplitPaymentPromoConfig, duration);
  const splitPaymentSummary = `${formatPrice(splitShareAmount)} ₽ × ${splitShareCount}`;
  // Eligible subscriptions must match the actual open-game exercise type we create.
  // Promo config may contain alternative Viva exercise type ids for pricing, but using
  // them here shows subscriptions that cannot be used for this booking flow.
  const splitRequiredTypeIds = useMemo(
    () => buildComparableIdSet([SPLIT_OPEN_GAME_EXERCISE_TYPE_ID]),
    [],
  );
  const splitRequiredDirectionIds = useMemo(
    () => buildComparableIdSet([SPLIT_OPEN_GAME_DIRECTION_ID]),
    [],
  );
  const splitHasEligibleSubscriptions = splitSubscriptions.length > 0;
  const splitSubscriptionPaymentOptions = useMemo(
    () => {
      return splitSubscriptions.map((subscription) => {
        const subscriptionId = String(subscription.subscriptionId || "").trim();
        if (!subscriptionId) return null;
        const name = resolveSplitSubscriptionDisplayName(subscription, splitSubscriptionNamesById);
        const balanceLabel = formatSplitSubscriptionValidityLabel(subscription, name) || "срок уточняется";
        return {
          subscriptionId,
          name,
          balanceLabel,
        };
      })
        .filter((item): item is { subscriptionId: string; name: string; balanceLabel: string } => Boolean(item));
    },
    [splitSubscriptions, splitSubscriptionNamesById],
  );
  const splitHasSubscriptionPaymentOptions = splitSubscriptionPaymentOptions.length > 0;
  const normalizedGameTitle = gameTitleDraft.trim();
  const normalizedGameParticipantComment = gameParticipantCommentDraft.trim();
  const normalizedGameJoinPrice = gameJoinPriceDraft.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  const splitJoinPriceAutoAmount = paymentAmount != null && paymentAmount > 0
    ? Math.max(0, Math.round(paymentAmount / Math.max(splitShareCount, 1)))
    : 0;
  const splitJoinPriceAutoValue = splitJoinPriceAutoAmount > 0 ? String(splitJoinPriceAutoAmount) : "";
  const hasSelectedCommunityAutopublish = selectedCommunityAutopublishIds.length > 0;
  const showPublicationFields = !isPrivate || hasSelectedCommunityAutopublish;
  const shouldShowPublicationJoinPriceField = !usePublicCreateWizard;
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
          ? `Оплатить ${splitSharePartLabel} стоимости · ${formatPrice(splitShareAmount)} ₽`
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
            ? buildSplitSubscriptionStatusLabel(
              splitSubscriptions,
              splitSubscriptionNamesById,
              splitRequiredSubscriptionVisits,
            )
            : `Подходящий абонемент не найден, доступна оплата ${splitSharePartLabel} стоимости.`
    )
    : null;
  const splitPaymentAvailabilityLabel = splitPaymentSelected ? splitSubscriptionsLabel : null;
  const splitPaymentAvailabilityLabelIsError = splitPaymentSelected ? Boolean(splitSubscriptionsError) : false;
  const publicCreateSplitShareLabel = `Оплачиваю только ${splitSharePartLabel} часть · ${formatPrice(splitShareAmount)} ₽`;
  const publicCreatePaymentSummaryLabel = splitPaymentSelected
    ? "Каждый платит за себя"
    : "Я оплачиваю весь корт";
  const publicCreateSummaryCourtLabel = selectedCourt?.name || "Корт";
  const publicCreateSummaryTimeLabel = time ? `${time}-${addMinutesToTime(time, duration)}` : null;
  const publicCreateSummaryPaymentLine = publicCreatePaymentSummaryLabel;
  const shouldShowPublicSplitPaymentAvailabilityLabel = Boolean(
    splitPaymentAvailabilityLabel
    && (splitSubscriptionsLoading || splitPaymentAvailabilityLabelIsError),
  );
  const publicCreateJoinersCountNoun = createInviteSlotsCount % 10 === 1 && createInviteSlotsCount % 100 !== 11
    ? "игрок"
    : createInviteSlotsCount % 10 >= 2
      && createInviteSlotsCount % 10 <= 4
      && (createInviteSlotsCount % 100 < 12 || createInviteSlotsCount % 100 > 14)
      ? "игрока"
      : "игроков";
  const publicCreateJoinersCountVerb = createInviteSlotsCount === 1 ? "сможет" : "смогут";
  const publicCreateJoinersPillLabel = createInviteSlotsCount > 0
    ? `${createInviteSlotsCount} ${publicCreateJoinersCountNoun} ${publicCreateJoinersCountVerb} присоединиться`
    : "Новых игроков присоединить нельзя";
  const publicCreateJoinersSentenceLabel = createInviteSlotsCount > 0
    ? `${publicCreateJoinersCountVerb} присоединиться ${createInviteSlotsCount} ${publicCreateJoinersCountNoun}`
    : "нельзя присоединить новых игроков";
  const publicCreateSplitPaymentDescription = createInviteSlotsCount > 0
    ? `Вы оплачиваете только своё участие. Будет создана игра, к которой ${publicCreateJoinersSentenceLabel}, оплатив свою часть.`
    : "Вы оплачиваете только своё участие.";
  const publicCreateFullCourtDescription = "Вы оплачиваете весь корт сами. После создания игру можно открыть для всех или оставить приватной.";
  const publicCreateVisibilityOpenDescription = "К игре может присоединиться любой игрок подходящего уровня";
  const publicCreateVisibilityPrivateDescription = "Присоединиться можно по ссылке или в сообществе, где игра опубликована";
  const publicCreateVisibilityOpenPillLabel = "Быстрее собрать";
  const publicCreateVisibilityPrivatePillLabel = "Для своих";
  const publicCreateGeneralListCardLabel = "Общий список игр";
  const shouldShowPublicSplitSubscriptionBadge = splitHasSubscriptionPaymentOptions
    && !splitSubscriptionsLoading
    && !splitPaymentAvailabilityLabelIsError;
  const shouldShowPublicSplitSubscriptionInfoBadge = !splitHasSubscriptionPaymentOptions
    && !splitSubscriptionsLoading
    && !splitPaymentAvailabilityLabelIsError;
  const renderSelectedParamsChips = () => (
    <div className="game-selected-params-chips" role="list" aria-label="Выбранные параметры игры">
      <div className="game-selected-param-chip" role="listitem">
        <span>{`${duration} мин`}</span>
      </div>
      {selectedDateChipLabel && (
        <div className="game-selected-param-chip" role="listitem">
          <span>{selectedDateChipLabel}</span>
        </div>
      )}
      {time && (
        <div className="game-selected-param-chip game-selected-param-chip--dismissible" role="listitem">
          <span>{time}</span>
          <button
            type="button"
            className="game-selected-param-chip-remove"
            onClick={resetSelectedTime}
            aria-label="Сбросить выбранное время"
          >
            ×
          </button>
        </div>
      )}
      {selectedCourt && (
        <div className="game-selected-param-chip game-selected-param-chip--dismissible" role="listitem">
          <span>{selectedCourt.name}</span>
          <button
            type="button"
            className="game-selected-param-chip-remove"
            onClick={resetSelectedCourt}
            aria-label="Сбросить выбранный корт"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
  const renderPublicCreateVisibilityPillIcon = (mode: "public" | "private") => (
    mode === "public" ? (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8.92 1.75L4.7 8.08H7.4L6.63 14.25L10.96 7.92H8.2L8.92 1.75Z" fill="currentColor" />
      </svg>
    ) : (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="4.2" y="7.2" width="7.6" height="5.7" rx="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.75 7.2V5.95C5.75 4.72 6.76 3.7 8 3.7C9.24 3.7 10.25 4.72 10.25 5.95V7.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="8" cy="10" r="0.8" fill="currentColor" />
      </svg>
    )
  );
  const renderPublicCreateSummaryIcon = (kind: "place" | "calendar" | "clock" | "duration" | "players") => {
    switch (kind) {
      case "place":
        return (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M10 17C13.5 13.1 15.25 10.32 15.25 7.97C15.25 5.23 12.9 3 10 3C7.1 3 4.75 5.23 4.75 7.97C4.75 10.32 6.5 13.1 10 17Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <circle cx="10" cy="7.9" r="1.95" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        );
      case "calendar":
        return (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <rect x="3.25" y="4.75" width="13.5" height="11.5" rx="2.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M6.5 3.25V6.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M13.5 3.25V6.25" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M3.25 8H16.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        );
      case "clock":
        return (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="6.9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10 6.6V10L12.55 11.55" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case "duration":
        return (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="11" r="5.9" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M10 8.3V11L12.05 12.35" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M7.1 3.75H12.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M6 5.2L4.9 4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M14 5.2L15.1 4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        );
      case "players":
        return (
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="7.1" cy="7.15" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M3.9 14.6C4.1 12.6 5.43 11.25 7.1 11.25C8.77 11.25 10.1 12.6 10.3 14.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            <circle cx="13.55" cy="8.05" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M11.55 14.25C11.78 12.82 12.78 11.85 13.97 11.85C15.16 11.85 16.16 12.82 16.39 14.25" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        );
      default:
        return null;
    }
  };
  const publicCreateFinalSubmitTitle = splitPaymentSelected
    ? (
      splitCheckoutMode === "subscription" && splitHasSubscriptionPaymentOptions
        ? "Создать игру с помощью подписки"
        : `Создать игру и оплатить ${formatPrice(splitShareAmount)} ₽`
    )
    : (
      paymentAmount != null && paymentAmount > 0
        ? `Создать игру и оплатить ${formatPrice(paymentAmount)} ₽`
        : "Создать игру"
    );
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
        setSplitSubscriptionNamesById({});
        setSplitSubscriptionsError(result.error.message || "Не удалось получить абонементы");
        return;
      }

      const subscriptions = Array.isArray(result.data?.content) ? result.data.content : [];
      const eligible = filterSplitEligibleSubscriptions(
        subscriptions,
        splitRequiredTypeIds,
        splitRequiredDirectionIds,
        studioId,
        splitRequiredSubscriptionVisits,
        duration,
        selectedDate ? formatDateLocalIso(selectedDate) : null,
      );
      const eligibleNameKeys = new Set(
        eligible
          .map((item) => normalizeComparableId(item.subscriptionId))
          .filter((value): value is string => Boolean(value)),
      );

      setSplitSubscriptions(eligible);
      setSplitSubscriptionNamesById((current) => {
        if (eligibleNameKeys.size === 0) return {};
        const next: Record<string, string> = {};
        eligibleNameKeys.forEach((key) => {
          if (current[key]) {
            next[key] = current[key];
          }
        });
        return next;
      });
      setSplitSubscriptionsError(null);

      if (eligible.length > 0) {
        try {
          const profileResult = await apiFetchProfile();
          if (splitSubscriptionRequestRef.current !== requestId) return;

          const phone = String(profileResult.data?.phone || "").trim();
          if (phone) {
            const names = await Promise.all(
              eligible.map(async (item) => {
                const subscriptionId = String(item.subscriptionId || "").trim();
                const key = normalizeComparableId(subscriptionId);
                if (!subscriptionId || !key) return null;

                const response = await apiFetchSubscriptioName(subscriptionId, phone);
                const name = String(response.data?.sertName || "").trim();
                if (!name) return null;
                return { key, name };
              }),
            );
            if (splitSubscriptionRequestRef.current !== requestId) return;
            setSplitSubscriptionNamesById((current) => {
              const next = { ...current };
              names.forEach((entry) => {
                if (!entry) return;
                next[entry.key] = entry.name;
              });
              return next;
            });
          }
        } catch {
          // intentionally ignore name lookup errors; fallback labels are still usable
        }
      }
    } catch {
      if (splitSubscriptionRequestRef.current !== requestId) return;
      setSplitSubscriptions([]);
      setSplitSubscriptionNamesById({});
      setSplitSubscriptionsError("Не удалось получить абонементы");
    } finally {
      if (splitSubscriptionRequestRef.current === requestId) {
        setSplitSubscriptionsLoading(false);
      }
    }
  }, [
    duration,
    selectedDate,
    splitRequiredDirectionIds,
    splitRequiredSubscriptionVisits,
    splitRequiredTypeIds,
    studioId,
  ]);
  const handlePaymentModeSwitchTap = useCallback(() => {
    setPaymentMode((current) => {
      const nextMode = current === "split" ? "self" : "split";
      if (nextMode === "split") {
        setSplitShareCount(splitShareCountByGameFormat);
      }
      return nextMode;
    });
  }, [splitShareCountByGameFormat]);
  useEffect(() => {
    setSplitShareCount(splitShareCountByGameFormat);
  }, [splitShareCountByGameFormat]);
  useEffect(() => {
    if (!splitPaymentSelected) return;
    void loadSplitSubscriptions();
  }, [splitPaymentSelected, loadSplitSubscriptions]);
  useEffect(() => {
    if (!splitPaymentSelected) {
      setSplitCheckoutMode("one_time");
      return;
    }
    setSplitCheckoutMode(splitHasSubscriptionPaymentOptions ? "subscription" : "one_time");
  }, [splitPaymentSelected, splitHasSubscriptionPaymentOptions]);
  useEffect(() => {
    if (!splitHasSubscriptionPaymentOptions) {
      setSelectedSplitSubscriptionId(null);
      return;
    }
    setSelectedSplitSubscriptionId((current) => {
      if (current && splitSubscriptionPaymentOptions.some((option) => option.subscriptionId === current)) {
        return current;
      }
      return splitSubscriptionPaymentOptions[0]?.subscriptionId ?? null;
    });
  }, [splitHasSubscriptionPaymentOptions, splitSubscriptionPaymentOptions]);
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
    notifyGameRecordsUpdated([incoming], "games_upsert_record");
  }, [gameRecordId]);
  const removeGameRecordFromStores = useCallback((targetId: string) => {
    const normalizedId = targetId.trim();
    if (!normalizedId) return;
    setCommunityGames((prev) => prev.filter((item) => item.id !== normalizedId));
    setActiveGameRecordStore((prev) => (prev?.id === normalizedId ? null : prev));
  }, []);
  const hideCancelledGameRecord = useCallback(async (record: PadelGameRecord) => {
    const normalizedId = (record.id || "").trim();
    if (!normalizedId) return;

    const cancelledRecord: PadelGameRecord = {
      ...record,
      status: "CANCELLED",
    };
    upsertGameRecordInStores(cancelledRecord, { communityMode: "if_exists" });
    removeGameRecordFromStores(normalizedId);

    setGameRecordStatus("CANCELLED");
    setGamePaid(false);
    setGamePaymentUrl(null);
    setGameRecordError("Игра отменена и скрыта из списка");

    const patchResult = await apiUpdatePadelGameRecord(normalizedId, {
      status: "CANCELLED",
    });
    if (patchResult.data?.id) {
      removeGameRecordFromStores(normalizedId);
      setGameRecordStatus("CANCELLED");
      setGamePaid(false);
      setGamePaymentUrl(null);
    }
  }, [removeGameRecordFromStores, upsertGameRecordInStores]);
  const activeGameRecord = useMemo(
    () => {
      if (!gameRecordId) return null;
      if (activeGameRecordStore?.id === gameRecordId) return activeGameRecordStore;
      return communityGames.find((item) => item.id === gameRecordId) ?? null;
    },
    [activeGameRecordStore, communityGames, gameRecordId],
  );
  const isReadOnlySyntheticGame = useMemo(
    () => isSyntheticCabinetBookingGame(activeGameRecord),
    [activeGameRecord],
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
    && !isGameCancelledStatus(gameRecordStatus)
    && Boolean(inviteLink);
  const detailsMaxPlayers = useMemo(
    () => resolveGameDetailsMaxPlayers(activeGameRecord),
    [activeGameRecord],
  );
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
      id:
        activeGameRecord?.organizer?.id
        ?? detailsOrganizerPlayer?.id
        ?? (typeof activeGameMetadata?.organizerId === "string" ? activeGameMetadata.organizerId : null)
        ?? null,
      name: activeGameRecord?.organizer?.name ?? detailsOrganizerPlayer?.name ?? "Организатор",
      phone:
        activeGameRecord?.organizer?.phone
        ?? detailsOrganizerPlayer?.phone
        ?? (
          typeof activeGameMetadata?.organizerPhoneNorm === "string"
            ? activeGameMetadata.organizerPhoneNorm
            : (typeof activeGameMetadata?.organizerPhone === "string" ? activeGameMetadata.organizerPhone : null)
        )
        ?? null,
      photo: activeGameRecord?.organizer?.photo ?? detailsOrganizerPlayer?.photo ?? null,
      rating: activeGameRecord?.organizer?.rating ?? detailsOrganizerPlayer?.rating ?? null,
      ratingNumeric:
        activeGameRecord?.organizer?.ratingNumeric
        ?? detailsOrganizerPlayer?.ratingNumeric
        ?? null,
    }),
    [
      activeGameRecord?.organizer,
      activeGameMetadata?.organizerId,
      activeGameMetadata?.organizerPhone,
      activeGameMetadata?.organizerPhoneNorm,
      detailsOrganizerPlayer,
    ],
  );
  const detailsOrganizerHasIdentity = useMemo(() => Boolean(
    normalizeComparableId(detailsOrganizerPayload.id)
    || normalizePhoneForGame(detailsOrganizerPayload.phone),
  ), [detailsOrganizerPayload.id, detailsOrganizerPayload.phone]);
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
  const detailsMatchResultRatingWork = useMemo(() => {
    const rawMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : null;
    const rawRatingWork = rawMatchResult && isRecordObject(rawMatchResult.ratingWork)
      ? rawMatchResult.ratingWork
      : null;
    if (!rawRatingWork) return null;
    return {
      status: typeof rawRatingWork.status === "string" ? rawRatingWork.status.trim().toUpperCase() : null,
      appliedAt: typeof rawRatingWork.appliedAt === "string" ? rawRatingWork.appliedAt : null,
      revertedAt: typeof rawRatingWork.revertedAt === "string" ? rawRatingWork.revertedAt : null,
      nextAttemptAt: typeof rawRatingWork.nextAttemptAt === "string" ? rawRatingWork.nextAttemptAt : null,
      lastError: typeof rawRatingWork.lastError === "string" ? rawRatingWork.lastError : null,
    };
  }, [detailsMetadata]);
  const detailsMatchResultModelVersion = useMemo(() => {
    const rawMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : null;
    const version = toFiniteNumber(rawMatchResult?.resultModelVersion);
    return version != null ? Math.max(1, Math.floor(version)) : 1;
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
    const organizerParticipant = detailsOrganizerPlayer && detailsOrganizerInMatch
      ? {
          ...detailsOrganizerPlayer,
          source: "ORGANIZER" as const,
          status: "CONFIRMED" as const,
        }
      : null;

    const rosterParticipants = detailsSourceParticipants
      .filter((player) => {
        if (!detailsOrganizerInMatch && detailsOrganizerKey) {
          return getPadelPlayerIdentityKey(player) !== detailsOrganizerKey;
        }
        return true;
      })
      .map((player) => ({
        ...player,
        source: player.source ?? "INVITE_LINK",
        status: player.status ?? "CONFIRMED",
      }));

    return dedupePlayersByIdentity([
      organizerParticipant,
      ...rosterParticipants,
    ]).slice(0, detailsMaxPlayers);
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
    return excludePlayersAlreadyInRoster(sourceWaitlist, detailsParticipants);
  }, [activeGameRecord?.waitlist, waitlistPlayers, detailsParticipants]);
  const detailsPlayerPool = useMemo<PadelGamePlayer[]>(() => {
    const sessionRosterSnapshot = isRecordObject(detailsMatchResultSession?.rosterSnapshot)
      ? detailsMatchResultSession.rosterSnapshot as Record<string, unknown>
      : null;
    const snapshotPool = sessionRosterSnapshot
      ? extractMatchResultSnapshotPlayers(sessionRosterSnapshot)
      : [];
    const rawPool = snapshotPool.length > 0
      ? snapshotPool
      : Array.isArray(detailsMetadata.playerPool)
        ? detailsMetadata.playerPool
      : Array.isArray(detailsMetadata.playersPool)
        ? detailsMetadata.playersPool
        : Array.isArray(detailsMetadata.allPlayers)
          ? detailsMetadata.allPlayers
          : [];
    return dedupePlayersByIdentity(
      excludePlayersAlreadyInRoster(
        rawPool
          .map((item) => (
            isRecordObject(item) && "name" in item
              ? normalizeMatchResultRosterPlayer(item)
              : normalizeVivaBookingParticipant(item)
          ))
          .filter((item): item is PadelGamePlayer => Boolean(item)),
        detailsParticipants,
      ),
    );
  }, [detailsMatchResultSession, detailsMetadata, detailsParticipants]);
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
  const isDetailsOrganizerPlayer = useCallback((player: PadelGamePlayer | null | undefined) => {
    if (!player) return false;
    const source = String(player.source || "").trim().toUpperCase();
    if (source === "ORGANIZER") return true;
    if (detailsOrganizerPlayer && playersShareRosterIdentity(detailsOrganizerPlayer, player)) {
      return true;
    }
    return playersShareRosterIdentity(detailsOrganizerPayload, player);
  }, [detailsOrganizerPayload, detailsOrganizerPlayer]);
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
    const normalizedProfileId = normalizeComparableId(profileId);
    const playerId = normalizeComparableId(player.id);
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
  const detailsSplitPaymentMetadata = useMemo<Record<string, unknown> | null>(() => (
    isRecordObject(detailsMetadata.splitPayment) ? detailsMetadata.splitPayment : null
  ), [detailsMetadata]);
  const detailsCurrentUserActiveSplitPayment = useMemo<Record<string, unknown> | null>(() => {
    if (!hasCurrentUserIdentityInDetails || !detailsSplitPaymentMetadata) return null;
    const currentUserId = normalizeComparableId(profileId);
    const currentUserPhone = profilePhoneNorm ?? normalizePhoneForGame(profilePhone);
    if (!currentUserId && !currentUserPhone) return null;

    const payments = Array.isArray(detailsSplitPaymentMetadata.payments)
      ? detailsSplitPaymentMetadata.payments.filter((item) => isRecordObject(item))
      : [];
    for (const item of payments) {
      if (!isSplitPaymentReservationActive(item.status)) continue;
      if (isSplitPaymentPendingExpired(item, detailsSplitPaymentMetadata, splitPendingNowTs)) continue;
      const paymentId = normalizeComparableId(item.clientId);
      const paymentPhone = normalizePhoneForGame(
        typeof item.phoneNorm === "string"
          ? item.phoneNorm
          : (typeof item.phone === "string" ? item.phone : null),
      );
      if (currentUserId && paymentId && currentUserId === paymentId) return item;
      if (currentUserPhone && paymentPhone && currentUserPhone === paymentPhone) return item;
    }
    return null;
  }, [
    hasCurrentUserIdentityInDetails,
    detailsSplitPaymentMetadata,
    profileId,
    profilePhoneNorm,
    profilePhone,
    splitPendingNowTs,
  ]);
  const hasCurrentUserActiveSplitPayment = Boolean(detailsCurrentUserActiveSplitPayment);
  const detailsCurrentUserPendingSplitPayment = useMemo<Record<string, unknown> | null>(() => {
    if (!detailsCurrentUserActiveSplitPayment) return null;
    const status = String(detailsCurrentUserActiveSplitPayment.status || "").trim().toUpperCase();
    return status === "PAYMENT_PENDING" ? detailsCurrentUserActiveSplitPayment : null;
  }, [detailsCurrentUserActiveSplitPayment]);
  const detailsCurrentUserPendingSplitPaymentDeadlineTs = useMemo(() => (
    resolveSplitPaymentItemDeadlineTs(detailsCurrentUserPendingSplitPayment, detailsSplitPaymentMetadata)
  ), [detailsCurrentUserPendingSplitPayment, detailsSplitPaymentMetadata]);
  const detailsCurrentUserPendingSplitPaymentRemainingMs = detailsCurrentUserPendingSplitPaymentDeadlineTs == null
    ? null
    : Math.max(0, detailsCurrentUserPendingSplitPaymentDeadlineTs - splitPendingNowTs);
  const detailsCurrentUserPendingSplitPaymentPaymentUrl = typeof detailsCurrentUserPendingSplitPayment?.paymentUrl === "string"
    ? detailsCurrentUserPendingSplitPayment.paymentUrl.trim()
    : "";
  const detailsCurrentUserPendingSplitPaymentIsExpired = Boolean(
    detailsCurrentUserPendingSplitPayment
    && detailsCurrentUserPendingSplitPaymentDeadlineTs != null
    && detailsCurrentUserPendingSplitPaymentDeadlineTs <= splitPendingNowTs,
  );
  const detailsCurrentUserPendingSplitPaymentCountdownLabel = detailsCurrentUserPendingSplitPaymentRemainingMs == null
    ? null
    : formatSplitPaymentTimeLeft(detailsCurrentUserPendingSplitPaymentRemainingMs);
  const isDetailsSplitPaymentGame = Boolean(
    activeGameRecord?.settings?.payMode === "split"
    || hasSplitPaymentSignal(detailsSplitPaymentMetadata),
  );
  const detailsNeedsVivaRosterSync = isDetailsSplitPaymentGame
    || isCabinetBookingConvertedGame(activeGameRecord);
  const detailsSplitOccupancy = useMemo(() => resolveSplitPaymentOccupancy({
    participants: detailsParticipants,
    payments: Array.isArray(detailsSplitPaymentMetadata?.payments)
      ? detailsSplitPaymentMetadata.payments
      : [],
    maxPlayers: detailsMaxPlayers,
    nowTs: splitPendingNowTs,
    splitPayment: detailsSplitPaymentMetadata,
    paymentDeadlineMinutes: SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES,
  }), [
    detailsParticipants,
    detailsSplitPaymentMetadata,
    detailsMaxPlayers,
    splitPendingNowTs,
  ]);
  const detailsOccupiedSlotsCount = useMemo(() => {
    if (!isDetailsSplitPaymentGame) {
      return Math.min(detailsParticipants.length, detailsMaxPlayers);
    }
    return detailsSplitOccupancy.occupiedSlotsCount;
  }, [
    isDetailsSplitPaymentGame,
    detailsParticipants.length,
    detailsMaxPlayers,
    detailsSplitOccupancy,
  ]);
  const detailsHasFreeSlots = detailsOccupiedSlotsCount < detailsMaxPlayers;
  const detailsExpiredSplitPendingCleanupKeys = useMemo<string[]>(() => {
    if (!isDetailsSplitPaymentGame || !detailsSplitPaymentMetadata) return [];
    const payments = Array.isArray(detailsSplitPaymentMetadata.payments)
      ? detailsSplitPaymentMetadata.payments.filter((item) => isRecordObject(item))
      : [];

    return payments
      .map((item, index) => {
        const status = String(item.status || "").trim().toUpperCase();
        if (status !== "PAYMENT_PENDING") return null;
        const deadlineTs = resolveSplitPaymentItemDeadlineTs(item, detailsSplitPaymentMetadata);
        if (deadlineTs == null || deadlineTs > splitPendingNowTs) return null;

        const paymentRef = typeof item.paymentRef === "string" ? item.paymentRef.trim().toLowerCase() : "";
        const clientId = normalizeComparableId(item.clientId ?? item.playerId ?? item.userId) || "";
        const phoneNorm = normalizePhoneForGame(
          typeof item.phoneNorm === "string"
            ? item.phoneNorm
            : (typeof item.phone === "string" ? item.phone : null),
        ) || "";
        const bookingId = normalizeBookingId(item.bookingId) || "";
        return `${paymentRef}|${clientId}|${phoneNorm}|${bookingId}|${index}`;
      })
      .filter((value): value is string => Boolean(value));
  }, [isDetailsSplitPaymentGame, detailsSplitPaymentMetadata, splitPendingNowTs]);
  const detailsWaitlistPaymentStateByKey = useMemo(() => {
    const byPlayerKey = new Map<string, {
      isPending: boolean;
      isExpired: boolean;
      countdownLabel: string | null;
    }>();
    if (!isDetailsSplitPaymentGame || !detailsSplitPaymentMetadata || detailsWaitlist.length === 0) {
      return byPlayerKey;
    }

    const payments = Array.isArray(detailsSplitPaymentMetadata.payments)
      ? detailsSplitPaymentMetadata.payments.filter((item) => isRecordObject(item))
      : [];

    detailsWaitlist.forEach((player, index) => {
      const playerKey = getPadelPlayerIdentityKey(player) || `waitlist-${index}`;
      const matchedPendingItem = payments
        .filter((item) => splitPaymentItemMatchesPlayer(item, player))
        .sort((left, right) => {
          const leftTs = resolveSplitPaymentItemDeadlineTs(left, detailsSplitPaymentMetadata)
            ?? parseIsoTimestamp(left.createdAt)
            ?? 0;
          const rightTs = resolveSplitPaymentItemDeadlineTs(right, detailsSplitPaymentMetadata)
            ?? parseIsoTimestamp(right.createdAt)
            ?? 0;
          return rightTs - leftTs;
        })
        .find((item) => String(item.status || "").trim().toUpperCase() === "PAYMENT_PENDING");

      if (!matchedPendingItem) return;
      const deadlineTs = resolveSplitPaymentItemDeadlineTs(matchedPendingItem, detailsSplitPaymentMetadata);
      const remainingMs = deadlineTs == null ? null : Math.max(0, deadlineTs - splitPendingNowTs);
      byPlayerKey.set(playerKey, {
        isPending: deadlineTs == null || (remainingMs ?? 0) > 0,
        isExpired: deadlineTs != null && (remainingMs ?? 0) <= 0,
        countdownLabel: remainingMs == null ? null : formatSplitPaymentTimeLeft(remainingMs),
      });
    });

    return byPlayerKey;
  }, [isDetailsSplitPaymentGame, detailsSplitPaymentMetadata, detailsWaitlist, splitPendingNowTs]);
  const detailsSplitShareCount = useMemo<2 | 4>(() => {
    const shareCount = toFiniteNumber(detailsSplitPaymentMetadata?.shareCount);
    if (shareCount === 2) return 2;
    return detailsMaxPlayers <= 2 ? 2 : 4;
  }, [detailsSplitPaymentMetadata, detailsMaxPlayers]);
  const detailsSplitShareAmount = useMemo(() => {
    const fromSplit = toFiniteNumber(
      detailsSplitPaymentMetadata?.shareAmount
      ?? detailsSplitPaymentMetadata?.amount
      ?? detailsSplitPaymentMetadata?.toPay,
    );
    if (fromSplit != null && fromSplit > 0) return Math.round(fromSplit);

    const fromJoinPrice = toFiniteNumber(extractGameJoinPrice(detailsMetadata));
    if (fromJoinPrice != null && fromJoinPrice > 0) return Math.round(fromJoinPrice);
    return null;
  }, [detailsSplitPaymentMetadata, detailsMetadata]);
  const isDetailsWaitlistEnabled = activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled;
  const canCurrentUserJoinGameInDetails = Boolean(
    gameRecordId
    && !isReadOnlySyntheticGame
    && !isCurrentUserOrganizerByDetails
    && !updatingGameRoster
    && !updatingGameMeta
    && !joiningSplitPayment
    && hasCurrentUserIdentityInDetails
    && !isCurrentUserConfirmedParticipant
    && !isCurrentUserInWaitlist
    && !isDetailsSplitPaymentGame
    && (detailsHasFreeSlots || isDetailsWaitlistEnabled),
  );
  const canCurrentUserJoinSplitGameInDetails = Boolean(
    gameRecordId
    && !isReadOnlySyntheticGame
    && isDetailsSplitPaymentGame
    && !isCurrentUserOrganizerByDetails
    && !updatingGameRoster
    && !updatingGameMeta
    && !joiningSplitPayment
    && hasCurrentUserIdentityInDetails
    && !isCurrentUserConfirmedParticipant
    && !isCurrentUserInWaitlist
    && !hasCurrentUserActiveSplitPayment
    && detailsHasFreeSlots
  );
  const detailsSplitJoinSubscriptionLabel = joiningSplitPayment
    ? "Готовим оплату..."
    : "Списать с абонемента";
  const detailsSplitJoinOneTimeLabel = joiningSplitPayment
    ? "Готовим оплату..."
    : `Оплатить стоимость${detailsSplitShareAmount != null ? ` · ${formatPrice(detailsSplitShareAmount)} ₽` : ""}`;
  const shouldShowCurrentUserLeaveActionInDetails = !isCurrentUserOrganizerOfActiveGame
    && !isCurrentUserOrganizerByDetails;
  const canCurrentUserLeaveGameInDetails = Boolean(
    gameRecordId
    && !isReadOnlySyntheticGame
    && shouldShowCurrentUserLeaveActionInDetails
    && !updatingGameRoster
    && !updatingGameMeta
    && (
      isCurrentUserConfirmedParticipant
      || detailsWaitlist.some((player) => isCurrentUserPlayer(player))
      || Boolean(detailsCurrentUserPendingSplitPayment && !detailsCurrentUserPendingSplitPaymentIsExpired)
    ),
  );
  const detailsTeamSlotKeys = useMemo(
    () => detailsTeamSlots.map((player) => getPadelPlayerIdentityKey(player) || null),
    [detailsTeamSlots],
  );
  const detailsCurrentUserTeamSlotIndex = useMemo(
    () => detailsTeamSlots.findIndex((player) => isCurrentUserPlayer(player)),
    [detailsTeamSlots, isCurrentUserPlayer],
  );
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
  const canCurrentUserAccessResultTab = !isReadOnlySyntheticGame && (
    isDetailsMatchStarted
    || isCurrentUserOrganizerByDetails
    || isCurrentUserConfirmedParticipant
  );
  const canCurrentUserFetchResultState = Boolean(
    !isReadOnlySyntheticGame
    && profilePhoneNorm
    && (isCurrentUserOrganizerByDetails || isCurrentUserConfirmedParticipant),
  );

  useEffect(() => {
    if (step !== "details" && step !== "chat") return;
    setSplitPendingNowTs(Date.now());
    const timer = window.setInterval(() => {
      setSplitPendingNowTs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [step]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !activeGameRecord?.id) return;
    if (!isDetailsSplitPaymentGame) return;
    if (detailsExpiredSplitPendingCleanupKeys.length === 0) return;
    if (splitTimeoutCleanupInFlightRef.current) return;

    const nowTs = Date.now();
    const RETRY_MS = 60 * 1000;
    const shouldRunCleanup = detailsExpiredSplitPendingCleanupKeys.some((key) => (
      nowTs - (splitTimeoutCleanupAttemptAtRef.current[key] ?? 0) >= RETRY_MS
    ));
    if (!shouldRunCleanup) return;

    detailsExpiredSplitPendingCleanupKeys.forEach((key) => {
      splitTimeoutCleanupAttemptAtRef.current[key] = nowTs;
    });
    splitTimeoutCleanupInFlightRef.current = true;

    let alive = true;
    void apiCleanupPadelGameByOrganizer(activeGameRecord.id, {
      force: false,
      dryRun: false,
      limit: 1,
      intent: "participant_timeout",
    }).then(async (cleanupResult) => {
      if (!alive || cleanupResult.error) return;

      const refreshed = await apiFetchPadelGameRecord(activeGameRecord.id);
      if (!alive || !refreshed.data?.id) return;

      const refreshedRecord = refreshed.data as PadelGameRecord;
      upsertGameRecordInStores(refreshedRecord, { communityMode: "if_exists" });
      setActiveGameRecordStore((prev) => (prev?.id === refreshedRecord.id ? refreshedRecord : prev));
      setParticipants(Array.isArray(refreshedRecord.participants) ? refreshedRecord.participants : []);
      setWaitlistPlayers(Array.isArray(refreshedRecord.waitlist) ? refreshedRecord.waitlist : []);
    }).finally(() => {
      splitTimeoutCleanupInFlightRef.current = false;
    });

    return () => {
      alive = false;
    };
  }, [
    step,
    activeGameRecord?.id,
    isDetailsSplitPaymentGame,
    detailsExpiredSplitPendingCleanupKeys,
    upsertGameRecordInStores,
  ]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !activeGameRecord?.id) return;
    if (!detailsNeedsVivaRosterSync) return;
    if (updatingGameRoster) return;

    const exerciseId = resolveGameVivaExerciseId(activeGameRecord);
    if (!exerciseId) return;

    if (shouldSkipRecentSplitGameRosterSync({
      record: activeGameRecord,
      isSplitPaymentGame: isDetailsSplitPaymentGame,
      sourceParticipantsCount: detailsSourceParticipants.length,
      leaveEventsCount: detailsLeaveEvents.length,
    })) {
      trackRosterSyncEvent("skipped", {
        gameId: activeGameRecord.id,
        exerciseId,
        reason: "recent_paid_create",
        sourceParticipantsCount: detailsSourceParticipants.length,
        leaveEventsCount: detailsLeaveEvents.length,
        durationMs: 0,
      });
      return;
    }

    const syncStartedAt = Date.now();
    trackRosterSyncEvent("started", {
      gameId: activeGameRecord.id,
      exerciseId,
      sourceParticipantsCount: detailsSourceParticipants.length,
      leaveEventsCount: detailsLeaveEvents.length,
    });

    let alive = true;
    void apiFetchTournamentParticipants(exerciseId, { sanitize: false })
      .then((result) => {
        if (!alive || !result.data) return;

        const vivaPlayers = extractExerciseBookingRows(result.data)
          .map((item) => normalizeVivaBookingParticipant(item))
          .filter((item): item is PadelGamePlayer => item !== null)
          .filter((item) => item.status !== "WAITLIST");
        if (vivaPlayers.length === 0) {
          trackRosterSyncEvent("skipped", {
            gameId: activeGameRecord.id,
            exerciseId,
            reason: "viva_empty",
            sourceParticipantsCount: detailsSourceParticipants.length,
            vivaParticipantsCount: 0,
            leaveEventsCount: detailsLeaveEvents.length,
            durationMs: Date.now() - syncStartedAt,
          });
          return;
        }

        const reconciliation = reconcileRosterWithViva({
          sourceParticipants: detailsSourceParticipants,
          vivaParticipants: vivaPlayers,
          leaveEvents: detailsLeaveEvents,
          organizerPlayer: detailsOrganizerPlayer,
        });

        const mergedParticipants = dedupePlayersByIdentity(reconciliation.mergedCandidates)
          .slice(0, detailsMaxPlayers);
        const participantsChanged = !arePlayersEqualByIdentity(mergedParticipants, detailsSourceParticipants);
        const leaveEventsChanged = reconciliation.staleLeaveEventsRemoved > 0;
        if (!participantsChanged && !leaveEventsChanged) {
          trackRosterSyncEvent("skipped", {
            gameId: activeGameRecord.id,
            exerciseId,
            reason: "no_changes",
            sourceParticipantsCount: detailsSourceParticipants.length,
            vivaParticipantsCount: vivaPlayers.length,
            leaveEventsCount: detailsLeaveEvents.length,
            staleLeaveEventsRemoved: 0,
            staleSourcePlayersRemoved: 0,
            durationMs: Date.now() - syncStartedAt,
          });
          return;
        }

        const patchPayload: Parameters<typeof apiUpdatePadelGameRecord>[1] = {
          participants: mergedParticipants,
        };
        if (leaveEventsChanged) {
          patchPayload.metadata = {
            ...detailsMetadata,
            leaveEvents: reconciliation.nextLeaveEvents,
            lastLeaveUpdateAt: new Date().toISOString(),
          };
        }

        void apiUpdatePadelGameRecord(activeGameRecord.id, patchPayload).then((patchResult) => {
          if (!alive) return;
          const durationMs = Date.now() - syncStartedAt;
          const restoredPlayersCount = Math.max(
            0,
            mergedParticipants.length - detailsSourceParticipants.length + reconciliation.filteredSourcePlayersCount,
          );
          if (patchResult.data?.id) {
            upsertGameRecordInStores(patchResult.data as PadelGameRecord, { communityMode: "if_exists" });
            trackRosterSyncEvent("applied", {
              gameId: activeGameRecord.id,
              exerciseId,
              sourceParticipantsCount: detailsSourceParticipants.length,
              vivaParticipantsCount: vivaPlayers.length,
              mergedParticipantsCount: mergedParticipants.length,
              leaveEventsCount: detailsLeaveEvents.length,
              staleLeaveEventsRemoved: reconciliation.staleLeaveEventsRemoved,
              staleSourcePlayersRemoved: reconciliation.staleSourcePlayersRemoved,
              restoredPlayersCount,
              durationMs,
            });
            return;
          }
          upsertGameRecordInStores(
            {
              ...activeGameRecord,
              participants: mergedParticipants,
              ...(leaveEventsChanged
                ? {
                    metadata: {
                      ...detailsMetadata,
                      leaveEvents: reconciliation.nextLeaveEvents,
                      lastLeaveUpdateAt: new Date().toISOString(),
                    },
                  }
                : {}),
            },
            { communityMode: "if_exists" },
          );
          trackRosterSyncEvent("applied", {
            gameId: activeGameRecord.id,
            exerciseId,
            sourceParticipantsCount: detailsSourceParticipants.length,
            vivaParticipantsCount: vivaPlayers.length,
            mergedParticipantsCount: mergedParticipants.length,
            leaveEventsCount: detailsLeaveEvents.length,
            staleLeaveEventsRemoved: reconciliation.staleLeaveEventsRemoved,
            staleSourcePlayersRemoved: reconciliation.staleSourcePlayersRemoved,
            restoredPlayersCount,
            durationMs,
            fallbackApplied: true,
          });
        }).catch(() => {
          trackRosterSyncEvent("failed", {
            gameId: activeGameRecord.id,
            exerciseId,
            sourceParticipantsCount: detailsSourceParticipants.length,
            vivaParticipantsCount: vivaPlayers.length,
            leaveEventsCount: detailsLeaveEvents.length,
            staleLeaveEventsRemoved: reconciliation.staleLeaveEventsRemoved,
            staleSourcePlayersRemoved: reconciliation.staleSourcePlayersRemoved,
            durationMs: Date.now() - syncStartedAt,
            reason: "patch_failed",
          });
          // Ignore sync errors: roster falls back to locally stored participants.
        });
      })
      .catch(() => {
        trackRosterSyncEvent("failed", {
          gameId: activeGameRecord.id,
          exerciseId,
          sourceParticipantsCount: detailsSourceParticipants.length,
          leaveEventsCount: detailsLeaveEvents.length,
          durationMs: Date.now() - syncStartedAt,
          reason: "viva_fetch_failed",
        });
        // Ignore sync errors: roster falls back to locally stored participants.
      });

    return () => {
      alive = false;
    };
  }, [
    step,
    activeGameRecord,
    detailsNeedsVivaRosterSync,
    isDetailsSplitPaymentGame,
    updatingGameRoster,
    detailsSourceParticipants,
    detailsLeaveEvents,
    detailsMetadata,
    detailsMaxPlayers,
    detailsOrganizerPlayer,
    upsertGameRecordInStores,
  ]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !activeGameRecord?.id) return;
    if (!isDetailsSplitPaymentGame || !detailsSplitPaymentMetadata) return;

    const splitPhones = extractSplitPaymentPhones(detailsSplitPaymentMetadata);
    if (splitPhones.length === 0) return;

    const existingAllRelated = Array.isArray(detailsMetadata.allRelatedPhones)
      ? detailsMetadata.allRelatedPhones
          .map((value) => (typeof value === "string" ? normalizePhoneForGame(value) : null))
          .filter((value): value is string => Boolean(value))
      : [];
    const nextAllRelatedPhones = Array.from(new Set([
      normalizePhoneForGame(detailsOrganizerPayload.phone),
      ...detailsParticipants
        .map((player) => normalizePhoneForGame(player.phone))
        .filter((value): value is string => Boolean(value)),
      ...detailsWaitlist
        .map((player) => normalizePhoneForGame(player.phone))
        .filter((value): value is string => Boolean(value)),
      ...splitPhones,
    ].filter((value): value is string => Boolean(value))));
    const existingKey = existingAllRelated.slice().sort().join(",");
    const nextKey = nextAllRelatedPhones.slice().sort().join(",");
    if (existingKey === nextKey) return;

    const repairKey = `${activeGameRecord.id}:${nextKey}`;
    if (splitRelatedPhonesRepairAttemptRef.current === repairKey) return;
    splitRelatedPhonesRepairAttemptRef.current = repairKey;

    let alive = true;
    void apiUpdatePadelGameRecord(activeGameRecord.id, {
      metadata: {
        ...detailsMetadata,
        allRelatedPhones: nextAllRelatedPhones,
      },
    }).then((result) => {
      if (!alive) return;
      if (result.data?.id) {
        upsertGameRecordInStores(result.data as PadelGameRecord, { communityMode: "if_exists" });
      } else {
        splitRelatedPhonesRepairAttemptRef.current = null;
      }
    }).catch(() => {
      if (!alive) return;
      splitRelatedPhonesRepairAttemptRef.current = null;
    });

    return () => {
      alive = false;
    };
  }, [
    step,
    activeGameRecord?.id,
    isDetailsSplitPaymentGame,
    detailsSplitPaymentMetadata,
    detailsMetadata,
    detailsOrganizerPayload.phone,
    detailsParticipants,
    detailsWaitlist,
    upsertGameRecordInStores,
  ]);

  useEffect(() => {
    setDetailsActiveTab(isDetailsMatchStarted && canCurrentUserAccessResultTab ? "result" : "game");
  }, [activeGameRecord?.id, isDetailsMatchStarted, canCurrentUserAccessResultTab]);

  useEffect(() => {
    detailsMatchResultSourceKeyRef.current = null;
    detailsMatchResultDraftDirtyRef.current = false;
    detailsMatchResultSessionOpenKeyRef.current = null;
    detailsMatchResultSessionSyncKeyRef.current = null;
    detailsMatchResultSessionRevisionRef.current = null;
    detailsMatchResultSessionContextRef.current = null;
    detailsMatchResultSessionConflictRef.current = false;
    detailsMatchResultSubmissionRef.current = null;
    if (detailsMatchResultSessionSaveTimerRef.current != null) {
      window.clearTimeout(detailsMatchResultSessionSaveTimerRef.current);
      detailsMatchResultSessionSaveTimerRef.current = null;
    }
    setDetailsMatchResultSession(null);
  }, [activeGameRecord?.id]);

  useEffect(() => {
    setDetailsLeaveHistoryOpen(false);
  }, [activeGameRecord?.id]);

  useEffect(() => {
    if (detailsActiveTab === "result" && !canCurrentUserAccessResultTab) {
      setDetailsActiveTab("game");
    }
  }, [detailsActiveTab, canCurrentUserAccessResultTab]);

  useEffect(() => {
    const rawMatchResult = isRecordObject(detailsMetadata.matchResult)
      ? detailsMetadata.matchResult
      : buildFallbackMatchResultFromGameRecord(activeGameRecord);
    const sessionDraftMatchResult: Record<string, unknown> | null = detailsMatchResultSession
      ? {
          sets: detailsMatchResultSession.draftSets,
          setPairings: detailsMatchResultSession.draftPairings,
          attachments: detailsMatchResultSession.attachments,
        }
      : null;
    const draftMatchResult = mergeMatchResultWithSessionDraft(rawMatchResult, sessionDraftMatchResult);
    const matchResultSourceKey = buildMatchResultSourceKey(gameRecordId, draftMatchResult);
    if (detailsMatchResultDraftDirtyRef.current) {
      return;
    }

    const sessionRosterSnapshot = isRecordObject(detailsMatchResultSession?.rosterSnapshot)
      ? detailsMatchResultSession.rosterSnapshot as Record<string, unknown>
      : isRecordObject(rawMatchResult?.rosterSnapshot)
        ? rawMatchResult.rosterSnapshot as Record<string, unknown>
        : null;
    const rosterPlayers = dedupePlayersByIdentity([
      ...extractMatchResultSnapshotPlayers(sessionRosterSnapshot),
      ...detailsParticipants,
      ...detailsWaitlist,
      ...detailsPlayerPool,
    ]);
    const participantByKey = new Map<string, PadelGamePlayer>();
    const participantByLookupKey = new Map<string, PadelGamePlayer>();

    rosterPlayers.forEach((player) => {
      const key = getPadelPlayerIdentityKey(player);
      if (!key) return;
      participantByKey.set(key, player);
      getPadelPlayerLookupKeys(player).forEach((lookupKey) => {
        if (!participantByLookupKey.has(lookupKey)) {
          participantByLookupKey.set(lookupKey, player);
        }
      });
    });

    const resolvePlayer = (value: unknown): PadelGamePlayer | null => {
      const lookupKeys = buildMatchResultParticipantLookupKeys(value);
      for (const lookupKey of lookupKeys) {
        const player = participantByLookupKey.get(lookupKey);
        if (player) return player;
      }
      return null;
    };
    const resolvePlayerKey = (value: unknown): string | null => getPadelPlayerIdentityKey(resolvePlayer(value)) || null;

    const latestDraftPairing = Array.isArray(draftMatchResult?.setPairings)
      ? draftMatchResult.setPairings
          .filter((item): item is Record<string, unknown> => isRecordObject(item))
          .filter((item) => Array.isArray(item.teamSlots) && item.teamSlots.some(Boolean))
          .sort((left, right) => Number(right.setIndex ?? 0) - Number(left.setIndex ?? 0))[0]
      : null;
    const rawTeamSlots = Array.isArray(latestDraftPairing?.teamSlots)
      ? latestDraftPairing.teamSlots
      : Array.isArray(sessionRosterSnapshot?.initialTeamSlots)
        ? sessionRosterSnapshot.initialTeamSlots
      : Array.isArray(detailsMetadata.teamSlots)
        ? detailsMetadata.teamSlots
        : [];
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

    const nextSlotPlayers = nextSlotKeys.map((key) => (key ? participantByKey.get(key) ?? null : null));

    setDetailsTeamSlots(nextSlotPlayers);
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

    detailsMatchResultSourceKeyRef.current = matchResultSourceKey;
    detailsMatchResultDraftDirtyRef.current = false;

    if (!draftMatchResult) {
      setDetailsMatchResultSets([{ left: "", right: "" }]);
      setDetailsMatchResultSetPairings(createEmptyMatchResultSetPairings());
      setDetailsMatchResultStatus(null);
      setDetailsMatchResultSubmittedBy(null);
      setDetailsMatchResultSubmittedAt(null);
      setDetailsMatchResultDisputeDeadlineAt(null);
      setDetailsMatchResultConfirmedBy(null);
      setDetailsMatchResultConfirmedAt(null);
      setDetailsMatchResultRatingImpact([]);
      setDetailsMatchResultViewerRole(null);
      setDetailsMatchResultDisputedBy(null);
      setDetailsMatchResultDisputedAt(null);
      setDetailsMatchResultAttachments([]);
      setGameDetailsMetaError(null);
      return;
    }

    const parsedSets = Array.isArray(draftMatchResult.sets)
      ? draftMatchResult.sets
          .map((item) => {
            if (!isRecordObject(item)) return null;
            const leftRaw = item.left == null ? "" : String(item.left);
            const rightRaw = item.right == null ? "" : String(item.right);
            if (leftRaw.trim() !== "" && !Number.isFinite(Number(leftRaw))) return null;
            if (rightRaw.trim() !== "" && !Number.isFinite(Number(rightRaw))) return null;
            return {
              left: normalizeScoreInput(leftRaw),
              right: normalizeScoreInput(rightRaw),
            };
          })
          .filter((item): item is EditableMatchResultSet => Boolean(item))
      : [];
    const parsedSetPairings = createEmptyMatchResultSetPairings(Math.max(parsedSets.length, 1));
    const rawSetPairings = Array.isArray(draftMatchResult.setPairings)
      ? draftMatchResult.setPairings
      : Array.isArray(draftMatchResult.effectiveSetPairings)
        ? draftMatchResult.effectiveSetPairings
      : Array.isArray(draftMatchResult.pairings)
        ? draftMatchResult.pairings
        : [];

    rawSetPairings.forEach((item: unknown, rawIndex: number) => {
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
      if (setIndex < 0) return;

      const resolvedSlots = cloneTeamSlots(
        rawTeamSlots.map((value) => {
          const player = resolvePlayer(value);
          return player ? participantByKey.get(getPadelPlayerIdentityKey(player)) ?? player : null;
        }),
      );

      if (!resolvedSlots.some(Boolean)) return;
      parsedSetPairings[setIndex] = resolvedSlots;
    });
    const normalizedSetPairings = materializeCompletedMatchResultSetPairings(
      parsedSetPairings,
      parsedSets.length,
    );

    const normalizedStatus = draftMatchResult ? normalizeMatchResultStatus(draftMatchResult.status) : null;
    const submittedAt = draftMatchResult && typeof draftMatchResult.submittedAt === "string"
      ? draftMatchResult.submittedAt
      : null;

    setDetailsMatchResultSets(
      normalizeEditableScoreSets(parsedSets.length > 0 ? parsedSets : [{ left: "", right: "" }]),
    );
    setDetailsMatchResultSetPairings(normalizedSetPairings);
    setDetailsMatchResultStatus(normalizedStatus || null);
    setDetailsMatchResultSubmittedBy(toPerson(draftMatchResult?.submittedBy));
    setDetailsMatchResultSubmittedAt(submittedAt);
    setDetailsMatchResultDisputeDeadlineAt(
      getMatchResultDisputeDeadlineAt(
        submittedAt,
        draftMatchResult && typeof draftMatchResult.disputeDeadlineAt === "string"
          ? draftMatchResult.disputeDeadlineAt
          : draftMatchResult && typeof draftMatchResult.reviewDeadlineAt === "string"
            ? draftMatchResult.reviewDeadlineAt
            : null,
        detailsDateKey,
      ),
    );
    setDetailsMatchResultConfirmedBy(toPerson(draftMatchResult?.confirmedBy));
    setDetailsMatchResultConfirmedAt(
      draftMatchResult && typeof draftMatchResult.confirmedAt === "string" ? draftMatchResult.confirmedAt : null,
    );
    setDetailsMatchResultRatingImpact(normalizeMatchResultRatingImpact(draftMatchResult?.ratingImpact));
    setDetailsMatchResultViewerRole(
      isRecordObject(draftMatchResult?.viewer) && typeof draftMatchResult.viewer.role === "string"
        ? draftMatchResult.viewer.role.trim().toUpperCase() || null
        : null,
    );
    setDetailsMatchResultDisputedBy(toPerson(draftMatchResult?.disputedBy));
    setDetailsMatchResultDisputedAt(
      draftMatchResult && typeof draftMatchResult.disputedAt === "string" ? draftMatchResult.disputedAt : null,
    );
    setDetailsMatchResultAttachments(
      normalizeMatchResultAttachments(
        draftMatchResult.photos
        ?? draftMatchResult.attachments
        ?? draftMatchResult.images
        ?? [],
      ),
    );
    setGameDetailsMetaError(null);
  }, [
    activeGameRecord?.lastResultAt,
    activeGameRecord?.resultId,
    activeGameRecord?.resultLifecycleState,
    activeGameRecord?.resultStatus,
    detailsMetadata,
    detailsMatchResultSession,
    detailsPlayerPool,
    detailsParticipants,
    detailsWaitlist,
    detailsOrganizerInMatch,
    detailsOrganizerKey,
    detailsDateKey,
    gameRecordId,
  ]);

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
    if (detailsMatchResultViewerRole === "AUTHOR") return true;
    if (!detailsMatchResultSubmittedBy) return false;
    const submittedId = (detailsMatchResultSubmittedBy.id || "").trim();
    const profileIdValue = (profileId || "").trim();
    if (submittedId && profileIdValue && submittedId === profileIdValue) {
      return true;
    }
    const submittedPhone = normalizePhoneForGame(detailsMatchResultSubmittedBy.phone);
    return Boolean(submittedPhone && profilePhoneNorm && submittedPhone === profilePhoneNorm);
  }, [detailsMatchResultSubmittedBy, detailsMatchResultViewerRole, profileId, profilePhoneNorm]);
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
    && !isMatchResultAgreed
    && (detailsMatchResultStatus !== "CORRECTION_PENDING" || isMatchResultSubmittedByCurrentUser);
  const canEditMatchResultTeamsInDetails = canEditMatchResult;
  const detailsMatchResultValidationError = validateCompletedMatchResultSets(detailsMatchResultSets)
    || validateCompletedMatchResultSetPairings(
      detailsMatchResultSetPairings,
      detailsCompletedMatchResultSets.length,
      detailsTeamSlots,
    );
  const canSubmitMatchResult = canEditMatchResult
    && detailsCompletedMatchResultSets.length > 0
    && !detailsMatchResultValidationError
    && !updatingGameMeta;
  const canDisputeMatchResult = isDetailsMatchStarted
    && isCurrentUserConfirmedParticipant
    && isMatchResultPendingReview
    && !isMatchResultSubmittedByCurrentUser
    && (detailsMatchResultDisputeTimeLeftMs == null || detailsMatchResultDisputeTimeLeftMs > 0)
    && !updatingGameMeta;
  const canConfirmMatchResult = isDetailsMatchStarted
    && isCurrentUserConfirmedParticipant
    && isMatchResultPendingReview
    && !isMatchResultSubmittedByCurrentUser
    && (detailsMatchResultDisputeTimeLeftMs == null || detailsMatchResultDisputeTimeLeftMs > 0)
    && !updatingGameMeta;
  const canAcceptMatchResultCorrection = isDetailsMatchStarted
    && isCurrentUserConfirmedParticipant
    && isMatchResultSubmittedByCurrentUser
    && detailsMatchResultStatus === "CORRECTION_PENDING"
    && detailsMatchResultModelVersion < 2
    && !updatingGameMeta;
  const buildMatchResultSessionSyncKey = useCallback((
    draftSets: Array<{ left: unknown; right: unknown }>,
    draftPairings: unknown[],
    attachments: unknown[],
  ) => JSON.stringify({
    draftSets: draftSets.map((item) => ({
      left: item?.left == null ? "" : String(item.left),
      right: item?.right == null ? "" : String(item.right),
    })),
    draftPairings,
    attachments: attachments.map((item) => {
      if (!isRecordObject(item)) return item;
      return {
        id: typeof item.id === "string" ? item.id : null,
        dataUrl: typeof item.dataUrl === "string" ? item.dataUrl : null,
      };
    }),
  }), []);

  const persistMatchResultSessionDraft = useCallback((params: {
    gameId: string;
    sessionId: string;
    phone: string;
    revision: number | null;
    draftSets: Array<{ left: string; right: string }>;
    draftPairings: ReturnType<typeof buildMatchResultSetPairingsPayload>;
    attachments: MatchResultAttachment[];
    actor: {
      id: string | null;
      phone: string;
      name: string | null;
    };
    syncKey: string;
  }) => {
    const contextKey = `${params.gameId}:${params.sessionId}`;
    const savePromise = detailsMatchResultSessionSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (detailsMatchResultSessionContextRef.current !== contextKey) {
          return { saved: false, revision: null, status: null };
        }
        if (detailsMatchResultSessionSyncKeyRef.current === params.syncKey) {
          return {
            saved: true,
            revision: detailsMatchResultSessionRevisionRef.current ?? params.revision,
            status: 200,
          };
        }

        const result = await apiUpdatePadelGameResultSession(params.gameId, params.sessionId, {
          phone: params.phone,
          revision: detailsMatchResultSessionRevisionRef.current ?? params.revision ?? 1,
          draftSets: params.draftSets,
          draftPairings: params.draftPairings,
          attachments: params.attachments,
          actor: params.actor,
        });

        if (result.error || !result.data) {
          if (result.error?.status === 409 && detailsMatchResultSessionContextRef.current === contextKey) {
            // The server draft won the revision race. Reopen it as the source of truth
            // instead of silently autosaving this stale local copy over the winner.
            detailsMatchResultSessionConflictRef.current = true;
            detailsMatchResultDraftDirtyRef.current = false;
            detailsMatchResultSessionOpenKeyRef.current = null;
            detailsMatchResultSessionSyncKeyRef.current = null;
            detailsMatchResultSessionRevisionRef.current = null;
            detailsMatchResultSessionContextRef.current = null;
            setDetailsMatchResultSession(null);
          }
          return { saved: false, revision: null, status: result.status };
        }

        if (detailsMatchResultSessionContextRef.current !== contextKey) {
          return { saved: false, revision: null, status: result.status };
        }

        setDetailsMatchResultSession((prev) => ({ ...(prev ?? {}), ...result.data }));
        detailsMatchResultSessionRevisionRef.current = typeof result.data.revision === "number"
          ? result.data.revision
          : detailsMatchResultSessionRevisionRef.current;
        detailsMatchResultSessionSyncKeyRef.current = params.syncKey;
        return {
          saved: true,
          revision: detailsMatchResultSessionRevisionRef.current,
          status: result.status,
        };
      });

    detailsMatchResultSessionSaveQueueRef.current = savePromise.then(
      () => undefined,
      () => undefined,
    );
    return savePromise;
  }, []);

  useEffect(() => {
    if (step !== "details" || detailsActiveTab !== "result" || !gameRecordId || !profilePhoneNorm || !canEditMatchResult) {
      return;
    }
    const openKey = `${gameRecordId}:${profilePhoneNorm}`;
    if (detailsMatchResultSessionOpenKeyRef.current === openKey) {
      return;
    }

    detailsMatchResultSessionOpenKeyRef.current = openKey;
    void apiOpenPadelGameResultSession(gameRecordId, {
      phone: profilePhoneNorm,
      submittedBy: {
        id: profileId ?? null,
        phone: profilePhoneNorm,
        name: profileName || null,
      },
    }).then((result) => {
      if (detailsMatchResultSessionOpenKeyRef.current !== openKey) return;
      if (result.error || !result.data) {
        detailsMatchResultSessionOpenKeyRef.current = null;
        detailsMatchResultSessionConflictRef.current = false;
        return;
      }

      const sessionId = (result.data.sessionId || "").trim();
      if (detailsMatchResultSessionConflictRef.current) {
        detailsMatchResultSessionConflictRef.current = false;
        detailsMatchResultDraftDirtyRef.current = false;
      }
      detailsMatchResultSessionContextRef.current = sessionId
        ? `${gameRecordId}:${sessionId}`
        : null;
      setDetailsMatchResultSession(result.data);
      detailsMatchResultSessionRevisionRef.current = typeof result.data.revision === "number"
        ? result.data.revision
        : null;
      detailsMatchResultSessionSyncKeyRef.current = buildMatchResultSessionSyncKey(
        Array.isArray(result.data.draftSets) ? result.data.draftSets : [],
        Array.isArray(result.data.draftPairings) ? result.data.draftPairings : [],
        Array.isArray(result.data.attachments) ? result.data.attachments : [],
      );
    }).catch(() => {
      if (detailsMatchResultSessionOpenKeyRef.current !== openKey) return;
      detailsMatchResultSessionOpenKeyRef.current = null;
      detailsMatchResultSessionConflictRef.current = false;
    });
  }, [
    buildMatchResultSessionSyncKey,
    canEditMatchResult,
    detailsActiveTab,
    detailsMatchResultSession?.sessionId,
    gameRecordId,
    profileId,
    profileName,
    profilePhoneNorm,
    step,
  ]);

  useEffect(() => {
    if (step !== "details" || detailsActiveTab !== "result" || !gameRecordId || !profilePhoneNorm || !canEditMatchResult) {
      return;
    }
    const sessionId = (detailsMatchResultSession?.sessionId || "").trim();
    if (!sessionId) return;

    const draftSetsPayload = detailsMatchResultSets.map((setItem) => ({
      left: setItem.left,
      right: setItem.right,
    }));
    const draftPairingsPayload = buildMatchResultSetPairingsPayload(detailsMatchResultSetPairings);
    const syncKey = buildMatchResultSessionSyncKey(
      draftSetsPayload,
      draftPairingsPayload,
      detailsMatchResultAttachments,
    );
    if (!detailsMatchResultDraftDirtyRef.current || detailsMatchResultSessionSyncKeyRef.current === syncKey) {
      return;
    }

    if (detailsMatchResultSessionSaveTimerRef.current != null) {
      window.clearTimeout(detailsMatchResultSessionSaveTimerRef.current);
    }

    const timerId = window.setTimeout(() => {
      if (detailsMatchResultSessionSaveTimerRef.current === timerId) {
        detailsMatchResultSessionSaveTimerRef.current = null;
      }
      void persistMatchResultSessionDraft({
        gameId: gameRecordId,
        sessionId,
        phone: profilePhoneNorm,
        revision: detailsMatchResultSessionRevisionRef.current ?? detailsMatchResultSession?.revision ?? null,
        draftSets: draftSetsPayload,
        draftPairings: draftPairingsPayload,
        attachments: detailsMatchResultAttachments,
        actor: {
          id: profileId ?? null,
          phone: profilePhoneNorm,
          name: profileName || null,
        },
        syncKey,
      });
    }, 500);
    detailsMatchResultSessionSaveTimerRef.current = timerId;

    return () => {
      if (detailsMatchResultSessionSaveTimerRef.current === timerId) {
        window.clearTimeout(timerId);
        detailsMatchResultSessionSaveTimerRef.current = null;
      }
    };
  }, [
    buildMatchResultSessionSyncKey,
    canEditMatchResult,
    detailsActiveTab,
    detailsMatchResultAttachments,
    detailsMatchResultSession,
    detailsMatchResultSetPairings,
    detailsMatchResultSets,
    gameRecordId,
    profileId,
    profileName,
    profilePhoneNorm,
    persistMatchResultSessionDraft,
    step,
  ]);
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
        detailsPlayerPool.forEach((player) => pushAvailablePlayer(player));
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
      detailsPlayerPool.forEach((player) => pushAvailablePlayer(player));
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
    detailsPlayerPool,
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
      defaultSelectedIds: usePublicCreateWizard && stationTarget?.id
        ? [stationTarget.id]
        : [],
    };
  }, [communityAutopublishStationName, resolveCurrentClientProfile, usePublicCreateWizard]);

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
    () => {
      return buildCommunityAutopublishSelectionState({
        stationTarget: communityAutopublishStationTarget,
        memberTargets: communityAutopublishMemberTargets,
        selectedCommunityIds: selectedCommunityAutopublishIdsRef.current,
        selectionTouched: communityAutopublishSelectionTouchedRef.current,
      }, {
        allowStationWithoutMembership: usePublicCreateWizard,
      });
    },
    [
      communityAutopublishMemberTargets,
      communityAutopublishStationTarget,
      usePublicCreateWizard,
    ],
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
          ...(
            targetsBundle.stationTarget
            && (targetsBundle.stationTarget.isOrganizerMember || usePublicCreateWizard)
              ? [targetsBundle.stationTarget.id]
              : []
          ),
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
          const next = usePublicCreateWizard
            ? defaults
            : (preserved.length > 0 ? preserved : defaults);
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
  }, [fetchCommunityAutopublishTargets, usePublicCreateWizard]);

  useEffect(() => {
    if (!ENABLE_GAME_COMMUNITY_AUTOPUBLISH || !usePublicCreateWizard) return;

    const availableIds = new Set<string>([
      ...(
        communityAutopublishStationTarget
        && (communityAutopublishStationTarget.isOrganizerMember || usePublicCreateWizard)
          ? [communityAutopublishStationTarget.id]
          : []
      ),
      ...communityAutopublishMemberTargets
        .filter((target) => target.isOrganizerMember)
        .map((target) => target.id),
    ]);
    const next = !isPrivate && communityAutopublishStationTarget?.id
      ? [communityAutopublishStationTarget.id].filter((communityId) => availableIds.has(communityId))
      : [];

    selectedCommunityAutopublishIdsRef.current = next;
    setSelectedCommunityAutopublishIds(next);
  }, [
    communityAutopublishMemberTargets,
    communityAutopublishStationTarget,
    isPrivate,
    usePublicCreateWizard,
  ]);

  useEffect(() => {
    if ((step !== "details" && step !== "chat") || !gameRecordId) return;
    if (isReadOnlySyntheticGame) return;

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

          if (shouldSkipRecentPaidGameBackgroundSync(fetchedRecord)) {
            return;
          }

          const vivaStatus = await resolveGamePaymentByVivaBookings(
            fetchedRecord,
            fetchedRecord.payment?.paymentUrl ?? null,
            snapshotFromRecord,
          );
          if (!alive) return;
          if (vivaStatus.cancelled) {
            await hideCancelledGameRecord(fetchedRecord);
            if (!alive) return;
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
    isReadOnlySyntheticGame,
    hideCancelledGameRecord,
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
    if (splitPaymentSelected && !normalizedGameJoinPrice) {
      const errorMessage = "Не удалось рассчитать стоимость присоединения для раздельной оплаты.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }
    if (!splitPaymentSelected && shouldShowPublicationJoinPriceField && !normalizedGameJoinPrice) {
      const errorMessage = "Укажите стоимость присоединения к игре перед публикацией в сообщества.";
      setPayError(errorMessage);
      setGameRecordError(errorMessage);
      return false;
    }

    return true;
  }, [
    showPublicationFields,
    normalizedGameTitle,
    splitPaymentSelected,
    shouldShowPublicationJoinPriceField,
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
          : (usePublicCreateWizard || communityAutopublishStationTarget.isOrganizerMember)
            ? "Сообщество станции"
            : "Организатор не состоит в сообществе станции",
        selected: communityAutopublishSelectedIdsSet.has(communityAutopublishStationTarget.id)
          && (!usePublicCreateWizard || !isPrivate),
        selectable: (usePublicCreateWizard || communityAutopublishStationTarget.isOrganizerMember) && !communityAutopublishLoading,
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
        selected: communityAutopublishSelectedIdsSet.has(community.id)
          && (!usePublicCreateWizard || !isPrivate),
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
    isPrivate,
    usePublicCreateWizard,
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

  const handleSplitGamePay = useCallback(async (
    preferredPaymentMode?: "subscription" | "one_time",
    preferredClientSubscriptionId?: string | null,
  ) => {
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
    const canUseSplitSubscription = splitHasEligibleSubscriptions;
    if (preferredPaymentMode === "subscription" && !canUseSplitSubscription) {
      setPayError("Выбранный абонемент больше недоступен. Обновите список и попробуйте снова.");
      setLoadingPay(false);
      return;
    }
    const resolvedPaymentMode = preferredPaymentMode ?? (canUseSplitSubscription ? "subscription" : "one_time");
    const resolvedClientSubscriptionId =
      resolvedPaymentMode === "subscription"
        ? (String(preferredClientSubscriptionId || "").trim() || null)
        : null;
    const resolvedSplitSubscription = resolvedPaymentMode === "subscription"
      ? splitSubscriptions.find((subscription) => (
        String(subscription.subscriptionId || "").trim() === resolvedClientSubscriptionId
      )) ?? null
      : null;
    if (resolvedPaymentMode === "subscription") {
      if (!resolvedClientSubscriptionId || !resolvedSplitSubscription) {
        setPayError("Не удалось определить выбранный абонемент. Выберите его повторно.");
        setLoadingPay(false);
        return;
      }
      const subscriptionDateMessage = resolveSplitSubscriptionUnavailableMessage({
        subscriptions: splitSubscriptions,
        gameDate: selectedDate ? formatDateLocalIso(selectedDate) : null,
        requiredVisits: splitRequiredSubscriptionVisits,
        requiredDurationMinutes: duration,
      });
      if (subscriptionDateMessage) {
        setPayError(subscriptionDateMessage);
        setLoadingPay(false);
        return;
      }
      const dailyLimitSubscriptionCandidate = await resolveSplitSubscriptionDailyLimitCandidate(
        resolvedSplitSubscription,
        splitSubscriptionNamesById,
        clientPhone,
      );
      if (subscriptionPlanAllowsDailyLimitCategory(
        dailyLimitSubscriptionCandidate,
        SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
      )) {
        const dailyLimitBookingsResult = await apiFetchBookings(false, { size: 1000 });
        if (dailyLimitBookingsResult.error) {
          setPayError("Не удалось проверить дневной лимит абонемента");
          setLoadingPay(false);
          return;
        }
        const dailyLimitConflict = resolveSubscriptionCategoryDailyLimitConflictFromBookings(
          dailyLimitBookingsResult.data?.content ?? [],
          {
            targetDate: fromDate,
            category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
            currentSubscription: dailyLimitSubscriptionCandidate,
            currentClientSubscriptionId: resolvedClientSubscriptionId,
          },
        );
        if (dailyLimitConflict) {
          setPayError(dailyLimitConflict.message);
          setLoadingPay(false);
          return;
        }
      }
    }
    // Split subscription eligibility is calculated for the canonical open-game type.
    // Use the same Viva direction/type for actual booking creation to avoid mismatches.
    const resolvedSplitDirectionId = SPLIT_OPEN_GAME_DIRECTION_ID;
    const resolvedSplitExerciseTypeId = SPLIT_OPEN_GAME_EXERCISE_TYPE_ID;
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
      clientSubscriptionId: resolvedClientSubscriptionId,
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
      vivaDirectionId: resolvedSplitDirectionId,
      vivaExerciseTypeId: resolvedSplitExerciseTypeId,
    });

    if (paymentResult.error || !paymentResult.data) {
      const dailyLimitMessage = resolvedPaymentMode === "subscription"
        ? resolveSubscriptionCategoryDailyLimitErrorMessage(paymentResult.error)
        : null;
      if (dailyLimitMessage) {
        setPayError(dailyLimitMessage);
      } else if (resolvedPaymentMode === "subscription" && isNoSubscriptionsAvailableError(paymentResult.error)) {
        setPayError(
          resolveSplitSubscriptionUnavailableMessage({
            subscriptions: splitSubscriptions,
            gameDate: selectedDate ? formatDateLocalIso(selectedDate) : null,
            requiredVisits: splitRequiredSubscriptionVisits,
            requiredDurationMinutes: duration,
          }) || paymentResult.error?.message || "Не удалось сформировать split-оплату",
        );
      } else {
        setPayError(paymentResult.error?.message ?? "Не удалось сформировать split-оплату");
      }
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
      clientSubscriptionId: resolvedClientSubscriptionId,
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
    const allRelatedPhones = buildGameAllRelatedPhones({
      organizerPhone: clientPhone ?? organizerPlayer.phone ?? null,
      participants: normalizedParticipants.slice(0, splitShareCount),
      waitlist: waitlistPlayers,
      splitPaymentPhones: [clientPhone ?? organizerPlayer.phone ?? null],
    });

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
        vivaExerciseId: paymentResult.data.exerciseId,
        exerciseId: paymentResult.data.exerciseId,
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
        vivaExerciseId: paymentResult.data.exerciseId,
        exerciseId: paymentResult.data.exerciseId,
        source: "games_split_widget",
        gameFormat: resolvedGameFormat,
        ...buildGameOptionalMetadataFields({
          gameTitle: gameTitleDraft,
          participantComment: gameParticipantCommentDraft,
          joinPrice: gameJoinPriceDraft,
        }),
        sourceMode: "create",
        allRelatedPhones,
        splitPayment: splitMetadata,
        ...publicCreatePreciseRatingMetadata,
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
    paymentAmount,
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
    splitRequiredSubscriptionVisits,
    splitSubscriptions,
    splitSubscriptionNamesById,
    resolvedGameFormat,
    publicCreatePreciseRatingMetadata,
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
          ...publicCreatePreciseRatingMetadata,
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
          ...publicCreatePreciseRatingMetadata,
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
    publicCreatePreciseRatingMetadata,
    buildCommunityAutopublishMetadata,
    validateGamePublicationFields,
    resolveCurrentClientProfile,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);
  const handleCreateSubmit = useCallback(() => {
    if (splitPaymentSelected) {
      if (splitCheckoutMode === "subscription" && splitHasSubscriptionPaymentOptions) {
        if (splitHasSubscriptionPaymentOptions && !selectedSplitSubscriptionId) {
          setPayError("Выберите абонемент для списания");
          return;
        }
        void handleSplitGamePay("subscription", selectedSplitSubscriptionId);
        return;
      }
      void handleSplitGamePay("one_time");
      return;
    }
    void handleMasterServicePay();
  }, [
    splitPaymentSelected,
    splitCheckoutMode,
    splitHasSubscriptionPaymentOptions,
    selectedSplitSubscriptionId,
    handleSplitGamePay,
    handleMasterServicePay,
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

    if (!bookingPreset.hasRequiredBookingData || !bookingPreset.bookingId || !bookingPreset.date
      || !bookingPreset.timeFrom || !bookingPreset.timeTo) {
      setGameRecordError("Недостаточно данных брони для создания сборной игры");
      return;
    }
    if (!bookingPreset.canCreateFromPreset) {
      setGameRecordError(
        bookingPresetCategoryError
        || "Из этой брони нельзя создать сборную игру. Конвертация доступна только для открытой игры или аренды корта.",
      );
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

      const fallbackParticipants = participants.length > 0
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
      const organizerPlayer = fallbackParticipants[0];
      let normalizedParticipants = fallbackParticipants;
      let bookingIdsForPayload = Array.from(new Set([bookingPreset.bookingId].filter(Boolean)));
      let bookingPaymentTypes: string[] = [];
      let hasSubscriptionBooking = false;

      if (bookingPreset.exerciseId) {
        const rosterResult = await apiFetchTournamentParticipants(bookingPreset.exerciseId, { sanitize: false });
        if (rosterResult.data) {
          const rosterRows = extractExerciseBookingRows(rosterResult.data)
            .filter((item) => !isRecordObject(item)
              ? false
              : !(item.isCancelled === true || item.cancelled === true || item.canceled === true));

          const rosterParticipants = rosterRows
            .map((item) => normalizeVivaBookingParticipant(item))
            .filter((item): item is PadelGamePlayer => item !== null)
            .filter((item) => item.status !== "WAITLIST");
          if (rosterParticipants.length > 0) {
            const fallbackOrganizerParticipant = organizerPlayer
              ? {
                  ...organizerPlayer,
                  source: "ORGANIZER" as const,
                  status: "CONFIRMED" as const,
                }
              : null;
            normalizedParticipants = dedupePlayersByIdentity([
              fallbackOrganizerParticipant,
              ...rosterParticipants,
            ]).slice(0, createMaxPlayers);
          }

          const rosterBookingIds = rosterRows
            .map((item) => extractVivaBookingId(item))
            .filter((item): item is string => Boolean(item));
          bookingIdsForPayload = Array.from(new Set([
            bookingPreset.bookingId,
            ...rosterBookingIds,
          ].filter(Boolean)));

          bookingPaymentTypes = Array.from(new Set(
            rosterRows.flatMap((item) => extractVivaBookingPaymentTypes(item)),
          ));
          hasSubscriptionBooking = rosterRows.some((item) => hasVivaSubscriptionBookingSignal(item));
        }
      }
      const bookingPresetPaid = bookingPreset.paid;
      const bookingPresetIsPaid = bookingPresetPaid !== false;

      const payload: PadelGameRecordPayload = {
        tenantKey: null,
        status: bookingPresetIsPaid ? "PAID" : "PAYMENT_PENDING",
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
          bookingIds: bookingIdsForPayload,
        },
        payment: {
          amount: bookingPreset.amount,
          paymentUrl: bookingPreset.paymentUrl,
          paymentMethod: "WIDGET",
          ...(bookingPresetPaid === null ? {} : { paid: bookingPresetPaid }),
          paidAt: bookingPresetPaid === true ? new Date().toISOString() : null,
          bookingIds: bookingIdsForPayload,
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
          bookingId: bookingIdsForPayload[0] ?? bookingPreset.bookingId,
          bookingIds: bookingIdsForPayload,
          slotId: bookingPreset.slotId,
          vivaExerciseId: bookingPreset.exerciseId,
          exerciseId: bookingPreset.exerciseId,
          typeId: bookingPreset.typeId,
          typeName: bookingPreset.typeName,
          directionId: bookingPreset.directionId,
          directionName: bookingPreset.directionName,
          bookingPaymentTypes,
          hasSubscriptionBooking,
          canJoinBySubscription: hasSubscriptionBooking,
          gameFormat: resolvedGameFormat,
          ...buildGameOptionalMetadataFields({
            gameTitle: gameTitleDraft,
            participantComment: gameParticipantCommentDraft,
            joinPrice: gameJoinPriceDraft,
          }),
          ...publicCreatePreciseRatingMetadata,
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
    bookingPresetCategoryError,
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
    publicCreatePreciseRatingMetadata,
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
      const inviteResult = await shareOrCopyGameInvitePayload(inviteLink, activeGameRecord, {
        includePreviewImage: true,
      });
      setInviteFeedback(inviteResult);
      window.setTimeout(() => {
        setInviteFeedback((current) => (current === inviteResult ? null : current));
      }, 1600);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setInviteFeedback(null);
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
      if (vivaStatus.cancelled && activeGameRecord) {
        await hideCancelledGameRecord(activeGameRecord);
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
    hideCancelledGameRecord,
    runPaidGameCommunityMembershipAndPublication,
    upsertGameRecordInStores,
  ]);

  const handleCancelUnpaidGame = useCallback(async () => {
    if (!gameRecordId || cancellingUnpaidGame) return;

    setCancellingUnpaidGame(true);
    setGameRecordError(null);

    let cleanupHandled = false;
    let cleanupSucceeded = false;

    const cleanupResult = await apiCleanupPadelGameByOrganizer(gameRecordId, {
      force: true,
      dryRun: false,
      limit: 1,
      intent: "cancel_game",
    });
    const cleanupData = cleanupResult.data;
    const cleanupItems = Array.isArray(cleanupData?.items) ? cleanupData.items : [];
    const cleanupItem = cleanupItems.find((item) => item.gameId === gameRecordId)
      ?? cleanupItems[0]
      ?? null;
    const cleanupProcessed = (cleanupData?.processed ?? 0) > 0 || cleanupItem !== null;

    if (cleanupProcessed) {
      cleanupHandled = true;
      cleanupSucceeded = cleanupItem?.cancelledInLk === true && cleanupItem?.withVivaErrors !== true;
      if (!cleanupSucceeded) {
        setGameRecordError("Не удалось удалить занятие в Viva");
        setCancellingUnpaidGame(false);
        return;
      }
    }

    const cancelResult = cleanupHandled
      ? { data: { id: gameRecordId }, error: null }
      : await apiUpdatePadelGameRecord(gameRecordId, {
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
      const payload: Parameters<typeof apiUpdatePadelGameRecord>[1] = {
        participants: detailsParticipants,
        waitlist: detailsWaitlist,
        invite: {
          waitlistEnabled: activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled,
          maxPlayers: detailsMaxPlayers,
        },
        metadata: nextMetadata,
      };
      if (detailsOrganizerHasIdentity) {
        payload.organizer = detailsOrganizerPayload;
      }

      const updateResult = await apiUpdatePadelGameRecord(gameRecordId, payload);

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
    detailsOrganizerHasIdentity,
    detailsParticipants,
    detailsWaitlist,
    activeGameRecord?.invite?.maxPlayers,
    activeGameRecord?.invite?.waitlistEnabled,
    waitlistEnabled,
    detailsMaxPlayers,
    upsertGameRecordInStores,
  ]);

  const applyMatchResultActionResponse = useCallback((
    response: PadelGameResultActionResponse | null | undefined,
  ) => {
    if (!response) return false;

    if (response.game?.id) {
      upsertGameRecordInStores(response.game, { communityMode: "if_exists" });
    }

    const nextMatchResult = normalizeMatchResultFromActionResponse(response);
    if (!nextMatchResult) return Boolean(response.game?.id);

    const nextMetadata: Record<string, unknown> = {
      ...detailsMetadata,
      matchResult: nextMatchResult,
    };
    const nextRecord = activeGameRecord
      ? {
          ...activeGameRecord,
          metadata: nextMetadata,
        }
      : (
        gameRecordId
          ? {
              id: gameRecordId,
              inviteUrl: null,
              status: gameRecordStatus,
              metadata: nextMetadata,
            } satisfies PadelGameRecord
          : null
      );

    if (nextRecord) {
      upsertGameRecordInStores(nextRecord, { communityMode: "if_exists" });
      setActiveGameRecordStore((prev) => (
        prev?.id === nextRecord.id ? mergePadelGameRecord(prev, nextRecord) : nextRecord
      ));
    }

    return true;
  }, [
    activeGameRecord,
    detailsMetadata,
    gameRecordId,
    gameRecordStatus,
    upsertGameRecordInStores,
  ]);

  useEffect(() => {
    if (step !== "details" || !gameRecordId || !canCurrentUserFetchResultState) return;
    const fetchKey = `${gameRecordId}:${profilePhoneNorm}`;
    if (resultStateFetchKeyRef.current === fetchKey) return;
    resultStateFetchKeyRef.current = fetchKey;

    let cancelled = false;
    void apiFetchPadelGameResultState(gameRecordId, { phone: profilePhoneNorm }).then((result) => {
      if (cancelled || result.error || !result.data) return;
      applyMatchResultActionResponse(result.data);
    }).catch(() => {
      // State endpoint is additive; existing game metadata remains the fallback.
    });

    return () => {
      cancelled = true;
    };
  }, [
    applyMatchResultActionResponse,
    canCurrentUserFetchResultState,
    gameRecordId,
    profilePhoneNorm,
    step,
  ]);

  useEffect(() => {
    const ratingWorkStatus = detailsMatchResultRatingWork?.status;
    const shouldPollRatingWork = ratingWorkStatus === "QUEUED"
      || ratingWorkStatus === "RUNNING"
      || ratingWorkStatus === "PREPARED"
      || ratingWorkStatus === "RETRYABLE";
    if (step !== "details" || !gameRecordId || !canCurrentUserFetchResultState || !shouldPollRatingWork) return;

    let cancelled = false;
    let requestInFlight = false;
    const intervalId = window.setInterval(() => {
      if (requestInFlight) return;
      requestInFlight = true;
      void apiFetchPadelGameResultState(gameRecordId, { phone: profilePhoneNorm }).then((result) => {
        if (cancelled || result.error || !result.data) return;
        applyMatchResultActionResponse(result.data);
      }).catch(() => {
        // Background status polling must not block result interaction.
      }).finally(() => {
        requestInFlight = false;
      });
    }, ratingWorkStatus === "RETRYABLE" ? 10_000 : 4_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    applyMatchResultActionResponse,
    canCurrentUserFetchResultState,
    detailsMatchResultRatingWork?.status,
    gameRecordId,
    profilePhoneNorm,
    step,
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
    const normalizedWaitlist = excludePlayersAlreadyInRoster(
      normalizePlayers(nextWaitlistRaw, "WAITLIST"),
      normalizedParticipants,
    );
    setUpdatingGameRoster(true);
    setGameRosterError(null);
    try {
      const payload: Parameters<typeof apiUpdatePadelGameRecord>[1] = {
        participants: normalizedParticipants,
        waitlist: normalizedWaitlist,
        invite: {
          waitlistEnabled: activeGameRecord?.invite?.waitlistEnabled ?? waitlistEnabled,
          maxPlayers: detailsMaxPlayers,
        },
      };
      if (detailsOrganizerHasIdentity) {
        payload.organizer = detailsOrganizerPayload;
      }
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
        const stillRelevantToCurrentProfile = isPadelGameRecordRelevantToIdentity(
          recordWithRoster,
          profilePhone,
          profileId,
        );
        setParticipants(normalizedParticipants);
        setWaitlistPlayers(normalizedWaitlist);
        setGameRosterError(null);

        if (!stillRelevantToCurrentProfile) {
          notifyGameRecordsUpdated([recordWithRoster], "games_roster_patch_irrelevant");
          removeGameRecordFromStores(recordWithRoster.id);
          setGameRecordId(null);
          setStep("create");
          return true;
        }

        upsertGameRecordInStores(recordWithRoster, { communityMode: "if_exists" });
        setActiveGameRecordStore((prev) => (
          prev?.id === recordWithRoster.id ? recordWithRoster : prev
        ));
        setCommunityGames((prev) => prev.map((item) => (
          item.id === recordWithRoster.id ? recordWithRoster : item
        )));
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
    detailsOrganizerHasIdentity,
    activeGameRecord,
    activeGameRecord?.invite?.maxPlayers,
    activeGameRecord?.invite?.waitlistEnabled,
    upsertGameRecordInStores,
    profileId,
    profilePhone,
    removeGameRecordFromStores,
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
    const splitPaymentSource = isRecordObject(options?.extraMetadata?.splitPayment)
      ? options?.extraMetadata?.splitPayment
      : (isRecordObject(detailsMetadata.splitPayment) ? detailsMetadata.splitPayment : null);
    const splitPaymentPhones = extractSplitPaymentPhones(splitPaymentSource);
    return {
      ...detailsMetadata,
      ...(options?.extraMetadata ?? {}),
      organizerInMatch: options?.organizerInMatch ?? detailsOrganizerInMatch,
      teamSlots: buildStoredTeamSlots(options?.teamSlots ?? detailsTeamSlots),
      organizerId: detailsOrganizerPayload.id ?? null,
      organizerPhone: organizerPhone ?? null,
      organizerPhoneNorm: organizerPhone ?? null,
      participantPhones,
      waitlistPhones,
      allRelatedPhones: Array.from(new Set([
        organizerPhone,
        ...splitPaymentPhones,
        ...participantPhones,
        ...waitlistPhones,
      ].filter((value): value is string => Boolean(value)))),
    };
  }, [
    detailsMetadata,
    detailsOrganizerInMatch,
    detailsOrganizerPayload.id,
    detailsOrganizerPayload.phone,
    detailsTeamSlots,
    buildStoredTeamSlots,
  ]);

  const cancelVivaBookingsForPlayerFromDetails = useCallback(async (
    player: PadelGamePlayer,
    reason: "PLAYER_LEFT" | "REMOVED_BY_ORGANIZER",
  ): Promise<VivaParticipantCancelOutcome> => {
    if (!gameRecordId || !activeGameRecord) {
      return { ok: true, bookingIds: [], summary: null, error: null };
    }

    const bookingTargets = new Map<string, { bookingId: string; clientId: string | null }>();
    const upsertBookingTarget = (bookingIdRaw: unknown, clientIdRaw: unknown) => {
      const bookingId = normalizeBookingId(bookingIdRaw);
      if (!bookingId) return;
      const clientId = normalizeBookingId(clientIdRaw);
      const existing = bookingTargets.get(bookingId);
      if (existing) {
        if (!existing.clientId && clientId) {
          existing.clientId = clientId;
        }
        return;
      }
      bookingTargets.set(bookingId, {
        bookingId,
        clientId,
      });
    };

    extractSplitPaymentBookingTargetsForPlayer(detailsSplitPaymentMetadata, player)
      .forEach((target) => upsertBookingTarget(target.bookingId, target.clientId));

    const exerciseId = resolveGameVivaExerciseId(activeGameRecord);
    if (exerciseId) {
      const participantsResult = await apiFetchTournamentParticipants(exerciseId, { sanitize: false });
      if (participantsResult.error && bookingTargets.size === 0) {
        return {
          ok: false,
          bookingIds: [],
          summary: null,
          error: participantsResult.error.message || "Не удалось найти запись игрока в Viva",
        };
      }

      if (!participantsResult.error) {
        extractExerciseBookingRows(participantsResult.data)
          .filter((row) => vivaBookingMatchesPlayer(row, player))
          .forEach((row) => {
            upsertBookingTarget(
              extractVivaBookingId(row),
              extractVivaBookingClientId(row),
            );
          });
      }
    }

    const resolvedBookingTargets = Array.from(bookingTargets.values());
    const resolvedBookingIds = resolvedBookingTargets.map((item) => item.bookingId);
    if (resolvedBookingIds.length === 0) {
      return {
        ok: false,
        bookingIds: [],
        summary: null,
        error: "В Viva не найдена запись игрока для отмены. Обновите состав игры и повторите попытку.",
      };
    }

    const resolvedClientId =
      resolvedBookingTargets.find((item) => item.clientId)?.clientId
      ?? normalizeBookingId(player.id)
      ?? null;

    const cancelResult = await apiCancelPadelSplitParticipantBookings(gameRecordId, {
      exerciseId,
      bookingIds: resolvedBookingIds,
      bookingItems: resolvedBookingTargets,
      clientId: resolvedClientId,
      playerId: player.id ?? null,
      playerPhone: normalizePhoneForGame(player.phone),
      playerName: player.name || null,
      reason,
    });

    const cancelPayload = isRecordObject(cancelResult.data)
      ? cancelResult.data as Record<string, unknown>
      : null;
    const withVivaErrors = cancelPayload?.withVivaErrors === true || cancelPayload?.ok === false;
    if (cancelResult.error || withVivaErrors) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error:
          cancelResult.error?.message
          || "Не удалось удалить игрока из групповой записи Viva",
      };
    }

    if (!exerciseId) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: "Не удалось проверить Viva exerciseId для leave",
      };
    }

    const verificationResult = await apiFetchTournamentParticipants(exerciseId, { sanitize: false });
    if (verificationResult.error || !verificationResult.data) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: verificationResult.error?.message || "Не удалось проверить запись игрока в Viva",
      };
    }

    const stillPresentInViva = extractExerciseBookingRows(verificationResult.data)
      .some((row) => vivaBookingMatchesPlayer(row, player));
    if (stillPresentInViva) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: "Viva ещё держит запись игрока, попробуйте повторить позже",
      };
    }

    return {
      ok: true,
      bookingIds: resolvedBookingIds,
      summary: cancelPayload,
      error: null,
    };
  }, [
    activeGameRecord,
    detailsSplitPaymentMetadata,
    gameRecordId,
    isDetailsSplitPaymentGame,
  ]);

  const cancelCurrentUserVivaBookingsFromDetails = useCallback(async (
    player: PadelGamePlayer,
  ): Promise<SelfRemovalVivaCancellationOutcome> => {
    if (!activeGameRecord) {
      return {
        ok: true,
        bookingIds: [],
        summary: null,
        error: null,
        auditStatus: "no_viva_booking_target",
        verification: "skipped_no_booking_target",
        trace: [],
      };
    }

    const bookingTargets = new Map<string, { bookingId: string; clientId: string | null }>();
    const upsertBookingTarget = (bookingIdRaw: unknown, clientIdRaw: unknown) => {
      const bookingId = normalizeBookingId(bookingIdRaw);
      if (!bookingId) return;
      const clientId = normalizeBookingId(clientIdRaw);
      const existing = bookingTargets.get(bookingId);
      if (existing) {
        if (!existing.clientId && clientId) {
          existing.clientId = clientId;
        }
        return;
      }
      bookingTargets.set(bookingId, {
        bookingId,
        clientId,
      });
    };

    extractSplitPaymentBookingTargetsForPlayer(detailsSplitPaymentMetadata, player)
      .forEach((target) => upsertBookingTarget(target.bookingId, target.clientId));

    const exerciseId = resolveGameVivaExerciseId(activeGameRecord);
    let lookupError: string | null = null;
    if (exerciseId) {
      const participantsResult = await apiFetchTournamentParticipants(exerciseId, { sanitize: false });
      if (participantsResult.error) {
        lookupError = participantsResult.error.message || "Не удалось проверить запись игрока в Viva";
      } else {
        extractExerciseBookingRows(participantsResult.data)
          .filter((row) => vivaBookingMatchesPlayer(row, player))
          .forEach((row) => {
            upsertBookingTarget(
              extractVivaBookingId(row),
              extractVivaBookingClientId(row),
            );
          });
      }
    }

    const resolvedBookingIds = Array.from(bookingTargets.values()).map((item) => item.bookingId);
    if (resolvedBookingIds.length === 0) {
      if (lookupError) {
        return {
          ok: false,
          bookingIds: [],
          summary: null,
          error: lookupError,
          auditStatus: "no_viva_booking_target",
          verification: "skipped_no_booking_target",
          trace: [],
        };
      }

      return {
        ok: true,
        bookingIds: [],
        summary: null,
        error: null,
        auditStatus: "no_viva_booking_target",
        verification: "skipped_no_booking_target",
        trace: [],
      };
    }

    const cancelResult = await apiCancelPadelSelfRemovalBookings(resolvedBookingIds);
    const cancelPayload = isRecordObject(cancelResult.data)
      ? cancelResult.data as Record<string, unknown>
      : null;
    const trace = Array.isArray(cancelResult.data?.trace) ? cancelResult.data.trace : [];
    const withVivaErrors = cancelPayload?.withVivaErrors === true || cancelPayload?.ok === false;
    if (cancelResult.error || withVivaErrors) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error:
          cancelResult.error?.message
          || "Не удалось удалить вас из групповой записи Viva",
        auditStatus: "cancelled_in_viva",
        verification: exerciseId ? "verified_absent" : "skipped_no_exercise_id",
        trace,
      };
    }

    const auditStatus: GameSelfRemovalAuditStatus =
      Array.isArray(cancelResult.data?.bookingSuccess) && cancelResult.data.bookingSuccess.length > 0
        ? "cancelled_in_viva"
        : "already_absent_in_viva";

    if (!exerciseId) {
      return {
        ok: true,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: null,
        auditStatus,
        verification: "verified_booking_history",
        trace,
      };
    }

    const verificationResult = await apiFetchTournamentParticipants(exerciseId, { sanitize: false });
    if (verificationResult.error || !verificationResult.data) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: verificationResult.error?.message || "Не удалось проверить запись игрока в Viva",
        auditStatus,
        verification: "verified_absent",
        trace,
      };
    }

    const stillPresentInViva = extractExerciseBookingRows(verificationResult.data)
      .some((row) => vivaBookingMatchesPlayer(row, player));
    if (stillPresentInViva) {
      return {
        ok: false,
        bookingIds: resolvedBookingIds,
        summary: cancelPayload,
        error: "Viva ещё держит запись игрока, попробуйте повторить позже",
        auditStatus,
        verification: "verified_absent",
        trace,
      };
    }

    return {
      ok: true,
      bookingIds: resolvedBookingIds,
      summary: cancelPayload,
      error: null,
      auditStatus,
      verification: "verified_absent",
      trace,
    };
  }, [
    activeGameRecord,
    detailsSplitPaymentMetadata,
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
    if (targetSetIndex < 0) {
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
    detailsMatchResultDraftDirtyRef.current = true;
    const nextSetPairings = options?.setPairings ?? buildNextSetPairingsForTeamSlots(nextSlots);
    if (canEditMatchResult) {
      // Result pairings belong to the result session. Its autosave effect persists
      // this local state without blocking the screen on a generic game PATCH.
      return true;
    }
    const nextMetadata = buildDetailsRosterMetadata(detailsParticipants, detailsWaitlist, {
      teamSlots: nextSlots,
      setPairings: nextSetPairings,
    });

    return saveDetailsMetadata(nextMetadata, "Не удалось обновить состав команд");
  }, [
    buildDetailsRosterMetadata,
    buildNextSetPairingsForTeamSlots,
    canEditMatchResult,
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
    if (!canManagePlayersInDetails && !canEditMatchResultTeamsInDetails) return;

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

        detailsMatchResultDraftDirtyRef.current = true;
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

        detailsMatchResultDraftDirtyRef.current = true;
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

    detailsMatchResultDraftDirtyRef.current = true;
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
    canEditMatchResultTeamsInDetails,
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

    if (canManagePlayersInDetails || canEditMatchResultTeamsInDetails) {
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
    detailsMatchResultDraftDirtyRef.current = true;
    setDetailsTeamSlots(nextSlots);
    setDetailsMatchResultSetPairings(nextSetPairings);
    void persistTeamSlots(nextSlots, { setPairings: nextSetPairings }).then((saved) => {
      if (saved) return;
      setDetailsTeamSlots(detailsTeamSlots);
      setDetailsMatchResultSetPairings(previousSetPairings);
    });
  }, [
    updatingGameMeta,
    canEditMatchResultTeamsInDetails,
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
    if (targetSetIndex < 0) return;

    if (areTeamSlotsEqualByIdentity(nextSlots, detailsTeamSlots)) {
      setDetailsPairComposerSetIndex(null);
      return;
    }

    const previousSlots = [...detailsTeamSlots];
    const previousSetPairings = detailsMatchResultSetPairings.map((teamSlots) => (
      teamSlots ? cloneTeamSlots(teamSlots) : null
    ));
    const nextSetPairings = buildNextSetPairingsForTeamSlots(nextSlots, {
      basePairings: previousSetPairings,
    });
    setDetailsTeamMenuSlotIndex(null);
    detailsMatchResultDraftDirtyRef.current = true;
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
    detailsMatchResultDraftDirtyRef.current = true;
    setDetailsMatchResultSets((prev) => {
      const next = prev.map((setItem) => ({ ...setItem }));
      if (!next[setIndex]) {
        next[setIndex] = { left: "", right: "" };
      }
      next[setIndex][side] = normalizeScoreInput(value);
      return normalizeEditableScoreSets(next);
    });
  }, [canEditMatchResult, updatingGameMeta]);

  const handleAddEmptyMatchResultSet = useCallback(() => {
    if (!canEditMatchResult || updatingGameMeta) return;
    detailsMatchResultDraftDirtyRef.current = true;
    setDetailsMatchResultSets((prev) => normalizeEditableScoreSets([...prev, { left: "", right: "" }]));
  }, [canEditMatchResult, updatingGameMeta]);

  const handleRemoveMatchResultSet = useCallback((setIndex: number) => {
    if (!canEditMatchResult || updatingGameMeta) return;
    detailsMatchResultDraftDirtyRef.current = true;
    setDetailsMatchResultSets((prev) => {
      if (prev.length <= 1 || setIndex < 0 || setIndex >= prev.length) return prev;
      const next = prev.filter((_, index) => index !== setIndex);
      return normalizeEditableScoreSets(next);
    });
    setDetailsMatchResultSetPairings((prev) => prev.filter((_, index) => index !== setIndex));
  }, [canEditMatchResult, updatingGameMeta]);

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

      detailsMatchResultDraftDirtyRef.current = true;
      const previousAttachments = [...detailsMatchResultAttachments];
      const nextAttachments = [...previousAttachments, ...nextItems].slice(0, MAX_MATCH_RESULT_ATTACHMENTS);
      setDetailsMatchResultAttachments(nextAttachments);

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
  ]);

  const handleRemoveMatchResultAttachment = useCallback((attachmentId: string) => {
    if (!attachmentId.trim()) return;
    if (updatingGameMeta) return;
    detailsMatchResultDraftDirtyRef.current = true;
    setDetailsMatchResultAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
  }, [updatingGameMeta]);

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

  const handleSubmitMatchResult = useCallback(async () => {
    if (!canSubmitMatchResult) return;
    const validationError = validateCompletedMatchResultSets(detailsMatchResultSets);
    if (validationError) {
      setGameDetailsMetaError(validationError);
      return;
    }
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

    const setPairings = buildMatchResultSubmitSetPairingsPayload(
      detailsMatchResultSetPairings,
      completedSets.length,
      detailsTeamSlots,
    );
    const pairingValidationError = validateCompletedMatchResultSetPairings(
      detailsMatchResultSetPairings,
      completedSets.length,
      detailsTeamSlots,
    );
    if (pairingValidationError) {
      setGameDetailsMetaError(pairingValidationError);
      return;
    }
    const scoreA = completedSets.reduce((total, setItem) => total + setItem.left, 0);
    const scoreB = completedSets.reduce((total, setItem) => total + setItem.right, 0);
    const actor = {
      id: profileId ?? null,
      phone: normalizePhoneForGame(profilePhone),
      name: profileName || null,
    };
    const draftSetsPayload = detailsMatchResultSets.map((setItem) => ({
      left: setItem.left,
      right: setItem.right,
    }));
    const draftPairingsPayload = buildMatchResultSetPairingsPayload(detailsMatchResultSetPairings);
    const draftSyncKey = buildMatchResultSessionSyncKey(
      draftSetsPayload,
      draftPairingsPayload,
      detailsMatchResultAttachments,
    );
    const submissionDraftKey = JSON.stringify({
      gameId: gameRecordId || "",
      sets: completedSets,
      setPairings,
      attachments: detailsMatchResultAttachments.map((item) => ({
        id: item.id,
        size: item.size,
        dataLength: item.dataUrl.length,
      })),
    });
    let submission = detailsMatchResultSubmissionRef.current;
    if (!submission || submission.draftKey !== submissionDraftKey) {
      submission = {
        draftKey: submissionDraftKey,
        idempotencyKey: `match-result:${generatePaymentRef()}`,
      };
      detailsMatchResultSubmissionRef.current = submission;
    }

    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      if (detailsMatchResultSessionSaveTimerRef.current != null) {
        window.clearTimeout(detailsMatchResultSessionSaveTimerRef.current);
        detailsMatchResultSessionSaveTimerRef.current = null;
      }

      let submittedSessionId = (detailsMatchResultSession?.sessionId || "").trim() || null;
      let submittedSessionRevision = detailsMatchResultSessionRevisionRef.current
        ?? detailsMatchResultSession?.revision
        ?? null;
      if (submittedSessionId && profilePhoneNorm) {
        const flushResult = await Promise.race([
          persistMatchResultSessionDraft({
            gameId: gameRecordId || "",
            sessionId: submittedSessionId,
            phone: profilePhoneNorm,
            revision: submittedSessionRevision,
            draftSets: draftSetsPayload,
            draftPairings: draftPairingsPayload,
            attachments: detailsMatchResultAttachments,
            actor: {
              id: profileId ?? null,
              phone: profilePhoneNorm,
              name: profileName || null,
            },
            syncKey: draftSyncKey,
          }).catch(() => null),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), MATCH_RESULT_DRAFT_FLUSH_TIMEOUT_MS);
          }),
        ]);

        if (flushResult?.saved) {
          submittedSessionRevision = flushResult.revision;
        } else {
          // The final score, pairings and attachments below are the canonical submit payload.
          // If draft persistence is slow or failed, do not link the result to a stale revision.
          submittedSessionId = null;
          submittedSessionRevision = null;
        }
      }

      const submitResult = await apiSubmitPadelGameResult(gameRecordId || "", {
        idempotencyKey: submission.idempotencyKey,
        phone: actor.phone,
        sessionId: submittedSessionId,
        sessionRevision: submittedSessionRevision,
        resultSession: {
          sessionId: submittedSessionId,
          sessionRevision: submittedSessionRevision,
          rosterSnapshot: isRecordObject(detailsMatchResultSession?.rosterSnapshot)
            ? detailsMatchResultSession.rosterSnapshot as Record<string, unknown>
            : null,
        },
        scoreA,
        scoreB,
        sets: completedSets,
        ...(setPairings.length > 0 ? { setPairings } : {}),
        photos: detailsMatchResultAttachments,
        submittedBy: actor,
      });

      if (submitResult.error || !submitResult.data) {
        setGameDetailsMetaError(
          submitResult.error?.message || "Не удалось сохранить результат",
        );
        return;
      }

      detailsMatchResultSessionContextRef.current = null;
      detailsMatchResultSessionOpenKeyRef.current = null;
      detailsMatchResultSessionSyncKeyRef.current = null;
      detailsMatchResultSessionRevisionRef.current = null;
      setDetailsMatchResultSession(null);
      detailsMatchResultDraftDirtyRef.current = false;
      detailsMatchResultSubmissionRef.current = null;
      applyMatchResultActionResponse(submitResult.data);
    } catch {
      setGameDetailsMetaError("Не удалось сохранить результат");
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    canSubmitMatchResult,
    detailsMatchResultSets,
    detailsCompletedMatchResultSets,
    detailsMatchResultAttachments,
    detailsMatchResultSession,
    detailsMatchResultSetPairings,
    detailsTeamSlots,
    gameRecordId,
    applyMatchResultActionResponse,
    buildMatchResultSessionSyncKey,
    persistMatchResultSessionDraft,
    profileId,
    profileName,
    profilePhone,
    profilePhoneNorm,
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
    if (!gameRecordId) return false;
    if (!isMatchResultPendingReview) return false;

    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      const actorPhone = options?.confirmedBy?.phone ?? normalizePhoneForGame(profilePhone);
      const actionResult = options?.autoConfirmed
        ? await apiExpirePadelGameResult(gameRecordId, {
            phone: actorPhone,
            playerPhone: actorPhone,
            actor: options?.confirmedBy ?? null,
            reason: "DISPUTE_TIMEOUT",
          })
        : await apiConfirmPadelGameResult(gameRecordId, {
            phone: actorPhone,
            confirmerPhone: actorPhone,
            playerPhone: actorPhone,
            actor: options?.confirmedBy ?? {
              id: profileId ?? null,
              phone: actorPhone,
              name: profileName || null,
            },
            reason: "MANUAL",
          });

      if (actionResult.error || !actionResult.data) {
        setGameDetailsMetaError(
          actionResult.error?.message
          || options?.persistErrorMessage
          || "Не удалось согласовать результат",
        );
        return false;
      }

      applyMatchResultActionResponse(actionResult.data);
      return true;
    } catch {
      setGameDetailsMetaError(options?.persistErrorMessage || "Не удалось согласовать результат");
      return false;
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    applyMatchResultActionResponse,
    gameRecordId,
    isMatchResultPendingReview,
    profileId,
    profileName,
    profilePhone,
    setGameDetailsMetaError,
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

  const handleDisputeMatchResult = useCallback(async () => {
    if (!canDisputeMatchResult) return;

    const actorPhone = normalizePhoneForGame(profilePhone);
    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      const disputeResult = await apiDisputePadelGameResult(gameRecordId || "", {
        phone: actorPhone,
        playerPhone: actorPhone,
        disputerPhone: actorPhone,
        actor: {
          id: profileId ?? null,
          phone: actorPhone,
          name: profileName || null,
        },
      });

      if (disputeResult.error || !disputeResult.data) {
        setGameDetailsMetaError(disputeResult.error?.message || "Не удалось оспорить результат");
        return;
      }

      applyMatchResultActionResponse(disputeResult.data);
    } catch {
      setGameDetailsMetaError("Не удалось оспорить результат");
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    canDisputeMatchResult,
    applyMatchResultActionResponse,
    gameRecordId,
    profileId,
    profileName,
    profilePhone,
  ]);

  const handleConfirmMatchResult = useCallback(async () => {
    if (!canConfirmMatchResult) return;
    await finalizeMatchResultAgreement({
      confirmedBy: {
        id: profileId ?? null,
        phone: normalizePhoneForGame(profilePhone),
        name: profileName || null,
      },
      autoConfirmed: false,
    });
  }, [
    canConfirmMatchResult,
    finalizeMatchResultAgreement,
    profileId,
    profileName,
    profilePhone,
  ]);

  const handleAcceptMatchResultCorrection = useCallback(async () => {
    if (!canAcceptMatchResultCorrection) return;
    const actorPhone = normalizePhoneForGame(profilePhone);
    setUpdatingGameMeta(true);
    setGameDetailsMetaError(null);
    try {
      const acceptResult = await apiAcceptPadelGameResultCorrection(gameRecordId || "", {
        phone: actorPhone,
        playerPhone: actorPhone,
        actor: {
          id: profileId ?? null,
          phone: actorPhone,
          name: profileName || null,
        },
      });

      if (acceptResult.error || !acceptResult.data) {
        setGameDetailsMetaError(acceptResult.error?.message || "Не удалось принять исправление результата");
        return;
      }

      applyMatchResultActionResponse(acceptResult.data);
    } catch {
      setGameDetailsMetaError("Не удалось принять исправление результата");
    } finally {
      setUpdatingGameMeta(false);
    }
  }, [
    applyMatchResultActionResponse,
    canAcceptMatchResultCorrection,
    gameRecordId,
    profileId,
    profileName,
    profilePhone,
  ]);

  const handleRemoveParticipantFromDetails = useCallback(async (player: PadelGamePlayer, index: number) => {
    if (!canManagePlayersInDetails || updatingGameRoster) return;
    if (isDetailsOrganizerPlayer(player)) {
      setGameRosterError("Организатора нельзя удалить из игры");
      return;
    }

    const nextParticipants = detailsParticipants.filter((_, playerIndex) => playerIndex !== index);
    const leftAt = new Date().toISOString();
    const vivaCancellation = await cancelVivaBookingsForPlayerFromDetails(player, "REMOVED_BY_ORGANIZER");
    if (!vivaCancellation.ok) {
      setGameRosterError(vivaCancellation.error || "Не удалось удалить игрока из групповой записи Viva");
      return;
    }

    const nextSplitPayment = markSplitPaymentPlayerLeft(
      detailsSplitPaymentMetadata,
      player,
      leftAt,
      vivaCancellation.summary,
    );
    const nextLeaveEvents = [
      ...normalizeGameLeaveEvents(detailsMetadata.leaveEvents),
      {
        playerId: player.id ?? null,
        playerPhone: normalizePhoneForGame(player.phone),
        playerName: player.name || "Игрок",
        leftAt,
        reason: "ORGANIZER_REMOVED",
        byId: profileId ?? null,
        byPhone: profilePhoneNorm ?? normalizePhoneForGame(profilePhone),
        byName: profileName || "Организатор",
      } satisfies GameLeaveEvent,
    ];
    const nextMetadata = buildDetailsRosterMetadata(nextParticipants, detailsWaitlist, {
      extraMetadata: {
        leaveEvents: nextLeaveEvents,
        lastLeaveUpdateAt: leftAt,
        ...(nextSplitPayment ? { splitPayment: nextSplitPayment } : {}),
      },
    });

    await patchGameRoster(nextParticipants, detailsWaitlist, {
      metadata: nextMetadata,
      fallbackErrorMessage: "Не удалось удалить игрока из игры",
    });
  }, [
    canManagePlayersInDetails,
    updatingGameRoster,
    isDetailsOrganizerPlayer,
    detailsParticipants,
    detailsWaitlist,
    detailsMetadata,
    detailsSplitPaymentMetadata,
    profileId,
    profilePhone,
    profilePhoneNorm,
    profileName,
    buildDetailsRosterMetadata,
    cancelVivaBookingsForPlayerFromDetails,
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

    detailsMatchResultDraftDirtyRef.current = true;
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

    const currentPlayerFromRoster =
      detailsParticipants.find((player) => isCurrentUserPlayer(player))
      ?? detailsWaitlist.find((player) => isCurrentUserPlayer(player))
      ?? null;
    const currentPlayerFromPendingSplit = (
      !currentPlayerFromRoster
      && detailsCurrentUserPendingSplitPayment
      && !detailsCurrentUserPendingSplitPaymentIsExpired
    ) ? {
      id: normalizeBookingId(
        detailsCurrentUserPendingSplitPayment.clientId
        ?? detailsCurrentUserPendingSplitPayment.playerId
        ?? profileId,
      ),
      name: (
        typeof detailsCurrentUserPendingSplitPayment.clientName === "string"
          ? detailsCurrentUserPendingSplitPayment.clientName
          : typeof detailsCurrentUserPendingSplitPayment.playerName === "string"
            ? detailsCurrentUserPendingSplitPayment.playerName
            : typeof detailsCurrentUserPendingSplitPayment.name === "string"
              ? detailsCurrentUserPendingSplitPayment.name
              : profileName
      ) || "Игрок",
      phone: normalizePhoneForGame(
        typeof detailsCurrentUserPendingSplitPayment.phoneNorm === "string"
          ? detailsCurrentUserPendingSplitPayment.phoneNorm
          : typeof detailsCurrentUserPendingSplitPayment.phone === "string"
            ? detailsCurrentUserPendingSplitPayment.phone
            : profilePhoneNorm ?? profilePhone,
      ),
      photo: profilePhoto ?? null,
      rating: profileGrade ?? null,
      ratingNumeric: profileRatingNumeric ?? null,
      source: "INVITE_LINK" as const,
      status: "PENDING" as const,
    } satisfies PadelGamePlayer : null;
    const currentPlayer = currentPlayerFromRoster ?? currentPlayerFromPendingSplit;
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

    const vivaCancellation = await cancelCurrentUserVivaBookingsFromDetails(currentPlayer);
    if (!vivaCancellation.ok) {
      setGameRosterError(vivaCancellation.error || "Не удалось удалить вас из групповой записи Viva");
      return;
    }

    const nextParticipants = detailsParticipants.filter((player) => !isCurrentUserPlayer(player));
    const nextWaitlist = detailsWaitlist.filter((player) => !isCurrentUserPlayer(player));
    const leftAt = new Date().toISOString();
    const nextSplitPayment = markSplitPaymentPlayerLeft(
      detailsSplitPaymentMetadata,
      currentPlayer,
      leftAt,
      vivaCancellation.summary,
    );
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
    const nextMetadata = buildDetailsRosterMetadata(nextParticipants, nextWaitlist, {
      extraMetadata: {
        leaveEvents: nextLeaveEvents,
        lastLeaveUpdateAt: leftAt,
        ...(nextSplitPayment ? { splitPayment: nextSplitPayment } : {}),
        selfRemovalAuditLog: appendGameSelfRemovalAuditLog(
          detailsMetadata.selfRemovalAuditLog,
          buildGameSelfRemovalAuditEntry({
            at: leftAt,
            gameId: activeGameRecord?.id ?? gameRecordId,
            source: "game_details",
            actor: "self",
            playerId: profileId ?? currentPlayer.id ?? null,
            playerPhone: profilePhoneNorm ?? normalizePhoneForGame(currentPlayer.phone),
            playerName: profileName || currentPlayer.name || "Игрок",
            status: vivaCancellation.auditStatus,
            verification: vivaCancellation.verification,
            bookingIds: vivaCancellation.bookingIds,
            trace: vivaCancellation.trace,
          }),
        ),
        lastSelfRemovalAuditAt: leftAt,
      },
    });

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
    pushCabinetFlashNotice(SELF_REMOVE_SUCCESS_NOTICE);
    if (!navigateToCabinetFromGamesDetails()) {
      onBack();
    }
  }, [
    canCurrentUserLeaveGameInDetails,
    gameRecordId,
    detailsParticipants,
    detailsWaitlist,
    isCurrentUserPlayer,
    isDetailsOrganizerPlayer,
    detailsMetadata,
    detailsSplitPaymentMetadata,
    detailsCurrentUserPendingSplitPayment,
    detailsCurrentUserPendingSplitPaymentIsExpired,
    profileName,
    profileId,
    profilePhone,
    profilePhoneNorm,
    profilePhoto,
    profileGrade,
    profileRatingNumeric,
    activeGameRecord?.id,
    buildDetailsRosterMetadata,
    cancelCurrentUserVivaBookingsFromDetails,
    onBack,
    patchGameRoster,
  ]);

  const handleSplitJoinCurrentUserFromDetails = useCallback(async (
    preferredPaymentMode: "subscription" | "one_time",
  ) => {
    if (!canCurrentUserJoinSplitGameInDetails || !gameRecordId || !activeGameRecord) return;
    if (joiningSplitPayment) return;

    const normalizedProfileId = normalizeComparableId(profileId);
    const normalizedPhone = profilePhoneNorm ?? normalizePhoneForGame(profilePhone);
    if (!normalizedProfileId && !normalizedPhone) {
      setGameRosterError("Не удалось определить профиль. Обновите страницу и попробуйте снова.");
      return;
    }

    const splitPayments = Array.isArray(detailsSplitPaymentMetadata?.payments)
      ? detailsSplitPaymentMetadata.payments.filter((item) => isRecordObject(item))
      : [];
    const pendingPayment = splitPayments.find((item) => {
      const itemClientId = normalizeComparableId(item.clientId);
      const itemPhone = normalizePhoneForGame(
        typeof item.phoneNorm === "string"
          ? item.phoneNorm
          : (typeof item.phone === "string" ? item.phone : null),
      );
      if (normalizedProfileId && itemClientId && normalizedProfileId === itemClientId) return true;
      if (normalizedPhone && itemPhone && normalizedPhone === itemPhone) return true;
      return false;
    }) ?? null;
    const pendingPaymentStatus = String(pendingPayment?.status || "").trim().toUpperCase();
    const pendingPaymentUrl = typeof pendingPayment?.paymentUrl === "string"
      ? pendingPayment.paymentUrl.trim()
      : "";
    const pendingPaymentExpired = isSplitPaymentPendingExpired(
      pendingPayment,
      detailsSplitPaymentMetadata,
      splitPendingNowTs,
    );
    if (pendingPayment && isSplitPaymentReservationActive(pendingPayment.status) && !pendingPaymentExpired) {
      if (pendingPaymentStatus === "PAYMENT_PENDING" && pendingPaymentUrl) {
        navigateToExternalUrl(pendingPaymentUrl);
        return;
      }
      setGameRosterError("Вы уже присоединились к этой игре");
      return;
    }

    const booking = activeGameRecord.booking;
    const bookingDate = booking?.date?.trim() || "";
    const fromTime = booking?.timeFrom?.trim() || "";
    const toTime = booking?.timeTo?.trim() || "";
    const exerciseId = resolveGameVivaExerciseId(activeGameRecord);
    const studioId = booking?.studioId?.trim() || "";
    const roomId = booking?.roomId?.trim() || "";
    const bookingDurationMinutes = typeof booking?.durationMinutes === "number" && Number.isFinite(booking.durationMinutes)
      ? booking.durationMinutes
      : null;
    if (!bookingDate || !fromTime || !toTime || !studioId || !roomId || !exerciseId) {
      setGameRosterError("В игре нет данных для оплаты участия");
      return;
    }

    const shareAmount = detailsSplitShareAmount ?? (detailsSplitShareCount === 2 ? 5000 : 2500);
    const paymentRef = generatePaymentRef();
    const callbackUrl = (() => {
      if (typeof window === "undefined") return null;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set(PAYMENT_REF_QUERY_KEY, paymentRef);
        return url.toString();
      } catch {
        return window.location.href || null;
      }
    })();
    const directionId = toFiniteNumber(
      detailsSplitPaymentMetadata?.directionId ?? detailsSplitPaymentMetadata?.vivaDirectionId,
    );
    const exerciseTypeId = toFiniteNumber(
      detailsSplitPaymentMetadata?.exerciseTypeId ?? detailsSplitPaymentMetadata?.vivaExerciseTypeId,
    );
    const totalAmount = toFiniteNumber(detailsSplitPaymentMetadata?.totalAmount);
    const oneTimeBaseAmount = toFiniteNumber(
      detailsSplitPaymentMetadata?.oneTimeBaseAmount ?? detailsSplitPaymentMetadata?.baseShareAmount,
    );

    setJoiningSplitPayment(true);
    setGameRosterError(null);
    try {
      const profile = await resolveCurrentClientProfile();
      const clientPhone = profile.clientPhone ?? normalizedPhone;
      if (!clientPhone) {
        setGameRosterError("В профиле отсутствует номер телефона");
        return;
      }

      let subscriptionCandidates: Subscription[] = [];
      let compatibleSubscriptionCandidates: Subscription[] = [];
      let eligibleSubscriptionCandidates: Subscription[] = [];
      let resolvedClientSubscriptionId: string | null = null;
      if (preferredPaymentMode === "subscription") {
        const subscriptionsResult = await apiFetchSubscriptions();
        if (subscriptionsResult.error) {
          setGameRosterError(subscriptionsResult.error.message || "Не удалось проверить абонемент");
          return;
        }

        subscriptionCandidates = Array.isArray(subscriptionsResult.data?.content)
          ? subscriptionsResult.data.content
          : [];
        const requiredExerciseTypeIds = buildComparableIdSet([
          exerciseTypeId != null ? Math.round(exerciseTypeId) : SPLIT_OPEN_GAME_EXERCISE_TYPE_ID,
        ]);
        const requiredDirectionIds = buildComparableIdSet([
          directionId != null ? Math.round(directionId) : SPLIT_OPEN_GAME_DIRECTION_ID,
        ]);
        compatibleSubscriptionCandidates = subscriptionCandidates.filter((subscription) => subscriptionMatchesSplitCategory(
          subscription,
          requiredExerciseTypeIds,
          requiredDirectionIds,
          studioId,
        ));
        eligibleSubscriptionCandidates = filterSplitEligibleSubscriptions(
          subscriptionCandidates,
          requiredExerciseTypeIds,
          requiredDirectionIds,
          studioId,
          resolveSplitSubscriptionVisitCharge(bookingDurationMinutes),
          bookingDurationMinutes,
          bookingDate,
        );
        resolvedClientSubscriptionId =
          String(eligibleSubscriptionCandidates[0]?.subscriptionId || "").trim() || null;
        const resolvedSubscriptionCandidate = eligibleSubscriptionCandidates[0] ?? null;
        const subscriptionDateMessage = resolveSplitSubscriptionUnavailableMessage({
          subscriptions: compatibleSubscriptionCandidates,
          gameDate: bookingDate,
          requiredVisits: resolveSplitSubscriptionVisitCharge(bookingDurationMinutes),
          requiredDurationMinutes: bookingDurationMinutes,
        });
        if (subscriptionDateMessage) {
          setGameRosterError(subscriptionDateMessage);
          return;
        }
        const dailyLimitSubscriptionCandidate = await resolveSplitSubscriptionDailyLimitCandidate(
          resolvedSubscriptionCandidate,
          splitSubscriptionNamesById,
          clientPhone,
        );
        if (subscriptionPlanAllowsDailyLimitCategory(
          dailyLimitSubscriptionCandidate,
          SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
        )) {
          const dailyLimitBookingsResult = await apiFetchBookings(false, { size: 1000 });
          if (dailyLimitBookingsResult.error) {
            setGameRosterError("Не удалось проверить дневной лимит абонемента");
            return;
          }
          const dailyLimitConflict = resolveSubscriptionCategoryDailyLimitConflictFromBookings(
            dailyLimitBookingsResult.data?.content ?? [],
            {
              targetDate: bookingDate,
              category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
              currentSubscription: dailyLimitSubscriptionCandidate,
              currentClientSubscriptionId: resolvedClientSubscriptionId,
              currentExerciseId: exerciseId,
            },
          );
          if (dailyLimitConflict) {
            setGameRosterError(dailyLimitConflict.message);
            return;
          }
        }
      }

      const paymentResult = await apiCreatePadelSplitParticipantPayment(gameRecordId, {
        date: bookingDate,
        fromTime,
        toTime,
        exerciseId,
        studioId,
        roomId,
        clientId: profile.clientId ?? normalizedProfileId,
        clientPhone,
        paymentRef,
        paymentMode: preferredPaymentMode,
        clientSubscriptionId: resolvedClientSubscriptionId,
        baseRedirectUrl: callbackUrl,
        successUrl: callbackUrl,
        failUrl: callbackUrl,
        shareCount: detailsSplitShareCount,
        shareAmount,
        totalAmount,
        oneTimeBaseAmount,
        shareAmountIncludesDuration: true,
        durationMinutes: bookingDurationMinutes,
        maxClientsCount: Math.max(detailsMaxPlayers, detailsSplitShareCount),
        spot: null,
        vivaDirectionId: directionId != null ? Math.round(directionId) : SPLIT_OPEN_GAME_DIRECTION_ID,
        vivaExerciseTypeId: exerciseTypeId != null ? Math.round(exerciseTypeId) : SPLIT_OPEN_GAME_EXERCISE_TYPE_ID,
        paymentDeadlineMinutes: SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES,
      });

      if (paymentResult.error || !paymentResult.data) {
        const dailyLimitMessage = preferredPaymentMode === "subscription"
          ? resolveSubscriptionCategoryDailyLimitErrorMessage(paymentResult.error)
          : null;
        if (dailyLimitMessage) {
          setGameRosterError(dailyLimitMessage);
        } else if (preferredPaymentMode === "subscription" && isNoSubscriptionsAvailableError(paymentResult.error)) {
          setGameRosterError(
            resolveSplitSubscriptionUnavailableMessage({
              subscriptions: compatibleSubscriptionCandidates.length > 0
                ? compatibleSubscriptionCandidates
                : subscriptionCandidates,
              gameDate: bookingDate,
              requiredVisits: resolveSplitSubscriptionVisitCharge(bookingDurationMinutes),
              requiredDurationMinutes: bookingDurationMinutes,
            }) || paymentResult.error?.message || "Не удалось создать оплату участия",
          );
        } else {
          setGameRosterError(paymentResult.error?.message || "Не удалось создать оплату участия");
        }
        return;
      }

      const bookingIds = paymentResult.data.bookingId ? [paymentResult.data.bookingId] : [];
      enqueuePendingPaymentSync(paymentRef, bookingIds, "details_split_join_pay_click");

      const pendingCurrentClientId = profile.clientId ?? profileId ?? null;
      const pendingCurrentClientPhone = profile.clientPhone ?? profilePhone ?? null;
      const pendingCurrentClientPhoneNorm = normalizePhoneForGame(pendingCurrentClientPhone);
      const pendingPaymentRef = paymentResult.data.paymentRef ?? paymentRef;
      const pendingPaymentSpotRaw = toFiniteNumber(paymentResult.data.spot);
      const pendingPaymentSpot = pendingPaymentSpotRaw != null
        ? Math.max(1, Math.floor(pendingPaymentSpotRaw))
        : null;
      const pendingSplitPaymentSource = isRecordObject(detailsSplitPaymentMetadata)
        ? detailsSplitPaymentMetadata
        : (
          isRecordObject(activeGameRecord.metadata)
          && isRecordObject((activeGameRecord.metadata as Record<string, unknown>).splitPayment)
            ? (activeGameRecord.metadata as Record<string, unknown>).splitPayment as Record<string, unknown>
            : null
        );
      const pendingCurrentSplitPayments = Array.isArray(pendingSplitPaymentSource?.payments)
        ? pendingSplitPaymentSource.payments.filter((item) => isRecordObject(item))
        : [];
      const pendingCurrentSplitBookingIds = parseBookingIdsFromUnknown(pendingSplitPaymentSource?.bookingIds);
      const pendingCurrentMetadataBookingIds = parseBookingIdsFromUnknown(detailsMetadata.bookingIds);
      const pendingFilteredSplitPayments = pendingCurrentSplitPayments.filter((item) => {
        const itemClientId = normalizeComparableId(item.clientId);
        const itemPhoneNorm = normalizePhoneForGame(
          typeof item.phoneNorm === "string"
            ? item.phoneNorm
            : (typeof item.phone === "string" ? item.phone : null),
        );
        const currentClientIdNorm = normalizeComparableId(pendingCurrentClientId);
        if (currentClientIdNorm && itemClientId && currentClientIdNorm === itemClientId) return false;
        if (pendingCurrentClientPhoneNorm && itemPhoneNorm && pendingCurrentClientPhoneNorm === itemPhoneNorm) return false;
        return true;
      });
      const pendingPlayer: PadelGamePlayer = {
        id: pendingCurrentClientId,
        name: profileName || "Игрок",
        phone: pendingCurrentClientPhoneNorm ?? pendingCurrentClientPhone,
        photo: profilePhoto ?? null,
        rating: profileGrade ?? null,
        ratingNumeric: profileRatingNumeric ?? null,
        source: "INVITE_LINK",
        status: "PENDING",
      };
      const pendingNextParticipants = dedupePlayersByIdentity(
        detailsParticipants.filter((player) => !isCurrentUserPlayer(player)),
      );
      const pendingNextWaitlist = dedupePlayersByIdentity([
        ...detailsWaitlist.filter((player) => !isCurrentUserPlayer(player)),
        pendingPlayer,
      ]);
      const pendingNowIso = new Date().toISOString();
      const pendingDeadlineAt = paymentResult.data.deadlineAt
        ?? new Date(Date.now() + SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES * 60 * 1000).toISOString();
      const pendingNextSplitPayment: Record<string, unknown> = {
        ...(pendingSplitPaymentSource ?? {}),
        enabled: true,
        status: "ACTIVE",
        shareCount: detailsSplitShareCount,
        shareAmount,
        bookingIds: Array.from(new Set([
          ...pendingCurrentSplitBookingIds,
          paymentResult.data.bookingId,
        ].filter(Boolean))),
        payments: [
          ...pendingFilteredSplitPayments,
          {
            role: "PARTICIPANT",
            status: "PAYMENT_PENDING",
            paymentRef: pendingPaymentRef,
            clientId: pendingCurrentClientId,
            phone: pendingCurrentClientPhone,
            phoneNorm: pendingCurrentClientPhoneNorm,
            bookingId: paymentResult.data.bookingId ?? null,
            productId: paymentResult.data.productId ?? null,
            transactionId: paymentResult.data.transactionId ?? null,
            paymentUrl: paymentResult.data.paymentUrl ?? null,
            amount: paymentResult.data.toPay ?? null,
            amountMinor: paymentResult.data.toPayMinor ?? null,
            spot: pendingPaymentSpot,
            deadlineAt: pendingDeadlineAt,
            expiresAt: pendingDeadlineAt,
            createdAt: pendingNowIso,
            paidAt: null,
          },
        ],
      };
      const pendingMetadataBookingIds = Array.from(new Set([
        ...pendingCurrentMetadataBookingIds,
        ...pendingCurrentSplitBookingIds,
        paymentResult.data.bookingId,
      ].filter(Boolean)));
      const pendingNextMetadata = buildDetailsRosterMetadata(
        pendingNextParticipants,
        pendingNextWaitlist,
        {
          extraMetadata: {
            bookingIds: pendingMetadataBookingIds,
            splitPayment: pendingNextSplitPayment,
          },
        },
      );
      const pendingSaved = await patchGameRoster(pendingNextParticipants, pendingNextWaitlist, {
        metadata: pendingNextMetadata,
        fallbackErrorMessage: "Не удалось сохранить ожидающую оплату участия",
      });
      if (!pendingSaved) {
        return;
      }

      if (paymentResult.data.paymentUrl) {
        if (!navigateToExternalUrl(paymentResult.data.paymentUrl)) {
          setGameRosterError("Не удалось открыть страницу оплаты");
        }
        return;
      }

      if (paymentResult.data.toPay > 0) {
        setGameRosterError("Не удалось получить ссылку на оплату участия");
        return;
      }

      const isPaidWithoutRedirect = !paymentResult.data.paymentUrl && paymentResult.data.toPay <= 0;
      const refreshed = await apiFetchPadelGameRecord(gameRecordId);
      let resolvedRecord: PadelGameRecord | null = null;
      let resolvedParticipants = detailsParticipants;
      let resolvedWaitlist = detailsWaitlist;
      if (refreshed.data?.id) {
        const fetchedRecord = refreshed.data as PadelGameRecord;
        resolvedRecord = fetchedRecord;
        upsertGameRecordInStores(fetchedRecord, { communityMode: "if_exists" });
        setActiveGameRecordStore((prev) => (prev?.id === fetchedRecord.id ? fetchedRecord : prev));
        resolvedParticipants = Array.isArray(fetchedRecord.participants) ? fetchedRecord.participants : [];
        resolvedWaitlist = Array.isArray(fetchedRecord.waitlist) ? fetchedRecord.waitlist : [];
        setParticipants(resolvedParticipants);
        setWaitlistPlayers(resolvedWaitlist);
      }

      if (isPaidWithoutRedirect) {
        const currentClientId = profile.clientId ?? profileId ?? null;
        const currentClientPhone = profile.clientPhone ?? profilePhone ?? null;
        const currentClientPhoneNorm = normalizePhoneForGame(currentClientPhone);
        const paymentRefResolved = paymentResult.data.paymentRef ?? paymentRef;
        const paymentSpotRaw = toFiniteNumber(paymentResult.data.spot);
        const paymentSpot = paymentSpotRaw != null ? Math.max(1, Math.floor(paymentSpotRaw)) : null;
        const nowIso = new Date().toISOString();
        const hasCurrentUserInParticipants = resolvedParticipants.some((player) => isCurrentUserPlayer(player));
        const hasCurrentUserInWaitlist = resolvedWaitlist.some((player) => isCurrentUserPlayer(player));
        const shouldJoinAsConfirmed = hasCurrentUserInParticipants
          ? true
          : hasCurrentUserInWaitlist
            ? false
            : (paymentSpot != null
              ? paymentSpot <= detailsMaxPlayers
              : resolvedParticipants.length < detailsMaxPlayers);

        const joinPlayerBase: PadelGamePlayer = {
          id: currentClientId,
          name: profileName || "Игрок",
          phone: currentClientPhoneNorm ?? currentClientPhone,
          photo: profilePhoto ?? null,
          rating: profileGrade ?? null,
          ratingNumeric: profileRatingNumeric ?? null,
          source: "INVITE_LINK",
          status: shouldJoinAsConfirmed ? "CONFIRMED" : "WAITLIST",
        };

        const nextParticipants = dedupePlayersByIdentity([
          ...resolvedParticipants.filter((player) => !isCurrentUserPlayer(player)),
          ...(shouldJoinAsConfirmed
            ? [{ ...joinPlayerBase, status: "CONFIRMED" as const }]
            : []),
        ]);
        const nextWaitlist = dedupePlayersByIdentity([
          ...resolvedWaitlist.filter((player) => !isCurrentUserPlayer(player)),
          ...(!shouldJoinAsConfirmed
            ? [{ ...joinPlayerBase, status: "WAITLIST" as const }]
            : []),
        ]);

        const splitPaymentFromResolvedRecord = (
          isRecordObject(resolvedRecord?.metadata)
          && isRecordObject((resolvedRecord.metadata as Record<string, unknown>).splitPayment)
            ? (resolvedRecord.metadata as Record<string, unknown>).splitPayment as Record<string, unknown>
            : null
        );
        const splitPaymentSource = splitPaymentFromResolvedRecord
          ?? pendingNextSplitPayment
          ?? (isRecordObject(detailsSplitPaymentMetadata) ? detailsSplitPaymentMetadata : null);
        const currentSplitPayments = Array.isArray(splitPaymentSource?.payments)
          ? splitPaymentSource.payments.filter((item) => isRecordObject(item))
          : [];
        const currentBookingIds = Array.isArray(splitPaymentSource?.bookingIds)
          ? splitPaymentSource.bookingIds
          : [];
        const matchedCurrentSplitPayment = currentSplitPayments.find((item) => {
          const itemClientId = normalizeComparableId(item.clientId);
          const itemPhoneNorm = normalizePhoneForGame(
            typeof item.phoneNorm === "string"
              ? item.phoneNorm
              : (typeof item.phone === "string" ? item.phone : null),
          );
          const currentClientIdNorm = normalizeComparableId(currentClientId);
          if (currentClientIdNorm && itemClientId && currentClientIdNorm === itemClientId) return true;
          if (currentClientPhoneNorm && itemPhoneNorm && currentClientPhoneNorm === itemPhoneNorm) return true;
          return false;
        }) ?? null;
        const filteredSplitPayments = currentSplitPayments.filter((item) => item !== matchedCurrentSplitPayment);
        const existingBookingId = normalizeBookingId(matchedCurrentSplitPayment?.bookingId);
        const existingSpotRaw = toFiniteNumber(matchedCurrentSplitPayment?.spot);
        const existingSpot = existingSpotRaw != null ? Math.max(1, Math.floor(existingSpotRaw)) : null;
        const resolvedDeadlineAt = paymentResult.data.deadlineAt
          ?? (typeof matchedCurrentSplitPayment?.deadlineAt === "string"
            ? matchedCurrentSplitPayment.deadlineAt
            : pendingDeadlineAt);

        const nextSplitPayment: Record<string, unknown> = {
          ...(splitPaymentSource ?? {}),
          enabled: true,
          status: "ACTIVE",
          shareCount: detailsSplitShareCount,
          shareAmount,
          bookingIds: Array.from(new Set([
            ...parseBookingIdsFromUnknown(currentBookingIds),
            ...parseBookingIdsFromUnknown(matchedCurrentSplitPayment?.bookingIds),
            matchedCurrentSplitPayment?.bookingId,
            paymentResult.data.bookingId,
          ].filter(Boolean))),
          payments: [
            ...filteredSplitPayments,
            {
              ...(matchedCurrentSplitPayment ?? {}),
              role: "PARTICIPANT",
              status: shouldJoinAsConfirmed ? "PAID" : "WAITLIST",
              paymentRef: paymentRefResolved,
              clientId: currentClientId,
              phone: currentClientPhone,
              phoneNorm: currentClientPhoneNorm,
              bookingId: paymentResult.data.bookingId ?? existingBookingId ?? null,
              bookingIds: Array.from(new Set([
                ...parseBookingIdsFromUnknown(matchedCurrentSplitPayment?.bookingIds),
                paymentResult.data.bookingId,
              ].filter(Boolean))),
              productId: paymentResult.data.productId ?? (
                typeof matchedCurrentSplitPayment?.productId === "string"
                  ? (matchedCurrentSplitPayment.productId.trim() || null)
                  : null
              ),
              transactionId: paymentResult.data.transactionId ?? (
                typeof matchedCurrentSplitPayment?.transactionId === "string"
                  ? (matchedCurrentSplitPayment.transactionId.trim() || null)
                  : null
              ),
              paymentUrl: paymentResult.data.paymentUrl ?? (
                typeof matchedCurrentSplitPayment?.paymentUrl === "string"
                  ? (matchedCurrentSplitPayment.paymentUrl.trim() || null)
                  : null
              ),
              amount: paymentResult.data.toPay ?? toFiniteNumber(matchedCurrentSplitPayment?.amount) ?? 0,
              amountMinor: paymentResult.data.toPayMinor ?? toFiniteNumber(matchedCurrentSplitPayment?.amountMinor),
              spot: paymentSpot ?? existingSpot,
              deadlineAt: resolvedDeadlineAt,
              expiresAt: resolvedDeadlineAt,
              createdAt: typeof matchedCurrentSplitPayment?.createdAt === "string"
                ? matchedCurrentSplitPayment.createdAt
                : nowIso,
              paidAt: shouldJoinAsConfirmed
                ? (typeof matchedCurrentSplitPayment?.paidAt === "string"
                  ? matchedCurrentSplitPayment.paidAt
                  : nowIso)
                : null,
              cancelReason: null,
              cancelledAt: null,
              leftAt: null,
            },
          ],
        };
        const nextMetadataBookingIds = Array.from(new Set([
          ...parseBookingIdsFromUnknown(detailsMetadata.bookingIds),
          ...parseBookingIdsFromUnknown(currentBookingIds),
          ...parseBookingIdsFromUnknown(matchedCurrentSplitPayment?.bookingIds),
          matchedCurrentSplitPayment?.bookingId,
          paymentResult.data.bookingId,
        ].filter(Boolean)));

        const nextMetadata = buildDetailsRosterMetadata(nextParticipants, nextWaitlist, {
          extraMetadata: {
            bookingIds: nextMetadataBookingIds,
            splitPayment: nextSplitPayment,
          },
        });

        await patchGameRoster(nextParticipants, nextWaitlist, {
          metadata: nextMetadata,
          fallbackErrorMessage: "Не удалось синхронизировать состав игры после списания абонемента",
        });
      }
    } catch {
      setGameRosterError("Не удалось создать оплату участия");
    } finally {
      setJoiningSplitPayment(false);
    }
  }, [
    canCurrentUserJoinSplitGameInDetails,
    gameRecordId,
    activeGameRecord,
    joiningSplitPayment,
    profileId,
    profilePhoneNorm,
    profilePhone,
    splitPendingNowTs,
    detailsSplitPaymentMetadata,
    detailsSplitShareAmount,
    detailsSplitShareCount,
    detailsMaxPlayers,
    detailsParticipants,
    detailsWaitlist,
    detailsMetadata,
    splitSubscriptionNamesById,
    resolveCurrentClientProfile,
    upsertGameRecordInStores,
    isCurrentUserPlayer,
    profileName,
    profilePhoto,
    profileGrade,
    profileRatingNumeric,
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
    if (navigateToCabinetFromGamesDetails()) return;
    onBack();
  }, [onBack]);

  if (step === "place") {
    return (
      <div className="app-container game-container game-container-place-step">
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
      <div className="app-container game-container game-container-time-step">
        <div className="page-header">
          <button
            className="page-back"
            onClick={() => setStep(usePublicCreateWizard ? "place" : "create")}
            type="button"
          >
            ← Назад
          </button>
          <div className="page-title">Дата и время</div>
        </div>

        {usePublicCreateWizard && studio && (
          <div className="game-section">
            <button
              className="game-card game-create-summary-card"
              onClick={() => setStep("place")}
              type="button"
            >
              <div className="game-card-row">
                <div>
                  <div className="game-card-title">{studio.name}</div>
                  {studio.address && <div className="game-card-sub">{studio.address}</div>}
                </div>
                <span className="game-card-arrow">›</span>
              </div>
            </button>
          </div>
        )}

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
                className={`duration-chip ${duration === d ? "active" : ""} ${usePublicCreateWizard && (d === 60 || d === 90) ? "duration-chip--friendship" : ""}`}
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
                    className={`date-chip ${dateIndex === i ? "active" : ""} ${usePublicCreateWizard && i < 4 && dateIndex !== i ? "date-chip--friendship" : ""}`}
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
          {!usePublicCreateWizard && selectedCourt && (
            <div className="game-selection-filter-row">
              <span className="game-selection-filter-text">{`Показано время для ${selectedCourt.name}`}</span>
              <button
                type="button"
                className="game-selection-filter-reset"
                onClick={resetSelectedCourt}
              >
                Сбросить корт
              </button>
            </div>
          )}
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
              availableTimeSlots.map((slot) => {
                const isSelectedTime = time === slot;
                return (
                  <div key={slot} className="game-time-chip-wrap">
                    <button
                      className={`time-chip ${isSelectedTime ? "active" : ""} ${usePublicCreateWizard && isSelectedTime ? "time-chip--dismissible" : ""}`}
                      onClick={() => setTime(slot)}
                      type="button"
                    >
                      {slot}
                    </button>
                    {usePublicCreateWizard && isSelectedTime && (
                      <button
                        type="button"
                        className="game-time-chip-reset"
                        onClick={resetSelectedTime}
                        aria-label="Сбросить выбранное время"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        {!usePublicCreateWizard && (
          <div className="game-section">
            <div className="team-card game-selected-params-card">
              <div className="game-card-title">Параметры игры</div>
              {renderSelectedParamsChips()}
            </div>
          </div>
        )}

        <div className="game-section">
          <div className="game-section-title">Корты</div>
          {!usePublicCreateWizard && time && (
            <div className="game-selection-filter-row">
              <span className="game-selection-filter-text">{`Показаны корты на ${time}`}</span>
              <button
                type="button"
                className="game-selection-filter-reset"
                onClick={resetSelectedTime}
              >
                Сбросить время
              </button>
            </div>
          )}
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
              availableCourts.map((court) => {
                const isOutdoorCourt = isOutdoorCourtName(court.name);
                const isSelectedCourt = courtId === court.id;
                return (
                  <div className="game-court-option" key={court.id}>
                    <button
                      className={`game-card ${isOutdoorCourt ? "game-court-option-card--outdoor" : ""} ${isSelectedCourt ? "selected" : ""} ${usePublicCreateWizard && isSelectedCourt ? "game-card--dismissible" : ""}`}
                      onClick={() => {
                        setCourtId(court.id);
                      }}
                      type="button"
                    >
                      <div className="game-card-title">{court.name}</div>
                    </button>
                    {isOutdoorCourt && (
                      <button
                        className="game-court-info-button"
                        onClick={() => {
                          setOutdoorCourtHintOpen(true);
                        }}
                        type="button"
                        aria-label={`Пояснение по корту ${court.name}`}
                        title="Пояснение по уличным кортам"
                      >
                        ?
                      </button>
                    )}
                    {usePublicCreateWizard && isSelectedCourt && (
                      <button
                        type="button"
                        className="game-court-option-reset"
                        onClick={resetSelectedCourt}
                        aria-label="Сбросить выбранный корт"
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </div>

        {usePublicCreateWizard && canProceedToPayment && (
          <>
            <div className="game-section">
              <div className="team-card game-create-payment-card">
                <div className="game-card-title">Кто оплачивает корт?</div>
                <button
                  type="button"
                  className={`game-payment-choice-card game-payment-choice-card--payer ${splitPaymentSelected ? "selected" : ""}`}
                  onClick={(event) => {
                    const target = event.target;
                    if (target instanceof HTMLElement && target.closest("[data-subscription-info-trigger='true']")) {
                      setSplitSubscriptionInfoModalOpen(true);
                      return;
                    }
                    setPaymentMode("split");
                  }}
                >
                  <span className="game-payment-choice-radio" aria-hidden="true" />
                  <span className="game-payment-choice-copy">
                    <strong>Каждый платит за себя</strong>
                    <span className="game-payment-choice-description">{publicCreateSplitPaymentDescription}</span>
                    <span className="game-payment-choice-tag game-payment-choice-tag--accent">
                      <svg
                        className="game-payment-choice-tag-icon"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <path
                          d="M7.5 9.16667C9.34195 9.16667 10.8333 7.67528 10.8333 5.83333C10.8333 3.99138 9.34195 2.5 7.5 2.5C5.65805 2.5 4.16667 3.99138 4.16667 5.83333C4.16667 7.67528 5.65805 9.16667 7.5 9.16667Z"
                          fill="currentColor"
                        />
                        <path
                          d="M12.9167 9.99999C14.2988 9.99999 15.4167 8.8821 15.4167 7.49999C15.4167 6.11788 14.2988 5 12.9167 5C12.35 5 11.8273 5.18799 11.4073 5.50496C11.5461 5.90831 11.6224 6.34116 11.6224 6.79166C11.6224 7.8835 11.2078 8.87851 10.5277 9.62782C11.0011 9.86498 11.5348 9.99999 12.1 9.99999H12.9167Z"
                          fill="currentColor"
                        />
                        <path
                          d="M7.5 10.8333C4.73858 10.8333 2.5 13.0719 2.5 15.8333C2.5 16.2936 2.8731 16.6667 3.33333 16.6667H11.6667C12.1269 16.6667 12.5 16.2936 12.5 15.8333C12.5 13.0719 10.2614 10.8333 7.5 10.8333Z"
                          fill="currentColor"
                        />
                        <path
                          d="M13.75 10.8333C13.0818 10.8333 12.4456 10.9694 11.8677 11.2153C12.8994 12.1646 13.5417 13.5263 13.5417 15.0417V15.8333H16.6667C17.1269 15.8333 17.5 15.4602 17.5 15C17.5 12.6988 15.6345 10.8333 13.3333 10.8333H13.75Z"
                          fill="currentColor"
                        />
                      </svg>
                      <span>{publicCreateJoinersPillLabel}</span>
                    </span>
                  </span>
                  <span className={`game-payment-choice-aside${shouldShowPublicSplitSubscriptionBadge ? " game-payment-choice-aside--subscription" : ""}`}>
                    <strong className={`game-payment-choice-price${shouldShowPublicSplitSubscriptionBadge ? " game-payment-choice-price--discounted" : ""}`}>
                      {`${formatPrice(splitShareAmount)} ₽`}
                    </strong>
                    {shouldShowPublicSplitSubscriptionBadge ? (
                      <span className="game-payment-choice-badge">Подписка</span>
                    ) : null}
                    {shouldShowPublicSplitSubscriptionInfoBadge && (
                      <span
                        className="game-payment-choice-badge game-payment-choice-badge--outline"
                        data-subscription-info-trigger="true"
                      >
                        Подписка
                      </span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className={`game-payment-choice-card game-payment-choice-card--payer ${!splitPaymentSelected ? "selected" : ""}`}
                  onClick={() => {
                    setPaymentMode("self");
                    setIsPrivate(false);
                  }}
                >
                  <span className="game-payment-choice-radio" aria-hidden="true" />
                  <span className="game-payment-choice-copy">
                    <strong>Я оплачиваю весь корт</strong>
                    <span className="game-payment-choice-description">{publicCreateFullCourtDescription}</span>
                    <span className="game-payment-choice-tag game-payment-choice-tag--muted">
                      <svg
                        className="game-payment-choice-tag-icon"
                        viewBox="0 0 20 20"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                      >
                        <path
                          d="M7.08333 9.16667C8.69516 9.16667 10 7.86183 10 6.25C10 4.63817 8.69516 3.33333 7.08333 3.33333C5.4715 3.33333 4.16667 4.63817 4.16667 6.25C4.16667 7.86183 5.4715 9.16667 7.08333 9.16667Z"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M2.91667 15.8333C2.91667 13.5321 4.78148 11.6667 7.08333 11.6667C9.38518 11.6667 11.25 13.5321 11.25 15.8333"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path
                          d="M12.9167 7.08333V12.9167"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                        <path
                          d="M10 10H15.8333"
                          stroke="currentColor"
                          strokeWidth="1.7"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span>Соберу игроков сам</span>
                    </span>
                  </span>
                  <span className="game-payment-choice-aside">
                    <strong className="game-payment-choice-price">
                      {paymentAmount != null && paymentAmount > 0 ? `${formatPrice(paymentAmount)} ₽` : "— ₽"}
                    </strong>
                  </span>
                </button>
                {shouldShowPublicSplitPaymentAvailabilityLabel && (
                  <div className={`game-empty${splitPaymentAvailabilityLabelIsError ? " game-pay-error" : ""}`}>
                    {splitPaymentAvailabilityLabel}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <button
          className={`game-submit game-submit-booking ${canProceedToPayment ? "active" : ""}`}
          onClick={() => {
            if (isContinueDisabled()) return;
            setStep("create");
          }}
          type="button"
          disabled={isContinueDisabled()}
        >
          <span className="game-submit-main">{usePublicCreateWizard ? "Продолжить" : paymentContinueTitle}</span>
          {!usePublicCreateWizard && <span className="game-submit-price">{paymentBookingAmount}</span>}
          <span className="game-submit-meta">{paymentStationCourt}</span>
          <span className="game-submit-meta">{paymentTimeRange}</span>
        </button>

        <Modal
          isOpen={outdoorCourtHintOpen}
          onClose={() => {
            setOutdoorCourtHintOpen(false);
          }}
          title="Уличные корты"
        >
          <div className="game-outdoor-court-hint">
            Открытые корты находятся на улице. Просьба приезжать на 10 минут раньше, по сравнению
            с обычными кортами, чтобы начать играть вовремя.
          </div>
        </Modal>

        <Modal
          isOpen={splitSubscriptionInfoModalOpen}
          onClose={() => {
            setSplitSubscriptionInfoModalOpen(false);
          }}
          title="Подписка"
          variant="dialog"
        >
          <div className="find-game-friendly-modal">
            <p className="find-game-friendly-modal-text">Оплатить участие можно по летней подписке.</p>
            <button
              type="button"
              className="section-cta"
              onClick={() => {
                navigateToExternalUrl(PUBLIC_CREATE_SUBSCRIPTION_INFO_URL);
              }}
            >
              Узнать подробнее
            </button>
            <SummerSubscriptionGallery />
          </div>
        </Modal>
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
    if (isGameCancelledStatus(gameRecordStatus)) {
      return (
        <div className="app-container game-container">
          <div className="page-header">
            <button className="back-btn" onClick={onBack}>← Назад</button>
            <div className="page-title">Игра отменена</div>
          </div>
          <div className="game-section">
            <div className="game-empty game-pay-error">
              {gameRecordError || "Эта игра была отменена и больше не отображается в списке."}
            </div>
          </div>
          <div className="game-section">
            <button className="section-cta" type="button" onClick={onBack}>
              Вернуться в кабинет
            </button>
          </div>
        </div>
      );
    }

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
    const isResultViewerParticipant = isCurrentUserConfirmedParticipant;
    const isResultViewerSpectator = !isResultViewerParticipant;
    const effectiveMatchResultStatus: MatchResultLifecycleStatus = isMatchResultAgreed
      ? "CONFIRMED"
      : detailsMatchResultStatus ?? "NO_RESULT";
    const matchResultStatusLabel = (() => {
      if (effectiveMatchResultStatus === "CONFIRMED") return "Итог матча";
      if (effectiveMatchResultStatus === "PENDING_REVIEW") {
        if (isPendingDisputeWindowExpired) return "Согласуется";
        return isMatchResultSubmittedByCurrentUser ? "Результат внесен" : "На согласовании";
      }
      if (effectiveMatchResultStatus === "DISPUTED") return "Оспорен";
      if (effectiveMatchResultStatus === "CORRECTION_PENDING") return "Нужна правка";
      if (effectiveMatchResultStatus === "NO_RESULT_EXPIRED") return "Срок истек";
      return isResultViewerParticipant ? "Ввод результата" : "Ждем результат";
    })();
    const matchResultStatusClass = (() => {
      if (effectiveMatchResultStatus === "CONFIRMED") return "confirmed";
      if (effectiveMatchResultStatus === "PENDING_REVIEW") return "pending";
      if (effectiveMatchResultStatus === "DISPUTED") return "disputed";
      if (effectiveMatchResultStatus === "CORRECTION_PENDING") return "pending";
      if (effectiveMatchResultStatus === "NO_RESULT_EXPIRED") return "disputed";
      return "draft";
    })();
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
    const matchResultRatingWorkMeta = (() => {
      const status = detailsMatchResultRatingWork?.status;
      if (!status) return null;
      if (status === "QUEUED" || status === "RUNNING" || status === "PREPARED") {
        return "Счет сохранен. Рейтинг обновляется в фоне.";
      }
      if (status === "RETRYABLE") {
        return "Счет сохранен. Расчет рейтинга будет повторен автоматически.";
      }
      if (status === "APPLIED") {
        return detailsMatchResultRatingWork?.appliedAt
          ? `Рейтинг рассчитан · ${new Date(detailsMatchResultRatingWork.appliedAt).toLocaleString("ru-RU")}`
          : "Рейтинг рассчитан.";
      }
      if (status === "REVERTED") {
        return detailsMatchResultRatingWork?.revertedAt
          ? `Изменение рейтинга отменено · ${new Date(detailsMatchResultRatingWork.revertedAt).toLocaleString("ru-RU")}`
          : "Изменение рейтинга отменено.";
      }
      if (status === "BLOCKED") {
        return "Счет сохранен. Расчет рейтинга требует проверки администратора.";
      }
      if (status === "SKIPPED") return "Счет сохранен. Игра не влияет на рейтинг.";
      return null;
    })();
    const matchResultLifecycleNote = (() => {
      if (!isDetailsMatchStarted) return "Ввод результатов игры будет доступен после ее начала.";
      if (effectiveMatchResultStatus === "NO_RESULT") {
        return isResultViewerParticipant
          ? "Внесите счет по сетам и отправьте результат на согласование участникам."
          : "Участники еще не отправили результат матча.";
      }
      if (effectiveMatchResultStatus === "PENDING_REVIEW") {
        if (isResultViewerSpectator) return "Результат на согласовании у участников матча.";
        if (isMatchResultSubmittedByCurrentUser) {
          return matchResultDisputeDeadlineMeta
            ? `Счет зафиксирован. До ${matchResultDisputeDeadlineMeta} другие участники могут оспорить его.`
            : "Счет зафиксирован. Другие участники могут оспорить его.";
        }
        if (detailsMatchResultDisputeTimeLeftMs != null && detailsMatchResultDisputeTimeLeftMs > 0) {
          return `Проверьте результат: его можно подтвердить или оспорить до ${matchResultDisputeDeadlineMeta}.`;
        }
        return "Срок на оспаривание истек. Согласуем результат автоматически.";
      }
      if (effectiveMatchResultStatus === "DISPUTED") {
        return isResultViewerParticipant
          ? "Результат оспорен. Автору результата нужно отправить исправление или договориться с участниками."
          : "Результат оспорен участниками, ждем исправление.";
      }
      if (effectiveMatchResultStatus === "CORRECTION_PENDING") {
        if (detailsMatchResultModelVersion >= 2) {
          return isMatchResultSubmittedByCurrentUser
            ? "Результат оспорен. Исправьте счет и сохраните новую версию."
            : "Результат оспорен. Ждем новую версию от автора.";
        }
        return isResultViewerParticipant
          ? "Отправлено исправление результата. Проверьте и примите его, если все верно."
          : "Исправление результата ожидает решения участников.";
      }
      if (effectiveMatchResultStatus === "NO_RESULT_EXPIRED") {
        return "Срок внесения результата истек.";
      }
      return null;
    })();
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
    const isMatchResultRatingImpactFallback = isMatchResultAgreed
      && detailsMatchResultRatingImpact.length === 0
      && fallbackRatingImpactRows.length > 0;
    const isMatchResultVivaSynced = detailsMatchResultVivaSync?.status === "SUCCESS";
    const canRetryVivaMatchResultSync = isMatchResultAgreed
      && matchResultRatingImpactRows.length > 0
      && !updatingGameMeta
      && !isMatchResultVivaSynced;
    const syncedPlayersCount = detailsMatchResultVivaSync?.syncedPlayers && detailsMatchResultVivaSync.syncedPlayers > 0
      ? detailsMatchResultVivaSync.syncedPlayers
      : matchResultRatingImpactRows.length;
    const totalPlayersCount = detailsMatchResultVivaSync?.totalPlayers && detailsMatchResultVivaSync.totalPlayers > 0
      ? detailsMatchResultVivaSync.totalPlayers
      : matchResultRatingImpactRows.length;
    const matchResultVivaSyncedMeta = isMatchResultAgreed && isMatchResultVivaSynced
      ? [
        `Рейтинг игроков изменен в Viva (${syncedPlayersCount}/${totalPlayersCount})`,
        detailsMatchResultVivaSync?.lastSuccessAt
          ? new Date(detailsMatchResultVivaSync.lastSuccessAt).toLocaleString("ru-RU")
          : null,
      ].filter(Boolean).join(" · ")
      : null;
    const matchResultVivaSyncWarning = isMatchResultAgreed
      && detailsMatchResultVivaSync
      && (detailsMatchResultVivaSync.status === "FAILED" || detailsMatchResultVivaSync.status === "PARTIAL_SUCCESS")
      ? detailsMatchResultVivaSync.lastError || "Не удалось полностью обновить рейтинг в Viva"
      : null;
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
                    const slotLevelLabel = normalizePlayerRatingLabel(
                      slotPlayer?.rating ?? null,
                      normalizeRatingNumeric(slotPlayer?.ratingNumeric),
                    );
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
                const isPoolPlayer = !isWaitlistPlayer && detailsPlayerPool.some((item) => (
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
                    {isPoolPlayer ? " · пул игроков" : ""}
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
    const detailsInviteActionLabel = inviteFeedback === "shared"
      ? "Ссылка отправлена"
      : inviteFeedback === "copied"
        ? "Ссылка скопирована"
        : "Пригласить в игру";
    const showDetailsRosterInviteRow = !isMatchResultAgreed && canCurrentUserInviteInDetails;
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
              {`${detailsOccupiedSlotsCount}/${detailsMaxPlayers}`}
            </div>
          </div>
          {gameRosterError && <div className="game-empty game-pay-error">{gameRosterError}</div>}
          <div className="details-roster-list">
            {detailsParticipants.length === 0 ? (
              <div className="game-empty">Пока нет подтвержденных игроков</div>
            ) : (
              detailsParticipants.map((player, index) => {
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
                            onClick={() => {
                              void handleRemoveParticipantFromDetails(player, index);
                            }}
                            disabled={updatingGameRoster}
                          >
                            Удалить
                          </button>
                        </div>
                      ) : (
                        shouldShowCurrentUserLeaveActionInDetails && isCurrentUserPlayer(player) && (
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
              })
            )}
            {showDetailsRosterInviteRow && (
              <button
                type="button"
                className="details-roster-row details-roster-row-invite"
                onClick={handleCopyInvite}
                disabled={!inviteLink}
              >
                <span className="details-roster-player">
                  <span className="details-roster-avatar-wrap details-roster-avatar-wrap-invite" aria-hidden="true">
                    <span className="details-roster-avatar details-roster-avatar-invite-plus">+</span>
                  </span>
                  <span className="details-roster-meta">
                    <span className="details-roster-name">{detailsInviteActionLabel}</span>
                  </span>
                </span>
              </button>
            )}
          </div>
          {detailsWaitlist.length > 0 && (
            <div className="details-roster-waitlist">
              <div className="details-roster-subtitle">Лист ожидания</div>
              <div className="details-roster-list">
                {detailsWaitlist.map((player, index) => {
                  const playerKey = getPadelPlayerIdentityKey(player) || `waitlist-${index}`;
                  const waitlistPaymentState = detailsWaitlistPaymentStateByKey.get(playerKey);
                  const waitlistSubtitle = (() => {
                    if (!canManagePlayersInDetails || !waitlistPaymentState) {
                      return "Ожидает подтверждения";
                    }
                    if (waitlistPaymentState.isPending) {
                      return waitlistPaymentState.countdownLabel
                        ? `Без оплаты · удалить через ${waitlistPaymentState.countdownLabel}`
                        : "Без оплаты";
                    }
                    if (waitlistPaymentState.isExpired) {
                      return "Без оплаты · время ожидания вышло";
                    }
                    return "Ожидает подтверждения";
                  })();
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
                          <div className="details-roster-sub">{waitlistSubtitle}</div>
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
                        shouldShowCurrentUserLeaveActionInDetails && isCurrentUserPlayer(player) && (
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
              <button
                type="button"
                className="details-roster-history-toggle"
                aria-expanded={detailsLeaveHistoryOpen}
                aria-controls="details-roster-leave-list"
                onClick={() => {
                  setDetailsLeaveHistoryOpen((prev) => !prev);
                }}
              >
                <span>История присоединений</span>
                <span className={`details-roster-history-toggle-icon${detailsLeaveHistoryOpen ? " is-open" : ""}`}>v</span>
              </button>
              {detailsLeaveHistoryOpen && (
                <div className="details-roster-leave-list" id="details-roster-leave-list">
                  {detailsLeaveEvents.map((item, index) => {
                    const playerName = item.playerName?.trim() || "Игрок";
                    const leftAtLabel = new Date(item.leftAt).toLocaleString("ru-RU");
                    const reason = String(item.reason || "").trim().toUpperCase();
                    const actionLabel = reason === "ORGANIZER_REMOVED"
                      ? "удален из игры"
                      : (reason === "AUTO_PAYMENT_TIMEOUT" || reason.includes("PAYMENT_TIMEOUT"))
                        ? "удален из-за неоплаты"
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
              )}
            </div>
          )}
        </div>
      </>
    );
    const matchResultRatingImpactBlock = (isMatchResultAgreed || isMatchResultPendingReview)
      && matchResultRatingImpactRows.length > 0 ? (
      <div className="details-rating-impact">
        <div className="details-rating-impact-title">
          {isMatchResultPendingReview ? "Предварительное изменение рейтинга" : "Изменение рейтинга"}
        </div>
        {isMatchResultRatingImpactFallback && (
          <div className="details-result-note">
            Предварительная оценка для отображения. Источник истины по рейтингу - backend ratingImpact.
          </div>
        )}
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

              {matchResultRatingWorkMeta && (
                <div className="details-result-meta">{matchResultRatingWorkMeta}</div>
              )}

              {matchResultVivaSyncedMeta && (
                <div className="details-result-meta">{matchResultVivaSyncedMeta}</div>
              )}

              {matchResultVivaSyncWarning && (
                <div className="details-result-note">
                  {matchResultVivaSyncWarning}
                </div>
              )}

              {canRetryVivaMatchResultSync && (
                <div className="details-result-note">
                  Повторная синхронизация в Viva больше не запускается с фронта. Источник истины по рейтингу теперь backend lifecycle результата.
                </div>
              )}

              {matchResultLifecycleNote && (
                <div className="details-result-note">
                  {matchResultLifecycleNote}
                </div>
              )}

              <div className="details-result-sets">
                {matchResultSetsForDisplay.map((setItem, index) => {
                  const setPairing = matchResultSetPairingsForDisplay[index] ?? null;
                  const previousSetPairing = index > 0
                    ? (matchResultSetPairingsForDisplay[index - 1] ?? null)
                  : null;
                  const isEditableStartPairing = canEditMatchResult
                    && index === 0
                    && detailsCompletedMatchResultSets.length === 0;
                  const isUpcomingSetPairingBlock = canEditMatchResult
                    && index > 0
                    && index === detailsCompletedMatchResultSets.length;
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
                  const hasSetPairingContent = Boolean(
                    setPairingTeamALabel || setPairingTeamBLabel || isEditableStartPairing
                  );
                  const hasSetPairingChange = Boolean(
                    isEditableStartPairing
                    || !previousSetPairing
                    || !areTeamSlotsEqualByIdentity(setPairingSlotsForDisplay ?? [], previousSetPairing)
                  );
                  const shouldShowSetPairingBlock = hasSetPairingContent && (
                    isEditableStartPairing
                    || !canEditMatchResult
                    || index < detailsCompletedMatchResultSets.length
                    || (isUpcomingSetPairingBlock && Boolean(setPairingSlotsForDisplay?.some(Boolean)))
                  ) && hasSetPairingChange;
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
                    const playerLevelLabel = normalizePlayerRatingLabel(
                      player?.rating ?? null,
                      normalizeRatingNumeric(player?.ratingNumeric),
                    );
                    const playerLevelProgress = getPlayerRatingProgress(playerLevelLabel);
                    const playerRingProgressDeg = playerLevelProgress != null
                      ? `${Math.max(0, Math.min(360, Math.round(playerLevelProgress * 360)))}deg`
                      : "0deg";
                    const playerKey = getPadelPlayerIdentityKey(player) || `set-${index}-${teamKey}-${playerIndex}`;
                    const slotIsOrganizerLocked =
                      slotIndex === 0 && detailsOrganizerInMatch && Boolean(detailsOrganizerPlayer);
                    const slotDisabled = updatingGameMeta
                      || (slotIsOrganizerLocked && !canEditMatchResultTeamsInDetails)
                      || (!canEditMatchResultTeamsInDetails
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
                        {isEditableStartPairing && detailsTeamMenuSlotIndex != null && canEditMatchResultTeamsInDetails && (
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
                                const isPoolPlayer = !isWaitlistPlayer && detailsPlayerPool.some((item) => (
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
                                    {isPoolPlayer ? " · пул игроков" : ""}
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
                    {canEditMatchResult
                      && detailsMatchResultSets.length > 1
                      && setItem.left.trim() === ""
                      && setItem.right.trim() === "" && (
                        <button
                          type="button"
                          className="details-result-pair-toggle"
                          onClick={() => {
                            handleRemoveMatchResultSet(index);
                          }}
                          disabled={updatingGameMeta}
                        >
                          Удалить пустой сет
                        </button>
                      )}
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

              {canEditMatchResult && (
                <div className="details-result-pair-change">
                  <button
                    type="button"
                    className="details-result-pair-toggle"
                    onClick={handleAddEmptyMatchResultSet}
                    disabled={updatingGameMeta}
                  >
                    Добавить пустой сет
                  </button>
                </div>
              )}

              {matchResultPhotosBlock}

              {matchResultRatingImpactBlock}

              {canEditMatchResult && detailsMatchResultValidationError && hasAnyMatchResultScoreInput && (
                <div className="details-result-note">
                  {detailsMatchResultValidationError}
                </div>
              )}

              {canEditMatchResult && detailsCompletedMatchResultSets.length > 0 && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-submit"
                  onClick={() => {
                    void handleSubmitMatchResult();
                  }}
                  disabled={!canSubmitMatchResult}
                >
                  {updatingGameMeta ? "Сохраняем..." : "Сохранить результат"}
                </button>
              )}
              {canConfirmMatchResult && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-confirm"
                  onClick={() => {
                    void handleConfirmMatchResult();
                  }}
                  disabled={updatingGameMeta}
                >
                  {updatingGameMeta ? "Сохраняем..." : "Подтвердить результат"}
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
              {canAcceptMatchResultCorrection && (
                <button
                  type="button"
                  className="section-cta section-cta-secondary details-result-confirm"
                  onClick={() => {
                    void handleAcceptMatchResultCorrection();
                  }}
                  disabled={updatingGameMeta}
                >
                  {updatingGameMeta ? "Сохраняем..." : "Принять исправление"}
                </button>
              )}
            </div>
          )}

          {!isCurrentUserConfirmedParticipant && !isCurrentUserOrganizerByDetails && (
            <div className="details-action-row">
              {isDetailsSplitPaymentGame ? (
                detailsCurrentUserPendingSplitPayment && !detailsCurrentUserPendingSplitPaymentIsExpired ? (
                  <div className="game-join-split-pay-actions">
                    <div className="game-empty">
                      {detailsCurrentUserPendingSplitPaymentCountdownLabel
                        ? `Ожидаем оплату участия · осталось ${detailsCurrentUserPendingSplitPaymentCountdownLabel}`
                        : "Ожидаем оплату участия"}
                    </div>
                    <button
                      className="game-join-split-pay-option game-join-split-pay-option-primary"
                      type="button"
                      disabled={!detailsCurrentUserPendingSplitPaymentPaymentUrl}
                      onClick={() => {
                        if (!detailsCurrentUserPendingSplitPaymentPaymentUrl) return;
                        navigateToExternalUrl(detailsCurrentUserPendingSplitPaymentPaymentUrl);
                      }}
                    >
                      Оплатить
                    </button>
                    <button
                      className="game-join-split-pay-option"
                      type="button"
                      disabled={!canCurrentUserLeaveGameInDetails}
                      onClick={() => {
                        void handleLeaveCurrentUserFromDetails();
                      }}
                    >
                      Покинуть игру
                    </button>
                  </div>
                ) : (
                  <div className="game-join-split-pay-actions">
                    <button
                      className="game-join-split-pay-option"
                      type="button"
                      disabled={!canCurrentUserJoinSplitGameInDetails}
                      onClick={() => {
                        void handleSplitJoinCurrentUserFromDetails("subscription");
                      }}
                    >
                      {detailsSplitJoinSubscriptionLabel}
                    </button>
                    <button
                      className="game-join-split-pay-option game-join-split-pay-option-primary"
                      type="button"
                      disabled={!canCurrentUserJoinSplitGameInDetails}
                      onClick={() => {
                        void handleSplitJoinCurrentUserFromDetails("one_time");
                      }}
                    >
                      {detailsSplitJoinOneTimeLabel}
                    </button>
                  </div>
                )
              ) : (
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
              )}
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

          {!isMatchResultAgreed
          && ((!showDetailsRosterInviteRow && canCurrentUserInviteInDetails) || canCurrentUserOpenDetailsChat)
          && (
            <div className="details-action-row">
              {!showDetailsRosterInviteRow && canCurrentUserInviteInDetails && (
                <button
                  className="section-cta details-action-invite"
                  onClick={handleCopyInvite}
                  type="button"
                  disabled={!inviteLink}
                >
                  {detailsInviteActionLabel}
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
        {usePublicCreateWizard ? (
          <div className="team-card game-create-summary-card game-create-summary-card--review">
            <div className="game-card-row game-create-summary-row">
              <div className="game-create-summary-copy">
                <div className="game-card-title">{studio ? studio.name : "Станция"}</div>
                <div className="game-create-summary-meta-row">
                  <span className="game-create-summary-meta-item">
                    <span className="game-create-summary-meta-icon" aria-hidden="true">
                      {renderPublicCreateSummaryIcon("place")}
                    </span>
                    <span>{publicCreateSummaryCourtLabel}</span>
                  </span>
                  {dateLabel && (
                    <>
                      <span className="game-create-summary-meta-dot" aria-hidden="true">•</span>
                      <span className="game-create-summary-meta-item">
                        <span className="game-create-summary-meta-icon" aria-hidden="true">
                          {renderPublicCreateSummaryIcon("calendar")}
                        </span>
                        <span>{dateLabel}</span>
                      </span>
                    </>
                  )}
                </div>
                <div className="game-create-summary-meta-row">
                  {publicCreateSummaryTimeLabel && (
                    <span className="game-create-summary-meta-item">
                      <span className="game-create-summary-meta-icon" aria-hidden="true">
                        {renderPublicCreateSummaryIcon("clock")}
                      </span>
                      <span>{publicCreateSummaryTimeLabel}</span>
                    </span>
                  )}
                  {publicCreateSummaryTimeLabel && (
                    <span className="game-create-summary-meta-dot" aria-hidden="true">•</span>
                  )}
                  <span className="game-create-summary-meta-item">
                    <span className="game-create-summary-meta-icon" aria-hidden="true">
                      {renderPublicCreateSummaryIcon("duration")}
                    </span>
                    <span>{`${duration} мин`}</span>
                  </span>
                </div>
                <div className="game-create-summary-meta-row game-create-summary-meta-row--payment">
                  <span className="game-create-summary-meta-item">
                    <span className="game-create-summary-meta-icon" aria-hidden="true">
                      {renderPublicCreateSummaryIcon("players")}
                    </span>
                    <span>{publicCreateSummaryPaymentLine}</span>
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="game-summary-edit-button"
                onClick={() => setStep("time")}
              >
                Изменить
              </button>
            </div>
          </div>
        ) : (
          <>
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
          </>
        )}

        {!isSinglesGame && (
          usePublicCreateWizard ? (
            <div className="team-card game-create-level-card">
              <div className="game-create-level-heading">
                <div className="game-card-title">Уровень игроков</div>
                <div className="game-create-level-summary">{publicCreateLevelSummaryLabel}</div>
              </div>
              <div className="game-create-level-compact-panel">
                <div className="game-create-level-range-strip-wrap">
                  <div
                    className={`game-create-level-range-strip ${ratingGame ? "" : "is-inactive"}`}
                    role="group"
                    aria-label="Уровень игры"
                  >
                    {RATING_LABELS.map((label, index) => {
                      const selected = ratingGame && index >= minRating && index <= maxRating;
                      return (
                        <button
                          key={`public-create-rating-segment-${label}`}
                          type="button"
                          className={`game-create-level-range-segment ${selected ? "is-selected" : ""}`}
                          onClick={() => handlePublicCreateLevelButtonSelect(index)}
                          aria-pressed={selected}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
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
            </>
          )
        )}

        {!isBookingPresetMode && !usePublicCreateWizard && (
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

        {usePublicCreateWizard ? (
          <div className="team-card game-create-visibility-card">
            <div className="game-card-title">Доступность игры</div>
            <div className="game-create-visibility-options">
              <button
                type="button"
                className={`game-payment-choice-card game-visibility-option game-visibility-option--public ${!isPrivate ? "selected" : ""}`}
                onClick={() => setIsPrivate(false)}
              >
                <span className="game-payment-choice-radio" aria-hidden="true" />
                <span className="game-visibility-option-copy">
                  <span className="game-visibility-option-title-row">
                    <strong className="game-visibility-option-title">Открытая игра</strong>
                  </span>
                  <span className="game-visibility-option-description">{publicCreateVisibilityOpenDescription}</span>
                </span>
                <span className="game-visibility-option-pill">
                  <span className="game-visibility-option-pill-icon" aria-hidden="true">
                    {renderPublicCreateVisibilityPillIcon("public")}
                  </span>
                  <span className="game-visibility-option-pill-label">{publicCreateVisibilityOpenPillLabel}</span>
                </span>
              </button>
              <button
                type="button"
                className={`game-payment-choice-card game-visibility-option game-visibility-option--private ${isPrivate ? "selected" : ""}`}
                onClick={() => setIsPrivate(true)}
              >
                <span className="game-payment-choice-radio" aria-hidden="true" />
                <span className="game-visibility-option-copy">
                  <span className="game-visibility-option-title-row">
                    <strong className="game-visibility-option-title">Приватная игра</strong>
                  </span>
                  <span className="game-visibility-option-description">{publicCreateVisibilityPrivateDescription}</span>
                </span>
                <span className="game-visibility-option-pill">
                  <span className="game-visibility-option-pill-icon" aria-hidden="true">
                    {renderPublicCreateVisibilityPillIcon("private")}
                  </span>
                  <span className="game-visibility-option-pill-label">{publicCreateVisibilityPrivatePillLabel}</span>
                </span>
              </button>
            </div>
          </div>
        ) : (
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
        )}
        {!isBookingPresetMode && !usePublicCreateWizard && (
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
        {!usePublicCreateWizard && splitPaymentAvailabilityLabel && (
          <div className={`game-empty${splitPaymentAvailabilityLabelIsError ? " game-pay-error" : ""}`}>
            {splitPaymentAvailabilityLabel}
          </div>
        )}

        {ENABLE_GAME_COMMUNITY_AUTOPUBLISH && (
          <div className="team-card game-autopublish-panel">
            <div className="game-card-title">Публикация в сообщества</div>
            <div className="game-autopublish-row" role="group" aria-label="Выбор сообществ для публикации">
              {usePublicCreateWizard && (
                <div
                  className={`team-member game-autopublish-card game-autopublish-card--general-list game-autopublish-card--readonly${!isPrivate ? " is-selected" : ""}`}
                >
                  <span className="game-autopublish-card-check" aria-hidden="true" />
                  <div className="game-autopublish-card-avatar game-autopublish-card-avatar--square">
                    {renderCommunityAutopublishAvatar({
                      name: publicCreateGeneralListCardLabel,
                      logo: logoHabBlack,
                    })}
                  </div>
                  <div className="game-autopublish-card-name">{publicCreateGeneralListCardLabel}</div>
                </div>
              )}
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
            && communityAutopublishCards
              .filter((community) => community.communityId)
              .every((community) => !community.selectable) && (
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
            {!usePublicCreateWizard && (
              <div className="game-publish-fields-note">
                {publicationFieldsNote}
              </div>
            )}
            {!usePublicCreateWizard && <div className="game-card-title">Данные для публикации</div>}
            <div className="game-publish-fields-stack">
              <label className="game-publish-field">
                <span className="game-publish-field-label">
                  {usePublicCreateWizard ? "Название игры для публикации" : "Название игры"}
                </span>
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
                />
              </label>
              {shouldShowPublicationJoinPriceField && (
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
              )}
            </div>
          </div>
        )}

        {usePublicCreateWizard && splitPaymentSelected && (
          <div className="team-card game-create-payment-method-card">
            <div className="game-card-title">Способ оплаты записи</div>
            {splitSubscriptionPaymentOptions.map((option) => (
              <button
                key={option.subscriptionId}
                type="button"
                className={`game-payment-choice-card game-payment-choice-card--subscription ${splitCheckoutMode === "subscription" && selectedSplitSubscriptionId === option.subscriptionId ? "selected" : ""}`}
                onClick={() => {
                  setSplitCheckoutMode("subscription");
                  setSelectedSplitSubscriptionId(option.subscriptionId);
                }}
                disabled={splitSubscriptionsLoading}
              >
                <span className="game-payment-choice-radio" aria-hidden="true" />
                <span className="game-payment-choice-copy">
                  <strong>{option.name}</strong>
                  <span>Создать игру по подписке</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              className={`game-payment-choice-card ${splitCheckoutMode === "one_time" ? "selected" : ""}`}
              onClick={() => setSplitCheckoutMode("one_time")}
            >
              <span className="game-payment-choice-radio" aria-hidden="true" />
              <span className="game-payment-choice-copy">
                <strong>Оплатить картой</strong>
                <span>{publicCreateSplitShareLabel}</span>
              </span>
            </button>
            {shouldShowPublicSplitPaymentAvailabilityLabel && (
              <div className={`game-empty${splitPaymentAvailabilityLabelIsError ? " game-pay-error" : ""}`}>
                {splitPaymentAvailabilityLabel}
              </div>
            )}
          </div>
        )}

        {showInlinePaymentSection && (
          <div className="game-payment-stack">
            {splitPaymentAvailable && splitPaymentSelected && !usePublicCreateWizard && (
              <div className="game-split-payment-panel">
                <div className="game-split-payment-summary">
                  <span>{splitPaymentSummary}</span>
                </div>
              </div>
            )}
            {!usePublicCreateWizard && splitPaymentSelected && splitHasEligibleSubscriptions && (
              splitHasSubscriptionPaymentOptions
                ? (
                  <div className="game-split-subscription-options">
                    <div className="game-split-subscription-title">Выберите абонемент для списания</div>
                    {splitSubscriptionPaymentOptions.map((option) => (
                      <button
                        key={option.subscriptionId}
                        className="game-split-subscription-option"
                        onClick={() => {
                          void handleSplitGamePay("subscription", option.subscriptionId);
                        }}
                        type="button"
                        disabled={!canProceedToPayment || loadingPay || splitSubscriptionsLoading}
                      >
                        <span>{`Списать с «${option.name}»`}</span>
                        <strong>{option.balanceLabel}</strong>
                      </button>
                    ))}
                  </div>
                )
                : (
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
                )
            )}
            <button
              className={`game-submit game-submit-booking game-submit-inline ${canProceedToPayment ? "active" : ""}`}
              onClick={() => {
                if (usePublicCreateWizard) {
                  handleCreateSubmit();
                  return;
                }
                if (splitPaymentSelected) {
                  void handleSplitGamePay(splitHasEligibleSubscriptions ? "one_time" : undefined);
                } else {
                  void handleMasterServicePay();
                }
              }}
              type="button"
              disabled={!canProceedToPayment || loadingPay}
            >
              <span className="game-submit-main">
                {usePublicCreateWizard ? publicCreateFinalSubmitTitle : paymentSubmitTitle}
              </span>
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
            {inviteFeedback === "shared"
              ? "Ссылка отправлена"
              : inviteFeedback === "copied"
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
      {isBookingPresetMode && bookingPresetErrorMessage && (
        <div className="game-empty game-pay-error">{bookingPresetErrorMessage}</div>
      )}

      <Modal
        isOpen={publicCreatePreciseRatingModalOpen}
        onClose={() => {
          setPublicCreatePreciseRatingModalOpen(false);
        }}
        title="Настроить точнее"
        variant="dialog"
        bodyClassName="game-create-precise-rating-modal-body"
      >
        <div className="game-create-precise-rating-modal">
          <div className="game-create-precise-rating-modal-grid">
            <div className="game-create-precise-rating-modal-group">
              <div className="game-create-precise-rating-modal-group-title">От</div>
              <div className="game-create-precise-rating-modal-row">
                <select
                  className="game-input"
                  value={publicCreatePreciseRatingRange.min.grade}
                  onChange={(event) => {
                    handlePublicCreatePreciseRatingBoundChange("min", "grade", event.target.value);
                  }}
                  aria-label="Минимальная буква уровня"
                >
                  {PRECISE_RATING_GRADE_OPTIONS.map((grade) => (
                    <option key={`public-create-precise-min-grade-${grade}`} value={grade}>{grade}</option>
                  ))}
                </select>
                <select
                  className="game-input"
                  value={String(publicCreatePreciseRatingRange.min.level)}
                  onChange={(event) => {
                    handlePublicCreatePreciseRatingBoundChange("min", "level", event.target.value);
                  }}
                  aria-label="Минимальная цифра уровня"
                >
                  {PRECISE_RATING_LEVEL_OPTIONS.map((level) => (
                    <option key={`public-create-precise-min-level-${level}`} value={level}>{level}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="game-create-precise-rating-modal-group">
              <div className="game-create-precise-rating-modal-group-title">До</div>
              <div className="game-create-precise-rating-modal-row">
                <select
                  className="game-input"
                  value={publicCreatePreciseRatingRange.max.grade}
                  onChange={(event) => {
                    handlePublicCreatePreciseRatingBoundChange("max", "grade", event.target.value);
                  }}
                  aria-label="Максимальная буква уровня"
                >
                  {PRECISE_RATING_GRADE_OPTIONS.map((grade) => (
                    <option key={`public-create-precise-max-grade-${grade}`} value={grade}>{grade}</option>
                  ))}
                </select>
                <select
                  className="game-input"
                  value={String(publicCreatePreciseRatingRange.max.level)}
                  onChange={(event) => {
                    handlePublicCreatePreciseRatingBoundChange("max", "level", event.target.value);
                  }}
                  aria-label="Максимальная цифра уровня"
                >
                  {PRECISE_RATING_LEVEL_OPTIONS.map((level) => (
                    <option key={`public-create-precise-max-level-${level}`} value={level}>{level}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="game-create-precise-rating-modal-summary">
            {publicCreateRatingSummaryLabel} <strong>{publicCreatePreciseRatingSummaryValue}</strong>
          </div>
        </div>
      </Modal>

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
