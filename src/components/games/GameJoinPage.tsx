import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiCreatePadelSplitParticipantPayment,
  apiFetchSubscriptionDailyLimitBookings,
  apiLeavePadelGameAsCurrentUser,
  apiFetchPadelGameRecord,
  apiFetchTournamentParticipants,
  apiFetchProfile,
  apiFetchSubscriptioName,
  apiFetchSubscriptions,
  apiUpdatePadelGameRecord,
  type PadelGamePlayer,
  type PadelGameRecord,
  type Subscription,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  excludePlayersAlreadyInRoster,
  playersShareRosterIdentity,
  reconcileRosterWithViva,
  type RosterSyncLeaveEvent,
} from "./rosterSyncReconcile";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import { CABINET_URL } from "../../consts/api_config";
import { PAYMENT_REF_QUERY_KEY } from "../../utils/paymentSync";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import { pushCabinetFlashNotice } from "../../utils/cabinetFlashNotice";
import {
  buildSplitComparableIdSet,
  filterSplitCategoryCompatibleSubscriptions,
  filterSplitEligibleSubscriptions,
  isNoSubscriptionsAvailableError,
  resolveSplitSubscriptionUnavailableMessage,
} from "./splitSubscriptionAvailability";
import { shouldSkipRecentSplitGameRosterSync } from "./recentPaidGameStability";
import {
  SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
  resolveSubscriptionCategoryDailyLimitConflictFromBookings,
  resolveSubscriptionCategoryDailyLimitErrorMessage,
  subscriptionPlanAllowsDailyLimitCategory,
  withSubscriptionCategoryDailyLimitResolvedName,
} from "../../utils/subscriptionCategoryDailyLimit";

type JoinDecision = "JOINED" | "WAITLIST" | "DECLINED" | "NONE";

interface GameJoinPageProps {
  gameId: string;
  cabinetUrl?: string | null;
}

const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_MAX_PLAYERS = 4;
const DEFAULT_SINGLES_MAX_PLAYERS = 2;
const SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES = 10;
const SPLIT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const SPLIT_OPEN_GAME_DIRECTION_ID = 4588;
const OPEN_GAME_QUERY_KEY = "openGameId";
const SPLIT_JOIN_QUERY_KEY = "splitJoin";
const SPLIT_PAYMENT_MODE_QUERY_KEY = "splitPaymentMode";
const SELF_REMOVE_SUCCESS_NOTICE = "Вы вышли из игры. 1 посещение вернули в абонемент.";
const SELF_REMOVE_PENDING_NOTICE =
  "Бронирование отменено, обновляем состав игры. Это может занять несколько минут.";

function parseSplitPaymentMode(
  value: string | null | undefined,
): "subscription" | "one_time" | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "subscription") return "subscription";
  if (normalized === "one_time") return "one_time";
  return null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeComparableId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

async function resolveSubscriptionDailyLimitCandidate(
  subscription: Subscription | null,
  phone: string | null | undefined,
): Promise<unknown> {
  if (!subscription) return null;

  const subscriptionId = String(subscription.subscriptionId || "").trim();
  let resolvedName: string | null = null;

  if (subscriptionId && phone) {
    try {
      const response = await apiFetchSubscriptioName(subscriptionId, phone);
      resolvedName = String(response.data?.sertName || "").trim() || null;
    } catch {
      resolvedName = null;
    }
  }

  return withSubscriptionCategoryDailyLimitResolvedName(subscription, resolvedName);
}

function parseBookingIdsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(
      value
        .map((item) => normalizeComparableId(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  if (typeof value === "string") {
    return Array.from(new Set(
      value
        .split(",")
        .map((item) => normalizeComparableId(item))
        .filter((item): item is string => Boolean(item)),
    ));
  }
  return [];
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

function isSinglesGame(game: PadelGameRecord): boolean {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  if (isSinglesFormat(metadata?.gameFormat ?? metadata?.format)) return true;
  const splitPayment = resolveSplitPaymentMetadata(game);
  const splitShareCount = toFiniteNumber(splitPayment?.shareCount);
  if (splitShareCount === 2) return true;
  return [
    game.booking?.roomName,
    metadata?.roomName,
    metadata?.courtName,
    metadata?.courtTitle,
  ].some((value) => isSinglesCourtName(value));
}

function isSplitPaymentInactiveStatus(statusRaw: unknown): boolean {
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

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function resolveSplitPaymentItemDeadlineAt(
  item: Record<string, unknown>,
  splitPayment: Record<string, unknown> | null,
): string | null {
  const directDeadline = typeof item.deadlineAt === "string" ? item.deadlineAt : null;
  if (directDeadline && directDeadline.trim()) return directDeadline.trim();
  const directExpires = typeof item.expiresAt === "string" ? item.expiresAt : null;
  if (directExpires && directExpires.trim()) return directExpires.trim();
  const splitDeadline = typeof splitPayment?.deadlineAt === "string" ? splitPayment.deadlineAt : null;
  if (splitDeadline && splitDeadline.trim()) return splitDeadline.trim();
  return null;
}

function isSplitPaymentPendingExpired(
  item: Record<string, unknown>,
  splitPayment: Record<string, unknown> | null,
  nowTs = Date.now(),
): boolean {
  const status = String(item.status || "").trim().toUpperCase();
  if (status !== "PAYMENT_PENDING") return false;
  const deadlineTs = parseIsoTimestamp(resolveSplitPaymentItemDeadlineAt(item, splitPayment));
  return deadlineTs != null && nowTs >= deadlineTs;
}

function resolveSplitPaymentJoinDecision(statusRaw: unknown): JoinDecision {
  const status = String(statusRaw || "").trim().toUpperCase();
  if (!status) return "WAITLIST";
  if (
    status.includes("PAID")
    || status.includes("JOIN")
    || status.includes("CONFIRM")
    || status.includes("SUCCESS")
    || status.includes("COMPLETE")
  ) {
    return "JOINED";
  }
  return "WAITLIST";
}

function playerMatchesProfileIdentity(
  player: PadelGamePlayer | null | undefined,
  profileId: string | null,
  profilePhone: string | null,
): boolean {
  if (!player) return false;
  const playerId = normalizeComparableId(player.id);
  if (profileId && playerId && profileId === playerId) return true;
  const playerPhone = normalizePhone(player.phone);
  if (profilePhone && playerPhone && profilePhone === playerPhone) return true;
  return false;
}

function toDateLabel(dateValue: string | null | undefined): string {
  if (!dateValue) return "Дата не указана";
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "Дата не указана";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

function dedupePlayers(players: PadelGamePlayer[]): PadelGamePlayer[] {
  const map = new Map<string, PadelGamePlayer>();
  players.forEach((player, index) => {
    const phoneKey = normalizePhone(player.phone);
    const idKey = player.id?.trim() || "";
    const key = phoneKey || idKey || `idx-${index}`;
    map.set(key, player);
  });
  return Array.from(map.values());
}

function removePlayer(players: PadelGamePlayer[], phoneNorm: string, userId: string | null): PadelGamePlayer[] {
  const normalizedUserId = normalizeComparableId(userId);
  return players.filter((player) => {
    const playerPhone = normalizePhone(player.phone);
    if (playerPhone && playerPhone === phoneNorm) return false;
    const playerId = normalizeComparableId(player.id);
    if (normalizedUserId && playerId && playerId === normalizedUserId) return false;
    return true;
  });
}

function buildMyPlayer(profile: UserProfileType): PadelGamePlayer {
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
  const explicitGrade = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
  const numeric = parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));

  return {
    id: profile.id ?? null,
    name: fullName || "Игрок",
    phone: profile.phone ?? null,
    photo: profile.photo ?? null,
    rating: explicitGrade ?? (numeric != null ? getLetterGrade(numeric) : null),
    ratingNumeric: numeric,
    source: "INVITE_LINK",
    status: "CONFIRMED",
  };
}

function resolveMyDecision(game: PadelGameRecord | null, profile: UserProfileType | null): JoinDecision {
  if (!game || !profile) return "NONE";
  const myPhone = normalizePhone(profile.phone);
  const myId = normalizeComparableId(profile.id);
  if (!myPhone && !myId) return "NONE";

  const inParticipants = (game.participants ?? []).some(
    (player) => playerMatchesProfileIdentity(player, myId, myPhone),
  );
  if (inParticipants) return "JOINED";

  const inWaitlist = (game.waitlist ?? []).some(
    (player) => playerMatchesProfileIdentity(player, myId, myPhone),
  );
  if (inWaitlist) return "WAITLIST";

  const splitPayment = resolveSplitPaymentMetadata(game);
  const splitPayments = Array.isArray(splitPayment?.payments) ? splitPayment.payments : [];
  for (const item of splitPayments) {
    if (!isRecord(item)) continue;
    if (isSplitPaymentPendingExpired(item, splitPayment)) continue;
    const itemId = normalizeComparableId(item.clientId);
    const itemPhone = normalizePhone(
      typeof item.phoneNorm === "string"
        ? item.phoneNorm
        : (typeof item.phone === "string" ? item.phone : null),
    );
    const matchesById = Boolean(myId && itemId && myId === itemId);
    const matchesByPhone = Boolean(myPhone && itemPhone && myPhone === itemPhone);
    if (!matchesById && !matchesByPhone) continue;
    if (isSplitPaymentInactiveStatus(item.status)) continue;
    return resolveSplitPaymentJoinDecision(item.status);
  }

  const metadata = game.metadata;
  if (myPhone && isRecord(metadata) && isRecord(metadata.joinResponses) && isRecord(metadata.joinResponses[myPhone])) {
    const status = String((metadata.joinResponses[myPhone] as Record<string, unknown>).status || "").toUpperCase();
    if (status.includes("DECLIN")) return "DECLINED";
  }

  return "NONE";
}

function resolveMaxPlayers(game: PadelGameRecord): number {
  if (isSinglesGame(game)) return DEFAULT_SINGLES_MAX_PLAYERS;

  const inviteLimit = game.invite?.maxPlayers;
  if (typeof inviteLimit === "number" && Number.isFinite(inviteLimit) && inviteLimit > 0) {
    return Math.floor(inviteLimit);
  }

  const metadata = game.metadata;
  if (isRecord(metadata)) {
    const fromMeta = toFiniteNumber(metadata.maxPlayers ?? metadata.playersLimit);
    if (fromMeta !== null && fromMeta > 0) {
      return Math.floor(fromMeta);
    }
    if (isSinglesFormat(metadata.gameFormat ?? metadata.format)) return DEFAULT_SINGLES_MAX_PLAYERS;
  }

  return DEFAULT_MAX_PLAYERS;
}

function resolveWaitlistEnabled(game: PadelGameRecord): boolean {
  if (typeof game.invite?.waitlistEnabled === "boolean") {
    return game.invite.waitlistEnabled;
  }
  const metadata = game.metadata;
  if (isRecord(metadata) && typeof metadata.waitlistEnabled === "boolean") {
    return metadata.waitlistEnabled;
  }
  return true;
}

function resolveSplitPaymentMetadata(game: PadelGameRecord | null): Record<string, unknown> | null {
  if (!game || !isRecord(game.metadata)) return null;
  const splitPayment = game.metadata.splitPayment;
  return isRecord(splitPayment) ? splitPayment : null;
}

function hasSplitPaymentSignal(splitPayment: Record<string, unknown> | null): boolean {
  if (!splitPayment) return false;
  if (splitPayment.enabled === true) return true;
  if (splitPayment.enabled === false) return false;

  const mode = typeof splitPayment.mode === "string" ? splitPayment.mode.trim().toLowerCase() : "";
  if (mode.includes("split") || mode.includes("group")) return true;

  const payments = Array.isArray(splitPayment.payments) ? splitPayment.payments : [];
  if (payments.some((item) => isRecord(item))) return true;

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

function isSplitPaymentGame(game: PadelGameRecord | null): boolean {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;
  const splitPayment = resolveSplitPaymentMetadata(game);
  return hasSplitPaymentSignal(splitPayment);
}

function getSplitShareAmount(game: PadelGameRecord | null): number | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const value = splitPayment?.shareAmount;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getSplitShareCount(game: PadelGameRecord | null): number | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const value = splitPayment?.shareCount;
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return null;
}

function resolveGameExerciseId(game: PadelGameRecord | null): string | null {
  if (!game) return null;
  const booking = isRecord(game.booking) ? game.booking : null;
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const splitPayment = metadata && isRecord(metadata.splitPayment) ? metadata.splitPayment : null;

  return (
    normalizeComparableId(booking?.vivaExerciseId) ??
    normalizeComparableId(booking?.exerciseId) ??
    normalizeComparableId(metadata?.vivaExerciseId) ??
    normalizeComparableId(metadata?.exerciseId) ??
    normalizeComparableId(metadata?.viva_exercise_id) ??
    normalizeComparableId(metadata?.exercise_id) ??
    normalizeComparableId(splitPayment?.vivaExerciseId) ??
    normalizeComparableId(splitPayment?.exerciseId) ??
    normalizeComparableId(splitPayment?.viva_exercise_id) ??
    normalizeComparableId(splitPayment?.exercise_id) ??
    null
  );
}

function extractExerciseBookingRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const keys = ["payload", "content", "data", "result", "items", "records", "participants", "bookings"];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function normalizeVivaBookingParticipant(raw: unknown): PadelGamePlayer | null {
  if (!isRecord(raw)) return null;
  if (raw.isCancelled === true || raw.cancelled === true || raw.canceled === true) return null;

  const client = isRecord(raw.client) ? raw.client : null;
  const id = normalizeComparableId(client?.id) ?? normalizeComparableId(raw.clientId) ?? null;
  const phone = normalizePhone(
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

function resolveGameLeaveEvents(game: PadelGameRecord | null): RosterSyncLeaveEvent[] {
  if (!game || !isRecord(game.metadata)) return [];
  const sources = [
    game.metadata.leaveEvents,
    game.metadata.playerLeaveEvents,
    game.metadata.leftPlayers,
  ];
  for (const source of sources) {
    if (Array.isArray(source)) {
      return source as RosterSyncLeaveEvent[];
    }
  }
  return [];
}

function arePlayersEqualByIdentity(left: PadelGamePlayer[], right: PadelGamePlayer[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((player, index) => playersShareRosterIdentity(player, right[index]));
}

function findMySplitPayment(game: PadelGameRecord, profile: UserProfileType): Record<string, unknown> | null {
  const splitPayment = resolveSplitPaymentMetadata(game);
  const payments = Array.isArray(splitPayment?.payments) ? splitPayment.payments : [];
  const myPhone = normalizePhone(profile.phone);
  const myId = normalizeComparableId(profile.id);

  for (const item of payments) {
    if (!isRecord(item)) continue;
    if (isSplitPaymentInactiveStatus(item.status)) continue;
    if (isSplitPaymentPendingExpired(item, splitPayment)) continue;
    const itemPhone = normalizePhone(
      typeof item.phoneNorm === "string"
        ? item.phoneNorm
        : (typeof item.phone === "string" ? item.phone : null),
    );
    const itemId = normalizeComparableId(item.clientId);
    if (myPhone && itemPhone === myPhone) return item;
    if (myId && itemId === myId) return item;
  }

  return null;
}

function buildCurrentJoinUrl(extraParams: Record<string, string>): string | null {
  if (typeof window === "undefined") return null;
  try {
    const url = new URL(window.location.href);
    Object.entries(extraParams).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
    return url.toString();
  } catch {
    return window.location.href || null;
  }
}

function generatePaymentRef(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanSplitJoinQuery(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
    url.searchParams.delete(SPLIT_JOIN_QUERY_KEY);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    // ignore history cleanup failures
  }
}

function mergeRecord(base: PadelGameRecord, incoming: PadelGameRecord): PadelGameRecord {
  return {
    ...base,
    ...incoming,
    organizer: incoming.organizer ?? base.organizer ?? null,
    participants: incoming.participants ?? base.participants ?? [],
    waitlist: incoming.waitlist ?? base.waitlist ?? [],
    invite: incoming.invite ?? base.invite ?? null,
    booking: incoming.booking ?? base.booking ?? null,
    payment: incoming.payment ?? base.payment ?? null,
    metadata: incoming.metadata ?? base.metadata ?? null,
  };
}

function resolveGameOrganizerPlayer(game: PadelGameRecord | null | undefined): PadelGamePlayer | null {
  if (!game) return null;

  if (game.organizer) {
    return {
      id: game.organizer.id ?? null,
      name: game.organizer.name || "Организатор",
      phone: game.organizer.phone ?? null,
      photo: game.organizer.photo ?? null,
      rating: game.organizer.rating ?? null,
      ratingNumeric: game.organizer.ratingNumeric ?? null,
      source: "ORGANIZER",
      status: "CONFIRMED",
    };
  }

  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const metadataOrganizerId = typeof metadata?.organizerId === "string" ? metadata.organizerId : null;
  const metadataOrganizerPhone =
    typeof metadata?.organizerPhoneNorm === "string"
      ? metadata.organizerPhoneNorm
      : (typeof metadata?.organizerPhone === "string" ? metadata.organizerPhone : null);
  if (metadataOrganizerId || metadataOrganizerPhone) {
    const organizerFromParticipants = (game.participants ?? []).find((player) => playersShareRosterIdentity(
      {
        id: metadataOrganizerId,
        phone: metadataOrganizerPhone,
        name: "Организатор",
      },
      player,
    ));
    if (organizerFromParticipants) {
      return {
        ...organizerFromParticipants,
        source: "ORGANIZER",
        status: "CONFIRMED",
      };
    }

    return {
      id: metadataOrganizerId,
      name: "Организатор",
      phone: metadataOrganizerPhone,
      photo: null,
      rating: null,
      ratingNumeric: null,
      source: "ORGANIZER",
      status: "CONFIRMED",
    };
  }

  return (game.participants ?? []).find((player) => String(player.source || "").trim().toUpperCase() === "ORGANIZER")
    ?? null;
}

function notifyGameRecordUpdated(record: PadelGameRecord | null | undefined, source: string): void {
  if (typeof window === "undefined" || !record?.id) return;
  window.dispatchEvent(new CustomEvent("lk-games-updated", {
    detail: {
      records: [record],
      source,
    },
  }));
}

function resolveInviteCabinetUrl(value: string | null | undefined): string {
  const fallback = (DEFAULT_CABINET_URL || "").trim();
  const raw = (value || "").trim();
  if (!raw) return fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback;

  try {
    return appendCurrentAuthModeToNavigableUrl(
      new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined),
    ).toString();
  } catch {
    return raw || (fallback ? appendCurrentAuthModeToNavigableUrl(fallback).toString() : fallback);
  }
}

function buildCabinetGameUrl(cabinetUrl: string | null | undefined, gameId: string): string {
  const targetUrl = resolveInviteCabinetUrl(cabinetUrl);

  try {
    const parsed = new URL(targetUrl, window.location.origin);
    parsed.searchParams.set(OPEN_GAME_QUERY_KEY, gameId);
    return appendCurrentAuthModeToNavigableUrl(parsed).toString();
  } catch {
    const join = targetUrl.includes("?") ? "&" : "?";
    return appendCurrentAuthModeToNavigableUrl(
      `${targetUrl}${join}${OPEN_GAME_QUERY_KEY}=${encodeURIComponent(gameId)}`,
    ).toString();
  }
}

function buildCabinetHomeUrl(cabinetUrl: string | null | undefined): string {
  return resolveInviteCabinetUrl(cabinetUrl);
}

export default function GameJoinPage({ gameId, cabinetUrl = DEFAULT_CABINET_URL }: GameJoinPageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [game, setGame] = useState<PadelGameRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<"join" | "decline" | null>(null);
  const [confirmingSplitPaymentRef, setConfirmingSplitPaymentRef] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const preferredSplitPaymentMode = useMemo(() => {
    if (typeof window === "undefined") return null;
    try {
      const url = new URL(window.location.href);
      return parseSplitPaymentMode(url.searchParams.get(SPLIT_PAYMENT_MODE_QUERY_KEY));
    } catch {
      return null;
    }
  }, []);

  const loadData = useCallback(async () => {
    const normalizedGameId = gameId.trim();
    if (!normalizedGameId) {
      setError("Не передан идентификатор игры");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [profileResult, gameResult] = await Promise.all([
      apiFetchProfile(),
      apiFetchPadelGameRecord(normalizedGameId),
    ]);

    if (profileResult.data) {
      setProfile(profileResult.data);
    }

    if (gameResult.data) {
      setGame(gameResult.data);
    } else {
      setError(gameResult.error?.message || "Игра не найдена");
    }

    setLoading(false);
  }, [gameId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    if (!game || !profile) return;

    const exerciseId = resolveGameExerciseId(game);
    if (!exerciseId) return;

    const sourceParticipants = dedupePlayers(game.participants ?? []);
    const leaveEvents = resolveGameLeaveEvents(game);
    const maxPlayers = resolveMaxPlayers(game);
    const splitPaymentGame = isSplitPaymentGame(game);
    const organizerPlayer = resolveGameOrganizerPlayer(game);

    if (splitPaymentGame && shouldSkipRecentSplitGameRosterSync({
      record: game,
      isSplitPaymentGame: true,
      sourceParticipantsCount: sourceParticipants.length,
      leaveEventsCount: leaveEvents.length,
    })) {
      return;
    }

    let alive = true;
    void apiFetchTournamentParticipants(exerciseId, { sanitize: false })
      .then((result) => {
        if (!alive || !result.data) return;

        const vivaPlayers = extractExerciseBookingRows(result.data)
          .map((item) => normalizeVivaBookingParticipant(item))
          .filter((item): item is PadelGamePlayer => item !== null)
          .filter((item) => item.status !== "WAITLIST");
        if (vivaPlayers.length === 0) return;

        const reconciliation = reconcileRosterWithViva({
          sourceParticipants,
          vivaParticipants: vivaPlayers,
          leaveEvents,
          organizerPlayer,
        });
        const mergedParticipants = dedupePlayers(reconciliation.mergedCandidates).slice(0, maxPlayers);
        const nextWaitlist = excludePlayersAlreadyInRoster(
          dedupePlayers(game.waitlist ?? []),
          mergedParticipants,
        );
        const participantsChanged = !arePlayersEqualByIdentity(mergedParticipants, sourceParticipants);
        const waitlistChanged = !arePlayersEqualByIdentity(nextWaitlist, game.waitlist ?? []);
        const leaveEventsChanged = reconciliation.staleLeaveEventsRemoved > 0;
        if (!participantsChanged && !waitlistChanged && !leaveEventsChanged) return;

        const nextMetadata: Record<string, unknown> | null = leaveEventsChanged
          ? {
            ...(isRecord(game.metadata) ? game.metadata : {}),
            leaveEvents: reconciliation.nextLeaveEvents,
            lastLeaveUpdateAt: new Date().toISOString(),
          }
          : null;

        void apiUpdatePadelGameRecord(game.id, {
          expectedUpdatedAt: game.updatedAt ?? null,
          participants: mergedParticipants,
          ...(waitlistChanged ? { waitlist: nextWaitlist } : {}),
          ...(nextMetadata ? { metadata: nextMetadata } : {}),
        }).then(async (patchResult) => {
          if (!alive) return;
          const patchedRecord = patchResult.data;
          if (patchedRecord?.id) {
            setGame((prev) => (prev ? mergeRecord(prev, patchedRecord) : patchedRecord));
            return;
          }
          const authoritative = await apiFetchPadelGameRecord(game.id);
          if (!alive || !authoritative.data?.id) return;
          setGame((prev) => (prev
            ? mergeRecord(prev, authoritative.data as PadelGameRecord)
            : authoritative.data));
        });
      })
      .catch(() => {
        // Ignore sync errors: the page falls back to the stored game snapshot.
      });

    return () => {
      alive = false;
    };
  }, [game, profile]);

  const myDecision = useMemo(() => resolveMyDecision(game, profile), [game, profile]);
  const statusLabel = useMemo(() => {
    switch (myDecision) {
      case "JOINED":
        return "Вы в составе игры";
      case "WAITLIST":
        return isSplitPaymentGame(game) ? "Ожидается оплата участия" : "Вы в листе ожидания";
      case "DECLINED":
        return "Вы отказались от игры";
      default:
        return "Вы пока не присоединились";
    }
  }, [game, myDecision]);

  const confirmSplitJoinPayment = useCallback(
    async (paymentRef: string) => {
      if (!game || !profile || !isSplitPaymentGame(game)) return;

      const myPhoneNorm = normalizePhone(profile.phone);
      if (!myPhoneNorm) {
        setDecisionError("В профиле отсутствует номер телефона");
        return;
      }

      setConfirmingSplitPaymentRef(paymentRef);
      setDecisionError(null);

      const freshRecordResult = await apiFetchPadelGameRecord(game.id);
      const actualGame = freshRecordResult.data ?? game;
      const myPlayer = buildMyPlayer(profile);
      let participants = dedupePlayers(actualGame.participants ?? []);
      let waitlist = dedupePlayers(actualGame.waitlist ?? []);
      const maxPlayers = resolveMaxPlayers(actualGame);

      participants = removePlayer(participants, myPhoneNorm, profile.id ?? null);
      waitlist = removePlayer(waitlist, myPhoneNorm, profile.id ?? null);

      if (participants.length < maxPlayers) {
        participants.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "CONFIRMED",
        });
      } else {
        waitlist.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "WAITLIST",
        });
      }

      const nowIso = new Date().toISOString();
      const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
        ? { ...actualGame.metadata }
        : {};
      const splitPaymentMeta = resolveSplitPaymentMetadata(actualGame) ?? {};
      const currentPayments = Array.isArray(splitPaymentMeta.payments)
        ? splitPaymentMeta.payments.filter((item) => isRecord(item))
        : [];
      const currentSplitBookingIds = parseBookingIdsFromUnknown(splitPaymentMeta.bookingIds);
      const currentMetadataBookingIds = parseBookingIdsFromUnknown(metadata.bookingIds);
      metadata.splitPayment = {
        ...splitPaymentMeta,
        enabled: true,
        status: "ACTIVE",
        payments: currentPayments.map((item) => {
          const itemRef = typeof item.paymentRef === "string" ? item.paymentRef.trim() : "";
          const itemPhone = normalizePhone(
            typeof item.phoneNorm === "string"
              ? item.phoneNorm
              : (typeof item.phone === "string" ? item.phone : null),
          );
          if (itemRef !== paymentRef && itemPhone !== myPhoneNorm) return item;
          return {
            ...item,
            status: "PAID",
            paidAt: nowIso,
          };
        }),
      };
      metadata.bookingIds = Array.from(new Set([
        ...currentMetadataBookingIds,
        ...currentSplitBookingIds,
      ]));

      const joinResponses = isRecord(metadata.joinResponses)
        ? { ...metadata.joinResponses as Record<string, unknown> }
        : {};
      joinResponses[myPhoneNorm] = {
        status: "JOINED",
        updatedAt: nowIso,
        playerName: myPlayer.name,
        playerId: myPlayer.id ?? null,
        paymentRef,
      };
      metadata.joinResponses = joinResponses;
      metadata.lastJoinUpdateAt = nowIso;

      const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
        expectedUpdatedAt: actualGame.updatedAt ?? null,
        participants,
        waitlist,
        metadata,
      });

      if (updateResult.error) {
        setConfirmingSplitPaymentRef(null);
        setDecisionError(updateResult.error.message || "Не удалось подтвердить оплату участия");
        return;
      }

      notifyGameRecordUpdated(
        updateResult.data ?? {
          ...actualGame,
          participants,
          waitlist,
          metadata,
        },
        "game_join_split_confirmed",
      );

      cleanSplitJoinQuery();
      setConfirmingSplitPaymentRef(null);
      window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
    },
    [cabinetUrl, game, profile],
  );

  useEffect(() => {
    if (!game || !profile || confirmingSplitPaymentRef) return;
    if (typeof window === "undefined") return;

    try {
      const url = new URL(window.location.href);
      const splitJoin = url.searchParams.get(SPLIT_JOIN_QUERY_KEY);
      const paymentRef = url.searchParams.get(PAYMENT_REF_QUERY_KEY)?.trim() || "";
      if (splitJoin === "paid" && paymentRef) {
        void confirmSplitJoinPayment(paymentRef);
      }
    } catch {
      // ignore malformed callback URL
    }
  }, [confirmSplitJoinPayment, confirmingSplitPaymentRef, game, profile]);

  const applyDecision = useCallback(
    async (
      target: "join" | "decline",
      explicitSplitPaymentMode?: "subscription" | "one_time",
    ) => {
      if (!game || !profile) {
        setDecisionError("Не удалось определить профиль или игру");
        return;
      }

      const myPhoneNorm = normalizePhone(profile.phone);
      if (!myPhoneNorm) {
        setDecisionError("В профиле отсутствует номер телефона");
        return;
      }

      setSubmitting(target);
      setDecisionError(null);

      const freshRecordResult = await apiFetchPadelGameRecord(game.id);
      const actualGame = freshRecordResult.data ?? game;

      if (target === "decline") {
        const leaveResult = await apiLeavePadelGameAsCurrentUser(actualGame.id);
        setSubmitting(null);
        if (leaveResult.error || !leaveResult.data) {
          setDecisionError(leaveResult.error?.message || "Не удалось покинуть игру");
          return;
        }
        if (leaveResult.data.state === "RETRY_REQUIRED" || leaveResult.data.state === "IN_PROGRESS") {
          pushCabinetFlashNotice(leaveResult.data.message || SELF_REMOVE_PENDING_NOTICE);
          window.location.href = buildCabinetHomeUrl(cabinetUrl);
          return;
        }
        if (leaveResult.data.state !== "DONE") {
          setDecisionError(leaveResult.data.message || "Не удалось подтвердить выход из игры");
          return;
        }
        pushCabinetFlashNotice(leaveResult.data.message || SELF_REMOVE_SUCCESS_NOTICE);
        window.location.href = buildCabinetHomeUrl(cabinetUrl);
        return;
      }

      const existingSplitPayment = isSplitPaymentGame(actualGame)
        ? findMySplitPayment(actualGame, profile)
        : null;
      if (existingSplitPayment && !isSplitPaymentInactiveStatus(existingSplitPayment.status)) {
        const existingPaymentStatus = String(existingSplitPayment.status || "").trim().toUpperCase();
        const existingPaymentUrl = typeof existingSplitPayment.paymentUrl === "string"
          ? existingSplitPayment.paymentUrl.trim()
          : "";
        setSubmitting(null);
        if (existingPaymentStatus === "PAYMENT_PENDING" && existingPaymentUrl) {
          window.location.href = existingPaymentUrl;
          return;
        }
        window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
        return;
      }

      const existingJoinDecision = resolveMyDecision(actualGame, profile);
      if (existingJoinDecision === "JOINED" || existingJoinDecision === "WAITLIST") {
        setSubmitting(null);
        window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
        return;
      }

      const myPlayer = buildMyPlayer(profile);
      let participants = dedupePlayers(actualGame.participants ?? []);
      let waitlist = dedupePlayers(actualGame.waitlist ?? []);
      const exerciseId = resolveGameExerciseId(actualGame);

      participants = removePlayer(participants, myPhoneNorm, profile.id ?? null);
      waitlist = removePlayer(waitlist, myPhoneNorm, profile.id ?? null);

      const maxPlayers = resolveMaxPlayers(actualGame);
      const waitlistEnabled = resolveWaitlistEnabled(actualGame);
      let appliedStatus: JoinDecision = "NONE";

      if (isSplitPaymentGame(actualGame)) {
        const existingPayment = findMySplitPayment(actualGame, profile);
        const existingPaymentStatus = String(existingPayment?.status || "").trim().toUpperCase();
        const existingPaymentUrl =
          typeof existingPayment?.paymentUrl === "string" ? existingPayment.paymentUrl.trim() : "";

        if (existingPaymentStatus === "PAYMENT_PENDING" && existingPaymentUrl) {
          setSubmitting(null);
          window.location.href = existingPaymentUrl;
          return;
        }

        const booking = actualGame.booking;
        const bookingDate = booking?.date?.trim() || "";
        const bookingFromTime = booking?.timeFrom?.trim() || "";
        const bookingToTime = booking?.timeTo?.trim() || "";
        const bookingStudioId = booking?.studioId?.trim() || "";
        const bookingRoomId = booking?.roomId?.trim() || "";
        const bookingDurationMinutes = typeof booking?.durationMinutes === "number" && Number.isFinite(booking.durationMinutes)
          ? booking.durationMinutes
          : null;
        const shareCountRaw = getSplitShareCount(actualGame);
        const fallbackShareCount = resolveMaxPlayers(actualGame) <= DEFAULT_SINGLES_MAX_PLAYERS ? 2 : 4;
        const shareCount = shareCountRaw === 2 || fallbackShareCount === 2 ? 2 : 4;
        const shareAmount = getSplitShareAmount(actualGame) ?? (shareCount === 2 ? 5000 : 2500);
        const paymentRef = generatePaymentRef();
        const successUrl = buildCurrentJoinUrl({
          [PAYMENT_REF_QUERY_KEY]: paymentRef,
          [SPLIT_JOIN_QUERY_KEY]: "paid",
        });
        const splitPaymentMeta = resolveSplitPaymentMetadata(actualGame) ?? {};
        const splitPaymentTotalAmount = (() => {
          const value = splitPaymentMeta.totalAmount;
          if (typeof value === "number" && Number.isFinite(value)) return value;
          if (typeof value === "string") {
            const parsed = Number(value.trim().replace(",", "."));
            return Number.isFinite(parsed) ? parsed : null;
          }
          return null;
        })();
        const splitPaymentOneTimeBaseAmount = (() => {
          const value = splitPaymentMeta.oneTimeBaseAmount ?? splitPaymentMeta.baseShareAmount;
          if (typeof value === "number" && Number.isFinite(value)) return value;
          if (typeof value === "string") {
            const parsed = Number(value.trim().replace(",", "."));
            return Number.isFinite(parsed) ? parsed : null;
          }
          return null;
        })();
        const currentPayments = Array.isArray(splitPaymentMeta.payments)
          ? splitPaymentMeta.payments.filter((item) => isRecord(item))
          : [];
        const usedSpots = new Set<number>(
          currentPayments
            .map((item) => (typeof item.spot === "number" && Number.isFinite(item.spot) ? Math.floor(item.spot) : null))
            .filter((item): item is number => item !== null && item > 0),
        );
        let nextSpot: number | null = null;
        for (let candidate = 1; candidate <= Math.max(maxPlayers, shareCount); candidate += 1) {
          if (!usedSpots.has(candidate)) {
            nextSpot = candidate;
            break;
          }
        }

        if (!bookingDate || !bookingFromTime || !bookingToTime || !bookingStudioId || !bookingRoomId) {
          setSubmitting(null);
          setDecisionError("В игре нет данных для оплаты участия");
          return;
        }
        if (!exerciseId) {
          setSubmitting(null);
          setDecisionError("В игре отсутствует exerciseId для оплаты участия");
          return;
        }

        const resolvedPaymentMode = explicitSplitPaymentMode ?? preferredSplitPaymentMode ?? "one_time";
        let subscriptionCandidates: Subscription[] = [];
        let compatibleSubscriptionCandidates: Subscription[] = [];
        let eligibleSubscriptionCandidates: Subscription[] = [];
        let resolvedClientSubscriptionId: string | null = null;
        if (resolvedPaymentMode === "subscription") {
          const subscriptionsResult = await apiFetchSubscriptions();
          if (subscriptionsResult.error) {
            setSubmitting(null);
            setDecisionError(subscriptionsResult.error.message || "Не удалось проверить абонемент");
            return;
          }

          subscriptionCandidates = Array.isArray(subscriptionsResult.data?.content)
            ? subscriptionsResult.data.content
            : [];
          const requiredVisits = bookingDurationMinutes != null && bookingDurationMinutes >= 90
            ? 2
            : 1;
          const requiredExerciseTypeIds = buildSplitComparableIdSet([SPLIT_OPEN_GAME_EXERCISE_TYPE_ID]);
          const requiredDirectionIds = buildSplitComparableIdSet([SPLIT_OPEN_GAME_DIRECTION_ID]);
          compatibleSubscriptionCandidates = filterSplitCategoryCompatibleSubscriptions(
            subscriptionCandidates,
            requiredExerciseTypeIds,
            requiredDirectionIds,
            bookingStudioId,
          );
          eligibleSubscriptionCandidates = filterSplitEligibleSubscriptions(
            subscriptionCandidates,
            requiredExerciseTypeIds,
            requiredDirectionIds,
            bookingStudioId,
            requiredVisits,
            bookingDurationMinutes,
            bookingDate,
          );
          resolvedClientSubscriptionId = String(eligibleSubscriptionCandidates[0]?.subscriptionId || "").trim() || null;
          const resolvedSubscriptionCandidate = eligibleSubscriptionCandidates[0] ?? null;
          const subscriptionDateMessage = resolveSplitSubscriptionUnavailableMessage({
            subscriptions: compatibleSubscriptionCandidates,
            gameDate: bookingDate,
            requiredVisits,
            requiredDurationMinutes: bookingDurationMinutes,
          });
          if (subscriptionDateMessage) {
            setSubmitting(null);
            setDecisionError(subscriptionDateMessage);
            return;
          }
          const dailyLimitSubscriptionCandidate = await resolveSubscriptionDailyLimitCandidate(
            resolvedSubscriptionCandidate,
            profile.phone,
          );
          if (subscriptionPlanAllowsDailyLimitCategory(
            dailyLimitSubscriptionCandidate,
            SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
          )) {
            const dailyLimitBookingsResult = await apiFetchSubscriptionDailyLimitBookings({ size: 1000 });
            if (dailyLimitBookingsResult.error) {
              setSubmitting(null);
              setDecisionError("Не удалось проверить дневной лимит абонемента");
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
              setSubmitting(null);
              setDecisionError(dailyLimitConflict.message);
              return;
            }
          }
        }
        const paymentResult = await apiCreatePadelSplitParticipantPayment(actualGame.id, {
          date: bookingDate,
          fromTime: bookingFromTime,
          toTime: bookingToTime,
          exerciseId,
          studioId: bookingStudioId,
          roomId: bookingRoomId,
          clientId: profile.id ?? null,
          clientPhone: profile.phone ?? null,
          paymentRef,
          paymentMode: resolvedPaymentMode,
          clientSubscriptionId: resolvedClientSubscriptionId,
          baseRedirectUrl: successUrl,
          successUrl,
          failUrl: successUrl,
          shareCount,
          shareAmount,
          totalAmount: splitPaymentTotalAmount,
          oneTimeBaseAmount: splitPaymentOneTimeBaseAmount,
          shareAmountIncludesDuration: true,
          durationMinutes: bookingDurationMinutes,
          maxClientsCount: Math.max(maxPlayers, shareCount),
          spot: nextSpot,
          paymentDeadlineMinutes: SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES,
        });

        if (paymentResult.error || !paymentResult.data) {
          setSubmitting(null);
          const dailyLimitMessage = resolvedPaymentMode === "subscription"
            ? resolveSubscriptionCategoryDailyLimitErrorMessage(paymentResult.error)
            : null;
          if (dailyLimitMessage) {
            setDecisionError(dailyLimitMessage);
          } else if (resolvedPaymentMode === "subscription" && isNoSubscriptionsAvailableError(paymentResult.error)) {
            setDecisionError(
              resolveSplitSubscriptionUnavailableMessage({
                subscriptions: compatibleSubscriptionCandidates.length > 0
                  ? compatibleSubscriptionCandidates
                  : subscriptionCandidates,
                gameDate: bookingDate,
                requiredVisits: bookingDurationMinutes != null && bookingDurationMinutes >= 90
                  ? 2
                  : 1,
                requiredDurationMinutes: bookingDurationMinutes,
              }) || paymentResult.error?.message || "Не удалось создать оплату участия",
            );
          } else {
            setDecisionError(paymentResult.error?.message || "Не удалось создать оплату участия");
          }
          return;
        }

        const isPaidWithoutRedirect = !paymentResult.data.paymentUrl && paymentResult.data.toPay <= 0;
        if (!paymentResult.data.paymentUrl && !isPaidWithoutRedirect) {
          setSubmitting(null);
          setDecisionError("Не удалось получить ссылку на оплату участия");
          return;
        }

        const nowIso = new Date().toISOString();
        const resolvedPaymentDeadlineAt = paymentResult.data.deadlineAt
          ?? new Date(Date.now() + SPLIT_PARTICIPANT_PAYMENT_DEADLINE_MINUTES * 60 * 1000).toISOString();
        const paymentStatus = isPaidWithoutRedirect ? "PAID" : "PAYMENT_PENDING";
        if (isPaidWithoutRedirect && participants.length < maxPlayers) {
          participants.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "CONFIRMED",
          });
          appliedStatus = "JOINED";
        } else {
          waitlist.push({
            ...myPlayer,
            source: "INVITE_LINK",
            status: "PENDING",
          });
          appliedStatus = "WAITLIST";
        }

        const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
          ? { ...actualGame.metadata }
          : {};
        const currentMetadataBookingIds = parseBookingIdsFromUnknown(metadata.bookingIds);
        const joinResponses = isRecord(metadata.joinResponses)
          ? { ...metadata.joinResponses as Record<string, unknown> }
          : {};
        joinResponses[myPhoneNorm] = {
          status: paymentStatus,
          comment: comment.trim() || null,
          updatedAt: nowIso,
          playerName: myPlayer.name,
          playerId: myPlayer.id ?? null,
          paymentRef,
        };
        metadata.joinResponses = joinResponses;
        metadata.lastJoinUpdateAt = nowIso;
        metadata.splitPayment = {
          ...splitPaymentMeta,
          enabled: true,
          status: "ACTIVE",
          shareCount,
          shareAmount,
          bookingIds: [
            ...new Set([
              ...(Array.isArray(splitPaymentMeta.bookingIds) ? splitPaymentMeta.bookingIds : []),
              paymentResult.data.bookingId,
            ].filter(Boolean)),
          ],
          payments: [
            ...currentPayments.filter((item) => {
              const itemPhone = normalizePhone(
                typeof item.phoneNorm === "string"
                  ? item.phoneNorm
                  : (typeof item.phone === "string" ? item.phone : null),
              );
              const itemId = typeof item.clientId === "string" ? item.clientId : null;
              if (myPhoneNorm && itemPhone === myPhoneNorm) return false;
              if (profile.id && itemId === profile.id) return false;
              return true;
            }),
            {
              role: "PARTICIPANT",
              status: paymentStatus,
              paymentRef,
              clientId: profile.id ?? null,
              phone: profile.phone ?? null,
              phoneNorm: myPhoneNorm,
              bookingId: paymentResult.data.bookingId,
              productId: paymentResult.data.productId,
              transactionId: paymentResult.data.transactionId,
              paymentUrl: paymentResult.data.paymentUrl,
              amount: paymentResult.data.toPay,
              amountMinor: paymentResult.data.toPayMinor,
              spot: paymentResult.data.spot ?? nextSpot,
              deadlineAt: resolvedPaymentDeadlineAt,
              expiresAt: resolvedPaymentDeadlineAt,
              createdAt: nowIso,
              paidAt: isPaidWithoutRedirect ? nowIso : null,
            },
          ],
        };
        metadata.bookingIds = Array.from(new Set([
          ...currentMetadataBookingIds,
          ...parseBookingIdsFromUnknown(splitPaymentMeta.bookingIds),
          paymentResult.data.bookingId,
        ].filter(Boolean)));

        const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
          expectedUpdatedAt: actualGame.updatedAt ?? null,
          participants,
          waitlist,
          metadata,
        });

        if (updateResult.error) {
          setSubmitting(null);
          setDecisionError(updateResult.error.message || "Не удалось сохранить оплату участия");
          return;
        }

        notifyGameRecordUpdated(
          updateResult.data ?? {
            ...actualGame,
            participants,
            waitlist,
            metadata,
          },
          "game_join_split_update",
        );

        if (isPaidWithoutRedirect) {
          setSubmitting(null);
          window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
          return;
        }

        setSubmitting(null);
        window.location.href = paymentResult.data.paymentUrl || buildCabinetGameUrl(cabinetUrl, actualGame.id);
        return;
      }

      if (participants.length < maxPlayers) {
        participants.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "CONFIRMED",
        });
        appliedStatus = "JOINED";
      } else if (waitlistEnabled) {
        waitlist.push({
          ...myPlayer,
          source: "INVITE_LINK",
          status: "WAITLIST",
        });
        appliedStatus = "WAITLIST";
      } else {
        setSubmitting(null);
        setDecisionError("В игре нет свободных мест");
        return;
      }

      const nowIso = new Date().toISOString();
      const metadata: Record<string, unknown> = isRecord(actualGame.metadata)
        ? { ...actualGame.metadata }
        : {};
      const joinResponses = isRecord(metadata.joinResponses)
        ? { ...metadata.joinResponses as Record<string, unknown> }
        : {};
      joinResponses[myPhoneNorm] = {
        status: appliedStatus,
        comment: comment.trim() || null,
        updatedAt: nowIso,
        playerName: myPlayer.name,
        playerId: myPlayer.id ?? null,
      };
      metadata.joinResponses = joinResponses;
      metadata.lastJoinUpdateAt = nowIso;
      const updateResult = await apiUpdatePadelGameRecord(actualGame.id, {
        expectedUpdatedAt: actualGame.updatedAt ?? null,
        participants,
        waitlist,
        metadata,
      });

      if (updateResult.error) {
        setDecisionError(updateResult.error.message || "Не удалось обновить участие");
        setSubmitting(null);
        return;
      }

      const reloaded = await apiFetchPadelGameRecord(actualGame.id);
      if (reloaded.data) {
        setGame(reloaded.data);
        notifyGameRecordUpdated(reloaded.data, "game_join_update");
      } else if (updateResult.data) {
        const merged = mergeRecord(actualGame, updateResult.data);
        setGame(merged);
        notifyGameRecordUpdated(merged, "game_join_update");
      }

      setSubmitting(null);
      window.location.href = buildCabinetGameUrl(cabinetUrl, actualGame.id);
    },
    [cabinetUrl, comment, game, preferredSplitPaymentMode, profile],
  );

  if (loading) {
    return (
      <div className="app-container game-container">
        <div className="game-empty">Загружаем данные игры...</div>
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <div className="page-title">Приглашение в игру</div>
        </div>
        <div className="game-section">
          <div className="game-empty game-pay-error">{error || "Игра не найдена"}</div>
        </div>
        <div className="game-section">
          <button
            className="section-cta"
            type="button"
            onClick={() => {
              window.location.href = buildCabinetHomeUrl(cabinetUrl);
            }}
          >
            Вернуться в личный кабинет
          </button>
        </div>
      </div>
    );
  }

  const dateLabel = toDateLabel(game.booking?.date);
  const timeLabel =
    game.booking?.timeFrom && game.booking?.timeTo
      ? `${game.booking.timeFrom} - ${game.booking.timeTo}`
      : "Время уточняется";
  const courtLabel = game.booking?.roomName || "Корт";
  const stationLabel = game.booking?.studioName || "Станция";
  const alreadyJoined = myDecision === "JOINED";
  const splitPaymentGame = isSplitPaymentGame(game);
  const splitShareAmount = getSplitShareAmount(game);
  const splitShareCount = getSplitShareCount(game) ?? (resolveMaxPlayers(game) <= DEFAULT_SINGLES_MAX_PLAYERS ? 2 : 4);
  const canPrimaryAction = submitting === null && !confirmingSplitPaymentRef;
  const canDecline = submitting === null && !confirmingSplitPaymentRef;
  const splitJoinSubscriptionLabel =
    submitting === "join"
      ? "Готовим оплату..."
      : "Списать с абонемента";
  const splitJoinOneTimeLabel =
    submitting === "join"
      ? "Готовим оплату..."
      : `Оплатить стоимость${splitShareAmount != null ? ` · ${formatPrice(splitShareAmount)} ₽` : ""}`;
  const joinButtonLabel = splitPaymentGame
    ? (submitting === "join"
        ? "Готовим оплату..."
        : (
          preferredSplitPaymentMode === "subscription"
            ? "Списать с абонемента"
            : `Оплатить стоимость${splitShareAmount != null ? ` · ${formatPrice(splitShareAmount)} ₽` : ""}`
        ))
    : (submitting === "join" ? "Сохраняем..." : "Присоединиться");
  const primaryButtonLabel = alreadyJoined ? "Открыть игру" : joinButtonLabel;

  return (
    <div className="app-container game-container game-join-container">
      <div className="page-header">
        <div className="page-title">Приглашение в игру</div>
      </div>

      <div className="game-section">
        <div className="details-card">
          <div className="details-row">
            <div>
              <div className="details-date details-date-capitalize">{dateLabel}</div>
              <div className="details-time">{timeLabel}</div>
              <div className="details-time details-time-strong">{courtLabel}</div>
              <div className="details-time">{stationLabel}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="game-section">
        <div className="game-join-status">{statusLabel}</div>
        {confirmingSplitPaymentRef && (
          <div className="game-empty">Подтверждаем оплату участия...</div>
        )}
        {splitPaymentGame && splitShareAmount != null && (
          <div className="game-split-join-summary">
            <span>{formatPrice(splitShareAmount)} ₽ за участие</span>
            {splitShareCount != null && <span>{splitShareCount === 2 ? "2 игрока" : "4 игрока"}</span>}
          </div>
        )}
      </div>

      {!alreadyJoined && (
        <div className="game-section">
          <div className="game-section-title">Комментарий к ответу</div>
          <textarea
            className="game-input game-join-comment"
            placeholder="Например: буду с партнером / опоздаю на 10 минут"
            value={comment}
            onChange={(event) => setComment(event.target.value.slice(0, 300))}
          />
        </div>
      )}

      {decisionError && (
        <div className="game-section">
          <div className="game-empty game-pay-error">{decisionError}</div>
        </div>
      )}

      <div className="game-section game-join-actions">
        {splitPaymentGame && !alreadyJoined ? (
          <div className="game-join-split-pay-actions">
            <button
              className="game-join-split-pay-option"
              type="button"
              disabled={!canPrimaryAction}
              onClick={() => {
                void applyDecision("join", "subscription");
              }}
            >
              {splitJoinSubscriptionLabel}
            </button>
            <button
              className="game-join-split-pay-option game-join-split-pay-option-primary"
              type="button"
              disabled={!canPrimaryAction}
              onClick={() => {
                void applyDecision("join", "one_time");
              }}
            >
              {splitJoinOneTimeLabel}
            </button>
          </div>
        ) : (
          <button
            className="section-cta"
            type="button"
            disabled={!canPrimaryAction}
            onClick={() => {
              if (alreadyJoined) {
                window.location.href = buildCabinetGameUrl(cabinetUrl, game.id);
                return;
              }
              void applyDecision("join");
            }}
          >
            {primaryButtonLabel}
          </button>
        )}
        <button
          className="section-cta section-cta-secondary"
          type="button"
          disabled={!canDecline}
          onClick={() => {
            void applyDecision("decline");
          }}
        >
          {submitting === "decline" ? "Сохраняем..." : "Выйти"}
        </button>
      </div>
    </div>
  );
}
