import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiFetchPadelAvailableGames,
  apiFetchProfile,
  type PadelGamePlayer,
  type PadelGameRecord,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  CABINET_URL,
  IS_DEV_RELEASE_CHANNEL,
  PUBLIC_GAME_CREATE_PATH,
  PUBLIC_INVITE_ORIGIN,
  PUBLIC_INVITE_PATH,
} from "../../consts/api_config";
import {
  apiFetchGroupTrainingsByDate,
  isGamePlusTrainerSummary,
  type GroupTrainingSummary,
} from "../../utils/groupScheduleApi";
import {
  apiFetchTournamentVivaPublicCheckout,
  type TournamentVivaCheckout,
  type TournamentVivaProduct,
} from "../../utils/tournamentSignupApi";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  normalizeLevelGradeLabel,
  parseNumericLevel,
} from "../../utils/customFields";
import { appendCurrentAuthModeToNavigableUrl } from "../../utils/authMode";
import { addGameToCalendar } from "../../utils/calendarEvent";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { Modal } from "../UI/Modal";
import { SummerSubscriptionGallery } from "../UI/SummerSubscriptionGallery";
import { appendSubscriptionUsageShadowToSameOriginUrl } from "../subscriptions/subscriptionUsageShadow";

interface FindGamePageProps {
  onBack?: () => void;
  cabinetUrl?: string | null;
  presetStudioId?: string | null;
  presetStudioName?: string | null;
  includeGamePlusTrainer?: boolean;
}

type ViewerGameState = "participant" | "waitlist" | "none";
type FindGameViewer = { id: string | null; phone: string | null; level: string | null; levelNumeric: number | null };
type FindGameKindFilter = "all" | "game" | "game-plus-trainer";
type FindGameTimeOfDayFilter = "all" | "morning" | "day" | "evening";
type FindGameSelectOption = { value: string; label: string };
type GamePlusTrainerMeta = {
  priceLabel: string | null;
};
type FindGameListItem =
  | { kind: "game"; id: string; sortTs: number; game: PadelGameRecord }
  | { kind: "game-plus-trainer"; id: string; sortTs: number; training: GroupTrainingSummary };

const PAGE_SIZE = 12;
const DAYS_BEFORE_TODAY = 0;
const DAYS_AFTER_TODAY = 14;
const TODAY_DATE_INDEX = DAYS_BEFORE_TODAY;
const DEFAULT_CABINET_URL = CABINET_URL;
const DEFAULT_GAME_CREATE_PATH =
  (PUBLIC_GAME_CREATE_PATH || "/game_create").replace(/\/+$/, "") || "/game_create";
const DEFAULT_GAME_JOIN_PATH =
  (PUBLIC_INVITE_PATH || "/game_join").replace(/\/+$/, "") || "/game_join";
const FRIENDLY_TAG_LABEL = "Лето.Падел";
const FRIENDLY_TAG_SUBSCRIPTION_URL = "https://padlhub.ru/ab_leto";
const GAME_PLUS_TRAINER_GROUP_PATH = "/group";
const GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL = "5500";
const GAME_PLUS_TRAINER_INCLUDED_PRICE_LABELS = ["Энергия5", "академия", "РА"] as const;
const GAME_PLUS_TRAINER_DEFAULT_PRICE_LABEL = [
  GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL,
  ...GAME_PLUS_TRAINER_INCLUDED_PRICE_LABELS,
].join("/");
const FIND_GAME_FILTER_ALL_VALUE = "__all__";
const FIND_GAME_KIND_OPTIONS: Array<{ value: FindGameKindFilter; label: string }> = [
  { value: "all", label: "Все типы" },
  { value: "game", label: "Игра" },
  { value: "game-plus-trainer", label: "Игра+Тренер" },
];
const FIND_GAME_TIME_OF_DAY_OPTIONS: Array<{ value: FindGameTimeOfDayFilter; label: string }> = [
  { value: "all", label: "Все" },
  { value: "morning", label: "Утро до 11" },
  { value: "day", label: "День с 11 до 18" },
  { value: "evening", label: "Вечер после 18" },
];
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

