import {
  API_BASE,
  PHAB_API_BASE,
  SERV2,
  SERV2_FALLBACK,
  TENANT_KEY,
} from "../consts/api_config";
import {
  apiFetchSubscriptionDailyLimitBookings,
  apiFetchSubscriptioName,
  apiReleaseSubscriptionBookingClaim,
  apiVerifyBookingCancellation,
  getServ2Origin,
  request,
  type ApiResult,
  type UserProfileType,
} from "./apiClient";
import { readAuthToken } from "./authTokenStorage";
import { appendCurrentAuthModeToNavigableUrl } from "./authMode";
import { buildProjectUrlCandidates } from "./lkApiBaseUrls";
import {
  buildBookingCancellationPayload,
  findBookingCancellationActionByRefundMethod,
  resolveBookingCancellationPlan,
  type BookingCancellationOptionsResponse,
  type BookingCancellationRefundMethod,
} from "./bookingCancellation";
import {
  buildTournamentCustomEnergyDiscountReason,
  buildTournamentCustomEnergyProduct,
  buildTournamentVivaTransactionProductPayload,
  resolveTournamentCustomPricing,
  toTournamentRubMinorAmount,
  type TournamentCustomPricing,
  type TournamentCustomPricingProductFields,
} from "./tournamentCustomPricing";
import { resolveTournamentSignupExerciseId } from "./tournamentExerciseId";
import {
  normalizeTournamentPricingPreviewSnapshot,
  normalizeTournamentPromoOnlyOfferSnapshot,
  type TournamentPricingPreview,
  type TournamentPricingPromoOnlyOffer,
} from "./tournamentPricingPreview";
import { isTournamentSignupPayloadCancelled } from "./tournamentSignupCancellation";
import {
  buildSubscriptionCategoryDailyLimitApiError,
  resolveSubscriptionCategoryDailyLimitCategoryFromEvent,
  resolveSubscriptionCategoryDailyLimitConflictFromBookings,
  resolveSubscriptionCategoryDailyLimitDateFromEvent,
  subscriptionPlanAllowsDailyLimitCategory,
} from "./subscriptionCategoryDailyLimit";

export type TournamentSignupStatus = "AVAILABLE" | "REGISTERED" | "WAITLIST" | "FULL" | "CLOSED" | "CANCELLED";

export interface TournamentSignupSummary {
  id: string;
  exerciseId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  date: string | null;
  timeLabel: string;
  studioName: string | null;
  address: string | null;
  format: string | null;
  levelLabel: string | null;
  priceLabel: string | null;
  participantsCount: number | null;
  maxParticipants: number | null;
  waitlistCount: number | null;
  status: TournamentSignupStatus;
  trainerName: string | null;
  trainerAvatarUrl: string | null;
  publicUrl: string | null;
  storedPricingPreview: TournamentPricingPreview | null;
  storedHasFriendlySubscriptionTag: boolean;
  storedSummerSubscriptionOffer: TournamentPricingPromoOnlyOffer | null;
  raw: unknown;
}

export interface TournamentSignupDetail extends TournamentSignupSummary {
  description: string | null;
  rules: string | null;
  registration: TournamentRegistrationState | null;
}

export interface TournamentMechanicsVivaRefreshResult {
  refreshed: boolean;
  reason: "refreshed" | "cooldown" | "refresh_failed";
  date: string;
  snapshotAvailable: boolean;
  tournaments: TournamentSignupSummary[];
  refreshedAt: string | null;
  retryAfterMs: number | null;
  persisted: boolean | null;
}

export interface TournamentRegistrationState {
  status: "NONE" | "REGISTERED" | "WAITLIST" | "PAYMENT_PENDING";
  bookingId?: string | null;
  placeNumber: number | null;
  waitlistNumber: number | null;
  canRegister: boolean;
  canCancel: boolean;
  message: string | null;
  paymentUrl?: string | null;
  paymentExpiresAt?: string | null;
}

export type TournamentVivaProductType =
  | "SERVICE"
  | "GOODS"
  | "INSTANT_SUB_SERVICE"
  | "ADVANCE_SUB_SERVICE"
  | "COMMISSION"
  | "FULL_PAYMENT_SERVICE"
  | "SUBSCRIPTION"
  | "DEPOSIT";

export interface TournamentVivaProduct {
  id: string;
  name: string;
  type: TournamentVivaProductType;
  cost: number | null;
  visitsTotal: number | null;
  source: "client-subscription" | "client-one-time" | "one-time" | "subscription" | "custom-tournament-energy";
  raw: unknown;
  priceLabel?: TournamentCustomPricingProductFields["priceLabel"];
  baseAmount?: TournamentCustomPricingProductFields["baseAmount"];
  discountAmount?: TournamentCustomPricingProductFields["discountAmount"];
  targetAmount?: TournamentCustomPricingProductFields["targetAmount"];
  isCustomTournamentEnergy?: TournamentCustomPricingProductFields["isCustomTournamentEnergy"];
}

export interface TournamentVivaCheckout {
  profile: UserProfileType | null;
  exercise: Record<string, unknown>;
  studioId: string | null;
  customPricing: TournamentCustomPricing | null;
  purchasedProducts: TournamentVivaProduct[];
  clientSubscriptions: TournamentVivaProduct[];
  oneTimes: TournamentVivaProduct[];
  subscriptions: TournamentVivaProduct[];
}

export interface TournamentVivaTransactionResult {
  paymentUrl: string | null;
  bookingId: string | null;
  toPay: number | null;
  paid: boolean;
  paymentExpiresAt: string | null;
  raw: unknown;
}

type QueryValue = string | number | boolean | null | undefined;

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

function pickNestedRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (isRecord(raw)) return raw;
  }
  return null;
}

function pickNestedFirstRecord(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      const record = raw.find(isRecord);
      if (record) return record;
    }
    if (isRecord(raw)) return raw;
  }
  return null;
}

function pickFirstArray(value: unknown, keys: string[]): unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) return raw;
  }
  return [];
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value
      .map((item) => (typeof item === "string" || typeof item === "number" ? String(item).trim() : ""))
      .filter(Boolean)
    : [];
}

function parseTournamentAccessLevel(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTournamentAccessLevel(value: string) {
  const parsed = parseTournamentAccessLevel(value);
  if (parsed === null) return value;
  if (parsed < 2) return "D1";
  if (parsed < 3) return "D+";
  if (parsed < 3.5) return "C";
  if (parsed <= 4) return "C+";
  if (parsed < 4.7) return "B";
  if (parsed < 5.5) return "B+";
  return "A";
}

function formatAccessLevelRange(value: unknown): string | null {
  const levels = normalizeStringArray(value);
  if (levels.length === 0) return null;
  const normalizedLevels = levels
    .map((level) => ({
      raw: level,
      numeric: parseTournamentAccessLevel(level),
      label: formatTournamentAccessLevel(level),
    }))
    .sort((left, right) => {
      if (left.numeric == null && right.numeric == null) return left.raw.localeCompare(right.raw, "ru-RU");
      if (left.numeric == null) return 1;
      if (right.numeric == null) return -1;
      return left.numeric - right.numeric;
    });

  if (normalizedLevels.length === 1) return normalizedLevels[0].label;
  return `${normalizedLevels[0].label}/${normalizedLevels[normalizedLevels.length - 1].label}`;
}

function normalizeTournamentRatingLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[–-]\s*/g, "–")
    .replace(/\s*\/\s*/g, "/")
    .trim();
  return normalized || null;
}

function pickPersonName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = pickString(value, ["name", "displayName", "fullName", "title"]);
  if (direct) return direct;
  const name = [
    pickString(value, ["firstName", "firstname", "givenName"]),
    pickString(value, ["lastName", "lastname", "familyName"]),
  ].filter(Boolean).join(" ").trim();
  return name || null;
}

function pickTournamentTrainer(value: unknown) {
  if (!isRecord(value)) {
    return { name: null, avatarUrl: null };
  }

  const person = pickNestedFirstRecord(value, [
    "trainer",
    "trainers",
    "coach",
    "coaches",
    "executor",
    "executors",
    "performer",
    "performers",
    "responsible",
    "organizer",
    "instructor",
  ]);
  const name =
    pickString(value, [
      "trainerName",
      "coachName",
      "executorName",
      "performerName",
      "responsibleName",
      "organizerName",
      "instructorName",
    ]) || pickPersonName(person);
  const avatarUrl =
    pickString(value, [
      "trainerAvatarUrl",
      "trainerAvatar",
      "trainerPhoto",
      "coachAvatarUrl",
      "executorAvatarUrl",
      "performerAvatarUrl",
      "performerPhoto",
      "organizerAvatarUrl",
    ]) || pickString(person, ["avatarUrl", "avatar", "photo", "imageUrl", "picture"]);

  return { name, avatarUrl };
}

function normalizeStatus(value: unknown): TournamentSignupStatus {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "REGISTERED") return "REGISTERED";
  if (raw === "WAITLIST" || raw === "WAITLISTED") return "WAITLIST";
  if (raw === "FULL") return "FULL";
  if (raw === "CLOSED" || raw === "FINISHED") return "CLOSED";
  if (isCancelledStatusValue(raw)) return "CANCELLED";
  return "AVAILABLE";
}

function isCancelledStatusValue(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return normalized === "CANCELLED"
    || normalized === "CANCELED"
    || normalized === "CANCEL"
    || normalized === "ОТМЕНЕН"
    || normalized === "ОТМЕНЁН"
    || normalized === "ОТМЕНЕННЫЙ"
    || normalized === "ОТМЕНЁННЫЙ"
    || normalized.includes("ОТМЕН");
}

function isClosedStatusValue(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return isCancelledStatusValue(normalized)
    || normalized === "CLOSED"
    || normalized === "FINISHED"
    || normalized === "ARCHIVED"
    || normalized === "HIDDEN"
    || normalized === "DRAFT";
}

function toBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function isClosedVisibilityValue(value: unknown) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return false;
  return normalized === "CLOSED"
    || normalized === "PRIVATE"
    || normalized === "INVITE_ONLY"
    || normalized === "INVITE-ONLY"
    || normalized === "HIDDEN";
}

