import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetchPadelAvailableGames,
  apiFetchProfile,
  apiFetchSubscriptions,
  type PadelGamePlayer,
  type PadelGameRecord,
  type Subscription,
  type UserProfileType,
} from "../../utils/apiClient";
import { CABINET_URL, PUBLIC_GAME_CREATE_PATH, PUBLIC_INVITE_ORIGIN, PUBLIC_INVITE_PATH } from "../../consts/api_config";
import { CUSTOM_FIELD_IDS, getCustomFieldValue, getLetterGrade, parseNumericLevel } from "../../utils/customFields";
import { addGameToCalendar } from "../../utils/calendarEvent";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";

interface FindGamePageProps {
  onBack?: () => void;
  cabinetUrl?: string | null;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
}

type ViewerGameState = "participant" | "waitlist" | "none";
type FindGameViewer = { id: string | null; phone: string | null; level: string | null; levelNumeric: number | null };
type FindGameTimeOfDayFilter = "all" | "morning" | "day" | "evening";
type FindGameSelectOption = { value: string; label: string };

const PAGE_SIZE = 12;
const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_GAME_CREATE_PATH =
  (PUBLIC_GAME_CREATE_PATH || "/game_create").replace(/\/+$/, "") || "/game_create";
const DEFAULT_GAME_JOIN_PATH =
  (PUBLIC_INVITE_PATH || "/game_join").replace(/\/+$/, "") || "/game_join";
const SPLIT_OPEN_GAME_EXERCISE_TYPE_ID = 1613;
const SPLIT_OPEN_GAME_DIRECTION_ID = 4588;
const SPLIT_PAYMENT_MODE_QUERY_KEY = "splitPaymentMode";
const FIND_GAME_FILTER_ALL_VALUE = "__all__";
const FIND_GAME_TIME_OF_DAY_OPTIONS: Array<{ value: FindGameTimeOfDayFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "morning", label: "Утро до 11" },
  { value: "day", label: "День с 11 до 18" },
  { value: "evening", label: "Вечер после 18" },
];

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getSplitPaymentMetadata(game: PadelGameRecord | undefined): Record<string, unknown> | null {
  const metadata = isRecordObject(game?.metadata) ? game.metadata : null;
  return metadata && isRecordObject(metadata.splitPayment) ? metadata.splitPayment : null;
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
  const visitsLeft = Number.isFinite(subscription.visitsLeft) ? subscription.visitsLeft : null;
  const minutesLeft = Number.isFinite(subscription.availableMinutes) ? subscription.availableMinutes : null;
  if (visitsLeft != null && visitsLeft > 0) return true;
  if (minutesLeft != null && minutesLeft > 0) return true;
  if (visitsLeft != null && minutesLeft != null) return false;
  if (visitsLeft != null) return visitsLeft > 0;
  if (minutesLeft != null) return minutesLeft > 0;
  return true;
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
    return subscriptionMatchesSplitCategory(subscription, requiredExerciseTypeIds, requiredDirectionIds);
  });
}

function isSplitPaymentGame(game: PadelGameRecord | undefined): boolean {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;
  const splitPayment = getSplitPaymentMetadata(game);
  return Boolean(splitPayment?.enabled);
}

function extractGameCustomTitle(game: PadelGameRecord | undefined): string | null {
  const metadata = isRecordObject(game?.metadata) ? game.metadata : null;
  if (!metadata) return null;
  const value = typeof metadata.gameTitle === "string" ? metadata.gameTitle.trim() : "";
  return value || null;
}