function normalizePhone(value: string | null | undefined): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isDevCabinetUrl(value: string | null | undefined): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    return new URL(raw, typeof window !== "undefined" ? window.location.origin : undefined).pathname.includes("/lk_dev");
  } catch {
    return raw.includes("/lk_dev");
  }
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

function getSplitPaymentMetadata(game: PadelGameRecord | undefined): Record<string, unknown> | null {
  const metadata = isRecordObject(game?.metadata) ? game.metadata : null;
  return metadata && isRecordObject(metadata.splitPayment) ? metadata.splitPayment : null;
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

  const shareCount = toNumber(splitPayment.shareCount);
  const shareAmount = toNumber(splitPayment.shareAmount ?? splitPayment.amount ?? splitPayment.toPay);
  const totalAmount = toNumber(splitPayment.totalAmount);
  const oneTimeBaseAmount = toNumber(splitPayment.oneTimeBaseAmount ?? splitPayment.baseShareAmount);
  if (
    (shareCount === 2 || shareCount === 4)
    && ((shareAmount ?? 0) > 0 || (totalAmount ?? 0) > 0 || (oneTimeBaseAmount ?? 0) > 0)
  ) {
    return true;
  }

  return false;
}

function isSplitPaymentGame(game: PadelGameRecord | undefined): boolean {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;
  const splitPayment = getSplitPaymentMetadata(game);
  return hasSplitPaymentSignal(splitPayment);
}

function hasSubscriptionPaymentTypeToken(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toUpperCase();
  if (!normalized) return false;
  return normalized.includes("SUBSCRIPTION") || normalized.includes("ABON");
}