function isPrivateTournamentRecord(record: Record<string, unknown>) {
  if (
    ["isPublic", "public"].some((key) => toBooleanFlag(record[key]) === false)
  ) return true;

  if (
    [
      "isPrivate",
      "private",
      "isClosed",
      "closed",
      "isHidden",
      "hidden",
      "inviteOnly",
      "isInviteOnly",
    ].some((key) => toBooleanFlag(record[key]) === true)
  ) return true;

  return [
    "visibility",
    "privacy",
    "access",
    "accessType",
    "audience",
    "joinRule",
  ].some((key) => isClosedVisibilityValue(record[key]));
}

function collectTournamentStateRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const records: Record<string, unknown>[] = [value];
  for (const key of [
    "skin",
    "tournamentSkin",
    "customTournament",
    "publicTournament",
    "sourceTournamentSnapshot",
    "sourceTournament",
    "tournament",
    "details",
    "statusAudit",
    "settings",
    "params",
  ]) {
    const nested = value[key];
    if (isRecord(nested)) records.push(...collectTournamentStateRecords(nested));
  }
  return records;
}

function readBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes", "y", "да", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "нет", "off"].includes(normalized)) return false;
  return null;
}

function buildStoredTournamentPricingSnapshot(value: unknown) {
  const records = collectTournamentStateRecords(value);
  let pricingPreview: TournamentPricingPreview | null = null;
  let summerSubscriptionOffer: TournamentPricingPromoOnlyOffer | null = null;
  let hasFriendlySubscriptionTag = false;

  for (const record of records) {
    if (!pricingPreview) {
      pricingPreview =
        normalizeTournamentPricingPreviewSnapshot(record.pricePopover)
        || normalizeTournamentPricingPreviewSnapshot(record.pricingPreview)
        || normalizeTournamentPricingPreviewSnapshot(record.pricePreview)
        || normalizeTournamentPricingPreviewSnapshot(record.pricingSnapshot);
    }

    if (!summerSubscriptionOffer) {
      summerSubscriptionOffer =
        normalizeTournamentPromoOnlyOfferSnapshot(record.summerSubscriptionOffer)
        || normalizeTournamentPromoOnlyOfferSnapshot(record.promoOnlyOffer)
        || normalizeTournamentPromoOnlyOfferSnapshot(record.friendlySubscriptionOffer);
    }

    const explicitFriendlyFlag =
      readBooleanFlag(record.hasFriendlySubscriptionTag)
      ?? readBooleanFlag(record.friendlySubscriptionTag)
      ?? readBooleanFlag(record.hasPromoOnlyTournamentProducts)
      ?? readBooleanFlag(record.hasSummerSubscriptionOffer);
    if (explicitFriendlyFlag === true) {
      hasFriendlySubscriptionTag = true;
    }
  }

  if (summerSubscriptionOffer) hasFriendlySubscriptionTag = true;

  return {
    pricingPreview,
    hasFriendlySubscriptionTag,
    summerSubscriptionOffer,
  };
}

function buildTournamentLevelLabel(value: unknown): string | null {
  const states = collectTournamentStateRecords(value);
  for (const state of states) {
    const direct = pickString(state, ["levelLabel", "ratingLabel", "level", "ratingRange", "rating"]);
    if (direct) {
      const normalizedDirect = normalizeTournamentRatingLabel(direct);
      if (normalizedDirect) return normalizedDirect;
    }

    const accessRange = formatAccessLevelRange(state.accessLevels);
    if (accessRange) {
      const normalizedRange = normalizeTournamentRatingLabel(accessRange);
      if (normalizedRange) return normalizedRange;
    }

    const min = pickString(state, ["minRating", "ratingFrom", "ratingMin", "levelFrom"]);
    const max = pickString(state, ["maxRating", "ratingTo", "ratingMax", "levelTo"]);
    if (min && max) {
      const normalizedMinMax = normalizeTournamentRatingLabel(min === max ? min : `${min}/${max}`);
      if (normalizedMinMax) return normalizedMinMax;
    }
    if (min || max) {
      const normalizedBound = normalizeTournamentRatingLabel(min || max || null);
      if (normalizedBound) return normalizedBound;
    }
  }

  return null;
}

function isCancelledTournamentPayload(value: unknown) {
  return isTournamentSignupPayloadCancelled(value);
}

function isHiddenTournamentPayload(value: unknown) {
  if (isCancelledTournamentPayload(value)) return true;
  return collectTournamentStateRecords(value).some((record) => (
    isPrivateTournamentRecord(record)
    || ["skinStatus", "tournamentStatus", "customStatus", "publicationStatus"]
      .some((key) => isClosedStatusValue(record[key]))
  ));
}

function normalizeRegistration(value: unknown): TournamentRegistrationState | null {
  if (!isRecord(value)) return null;
  const statusRaw = String(pickString(value, ["status", "state", "registrationStatus"]) || "NONE").toUpperCase();
  const paymentUrl = extractPaymentUrl(value);
  const isPaymentPending = hasPendingPaymentStatus(value);
  const status =
    isPaymentPending
      ? "PAYMENT_PENDING"
      : statusRaw === "REGISTERED" || statusRaw === "CONFIRMED"
      ? "REGISTERED"
      : statusRaw === "WAITLIST" || statusRaw === "WAITLISTED"
        ? "WAITLIST"
        : "NONE";

  return {
    status,
    bookingId: pickString(value, ["bookingId", "id"]),
    placeNumber: pickNumber(value, ["placeNumber", "position", "participantPosition"]),
    waitlistNumber: pickNumber(value, ["waitlistNumber", "waitlistPosition", "queuePosition"]),
    canRegister: value.canRegister !== false && status !== "PAYMENT_PENDING",
    canCancel: value.canCancel !== false && status !== "NONE",
    message: status === "PAYMENT_PENDING"
      ? "Запись создана в Viva, ожидается оплата."
      : pickString(value, ["message", "reason", "note"]),
    paymentUrl,
    paymentExpiresAt: pickString(value, ["paymentExpiresAt", "paymentDeadline", "paymentDeadlineAt", "expiresAt"]),
  };
}

function formatTimeRange(startsAt: string | null, endsAt: string | null) {
  const start = startsAt ? new Date(startsAt) : null;
  const end = endsAt ? new Date(endsAt) : null;
  const startValid = start && !Number.isNaN(start.getTime());
  const endValid = end && !Number.isNaN(end.getTime());
  if (!startValid) return "Время уточняется";
  const startLabel = start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!endValid) return startLabel;
  const endLabel = end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${startLabel} - ${endLabel}`;
}

function formatDate(startsAt: string | null) {
  if (!startsAt) return null;
  const parsed = new Date(startsAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function formatDiscountReasonDate(startsAt: string | null, fallbackDate: string | null) {
  const source = startsAt || fallbackDate;
  if (!source) return null;
  const parsed = new Date(source);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  }
  return fallbackDate;
}

function normalizeTournamentSummary(value: unknown): TournamentSignupSummary | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "tournamentId", "uuid", "exerciseId"]);
  if (!id) return null;
  const exerciseId = resolveTournamentSignupExerciseId(value) || id;
  const storedPricing = buildStoredTournamentPricingSnapshot(value);

  const studio = pickNestedRecord(value, ["studio", "station", "club", "location"]);
  const startsAt = pickString(value, ["startsAt", "startAt", "timeFrom", "dateTimeFrom", "startTime"]);
  const endsAt = pickString(value, ["endsAt", "endAt", "timeTo", "dateTimeTo", "endTime"]);
  const price = pickNumber(value, ["price", "amount", "cost"]);
  const currency = pickString(value, ["currency", "currencyCode"]) || "RUB";
  const maxParticipants = pickNumber(value, ["maxParticipants", "maxPlayers", "limit", "capacity"]);
  const participantsCount = pickNumber(value, ["participantsCount", "registeredCount", "playersCount", "joinedCount"]);
  const waitlistCount = pickNumber(value, ["waitlistCount", "queueCount"]);
  const trainer = pickTournamentTrainer(value);

  return {
    id,
    exerciseId,
    title: pickString(value, ["title", "name", "displayName"]) || "Турнир",
    startsAt,
    endsAt,
    date: pickString(value, ["date", "day"]) || formatDate(startsAt),
    timeLabel: formatTimeRange(startsAt, endsAt),
    studioName: pickString(value, ["studioName", "stationName", "clubName"]) || pickString(studio, ["name", "title"]),
    address: pickString(value, ["address", "studioAddress"]) || pickString(studio, ["address", "fullAddress"]),
    format: pickString(value, ["format", "tournamentType", "type", "category"]),
    levelLabel: buildTournamentLevelLabel(value),
    priceLabel: pickString(value, ["priceLabel", "priceText"]) || (price != null ? `${price.toLocaleString("ru-RU")} ${currency}` : null),
    participantsCount,
    maxParticipants,
    waitlistCount,
    status: isCancelledTournamentPayload(value)
      ? "CANCELLED"
      : normalizeStatus(pickString(value, ["status", "rawStatus", "registrationStatus", "state"])),
    trainerName: trainer.name,
    trainerAvatarUrl: trainer.avatarUrl,
    publicUrl: pickString(value, ["publicUrl", "url", "link"]),
    storedPricingPreview: storedPricing.pricingPreview,
    storedHasFriendlySubscriptionTag: storedPricing.hasFriendlySubscriptionTag,
    storedSummerSubscriptionOffer: storedPricing.summerSubscriptionOffer,
    raw: value,
  };
}

function normalizeTournamentDetail(value: unknown): TournamentSignupDetail | null {
  const summary = normalizeTournamentSummary(value);
  if (!summary) return null;
  const registration = normalizeRegistration(
    isRecord(value) ? value.registration || value.myRegistration || value.viewerRegistration : null,
  );
  return {
    ...summary,
    description: pickString(value, ["description", "body", "text", "details"]),
    rules: pickString(value, ["rules", "policy"]),
    registration,
  };
}

function normalizePublicTournamentPath(value: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/api/")) return raw.slice(4);
  if (raw.startsWith("api/")) return `/${raw.slice(4)}`;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function isPublicTournamentApiPath(value: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return false;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return /^\/tournaments\/public\/[^/?#]+$/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  return /^\/tournaments\/public\/[^/?#]+$/i.test(raw);
}

function resolvePublicTournamentPath(value: unknown) {
  const records = collectTournamentStateRecords(value);
  for (const record of records) {
    const normalizedPath = normalizePublicTournamentPath(
      pickString(record, ["publicUrl", "joinUrl"]),
    );
    if (normalizedPath) return normalizedPath;
  }
  return null;
}

function shouldHideByPublicTournamentDetail(
  summary: TournamentSignupSummary,
  detailPayload: unknown,
) {
  if (isHiddenTournamentPayload(detailPayload)) return true;
  if (!isRecord(detailPayload)) return false;

  const registrationOpen = detailPayload.registrationOpen;
  if (registrationOpen !== false) return false;

  const sourceTournamentId =
    pickString(detailPayload, ["sourceTournamentId", "vivaExerciseId", "exerciseId"])
    || pickString(pickNestedRecord(detailPayload, ["booking"]), ["vivaExerciseId", "exerciseId"])
    || pickString(pickNestedRecord(detailPayload, ["sourceTournament"]), ["id"]);
  if (sourceTournamentId && sourceTournamentId !== summary.id) return false;

  return true;
}

async function shouldShowTournamentSummary(summary: TournamentSignupSummary) {
  if (summary.status === "CANCELLED" || isHiddenTournamentPayload(summary.raw)) return false;

  const publicPath = resolvePublicTournamentPath(summary.raw);
  if (!publicPath) return false;
  if (!isPublicTournamentApiPath(publicPath)) return true;

  const detailResult = await request<unknown>(publicPath, {
    ...buildTournamentApiRequestOptions(),
    method: "GET",
    headers: phabHeaders(),
    retries: 1,
  });
  if (detailResult.error) {
    const errorStatus = detailResult.error.status;
    if (errorStatus === 401 || errorStatus === 403 || errorStatus === 404 || errorStatus === 410) {
      return false;
    }
    return true;
  }

  return !shouldHideByPublicTournamentDetail(summary, detailResult.data);
}

async function filterVisibleTournamentSummaries(items: TournamentSignupSummary[]) {
  const visibility = await Promise.all(items.map((item) => shouldShowTournamentSummary(item)));
  return items.filter((_, index) => visibility[index]);
}

function extractItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["items", "content", "data", "tournaments", "results"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeTournamentSignupSummaries(payload: unknown) {
  return extractItems(payload)
    .map((item) => normalizeTournamentSummary(item))
    .filter((item): item is TournamentSignupSummary => item !== null);
}

function isLikelyPaymentUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const parsed = new URL(value);
    const searchable = `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    if (/(pay|tbank|tinkoff|payment|checkout|bank|acquir)/.test(searchable)) return true;
    return ["payment", "transaction", "order", "invoice"].some((key) => parsed.searchParams.has(key));
  } catch {
    return false;
  }
}

