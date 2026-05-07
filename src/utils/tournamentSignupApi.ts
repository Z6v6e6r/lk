import { API_BASE, BOOKING_CANCEL_REFUND_TYPE, PHAB_API_BASE, TENANT_KEY } from "../consts/api_config";
import { request, type ApiResult, type UserProfileType } from "./apiClient";

export type TournamentSignupStatus = "AVAILABLE" | "REGISTERED" | "WAITLIST" | "FULL" | "CLOSED" | "CANCELLED";

export interface TournamentSignupSummary {
  id: string;
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
  raw: unknown;
}

export interface TournamentSignupDetail extends TournamentSignupSummary {
  description: string | null;
  rules: string | null;
  registration: TournamentRegistrationState | null;
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
  source: "client-subscription" | "client-one-time" | "one-time" | "subscription";
  raw: unknown;
}

export interface TournamentVivaCheckout {
  profile: UserProfileType;
  exercise: Record<string, unknown>;
  studioId: string | null;
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
    "settings",
    "params",
  ]) {
    const nested = value[key];
    if (isRecord(nested)) records.push(...collectTournamentStateRecords(nested));
  }
  return records;
}

function isCancelledTournamentPayload(value: unknown) {
  return collectTournamentStateRecords(value).some((record) => {
    if (
      record.isCancelled === true
      || record.cancelled === true
      || record.canceled === true
      || record.isCanceled === true
    ) return true;

    return [
      "status",
      "state",
      "skinStatus",
      "tournamentStatus",
      "customStatus",
      "publicationStatus",
      "registrationStatus",
    ].some((key) => isCancelledStatusValue(record[key]));
  });
}