function extractGameJoinPrice(game: PadelGameRecord | undefined): number | null {
  const metadata = isRecordObject(game?.metadata) ? game.metadata : null;
  if (!metadata) return null;
  if (typeof metadata.joinPrice === "number" && Number.isFinite(metadata.joinPrice)) {
    const normalized = Math.max(0, Math.round(metadata.joinPrice));
    return normalized > 0 ? normalized : null;
  }
  const raw = typeof metadata.joinPrice === "string" ? metadata.joinPrice.trim() : "";
  const digits = raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  if (!digits) return null;
  const numeric = Number.parseInt(digits, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function toComparableIdValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  return null;
}

function resolveSplitRequiredTypeIds(game: PadelGameRecord | undefined): Set<string> {
  const splitPayment = getSplitPaymentMetadata(game);
  return buildComparableIdSet([
    SPLIT_OPEN_GAME_EXERCISE_TYPE_ID,
    toComparableIdValue(splitPayment?.exerciseTypeId),
    toComparableIdValue(splitPayment?.vivaExerciseTypeId),
  ]);
}

function resolveSplitRequiredDirectionIds(game: PadelGameRecord | undefined): Set<string> {
  const splitPayment = getSplitPaymentMetadata(game);
  return buildComparableIdSet([
    SPLIT_OPEN_GAME_DIRECTION_ID,
    toComparableIdValue(splitPayment?.directionId),
    toComparableIdValue(splitPayment?.vivaDirectionId),
  ]);
}

function formatRubPrice(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function getSplitJoinPriceText(game: PadelGameRecord | undefined): string | null {
  if (!isSplitPaymentGame(game)) return null;
  const splitPayment = getSplitPaymentMetadata(game);
  const shareAmountMinor = toNumber(splitPayment?.shareAmountMinor ?? splitPayment?.amountMinor ?? splitPayment?.toPayMinor);
  const shareAmount =
    toNumber(splitPayment?.shareAmount ?? splitPayment?.amount ?? splitPayment?.toPay)
    ?? (shareAmountMinor !== null ? shareAmountMinor / 100 : null)
    ?? extractGameJoinPrice(game);
  return formatRubPrice(shareAmount);
}

function initialsFromName(value: string | null | undefined): string {
  const parts = String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2);
  const initials = parts.map((part) => part[0]?.toUpperCase()).join("");
  return initials || "PH";
}

function parseLocalGameDate(dateValue: string | null | undefined): Date | null {
  if (!dateValue) return null;
  const parsed = new Date(`${dateValue}T00:00:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatDateLocalIso(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveGameStartTs(game: PadelGameRecord): number | null {
  const booking = game.booking;
  const date = booking?.date;
  const time = booking?.timeFrom || booking?.timeTo;
  if (!date || !time) return null;
  const normalizedTime = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const parsed = new Date(`${date}T${normalizedTime}`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function resolveGameEndTs(game: PadelGameRecord): number | null {
  const booking = game.booking;
  const date = booking?.date;
  const time = booking?.timeTo || booking?.timeFrom;
  if (!date || !time) return null;
  const normalizedTime = /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
  const parsed = new Date(`${date}T${normalizedTime}`);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function isGameCancelled(game: PadelGameRecord): boolean {
  return String(game.status || "").trim().toUpperCase().includes("CANCEL");
}

function isGamePendingPayment(game: PadelGameRecord): boolean {
  const status = String(game.status || "").trim().toUpperCase();
  return status.includes("PAYMENT_PENDING") || status.includes("DRAFT") || game.payment?.paid === false;
}

function resolveMaxPlayers(game: PadelGameRecord): number {
  const inviteLimit = game.invite?.maxPlayers;
  if (typeof inviteLimit === "number" && Number.isFinite(inviteLimit) && inviteLimit > 0) {
    return Math.floor(inviteLimit);
  }

  const metadata = game.metadata;
  if (isRecordObject(metadata)) {
    const fromMeta = toNumber(metadata.maxPlayers ?? metadata.playersLimit);
    if (fromMeta !== null && fromMeta > 0) return Math.floor(fromMeta);

    const format = String(metadata.gameFormat || metadata.format || "").trim().toLowerCase();
    if (format === "singles" || format.includes("1x1") || format.includes("1 на 1")) return 2;
  }

  return 4;
}

function resolveWaitlistEnabled(game: PadelGameRecord): boolean {
  if (typeof game.invite?.waitlistEnabled === "boolean") return game.invite.waitlistEnabled;
  const metadata = game.metadata;
  if (isRecordObject(metadata) && typeof metadata.waitlistEnabled === "boolean") {
    return metadata.waitlistEnabled;
  }
  return true;
}

function getPlayerKey(player: PadelGamePlayer, index: number): string {
  const phone = normalizePhone(player.phone);
  if (phone) return `phone:${phone}`;
  if (player.id) return `id:${player.id}`;
  return `idx:${index}`;
}

function isSamePlayer(player: PadelGamePlayer, viewer: { id: string | null; phone: string | null }): boolean {
  const playerPhone = normalizePhone(player.phone);
  return Boolean(
    (viewer.phone && playerPhone && playerPhone === viewer.phone) ||
    (viewer.id && player.id && player.id === viewer.id),
  );
}

function resolveViewerState(
  game: PadelGameRecord,
  viewer: { id: string | null; phone: string | null },
): ViewerGameState {
  if ((game.participants ?? []).some((player) => isSamePlayer(player, viewer))) return "participant";
  if ((game.waitlist ?? []).some((player) => isSamePlayer(player, viewer))) return "waitlist";
  return "none";
}

function getViewerLevel(profile: UserProfileType | null): string | null {
  if (!profile) return null;
  const explicitGrade = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel);
  if (explicitGrade) return explicitGrade;
  const numeric = parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));
  return numeric !== null ? getLetterGrade(numeric) : null;
}

function getViewerLevelNumeric(profile: UserProfileType | null): number | null {
  if (!profile) return null;
  return parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));
}

function getRatingTag(game: PadelGameRecord): string {
  if (game.settings?.ratingGame === false) return "Без рейтинга";
  const min = game.settings?.minRating;
  const max = game.settings?.maxRating;
  if (min && max) return `${min}-${max}`;
  if (min) return `от ${min}`;
  if (max) return `до ${max}`;
  return "Рейтинг";
}

function getGameFormatLabel(maxPlayers: number): string {
  return maxPlayers <= 2 ? "1 на 1" : "2 на 2";
}

function formatDateLine(game: PadelGameRecord): string {
  const parsed = parseLocalGameDate(game.booking?.date);
  if (!parsed) return "Дата уточняется";
  return parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function getDateBadgeLabels(game: PadelGameRecord) {
  const parsed = parseLocalGameDate(game.booking?.date);
  if (!parsed) {
    return {
      monthLabel: "ИГРА",
      dayLabel: "—",
      weekdayLabel: "—",
    };
  }

  return {
    monthLabel: parsed
      .toLocaleDateString("ru-RU", { month: "short" })
      .replace(".", "")
      .trim()
      .slice(0, 3)
      .toUpperCase(),
    dayLabel: parsed.toLocaleDateString("ru-RU", { day: "2-digit" }),
    weekdayLabel: parsed
      .toLocaleDateString("ru-RU", { weekday: "short" })
      .replace(".", "")
      .toUpperCase(),
  };
}

function formatTimeLine(game: PadelGameRecord): string {
  const from = game.booking?.timeFrom;
  const to = game.booking?.timeTo;
  if (from && to) return `${from} - ${to}`;
  if (from) return from;
  if (to) return `до ${to}`;
  return "Время уточняется";
}

function formatLocationLine(game: PadelGameRecord): string {
  return [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(" · ") || "Станция уточняется";
}

function normalizeComparable(value: string | null | undefined): string | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
}

function buildStationFilterValue(
  studioId: string | null | undefined,
  studioName: string | null | undefined,
): string | null {
  const normalizedStudioId = String(studioId || "").trim();
  if (normalizedStudioId) return `id:${normalizedStudioId}`;
  const normalizedStudioName = normalizeComparable(studioName);
  return normalizedStudioName ? `name:${normalizedStudioName}` : null;
}

function matchesSelectedStationFilter(game: PadelGameRecord, stationFilterValue: string): boolean {
  if (stationFilterValue === FIND_GAME_FILTER_ALL_VALUE) return true;
  const gameStationValue = buildStationFilterValue(game.booking?.studioId, game.booking?.studioName);
  return Boolean(gameStationValue && gameStationValue === stationFilterValue);
}

function matchesSelectedLevelFilter(game: PadelGameRecord, levelFilterValue: string): boolean {
  if (levelFilterValue === FIND_GAME_FILTER_ALL_VALUE) return true;
  return getRatingTag(game) === levelFilterValue;
}

function parseTimeMinutes(value: string | null | undefined): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function matchesTimeOfDayFilter(game: PadelGameRecord, timeOfDayFilter: FindGameTimeOfDayFilter): boolean {
  if (timeOfDayFilter === "all") return true;
  const startMinutes = parseTimeMinutes(game.booking?.timeFrom || game.booking?.timeTo);
  if (startMinutes === null) return false;

  if (timeOfDayFilter === "morning") {
    return startMinutes >= 7 * 60 && startMinutes < 11 * 60;
  }
  if (timeOfDayFilter === "day") {
    return startMinutes >= 11 * 60 && startMinutes < 18 * 60;
  }
  return startMinutes >= 18 * 60 && startMinutes < 24 * 60;
}

function matchesStationFilter(
  game: PadelGameRecord,
  presetStudioId: string | null | undefined,
  presetStudioName: string | null | undefined,
): boolean {
  const studioId = String(presetStudioId || "").trim();
  const studioName = normalizeComparable(presetStudioName);
  if (!studioId && !studioName) return true;

  if (studioId && game.booking?.studioId === studioId) return true;
  if (!studioName) return false;

  const gameStudioName = normalizeComparable(game.booking?.studioName);
  return Boolean(gameStudioName && (gameStudioName.includes(studioName) || studioName.includes(gameStudioName)));
}

function matchesDateFilter(game: PadelGameRecord, dateKey: string | null): boolean {
  if (!dateKey) return true;
  return game.booking?.date === dateKey;
}

function buildAbsolutePageUrl(path: string, fallbackOrigin?: string): URL {
  if (fallbackOrigin) {
    return new URL(path, fallbackOrigin);
  }
  if (typeof window === "undefined") {
    return new URL(path, "https://padlhub.ru");
  }
  return new URL(path, window.location.origin);
}

function normalizePadlHubInviteOrigin(url: URL): URL {
  if (url.hostname !== "padlhub.su") return url;
  const normalized = new URL(url.toString());
  normalized.hostname = "padlhub.ru";
  return normalized;
}

function normalizeUrl(value: string | null | undefined): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw, typeof window !== "undefined" ? window.location.origin : "https://padlhub.ru");
    return normalizePadlHubInviteOrigin(parsed).toString();
  } catch {
    return raw;
  }
}

function mergeGames(current: PadelGameRecord[], incoming: PadelGameRecord[]): PadelGameRecord[] {
  const byId = new Map<string, PadelGameRecord>();
  current.forEach((game) => byId.set(game.id, game));
  incoming.forEach((game) => byId.set(game.id, game));
  return Array.from(byId.values()).sort((left, right) => {
    const leftTs = resolveGameStartTs(left) ?? Number.MAX_SAFE_INTEGER;
    const rightTs = resolveGameStartTs(right) ?? Number.MAX_SAFE_INTEGER;
    return leftTs - rightTs;
  });
}

function isJoinablePublicGame(
  game: PadelGameRecord,
  viewer: { id: string | null; phone: string | null },
): boolean {
  if (!game.id || isGameCancelled(game) || isGamePendingPayment(game)) return false;
  if (game.settings?.isPrivate === true) return false;

  const endTs = resolveGameEndTs(game);
  if (endTs !== null && endTs < Date.now()) return false;

  const maxPlayers = resolveMaxPlayers(game);
  const participantCount = game.participants?.length ?? 0;
  const viewerState = resolveViewerState(game, viewer);
  if (viewerState !== "none") return true;

  return participantCount < maxPlayers || resolveWaitlistEnabled(game);
}

function GamePlayerAvatar({ player, index }: { player: PadelGamePlayer; index: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const level = player.rating || (typeof player.ratingNumeric === "number" ? getLetterGrade(player.ratingNumeric) : null);
  const numeric = typeof player.ratingNumeric === "number" ? player.ratingNumeric : null;
  const photoSrc = (player.photo || "").trim();
  const showPhoto = Boolean(photoSrc) && !imageFailed;
  const progress = numeric !== null
    ? `${Math.max(18, Math.min(360, (numeric / 7) * 360))}deg`
    : "0deg";

  useEffect(() => {
    setImageFailed(false);
  }, [photoSrc]);

  return (
    <div className="find-game-player" title={player.name || `Игрок ${index + 1}`}>
      <span
        className={`find-game-player-ring${numeric !== null ? " has-level" : ""}`}
        style={{ "--player-ring-progress": progress } as CSSProperties}
      >
        {showPhoto ? (
          <img className="find-game-player-avatar" src={photoSrc} alt="" onError={() => setImageFailed(true)} />
        ) : (
          <span className="find-game-player-avatar find-game-player-fallback">
            {initialsFromName(player.name)}
          </span>
        )}
      </span>
      {level && <span className="find-game-player-level">{level}</span>}
    </div>
  );
}

function EmptyPlayerSlot() {
  return (
    <div className="find-game-player find-game-player-empty">
      <span className="find-game-player-ring" aria-hidden="true" />
    </div>
  );
}

function FindGameCard({
  game,
  viewer,
  splitSubscriptionsLoading,
  splitHasEligibleSubscription,
  onOpen,
}: {
  game: PadelGameRecord;
  viewer: FindGameViewer;
  splitSubscriptionsLoading: boolean;
  splitHasEligibleSubscription: boolean;
  onOpen: (game: PadelGameRecord, preferredPaymentMode?: "subscription" | "one_time") => void;
}) {
  const maxPlayers = resolveMaxPlayers(game);
  const participants = (game.participants ?? []).slice(0, maxPlayers);
  const freeSlots = Math.max(0, maxPlayers - participants.length);
  const viewerState = resolveViewerState(game, viewer);
  const badgeLabels = getDateBadgeLabels(game);
  const cardTitle = extractGameCustomTitle(game) ?? formatDateLine(game);
  const actionLabel = viewerState === "participant" ? "Открыть игру" : "Открыть";
  const participantsLabel = `${participants.length}/${maxPlayers}`;
  const waitlistCount = game.waitlist?.length ?? 0;
  const splitPaymentGame = isSplitPaymentGame(game);
  const splitJoinPriceText = getSplitJoinPriceText(game);
  const showSplitJoinInfo = splitPaymentGame && freeSlots > 0 && Boolean(splitJoinPriceText);
  const showSplitPaymentChoices = splitPaymentGame && viewerState === "none";
  const showDefaultActionButton = true;

  return (
    <article
      className={`find-game-card find-game-card-clickable${splitPaymentGame ? " find-game-card-split" : ""}`}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, textarea, select, label")) return;
        onOpen(game);
      }}
    >
      <div className="find-game-card-head">
        <CalendarDateBadge
          monthLabel={badgeLabels.monthLabel}
          dayLabel={badgeLabels.dayLabel}
          weekdayLabel={badgeLabels.weekdayLabel}
          variant="game-card"
          badgeClassName="game-created-date-badge"
          buttonClassName="game-created-date-badge-button"
          disabled={!game.booking?.date || (!game.booking?.timeFrom && !game.booking?.timeTo)}
          onClick={() => addGameToCalendar(game)}
        />
        <div className="find-game-main">
          <div className="find-game-date">{cardTitle}</div>
          <div className="find-game-time">{formatTimeLine(game)}</div>
          <div className="find-game-location">{formatLocationLine(game)}</div>
        </div>
        <div className="find-game-count">{participantsLabel}</div>
      </div>

      <div className="find-game-tags">
        <span className="game-created-tag game-created-tag-level">{getGameFormatLabel(maxPlayers)}</span>
        <span className="game-created-tag game-created-tag-range">{getRatingTag(game)}</span>
        {freeSlots > 0 ? (
          <span className="game-created-tag game-created-tag-neutral">
            {freeSlots === 1 ? "1 слот" : `${freeSlots} слота`}
          </span>
        ) : (
          <span className="game-created-tag game-created-tag-waitlist">Лист ожидания</span>
        )}
        {viewer.level && <span className="game-created-tag game-created-tag-duration">Ваш {viewer.level}</span>}
        {waitlistCount > 0 && (
          <span className="game-created-tag game-created-tag-waitlist">Ожидают: {waitlistCount}</span>
        )}
      </div>

      {game.organizer?.name && (
        <div className="find-game-organizer">
          <span>Организатор: <span>{game.organizer.name}</span></span>
          {showSplitJoinInfo && (
            <div className="find-game-friendly-tag" aria-label="Тег игры">
              <span className="find-game-friendly-tag-dot" aria-hidden="true" />
              <span className="find-game-friendly-tag-text">Лето.Падел.Дружба</span>
            </div>
          )}
        </div>
      )}

      <div className="find-game-footer">
        <div className="find-game-footer-divider" />
        <div className="find-game-footer-row">
          <div className={`find-game-players${maxPlayers <= 2 ? " find-game-players-singles" : ""}`}>
            {participants.map((player, index) => (
              <GamePlayerAvatar key={getPlayerKey(player, index)} player={player} index={index} />
            ))}
            {Array.from({ length: freeSlots }, (_, index) => (
              <EmptyPlayerSlot key={`empty-${index}`} />
            ))}
          </div>

          <div className="find-game-footer-actions">
            {showSplitJoinInfo && (
              <div className="find-game-split-join-info" aria-label="Условия присоединения к сборной игре">
                <div className="find-game-split-join-info-row">
                  <span>Присоединиться за</span>
                  <strong>{splitJoinPriceText}</strong>
                </div>
              </div>
            )}
            {showDefaultActionButton && (
              <button
                type="button"
                className="find-game-action"
                onClick={() => onOpen(game)}
              >
                {actionLabel}
              </button>
            )}
            {showSplitPaymentChoices && (
              <div className="find-game-split-pay-actions find-game-split-pay-actions-inside">
                {splitSubscriptionsLoading ? (
                  <button type="button" className="find-game-split-pay-option" disabled>
                    Проверяем абонемент...
                  </button>
                ) : (
                  splitHasEligibleSubscription && (
                    <button
                      type="button"
                      className="find-game-split-pay-option"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpen(game, "subscription");
                      }}
                    >
                      Списать с абонемента
                    </button>
                  )
                )}
                <button
                  type="button"
                  className="find-game-split-pay-option find-game-split-pay-option-primary"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpen(game, "one_time");
                  }}
                >
                  Оплатить стоимость
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function FindGamePage({
  onBack,
  cabinetUrl = DEFAULT_CABINET_URL,
  presetStudioId = null,
  presetStudioName = null,
}: FindGamePageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [games, setGames] = useState<PadelGameRecord[]>([]);
  const [splitSubscriptionsLoading, setSplitSubscriptionsLoading] = useState(false);
  const [splitSubscriptions, setSplitSubscriptions] = useState<Subscription[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dateIndex, setDateIndex] = useState(TODAY_DATE_INDEX);
  const [stationFilterValue, setStationFilterValue] = useState(
    buildStationFilterValue(presetStudioId, presetStudioName) ?? FIND_GAME_FILTER_ALL_VALUE,
  );
  const [stationFilterLabel, setStationFilterLabel] = useState(
    String(presetStudioName || "").trim() || "Выбранная станция",
  );
  const [levelFilterValue, setLevelFilterValue] = useState(FIND_GAME_FILTER_ALL_VALUE);
  const [timeOfDayFilter, setTimeOfDayFilter] = useState<FindGameTimeOfDayFilter>("all");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const requestInFlightRef = useRef(false);
  const isStationLockedByPreset = Boolean(buildStationFilterValue(presetStudioId, presetStudioName));

  const dates = useMemo(() => {
    const base = new Date();
    const totalDays = DAYS_BEFORE_TODAY + DAYS_AFTER_TODAY + 1;
    return Array.from({ length: totalDays }).map((_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + (i - DAYS_BEFORE_TODAY));
      return d;
    });
  }, []);
  const selectedDateKey = dates[dateIndex] ? formatDateLocalIso(dates[dateIndex]) : null;

  const viewer = useMemo(() => ({
    id: profile?.id ?? null,
    phone: normalizePhone(profile?.phone),
    level: getViewerLevel(profile),
    levelNumeric: getViewerLevelNumeric(profile),
  }), [profile]);

  const stationOptions = useMemo(() => {
    const byValue = new Map<string, string>();
    games.forEach((game) => {
      const value = buildStationFilterValue(game.booking?.studioId, game.booking?.studioName);
      const label = String(game.booking?.studioName || "").trim() || "Станция";
      if (!value || byValue.has(value)) return;
      byValue.set(value, label);
    });
    const presetValue = buildStationFilterValue(presetStudioId, presetStudioName);
    const presetLabel = String(presetStudioName || "").trim();
    if (presetValue && presetLabel && !byValue.has(presetValue)) {
      byValue.set(presetValue, presetLabel);
    }

    const options = Array.from(byValue.entries())
      .map(([value, label]): FindGameSelectOption => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label, "ru"));

    const withDefault = isStationLockedByPreset
      ? options
      : [{ value: FIND_GAME_FILTER_ALL_VALUE, label: "Все станции" }, ...options];

    if (
      stationFilterValue !== FIND_GAME_FILTER_ALL_VALUE
      && !withDefault.some((option) => option.value === stationFilterValue)
    ) {
      withDefault.push({
        value: stationFilterValue,
        label: stationFilterLabel || "Выбранная станция",
      });
    }

    return withDefault;
  }, [
    games,
    isStationLockedByPreset,
    presetStudioId,
    presetStudioName,
    stationFilterLabel,
    stationFilterValue,
  ]);

  const levelOptions = useMemo(() => {
    const uniqueLevels = new Set<string>();
    games.forEach((game) => {
      uniqueLevels.add(getRatingTag(game));
    });
    const options = Array.from(uniqueLevels)
      .sort((left, right) => left.localeCompare(right, "ru"))
      .map((level): FindGameSelectOption => ({ value: level, label: level }));
    const withDefault: FindGameSelectOption[] = [
      { value: FIND_GAME_FILTER_ALL_VALUE, label: "Любой уровень" },
      ...options,
    ];
    if (
      levelFilterValue !== FIND_GAME_FILTER_ALL_VALUE
      && !withDefault.some((option) => option.value === levelFilterValue)
    ) {
      withDefault.push({ value: levelFilterValue, label: levelFilterValue });
    }
    return withDefault;
  }, [games, levelFilterValue]);

  const hasEligibleSplitSubscriptionForGame = useCallback((game: PadelGameRecord): boolean => {
    if (splitSubscriptions.length === 0) return false;
    const requiredTypeIds = resolveSplitRequiredTypeIds(game);
    const requiredDirectionIds = resolveSplitRequiredDirectionIds(game);
    const eligible = filterSplitEligibleSubscriptions(splitSubscriptions, requiredTypeIds, requiredDirectionIds);
    return eligible.length > 0;
  }, [splitSubscriptions]);

  const buildCreateUrl = useCallback(() => {
    const url = buildAbsolutePageUrl(DEFAULT_GAME_CREATE_PATH);
    const stationId = String(presetStudioId || "").trim();
    const stationName = String(presetStudioName || "").trim();
    const resolvedCabinetUrl = String(cabinetUrl || DEFAULT_CABINET_URL || "").trim();
    if (stationId) {
      url.searchParams.set("stationId", stationId);
    }
    if (stationName) {
      url.searchParams.set("station", stationName);
    }
    if (resolvedCabinetUrl) {
      url.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }
    return url.toString();
  }, [cabinetUrl, presetStudioId, presetStudioName]);

  const buildJoinUrl = useCallback((game: PadelGameRecord, preferredPaymentMode?: "subscription" | "one_time") => {
    const normalizedInvite = normalizeUrl(game.inviteUrl);
    if (normalizedInvite) {
      try {
        const inviteUrl = new URL(normalizedInvite);
        if (preferredPaymentMode) {
          inviteUrl.searchParams.set(SPLIT_PAYMENT_MODE_QUERY_KEY, preferredPaymentMode);
        }
        return inviteUrl.toString();
      } catch {
        return normalizedInvite;
      }
    }

    const url = normalizePadlHubInviteOrigin(buildAbsolutePageUrl(DEFAULT_GAME_JOIN_PATH, PUBLIC_INVITE_ORIGIN));
    url.searchParams.set("joinGame", game.id);
    const resolvedCabinetUrl = String(cabinetUrl || DEFAULT_CABINET_URL || "").trim();
    if (resolvedCabinetUrl) {
      url.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }
    if (preferredPaymentMode) {
      url.searchParams.set(SPLIT_PAYMENT_MODE_QUERY_KEY, preferredPaymentMode);
    }
    return url.toString();
  }, [cabinetUrl]);

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    window.location.href = String(cabinetUrl || DEFAULT_CABINET_URL || "/lk_new");
  }, [cabinetUrl, onBack]);

  const loadPage = useCallback(async (nextOffset: number, mode: "replace" | "append") => {
    if (requestInFlightRef.current) return;
    requestInFlightRef.current = true;
    if (mode === "replace") {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const response = await apiFetchPadelAvailableGames({
        limit: PAGE_SIZE,
        offset: nextOffset,
        date: selectedDateKey,
        stationId: presetStudioId,
        stationName: presetStudioName,
      });
      const incoming = (response.data?.games ?? [])
        .filter((game) => matchesStationFilter(game, presetStudioId, presetStudioName))
        .filter((game) => matchesDateFilter(game, selectedDateKey))
        .filter((game) => isJoinablePublicGame(game, viewer));

      setGames((prev) => (mode === "replace" ? mergeGames([], incoming) : mergeGames(prev, incoming)));
      setTotal(response.data?.total ?? incoming.length);
      setHasMore(response.data?.hasMore ?? incoming.length >= PAGE_SIZE);
      setOffset(nextOffset + (response.data?.games.length ?? incoming.length));

      if (response.error && mode === "replace") {
        setError(response.error.message || "Не удалось загрузить игры");
      }
    } catch {
      if (mode === "replace") {
        setGames([]);
      }
      setError("Не удалось загрузить игры");
      setHasMore(false);
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [presetStudioId, presetStudioName, selectedDateKey, viewer]);

  useEffect(() => {
    let alive = true;
    apiFetchProfile()
      .then((response) => {
        if (!alive) return;
        setProfile(response.data ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setProfile(null);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setSplitSubscriptionsLoading(true);
    apiFetchSubscriptions()
      .then((result) => {
        if (!alive) return;
        const subscriptions = Array.isArray(result.data?.content) ? result.data.content : [];
        setSplitSubscriptions(subscriptions);
      })
      .catch(() => {
        if (!alive) return;
        setSplitSubscriptions([]);
      })
      .finally(() => {
        if (!alive) return;
        setSplitSubscriptionsLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setGames([]);
    setOffset(0);
    setHasMore(true);
    void loadPage(0, "replace");
  }, [loadPage]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return undefined;

    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0]?.isIntersecting) return;
      void loadPage(offset, "append");
    }, {
      rootMargin: "260px 0px",
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loading, loadingMore, loadPage, offset]);

  const filteredGames = useMemo(() => games
    .filter((game) => matchesSelectedStationFilter(game, stationFilterValue))
    .filter((game) => matchesSelectedLevelFilter(game, levelFilterValue))
    .filter((game) => matchesTimeOfDayFilter(game, timeOfDayFilter)), [
    games,
    levelFilterValue,
    stationFilterValue,
    timeOfDayFilter,
  ]);

  const hasStationFilter = !isStationLockedByPreset && stationFilterValue !== FIND_GAME_FILTER_ALL_VALUE;
  const hasActiveFilters = hasStationFilter
    || levelFilterValue !== FIND_GAME_FILTER_ALL_VALUE
    || timeOfDayFilter !== "all";

  const visibleCountLabel = filteredGames.length > 0
    ? (hasActiveFilters
      ? `${filteredGames.length}`
      : `${filteredGames.length}${total > filteredGames.length ? ` из ${total}` : ""}`)
    : "";

  return (
    <div className="app-container game-container find-game-container">
      <div className="page-header">
        <button className="page-back" onClick={handleBack} type="button">
          В личный кабинет
        </button>
      </div>

      <div className="find-game-hero">
        <button
          type="button"
          className="find-game-create"
          onClick={() => {
            window.location.href = buildCreateUrl();
          }}
        >
          <span className="find-game-create-title">Создать игру</span>
          <span className="find-game-create-sub">Выберите станцию, время и откройте набор игроков</span>
        </button>
      </div>

      <div className="find-game-section-head">
        <div>
          <div className="game-section-title">Присоединиться к игре</div>
          {presetStudioName && <div className="find-game-section-sub">{presetStudioName}</div>}
        </div>
        {visibleCountLabel && <div className="find-game-total">{visibleCountLabel}</div>}
      </div>

      <div className="find-game-date-filter">
        <div className="date-row">
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
                  onClick={() => setDateIndex(i)}
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
      </div>

      <div className="find-game-filterbar">
        <label className="find-game-filter-control">
          <span>Станция</span>
          <select
            value={stationFilterValue}
            onChange={(event) => {
              setStationFilterValue(event.target.value);
              const selectedLabel = event.target.selectedOptions[0]?.textContent?.trim();
              if (selectedLabel) {
                setStationFilterLabel(selectedLabel);
              }
            }}
            disabled={isStationLockedByPreset || stationOptions.length <= 1}
          >
            {stationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="find-game-filter-control">
          <span>Уровень</span>
          <select
            value={levelFilterValue}
            onChange={(event) => setLevelFilterValue(event.target.value)}
            disabled={levelOptions.length <= 1}
          >
            {levelOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div className="find-game-time-of-day">
          {FIND_GAME_TIME_OF_DAY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`find-game-time-chip${timeOfDayFilter === option.value ? " active" : ""}`}
              onClick={() => setTimeOfDayFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading && <div className="community-loading-note find-game-loading">Загружаем игры...</div>}

      {!loading && error && (
        <div className="find-game-empty">
          <div>{error}</div>
          <button type="button" className="section-cta section-cta-secondary" onClick={() => loadPage(0, "replace")}>
            Повторить
          </button>
        </div>
      )}

      {!loading && !loadingMore && !hasMore && !error && filteredGames.length === 0 && (
        <div className="find-game-empty">
          <div className="find-game-empty-title">
            {hasActiveFilters ? "Нет игр по выбранным фильтрам" : "На выбранную дату нет открытых игр"}
          </div>
          <div className="find-game-empty-text">
            {hasActiveFilters
              ? "Измените фильтры или прокрутите ниже для подгрузки игр."
              : "Создайте игру первым, остальные игроки увидят ее в этом списке."}
          </div>
          {hasActiveFilters && (
            <button
              type="button"
              className="section-cta section-cta-secondary"
              onClick={() => {
                if (!isStationLockedByPreset) {
                  setStationFilterValue(FIND_GAME_FILTER_ALL_VALUE);
                }
                setLevelFilterValue(FIND_GAME_FILTER_ALL_VALUE);
                setTimeOfDayFilter("all");
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      )}

      {!loading && !error && filteredGames.length > 0 && (
        <div className="find-game-list">
          {filteredGames.map((game) => (
            <FindGameCard
              key={game.id}
              game={game}
              viewer={viewer}
              splitSubscriptionsLoading={splitSubscriptionsLoading}
              splitHasEligibleSubscription={hasEligibleSplitSubscriptionForGame(game)}
              onOpen={(targetGame, preferredPaymentMode) => {
                window.location.href = buildJoinUrl(targetGame, preferredPaymentMode);
              }}
            />
          ))}
        </div>
      )}

      {hasMore && !error && (
        <div ref={loadMoreRef} className="community-loading-note find-game-loading">
          {loadingMore ? "Подгружаем еще игры..." : "Прокрутите ниже, чтобы подгрузить еще игры"}
        </div>
      )}
    </div>
  );
}