function extractPaymentUrlFromString(value: string): string | null {
  const normalized = value.trim();
  if (isLikelyPaymentUrl(normalized)) return normalized;

  const urls = normalized.match(/https?:\/\/[^\s"'<>\\]+/gi) ?? [];
  for (const url of urls) {
    const cleaned = url.split("\u0000", 1)[0].replace(/[),.;\]]+$/g, "");
    if (isLikelyPaymentUrl(cleaned)) return cleaned;
  }
  return null;
}

function extractPaymentUrl(payload: unknown): string | null {
  const visit = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value === "string") {
      return extractPaymentUrlFromString(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    for (const key of ["paymentUrl", "redirectUrl", "paymentLink", "checkoutUrl", "cardPaymentUrl", "paymentPageUrl", "url", "link"]) {
      const direct = visit(value[key]);
      if (direct) return direct;
    }
    for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "cardPaymentInfo", "payment"]) {
      const nested = visit(value[key]);
      if (nested) return nested;
    }
    return null;
  };
  return visit(payload);
}

function extractBookingId(payload: unknown): string | null {
  const visit = (value: unknown): string | null => {
    if (value == null) return null;
    if (typeof value === "string") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    const direct = pickString(value, ["bookingId", "booking_id"]);
    if (direct) return direct;

    const bookingLike =
      Object.prototype.hasOwnProperty.call(value, "spot")
      || Object.prototype.hasOwnProperty.call(value, "isCancelled")
      || Object.prototype.hasOwnProperty.call(value, "visitConfirmed")
      || Object.prototype.hasOwnProperty.call(value, "transactionStatus")
      || Object.prototype.hasOwnProperty.call(value, "paymentType")
      || Object.prototype.hasOwnProperty.call(value, "exercise");
    if (bookingLike) {
      const id = pickString(value, ["id", "uuid"]);
      if (id) return id;
    }

    for (const key of [
      "inBooking",
      "booking",
      "bookings",
      "createdBooking",
      "createdBookings",
      "bookingInfo",
      "payload",
      "data",
      "result",
      "transaction",
      "transactionStatus",
    ]) {
      const nested = visit(value[key]);
      if (nested) return nested;
    }
    return null;
  };
  return visit(payload);
}

function hasPendingPaymentStatus(payload: unknown): boolean {
  const visit = (value: unknown): boolean | null => {
    if (value == null) return null;
    if (typeof value === "string") {
      const normalized = value.trim().toUpperCase();
      if (!normalized) return null;
      if (
        normalized.includes("WAIT")
        || normalized.includes("PENDING")
        || normalized.includes("CREATED")
        || normalized.includes("NEW")
        || normalized.includes("RESERVED")
        || normalized.includes("ОЖИД")
      ) return true;
      if (
        normalized.includes("PAID")
        || normalized.includes("COMPLETED")
        || normalized.includes("CONFIRMED")
        || normalized.includes("SUCCESS")
        || normalized.includes("ОПЛАЧ")
      ) return false;
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested !== null) return nested;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    for (const key of ["transactionStatus", "paymentStatus", "status", "originalStatus", "cardPaymentStatus", "cardPaymentInfo", "paymentType"]) {
      const direct = visit(value[key]);
      if (direct !== null) return direct;
    }
    for (const key of ["transaction", "transactionStatus", "cardPaymentStatus", "cardPaymentInfo", "payment", "paymentInfo", "data", "payload", "result"]) {
      const nested = visit(value[key]);
      if (nested !== null) return nested;
    }
    return null;
  };

  return visit(payload) === true;
}

function hasPaidPaymentStatus(payload: unknown): boolean {
  const visit = (value: unknown): boolean | null => {
    if (value == null) return null;
    if (typeof value === "string") {
      const normalized = value.trim().toUpperCase();
      if (!normalized) return null;
      if (
        normalized.includes("PAID")
        || normalized.includes("COMPLETED")
        || normalized.includes("CONFIRMED")
        || normalized.includes("SUCCESS")
        || normalized.includes("SUCCEEDED")
        || normalized.includes("ОПЛАЧ")
      ) return true;
      if (
        normalized.includes("WAIT")
        || normalized.includes("PENDING")
        || normalized.includes("CREATED")
        || normalized.includes("NEW")
        || normalized.includes("RESERVED")
        || normalized.includes("ОЖИД")
      ) return false;
      return null;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested !== null) return nested;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    for (const key of ["transactionStatus", "paymentStatus", "status", "originalStatus", "cardPaymentStatus", "cardPaymentInfo", "paymentType"]) {
      const direct = visit(value[key]);
      if (direct !== null) return direct;
    }
    for (const key of ["transaction", "transactionStatus", "cardPaymentStatus", "cardPaymentInfo", "payment", "paymentInfo", "data", "payload", "result"]) {
      const nested = visit(value[key]);
      if (nested !== null) return nested;
    }
    return null;
  };

  return visit(payload) === true;
}

function extractTransactionId(payload: unknown): string | null {
  const visit = (value: unknown): string | null => {
    if (value == null || typeof value === "string") return null;
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }
    if (!isRecord(value)) return null;

    const direct = pickString(value, ["transactionId", "transaction_id"]);
    if (direct) return direct;

    const transactionLike =
      Object.prototype.hasOwnProperty.call(value, "transactionStatus")
      || Object.prototype.hasOwnProperty.call(value, "cardPaymentStatus")
      || Object.prototype.hasOwnProperty.call(value, "paymentUrl")
      || Object.prototype.hasOwnProperty.call(value, "toPay");
    if (transactionLike) {
      const id = pickString(value, ["id", "uuid"]);
      if (id) return id;
    }

    for (const key of ["transaction", "transactionStatus", "cardPaymentStatus", "payment", "data", "payload", "result"]) {
      const nested = visit(value[key]);
      if (nested) return nested;
    }
    return null;
  };

  if (isRecord(payload)) {
    const direct = pickString(payload, ["transactionId", "transaction_id"]);
    if (direct) return direct;
    if (
      !Object.prototype.hasOwnProperty.call(payload, "spot")
      && !Object.prototype.hasOwnProperty.call(payload, "exercise")
      && !Object.prototype.hasOwnProperty.call(payload, "paymentType")
    ) {
      const id = pickString(payload, ["id", "uuid"]);
      if (id) return id;
    }
  }
  return visit(payload);
}

function getVivaBookingTransactionId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const transactionStatus = pickNestedRecord(value, ["transactionStatus", "transaction"]);
  return pickString(transactionStatus, ["transactionId", "id", "uuid"])
    || pickString(value, ["transactionId", "transaction_id"]);
}

function isVivaBookingCancelled(value: unknown) {
  if (!isRecord(value)) return true;
  return String(pickString(value, ["status", "state"]) || "").toUpperCase().includes("CANCEL")
    || value.isCancelled === true;
}

interface TournamentVivaPaymentResolution {
  paymentUrl: string | null;
  bookingId: string | null;
  toPay: number | null;
  paid: boolean | null;
  paymentExpiresAt: string | null;
  raw: unknown;
}

function buildPaymentExpiresAt(startedAtMs = Date.now()) {
  return new Date(startedAtMs + 20 * 60 * 1000).toISOString();
}

function normalizeTournamentVivaPaymentResolution(value: unknown): TournamentVivaPaymentResolution | null {
  if (!isRecord(value)) return null;
  const paymentUrl = extractPaymentUrl(value);
  const toPay = extractToPay(value);
  const paid = hasPaidPaymentStatus(value)
    ? true
    : hasPendingPaymentStatus(value) || paymentUrl
      ? false
      : toPay != null && toPay <= 0
        ? true
        : null;

  return {
    paymentUrl,
    bookingId: pickString(value, ["id", "bookingId"]) || extractBookingId(value),
    toPay,
    paid,
    paymentExpiresAt: pickString(value, ["paymentExpiresAt", "paymentDeadline", "paymentDeadlineAt", "expiresAt"]),
    raw: value,
  };
}