function isHiddenTournamentPayload(value: unknown) {
  if (isCancelledTournamentPayload(value)) return true;
  return collectTournamentStateRecords(value).some((record) => (
    ["skinStatus", "tournamentStatus", "customStatus", "publicationStatus"]
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

function normalizeTournamentSummary(value: unknown): TournamentSignupSummary | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "tournamentId", "uuid", "exerciseId"]);
  if (!id) return null;

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
    title: pickString(value, ["title", "name", "displayName"]) || "Турнир",
    startsAt,
    endsAt,
    date: pickString(value, ["date", "day"]) || formatDate(startsAt),
    timeLabel: formatTimeRange(startsAt, endsAt),
    studioName: pickString(value, ["studioName", "stationName", "clubName"]) || pickString(studio, ["name", "title"]),
    address: pickString(value, ["address", "studioAddress"]) || pickString(studio, ["address", "fullAddress"]),
    format: pickString(value, ["format", "tournamentType", "type", "category"]),
    levelLabel: pickString(value, ["levelLabel", "level", "ratingRange", "accessLevels"]),
    priceLabel: pickString(value, ["priceLabel", "priceText"]) || (price != null ? `${price.toLocaleString("ru-RU")} ${currency}` : null),
    participantsCount,
    maxParticipants,
    waitlistCount,
    status: normalizeStatus(pickString(value, ["status", "registrationStatus", "state"])),
    trainerName: trainer.name,
    trainerAvatarUrl: trainer.avatarUrl,
    publicUrl: pickString(value, ["publicUrl", "url", "link"]),
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

  const publicPath = normalizePublicTournamentPath(
    pickString(summary.raw, ["publicUrl", "joinUrl"])
      || (isRecord(summary.raw) ? pickString(summary.raw.skin, ["publicUrl", "joinUrl"]) : null),
  );
  if (!publicPath) return true;

  const detailResult = await request<unknown>(publicPath, {
    baseUrl: PHAB_API_BASE,
    method: "GET",
    headers: phabHeaders(),
    retries: 1,
  });
  if (detailResult.error) return true;

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

  const urls = normalized.match(/https?:\/\/[^\s"'<>\\\u0000]+/gi) ?? [];
  for (const url of urls) {
    const cleaned = url.replace(/[),.;\]]+$/g, "");
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
    for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "payment"]) {
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

    for (const key of ["transactionStatus", "paymentStatus", "status", "originalStatus", "cardPaymentStatus", "paymentType"]) {
      const direct = visit(value[key]);
      if (direct !== null) return direct;
    }
    for (const key of ["transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "data", "payload", "result"]) {
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

    for (const key of ["transactionStatus", "paymentStatus", "status", "originalStatus", "cardPaymentStatus", "paymentType"]) {
      const direct = visit(value[key]);
      if (direct !== null) return direct;
    }
    for (const key of ["transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "data", "payload", "result"]) {
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
  const id = pickString(value, [
    "id",
    "productId",
    "subscriptionId",
    "clientSubscriptionId",
    "oneTimeId",
    "clientOneTimeId",
    "uuid",
  ]);
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

async function createVivaPaymentWatcher(clientId?: string | null) {
  if (typeof window === "undefined" || typeof WebSocket === "undefined") {
    return null;
  }

  const normalizedClientId = String(clientId || "").trim();
  if (!normalizedClientId) return null;

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
  let resolveWait: (value: string | null) => void = () => {};
  const wait = new Promise<string | null>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (value: string | null) => {
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
          `SUBSCRIBE\nid:sub-0\ndestination:/messages/eu/users/${normalizedClientId}/events\n\n\u0000`,
        );
        return;
      }
      try {
        const payload = JSON.parse(text) as unknown;
        const paymentUrl = extractPaymentUrl(payload);
        if (paymentUrl) finish(paymentUrl);
      } catch {
        const paymentUrl = extractPaymentUrl(text);
        if (paymentUrl) finish(paymentUrl);
      }
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
      successUrl: successUrl.toString(),
      failUrl: failUrl.toString(),
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

export async function apiFetchTournamentSignupList(params: {
  date?: string | null;
  from?: string | null;
  to?: string | null;
} = {}): Promise<ApiResult<TournamentSignupSummary[]>> {
  const result = await request<unknown>(
    `/tournaments${buildQuery(params)}`,
    {
      baseUrl: PHAB_API_BASE,
      method: "GET",
      headers: phabHeaders(),
      retries: 1,
    },
  );
  const data = extractItems(result.data)
    .map((item) => normalizeTournamentSummary(item))
    .filter((item): item is TournamentSignupSummary => item !== null);
  return {
    ...result,
    data: await filterVisibleTournamentSummaries(data),
  };
}

export async function apiFetchTournamentSignupDetail(
  tournamentId: string,
): Promise<ApiResult<TournamentSignupDetail>> {
  const result = await request<unknown>(
    `/tournaments/${encodeURIComponent(tournamentId)}`,
    {
      baseUrl: PHAB_API_BASE,
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
      baseUrl: PHAB_API_BASE,
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

export async function apiCancelTournamentVivaRegistration(
  exerciseId: string,
  bookingId?: string | null,
  options: {
    placeNumber?: number | null;
  } = {},
): Promise<ApiResult<TournamentRegistrationState>> {
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

  await request<unknown>(
    `/end-user/api/v1/${TENANT_KEY}/bookings/${encodeURIComponent(resolvedBookingId)}/cancel`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );

  let cancelResult = await request<unknown>(
    `/end-user/api/v1/${TENANT_KEY}/bookings/${encodeURIComponent(resolvedBookingId)}`,
    {
      method: "DELETE",
      auth: true,
      retries: 1,
      body: JSON.stringify({ refundMethod: "CURRENCY" }),
    },
  );
  if (cancelResult.error) {
    const refundType = BOOKING_CANCEL_REFUND_TYPE?.trim();
    if (refundType && refundType.toLowerCase() !== "none") {
      cancelResult = await request<unknown>(
        `/end-user/api/v1/${TENANT_KEY}/bookings/${encodeURIComponent(resolvedBookingId)}`,
        {
          method: "DELETE",
          auth: true,
          retries: 1,
          body: JSON.stringify({ refundType }),
        },
      );
    }
  }
  if (cancelResult.error) {
    return {
      data: null,
      error: cancelResult.error,
      status: cancelResult.status,
    };
  }

  return {
    data: {
      status: "NONE",
      bookingId: null,
      placeNumber: null,
      waitlistNumber: null,
      canRegister: true,
      canCancel: false,
      message: "Запись отменена",
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
      baseUrl: PHAB_API_BASE,
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
      baseUrl: PHAB_API_BASE,
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

  const exercise = exerciseResult.data;
  const studio = pickNestedRecord(exercise, ["studio"]);
  const clientSubscriptions = filterClientSubscriptionsForExercise(
    normalizeVivaProducts(pickFirstArray(exercise, ["availableClientSubscriptions"]), "client-subscription"),
    exerciseId,
    exercise,
  );
  const purchasedProducts = [
    ...clientSubscriptions,
    ...normalizeVivaProducts(pickFirstArray(exercise, ["availableClientOneTimes"]), "client-one-time"),
  ];

  return {
    data: {
      profile: profileResult.data,
      exercise,
      studioId: pickString(studio, ["id"]) || pickString(exercise, ["studioId"]),
      purchasedProducts,
      clientSubscriptions,
      oneTimes: oneTimesResult.error ? [] : normalizeVivaProducts(extractItems(oneTimesResult.data), "one-time"),
      subscriptions: subscriptionsResult.error ? [] : normalizeVivaProducts(extractItems(subscriptionsResult.data), "subscription"),
    },
    error: null,
    status: exerciseResult.status || profileResult.status,
  };
}

export async function apiCreateTournamentVivaTransaction(params: {
  exerciseId: string;
  studioId: string | null;
  clientPhone: string;
  clientId?: string | null;
  product: TournamentVivaProduct;
  promoCode?: string | null;
  successUrl?: string | null;
  failUrl?: string | null;
}): Promise<ApiResult<TournamentVivaTransactionResult>> {
  const paymentWatcher = await createVivaPaymentWatcher(params.clientId);
  const transactionStartedAtMs = Date.now();
  const returnUrls = buildTournamentPaymentReturnUrls(params.exerciseId);
  const successUrl = params.successUrl?.trim() || returnUrls.successUrl;
  const failUrl = params.failUrl?.trim() || returnUrls.failUrl;
  const payload = {
    products: [
      {
        id: params.product.id,
        name: params.product.name,
        type: params.product.type,
        count: 1,
        bookingRequests: [
          {
            exerciseId: params.exerciseId,
            client: null,
            comment: null,
            marketingAttribution: {},
          },
        ],
      },
    ],
    clientPhone: params.clientPhone,
    paymentMethod: "WIDGET",
    ...(successUrl ? { successUrl } : {}),
    ...(failUrl ? { failUrl } : {}),
    exerciseId: params.exerciseId,
    studioId: params.studioId,
    promoCode: params.promoCode ?? null,
  };

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
  const responseBookingId = extractBookingId(result.data);
  const responseToPay = extractToPay(result.data);
  const directPaymentUrl = extractPaymentUrl(result.data);
  const watcherResolution = new Promise<TournamentVivaPaymentResolution | null>((resolve) => {
    void paymentWatcher?.wait.then((url) => {
      if (!url) return;
      resolve({
        paymentUrl: url,
        bookingId: responseBookingId,
        toPay: responseToPay,
        paid: false,
        paymentExpiresAt: buildPaymentExpiresAt(transactionStartedAtMs),
        raw: result.data,
      });
    });
  });
  const resolvedPayment = directPaymentUrl
    ? null
    : await Promise.race([
        watcherResolution,
        pollTournamentVivaPaymentResolution(params.exerciseId, transactionId),
      ]);
  const paymentUrl = directPaymentUrl || resolvedPayment?.paymentUrl || null;
  const bookingId = resolvedPayment?.bookingId ?? responseBookingId;
  const toPay = resolvedPayment?.toPay ?? responseToPay;
  const paymentExpiresAt = resolvedPayment?.paymentExpiresAt ?? (paymentUrl ? buildPaymentExpiresAt(transactionStartedAtMs) : null);
  const paid = resolvedPayment?.paid === true || (!paymentUrl && toPay != null && toPay <= 0);
  paymentWatcher?.close();

  if (!paymentUrl && !paid) {
    return {
      data: null,
      error: {
        status: result.status,
        message: "Не удалось получить ссылку на оплату",
        raw: {
          transaction: result.data,
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