function hasFriendlySubscriptionSignal(game: PadelGameRecord | undefined): boolean {
  if (!game) return false;
  if (isSplitPaymentGame(game)) return true;

  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  if (!metadata) return false;

  if (metadata.canJoinBySubscription === true) return true;
  if (metadata.hasSubscriptionBooking === true) return true;

  const paymentTypes = Array.isArray(metadata.bookingPaymentTypes)
    ? metadata.bookingPaymentTypes
    : [];
  if (paymentTypes.some((value) => hasSubscriptionPaymentTypeToken(value))) return true;

  return false;
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

function formatRubPrice(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function getGamePlusTrainerProductRubPrice(product: TournamentVivaProduct): number | null {
  if (typeof product.targetAmount === "number" && Number.isFinite(product.targetAmount)) {
    return Math.max(0, Math.round(product.targetAmount));
  }
  if (typeof product.priceLabel === "string" && product.priceLabel.trim()) {
    const digits = product.priceLabel.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
    if (digits) {
      const parsed = Number.parseInt(digits, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof product.cost === "number" && Number.isFinite(product.cost)) {
    return Math.max(0, Math.round(product.cost / 100));
  }
  return null;
}

function buildGamePlusTrainerPriceLabel(checkout: TournamentVivaCheckout | null): string | null {
  if (!checkout) return null;
  const oneTimePrice = checkout.oneTimes
    .map(getGamePlusTrainerProductRubPrice)
    .find((price): price is number => price !== null && price > 0);
  const priceValueLabel = oneTimePrice ? String(oneTimePrice) : GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL;
  return [priceValueLabel, ...GAME_PLUS_TRAINER_INCLUDED_PRICE_LABELS].join("/");
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

function isInactiveMembershipStatus(value: string | null | undefined): boolean {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return false;
  return INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS.some((marker) => status.includes(marker));
}

function normalizePersonName(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ");
}

function isPlaceholderName(value: string | null | undefined): boolean {
  const normalized = normalizePersonName(value);
  return normalized === "игрок" || normalized === "организатор";
}

function hasMeaningfulPlayerIdentity(player: PadelGamePlayer | null | undefined): boolean {
  if (!player || isInactiveMembershipStatus(player.status)) return false;
  if (String(player.id || "").trim()) return true;
  if (normalizePhone(player.phone)) return true;
  const name = String(player.name || "").trim();
  return Boolean(name && !isPlaceholderName(name));
}

function countActiveParticipants(game: PadelGameRecord): number {
  return (game.participants ?? []).filter((player) => hasMeaningfulPlayerIdentity(player)).length;
}

function resolveMaxPlayers(game: PadelGameRecord): number {
  const metadata = isRecordObject(game.metadata) ? game.metadata : null;
  const splitPayment = getSplitPaymentMetadata(game);
  const splitShareCount = toNumber(splitPayment?.shareCount);
  const singlesByCourt = [
    game.booking?.roomName,
    metadata?.roomName,
    metadata?.courtName,
    metadata?.courtTitle,
  ].some((value) => isSinglesCourtName(value));
  if (isSinglesFormat(metadata?.gameFormat ?? metadata?.format) || splitShareCount === 2 || singlesByCourt) {
    return 2;
  }

  const inviteLimit = game.invite?.maxPlayers;
  if (typeof inviteLimit === "number" && Number.isFinite(inviteLimit) && inviteLimit > 0) {
    return Math.floor(inviteLimit);
  }

  if (metadata) {
    const fromMeta = toNumber(metadata.maxPlayers ?? metadata.playersLimit);
    if (fromMeta !== null && fromMeta > 0) return Math.floor(fromMeta);

    if (isSinglesFormat(metadata.gameFormat ?? metadata.format)) return 2;
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

function resolveTrainingTimestamp(value: string | null | undefined): number | null {
  const parsed = new Date(String(value || "").trim());
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}

function resolveTrainingStartTs(training: GroupTrainingSummary): number | null {
  return resolveTrainingTimestamp(training.timeFrom);
}

function resolveTrainingEndTs(training: GroupTrainingSummary): number | null {
  return resolveTrainingTimestamp(training.timeTo) ?? resolveTrainingTimestamp(training.timeFrom);
}

function formatTrainingDateLine(training: GroupTrainingSummary): string {
  const parsed = parseLocalGameDate(training.date);
  if (!parsed) return training.title || "Игра+Тренер";
  return training.title || parsed.toLocaleDateString("ru-RU", {
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
}

function getTrainingDateBadgeLabels(training: GroupTrainingSummary) {
  const parsed = parseLocalGameDate(training.date);
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

function formatTrainingLocationLine(training: GroupTrainingSummary): string {
  return [training.studioName, training.roomName].filter(Boolean).join(" · ") || "Станция уточняется";
}

function getTrainingLevelTag(training: GroupTrainingSummary): string {
  return training.levelLabel || "Игра+Тренер";
}

function resolveTrainingMaxPlayers(training: GroupTrainingSummary): number {
  if (training.maxClientsCount > 0) return training.maxClientsCount;
  return Math.max(3, training.clientsCount);
}

function isJoinableGamePlusTrainerTraining(training: GroupTrainingSummary): boolean {
  if (!training.id || training.status === "CANCELLED") return false;
  const endTs = resolveTrainingEndTs(training);
  if (endTs !== null && endTs < Date.now()) return false;
  return training.status === "AVAILABLE" || training.inBooking || training.inWaitlist;
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

function matchesSelectedTrainingStationFilter(training: GroupTrainingSummary, stationFilterValue: string): boolean {
  if (stationFilterValue === FIND_GAME_FILTER_ALL_VALUE) return true;
  const trainingStationValue = buildStationFilterValue(training.studioId, training.studioName);
  return Boolean(trainingStationValue && trainingStationValue === stationFilterValue);
}

function matchesSelectedLevelFilter(game: PadelGameRecord, levelFilterValue: string): boolean {
  if (levelFilterValue === FIND_GAME_FILTER_ALL_VALUE) return true;
  return getRatingTag(game) === levelFilterValue;
}

function matchesSelectedTrainingLevelFilter(training: GroupTrainingSummary, levelFilterValue: string): boolean {
  if (levelFilterValue === FIND_GAME_FILTER_ALL_VALUE) return true;
  return getTrainingLevelTag(training) === levelFilterValue;
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

function getTrainingStartMinutes(training: GroupTrainingSummary): number | null {
  const direct = parseTimeMinutes(training.timeFrom);
  if (direct !== null) return direct;
  const parsed = new Date(training.timeFrom);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.getHours() * 60 + parsed.getMinutes();
}

function matchesTrainingTimeOfDayFilter(training: GroupTrainingSummary, timeOfDayFilter: FindGameTimeOfDayFilter): boolean {
  if (timeOfDayFilter === "all") return true;
  const startMinutes = getTrainingStartMinutes(training);
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

function matchesTrainingStationFilter(
  training: GroupTrainingSummary,
  presetStudioId: string | null | undefined,
  presetStudioName: string | null | undefined,
): boolean {
  const studioId = String(presetStudioId || "").trim();
  const studioName = normalizeComparable(presetStudioName);
  if (!studioId && !studioName) return true;

  if (studioId && training.studioId === studioId) return true;
  if (!studioName) return false;

  const trainingStudioName = normalizeComparable(training.studioName);
  return Boolean(trainingStudioName && (trainingStudioName.includes(studioName) || studioName.includes(trainingStudioName)));
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

function buildFindGameReturnUrl(fallbackUrl: string): string {
  if (typeof window === "undefined") return fallbackUrl;
  try {
    return new URL(window.location.href).toString();
  } catch {
    return fallbackUrl;
  }
}

function appendCurrentSubscriptionUsageShadow(url: URL): URL {
  if (typeof window === "undefined") return url;
  try {
    return appendSubscriptionUsageShadowToSameOriginUrl(url, new URL(window.location.href));
  } catch {
    return url;
  }
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
  const participantCount = countActiveParticipants(game);
  const viewerState = resolveViewerState(game, viewer);
  if (viewerState !== "none") return true;

  return participantCount < maxPlayers || resolveWaitlistEnabled(game);
}

async function fetchGamePlusTrainerMeta(training: GroupTrainingSummary): Promise<[string, GamePlusTrainerMeta]> {
  const checkoutResult = await apiFetchTournamentVivaPublicCheckout(
    training.id,
    { tournament: training.raw },
  ).catch(() => ({ data: null }));
  const checkout = checkoutResult.data ?? null;
  return [
    training.id,
    {
      priceLabel: buildGamePlusTrainerPriceLabel(checkout),
    },
  ];
}

function GamePlayerAvatar({ player, index }: { player: PadelGamePlayer; index: number }) {
  const [imageFailed, setImageFailed] = useState(false);
  const numeric = (
    typeof player.ratingNumeric === "number" && Number.isFinite(player.ratingNumeric)
      ? player.ratingNumeric
      : toNumber(player.rating)
  );
  const level = normalizeLevelGradeLabel(player.rating, numeric);
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

function OccupiedPlayerSlot() {
  return (
    <div className="find-game-player find-game-player-occupied">
      <span className="find-game-player-ring" aria-hidden="true">
        <span className="find-game-player-avatar find-game-player-fallback">PH</span>
      </span>
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

function GamePlusTrainerCard({
  training,
  meta,
  onOpen,
}: {
  training: GroupTrainingSummary;
  meta: GamePlusTrainerMeta | null;
  onOpen: (training: GroupTrainingSummary) => void;
}) {
  const maxPlayers = resolveTrainingMaxPlayers(training);
  const participantCount = Math.min(training.clientsCount, maxPlayers);
  const freeSlots = Math.max(0, maxPlayers - participantCount);
  const badgeLabels = getTrainingDateBadgeLabels(training);
  const priceLabel = meta?.priceLabel || GAME_PLUS_TRAINER_DEFAULT_PRICE_LABEL;
  const actionLabel = training.inBooking ? "Открыть запись" : "Записаться";

  return (
    <article
      className="find-game-card find-game-card-clickable find-game-card-trainer"
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, a, input, textarea, select, label")) return;
        onOpen(training);
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
          disabled
        />
        <div className="find-game-main">
          <div className="find-game-date">{formatTrainingDateLine(training)}</div>
          <div className="find-game-time">{training.timeLabel.replace("-", " - ")}</div>
          <div className="find-game-location">{formatTrainingLocationLine(training)}</div>
        </div>
        <div className="find-game-count">{participantCount}/{maxPlayers}</div>
      </div>

      <div className="find-game-tags">
        <span className="game-created-tag game-created-tag-level">{getTrainingLevelTag(training)}</span>
        {training.girlsOnly && <span className="game-created-tag game-created-tag-range">м/ж</span>}
        {freeSlots > 0 ? (
          <span className="game-created-tag game-created-tag-neutral">Есть места</span>
        ) : (
          <span className="game-created-tag game-created-tag-waitlist">Лист ожидания</span>
        )}
      </div>

      {training.trainerName && (
        <div className="find-game-organizer find-game-training-coach">
          {training.trainerAvatarUrl ? (
            <img className="find-game-training-coach-avatar" src={training.trainerAvatarUrl} alt="" />
          ) : (
            <span className="find-game-training-coach-avatar find-game-training-coach-fallback" aria-hidden="true">
              {initialsFromName(training.trainerName)}
            </span>
          )}
          <span>Тренер: <span>{training.trainerName}</span></span>
          <span className="find-game-friendly-tag find-game-friendly-tag-gold">
            <span className="find-game-friendly-tag-dot" aria-hidden="true" />
            <span className="find-game-friendly-tag-text">{FRIENDLY_TAG_LABEL}</span>
          </span>
        </div>
      )}

      <div className="find-game-footer">
        <div className="find-game-footer-divider" />
        <div className="find-game-footer-row">
          <div className="find-game-players">
            {Array.from({ length: participantCount }, (_, index) => (
              <OccupiedPlayerSlot key={`occupied-${index}`} />
            ))}
            {Array.from({ length: freeSlots }, (_, index) => (
              <EmptyPlayerSlot key={`empty-${index}`} />
            ))}
          </div>

          <div className="find-game-footer-actions">
            <div className="find-game-training-price" aria-label="Условия записи">
              <strong>{priceLabel}</strong>
            </div>
            <button
              type="button"
              className="find-game-action"
              onClick={() => onOpen(training)}
            >
              {actionLabel}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

function FindGameCard({
  game,
  viewer,
  onOpen,
  onOpenFriendlyTag,
}: {
  game: PadelGameRecord;
  viewer: FindGameViewer;
  onOpen: (game: PadelGameRecord) => void;
  onOpenFriendlyTag: (game: PadelGameRecord) => void;
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
  const friendlySubscriptionGame = hasFriendlySubscriptionSignal(game);
  const splitJoinPriceText = getSplitJoinPriceText(game);
  const showSplitJoinInfo = splitPaymentGame && freeSlots > 0 && Boolean(splitJoinPriceText);
  const showFriendlyTag = friendlySubscriptionGame && freeSlots > 0;
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
        {waitlistCount > 0 && (
          <span className="game-created-tag game-created-tag-waitlist">Ожидают: {waitlistCount}</span>
        )}
      </div>

      {game.organizer?.name && (
        <div className="find-game-organizer">
          <span>Организатор: <span>{game.organizer.name}</span></span>
          {showFriendlyTag && (
            <button
              type="button"
              className="find-game-friendly-tag"
              aria-label="Тег игры"
              onClick={(event) => {
                event.stopPropagation();
                onOpenFriendlyTag(game);
              }}
            >
              <span className="find-game-friendly-tag-dot" aria-hidden="true" />
              <span className="find-game-friendly-tag-text">{FRIENDLY_TAG_LABEL}</span>
            </button>
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
  includeGamePlusTrainer = false,
}: FindGamePageProps) {
  const [profile, setProfile] = useState<UserProfileType | null>(null);
  const [games, setGames] = useState<PadelGameRecord[]>([]);
  const [gamePlusTrainerTrainings, setGamePlusTrainerTrainings] = useState<GroupTrainingSummary[]>([]);
  const [gamePlusTrainerMetaById, setGamePlusTrainerMetaById] = useState<Record<string, GamePlusTrainerMeta>>({});
  const [gamePlusTrainerLoading, setGamePlusTrainerLoading] = useState(false);
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
  const [kindFilter, setKindFilter] = useState<FindGameKindFilter>("all");
  const [timeOfDayFilter, setTimeOfDayFilter] = useState<FindGameTimeOfDayFilter>("all");
  const [isFriendlyTagModalOpen, setFriendlyTagModalOpen] = useState(false);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const requestInFlightRef = useRef(false);
  const isStationLockedByPreset = Boolean(buildStationFilterValue(presetStudioId, presetStudioName));
  const shouldIncludeGamePlusTrainer = includeGamePlusTrainer === true;

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
    if (shouldIncludeGamePlusTrainer) {
      gamePlusTrainerTrainings.forEach((training) => {
        const value = buildStationFilterValue(training.studioId, training.studioName);
        const label = String(training.studioName || "").trim() || "Станция";
        if (!value || byValue.has(value)) return;
        byValue.set(value, label);
      });
    }
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
    gamePlusTrainerTrainings,
    isStationLockedByPreset,
    presetStudioId,
    presetStudioName,
    shouldIncludeGamePlusTrainer,
    stationFilterLabel,
    stationFilterValue,
  ]);

  const levelOptions = useMemo(() => {
    const uniqueLevels = new Set<string>();
    games.forEach((game) => {
      uniqueLevels.add(getRatingTag(game));
    });
    if (shouldIncludeGamePlusTrainer) {
      gamePlusTrainerTrainings.forEach((training) => {
        uniqueLevels.add(getTrainingLevelTag(training));
      });
    }
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
  }, [games, gamePlusTrainerTrainings, levelFilterValue, shouldIncludeGamePlusTrainer]);

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
    if (isDevCabinetUrl(resolvedCabinetUrl)) {
      url.searchParams.set("channel", "dev");
    }
    return appendCurrentAuthModeToNavigableUrl(
      appendCurrentSubscriptionUsageShadow(url),
    ).toString();
  }, [cabinetUrl, presetStudioId, presetStudioName]);

  const buildJoinUrl = useCallback((game: PadelGameRecord) => {
    const normalizedInvite = normalizeUrl(game.inviteUrl);
    if (normalizedInvite) {
      try {
        const url = new URL(normalizedInvite);
        if (IS_DEV_RELEASE_CHANNEL) url.searchParams.set("channel", "dev");
        return appendCurrentAuthModeToNavigableUrl(
          appendCurrentSubscriptionUsageShadow(url),
        ).toString();
      } catch {
        return appendCurrentAuthModeToNavigableUrl(normalizedInvite).toString();
      }
    }

    const url = normalizePadlHubInviteOrigin(buildAbsolutePageUrl(DEFAULT_GAME_JOIN_PATH, PUBLIC_INVITE_ORIGIN));
    url.searchParams.set("joinGame", game.id);
    const resolvedCabinetUrl = String(cabinetUrl || DEFAULT_CABINET_URL || "").trim();
    if (resolvedCabinetUrl) {
      url.searchParams.set("cabinetUrl", resolvedCabinetUrl);
    }
    if (isDevCabinetUrl(resolvedCabinetUrl) || IS_DEV_RELEASE_CHANNEL) {
      url.searchParams.set("channel", "dev");
    }
    return appendCurrentAuthModeToNavigableUrl(
      appendCurrentSubscriptionUsageShadow(url),
    ).toString();
  }, [cabinetUrl]);

  const buildGroupTrainingUrl = useCallback((training: GroupTrainingSummary) => {
    const url = buildAbsolutePageUrl(GAME_PLUS_TRAINER_GROUP_PATH);
    url.searchParams.set("exerciseId", training.id);
    url.searchParams.set("groupExerciseId", training.id);
    if (training.date) {
      url.searchParams.set("date", training.date);
    }
    if (training.studioId) {
      url.searchParams.set("studioId", training.studioId);
    }
    const resolvedCabinetUrl = String(cabinetUrl || DEFAULT_CABINET_URL || "").trim();
    const returnUrl = buildFindGameReturnUrl(resolvedCabinetUrl);
    if (returnUrl) {
      url.searchParams.set("cabinetUrl", returnUrl);
    }
    url.searchParams.set("returnTo", "finde_game");
    if (isDevCabinetUrl(resolvedCabinetUrl) || IS_DEV_RELEASE_CHANNEL) {
      url.searchParams.set("channel", "dev");
    }
    return appendCurrentAuthModeToNavigableUrl(url).toString();
  }, [cabinetUrl]);

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
      return;
    }
    const target = new URL(
      String(cabinetUrl || DEFAULT_CABINET_URL || "/lk_new"),
      window.location.origin,
    );
    window.location.href = appendCurrentAuthModeToNavigableUrl(
      appendCurrentSubscriptionUsageShadow(target),
    ).toString();
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
    setGames([]);
    setOffset(0);
    setHasMore(true);
    void loadPage(0, "replace");
  }, [loadPage]);

  useEffect(() => {
    let alive = true;

    if (!shouldIncludeGamePlusTrainer || !selectedDateKey) {
      setGamePlusTrainerTrainings([]);
      setGamePlusTrainerMetaById({});
      setGamePlusTrainerLoading(false);
      return () => {
        alive = false;
      };
    }

    setGamePlusTrainerLoading(true);
    setGamePlusTrainerTrainings([]);
    setGamePlusTrainerMetaById({});

    apiFetchGroupTrainingsByDate(selectedDateKey)
      .then((response) => {
        if (!alive) return;
        const trainings = (response.data ?? [])
          .filter(isGamePlusTrainerSummary)
          .filter((training) => matchesTrainingStationFilter(training, presetStudioId, presetStudioName))
          .filter(isJoinableGamePlusTrainerTraining);
        setGamePlusTrainerTrainings(trainings);
        setGamePlusTrainerLoading(false);

        trainings.forEach((training) => {
          void fetchGamePlusTrainerMeta(training)
            .then(([id, meta]) => {
              if (!alive) return;
              setGamePlusTrainerMetaById((current) => ({
                ...current,
                [id]: meta,
              }));
            })
            .catch(() => undefined);
        });
      })
      .catch(() => {
        if (!alive) return;
        setGamePlusTrainerTrainings([]);
        setGamePlusTrainerMetaById({});
        setGamePlusTrainerLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [presetStudioId, presetStudioName, selectedDateKey, shouldIncludeGamePlusTrainer]);

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

  const filteredGames = useMemo(() => {
    if (kindFilter === "game-plus-trainer") return [];
    return games
      .filter((game) => matchesSelectedStationFilter(game, stationFilterValue))
      .filter((game) => matchesSelectedLevelFilter(game, levelFilterValue))
      .filter((game) => matchesTimeOfDayFilter(game, timeOfDayFilter));
  }, [
    games,
    kindFilter,
    levelFilterValue,
    stationFilterValue,
    timeOfDayFilter,
  ]);

  const filteredGamePlusTrainerTrainings = useMemo(() => {
    if (!shouldIncludeGamePlusTrainer || kindFilter === "game") return [];
    return gamePlusTrainerTrainings
      .filter((training) => matchesSelectedTrainingStationFilter(training, stationFilterValue))
      .filter((training) => matchesSelectedTrainingLevelFilter(training, levelFilterValue))
      .filter((training) => matchesTrainingTimeOfDayFilter(training, timeOfDayFilter));
  }, [
    gamePlusTrainerTrainings,
    kindFilter,
    levelFilterValue,
    shouldIncludeGamePlusTrainer,
    stationFilterValue,
    timeOfDayFilter,
  ]);

  const filteredItems = useMemo<FindGameListItem[]>(() => [
    ...filteredGames.map((game) => ({
      kind: "game" as const,
      id: game.id,
      sortTs: resolveGameStartTs(game) ?? Number.MAX_SAFE_INTEGER,
      game,
    })),
    ...filteredGamePlusTrainerTrainings.map((training) => ({
      kind: "game-plus-trainer" as const,
      id: training.id,
      sortTs: resolveTrainingStartTs(training) ?? Number.MAX_SAFE_INTEGER,
      training,
    })),
  ].sort((left, right) => left.sortTs - right.sortTs), [filteredGamePlusTrainerTrainings, filteredGames]);

  const hasStationFilter = !isStationLockedByPreset && stationFilterValue !== FIND_GAME_FILTER_ALL_VALUE;
  const hasActiveFilters = hasStationFilter
    || levelFilterValue !== FIND_GAME_FILTER_ALL_VALUE
    || kindFilter !== "all"
    || timeOfDayFilter !== "all";
  const totalWithGamePlusTrainer = total + (shouldIncludeGamePlusTrainer ? gamePlusTrainerTrainings.length : 0);

  const visibleCountLabel = filteredItems.length > 0
    ? (hasActiveFilters
      ? `${filteredItems.length}`
      : `${filteredItems.length}${totalWithGamePlusTrainer > filteredItems.length ? ` из ${totalWithGamePlusTrainer}` : ""}`)
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
        <label className="find-game-filter-control">
          <span>Тип</span>
          <select
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as FindGameKindFilter)}
          >
            {FIND_GAME_KIND_OPTIONS.map((option) => (
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
      {!loading && shouldIncludeGamePlusTrainer && gamePlusTrainerLoading && (
        <div className="community-loading-note find-game-loading">Подгружаем Игра+Тренер...</div>
      )}

      {!loading && error && (
        <div className="find-game-empty">
          <div>{error}</div>
          <button type="button" className="section-cta section-cta-secondary" onClick={() => loadPage(0, "replace")}>
            Повторить
          </button>
        </div>
      )}

      {!loading && !loadingMore && !hasMore && !gamePlusTrainerLoading && !error && filteredItems.length === 0 && (
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
                setKindFilter("all");
                setTimeOfDayFilter("all");
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      )}

      {!loading && !error && filteredItems.length > 0 && (
        <div className="find-game-list">
          {filteredItems.map((item) => (
            item.kind === "game" ? (
              <FindGameCard
                key={`game-${item.id}`}
                game={item.game}
                viewer={viewer}
                onOpen={(targetGame) => {
                  window.location.href = buildJoinUrl(targetGame);
                }}
                onOpenFriendlyTag={() => {
                  setFriendlyTagModalOpen(true);
                }}
              />
            ) : (
              <GamePlusTrainerCard
                key={`game-plus-trainer-${item.id}`}
                training={item.training}
                meta={gamePlusTrainerMetaById[item.id] ?? null}
                onOpen={(targetTraining) => {
                  window.location.href = buildGroupTrainingUrl(targetTraining);
                }}
              />
            )
          ))}
        </div>
      )}

      {hasMore && !error && (
        <div ref={loadMoreRef} className="community-loading-note find-game-loading">
          {loadingMore ? "Подгружаем еще игры..." : "Прокрутите ниже, чтобы подгрузить еще игры"}
        </div>
      )}

      <Modal
        isOpen={isFriendlyTagModalOpen}
        onClose={() => setFriendlyTagModalOpen(false)}
        title={FRIENDLY_TAG_LABEL}
        variant="dialog"
      >
        <div className="find-game-friendly-modal">
          <p className="find-game-friendly-modal-text">Присоединиться можно по подписке</p>
          <button
            type="button"
            className="section-cta"
            onClick={() => {
              window.location.href = FRIENDLY_TAG_SUBSCRIPTION_URL;
            }}
          >
            Оформить подписку
          </button>
          <SummerSubscriptionGallery />
        </div>
      </Modal>
    </div>
  );
}