function normalizeTournamentVivaTransactionResolution(
  value: unknown,
  fallbackPaymentExpiresAt: string | null,
): TournamentVivaPaymentResolution | null {
  if (!isRecord(value)) return null;
  const normalized = normalizeServerTournamentTransactionResult(value, fallbackPaymentExpiresAt);
  return {
    paymentUrl: normalized.paymentUrl,
    bookingId: normalized.bookingId,
    toPay: normalized.toPay,
    paid: normalized.paid,
    paymentExpiresAt: normalized.paymentExpiresAt,
    raw: normalized.raw,
  };
}

function isResolvedTournamentVivaPayment(value: TournamentVivaPaymentResolution | null | undefined) {
  return Boolean(value?.paymentUrl || value?.paid === true);
}

function findTournamentVivaPaymentResolution(
  payload: unknown,
  exerciseId: string,
  transactionId: string | null,
  allowSingleExerciseBooking: boolean,
): TournamentVivaPaymentResolution | null {
  const candidates = extractItems(payload)
    .filter((item) => isRecord(item))
    .filter((item) => isVivaBookingForExercise(item, exerciseId))
    .filter((item) => !isVivaBookingCancelled(item));

  const matched = transactionId
    ? candidates.find((item) => getVivaBookingTransactionId(item) === transactionId) ?? null
    : null;
  const scoped = matched
    ? [matched]
    : transactionId
      ? (allowSingleExerciseBooking && candidates.length === 1 ? candidates : [])
      : candidates;
  const booking =
    scoped.find((item) => extractPaymentUrl(item)) ??
    scoped.find((item) => hasPendingPaymentStatus(item)) ??
    scoped.find((item) => hasPaidPaymentStatus(item)) ??
    (allowSingleExerciseBooking && scoped.length === 1 ? scoped[0] : null);

  return booking ? normalizeTournamentVivaPaymentResolution(booking) : null;
}

async function fetchTournamentVivaPaymentResolution(
  exerciseId: string,
  transactionId: string | null,
): Promise<TournamentVivaPaymentResolution | null> {
  const [ownBookingsResult, exerciseBookingsResult] = await Promise.all([
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/bookings?size=1000`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}/bookings`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
  ]);

  if (!ownBookingsResult.error) {
    const ownResolution = findTournamentVivaPaymentResolution(
      ownBookingsResult.data,
      exerciseId,
      transactionId,
      true,
    );
    if (ownResolution) return ownResolution;
  }

  if (!exerciseBookingsResult.error) {
    const exerciseResolution = findTournamentVivaPaymentResolution(
      exerciseBookingsResult.data,
      exerciseId,
      transactionId,
      Boolean(transactionId),
    );
    if (exerciseResolution) return exerciseResolution;
  }

  return null;
}

async function fetchTournamentVivaTransactionResolution(
  transactionId: string,
  fallbackPaymentExpiresAt: string | null,
): Promise<TournamentVivaPaymentResolution | null> {
  const normalizedTransactionId = String(transactionId || "").trim();
  if (!normalizedTransactionId) return null;

  const encodedTransactionId = encodeURIComponent(normalizedTransactionId);
  const paths = [
    "/end-user/api/v2/" + TENANT_KEY + "/transactions/" + encodedTransactionId,
    "/end-user/api/v1/" + TENANT_KEY + "/transactions/" + encodedTransactionId,
  ];

  for (const path of paths) {
    const result = await request<unknown>(path, {
      method: "GET",
      auth: true,
      retries: 1,
    });
    if (result.error) continue;

    const normalized = normalizeTournamentVivaTransactionResolution(result.data, fallbackPaymentExpiresAt);
    if (normalized) return normalized;
  }

  return null;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pollTournamentVivaPaymentResolution(
  exerciseId: string,
  transactionId: string | null,
): Promise<TournamentVivaPaymentResolution | null> {
  let lastResolution: TournamentVivaPaymentResolution | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const resolution = await fetchTournamentVivaPaymentResolution(exerciseId, transactionId);
    if (resolution?.paymentUrl || resolution?.paid === true) return resolution;
    if (resolution) lastResolution = resolution;
    await wait(750);
  }
  return lastResolution;
}

async function pollTournamentVivaTransactionResolution(
  transactionId: string | null,
  transactionStartedAtMs: number,
): Promise<TournamentVivaPaymentResolution | null> {
  const normalizedTransactionId = String(transactionId || "").trim();
  if (!normalizedTransactionId) return null;

  const fallbackPaymentExpiresAt = buildPaymentExpiresAt(transactionStartedAtMs);
  let lastResolution: TournamentVivaPaymentResolution | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const resolution = await fetchTournamentVivaTransactionResolution(
      normalizedTransactionId,
      fallbackPaymentExpiresAt,
    );
    if (isResolvedTournamentVivaPayment(resolution)) return resolution;
    if (resolution) lastResolution = resolution;
    await wait(750);
  }
  return lastResolution;
}

async function awaitPreferredTournamentPaymentResolution(
  promises: Array<Promise<TournamentVivaPaymentResolution | null>>,
): Promise<TournamentVivaPaymentResolution | null> {
  if (promises.length === 0) return null;

  return new Promise((resolve) => {
    let settled = false;
    let pending = promises.length;
    let fallback: TournamentVivaPaymentResolution | null = null;

    const finish = (value: TournamentVivaPaymentResolution | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    for (const promise of promises) {
      void promise
        .then((value) => {
          if (settled) return;
          if (isResolvedTournamentVivaPayment(value)) {
            finish(value);
            return;
          }
          if (!fallback && value) fallback = value;
          pending -= 1;
          if (pending === 0) finish(fallback);
        })
        .catch(() => {
          if (settled) return;
          pending -= 1;
          if (pending === 0) finish(fallback);
        });
    }
  });
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function normalizeVivaBookingRegistration(value: unknown, profile: UserProfileType): TournamentRegistrationState | null {
  if (!isRecord(value)) return null;
  const client = isRecord(value.client) ? value.client : null;
  const profilePhone = normalizePhone(profile.phone);
  const bookingPhone = normalizePhone(pickString(client, ["phone", "phoneNumber"]) || pickString(value, ["phone", "clientPhone"]));
  const profileId = String(profile.id || "").trim();
  const bookingClientId = pickString(client, ["id", "clientId"]) || pickString(value, ["clientId"]);
  const isMine = Boolean(
    (profileId && bookingClientId && profileId === bookingClientId)
    || (profilePhone && bookingPhone && profilePhone === bookingPhone),
  );
  if (!isMine) return null;

  const cancelled = String(pickString(value, ["status", "state"]) || "").toUpperCase().includes("CANCEL")
    || value.isCancelled === true;
  if (cancelled) return null;

  return normalizeRegistration({
    ...value,
    bookingId: pickString(value, ["id", "bookingId"]),
    status: hasPendingPaymentStatus(value) ? "PAYMENT_PENDING" : "REGISTERED",
    placeNumber: pickNumber(value, ["spot", "placeNumber", "position"]),
  });
}

function isVivaBookingForExercise(value: unknown, exerciseId: string) {
  if (!isRecord(value)) return false;
  const exercise = isRecord(value.exercise) ? value.exercise : null;
  const nestedExerciseId = pickString(exercise, ["id", "exerciseId", "uuid"]);
  const directExerciseId = pickString(value, ["exerciseId", "vivaExerciseId"]);
  return [nestedExerciseId, directExerciseId].some((id) => id === exerciseId);
}

function normalizeVivaOwnBookingRegistration(value: unknown): TournamentRegistrationState | null {
  if (!isRecord(value)) return null;

  const cancelled = String(pickString(value, ["status", "state"]) || "").toUpperCase().includes("CANCEL")
    || value.isCancelled === true;
  if (cancelled) return null;

  return normalizeRegistration({
    ...value,
    bookingId: pickString(value, ["id", "bookingId"]),
    status: hasPendingPaymentStatus(value) ? "PAYMENT_PENDING" : "REGISTERED",
    placeNumber: pickNumber(value, ["spot", "placeNumber", "position"]),
  });
}

async function fetchTournamentVivaMyBooking(
  exerciseId: string,
  options: {
    placeNumber?: number | null;
  } = {},
): Promise<ApiResult<unknown>> {
  const [profileResult, exerciseResult, bookingsResult, ownBookingsResult] = await Promise.all([
    request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}/bookings`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/bookings?size=1000`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
  ]);

  if (profileResult.error || !profileResult.data) {
    return {
      data: null,
      error: profileResult.error || { status: 401, message: "Не удалось получить профиль Viva" },
      status: profileResult.status,
    };
  }

  if (!exerciseResult.error) {
    const directBookingId = extractBookingId(exerciseResult.data);
    if (directBookingId) {
      return {
        data: { id: directBookingId, bookingId: directBookingId, status: "REGISTERED" },
        error: null,
        status: exerciseResult.status,
      };
    }
  }

  if (!ownBookingsResult.error) {
    const ownBooking = extractItems(ownBookingsResult.data)
      .find((item) => isVivaBookingForExercise(item, exerciseId) && normalizeVivaOwnBookingRegistration(item) !== null)
      ?? null;
    if (ownBooking) {
      return {
        data: ownBooking,
        error: null,
        status: ownBookingsResult.status,
      };
    }
  }

  if (bookingsResult.error) {
    return {
      data: null,
      error: bookingsResult.error,
      status: bookingsResult.status,
    };
  }

  const exerciseBookings = extractItems(bookingsResult.data)
    .filter((item) => isVivaBookingForExercise(item, exerciseId))
    .filter((item) => {
      if (!isRecord(item)) return false;
      const cancelled = String(pickString(item, ["status", "state"]) || "").toUpperCase().includes("CANCEL")
        || item.isCancelled === true;
      return !cancelled;
    });

  const booking = exerciseBookings
    .find((item) => normalizeVivaBookingRegistration(item, profileResult.data as UserProfileType) !== null)
    ?? (
      options.placeNumber != null
        ? exerciseBookings.find((item) => pickNumber(item, ["spot", "placeNumber", "position"]) === options.placeNumber)
        : null
    )
    ?? (exerciseBookings.length === 1 ? exerciseBookings[0] : null)
    ?? null;

  return {
    data: booking,
    error: null,
    status: bookingsResult.status || profileResult.status,
  };
}

function normalizeCost(value: unknown) {
  const cost = pickNumber(value, ["cost", "trialCost", "price", "amount"]);
  return cost == null ? null : Math.max(0, Math.round(cost));
}

function normalizeVivaProduct(
  value: unknown,
  source: TournamentVivaProduct["source"],
): TournamentVivaProduct | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, source === "client-subscription"
    ? ["clientSubscriptionId", "subscriptionId", "id", "productId", "uuid"]
    : ["id", "productId", "subscriptionId", "clientSubscriptionId", "oneTimeId", "clientOneTimeId", "uuid"]);
  if (!id) return null;
  const rawType = String(pickString(value, ["productType", "type"]) || "").trim().toUpperCase();
  const type: TournamentVivaProductType =
    rawType === "SERVICE"
    || rawType === "GOODS"
    || rawType === "INSTANT_SUB_SERVICE"
    || rawType === "ADVANCE_SUB_SERVICE"
    || rawType === "COMMISSION"
    || rawType === "FULL_PAYMENT_SERVICE"
    || rawType === "SUBSCRIPTION"
    || rawType === "DEPOSIT"
      ? rawType
      : source === "subscription" || source === "client-subscription"
        ? "SUBSCRIPTION"
        : "SERVICE";
  return {
    id,
    name: pickString(value, ["name", "title", "displayName"]) || "Продукт Viva",
    type,
    cost: normalizeCost(value),
    visitsTotal: pickNumber(value, ["visitsTotal", "visits", "count", "visitsCount"]),
    source,
    raw: value,
  };
}

function normalizeVivaProducts(items: unknown[], source: TournamentVivaProduct["source"]) {
  return items
    .map((item) => normalizeVivaProduct(item, source))
    .filter((item): item is TournamentVivaProduct => item !== null);
}

function pickSubscriptionLookupId(value: unknown) {
  if (!isRecord(value)) return null;
  return pickString(value, ["clientSubscriptionId", "subscriptionId", "id"]);
}

async function resolveClientSubscriptionProductNames(
  products: TournamentVivaProduct[],
  clientPhone: string | null | undefined,
) {
  const phone = String(clientPhone || "").trim();
  if (!phone || products.length === 0) return products;

  const resolved = await Promise.all(products.map(async (product) => {
    if (product.source !== "client-subscription") return product;
    const lookupId = pickSubscriptionLookupId(product.raw);
    if (!lookupId) return product;

    const nameResult = await apiFetchSubscriptioName(lookupId, phone);
    const resolvedName = nameResult.data?.sertName?.trim();
    if (!resolvedName) return product;

    return {
      ...product,
      name: resolvedName,
    };
  }));

  return resolved;
}

function collectComparableIds(value: unknown, keys: string[], seen = new Set<unknown>()): Set<string> {
  const ids = new Set<string>();
  if (value == null || seen.has(value)) return ids;
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) ids.add(text);
    return ids;
  }
  if (typeof value !== "object") return ids;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectComparableIds(item, keys, seen).forEach((id) => ids.add(id));
    });
    return ids;
  }

  if (!isRecord(value)) return ids;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" || typeof direct === "number") {
      const text = String(direct).trim();
      if (text) ids.add(text);
    } else if (Array.isArray(direct)) {
      direct.forEach((item) => {
        collectComparableIds(item, keys, seen).forEach((id) => ids.add(id));
      });
    } else if (isRecord(direct)) {
      const nestedId = pickString(direct, ["id", "uuid", "exerciseId", "typeId", "directionId"]);
      if (nestedId) ids.add(nestedId);
    }
  }
  Object.values(value).forEach((nested) => {
    if (nested && typeof nested === "object") {
      collectComparableIds(nested, keys, seen).forEach((id) => ids.add(id));
    }
  });
  return ids;
}

function collectExerciseTypeIds(exercise: Record<string, unknown>) {
  return collectComparableIds(exercise, [
    "type",
    "exerciseType",
    "exerciseTypeId",
    "typeId",
    "vivaExerciseTypeId",
    "direction",
    "directionId",
    "vivaDirectionId",
  ]);
}

function isClientSubscriptionActive(product: TournamentVivaProduct) {
  const raw = product.raw;
  if (!isRecord(raw)) return true;
  const status = String(pickString(raw, ["status", "state", "subscriptionStatus"]) || "").trim().toUpperCase();
  if (
    status.includes("EXPIRED")
    || status.includes("CANCEL")
    || status.includes("BLOCK")
    || status.includes("ARCHIVE")
    || status.includes("ЗАВЕРШ")
    || status.includes("ОТМЕН")
  ) return false;

  const activeTo = pickString(raw, ["activeTo", "validTo", "dateTo", "expiresAt", "expirationDate"]);
  if (activeTo) {
    const activeToTs = Date.parse(activeTo);
    if (Number.isFinite(activeToTs) && activeToTs < Date.now()) return false;
  }

  const visitsLeft = pickNumber(raw, ["visitsLeft", "availableVisits", "balance", "remainingVisits", "left"]);
  if (visitsLeft != null && visitsLeft <= 0) return false;
  return true;
}

function filterClientSubscriptionsForExercise(
  products: TournamentVivaProduct[],
  exerciseId: string,
  exercise: Record<string, unknown>,
) {
  const exerciseTypeIds = collectExerciseTypeIds(exercise);
  return products.filter((product) => {
    if (!isClientSubscriptionActive(product)) return false;
    const raw = product.raw;
    const productExerciseIds = collectComparableIds(raw, [
      "exerciseId",
      "vivaExerciseId",
      "availableExerciseIds",
      "exerciseIds",
      "sourceExerciseId",
    ]);
    if (productExerciseIds.size > 0) return productExerciseIds.has(exerciseId);

    const productTypeIds = collectComparableIds(raw, [
      "exerciseTypeId",
      "exerciseTypeIds",
      "typeId",
      "typeIds",
      "vivaExerciseTypeId",
      "directionId",
      "directionIds",
      "vivaDirectionId",
    ]);
    if (productTypeIds.size > 0 && exerciseTypeIds.size > 0) {
      return Array.from(productTypeIds).some((id) => exerciseTypeIds.has(id));
    }
    return true;
  });
}

function extractToPay(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return pickNumber(payload, ["toPay", "amount", "total", "cost"]);
}

function extractAuthorizationTicket(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!isRecord(payload)) return null;
  return pickString(payload, ["ticket", "token", "authorizationTicket", "id"])
    || extractAuthorizationTicket(payload.data)
    || extractAuthorizationTicket(payload.payload);
}

function decodeBase64UrlSegment(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  const base64 = normalized
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(normalized.length / 4) * 4, "=");

  try {
    if (typeof atob === "function") {
      const binary = atob(base64);
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }
  } catch {
    // Fallback below
  }

  try {
    const bufferCtor = typeof Reflect !== "undefined"
      ? Reflect.get(globalThis, "Buffer")
      : undefined;
    if (bufferCtor && typeof bufferCtor.from === "function") {
      return bufferCtor.from(base64, "base64").toString("utf8");
    }
  } catch {
    // ignore invalid JWT payloads
  }

  return null;
}

function extractAuthTokenJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  const normalized = String(token || "").trim();
  if (!normalized) return null;

  const segments = normalized.split(".");
  if (segments.length < 2) return null;

  const payloadText = decodeBase64UrlSegment(segments[1]);
  if (!payloadText) return null;

  try {
    const payload = JSON.parse(payloadText) as unknown;
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function resolveVivaSocketUserId(clientId: string | null | undefined) {
  const authToken = readAuthToken();
  const authPayload = extractAuthTokenJwtPayload(authToken);
  const authSub = pickString(authPayload, ["sub", "userId"]);
  if (authSub) return authSub;

  const normalizedClientId = String(clientId || "").trim();
  return normalizedClientId || null;
}

function extractStompFrameBody(message: string): string | null {
  if (typeof message !== "string" || !message) return null;
  const separatorIndex = message.indexOf("\n\n");
  if (separatorIndex === -1) return null;
  let body = message.slice(separatorIndex + 2);
  while (body.endsWith("\u0000")) {
    body = body.slice(0, -1);
  }
  body = body.trim();
  return body || null;
}

function parseVivaSocketPayload(message: string): unknown | null {
  if (typeof message !== "string" || !message) return null;

  const candidates = [message, extractStompFrameBody(message)].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

async function createVivaSocketWatcher<T>(
  clientId: string | null | undefined,
  resolvePayload: (payload: unknown, rawMessage: string) => T | null,
) {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    return null;
  }

  const socketUserId = resolveVivaSocketUserId(clientId);
  if (!socketUserId) return null;

  const ticketResult = await request<unknown>(`${API_BASE}/api/v1/authorization-tickets/eu`, {
    method: "POST",
    auth: true,
    retries: 1,
  });
  const ticket = ticketResult.error ? null : extractAuthorizationTicket(ticketResult.data);
  if (!ticket) return null;

  const wsBase = API_BASE.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:").replace(/\/+$/, "");
  let socket: WebSocket | null = null;
  let settled = false;
  let resolveWait: (value: T | null) => void = () => {};
  const wait = new Promise<T | null>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (value: T | null) => {
    if (settled) return;
    settled = true;
    resolveWait(value);
    socket?.close();
  };

  try {
    socket = new WebSocket(`${wsBase}/ws/eu/v1?ticket=${encodeURIComponent(ticket)}`);
    socket.addEventListener("open", () => {
      socket?.send("CONNECT\naccept-version:1.2,1.1,1.0\nheart-beat:0,10000\n\n\u0000");
    });
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      if (text.startsWith("CONNECTED")) {
        socket?.send(
          `SUBSCRIBE\nid:sub-0\ndestination:/messages/eu/users/${socketUserId}/events\n\n\u0000`,
        );
        return;
      }
      const payload = parseVivaSocketPayload(text);
      const resolved = resolvePayload(payload, text);
      if (resolved !== null) finish(resolved);
    });
    socket.addEventListener("error", () => finish(null));
    socket.addEventListener("close", () => finish(null));
  } catch {
    finish(null);
  }

  const timeout = window.setTimeout(() => finish(null), 15_000);
  return {
    wait: wait.finally(() => window.clearTimeout(timeout)),
    close: () => finish(null),
  };
}

async function createVivaPaymentWatcher(clientId?: string | null) {
  return createVivaSocketWatcher<string>(
    clientId,
    (payload, rawMessage) => extractPaymentUrl(payload) || extractPaymentUrl(rawMessage),
  );
}

function mapTournamentVivaFailureMessage(errorText: string | null | undefined): string | null {
  const normalized = String(errorText || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("no available spots")) return "В турнире нет свободных мест";
  return null;
}

async function createVivaBookingWatcher(
  clientId: string | null | undefined,
  correlationId: string,
) {
  return createVivaSocketWatcher<{ status: string; action: string | null; error: string | null; raw: unknown }>(
    clientId,
    (payload) => {
      if (!isRecord(payload)) return null;
      if (pickString(payload, ["correlationId"]) !== correlationId) return null;
      const action = String(pickString(payload, ["action"]) || "").toUpperCase();
      const status = String(pickString(payload, ["status"]) || "").toUpperCase();
      if (!["COMPLETED", "FAILED", "ERROR", "CANCELLED"].includes(status)) return null;
      const error = pickString(payload, ["error", "message", "reason", "description"]);
      return { status, action: action || null, error, raw: payload };
    },
  );
}

function buildTournamentPaymentReturnUrls(exerciseId: string) {
  if (typeof window === "undefined") return { successUrl: null, failUrl: null };

  const href = window.location.href;
  try {
    const successUrl = new URL(href);
    successUrl.searchParams.set("TorneosPADL_exercise", exerciseId);
    successUrl.searchParams.set("TorneosPADL_paymentsuccess", "true");
    successUrl.searchParams.delete("TorneosPADL_paymentfailed");

    const failUrl = new URL(href);
    failUrl.searchParams.set("TorneosPADL_exercise", exerciseId);
    failUrl.searchParams.set("TorneosPADL_paymentfailed", "true");
    failUrl.searchParams.delete("TorneosPADL_paymentsuccess");

    return {
      successUrl: appendCurrentAuthModeToNavigableUrl(successUrl).toString(),
      failUrl: appendCurrentAuthModeToNavigableUrl(failUrl).toString(),
    };
  } catch {
    return { successUrl: null, failUrl: null };
  }
}

function buildQuery(params: Record<string, QueryValue>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    query.set(key, String(value));
  });
  const value = query.toString();
  return value ? `?${value}` : "";
}

function phabHeaders() {
  return {
    "X-PadlHub-Auth-Source": "lk-keycloak",
    "X-PadlHub-Tenant-Key": TENANT_KEY,
  };
}

function buildTournamentApiBaseUrls(): string[] {
  return buildProjectUrlCandidates(PHAB_API_BASE, SERV2, SERV2_FALLBACK)
    .map((value) => value.replace(/\/+$/, ""))
    .filter(Boolean);
}

function buildTournamentApiRequestOptions(
  options: {
    allowFallback?: boolean;
  } = {},
) {
  const [baseUrl, ...fallbackBaseUrls] = buildTournamentApiBaseUrls();
  return options.allowFallback === false
    ? { baseUrl }
    : {
        baseUrl,
        fallbackBaseUrls,
      };
}

export async function apiFetchTournamentSignupList(params: {
  date?: string | null;
  from?: string | null;
  to?: string | null;
} = {}): Promise<ApiResult<TournamentSignupSummary[]>> {
  const result = await request<unknown>(
    `/tournaments${buildQuery(params)}`,
    {
      ...buildTournamentApiRequestOptions(),
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );
  const data = normalizeTournamentSignupSummaries(result.data);
  return {
    ...result,
    data: await filterVisibleTournamentSummaries(data),
  };
}

export async function apiFetchTournamentMechanicsSourceList(params: {
  date?: string | null;
  from?: string | null;
  to?: string | null;
} = {}): Promise<ApiResult<TournamentSignupSummary[]>> {
  const result = await request<unknown>(
    `/tournaments${buildQuery(params)}`,
    {
      ...buildTournamentApiRequestOptions(),
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );

  return {
    ...result,
    data: normalizeTournamentSignupSummaries(result.data),
  };
}

export async function apiRefreshTournamentMechanicsFromViva(
  date: string,
): Promise<ApiResult<TournamentMechanicsVivaRefreshResult>> {
  const result = await request<unknown>(
    "/tournaments/snapshot/refresh-day",
    {
      ...buildTournamentApiRequestOptions({ allowFallback: false }),
      method: "POST",
      auth: true,
      headers: phabHeaders(),
      retries: 0,
      body: JSON.stringify({ date }),
    },
  );
  const payload = isRecord(result.data) ? result.data : null;
  const reasonRaw = String(payload?.reason ?? "").trim();
  const reason = reasonRaw === "cooldown" || reasonRaw === "refresh_failed"
    ? reasonRaw
    : "refreshed";

  return {
    ...result,
    data: payload
      ? {
          refreshed: payload.refreshed === true,
          reason,
          date: String(payload.date ?? date),
          snapshotAvailable: payload.snapshotAvailable === true,
          tournaments: normalizeTournamentSignupSummaries(payload.tournaments),
          refreshedAt: pickString(payload, ["refreshedAt"]),
          retryAfterMs: pickNumber(payload, ["retryAfterMs"]),
          persisted: typeof payload.persisted === "boolean" ? payload.persisted : null,
        }
      : null,
  };
}

export async function apiFetchTournamentSignupDetail(
  tournamentId: string,
): Promise<ApiResult<TournamentSignupDetail>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}`,
    {
      ...buildTournamentApiRequestOptions(),
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeTournamentDetail(result.data),
  };
}

export async function apiFetchTournamentMyRegistration(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/registration/me`,
    {
      ...buildTournamentApiRequestOptions(),
      method: "GET",
      auth: true,
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}

export async function apiFetchTournamentVivaMyRegistration(
  exerciseId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const bookingResult = await fetchTournamentVivaMyBooking(exerciseId);
  if (bookingResult.error) {
    return {
      data: null,
      error: bookingResult.error,
      status: bookingResult.status,
    };
  }

  return {
    data: normalizeVivaOwnBookingRegistration(bookingResult.data),
    error: null,
    status: bookingResult.status,
  };
}

export async function apiResolveTournamentVivaRegistrationBookingId(
  exerciseId: string,
  bookingId?: string | null,
  options: {
    placeNumber?: number | null;
  } = {},
): Promise<ApiResult<string>> {
  let resolvedBookingId = String(bookingId || "").trim();
  if (!resolvedBookingId) {
    const bookingResult = await fetchTournamentVivaMyBooking(exerciseId, {
      placeNumber: options.placeNumber,
    });
    if (bookingResult.error) {
      return {
        data: null,
        error: bookingResult.error,
        status: bookingResult.status,
      };
    }
    resolvedBookingId = pickString(bookingResult.data, ["id", "bookingId"]) || "";
  }

  if (!resolvedBookingId) {
    return {
      data: null,
      error: { status: 404, message: "Не найдена ваша запись в Viva для отмены" },
      status: 404,
    };
  }

  return {
    data: resolvedBookingId,
    error: null,
    status: 200,
  };
}

export async function apiCancelTournamentVivaRegistration(
  exerciseId: string,
  bookingId?: string | null,
  options: {
    placeNumber?: number | null;
    refundMethod?: BookingCancellationRefundMethod | null;
  } = {},
): Promise<ApiResult<TournamentRegistrationState>> {
  const resolvedBookingIdResult = await apiResolveTournamentVivaRegistrationBookingId(
    exerciseId,
    bookingId,
    { placeNumber: options.placeNumber },
  );
  if (resolvedBookingIdResult.error || !resolvedBookingIdResult.data) {
    return {
      data: null,
      error: resolvedBookingIdResult.error,
      status: resolvedBookingIdResult.status,
    };
  }
  const resolvedBookingId = resolvedBookingIdResult.data;

  const cancellationOptionsResult = await request<BookingCancellationOptionsResponse>(
    `/end-user/api/v1/${TENANT_KEY}/bookings/${encodeURIComponent(resolvedBookingId)}/cancel`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
  if (cancellationOptionsResult.error || !cancellationOptionsResult.data) {
    return {
      data: null,
      error: cancellationOptionsResult.error,
      status: cancellationOptionsResult.status,
    };
  }

  const plan = resolveBookingCancellationPlan(cancellationOptionsResult.data);
  if (plan.mode === "unsupported" || plan.actions.length === 0) {
    return {
      data: null,
      error: {
        status: 409,
        message: plan.unsupportedReason || "Для этой записи нет поддержанного сценария возврата",
      },
      status: 409,
    };
  }

  const explicitAction = options.refundMethod
    ? findBookingCancellationActionByRefundMethod(plan, options.refundMethod)
    : null;
  if (options.refundMethod && !explicitAction) {
    return {
      data: null,
      error: {
        status: 409,
        message: "Выбранный способ возврата недоступен для этой записи",
      },
      status: 409,
    };
  }

  const action = explicitAction ?? plan.actions[0];
  const cancelPayload = buildBookingCancellationPayload(action);
  const cancelResult = await request<unknown>(
    `/end-user/api/v1/${TENANT_KEY}/bookings/${encodeURIComponent(resolvedBookingId)}`,
    {
      method: "DELETE",
      auth: true,
      retries: 1,
      ...(cancelPayload
        ? { body: JSON.stringify(cancelPayload) }
        : {}),
    });
  const accepted = !cancelResult.error;
  const verifiableConflict = cancelResult.status !== null
    && [400, 404, 409, 422].includes(cancelResult.status);
  if (!accepted && !verifiableConflict) {
    return {
      data: null,
      error: cancelResult.error,
      status: cancelResult.status,
    };
  }

  const verificationResult = await apiVerifyBookingCancellation(resolvedBookingId);
  if (verificationResult.error || verificationResult.data?.state !== "cancelled") {
    return {
      data: null,
      error: verificationResult.error || {
        status: 409,
        message: "Не удалось подтвердить отмену записи в Viva",
      },
      status: verificationResult.status,
    };
  }

  if (action.id === "subscription") {
    const releaseResult = await apiReleaseSubscriptionBookingClaim(resolvedBookingId);
    if (releaseResult.error || releaseResult.data?.state !== "RELEASED") {
      return {
        data: null,
        error: releaseResult.error || {
          status: 409,
          message: "Запись отменена в Viva, но дневной лимит ещё не синхронизирован",
        },
        status: releaseResult.status,
      };
    }
  }

  return {
    data: {
      status: "NONE",
      bookingId: null,
      placeNumber: null,
      waitlistNumber: null,
      canRegister: true,
      canCancel: false,
      message: action.successMessage,
      paymentUrl: null,
      paymentExpiresAt: null,
    },
    error: null,
    status: cancelResult.status,
  };
}

export async function apiRegisterForTournament(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/register`,
    {
      ...buildTournamentApiRequestOptions({ allowFallback: false }),
      method: "POST",
      auth: true,
      headers: phabHeaders(),
      body: JSON.stringify({ authProvider: "lk-keycloak", tenantKey: TENANT_KEY }),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}

export async function apiCancelTournamentRegistration(
  tournamentId: string,
): Promise<ApiResult<TournamentRegistrationState>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}/register`,
    {
      ...buildTournamentApiRequestOptions({ allowFallback: false }),
      method: "DELETE",
      auth: true,
      headers: phabHeaders(),
      retries: 1,
    },
  );
  return {
    ...result,
    data: normalizeRegistration(result.data),
  };
}

export async function apiFetchTournamentVivaCheckout(
  exerciseId: string,
  options: {
    tournament?: unknown;
    skinPriceLabel?: string | null;
  } = {},
): Promise<ApiResult<TournamentVivaCheckout>> {
  const [profileResult, exerciseResult] = await Promise.all([
    request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
  ]);

  if (profileResult.error || !profileResult.data) {
    return { data: null, error: profileResult.error || { status: 401, message: "Не удалось получить профиль Viva" }, status: profileResult.status };
  }
  if (exerciseResult.error || !isRecord(exerciseResult.data)) {
    return { data: null, error: exerciseResult.error || { status: 404, message: "Не удалось получить карточку турнира Viva" }, status: exerciseResult.status };
  }

  const exercise = exerciseResult.data;
  const studio = pickNestedRecord(exercise, ["studio"]);
  const customPricing = resolveTournamentCustomPricing([exercise, options.tournament], options.skinPriceLabel);

  if (customPricing) {
    return {
      data: {
        profile: profileResult.data,
        exercise,
        studioId: pickString(studio, ["id"]) || pickString(exercise, ["studioId"]),
        customPricing,
        purchasedProducts: [],
        clientSubscriptions: [],
        oneTimes: [],
        subscriptions: [buildTournamentCustomEnergyProduct(customPricing)],
      },
      error: null,
      status: exerciseResult.status || profileResult.status,
    };
  }

  const [oneTimesResult, subscriptionsResult] = await Promise.all([
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/products/one-times?exerciseId=${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/products/subscriptions?exerciseId=${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      auth: true,
      retries: 1,
    }),
  ]);

  const clientSubscriptions = filterClientSubscriptionsForExercise(
    normalizeVivaProducts(pickFirstArray(exercise, ["availableClientSubscriptions"]), "client-subscription"),
    exerciseId,
    exercise,
  );
  const clientOneTimes = normalizeVivaProducts(
    pickFirstArray(exercise, ["availableClientOneTimes"]),
    "client-one-time",
  );
  const oneTimes = oneTimesResult.error ? [] : normalizeVivaProducts(extractItems(oneTimesResult.data), "one-time");
  const subscriptions = subscriptionsResult.error ? [] : normalizeVivaProducts(extractItems(subscriptionsResult.data), "subscription");
  const resolvedClientSubscriptions = await resolveClientSubscriptionProductNames(
    clientSubscriptions,
    profileResult.data.phone,
  );

  return {
    data: {
      profile: profileResult.data,
      exercise,
      studioId: pickString(studio, ["id"]) || pickString(exercise, ["studioId"]),
      customPricing: null,
      purchasedProducts: [...resolvedClientSubscriptions, ...clientOneTimes],
      clientSubscriptions: resolvedClientSubscriptions,
      oneTimes,
      subscriptions,
    },
    error: null,
    status: exerciseResult.status || profileResult.status,
  };
}

export async function apiFetchTournamentVivaPublicCheckout(
  exerciseId: string,
  options: {
    tournament?: unknown;
    skinPriceLabel?: string | null;
  } = {},
): Promise<ApiResult<TournamentVivaCheckout>> {
  const exerciseResult = await request<unknown>(`/end-user/api/v1/${TENANT_KEY}/exercises/${encodeURIComponent(exerciseId)}`, {
    method: "GET",
    retries: 1,
  });
  const exercise = isRecord(exerciseResult.data)
    ? exerciseResult.data
    : isRecord(options.tournament)
      ? options.tournament
      : {};
  const studio = pickNestedRecord(exercise, ["studio"]);
  const customPricing = resolveTournamentCustomPricing([exercise, options.tournament], options.skinPriceLabel);

  if (customPricing) {
    return {
      data: {
        profile: null,
        exercise,
        studioId: pickString(studio, ["id"]) || pickString(exercise, ["studioId"]),
        customPricing,
        purchasedProducts: [],
        clientSubscriptions: [],
        oneTimes: [],
        subscriptions: [buildTournamentCustomEnergyProduct(customPricing)],
      },
      error: null,
      status: exerciseResult.status,
    };
  }

  const [oneTimesResult, subscriptionsResult] = await Promise.all([
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/products/one-times?exerciseId=${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      retries: 1,
    }),
    request<unknown>(`/end-user/api/v2/${TENANT_KEY}/products/subscriptions?exerciseId=${encodeURIComponent(exerciseId)}`, {
      method: "GET",
      retries: 1,
    }),
  ]);

  const oneTimes = oneTimesResult.error ? [] : normalizeVivaProducts(extractItems(oneTimesResult.data), "one-time");
  const subscriptions = subscriptionsResult.error ? [] : normalizeVivaProducts(extractItems(subscriptionsResult.data), "subscription");

  if (exerciseResult.error && oneTimes.length === 0 && subscriptions.length === 0) {
    return {
      data: null,
      error: exerciseResult.error,
      status: exerciseResult.status,
    };
  }

  return {
    data: {
      profile: null,
      exercise,
      studioId: pickString(studio, ["id"]) || pickString(exercise, ["studioId"]),
      customPricing: null,
      purchasedProducts: [],
      clientSubscriptions: [],
      oneTimes,
      subscriptions,
    },
    error: null,
    status: exerciseResult.status || oneTimesResult.status || subscriptionsResult.status,
  };
}

type CreateTournamentVivaTransactionParams = {
  exerciseId: string;
  studioId: string | null;
  clientPhone: string;
  clientId?: string | null;
  profile?: UserProfileType | null;
  product: TournamentVivaProduct;
  customPricing?: TournamentCustomPricing | null;
  tournament?: unknown;
  exercise?: Record<string, unknown> | null;
  promoCode?: string | null;
  successUrl?: string | null;
  failUrl?: string | null;
};

function buildTournamentCustomEnergySnapshot(
  exerciseId: string,
  tournament: unknown,
  exercise: Record<string, unknown> | null | undefined,
) {
  const tournamentRecord = isRecord(tournament) ? tournament : null;
  const rawRecord = isRecord(tournamentRecord?.raw) ? tournamentRecord.raw : null;
  const source = rawRecord ?? tournamentRecord;
  const startsAt =
    pickString(source, ["startsAt", "startAt", "timeFrom", "dateTimeFrom", "startTime"])
    || pickString(exercise, ["timeFrom", "startsAt", "startAt", "dateTimeFrom"]);
  const endsAt =
    pickString(source, ["endsAt", "endAt", "timeTo", "dateTimeTo", "endTime"])
    || pickString(exercise, ["timeTo", "endsAt", "endAt", "dateTimeTo"]);
  const date = pickString(source, ["date", "day"]) || formatDate(startsAt);
  const dateLabel = formatDiscountReasonDate(startsAt, date);
  const studio = pickNestedRecord(exercise, ["studio"]);

  return {
    id: pickString(source, ["id", "tournamentId", "uuid", "exerciseId"]) || exerciseId,
    exerciseId,
    sourceTournamentId: pickString(source, ["sourceTournamentId", "vivaExerciseId", "exerciseId"]),
    linkedCustomTournamentId: pickString(source, ["linkedCustomTournamentId", "customTournamentId"]),
    title: pickString(source, ["title", "name", "displayName"]) || "Турнир",
    startsAt,
    endsAt,
    date,
    dateLabel,
    studioId: pickString(source, ["studioId"]) || pickString(studio, ["id"]),
    studioName: pickString(source, ["studioName", "stationName", "clubName"]) || pickString(studio, ["name", "title"]),
    publicUrl: pickString(source, ["publicUrl", "url", "link"]),
  };
}

function buildTournamentCustomEnergyCheckoutPayload(
  params: CreateTournamentVivaTransactionParams,
  pricing: TournamentCustomPricing,
  successUrl: string | null,
  failUrl: string | null,
) {
  const tournament = buildTournamentCustomEnergySnapshot(params.exerciseId, params.tournament, params.exercise);
  const discountReason = buildTournamentCustomEnergyDiscountReason(tournament.title, tournament.dateLabel);

  return {
    source: "lk-tournament-signup",
    authProvider: "lk-keycloak",
    tenantKey: TENANT_KEY,
    exerciseId: params.exerciseId,
    studioId: params.studioId ?? tournament.studioId ?? null,
    paymentMethod: "SMS",
    client: {
      id: params.clientId ?? params.profile?.id ?? null,
      phone: params.clientPhone || params.profile?.phone || null,
      firstName: params.profile?.firstName ?? null,
      lastName: params.profile?.lastName ?? null,
      middleName: params.profile?.middleName ?? null,
      email: params.profile?.email ?? null,
    },
    product: {
      name: pricing.productName,
      type: "SUBSCRIPTION",
      kind: "TOURNAMENT_CUSTOM_ENERGY",
    },
    pricing: {
      currency: "RUB",
      priceLabel: pricing.priceLabel,
      amount: pricing.amount,
      amountMinor: toTournamentRubMinorAmount(pricing.amount),
      baseAmount: pricing.baseAmount,
      baseAmountMinor: toTournamentRubMinorAmount(pricing.baseAmount),
      discountAmount: pricing.discountAmount,
      discountAmountMinor: toTournamentRubMinorAmount(pricing.discountAmount),
      discountReason,
    },
    tournament,
    returnUrls: {
      successUrl,
      failUrl,
    },
  };
}

function normalizeServerTournamentTransactionResult(
  payload: unknown,
  fallbackPaymentExpiresAt: string | null,
): TournamentVivaTransactionResult {
  const toPay =
    (isRecord(payload) ? pickNumber(payload, ["toPayMinor", "amountMinor", "targetAmountMinor"]) : null)
    ?? extractToPay(payload);
  const paymentUrl = extractPaymentUrl(payload);
  return {
    paymentUrl,
    bookingId: extractBookingId(payload),
    toPay,
    paid: hasPaidPaymentStatus(payload) || (!paymentUrl && toPay != null && toPay <= 0),
    paymentExpiresAt: isRecord(payload)
      ? pickString(payload, ["paymentExpiresAt", "paymentDeadline", "paymentDeadlineAt", "paymentDueDate", "expiresAt"]) || fallbackPaymentExpiresAt
      : fallbackPaymentExpiresAt,
    raw: payload,
  };
}

async function apiCreateTournamentCustomEnergyTransaction(
  params: CreateTournamentVivaTransactionParams,
): Promise<ApiResult<TournamentVivaTransactionResult>> {
  const transactionStartedAtMs = Date.now();
  const returnUrls = buildTournamentPaymentReturnUrls(params.exerciseId);
  const successUrl = params.successUrl?.trim() || returnUrls.successUrl;
  const failUrl = params.failUrl?.trim() || returnUrls.failUrl;
  const pricing = params.customPricing
    ?? resolveTournamentCustomPricing([params.exercise, params.tournament], params.product.priceLabel);

  if (!pricing) {
    return {
      data: null,
      error: { status: 400, message: "Не найдена кастомная цена турнира" },
      status: 400,
    };
  }

  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(params.exerciseId)}/custom-energy-checkout`,
    {
      ...buildTournamentApiRequestOptions({ allowFallback: false }),
      method: "POST",
      auth: true,
      headers: phabHeaders(),
      retries: 1,
      body: JSON.stringify(buildTournamentCustomEnergyCheckoutPayload(params, pricing, successUrl, failUrl)),
    },
  );
  if (result.error) {
    return { data: null, error: result.error, status: result.status };
  }

  const normalized = normalizeServerTournamentTransactionResult(
    result.data,
    buildPaymentExpiresAt(transactionStartedAtMs),
  );
  if (!normalized.paymentUrl && !normalized.paid) {
    return {
      data: null,
      error: {
        status: result.status,
        message: "Сервер не вернул ссылку на оплату",
        raw: result.data,
      },
      status: result.status,
    };
  }

  return {
    data: normalized,
    error: null,
    status: result.status,
  };
}

async function apiCreateTournamentVivaBookingFromSubscription(
  params: CreateTournamentVivaTransactionParams,
): Promise<ApiResult<TournamentVivaTransactionResult>> {
  const targetDate =
    resolveSubscriptionCategoryDailyLimitDateFromEvent(params.exercise)
    || resolveSubscriptionCategoryDailyLimitDateFromEvent(params.tournament);
  const targetCategory =
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent(params.exercise)
    || resolveSubscriptionCategoryDailyLimitCategoryFromEvent(params.tournament);
  if (
    targetDate
    && targetCategory
    && subscriptionPlanAllowsDailyLimitCategory(params.product, targetCategory)
  ) {
    const bookingsResult = await apiFetchSubscriptionDailyLimitBookings({ size: 1000 });
    if (bookingsResult.error) {
      return {
        data: null,
        error: {
          status: bookingsResult.status || 502,
          message: "Не удалось проверить дневной лимит абонемента",
          raw: bookingsResult.error.raw ?? bookingsResult.error,
        },
        status: bookingsResult.status || 502,
      };
    }

    const conflict = resolveSubscriptionCategoryDailyLimitConflictFromBookings(
      bookingsResult.data?.content ?? [],
      {
        targetDate,
        category: targetCategory,
        currentSubscription: params.product,
        currentClientSubscriptionId: pickSubscriptionLookupId(params.product.raw) || params.product.id,
        currentExerciseId: params.exerciseId,
      },
    );
    if (conflict) {
      return {
        data: null,
        error: buildSubscriptionCategoryDailyLimitApiError(conflict),
        status: 409,
      };
    }
  }

  const clientSubscriptionId = pickSubscriptionLookupId(params.product.raw) || params.product.id;
  const idempotencySeed = [
    params.clientId,
    clientSubscriptionId,
    params.exerciseId,
  ].map((value) => String(value || "").trim()).join("|");
  const hashPart = (value: string) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const idempotencyKey = `lk-subscription-${hashPart(idempotencySeed)}${hashPart([...idempotencySeed].reverse().join(""))}`;
  const response = await request<unknown>(
    `/lk/subscription-bookings?operationId=${encodeURIComponent(idempotencyKey)}`,
    {
      method: "POST",
      baseUrl: getServ2Origin(),
      auth: true,
      retries: 0,
      body: JSON.stringify({
        exerciseId: params.exerciseId,
        clientSubscriptionId,
      }),
    },
  );
  if (response.error) {
    return { data: null, error: response.error, status: response.status };
  }
  const gatewayState = pickString(response.data, ["state"]);
  const bookingId = pickString(response.data, ["bookingId", "id"]);
  if (gatewayState !== "CONFIRMED" || !bookingId) {
    return {
      data: null,
      error: {
        status: response.status,
        message: pickString(response.data, ["message"]) || "Запись ожидает подтверждения Viva. Повторите проверку.",
        raw: response.data,
      },
      status: response.status,
    };
  }

  return {
    data: {
      paymentUrl: null,
      bookingId,
      toPay: 0,
      paid: true,
      paymentExpiresAt: null,
      raw: response.data,
    },
    error: null,
    status: response.status,
  };
}

function buildTournamentVivaTransactionPayload(
  params: CreateTournamentVivaTransactionParams,
  successUrl: string | null,
  failUrl: string | null,
) {
  return {
    products: [
      buildTournamentVivaTransactionProductPayload(params.product, params.exerciseId),
    ],
    clientPhone: params.clientPhone,
    paymentMethod: "WIDGET",
    exerciseId: params.exerciseId,
    studioId: params.studioId,
    promoCode: params.promoCode ?? null,
    ...(successUrl
      ? {
          successUrl,
          baseRedirectUrl: successUrl,
          redirectUrl: successUrl,
          returnUrl: successUrl,
          successRedirectUrl: successUrl,
        }
      : {}),
    ...(failUrl
      ? {
          failUrl,
          failRedirectUrl: failUrl,
          failureRedirectUrl: failUrl,
        }
      : {}),
  };
}

export async function apiCreateTournamentVivaTransaction(
  params: CreateTournamentVivaTransactionParams,
): Promise<ApiResult<TournamentVivaTransactionResult>> {
  if (params.product.isCustomTournamentEnergy) {
    return apiCreateTournamentCustomEnergyTransaction(params);
  }
  if (params.product.source === "client-subscription") {
    return apiCreateTournamentVivaBookingFromSubscription(params);
  }

  const paymentWatcher = await createVivaPaymentWatcher(params.clientId);
  const transactionStartedAtMs = Date.now();
  const returnUrls = buildTournamentPaymentReturnUrls(params.exerciseId);
  const successUrl = params.successUrl?.trim() || returnUrls.successUrl;
  const failUrl = params.failUrl?.trim() || returnUrls.failUrl;
  const payload = buildTournamentVivaTransactionPayload(params, successUrl, failUrl);

  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v2/${TENANT_KEY}/transactions`,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify(payload),
    },
  );
  if (result.error) {
    paymentWatcher?.close();
    return { data: null, error: result.error, status: result.status };
  }

  const transactionId = extractTransactionId(result.data);
  const bookingWatcher = transactionId
    ? await createVivaBookingWatcher(params.clientId, transactionId)
    : null;
  const responseBookingId = extractBookingId(result.data);
  const responseToPay = extractToPay(result.data);
  const directPaymentUrl = extractPaymentUrl(result.data);
  const watcherResolution = paymentWatcher?.wait.then((url) => {
    if (!url) return null;
    return {
      paymentUrl: url,
      bookingId: responseBookingId,
      toPay: responseToPay,
      paid: false,
      paymentExpiresAt: buildPaymentExpiresAt(transactionStartedAtMs),
      raw: result.data,
    } satisfies TournamentVivaPaymentResolution;
  }) ?? Promise.resolve<TournamentVivaPaymentResolution | null>(null);
  const paymentResolutionPromises: Array<Promise<TournamentVivaPaymentResolution | null>> = [
    watcherResolution,
    pollTournamentVivaPaymentResolution(params.exerciseId, transactionId),
  ];
  if (transactionId) {
    paymentResolutionPromises.unshift(
      pollTournamentVivaTransactionResolution(transactionId, transactionStartedAtMs),
    );
  }
  const resolvedPayment = directPaymentUrl
    ? null
    : await awaitPreferredTournamentPaymentResolution(paymentResolutionPromises);
  const paymentUrl = directPaymentUrl || resolvedPayment?.paymentUrl || null;
  const bookingId = resolvedPayment?.bookingId ?? responseBookingId;
  const toPay = resolvedPayment?.toPay ?? responseToPay;
  const paymentExpiresAt = resolvedPayment?.paymentExpiresAt ?? (paymentUrl ? buildPaymentExpiresAt(transactionStartedAtMs) : null);
  const paid = resolvedPayment?.paid === true || (!paymentUrl && toPay != null && toPay <= 0);
  const bookingEvent = !paymentUrl && !paid && bookingWatcher
    ? await Promise.race([
        bookingWatcher.wait,
        wait(1200).then(() => null),
      ])
    : null;
  bookingWatcher?.close();
  paymentWatcher?.close();

  if (!paymentUrl && !paid) {
    const mappedMessage = mapTournamentVivaFailureMessage(bookingEvent?.error);
    return {
      data: null,
      error: {
        status: result.status,
        message: mappedMessage || "Не удалось получить ссылку на оплату",
        raw: {
          transaction: result.data,
          event: bookingEvent?.raw ?? null,
          resolvedPayment: resolvedPayment?.raw ?? null,
        },
      },
      status: result.status,
    };
  }

  return {
    data: {
      paymentUrl,
      bookingId,
      toPay,
      paid,
      paymentExpiresAt,
      raw: result.data,
    },
    error: null,
    status: result.status,
  };
}
