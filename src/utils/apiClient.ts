import { getCookie } from "./cookies";
import {
  TENANT_KEY,
  API_BASE,
  SERV2,
  SERV2_FALLBACK,
  SUPPORT_API_BASE,
  SUCCESS_URL,
  FAIL_URL,
  GAMES_MASTER_SERVICE_ID,
  BOOKING_CANCEL_REFUND_TYPE,
  IS_DEV_RELEASE_CHANNEL,
} from "../consts/api_config";
import { trackClientError } from "./analytics";

const DEFAULT_GAMES_MASTER_SERVICE_ID =
  GAMES_MASTER_SERVICE_ID || "2f4155ad-7bc0-4a15-a12c-da7fce15c37a";
const ENABLE_MASTER_SERVICE_AUTO_DISCOVERY = false;
const PREFERRED_PANORAMIC_SUB_SERVICE_ID = "415edff9-b4ad-4d88-8709-75f1ab7d4081";
const DEV_EXERCISES_CACHE_TTL_MS = 30_000;
const DEV_GAMES_CACHE_TTL_MS = 30_000;
const DEV_CHAT_SUMMARY_CACHE_TTL_MS = 5_000;
const DEV_TOURNAMENT_HISTORY_CACHE_TTL_MS = 60_000;
const DEV_CABINET_ADVERTISING_CACHE_TTL_MS = 30_000;
const DEV_SPLIT_PAYMENT_PROMO_CACHE_TTL_MS = 30_000;

export interface UserProfileType {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
  middleName: string;
  sex: string;
  photo: string | null;
  phone: string;
  birthDate: string | null;
  deposit: number;
  trialUsed: boolean;
  withCard: boolean;
  loyaltyCard: string;
  clientCategory: { id: number; name: string };
  customFields: CustomField[];
}

export interface CustomFieldOption {
  id: string;
  name: string;
  default?: boolean;
}

export interface CustomFieldAttributes {
  placeholder?: string;
  options?: CustomFieldOption[];
  default?: string;
}

export interface CustomFieldSettings {
  visibleInWidget?: boolean;
  alwaysAsk?: boolean;
}

export interface CustomField {
  value: string[];
  id: string;
  name: string;
  description?: string;
  required?: boolean;
  resource?: string;
  type?: string;
  attributes?: CustomFieldAttributes;
  settings?: CustomFieldSettings;
  enabled?: boolean;
}

export interface CustomFieldValue {
  id: string;
  value: string[];
}

export interface SubscriptionAvailableStudios {
  id: string;
  name: string;
}

export interface SubscriptionAvailableTypes {
  id: string;
  name: string;
}

export interface SubscriptionAvailableDirections {
  id: string;
  name: string;
}

export interface Subscription {
  subscriptionId: string;
  name: string | null;
  cost: number;
  type: string;
  status: string;
  purchaseDate: string;
  autoActivationDate: string | null;
  activationDate: string | null;
  expirationDate: string | null;
  holdUntil: string | null;
  validityDays: number;
  totalFreezeDays: number;
  freezingDays: number;
  freezeUsed: boolean;
  hasStudioLimitation: boolean;
  availableStudios: SubscriptionAvailableStudios[];
  hasTypeLimitation: boolean;
  availableTypes: SubscriptionAvailableTypes[];
  hasDirectionLimitation: boolean;
  availableDirections: SubscriptionAvailableDirections[];
  hasDayLimitation: boolean;
  hasTimeRangeLimitation: boolean;
  variant: string;
  visitsTotal: number;
  visitsLeft: number;
  timeLimitation: string;
  minutes: number;
  availableMinutes: number;
  duration: string;
  availableDays: string;
}

export interface AdvertisementType {
  id?: string;
  title?: string;
  imgUrl: string;
  href: string;
}

export interface CabinetHomeAdvertisingItem {
  id: string;
  title?: string;
  imgUrl: string;
  href: string;
}

export interface CabinetHomeAdvertisingSettings {
  placement: "cabinet_home";
  rotationEnabled: boolean;
  ads: CabinetHomeAdvertisingItem[];
  updatedAt?: string;
}

export interface PadelSplitPaymentPromoConfig {
  id?: string;
  title?: string;
  enabled: boolean;
  activeTo?: string;
  stationIds: string[];
  stationNameIncludes: string[];
  roomIds: string[];
  roomNameIncludes: string[];
  shareAmounts: {
    twoTeams: number;
    fourPlayers: number;
  };
  baseShareAmount: number;
  vivaDirectionId: number;
  vivaExerciseTypeId: number;
  promos?: PadelSplitPaymentPromoConfig[];
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG: PadelSplitPaymentPromoConfig = {
  enabled: true,
  activeTo: undefined,
  stationIds: ["6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1"],
  stationNameIncludes: ["терехово", "terekhovo"],
  roomIds: [],
  roomNameIncludes: ["new"],
  shareAmounts: {
    twoTeams: 500,
    fourPlayers: 250,
  },
  baseShareAmount: 2000,
  vivaDirectionId: 4485,
  vivaExerciseTypeId: 1208,
};
export interface apiSubscription {
  id: string;
  productType: string;
  name: string;
  cost: number;
  discountPrice: number;
  bonusPoints: number;
  showToUser: boolean;
  type: string;
  activationDays: number;
  validityDays: number;
  freezingDays: number;
  hasStudioLimitation: boolean;
  availableStudios: SubscriptionAvailableStudios[];
  hasTypeLimitation: boolean;
  availableTypes: SubscriptionAvailableTypes[];
  hasDirectionLimitation: boolean;
  availableDirections: SubscriptionAvailableDirections[];
  hasDayLimitation: boolean;
  availableDaysOfWeek: [];
  hasTimeRangeLimitation: boolean;
  availableTimeRanges: [];
  variant: string;
  visits: number;
  timeLimitation: string;
  minutes: number;
  duration: string;
  photos: [];
  nameInReceipt: string | null;
  imgUrl: string;
}

export interface SubscriptionResponse {
  content: Subscription[];
  pageable: {
    pageNumber: number;
    pageSize: number;
    sort: {
      empty: boolean;
      sorted: boolean;
      unsorted: boolean;
    };
    offset: number;
    paged: boolean;
  };
  last: boolean;
  totalElements: number;
  totalPages: number;
  first: boolean;
  size: number;
  number: number;
  numberOfElements: number;
  empty: boolean;
}

export interface Studio {
  id: string;
  name: string;
  country: string;
  city: string;
  address: string;
  panoramicCourtsCount?: number | null;
  masterServiceId?: string | null;
  preferredSubServiceId?: string | null;
  subServiceIds?: string[];
  lat?: number | null;
  lng?: number | null;
}

export type GamePlayFormat = "doubles" | "singles";

export interface StudioGameModeConfig {
  key: GamePlayFormat;
  subServiceIds: string[];
  preferredSubServiceId: string | null;
  preferredRoomIds: string[];
}

export interface StudioGameModes {
  doubles: StudioGameModeConfig | null;
  singles: StudioGameModeConfig | null;
}

export interface GameCourtOption {
  id: string;
  name: string;
  price: number | null;
}

export interface GameTimeSlot {
  id: string;
  roomId: string;
  roomName: string;
  date: string | null;
  time: string;
  price: number | null;
  subServiceIds: string[];
  durationMinutes: number | null;
  timeTo: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const picked = toTrimmedString(source[key]);
    if (picked) return picked;
  }
  return null;
}

function toCountNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.trunc(parsed));
    }
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const picked = toCountNumber(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function toNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (["true", "1", "yes", "y", "paid"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "unpaid", "pending"].includes(normalized)) return false;
  }
  return null;
}

function summarizeApiErrorPayload(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") {
    const text = payload.trim();
    return text.length > 400 ? `${text.slice(0, 400)}...` : text;
  }
  try {
    const serialized = JSON.stringify(payload);
    return serialized.length > 400 ? `${serialized.slice(0, 400)}...` : serialized;
  } catch {
    return null;
  }
}

function pickNumeric(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const picked = toNumeric(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function toCoordinateNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickCoordinate(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const picked = toCoordinateNumber(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function normalizeTimeLabel(value: unknown): string | null {
  const raw = toTrimmedString(value);
  if (!raw) return null;

  const toNormalizedTime = (hoursRaw: string, minutesRaw: string): string | null => {
    const hours = Number.parseInt(hoursRaw, 10);
    const minutes = Number.parseInt(minutesRaw, 10);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  };

  const exactMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (exactMatch) {
    const normalized = toNormalizedTime(exactMatch[1], exactMatch[2]);
    if (normalized) return normalized;
  }

  const isoMatch = raw.match(/T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?/);
  if (isoMatch) {
    const normalized = toNormalizedTime(isoMatch[1], isoMatch[2]);
    if (normalized) return normalized;
  }

  const genericMatch = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (genericMatch) {
    const normalized = toNormalizedTime(genericMatch[1], genericMatch[2]);
    if (normalized) return normalized;
  }

  return null;
}

function normalizeDateLabel(value: unknown): string | null {
  const raw = toTrimmedString(value);
  if (!raw) return null;

  const exactMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exactMatch) {
    return exactMatch[0];
  }

  const isoMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseIsoDurationMinutes(value: string): number | null {
  const matched = value.trim().match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
  if (!matched) return null;
  const hours = matched[1] ? Number.parseInt(matched[1], 10) : 0;
  const minutes = matched[2] ? Number.parseInt(matched[2], 10) : 0;
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

function toDurationMinutes(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    const iso = parseIsoDurationMinutes(normalized);
    if (iso !== null) return iso;
    const numeric = Number.parseInt(normalized, 10);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return null;
}

function pickDurationMinutes(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const picked = toDurationMinutes(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function extractIdList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractIdList(item));
  }
  if (isRecord(value)) {
    const id = pickString(value, ["id", "subServiceId", "serviceId", "uuid"]);
    return id ? [id] : [];
  }
  return [];
}

function uniqueIds(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function extractStringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return uniqueIds(value.flatMap((item) => extractStringList(item)));
  }
  if (isRecord(value)) {
    const nestedKeys = ["items", "content", "data", "phones", "values"];
    for (const key of nestedKeys) {
      const candidate = value[key];
      if (candidate != null) {
        const extracted = extractStringList(candidate);
        if (extracted.length > 0) return extracted;
      }
    }
    return [];
  }
  const direct = toTrimmedString(value);
  return direct ? [direct] : [];
}

function extractPhoneList(value: unknown): string[] {
  return uniqueIds(
    extractStringList(value)
      .map((item) => normalizePhoneForChat(item) ?? item)
      .filter(Boolean),
  );
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function mergeFlatObject<T extends Record<string, unknown> | null | undefined>(current: T, incoming: T): T {
  if (!current) return incoming;
  if (!incoming) return current;

  const next: Record<string, unknown> = { ...current };
  Object.entries(incoming).forEach(([key, value]) => {
    if (hasMeaningfulValue(value)) {
      next[key] = value;
    }
  });
  return next as T;
}

function buildPadelGamePlayerKey(player: PadelGamePlayer): string {
  const id = (player.id || "").trim();
  if (id) return `id:${id}`;
  const phone = normalizePhoneForChat(player.phone ?? "");
  if (phone) return `phone:${phone}`;
  return `name:${(player.name || "").trim().toLowerCase()}`;
}

function mergePadelGamePlayers(current: PadelGamePlayer[] = [], incoming: PadelGamePlayer[] = []): PadelGamePlayer[] {
  const merged = new Map<string, PadelGamePlayer>();

  [...current, ...incoming].forEach((player) => {
    const key = buildPadelGamePlayerKey(player);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, player);
      return;
    }
    merged.set(key, {
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

function mergePadelGameRecord(current: PadelGameRecord | undefined, incoming: PadelGameRecord): PadelGameRecord {
  if (!current) return incoming;

  return {
    ...current,
    ...incoming,
    inviteUrl: incoming.inviteUrl ?? current.inviteUrl,
    status: incoming.status ?? current.status,
    participantPhones: uniqueIds([...(current.participantPhones ?? []), ...(incoming.participantPhones ?? [])]),
    waitlistPhones: uniqueIds([...(current.waitlistPhones ?? []), ...(incoming.waitlistPhones ?? [])]),
    allRelatedPhones: uniqueIds([...(current.allRelatedPhones ?? []), ...(incoming.allRelatedPhones ?? [])]),
    invitedPhones: uniqueIds([...(current.invitedPhones ?? []), ...(incoming.invitedPhones ?? [])]),
    createdAt: incoming.createdAt ?? current.createdAt,
    updatedAt: incoming.updatedAt ?? current.updatedAt,
    organizer: mergeFlatObject(current.organizer, incoming.organizer),
    settings: mergeFlatObject(current.settings, incoming.settings),
    participants: mergePadelGamePlayers(current.participants, incoming.participants),
    waitlist: mergePadelGamePlayers(current.waitlist, incoming.waitlist),
    invite: mergeFlatObject(current.invite, incoming.invite),
    metadata: mergeFlatObject(current.metadata, incoming.metadata),
    booking: mergeFlatObject(current.booking, incoming.booking),
    payment: mergeFlatObject(current.payment, incoming.payment),
  };
}

function extractPriceAmount(payload: unknown): number | null {
  if (payload == null) return null;

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractPriceAmount(item);
      if (nested !== null) return nested;
    }
    return null;
  }

  if (isRecord(payload)) {
    const direct = pickNumeric(payload, [
      "price",
      "cost",
      "amount",
      "fullPrice",
      "total",
      "value",
      "finalPrice",
      "from",
      "valueFrom",
    ]);
    if (direct !== null) return direct;

    const nestedKeys = [
      "payload",
      "data",
      "content",
      "result",
      "pricing",
      "price",
      "calculation",
      "basePrice",
    ];
    for (const key of nestedKeys) {
      const nested = extractPriceAmount(payload[key]);
      if (nested !== null) return nested;
    }

    for (const value of Object.values(payload)) {
      const nested = extractPriceAmount(value);
      if (nested !== null) return nested;
    }
    return null;
  }

  return toNumeric(payload);
}

function extractDirectPriceAmount(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return pickNumeric(payload, [
    "from",
    "price",
    "cost",
    "amount",
    "fullPrice",
    "total",
    "value",
    "finalPrice",
    "valueFrom",
  ]);
}

function extractImpactPriceAmount(impactPayload: unknown): number | null {
  if (!isRecord(impactPayload)) return null;

  const applied =
    pickNumeric(impactPayload, [
      "appliedValueFrom",
      "appliedValue",
      "appliedAmount",
      "valueFrom",
      "from",
      "amount",
    ]) ??
    (isRecord(impactPayload.price)
      ? pickNumeric(impactPayload.price, [
        "appliedValueFrom",
        "appliedValue",
        "appliedAmount",
        "valueFrom",
        "from",
        "amount",
      ])
      : null);
  if (applied !== null) return applied;

  const rawValue =
    pickNumeric(impactPayload, ["value", "valueTo"]) ??
    (isRecord(impactPayload.price)
      ? pickNumeric(impactPayload.price, ["value", "valueTo"])
      : null);
  if (rawValue === null) return null;

  const direction = pickString(impactPayload, ["impactDirection", "direction"])?.trim().toUpperCase();
  if (direction === "DISCOUNT") {
    return -Math.abs(rawValue);
  }

  return rawValue;
}

function extractPriceAmountForSubServices(payload: unknown, subServiceIds: string[]): number | null {
  if (!isRecord(payload)) return null;
  if (subServiceIds.length === 0) return null;

  const extractCalculatedPrice = (entryPayload: unknown): number | null => {
    if (!isRecord(entryPayload)) return null;
    const direct = extractDirectPriceAmount(entryPayload);
    if (direct !== null) return direct;

    const calculation = entryPayload.calculation;
    if (!isRecord(calculation)) return null;

    for (const item of Object.values(calculation)) {
      if (!isRecord(item)) continue;
      const basePrice = isRecord(item.basePrice) ? item.basePrice : null;
      const base =
        (basePrice ? pickNumeric(basePrice, ["appliedValueFrom", "valueFrom", "from", "value", "amount"]) : null) ??
        pickNumeric(item, ["valueFrom", "from", "value", "amount"]);
      if (base === null) continue;

      const impacts = Array.isArray(item.impacts) ? item.impacts : [];
      const impactsSum = impacts.reduce((sum, impact) => {
        const directImpact = extractImpactPriceAmount(impact);
        return directImpact === null ? sum : sum + directImpact;
      }, 0);

      return base + impactsSum;
    }

    return null;
  };

  for (const subServiceId of subServiceIds) {
    const directBySubService = extractDirectPriceAmount(payload[subServiceId]);
    if (directBySubService !== null) return directBySubService;
    const calculatedBySubService = extractCalculatedPrice(payload[subServiceId]);
    if (calculatedBySubService !== null) return calculatedBySubService;
    const bySubService = extractPriceAmount(payload[subServiceId]);
    if (bySubService !== null) return bySubService;
  }

  return null;
}

function extractPromoDiscountSummary(payload: unknown): PromoDiscountSummary | null {
  const summary: PromoDiscountSummary = {
    discount: 0,
    bonusPoints: 0,
  };
  let matched = false;

  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    if (!isRecord(value)) return;

    const hasDirectPromoFields =
      Object.prototype.hasOwnProperty.call(value, "discount")
      || Object.prototype.hasOwnProperty.call(value, "discountAmount")
      || Object.prototype.hasOwnProperty.call(value, "bonusPoints")
      || Object.prototype.hasOwnProperty.call(value, "bonus");

    if (hasDirectPromoFields) {
      summary.discount += pickNumeric(value, ["discount", "discountAmount", "discountPrice"]) ?? 0;
      summary.bonusPoints += pickNumeric(value, ["bonusPoints", "bonus"]) ?? 0;
      matched = true;
      return;
    }

    const nestedKeys = ["payload", "data", "content", "result", "items", "discounts"];
    nestedKeys.forEach((key) => {
      if (key in value) {
        visit(value[key]);
      }
    });
  };

  visit(payload);
  return matched ? summary : null;
}

function extractPromoValidationState(payload: unknown): boolean | null {
  if (typeof payload === "boolean") return payload;

  if (typeof payload === "string") {
    const normalized = payload.trim().toLowerCase();
    if (!normalized) return null;
    if (
      normalized.includes("invalid")
      || normalized.includes("not valid")
      || normalized.includes("невер")
      || normalized.includes("недейств")
      || normalized.includes("ошиб")
    ) {
      return false;
    }
    if (
      normalized.includes("valid")
      || normalized.includes("success")
      || normalized.includes("ok")
      || normalized.includes("успеш")
      || normalized.includes("примен")
    ) {
      return true;
    }
    return null;
  }

  if (!isRecord(payload)) return null;

  for (const key of ["valid", "isValid", "available", "active", "applied"]) {
    const picked = toBoolean(payload[key]);
    if (picked !== null) return picked;
  }

  const statusText = pickString(payload, ["status", "code", "message", "reason", "description"]);
  const statusState = extractPromoValidationState(statusText);
  if (statusState !== null) return statusState;

  for (const key of ["payload", "data", "content", "result"]) {
    if (!(key in payload)) continue;
    const nested = extractPromoValidationState(payload[key]);
    if (nested !== null) return nested;
  }

  return null;
}

function extractPromoMessage(payload: unknown): string | null {
  if (typeof payload === "string") {
    const normalized = payload.trim();
    return normalized ? normalized : null;
  }

  if (!isRecord(payload)) return null;

  const direct = pickString(payload, ["message", "reason", "description", "error", "status"]);
  if (direct) return direct;

  for (const key of ["payload", "data", "content", "result"]) {
    if (!(key in payload)) continue;
    const nested = extractPromoMessage(payload[key]);
    if (nested) return nested;
  }

  return null;
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

function extractPaymentUrl(payload: unknown): string | null {
  const visit = (value: unknown): string | null => {
    if (value == null) return null;

    if (typeof value === "string") {
      const normalized = value.trim();
      if (!/^https?:\/\//i.test(normalized)) return null;
      if (isLikelyPaymentUrl(normalized)) return normalized;
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = visit(item);
        if (nested) return nested;
      }
      return null;
    }

    if (!isRecord(value)) return null;

    const directPaymentKeys = [
      "paymentUrl",
      "redirectUrl",
      "paymentLink",
      "checkoutUrl",
      "cardPaymentUrl",
      "paymentPageUrl",
    ];
    for (const key of directPaymentKeys) {
      const direct = pickString(value, [key]);
      if (!direct) continue;
      const normalized = visit(direct);
      if (normalized) return normalized;
    }

    const genericDirect = pickString(value, ["url", "link"]);
    if (genericDirect) {
      const normalized = visit(genericDirect);
      if (normalized) return normalized;
    }

    const nestedKeys = [
      "data",
      "payload",
      "result",
      "transaction",
      "transactionStatus",
      "cardPaymentStatus",
      "payment",
      "paymentInfo",
      "cardPaymentInfo",
    ];
    for (const key of nestedKeys) {
      const nested = visit(value[key]);
      if (nested) return nested;
    }

    return null;
  };

  return visit(payload);
}

function extractBookingIdsFromPaymentPayload(payload: unknown): string[] {
  const bucket = new Set<string>();
  const pushMany = (value: unknown) => {
    extractIdList(value).forEach((item) => {
      const normalized = item.trim();
      if (normalized) bucket.add(normalized);
    });
  };
  const tryPaymentUrl = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (!normalized) return;
    try {
      const parsed = new URL(normalized);
      parsed.searchParams.getAll("bookingIds").forEach((item) => pushMany(item));
      parsed.searchParams.getAll("bookingId").forEach((item) => pushMany(item));
    } catch {
      // ignore invalid URLs
    }
  };

  const visit = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;

    pushMany(value.bookingIds);
    pushMany(value.bookingId);
    pushMany(value.booking_ids);
    pushMany(value.booking_id);

    const bookingLike =
      Object.prototype.hasOwnProperty.call(value, "isCancelled")
      || Object.prototype.hasOwnProperty.call(value, "paymentType")
      || Object.prototype.hasOwnProperty.call(value, "visitConfirmed")
      || Object.prototype.hasOwnProperty.call(value, "cancellationDeadline")
      || Object.prototype.hasOwnProperty.call(value, "clientOneTimeId")
      || Object.prototype.hasOwnProperty.call(value, "transactionStatus")
      || Object.prototype.hasOwnProperty.call(value, "exercise");
    if (bookingLike) {
      pushMany(value.id);
    }

    tryPaymentUrl(value.paymentUrl);
    tryPaymentUrl(value.paymentLink);
    tryPaymentUrl(value.redirectUrl);
    tryPaymentUrl(value.url);

    [
      "booking",
      "bookings",
      "bookingInfo",
      "bookingPayload",
      "createdBooking",
      "createdBookings",
      "payload",
      "data",
      "content",
      "result",
      "items",
      "transaction",
      "transactions",
      "transactionStatus",
    ].forEach((key) => {
      if (key in value) {
        visit(value[key]);
      }
    });
  };

  visit(payload);
  return Array.from(bucket);
}

function extractOneTimeFilterItems(payload: unknown): unknown[] {
  const flatten = (items: unknown[]): unknown[] =>
    items.flatMap((item) => (Array.isArray(item) ? flatten(item) : [item]));

  if (Array.isArray(payload)) return flatten(payload);
  if (!isRecord(payload)) return [];

  const listKeys = ["content", "data", "items", "result", "oneTimes"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return flatten(candidate);
  }

  return [];
}

interface OneTimeCandidate {
  id: string;
  roomId: string | null;
  subServiceId: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
}

function extractOneTimeCandidates(payload: unknown): OneTimeCandidate[] {
  const items = extractOneTimeFilterItems(payload);
  const parsed = items
    .map((item) => {
      if (!isRecord(item)) return null;

      const id =
        pickString(item, ["oneTimeId", "clientOneTimeId", "id", "uuid"]) ?? null;
      if (!id) return null;

      const roomPayload = isRecord(item.room) ? item.room : null;
      const subServicePayload = isRecord(item.subService) ? item.subService : null;

      const roomId =
        pickString(item, ["roomId", "masterServiceRoomId"]) ??
        (roomPayload ? pickString(roomPayload, ["id", "roomId"]) : null);
      const subServiceId =
        pickString(item, ["subServiceId", "productId", "serviceId"]) ??
        (subServicePayload ? pickString(subServicePayload, ["id", "subServiceId"]) : null);
      const startDateTime = pickString(item, [
        "exerciseStartDateTime",
        "startDateTime",
        "timeFrom",
        "fromDateTime",
        "dateTimeFrom",
      ]);
      const endDateTime = pickString(item, [
        "exerciseEndDateTime",
        "endDateTime",
        "timeTo",
        "toDateTime",
        "dateTimeTo",
      ]);

      return {
        id,
        roomId,
        subServiceId,
        startDateTime,
        endDateTime,
      } satisfies OneTimeCandidate;
    })
    .filter((item): item is OneTimeCandidate => item !== null);

  const deduped = new Map<string, OneTimeCandidate>();
  parsed.forEach((candidate) => {
    if (!deduped.has(candidate.id)) deduped.set(candidate.id, candidate);
  });

  return Array.from(deduped.values());
}

function selectOneTimeIdsForPay(
  candidates: OneTimeCandidate[],
  criteria: {
    roomId: string;
    subServiceIds: string[];
    fromDateTimeWithOffset: string;
    toDateTimeWithOffset: string;
    fromDateTimeLocal: string;
    toDateTimeLocal: string;
  },
): string[] {
  if (candidates.length === 0) return [];

  const subServiceSet = new Set(criteria.subServiceIds);

  const scored = candidates
    .map((candidate) => {
      let score = 0;
      if (candidate.roomId && candidate.roomId === criteria.roomId) score += 4;
      if (candidate.subServiceId && subServiceSet.has(candidate.subServiceId)) score += 3;
      if (
        candidate.startDateTime &&
        (candidate.startDateTime.includes(criteria.fromDateTimeWithOffset) ||
          candidate.startDateTime.includes(criteria.fromDateTimeLocal))
      ) {
        score += 3;
      }
      if (
        candidate.endDateTime &&
        (candidate.endDateTime.includes(criteria.toDateTimeWithOffset) ||
          candidate.endDateTime.includes(criteria.toDateTimeLocal))
      ) {
        score += 2;
      }
      return { candidate, score };
    })
    .sort((a, b) => b.score - a.score);

  return uniqueIds(scored.map((entry) => entry.candidate.id));
}

const STATION_ID_KEYS = ["id", "stationId", "studioId", "_id", "uuid"] as const;
const UUID_LIKE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: string | null): value is string {
  if (!value) return false;
  return UUID_LIKE_REGEX.test(value.trim());
}

function extractStationMasterServiceMap(payload: unknown): Map<string, string> {
  const mapping = new Map<string, string>();

  const assign = (stationId: string | null, masterServiceId: string | null) => {
    if (!isUuidLike(stationId) || !isUuidLike(masterServiceId)) return;
    if (!mapping.has(stationId)) {
      mapping.set(stationId, masterServiceId);
    }
  };

  const masterServiceKeys = [
    "masterServiceId",
    "master_service_id",
    "masterService",
    "master_service",
    "serviceId",
    "productId",
    "id",
  ];

  const fromValue = (value: unknown): string | null => {
    if (typeof value === "string" || typeof value === "number") {
      const normalized = toTrimmedString(value);
      return isUuidLike(normalized) ? normalized : null;
    }
    if (!isRecord(value)) return null;
    const nested = pickString(value, masterServiceKeys);
    return isUuidLike(nested) ? nested : null;
  };

  const processRecordPair = (
    record: Record<string, unknown>,
    fallbackStationId: string | null = null,
  ) => {
    const stationId =
      pickString(record, [...STATION_ID_KEYS, "station", "studio", "locationId"]) ??
      fallbackStationId;
    const directMasterServiceId = pickString(record, [
      "masterServiceId",
      "master_service_id",
      "masterService",
      "master_service",
      "serviceId",
      "productId",
    ]);
    assign(stationId, directMasterServiceId);

    const nestedService = isRecord(record.masterService)
      ? pickString(record.masterService, ["id", "masterServiceId", "serviceId", "productId"])
      : null;
    assign(stationId, nestedService);
  };

  const processArray = (items: unknown[]) => {
    items.forEach((item) => {
      if (!isRecord(item)) return;
      processRecordPair(item);
    });
  };

  const processMapObject = (record: Record<string, unknown>) => {
    Object.entries(record).forEach(([stationId, rawServiceValue]) => {
      if (!isUuidLike(stationId)) return;
      assign(stationId, fromValue(rawServiceValue));
    });
  };

  if (Array.isArray(payload)) {
    processArray(payload);
    return mapping;
  }
  if (!isRecord(payload)) return mapping;

  processRecordPair(payload);

  const mapKeys = [
    "masterServiceByStation",
    "masterServiceByStudio",
    "masterServiceIdsByStation",
    "masterServiceIdsByStudio",
    "masterServiceMap",
    "stationMasterServiceMap",
    "stationMasterServices",
    "servicesByStation",
    "servicesByStudio",
    "masterServicesByStation",
    "masterServicesByStudio",
  ];
  mapKeys.forEach((key) => {
    const candidate = payload[key];
    if (!candidate || Array.isArray(candidate) || !isRecord(candidate)) return;
    processMapObject(candidate);
  });

  const listKeys = [
    "stations",
    "items",
    "data",
    "content",
    "result",
    "stationMasterServices",
    "masterServicesByStation",
  ];
  listKeys.forEach((key) => {
    const candidate = payload[key];
    if (!Array.isArray(candidate)) return;
    processArray(candidate);
  });

  const objectValues = Object.values(payload).filter((entry): entry is Record<string, unknown> => isRecord(entry));
  objectValues.forEach((record) => {
    processRecordPair(record);
    processMapObject(record);
  });

  processMapObject(payload);

  return mapping;
}

function extractStationSubServiceMap(payload: unknown): Map<string, string[]> {
  const mapping = new Map<string, string[]>();

  const assign = (stationId: string | null, subServiceIds: string[]) => {
    if (!isUuidLike(stationId) || subServiceIds.length === 0) return;
    const current = mapping.get(stationId) ?? [];
    mapping.set(stationId, uniqueIds([...current, ...subServiceIds]));
  };

  const readSubServiceIds = (entry: unknown): string[] => {
    if (entry == null) return [];
    if (typeof entry === "string" || typeof entry === "number") {
      const single = toTrimmedString(entry);
      return isUuidLike(single) ? [single] : [];
    }
    if (!isRecord(entry)) return [];

    const directIds = uniqueIds([
      ...extractIdList(entry.subServiceIds),
      ...extractIdList(entry.sub_service_ids),
      ...extractIdList(entry.subServices),
      ...extractIdList(entry.sub_services),
      ...extractIdList(entry.preferredSubServiceIds),
      ...extractIdList(entry.preferred_sub_service_ids),
      ...extractIdList(entry.subServiceId),
      ...extractIdList(entry.sub_service_id),
      ...extractIdList(entry.preferredSubServiceId),
      ...extractIdList(entry.preferred_sub_service_id),
    ]).filter((value) => isUuidLike(value));

    if (directIds.length > 0) return directIds;

    const nestedItems = [
      entry.subService,
      entry.sub_service,
      entry.preferredSubService,
      entry.preferred_sub_service,
    ];
    const nestedIds = uniqueIds(
      nestedItems.flatMap((nested) =>
        isRecord(nested)
          ? extractIdList(
              pickString(nested, ["id", "subServiceId", "sub_service_id", "uuid"]),
            )
          : [],
      ),
    ).filter((value) => isUuidLike(value));

    return nestedIds;
  };

  const processRecordPair = (
    record: Record<string, unknown>,
    fallbackStationId: string | null = null,
  ) => {
    const stationId =
      pickString(record, [...STATION_ID_KEYS, "station", "studio", "locationId"]) ??
      fallbackStationId;
    assign(stationId, readSubServiceIds(record));
  };

  const processArray = (items: unknown[]) => {
    items.forEach((item) => {
      if (!isRecord(item)) return;
      processRecordPair(item);
    });
  };

  const processMapObject = (record: Record<string, unknown>) => {
    Object.entries(record).forEach(([stationId, raw]) => {
      if (!isUuidLike(stationId)) return;
      assign(stationId, readSubServiceIds(raw));
    });
  };

  if (Array.isArray(payload)) {
    processArray(payload);
    return mapping;
  }
  if (!isRecord(payload)) return mapping;

  processRecordPair(payload);

  const mapKeys = [
    "subServiceByStation",
    "subServiceByStudio",
    "subServiceIdsByStation",
    "subServiceIdsByStudio",
    "preferredSubServiceByStation",
    "preferredSubServiceByStudio",
    "stationSubServiceMap",
    "stationSubServices",
  ];
  mapKeys.forEach((key) => {
    const candidate = payload[key];
    if (!candidate || Array.isArray(candidate) || !isRecord(candidate)) return;
    processMapObject(candidate);
  });

  const listKeys = [
    "stations",
    "items",
    "data",
    "content",
    "result",
    "stationSubServices",
  ];
  listKeys.forEach((key) => {
    const candidate = payload[key];
    if (!Array.isArray(candidate)) return;
    processArray(candidate);
  });

  const objectValues = Object.values(payload).filter((entry): entry is Record<string, unknown> => isRecord(entry));
  objectValues.forEach((record) => {
    processRecordPair(record);
    processMapObject(record);
  });

  processMapObject(payload);

  return mapping;
}

function countPanoramicRooms(rooms: unknown): number | null {
  if (!Array.isArray(rooms)) return null;
  const count = rooms.reduce((acc, room) => {
    if (!isRecord(room)) return acc;
    const roomName = pickString(room, ["name"]);
    if (!roomName) return acc;
    return /панорам|panoramic/i.test(roomName) ? acc + 1 : acc;
  }, 0);
  return count > 0 ? count : null;
}

function extractVivaStudioItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const listKeys = ["content", "data", "items", "result", "studios"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function extractMasterServiceTimeslotItems(payload: unknown): unknown[] {
  const flattenSlots = (items: unknown[]): unknown[] =>
    items.flatMap((item) => (Array.isArray(item) ? flattenSlots(item) : [item]));

  if (Array.isArray(payload)) return flattenSlots(payload);
  if (!isRecord(payload)) return [];

  const listKeys = ["timeslots", "content", "data", "items", "result", "slots"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return flattenSlots(candidate);
  }

  const byTrainer = payload.byTrainer;
  if (isRecord(byTrainer)) {
    const trainerSlots = Object.values(byTrainer).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const slots = entry.slots;
      return Array.isArray(slots) ? flattenSlots(slots) : [];
    });
    if (trainerSlots.length > 0) return trainerSlots;
  }

  return [];
}

function normalizeMasterServiceTimeslot(item: unknown, index: number): GameTimeSlot | null {
  if (!isRecord(item)) return null;

  const roomPayload = isRecord(item.room)
    ? item.room
    : isRecord(item.resource)
      ? item.resource
      : isRecord(item.masterServiceRoom)
        ? item.masterServiceRoom
        : null;

  const roomId =
    pickString(item, ["roomId", "resourceId", "courtId"]) ??
    (roomPayload ? pickString(roomPayload, ["id", "roomId", "resourceId", "courtId"]) : null) ??
    `room-${index + 1}`;
  const roomName =
    pickString(item, ["roomName", "resourceName", "courtName"]) ??
    (roomPayload ? pickString(roomPayload, ["name", "title"]) : null) ??
    "Корт";
  const date =
    normalizeDateLabel(item.date) ??
    normalizeDateLabel(item.timeFrom) ??
    normalizeDateLabel(item.dateTimeFrom) ??
    normalizeDateLabel(item.dateStart) ??
    normalizeDateLabel(item.from) ??
    normalizeDateLabel(item.timeFromLocal) ??
    normalizeDateLabel(item.time);

  const time =
    normalizeTimeLabel(item.timeFrom) ??
    normalizeTimeLabel(item.dateTimeFrom) ??
    normalizeTimeLabel(item.dateStart) ??
    normalizeTimeLabel(item.startTime) ??
    normalizeTimeLabel(item.from) ??
    normalizeTimeLabel(item.timeFromLocal) ??
    normalizeTimeLabel(item.time);
  if (!time) return null;

  const timeTo =
    normalizeTimeLabel(item.timeTo) ??
    normalizeTimeLabel(item.endTime) ??
    normalizeTimeLabel(item.to) ??
    normalizeTimeLabel(item.timeToLocal) ??
    normalizeTimeLabel(item.dateTimeTo) ??
    normalizeTimeLabel(item.dateEnd);

  const pricePayload = isRecord(item.price) ? item.price : null;
  const price =
    pickNumber(item, ["price", "cost", "amount", "fullPrice", "total"]) ??
    (pricePayload
      ? pickNumber(pricePayload, ["from", "valueFrom", "value", "amount", "price"])
      : null) ??
    extractPriceAmount(pricePayload);

  const durationPayload = isRecord(item.duration) ? item.duration : null;
  const durationMinutes =
    pickDurationMinutes(item, [
      "durationMinutes",
      "duration",
      "minutes",
      "length",
      "slotDuration",
      "availableDuration",
    ]) ??
    (durationPayload ? pickDurationMinutes(durationPayload, ["minutes", "value"]) : null);

  const directSubServiceIds = uniqueIds([
    ...extractIdList(item.subServiceId),
    ...extractIdList(item.subServiceIds),
  ]);
  const fallbackSubServiceIds = uniqueIds([
    ...extractIdList(item.subServices),
    ...extractIdList(item.subService),
    ...extractIdList(item.services),
    ...extractIdList(item.service),
  ]);
  const subServiceIds = directSubServiceIds.length > 0 ? directSubServiceIds : fallbackSubServiceIds;

  const id =
    pickString(item, ["id", "slotId", "timeSlotId", "uuid"]) ??
    `${roomId}-${time}-${index + 1}`;

  return {
    id,
    roomId,
    roomName,
    date,
    time,
    price,
    subServiceIds,
    durationMinutes,
    timeTo,
  };
}

interface MasterServiceOption {
  id: string;
  name: string;
  studioIds: string[];
  roomsCount: number;
}

const masterServiceByStudioCache = new Map<string, string>();
const masterServiceBootstrapCache = new Set<string>();
const masterServiceStudioSubServicesCache = new Map<string, string[]>();
const masterServiceStudioPreferredSubServiceCache = new Map<string, string>();
const masterServiceStudioPreferredRoomIdsCache = new Map<string, string[]>();
const masterServiceStudioGameModesCache = new Map<string, StudioGameModes>();
const masterServiceTimeZoneCache = new Map<string, string>();

function extractMasterServiceItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const listKeys = ["content", "data", "items", "result", "masterServices", "products"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function extractSubServiceItems(payload: unknown): unknown[] {
  const flattenGroups = (items: unknown[]) => {
    const nested = items.flatMap((item) =>
      isRecord(item) && Array.isArray(item.subServices) ? item.subServices : [],
    );
    return nested.length > 0 ? nested : items;
  };

  if (Array.isArray(payload)) return flattenGroups(payload);
  if (!isRecord(payload)) return [];

  const listKeys = ["subServices", "content", "data", "items", "result", "services"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return flattenGroups(candidate);
  }

  return [];
}

function extractSubServiceRoomIdsForStudio(item: Record<string, unknown>, studioId?: string | null): string[] {
  const roomIds: string[] = [];
  const availableStudioRooms = Array.isArray(item.availableStudioRooms)
    ? item.availableStudioRooms
    : [];

  availableStudioRooms.forEach((entry) => {
    if (!isRecord(entry)) return;
    const studioPayload = isRecord(entry.studio) ? entry.studio : null;
    const entryStudioId =
      (studioPayload ? pickString(studioPayload, [...STATION_ID_KEYS]) : null) ??
      pickString(entry, ["studioId", "stationId"]);
    if (studioId && entryStudioId && entryStudioId !== studioId) return;

    const roomsPayload = Array.isArray(entry.rooms)
      ? entry.rooms
      : Array.isArray(entry.availableRooms)
        ? entry.availableRooms
        : [];
    roomsPayload.forEach((room) => {
      if (!isRecord(room)) return;
      const roomId = pickString(room, ["id", "roomId", "resourceId"]);
      if (roomId) roomIds.push(roomId);
    });
  });

  if (roomIds.length === 0 && Array.isArray(item.rooms)) {
    item.rooms.forEach((room) => {
      if (!isRecord(room)) return;
      const roomId = pickString(room, ["id", "roomId", "resourceId"]);
      if (roomId) roomIds.push(roomId);
    });
  }

  return uniqueIds(roomIds);
}

type PreferredSubServiceSelection = {
  allIds: string[];
  preferredId: string | null;
  preferredRoomIds: string[];
};

type StudioModeSubServiceCandidate = {
  id: string;
  name: string;
  roomIds: string[];
  durationMinutes: number | null;
  isSingles: boolean;
  isDoubles: boolean;
};

function isSinglesSubServiceName(name: string): boolean {
  return /сингл|single|1\s*на\s*1|1x1/i.test(name);
}

function isDoublesSubServiceName(name: string): boolean {
  return /панорам|panoramic|2\s*на\s*2|2x2|doubles/i.test(name);
}

function scoreStudioModeSubService(
  candidate: StudioModeSubServiceCandidate,
  format: GamePlayFormat,
): number {
  let score = 0;
  if (candidate.durationMinutes === 60) score += 70;
  if (candidate.durationMinutes === 30) score -= 40;
  if (candidate.roomIds.length > 0) score += 30;

  if (format === "doubles") {
    if (candidate.id === PREFERRED_PANORAMIC_SUB_SERVICE_ID) score += 10_000;
    if (/панорам|panoramic/i.test(candidate.name)) score += 300;
    if (/2\s*на\s*2|2x2|doubles/i.test(candidate.name)) score += 220;
    if (candidate.isDoubles) score += 180;
    if (candidate.isSingles) score -= 320;
    return score;
  }

  if (/сингл|single/i.test(candidate.name)) score += 420;
  if (/1\s*на\s*1|1x1/i.test(candidate.name)) score += 260;
  if (candidate.isSingles) score += 220;
  if (candidate.isDoubles) score -= 260;
  return score;
}

function buildStudioGameModeConfig(
  format: GamePlayFormat,
  candidates: StudioModeSubServiceCandidate[],
): StudioGameModeConfig | null {
  if (candidates.length === 0) return null;

  const ranked = candidates
    .slice()
    .sort((a, b) => scoreStudioModeSubService(b, format) - scoreStudioModeSubService(a, format));
  const preferred = ranked[0];
  if (!preferred) return null;

  return {
    key: format,
    subServiceIds: uniqueIds(candidates.map((item) => item.id)),
    preferredSubServiceId: preferred.id,
    preferredRoomIds: uniqueIds(candidates.flatMap((item) => item.roomIds)),
  };
}

function extractStudioGameModes(payload: unknown, studioId?: string | null): StudioGameModes {
  const candidates = extractSubServiceItems(payload)
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .map((item) => {
      const id = pickString(item, ["id", "subServiceId", "serviceId", "uuid"]);
      if (!id) return null;

      const name = pickString(item, ["name", "title", "description"]) || "";
      const exerciseDirection = isRecord(item.exerciseDirection) ? item.exerciseDirection : null;
      const durationRaw =
        (exerciseDirection ? pickString(exerciseDirection, ["duration"]) : null) ??
        pickString(item, ["duration"]);

      return {
        id,
        name,
        roomIds: extractSubServiceRoomIdsForStudio(item, studioId),
        durationMinutes: durationRaw ? toDurationMinutes(durationRaw) : null,
        isSingles: isSinglesSubServiceName(name),
        isDoubles: isDoublesSubServiceName(name),
      } satisfies StudioModeSubServiceCandidate;
    })
    .filter((item): item is StudioModeSubServiceCandidate => item !== null);

  if (candidates.length === 0) {
    return { doubles: null, singles: null };
  }

  const singlesCandidates = candidates.filter((item) => item.isSingles);
  const doublesCandidates = candidates.filter((item) => !item.isSingles);
  const fallbackDoublesCandidates = doublesCandidates.length > 0
    ? doublesCandidates
    : (singlesCandidates.length === 0 ? candidates : []);

  return {
    doubles: buildStudioGameModeConfig("doubles", fallbackDoublesCandidates),
    singles: buildStudioGameModeConfig("singles", singlesCandidates),
  };
}

function pickPreferredSubService(payload: unknown, studioId?: string | null): PreferredSubServiceSelection {
  const items = extractSubServiceItems(payload)
    .filter((item): item is Record<string, unknown> => isRecord(item));

  const allIds = uniqueIds(
    items.flatMap((item) => extractIdList(item.id ?? item.subServiceId ?? item.serviceId ?? item.uuid)),
  );
  if (items.length === 0) {
    return { allIds, preferredId: null, preferredRoomIds: [] };
  }

  const ranked = items
    .map((item) => {
      const id = pickString(item, ["id", "subServiceId", "serviceId", "uuid"]);
      if (!id) return null;
      const name = pickString(item, ["name", "title", "description"]) || "";
      const exerciseDirection = isRecord(item.exerciseDirection) ? item.exerciseDirection : null;
      const durationRaw =
        (exerciseDirection ? pickString(exerciseDirection, ["duration"]) : null) ??
        pickString(item, ["duration"]);
      const durationMinutes = durationRaw ? toDurationMinutes(durationRaw) : null;
      const roomIds = extractSubServiceRoomIdsForStudio(item, studioId);

      let score = 0;
      if (id === PREFERRED_PANORAMIC_SUB_SERVICE_ID) score += 10_000;
      if (/панорам|panoramic/i.test(name)) score += 300;
      if (/2\s*на\s*2|2x2|doubles/i.test(name)) score += 220;
      if (/сингл|single|1\s*на\s*1/i.test(name)) score -= 220;
      if (/30\s*м|30m|30\s*мин/i.test(name)) score -= 80;
      if (durationMinutes === 60) score += 70;
      if (durationMinutes === 30) score -= 40;
      if (roomIds.length > 0) score += 30;

      return { id, roomIds, score };
    })
    .filter((item): item is { id: string; roomIds: string[]; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);

  const preferred = ranked[0];
  if (!preferred) {
    return { allIds, preferredId: null, preferredRoomIds: [] };
  }

  return {
    allIds,
    preferredId: preferred.id,
    preferredRoomIds: preferred.roomIds,
  };
}

function normalizeTimeZoneForApi(value: unknown): string | null {
  const raw = toTrimmedString(value);
  if (!raw) return null;
  if (raw.includes("/")) return raw;
  if (/^UTC\+?03(?::?00)?$/i.test(raw) || /^GMT\+?03(?::?00)?$/i.test(raw)) {
    return "Europe/Moscow";
  }
  return null;
}

function extractMasterServiceTimeZone(payload: unknown, studioId?: string | null): string | null {
  const studios = extractVivaStudioItems(payload);
  if (studios.length === 0) return null;

  const pickZone = (item: unknown) => {
    if (!isRecord(item)) return null;
    const candidate = [
      item.timeZone,
      item.timezone,
      item.timeZoneName,
      item.zoneId,
      item.ianaTimeZone,
      item.timeZoneIana,
      item.tz,
    ];
    for (const zoneValue of candidate) {
      const normalized = normalizeTimeZoneForApi(zoneValue);
      if (normalized) return normalized;
    }
    return null;
  };

  if (studioId) {
    const matched = studios.find((item) => {
      if (!isRecord(item)) return false;
      const id = pickString(item, [...STATION_ID_KEYS]);
      return id === studioId;
    });
    const fromMatched = pickZone(matched);
    if (fromMatched) return fromMatched;
  }

  for (const item of studios) {
    const normalized = pickZone(item);
    if (normalized) return normalized;
  }

  return null;
}

function collectMasterServiceStudioIds(source: Record<string, unknown>): string[] {
  const ids = new Set<string>();

  const direct = pickString(source, ["studioId", "stationId", "locationId", "studioUuid"]);
  if (direct) ids.add(direct);

  ["studio", "station", "location"].forEach((key) => {
    const nested = source[key];
    if (!isRecord(nested)) return;
    const nestedId = pickString(nested, ["id", "studioId", "stationId", "locationId"]);
    if (nestedId) ids.add(nestedId);
  });

  ["studios", "stations", "availableStudios", "availableStations", "locations"].forEach((key) => {
    const nested = source[key];
    if (!Array.isArray(nested)) return;
    nested.forEach((item) => {
      if (!isRecord(item)) return;
      const nestedId = pickString(item, ["id", "studioId", "stationId", "locationId"]);
      if (nestedId) ids.add(nestedId);
    });
  });

  return Array.from(ids);
}

function normalizeMasterServiceOption(item: unknown, index: number): MasterServiceOption | null {
  if (!isRecord(item)) return null;

  const id = pickString(item, ["id", "masterServiceId", "productId", "uuid"]);
  if (!id) return null;

  const roomsPayload = Array.isArray(item.rooms)
    ? item.rooms
    : Array.isArray(item.availableRooms)
      ? item.availableRooms
      : Array.isArray(item.resources)
        ? item.resources
        : [];

  return {
    id,
    name: pickString(item, ["name", "title", "productName", "serviceName"]) || `Сервис ${index + 1}`,
    studioIds: collectMasterServiceStudioIds(item),
    roomsCount: roomsPayload.length,
  };
}

function scoreMasterService(service: MasterServiceOption, studioId: string): number {
  const hasStudio = service.studioIds.includes(studioId) ? 1000 : 0;
  const nameBoost = /игра|аренда|падел|padel|panoramic|панорамик/i.test(service.name) ? 100 : 0;
  return hasStudio + nameBoost + service.roomsCount;
}

async function resolveMasterServiceIdByStudio(studioId: string): Promise<string | null> {
  if (!studioId) return null;
  const cached = masterServiceByStudioCache.get(studioId);
  if (cached) return cached;

  const base = `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/master-services`;
  const encodedStudioId = encodeURIComponent(studioId);
  const candidateUrls = [
    `${base}?studioId=${encodedStudioId}&size=1000`,
    `${base}?stationId=${encodedStudioId}&size=1000`,
    `${base}?studio=${encodedStudioId}&size=1000`,
    `${base}?locationId=${encodedStudioId}&size=1000`,
    `${base}?size=1000`,
  ];

  const checked = new Set<string>();
  for (const url of candidateUrls) {
    if (checked.has(url)) continue;
    checked.add(url);

    const result = await request<unknown>(url, {
      method: "GET",
      auth: true,
      retries: 1,
    });
    if (result.error) continue;

    const services = extractMasterServiceItems(result.data)
      .map((item, index) => normalizeMasterServiceOption(item, index))
      .filter((item): item is MasterServiceOption => item !== null);
    if (services.length === 0) continue;

    const withStudio = services.filter((service) => service.studioIds.includes(studioId));
    const pool = withStudio.length > 0
      ? withStudio
      : services.filter((service) => service.studioIds.length === 0);
    const ranked = (pool.length > 0 ? pool : services)
      .slice()
      .sort((a, b) => scoreMasterService(b, studioId) - scoreMasterService(a, studioId));
    const picked = ranked[0];
    if (!picked?.id) continue;

    masterServiceByStudioCache.set(studioId, picked.id);
    return picked.id;
  }

  return null;
}

async function bootstrapMasterService(masterServiceId: string, studioId?: string | null) {
  if (!masterServiceId) return;

  const cacheKey = `${masterServiceId}:${studioId ?? ""}`;
  if (masterServiceBootstrapCache.has(cacheKey)) return;

  const base = `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/master-services/${masterServiceId}`;
  const baseSubServicesUrl = `${base}/subServices?`;
  const studiosUrl = `${base}/studios?`;

  await request<unknown>(`${base}/meta`, {
    method: "GET",
    auth: true,
    retries: 1,
  });

  await request<unknown>(baseSubServicesUrl, {
    method: "GET",
    auth: true,
    retries: 1,
  });

  const studiosResult = await request<unknown>(studiosUrl, {
    method: "GET",
    auth: true,
    retries: 1,
  });
  const timeZone =
    extractMasterServiceTimeZone(studiosResult.data, studioId) ??
    masterServiceTimeZoneCache.get(masterServiceId) ??
    "Europe/Moscow";
  masterServiceTimeZoneCache.set(masterServiceId, timeZone);

  await request<unknown>(`${API_BASE}/api/v1/time?timeZone=${encodeURIComponent(timeZone)}`, {
    method: "GET",
    retries: 1,
  });

  if (studioId) {
    const studioSubServicesResult = await request<unknown>(
      `${base}/subServices?studioId=${encodeURIComponent(studioId)}&showAll=true`,
      {
        method: "GET",
        auth: true,
        retries: 1,
      },
    );
    const studioGameModes = extractStudioGameModes(studioSubServicesResult.data, studioId);
    masterServiceStudioGameModesCache.set(cacheKey, studioGameModes);

    const selectedSubService = pickPreferredSubService(studioSubServicesResult.data, studioId);
    const defaultMode = studioGameModes.doubles ?? studioGameModes.singles;
    if (defaultMode?.subServiceIds.length) {
      masterServiceStudioSubServicesCache.set(cacheKey, defaultMode.subServiceIds);
    } else if (selectedSubService.allIds.length > 0) {
      masterServiceStudioSubServicesCache.set(cacheKey, selectedSubService.allIds);
    }
    if (defaultMode?.preferredSubServiceId) {
      masterServiceStudioPreferredSubServiceCache.set(cacheKey, defaultMode.preferredSubServiceId);
    } else if (selectedSubService.preferredId) {
      masterServiceStudioPreferredSubServiceCache.set(cacheKey, selectedSubService.preferredId);
    }
    if (defaultMode?.preferredRoomIds.length) {
      masterServiceStudioPreferredRoomIdsCache.set(cacheKey, defaultMode.preferredRoomIds);
    } else if (selectedSubService.preferredRoomIds.length > 0) {
      masterServiceStudioPreferredRoomIdsCache.set(cacheKey, selectedSubService.preferredRoomIds);
    }
  }

  masterServiceBootstrapCache.add(cacheKey);
}

function normalizeVivaStudio(item: unknown, index: number): Studio | null {
  if (!isRecord(item)) return null;

  const id = pickString(item, [...STATION_ID_KEYS]);
  if (!id) return null;

  const address = pickString(item, ["address", "fullAddress", "location", "street"]) ?? "";
  const resolvedName = pickString(item, ["name", "stationName", "studioName", "title"]);
  const name = (resolvedName ?? address) || `Станция ${index + 1}`;
  const city = pickString(item, ["city", "cityName", "town", "locality"]) ?? "Другой город";
  const country = pickString(item, ["country", "countryName"]) ?? "Россия";
  const masterServiceId = pickString(item, [
    "masterServiceId",
    "master_service_id",
    "masterService",
    "master_service",
    "serviceId",
    "productId",
  ]);
  const subServiceIds = uniqueIds([
    ...extractIdList(item.subServiceIds),
    ...extractIdList(item.sub_service_ids),
    ...extractIdList(item.subServiceId),
    ...extractIdList(item.sub_service_id),
    ...extractIdList(item.preferredSubServiceIds),
    ...extractIdList(item.preferred_sub_service_ids),
    ...extractIdList(item.preferredSubServiceId),
    ...extractIdList(item.preferred_sub_service_id),
  ]).filter((value) => isUuidLike(value));
  const preferredSubServiceId =
    pickString(item, [
      "preferredSubServiceId",
      "preferred_sub_service_id",
      "subServiceId",
      "sub_service_id",
    ]) ??
    (subServiceIds.length > 0 ? subServiceIds[0] : null);
  const coordsPayload = isRecord(item.coordinates)
    ? item.coordinates
    : isRecord(item.location)
      ? item.location
      : null;
  const lat =
    pickCoordinate(item, ["lat", "latitude", "geoLat"]) ??
    (coordsPayload ? pickCoordinate(coordsPayload, ["lat", "latitude"]) : null);
  const lng =
    pickCoordinate(item, ["lng", "lon", "longitude", "geoLng"]) ??
    (coordsPayload ? pickCoordinate(coordsPayload, ["lng", "lon", "longitude"]) : null);

  const courtsPayload = isRecord(item.courts) ? item.courts : null;
  const panoramicCourtsCount =
    pickNumber(item, [
      "panoramicCourtsCount",
      "panoramicCourts",
      "panoramicCount",
      "panoramicCourtsQty",
      "courtsPanoramic",
      "panoramic",
    ]) ??
    (courtsPayload
      ? pickNumber(courtsPayload, [
          "panoramicCourtsCount",
          "panoramicCourts",
          "panoramicCount",
          "panoramic",
        ])
      : null) ??
    countPanoramicRooms(item.rooms);

  return {
    id,
    name,
    country,
    city,
    address,
    panoramicCourtsCount,
    masterServiceId,
    preferredSubServiceId,
    subServiceIds,
    lat,
    lng,
  };
}

interface OnboardingStationSeed {
  id: string;
  name: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  panoramicCourtsCount: number | null;
  masterServiceId: string | null;
  preferredSubServiceId: string | null;
  subServiceIds: string[];
  lat: number | null;
  lng: number | null;
}

function extractStationSeedItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const listKeys = ["stations", "content", "data", "items", "result"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  const groupedKeys = ["byCity", "stationsByCity", "cities"];
  for (const key of groupedKeys) {
    const candidate = payload[key];
    if (!isRecord(candidate)) continue;
    const grouped = Object.values(candidate).flatMap((value) => (Array.isArray(value) ? value : []));
    if (grouped.length) return grouped;
  }

  const values = Object.values(payload);
  const hasIndexedKeys = Object.keys(payload).every((key) => /^\d+$/.test(key));
  const allScalarValues = values.every(
    (value) => typeof value === "string" || typeof value === "number",
  );
  if (hasIndexedKeys && allScalarValues) {
    return values;
  }

  const directId = pickString(payload, [...STATION_ID_KEYS]);
  if (directId) {
    return [payload];
  }

  const objectValues = values.filter((value): value is Record<string, unknown> => isRecord(value));
  if (
    objectValues.length > 0 &&
    objectValues.every((value) => pickString(value, [...STATION_ID_KEYS]))
  ) {
    return objectValues;
  }

  return [];
}

function normalizeStationSeed(item: unknown): OnboardingStationSeed | null {
  if (typeof item === "string" || typeof item === "number") {
    const id = toTrimmedString(item);
    if (!id) return null;
    return {
      id,
      name: null,
      country: null,
      city: null,
      address: null,
      panoramicCourtsCount: null,
      masterServiceId: null,
      preferredSubServiceId: null,
      subServiceIds: [],
      lat: null,
      lng: null,
    };
  }

  if (!isRecord(item)) return null;

  const id = pickString(item, [...STATION_ID_KEYS]);
  if (!id) return null;

  const courtsPayload = isRecord(item.courts) ? item.courts : null;
  const coordsPayload = isRecord(item.coordinates)
    ? item.coordinates
    : isRecord(item.location)
      ? item.location
      : null;
  const lat =
    pickCoordinate(item, ["lat", "latitude", "geoLat"]) ??
    (coordsPayload ? pickCoordinate(coordsPayload, ["lat", "latitude"]) : null);
  const lng =
    pickCoordinate(item, ["lng", "lon", "longitude", "geoLng"]) ??
    (coordsPayload ? pickCoordinate(coordsPayload, ["lng", "lon", "longitude"]) : null);
  const panoramicCourtsCount =
    pickNumber(item, [
      "panoramicCourtsCount",
      "panoramicCourts",
      "panoramicCount",
      "panoramicCourtsQty",
      "courtsPanoramic",
      "panoramic",
    ]) ??
    (courtsPayload
      ? pickNumber(courtsPayload, [
          "panoramicCourtsCount",
          "panoramicCourts",
          "panoramicCount",
          "panoramic",
        ])
      : null);
  const subServiceIds = uniqueIds([
    ...extractIdList(item.subServiceIds),
    ...extractIdList(item.sub_service_ids),
    ...extractIdList(item.subServiceId),
    ...extractIdList(item.sub_service_id),
    ...extractIdList(item.preferredSubServiceIds),
    ...extractIdList(item.preferred_sub_service_ids),
    ...extractIdList(item.preferredSubServiceId),
    ...extractIdList(item.preferred_sub_service_id),
  ]).filter((value) => isUuidLike(value));
  const preferredSubServiceId =
    pickString(item, [
      "preferredSubServiceId",
      "preferred_sub_service_id",
      "subServiceId",
      "sub_service_id",
    ]) ??
    (subServiceIds.length > 0 ? subServiceIds[0] : null);

  return {
    id,
    name: pickString(item, ["name", "stationName", "studioName", "title"]),
    country: pickString(item, ["country", "countryName"]),
    city: pickString(item, ["city", "cityName", "town", "locality"]),
    address: pickString(item, ["address", "fullAddress", "location", "street"]),
    panoramicCourtsCount,
    masterServiceId: pickString(item, [
      "masterServiceId",
      "master_service_id",
      "masterService",
      "master_service",
      "serviceId",
      "productId",
    ]),
    preferredSubServiceId,
    subServiceIds,
    lat,
    lng,
  };
}

function mergeStationWithViva(
  seed: OnboardingStationSeed,
  index: number,
  vivaStudio: Studio,
): Studio {
  const vivaRecord = isRecord(vivaStudio as unknown)
    ? (vivaStudio as unknown as Record<string, unknown>)
    : null;
  const panoramicFromViva = vivaRecord
    ? pickNumber(vivaRecord, [
        "panoramicCourtsCount",
        "panoramicCourts",
        "panoramicCount",
        "panoramicCourtsQty",
        "courtsPanoramic",
        "panoramic",
      ])
    : null;

  return {
    id: vivaStudio.id,
    name: vivaStudio.name || seed.name || `Станция ${index + 1}`,
    country: vivaStudio.country || seed.country || "Россия",
    city: vivaStudio.city || seed.city || "Другой город",
    address: vivaStudio.address || seed.address || "",
    panoramicCourtsCount:
      seed.panoramicCourtsCount ??
      panoramicFromViva ??
      vivaStudio.panoramicCourtsCount ??
      null,
    masterServiceId:
      seed.masterServiceId ??
      vivaStudio.masterServiceId ??
      DEFAULT_GAMES_MASTER_SERVICE_ID ??
      null,
    preferredSubServiceId:
      seed.preferredSubServiceId ??
      vivaStudio.preferredSubServiceId ??
      (seed.subServiceIds[0] ?? vivaStudio.subServiceIds?.[0] ?? null),
    subServiceIds: uniqueIds([
      ...(seed.subServiceIds ?? []),
      ...(vivaStudio.subServiceIds ?? []),
    ]),
    lat: seed.lat ?? vivaStudio.lat ?? null,
    lng: seed.lng ?? vivaStudio.lng ?? null,
  };
}

export interface Room {
  id: string;
  name: string;
}

export interface Grade {
  id: string;
  name: string;
}

export interface Trainer {
  id: string;
  firstName: string;
  lastName: string;
  photo?: string;
  grade?: Grade;
  bio?: string;
}

export interface Direction {
  id: number;
  name: string;
  description?: string | null;
  photo?: string | null;
  whatToTake?: string | null;
  photoWeb?: string | null;
  duration?: string | null;
}

export interface ExerciseType {
  id: number;
  name: string;
  color: string;
  format: string;
}

export interface Exercise {
  id: string;
  direction: Direction;
  type: ExerciseType;
  timeFrom: string;
  timeTo: string;
  clientsCount: number;
  maxClientsCount: number;
  girlsOnly: boolean;
  studio: Studio;
  room: Room;
  trainers: Trainer[];
  cancellationDeadline?: string | null;
}

export {
  isTournamentDirectionId,
  isTournamentExerciseCategory,
  type TournamentExerciseLike,
} from "./tournamentCategory";

export interface ExerciseBookingClient {
  id: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  photo?: string;
  phone?: string;
}

export interface ExerciseBooking {
  id: string;
  spot?: number;
  isCancelled?: boolean;
  client?: ExerciseBookingClient;
  rating?: string;
  ratingSource?: "level" | "phone";
}

export interface TournamentHistoryParticipant {
  id: string | null;
  name: string;
  phone: string | null;
  photo: string | null;
  rating: string | null;
}

export interface TournamentHistoryRecord {
  id: string;
  tournamentId: string;
  title: string | null;
  tournamentType: string | null;
  targetScore: number | null;
  courts: string[];
  participants: TournamentHistoryParticipant[];
  participantsCount: number;
  maxParticipants: number | null;
  minRating: string | null;
  maxRating: string | null;
  genderLabel: string | null;
  girlsOnly: boolean | null;
  mixed: boolean | null;
  organizer: TournamentHistoryParticipant | null;
  params: Record<string, unknown> | null;
  rounds: unknown[];
  standings: unknown[];
  summary: Record<string, unknown> | null;
  totals: AmericanoResultsResponse["totals"] | null;
  playerLogs: AmericanoResultsResponse["playerLogs"] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export type TournamentTypeKey =
  | "americano"
  | "americano_padelhub"
  | "americano_classic"
  | "paired_americano"
  | "mexicano"
  | "paired_mexicano";

export interface AmericanoTournamentPayload {
  tournamentId: string;
  tenantKey: string;
  createdAt: string;
  organizer: {
    id: string | null;
    phone: string | null;
    tenantKey: string;
  };
  tournamentType: TournamentTypeKey;
  targetScore: number;
  courts: string[];
  params?: Record<string, unknown>;
  participants: Array<{
    id: string | null;
    phone: string | null;
    rating: string | null;
    photo: string | null;
    name: string;
  }>;
  rounds?: Array<{
    id: string;
    index: number;
    byes?: string[];
    quality?: {
      score: number;
      label: string;
      explanation: string;
      averageCourtScore: number;
      minCourtScore: number;
      byeCount: number;
    };
    matches: Array<{
      id: string;
      court: string;
      courtIndex?: number;
      pair1: string[];
      pair2: string[];
      score1: number | null;
      score2: number | null;
      quality?: {
        score: number;
        label: string;
        explanation: string;
        partnerRepeatCount: number;
        opponentRepeatCount: number;
        balanceGap: number;
        courtRepeatPressure: number;
      };
      summary?: {
        pairPower1: number;
        pairPower2: number;
        balanceGap: number;
        partnerRepeatCount: number;
        opponentRepeatCount: number;
      };
    }>;
  }>;
}

export interface AmericanoResultsPayload {
  tournamentId: string;
  results: Array<{
    roundId: string;
    matchId: string;
    score1?: number;
    score2?: number;
    court?: string;
    courtIndex?: number;
    pair1?: string[];
    pair2?: string[];
  }>;
  params?: Record<string, unknown>;
}

export interface AmericanoResultsResponse {
  totals?: Record<
    string,
    {
      ratingBefore: number;
      ratingAfter: number;
      deltaTotal: number;
      wins: number;
      losses: number;
      draws: number;
      pointsFor: number;
      pointsAgainst: number;
      byeCount?: number;
      byePoints?: number;
      tournamentPoints?: number;
      playedPoints?: number;
      pointDiff?: number;
    }
  >;
  rounds?: unknown[];
  standings?: unknown[];
  summary?: Record<string, unknown>;
  playerLogs?: Record<
    string,
    Array<{
      roundId?: string;
      matchId?: string;
      scoreFor?: number;
      scoreAgainst?: number;
      delta?: number;
      ratingBefore?: number;
      ratingAfter?: number;
      expected?: number;
      actual?: number;
    }>
  >;
}

export interface PadelGamePlayer {
  id: string | null;
  name: string;
  phone: string | null;
  photo?: string | null;
  rating?: string | null;
  ratingNumeric?: number | null;
  source?: "ORGANIZER" | "INVITE_LINK" | "MANUAL_LIST" | "MANUAL_PHONE" | "ADMIN";
  status?: "CONFIRMED" | "WAITLIST" | "PENDING";
}

export interface PadelGameRecordPayload {
  gameId?: string | null;
  paymentRef?: string | null;
  tenantKey?: string | null;
  status?: "PAYMENT_PENDING" | "PAID" | "CANCELLED";
  organizer: {
    id: string | null;
    name: string | null;
    phone: string | null;
    photo?: string | null;
    rating?: string | null;
    ratingNumeric?: number | null;
  };
  booking: {
    studioId: string;
    studioName: string;
    masterServiceId: string | null;
    subServiceIds: string[];
    roomId: string;
    roomName: string;
    date: string;
    timeFrom: string;
    timeTo: string;
    timeFromIso: string;
    timeToIso: string;
    durationMinutes: number;
    slotId: string | null;
    bookingIds?: string[];
  };
  payment: {
    amount: number | null;
    paymentUrl: string | null;
    paymentMethod: "WIDGET";
    baseRedirectUrl?: string | null;
    paid?: boolean;
    paidAt?: string | null;
    paymentRef?: string | null;
    bookingIds?: string[];
  };
  settings?: {
    ratingGame?: boolean;
    minRating?: string | null;
    maxRating?: string | null;
    isPrivate?: boolean;
    payMode?: "self" | "split";
  };
  invite?: {
    inviteUrl?: string | null;
    waitlistEnabled?: boolean;
    maxPlayers?: number;
  };
  participants?: PadelGamePlayer[];
  waitlist?: PadelGamePlayer[];
  metadata?: Record<string, unknown>;
}

export interface PadelGameRecord {
  id: string;
  inviteUrl: string | null;
  status: string | null;
  participantPhones?: string[];
  waitlistPhones?: string[];
  allRelatedPhones?: string[];
  invitedPhones?: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  organizer?: {
    id: string | null;
    name: string | null;
    phone: string | null;
    photo: string | null;
    rating: string | null;
    ratingNumeric?: number | null;
  } | null;
  settings?: {
    ratingGame: boolean | null;
    minRating: string | null;
    maxRating: string | null;
    isPrivate: boolean | null;
    payMode?: "self" | "split" | null;
  } | null;
  participants?: PadelGamePlayer[];
  waitlist?: PadelGamePlayer[];
  invite?: {
    waitlistEnabled: boolean | null;
    maxPlayers: number | null;
  } | null;
  chatUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  booking?: {
    studioName: string | null;
    roomName: string | null;
    date: string | null;
    timeFrom: string | null;
    timeTo: string | null;
    durationMinutes: number | null;
    studioId?: string | null;
    roomId?: string | null;
    bookingId?: string | null;
    bookingIds?: string[];
    exerciseId?: string | null;
    vivaExerciseId?: string | null;
    subServiceIds?: string[];
  } | null;
  payment?: {
    amount: number | null;
    paymentUrl: string | null;
    paid: boolean | null;
  } | null;
}

export interface PadelPlayerCandidate {
  id: string | null;
  name: string;
  phone: string | null;
  photo: string | null;
  rating: string | null;
  ratingNumeric?: number | null;
}

export interface PadelLiveRatingRequestPlayer {
  clientId?: string | null;
  phone?: string | null;
  name?: string | null;
  rating?: string | null;
  ratingNumeric?: number | null;
}

export interface PadelLiveRatingItem {
  clientId: string | null;
  phoneNorm: string | null;
  name: string | null;
  rating: string | null;
  ratingNumeric: number | null;
  source: string | null;
}

export interface PadelGameChatMessageSender {
  id: string | null;
  phoneNorm: string | null;
  name: string | null;
  role: string | null;
}

export interface PadelGameChatMessage {
  id: string | null;
  gameId: string;
  type: string;
  text: string;
  createdAt: string | null;
  createdTs: number;
  sender: PadelGameChatMessageSender | null;
  deleted: boolean;
}

export interface PadelGameChatMessagesPage {
  gameId: string;
  phone: string | null;
  totalFetched: number;
  hasMore: boolean;
  nextBeforeTs: number | null;
  messages: PadelGameChatMessage[];
}

export interface PadelGameChatReadResponse {
  ok: boolean;
  read: {
    gameId: string;
    phoneNorm: string;
    lastReadTs: number;
    updatedAt: string | null;
  } | null;
}

export interface PadelChatSummaryItem {
  gameId: string;
  lastMessageTs: number;
  lastMessageAt: string | null;
  lastMessageText: string;
  lastMessageSenderPhone: string | null;
}

export interface PadelChatsByPhoneResponse {
  phone: string | null;
  total: number;
  chats: PadelChatSummaryItem[];
}

export interface SupportDialogAI {
  lastTopic: string | null;
  lastSentiment: string | null;
  lastPriority: string | null;
  topicTags: string[];
  needsAttention: boolean;
}

export interface SupportDialogLastMessage {
  preview: string;
  direction: string;
  authorType: string;
  channel: string | null;
  createdAt: string | null;
  createdTs: number | null;
}

export interface SupportDialog {
  id: string;
  clientId: string | null;
  displayName: string;
  primaryPhone: string | null;
  phoneNumbers: string[];
  stationId: string;
  stationName: string;
  status: string;
  authStatus: string;
  workflowState: string;
  channels: string[];
  connectors: string[];
  lastConnector: string | null;
  unreadClientMessages: number;
  pendingResponseSinceTs: number | null;
  firstResponseMinutes: number | null;
  lastResponseMinutes: number | null;
  avgResponseMinutes: number | null;
  maxResponseMinutes: number | null;
  ai: SupportDialogAI | null;
  lastMessage: SupportDialogLastMessage;
  createdAt: string | null;
  updatedAt: string | null;
  updatedTs: number | null;
}

export interface SupportDialogsResponse {
  total: number;
  dialogs: SupportDialog[];
  summary: {
    unanswered: number;
    pendingAuth: number;
  };
}

export interface SupportDialogMessageSender {
  id: string | null;
  name: string | null;
  role: string | null;
}

export interface SupportDialogMessage {
  id: string;
  dialogId: string;
  clientId: string | null;
  stationId: string | null;
  stationName: string | null;
  direction: string;
  authorType: string;
  eventType: string;
  channel: string;
  connector: string | null;
  text: string;
  textPreview: string;
  createdAt: string | null;
  createdTs: number;
  sender: SupportDialogMessageSender | null;
  deleted: boolean;
  metadata: Record<string, unknown> | null;
}

export interface SupportDialogMessagesPage {
  dialogId: string;
  totalFetched: number;
  hasMore: boolean;
  nextBeforeTs: number | null;
  messages: SupportDialogMessage[];
}

export interface SupportDialogEventPayload {
  connector?: string | null;
  channel?: string;
  direction?: "INBOUND" | "OUTBOUND" | "SYSTEM";
  authorType?: string;
  eventType?: string;
  text?: string;
  message?: string;
  content?: string;
  phone?: string;
  phoneNumber?: string;
  primaryPhone?: string;
  displayName?: string | null;
  clientName?: string | null;
  senderName?: string | null;
  userId?: string | null;
  clientId?: string | null;
  senderId?: string | null;
  channelUserId?: string | null;
  chatId?: string | null;
  externalThreadId?: string | null;
  stationId?: string | null;
  stationName?: string | null;
  authStatus?: string;
  workflowState?: string;
  metadata?: Record<string, unknown>;
}

export interface SupportDialogEventResponse {
  ok: boolean;
  client: Record<string, unknown> | null;
  dialog: SupportDialog | null;
  message: SupportDialogMessage | null;
}

interface SupportClientResolveResult {
  found: boolean;
  clientId: string | null;
}

export interface Booking {
  id: string;
  spot: number;
  paymentType: string;
  isCancelled: boolean;
  cancellationReason?: string | null;
  visitConfirmed: boolean;
  exercise?: Exercise;
  reviewRate?: number | null;
  reviewComment?: string | null;
  clientSubscriptionId?: string | null;
  clientOneTimeId?: string | null;
  cost: number;
  transactionStatus?: {
    transactionId: string;
    transactionStatus: string;
    cardPaymentStatus?: {
      paymentId: string;
      paymentUrl: string;
      status: string;
      originalStatus: string;
      errorCode?: string | null;
    } | null;
  } | null;
  cancellationDeadline: string;
}

export interface BookingsResponse {
  content: Booking[];
  pageable: {
    pageNumber: number;
    pageSize: number;
    sort: {
      empty: boolean;
      sorted: boolean;
      unsorted: boolean;
    };
    offset: number;
    paged: boolean;
  };
  totalPages: number;
  totalElements: number;
  last: boolean;
  first: boolean;
  numberOfElements: number;
  size: number;
  number: number;
  empty: boolean;
}

export interface PadelGamesByPhoneResponse {
  games: PadelGameRecord[];
  total: number;
}

export interface PadelAvailableGamesResponse {
  games: PadelGameRecord[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

export interface UpdateProfileData {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  photo: string | null;
  sex: string | null;
  customFields?: CustomFieldValue[];
}

export interface SubscriptionName {
  sertName: string;
}

export interface PaymentUrl {
  toPay: number;
  paymentUrl: string | null;
  bookingIds?: string[];
  paid?: boolean | null;
}

export interface PadelSplitPaymentParams {
  date: string;
  fromTime: string;
  toTime: string;
  activeTo?: string | null;
  studioId: string;
  roomId: string;
  studioName?: string | null;
  roomName?: string | null;
  clientId?: string | null;
  clientPhone?: string | null;
  paymentRef?: string | null;
  baseRedirectUrl?: string | null;
  successUrl?: string | null;
  failUrl?: string | null;
  shareCount: 2 | 4;
  shareAmount: number;
  shareAmountIncludesDuration?: boolean;
  durationMinutes?: number | null;
  maxClientsCount?: number | null;
  spot?: number | null;
  vivaDirectionId?: number | null;
  vivaExerciseTypeId?: number | null;
}

export interface PadelSplitPaymentResult {
  paymentRef: string | null;
  paymentUrl: string | null;
  toPay: number;
  toPayMinor: number | null;
  shareAmount: number | null;
  shareAmountMinor: number | null;
  baseShareAmount: number | null;
  baseShareAmountMinor: number | null;
  discountAmount: number | null;
  discountAmountMinor: number | null;
  deadlineAt: string | null;
  exerciseId: string | null;
  bookingId: string | null;
  productId: string | null;
  transactionId: string | null;
  spot: number | null;
  raw?: unknown;
}

export interface PromoDiscountSummary {
  discount: number;
  bonusPoints: number;
}

export type ApiStatus = number | null;

export interface ApiError {
  status: ApiStatus;
  message: string;
  raw?: unknown;
}

export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
  status: ApiStatus;
}

export interface RequestOptions extends RequestInit {
  auth?: boolean;
  retries?: number;
  baseUrl?: string;
  signal?: AbortSignal;
  cacheTtlMs?: number;
  dedupe?: boolean;
}

type CachedApiResult = ApiResult<unknown>;

type DevRequestCacheEntry = {
  expiresAt: number;
  result: CachedApiResult;
};

const devRequestCache = new Map<string, DevRequestCacheEntry>();
const devInflightRequests = new Map<string, Promise<CachedApiResult>>();

function pruneExpiredDevRequestCache() {
  const now = Date.now();
  devRequestCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      devRequestCache.delete(key);
    }
  });
}

function readDevRequestCache(
  key: string,
  options: {
    allowExpired?: boolean;
  } = {},
): CachedApiResult | null {
  const entry = devRequestCache.get(key);
  if (!entry) return null;
  if (options.allowExpired || entry.expiresAt > Date.now()) {
    return entry.result;
  }
  return null;
}

function writeDevRequestCache<T>(key: string, result: ApiResult<T>, ttlMs: number) {
  if (ttlMs <= 0) return;
  pruneExpiredDevRequestCache();
  devRequestCache.set(key, {
    expiresAt: Date.now() + ttlMs,
    result: result as CachedApiResult,
  });
}

function resolveRequestCacheConfig(url: string, options: RequestOptions) {
  const method = String(options.method || "GET").toUpperCase();
  if (!IS_DEV_RELEASE_CHANNEL || method !== "GET" || options.signal) {
    return null;
  }

  const ttlMs = Number.isFinite(options.cacheTtlMs)
    ? Math.max(0, Number(options.cacheTtlMs))
    : 0;
  const dedupe = options.dedupe ?? ttlMs > 0;
  if (!dedupe && ttlMs <= 0) {
    return null;
  }

  const baseUrl = options.baseUrl ?? API_BASE;
  const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;
  const authToken = options.auth ? getCookie(`${TENANT_KEY}AuthToken`) : null;
  const authScope = options.auth ? (authToken ? authToken.slice(-24) : "missing-auth") : "public";

  return {
    key: `${method}:${fullUrl}:auth=${authScope}`,
    ttlMs,
    dedupe,
  };
}

async function rawRequest<T>(
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const {
    auth = false,
    baseUrl = API_BASE,
    cacheTtlMs: _cacheTtlMs,
    dedupe: _dedupe,
    ...fetchOptions
  } = options;

  const headers = new Headers(fetchOptions.headers ?? {});

  if (auth) {
    const token = getCookie(`${TENANT_KEY}AuthToken`);
    if (!token) {
      return {
        data: null,
        error: { status: 401, message: "Не авторизован" },
        status: 401,
      };
    }
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  if (
    fetchOptions.body &&
    !headers.has("Content-Type") &&
    !(fetchOptions.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }

  const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;

  let response: Response;

  try {
    response = await fetch(fullUrl, { ...fetchOptions, headers });
  } catch (err) {
    trackClientError(
      "api.request_network_error",
      err,
      {
        url: fullUrl,
        method: fetchOptions.method ?? "GET",
      },
      { handled: true, severity: "error" },
    );
    return {
      data: null,
      error: { status: null, message: "Ошибка сети", raw: err },
      status: null,
    };
  }

  const status = response.status;

  let payload: unknown = null;
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => null);
  }

  if (status === 304) {
    return {
      data: null,
      error: null,
      status,
    };
  }

  if (!response.ok) {
    const message =
      (isRecord(payload) && (pickString(payload, ["message", "error_description"]) || null)) ||
      `Ошибка запроса (${status})`;

    trackClientError(
      "api.request_http_error",
      new Error(message),
      {
        url: fullUrl,
        method: fetchOptions.method ?? "GET",
        status,
        response: summarizeApiErrorPayload(payload),
      },
      { handled: true, severity: status >= 500 ? "error" : "warning" },
    );

    return {
      data: null,
      error: { status, message, raw: payload },
      status,
    };
  }

  return {
    data: (payload as T) ?? null,
    error: null,
    status,
  };
}

export async function request<T>(
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { retries = 0 } = options;
  const cacheConfig = resolveRequestCacheConfig(url, options);

  if (cacheConfig) {
    const cached = readDevRequestCache(cacheConfig.key);
    if (cached) {
      return cached as ApiResult<T>;
    }
    if (cacheConfig.dedupe) {
      const inflight = devInflightRequests.get(cacheConfig.key);
      if (inflight) {
        return inflight as Promise<ApiResult<T>>;
      }
    }
  }

  const executeRequest = async (): Promise<ApiResult<T>> => {
    const result = retries > 0
      ? await withRetry(() => rawRequest<T>(url, options), { retries })
      : await rawRequest<T>(url, options);

    if (cacheConfig && result.status === 304) {
      const cached = readDevRequestCache(cacheConfig.key, { allowExpired: true });
      if (cached) {
        writeDevRequestCache(cacheConfig.key, cached, cacheConfig.ttlMs);
        return cached as ApiResult<T>;
      }
    }

    if (cacheConfig && !result.error && cacheConfig.ttlMs > 0) {
      writeDevRequestCache(cacheConfig.key, result, cacheConfig.ttlMs);
    }

    return result;
  };

  if (!cacheConfig?.dedupe) {
    return executeRequest();
  }

  const sharedRequest = executeRequest() as Promise<CachedApiResult>;
  devInflightRequests.set(cacheConfig.key, sharedRequest);
  sharedRequest.finally(() => {
    if (devInflightRequests.get(cacheConfig.key) === sharedRequest) {
      devInflightRequests.delete(cacheConfig.key);
    }
  });
  return sharedRequest as Promise<ApiResult<T>>;
}

export function getServ2Origin() {
  try {
    return new URL(SERV2).origin;
  } catch {
    return SERV2;
  }
}

function shouldFallback(result: ApiResult<unknown>) {
  return result.status == null || result.status >= 500;
}

async function requestWithFallback<T>(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const primary = await request<T>(primaryUrl, options);
  if (!fallbackUrl || fallbackUrl === primaryUrl) return primary;
  if (!shouldFallback(primary)) return primary;
  const fallback = await request<T>(fallbackUrl, options);
  return fallback.data ? fallback : primary;
}

async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>,
  {
    retries = 2,
    baseDelayMs = 300,
  }: { retries?: number; baseDelayMs?: number } = {},
): Promise<ApiResult<T>> {
  const isSuccessStatus = (status: ApiStatus) =>
    status === 304 || (typeof status === "number" && status >= 200 && status < 300);

  let attempt = 0;
  while (true) {
    try {
      const res = await fn();
      if (!isSuccessStatus(res.status)) {
        attempt++;
        if (attempt > retries) {
          return res;
        }
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        return res;
      }
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        return {
          data: null,
          error: { status: null, message: "Ошибка сети", raw: err },
          status: null,
        };
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

export async function apiFetchProfile() {
  return request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
    method: "GET",
    auth: true,
    retries: 1,
  });
}

export async function apiUpdateProfile(data: UpdateProfileData) {
  return request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
    method: "PATCH",
    auth: true,
    retries: 1,
    body: JSON.stringify(data),
  });
}

export interface OnboardingLevelPayload {
  clientId: string;
  phone?: string | null;
  levelLetter: string;
  levelNumeric: string | number;
}

export async function apiSaveOnboardingLevel(payload: OnboardingLevelPayload) {
  const serv2Origin = (getServ2Origin() || "").trim();
  const onboardingUrl = serv2Origin
    ? `${serv2Origin.replace(/\/+$/, "")}/lk/onboarding/level`
    : "/lk/onboarding/level";

  const result = await request<{ ok?: boolean; success?: boolean; message?: string; error?: string }>(onboardingUrl, {
    method: "POST",
    auth: true,
    retries: 1,
    body: JSON.stringify(payload),
  });

  if (
    !result.error
    && isRecord(result.data)
    && (
      result.data.ok === false
      || result.data.success === false
    )
  ) {
    return {
      data: result.data,
      error: {
        status: result.status,
        message:
          pickString(result.data, ["message", "error", "error_description"])
          || "Не удалось обновить данные в Viva",
        raw: result.data,
      },
      status: result.status,
    };
  }

  return result;
}

export async function apiUpdateCustomFields(profile: UserProfileType, customFields: CustomField[]) {
  const customFieldValues: CustomFieldValue[] = customFields.map((field) => ({
    id: field.id,
    value: field.value ?? [],
  }));
  return apiUpdateProfile({
    email: profile.email ?? null,
    firstName: profile.firstName ?? null,
    lastName: profile.lastName ?? null,
    middleName: profile.middleName ?? null,
    photo: profile.photo ?? null,
    sex: profile.sex ?? "U",
    customFields: customFieldValues,
  });
}

export async function apiUploadProfilePhoto(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return request<string>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/profile/photo`,
    {
      method: "PUT",
      auth: true,
      retries: 1,
      body: formData,
    },
  );
}

function buildBookingCancelPayload(): Record<string, string> {
  const refundType = BOOKING_CANCEL_REFUND_TYPE?.trim();
  if (!refundType || refundType.toLowerCase() === "none") {
    return {};
  }

  return { refundType };
}

export async function apiFetchBookings(
  includeCanceled: boolean,
  options: {
    size?: number;
  } = {},
) {
  const size = Number.isFinite(options.size)
    ? Math.max(1, Math.min(1000, Math.floor(options.size as number)))
    : 1000;
  const url = includeCanceled
    ? `/end-user/api/v2/${TENANT_KEY}/bookings/history?includeCanceled=true&size=${size}`
    : `/end-user/api/v2/${TENANT_KEY}/bookings?size=${size}`;

  return request<BookingsResponse>(url, {
    method: "GET",
    auth: true,
    retries: 1,
  });
}

export async function apiCancelBooking(bookingId: string) {
  return request<BookingsResponse>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/bookings/${bookingId}`,
    {
      method: "DELETE",
      auth: true,
      retries: 1,
      body: JSON.stringify(buildBookingCancelPayload()),
    },
  );
}

export async function apiFetchSubscriptions() {
  return request<SubscriptionResponse>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/subscriptions`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchExercisesByDate(
  date: string,
  options: {
    includePast?: boolean;
  } = {},
) {
  const query = new URLSearchParams({ date });
  if (options.includePast) {
    query.set("includePast", "true");
    query.set("past", "true");
    if (!IS_DEV_RELEASE_CHANNEL) {
      query.set("_ts", String(Date.now()));
    }
  }

  return request<Exercise[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises?${query.toString()}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
      ...(IS_DEV_RELEASE_CHANNEL
        ? {
            cacheTtlMs: DEV_EXERCISES_CACHE_TTL_MS,
            dedupe: true,
          }
        : {
            cache: "no-store" as RequestCache,
          }),
    },
  );
}

function extractExercisesResponse(data: unknown): Exercise[] {
  if (Array.isArray(data)) {
    return data as Exercise[];
  }
  if (isRecord(data) && Array.isArray(data.content)) {
    return data.content as Exercise[];
  }
  return [];
}

export async function apiFetchExercisesByPeriod(
  dateFrom: string,
  dateTo: string,
  options: {
    size?: number;
  } = {},
): Promise<ApiResult<Exercise[]>> {
  const query = new URLSearchParams({
    dateFrom,
    dateTo,
    size: String(options.size ?? 5000),
  });

  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises/period?${query.toString()}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
      ...(IS_DEV_RELEASE_CHANNEL
        ? {
            cacheTtlMs: DEV_EXERCISES_CACHE_TTL_MS,
            dedupe: true,
          }
        : {
            cache: "no-store" as RequestCache,
          }),
    },
  );

  if (result.error) {
    return {
      data: null,
      error: result.error,
      status: result.status,
    };
  }

  return {
    data: extractExercisesResponse(result.data),
    error: null,
    status: result.status,
  };
}

function formatExerciseQueryDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftExerciseQueryDate(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setDate(parsed.getDate() + days);
  return formatExerciseQueryDate(parsed);
}

function getExerciseResponseDateKey(exercise: Pick<Exercise, "timeFrom"> | null | undefined) {
  if (!exercise?.timeFrom) return null;
  const parsed = new Date(exercise.timeFrom);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatExerciseQueryDate(parsed);
}

function mergeExercisesForDate(exerciseGroups: Array<Exercise[] | null | undefined>, date: string) {
  const merged = new Map<string, Exercise>();

  exerciseGroups.forEach((group) => {
    (group ?? []).forEach((exercise) => {
      const id = String(exercise?.id || "").trim();
      if (!id || getExerciseResponseDateKey(exercise) !== date) return;
      merged.set(id, exercise);
    });
  });

  return Array.from(merged.values()).sort((left, right) => {
    const leftTs = Date.parse(left.timeFrom || "");
    const rightTs = Date.parse(right.timeFrom || "");
    const safeLeftTs = Number.isFinite(leftTs) ? leftTs : 0;
    const safeRightTs = Number.isFinite(rightTs) ? rightTs : 0;
    return safeLeftTs - safeRightTs;
  });
}

export async function apiFetchExercisesByVisibleDate(
  date: string,
  options: {
    includePast?: boolean;
    includeAdjacentDays?: boolean;
  } = {},
): Promise<ApiResult<Exercise[]>> {
  const primaryResult = await apiFetchExercisesByDate(date, { includePast: options.includePast });
  if (!options.includeAdjacentDays) {
    return primaryResult;
  }

  const previousDate = shiftExerciseQueryDate(date, -1);
  const nextDate = shiftExerciseQueryDate(date, 1);

  if (!previousDate || !nextDate) {
    return primaryResult;
  }

  // Work around backend day-boundary issues around the selected day with one range query.
  const periodResult = await apiFetchExercisesByPeriod(previousDate, nextDate, { size: 5000 });
  if (periodResult.error && primaryResult.error) {
    return {
      data: null,
      error: primaryResult.error,
      status: primaryResult.status,
    };
  }

  const mergedData = mergeExercisesForDate(
    [periodResult.data ?? [], primaryResult.data ?? []],
    date,
  );

  return {
    data: mergedData,
    error: null,
    status: periodResult.status || primaryResult.status,
  };
}

export async function apiFetchExerciseBookings(exerciseId: string) {
  return request<ExerciseBooking[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises/${exerciseId}/bookings`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchTournamentParticipants(exerciseId: string) {
  const base = getServ2Origin();
  return request<ExerciseBooking[]>(
    `${base}/lk/tournaments/participants?exerciseId=${exerciseId}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

function normalizeTournamentHistoryParticipant(
  value: unknown,
  index: number,
): TournamentHistoryParticipant | null {
  if (!isRecord(value)) return null;

  const firstName = pickString(value, ["firstName", "name"]);
  const lastName = pickString(value, ["lastName", "surname"]);
  const displayName = pickString(value, ["displayName", "fullName", "title"]);
  const composedName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = displayName || composedName || `Участник ${index + 1}`;

  return {
    id: pickString(value, ["id", "clientId", "userId", "uuid"]),
    name,
    phone: pickString(value, ["phone", "phoneNumber", "mobile"]),
    photo: pickString(value, ["photo", "avatar", "imageUrl"]),
    rating: pickString(value, ["rating", "level", "grade"]),
  };
}

function normalizeTournamentGenderLabel(value: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  if (["women", "female", "girls", "ladies"].includes(lowered)) return "Женщины";
  if (["men", "male", "boys"].includes(lowered)) return "Мужчины";
  if (["mixed", "mix", "mixt", "микст"].includes(lowered)) return "Микст";
  if (["common", "open", "all", "general"].includes(lowered)) return "Общий";
  return normalized;
}

function normalizeTournamentHistoryRecord(value: unknown): TournamentHistoryRecord | null {
  if (!isRecord(value)) return null;

  const tournamentId = pickString(value, ["tournamentId", "exerciseId", "id"]);
  if (!tournamentId) return null;

  const paramsPayload = isRecord(value.params) ? value.params : null;
  const summaryPayload = isRecord(value.summary) ? value.summary : null;
  const organizerPayload = isRecord(value.organizer) ? value.organizer : null;
  const totalsPayload = isRecord(value.totals)
    ? (value.totals as AmericanoResultsResponse["totals"])
    : null;
  const playerLogsPayload = isRecord(value.playerLogs)
    ? (value.playerLogs as AmericanoResultsResponse["playerLogs"])
    : null;
  const participants = Array.isArray(value.participants)
    ? value.participants
      .map((item, index) => normalizeTournamentHistoryParticipant(item, index))
      .filter((item): item is TournamentHistoryParticipant => item !== null)
    : [];
  const explicitParticipantsCount =
    pickNumber(value, ["participantsCount", "joinedCount", "clientsCount"]) ??
    (paramsPayload ? pickNumber(paramsPayload, ["participantsCount", "joinedCount", "clientsCount"]) : null);
  const explicitMaxParticipants =
    pickNumber(value, ["maxParticipants", "maxClientsCount", "playersLimit", "limit"]) ??
    (paramsPayload
      ? pickNumber(paramsPayload, ["maxParticipants", "maxClientsCount", "maxPlayers", "playersLimit", "limit"])
      : null);
  const girlsOnly =
    toBoolean(value.girlsOnly) ??
    (paramsPayload
      ? (
        toBoolean(paramsPayload.girlsOnly)
        ?? toBoolean(paramsPayload.womenOnly)
        ?? toBoolean(paramsPayload.femaleOnly)
      )
      : null);
  const mixed =
    toBoolean(value.mixed) ??
    (paramsPayload
      ? (
        toBoolean(paramsPayload.mixed)
        ?? toBoolean(paramsPayload.mix)
        ?? toBoolean(paramsPayload.isMixed)
      )
      : null);
  const genderLabel =
    normalizeTournamentGenderLabel(
      pickString(value, ["genderLabel", "gender", "sex", "category", "division"])
      ?? (paramsPayload ? pickString(paramsPayload, ["genderLabel", "gender", "sex", "category", "division"]) : null),
    )
    ?? (girlsOnly ? "Женщины" : null)
    ?? (mixed ? "Микст" : null);

  return {
    id: tournamentId,
    tournamentId,
    title:
      pickString(value, ["title", "name", "displayName", "tournamentName", "label"])
      ?? (paramsPayload ? pickString(paramsPayload, ["title", "name", "displayName", "tournamentName", "label"]) : null)
      ?? (summaryPayload ? pickString(summaryPayload, ["title", "name", "displayName", "tournamentName"]) : null),
    tournamentType:
      pickString(value, ["tournamentType", "type"])
      ?? (paramsPayload ? pickString(paramsPayload, ["tournamentType", "type", "format"]) : null),
    targetScore:
      pickNumber(value, ["targetScore", "scoreTarget"])
      ?? (paramsPayload ? pickNumber(paramsPayload, ["targetScore", "scoreTarget"]) : null),
    courts: Array.isArray(value.courts)
      ? value.courts
        .map((item) => toTrimmedString(item))
        .filter((item): item is string => Boolean(item))
      : [],
    participants,
    participantsCount: explicitParticipantsCount ?? participants.length,
    maxParticipants: explicitMaxParticipants,
    minRating:
      (paramsPayload ? pickString(paramsPayload, ["minRating", "ratingFrom", "ratingMin"]) : null)
      ?? pickString(value, ["minRating", "ratingFrom", "ratingMin"]),
    maxRating:
      (paramsPayload ? pickString(paramsPayload, ["maxRating", "ratingTo", "ratingMax"]) : null)
      ?? pickString(value, ["maxRating", "ratingTo", "ratingMax"]),
    genderLabel,
    girlsOnly,
    mixed,
    organizer: organizerPayload ? normalizeTournamentHistoryParticipant(organizerPayload, 0) : null,
    params: paramsPayload,
    rounds: Array.isArray(value.rounds) ? value.rounds : [],
    standings: Array.isArray(value.standings) ? value.standings : [],
    summary: summaryPayload,
    totals: totalsPayload,
    playerLogs: playerLogsPayload,
    createdAt: pickString(value, ["createdAt", "created"]),
    updatedAt: pickString(value, ["updatedAt", "updated"]),
  };
}

export async function apiFetchTournamentHistory(tournamentId: string) {
  const base = getServ2Origin();
  const result = await request<unknown>(
    `${base}/lk/tournaments/americano/history?tournamentId=${encodeURIComponent(tournamentId)}`,
    {
      method: "GET",
      retries: 1,
      ...(IS_DEV_RELEASE_CHANNEL
        ? {
            cacheTtlMs: DEV_TOURNAMENT_HISTORY_CACHE_TTL_MS,
            dedupe: true,
          }
        : {}),
    },
  );

  const payload = result.data;
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { content?: unknown[] } | null | undefined)?.content)
      ? (payload as { content: unknown[] }).content
      : payload
        ? [payload]
        : [];

  return {
    data: items
      .map((item) => normalizeTournamentHistoryRecord(item))
      .filter((item): item is TournamentHistoryRecord => item !== null),
    error: result.error,
    status: result.status,
  };
}

export async function apiCreateAmericanoTournament(payload: AmericanoTournamentPayload) {
  const base = getServ2Origin();
  return request<{ ok?: boolean }>(`${base}/lk/tournaments/americano`, {
    method: "POST",
    retries: 1,
    body: JSON.stringify(payload),
  });
}

export async function apiUpdateAmericanoResults(payload: AmericanoResultsPayload) {
  const base = getServ2Origin();
  return request<AmericanoResultsResponse>(`${base}/lk/tournaments/americano/results`, {
    method: "POST",
    retries: 1,
    body: JSON.stringify(payload),
  });
}

export async function apiFetchStudios() {
  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/studios?size=1000`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );

  if (result.error) {
    return {
      data: [],
      error: result.error,
      status: result.status,
    };
  }

  const rawStudios = extractVivaStudioItems(result.data);
  const studios = rawStudios
    .map((item, index) => normalizeVivaStudio(item, index))
    .filter((item): item is Studio => item !== null);

  return {
    data: studios,
    error: null,
    status: result.status,
  };
}

export async function apiFetchOnboardingStations() {
  const baseUrl = getServ2Origin() || "";
  const onboardingResult = await request<unknown>(`/lk/onboarding/stations`, {
    method: "GET",
    baseUrl,
    retries: 1,
  });

  const rawSeeds = extractStationSeedItems(onboardingResult.data);
  const stationToMasterService = extractStationMasterServiceMap(onboardingResult.data);
  const stationToSubServices = extractStationSubServiceMap(onboardingResult.data);
  const seedStations = rawSeeds
    .map((item) => normalizeStationSeed(item))
    .filter((item): item is OnboardingStationSeed => item !== null)
    .map((seed) => {
      const mappedSubServices = stationToSubServices.get(seed.id) ?? [];
      const mergedSubServiceIds = uniqueIds([
        ...(seed.subServiceIds ?? []),
        ...mappedSubServices,
      ]);
      const preferredSubServiceId =
        seed.preferredSubServiceId ??
        (mergedSubServiceIds.length > 0 ? mergedSubServiceIds[0] : null);

      if (seed.masterServiceId) {
        return {
          ...seed,
          preferredSubServiceId,
          subServiceIds: mergedSubServiceIds,
        };
      }
      const mappedMasterService = stationToMasterService.get(seed.id) ?? null;
      if (!mappedMasterService) {
        return {
          ...seed,
          preferredSubServiceId,
          subServiceIds: mergedSubServiceIds,
        };
      }
      return {
        ...seed,
        masterServiceId: mappedMasterService,
        preferredSubServiceId,
        subServiceIds: mergedSubServiceIds,
      };
    });

  const uniqueSeeds: OnboardingStationSeed[] = [];
  seedStations.forEach((station) => {
    const existingIndex = uniqueSeeds.findIndex((item) => item.id === station.id);
    if (existingIndex < 0) {
      uniqueSeeds.push(station);
      return;
    }
    const existing = uniqueSeeds[existingIndex];
    uniqueSeeds[existingIndex] = {
      id: existing.id,
      name: existing.name ?? station.name,
      country: existing.country ?? station.country,
      city: existing.city ?? station.city,
      address: existing.address ?? station.address,
      panoramicCourtsCount: existing.panoramicCourtsCount ?? station.panoramicCourtsCount,
      masterServiceId: existing.masterServiceId ?? station.masterServiceId,
      preferredSubServiceId:
        existing.preferredSubServiceId ??
        station.preferredSubServiceId ??
        (existing.subServiceIds[0] ?? station.subServiceIds[0] ?? null),
      subServiceIds: uniqueIds([...(existing.subServiceIds ?? []), ...(station.subServiceIds ?? [])]),
      lat: existing.lat ?? station.lat,
      lng: existing.lng ?? station.lng,
    };
  });

  if (uniqueSeeds.length === 0) {
    return {
      data: [],
      error:
        onboardingResult.error ??
        { status: onboardingResult.status, message: "Станции не настроены в Node-RED" },
      status: onboardingResult.status,
    };
  }

  const vivaResult = await apiFetchStudios();
  if (vivaResult.error) {
    return {
      data: [],
      error: vivaResult.error,
      status: vivaResult.status,
    };
  }

  const vivaById = new Map(vivaResult.data.map((studio) => [studio.id, studio]));
  const stations = uniqueSeeds.flatMap((seed, index) => {
    const vivaStudio = vivaById.get(seed.id);
    if (!vivaStudio) return [];
    return [mergeStationWithViva(seed, index, vivaStudio)];
  });

  if (stations.length === 0) {
    return {
      data: [],
      error: {
        status: 404,
        message: "В Viva не найдены станции по ID из Node-RED",
      },
      status: 404,
    };
  }

  return {
    data: stations,
    error: null,
    status: vivaResult.status ?? onboardingResult.status,
  };
}

function normalizePadelGamePlayer(item: unknown): PadelGamePlayer | null {
  if (!isRecord(item)) return null;
  const id = pickString(item, ["id", "clientId", "userId", "uuid"]);
  const firstName = pickString(item, ["firstName", "name"]);
  const lastName = pickString(item, ["lastName", "surname"]);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const phone = pickString(item, ["phone", "phoneNumber", "mobile"]);
  const photo = pickString(item, ["photo", "avatar", "imageUrl"]);
  const rating = pickString(item, ["rating", "level", "grade"]);
  const ratingNumeric = pickNumeric(item, ["ratingNumeric", "numericRating", "levelNumeric"]);
  const sourceRaw = pickString(item, ["source", "origin", "type"]);
  const statusRaw = pickString(item, ["status", "state"]);

  const source = sourceRaw
    ? (sourceRaw.toUpperCase() as PadelGamePlayer["source"])
    : undefined;
  const status = statusRaw
    ? (statusRaw.toUpperCase() as PadelGamePlayer["status"])
    : undefined;

  if (!fullName && !phone && !id) return null;

  return {
    id: id ?? null,
    name: fullName || "Игрок",
    phone: phone ?? null,
    photo: photo ?? null,
    rating: rating ?? null,
    ratingNumeric,
    source,
    status,
  };
}

function extractPadelGamePlayerItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const listKeys = ["participants", "players", "members", "content", "items", "data"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function normalizePadelGameRecord(payload: unknown): PadelGameRecord | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const parsed = normalizePadelGameRecord(item);
      if (parsed) return parsed;
    }
    return null;
  }
  if (!isRecord(payload)) return null;

  const directId = pickString(payload, ["id", "gameId", "recordId", "uuid"]);
  const inviteUrl = pickString(payload, ["inviteUrl", "inviteLink", "shareUrl", "link"]);
  const status = pickString(payload, ["status", "state"]);
  if (directId) {
    const dataPayload = isRecord(payload.data) ? payload.data : null;
    const bookingPayload = isRecord(payload.booking)
      ? payload.booking
      : dataPayload && isRecord(dataPayload.booking)
        ? dataPayload.booking
        : null;
    const paymentPayload = isRecord(payload.payment)
      ? payload.payment
      : dataPayload && isRecord(dataPayload.payment)
        ? dataPayload.payment
        : null;
    const settingsPayload = isRecord(payload.settings)
      ? payload.settings
      : dataPayload && isRecord(dataPayload.settings)
        ? dataPayload.settings
        : null;
    const metadataPayload = isRecord(payload.metadata)
      ? payload.metadata
      : dataPayload && isRecord(dataPayload.metadata)
        ? dataPayload.metadata
        : null;
    const organizerPayload = isRecord(payload.organizer)
      ? payload.organizer
      : dataPayload && isRecord(dataPayload.organizer)
        ? dataPayload.organizer
        : null;
    const participantsPayload =
      payload.participants ??
      (dataPayload ? dataPayload.participants : null) ??
      payload.players ??
      (dataPayload ? dataPayload.players : null);
    const invitePayload = isRecord(payload.invite)
      ? payload.invite
      : dataPayload && isRecord(dataPayload.invite)
        ? dataPayload.invite
        : null;
    const waitlistPayload =
      payload.waitlist ??
      (dataPayload ? dataPayload.waitlist : null) ??
      payload.waitingList ??
      (dataPayload ? dataPayload.waitingList : null);

    const participants = extractPadelGamePlayerItems(participantsPayload)
      .map((item) => normalizePadelGamePlayer(item))
      .filter((item): item is PadelGamePlayer => item !== null);
    const waitlist = extractPadelGamePlayerItems(waitlistPayload)
      .map((item) => normalizePadelGamePlayer(item))
      .filter((item): item is PadelGamePlayer => item !== null);
    const participantPhones = extractPhoneList(
      payload.participantPhones
      ?? (dataPayload ? dataPayload.participantPhones : null)
      ?? (metadataPayload ? metadataPayload.participantPhones : null),
    );
    const waitlistPhones = extractPhoneList(
      payload.waitlistPhones
      ?? (dataPayload ? dataPayload.waitlistPhones : null)
      ?? (metadataPayload ? metadataPayload.waitlistPhones : null),
    );
    const allRelatedPhones = extractPhoneList(
      payload.allRelatedPhones
      ?? (dataPayload ? dataPayload.allRelatedPhones : null)
      ?? (metadataPayload ? metadataPayload.allRelatedPhones : null),
    );
    const invitedPhones = extractPhoneList(
      payload.invitedPhones
      ?? (dataPayload ? dataPayload.invitedPhones : null)
      ?? (metadataPayload ? metadataPayload.invitedPhones : null),
    );
    const createdAt =
      pickString(payload, ["createdAt", "created", "insertedAt"]) ??
      (dataPayload ? pickString(dataPayload, ["createdAt", "created", "insertedAt"]) : null);
    const updatedAt =
      pickString(payload, ["updatedAt", "updated", "modifiedAt"]) ??
      (dataPayload ? pickString(dataPayload, ["updatedAt", "updated", "modifiedAt"]) : null);

    const organizer = organizerPayload
      ? {
          id: pickString(organizerPayload, ["id", "clientId", "userId", "uuid"]),
          name: (() => {
            const nameValue = pickString(organizerPayload, ["name", "firstName"]);
            const lastName = pickString(organizerPayload, ["lastName", "surname"]);
            return [nameValue, lastName].filter(Boolean).join(" ").trim() || nameValue;
          })() ?? null,
          phone: pickString(organizerPayload, ["phone", "phoneNumber", "mobile"]),
          photo: pickString(organizerPayload, ["photo", "avatar", "imageUrl"]),
          rating: pickString(organizerPayload, ["rating", "level", "grade"]),
          ratingNumeric: pickNumeric(organizerPayload, ["ratingNumeric", "numericRating", "levelNumeric"]),
        }
      : null;

    if (organizer && participants.length === 0) {
      participants.push({
        id: organizer.id ?? null,
        name: organizer.name || "Организатор",
        phone: organizer.phone ?? null,
        photo: organizer.photo ?? null,
        rating: organizer.rating ?? null,
        ratingNumeric: organizer.ratingNumeric ?? null,
        source: "ORGANIZER",
        status: "CONFIRMED",
      });
    }

    const chatUrl =
      pickString(payload, ["chatUrl", "chatLink", "chat_url"]) ??
      (isRecord(payload.chat)
        ? pickString(payload.chat, ["url", "link", "chatUrl"])
        : null) ??
      (metadataPayload
        ? pickString(metadataPayload, ["chatUrl", "chatLink", "chat_url"])
        : null);

    return {
      id: directId,
      inviteUrl: inviteUrl ?? null,
      status: status ?? null,
      participantPhones,
      waitlistPhones,
      allRelatedPhones,
      invitedPhones,
      createdAt: createdAt ?? null,
      updatedAt: updatedAt ?? null,
      organizer,
      settings: settingsPayload
        ? {
            ratingGame:
              toBoolean(settingsPayload.ratingGame) ??
              toBoolean(settingsPayload.rating) ??
              null,
            minRating: pickString(settingsPayload, ["minRating", "ratingFrom", "ratingMin"]),
            maxRating: pickString(settingsPayload, ["maxRating", "ratingTo", "ratingMax"]),
            isPrivate:
              toBoolean(settingsPayload.isPrivate) ??
              toBoolean(settingsPayload.private) ??
              null,
            payMode: (() => {
              const normalized = pickString(settingsPayload, ["payMode"])?.toLowerCase();
              return normalized === "split" || normalized === "self"
                ? normalized
                : null;
            })(),
          }
        : null,
      participants,
      waitlist,
      invite: invitePayload
        ? {
            waitlistEnabled:
              toBoolean(invitePayload.waitlistEnabled) ??
              toBoolean(invitePayload.waitlist) ??
              null,
            maxPlayers: pickNumber(invitePayload, ["maxPlayers", "playersLimit", "limit"]),
          }
        : null,
      chatUrl: chatUrl ?? null,
      metadata: metadataPayload ?? null,
      booking: bookingPayload
        ? {
            studioName: pickString(bookingPayload, ["studioName", "stationName", "studio"]),
            roomName: pickString(bookingPayload, ["roomName", "courtName", "room"]),
            date:
              normalizeDateLabel(
                bookingPayload.date
                ?? bookingPayload.exerciseDate
                ?? bookingPayload.day
                ?? bookingPayload.timeFromIso
                ?? bookingPayload.timeToIso,
              ),
            timeFrom: normalizeTimeLabel(
              bookingPayload.timeFrom
              ?? bookingPayload.fromTime
              ?? bookingPayload.startTime
              ?? bookingPayload.timeFromIso,
            ),
            timeTo: normalizeTimeLabel(
              bookingPayload.timeTo
              ?? bookingPayload.toTime
              ?? bookingPayload.endTime
              ?? bookingPayload.timeToIso,
            ),
            durationMinutes: pickNumber(bookingPayload, [
              "durationMinutes",
              "duration",
              "durationMin",
            ]),
            studioId: pickString(bookingPayload, ["studioId", "stationId"]),
            roomId: pickString(bookingPayload, ["roomId", "courtId"]),
            bookingId: pickString(bookingPayload, ["bookingId", "id"]),
            bookingIds: uniqueIds(
              extractIdList(
                bookingPayload.bookingIds
                ?? bookingPayload.bookingId
                ?? bookingPayload.id,
              ),
            ),
            exerciseId: pickString(bookingPayload, ["exerciseId", "exercise_id"]),
            vivaExerciseId: pickString(bookingPayload, ["vivaExerciseId", "viva_exercise_id"]),
            subServiceIds: uniqueIds(
              extractIdList(
                bookingPayload.subServiceIds
                ?? bookingPayload.subServiceId
                ?? bookingPayload.subServiceIDs
                ?? bookingPayload.sub_service_ids,
              ),
            ),
          }
        : null,
      payment: paymentPayload
        ? {
            amount: pickNumber(paymentPayload, ["amount", "toPay", "price", "sum"]),
            paymentUrl: pickString(paymentPayload, [
              "paymentUrl",
              "paymentLink",
              "url",
              "redirectUrl",
              "link",
            ]),
            paid:
              toBoolean(paymentPayload.paid) ??
              toBoolean(paymentPayload.isPaid) ??
              null,
          }
        : null,
    };
  }

  const nestedKeys = ["data", "result", "content", "item", "record", "game", "payload"];
  for (const key of nestedKeys) {
    const nested = normalizePadelGameRecord(payload[key]);
    if (nested) return nested;
  }

  return null;
}

function collectPadelGameRecords(payload: unknown, bucket: Map<string, PadelGameRecord>) {
  if (payload == null) return;

  if (Array.isArray(payload)) {
    payload.forEach((item) => collectPadelGameRecords(item, bucket));
    return;
  }
  if (!isRecord(payload)) return;

  const normalized = normalizePadelGameRecord(payload);
  if (normalized) {
    bucket.set(normalized.id, mergePadelGameRecord(bucket.get(normalized.id), normalized));
  }

  const listKeys = [
    "content",
    "data",
    "result",
    "items",
    "records",
    "games",
    "list",
    "payload",
  ];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (candidate == null) continue;
    collectPadelGameRecords(candidate, bucket);
  }
}

function extractPadelGameRecordList(payload: unknown): PadelGameRecord[] {
  const bucket = new Map<string, PadelGameRecord>();
  collectPadelGameRecords(payload, bucket);
  return Array.from(bucket.values());
}

function extractPadelGameRecordListTotal(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return pickNumber(payload, ["total", "totalElements", "count", "gamesCount"]);
}

function extractPadelGameRecordListHasMore(payload: unknown): boolean | null {
  if (!isRecord(payload)) return null;
  return (
    toBoolean(payload.hasMore) ??
    toBoolean(payload.more) ??
    toBoolean(payload.hasNext) ??
    null
  );
}

function normalizePhoneForChat(phone: string): string | null {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function normalizeChatMessageSender(payload: unknown): PadelGameChatMessageSender | null {
  if (!isRecord(payload)) return null;
  return {
    id: pickString(payload, ["id", "clientId", "userId", "uuid"]),
    phoneNorm: pickString(payload, ["phoneNorm", "phone", "phoneNumber"]),
    name: pickString(payload, ["name", "fullName", "displayName"]),
    role: pickString(payload, ["role", "type", "source"]),
  };
}

function normalizePadelGameChatMessage(payload: unknown): PadelGameChatMessage | null {
  if (!isRecord(payload)) return null;
  const gameId = pickString(payload, ["gameId", "id", "recordId"]);
  const text = pickString(payload, ["text", "message", "body"]);
  const createdTs = pickNumber(payload, ["createdTs", "ts", "timestamp"]);
  const createdAt = pickString(payload, ["createdAt", "date", "created"]);
  const senderPayload = isRecord(payload.sender) ? payload.sender : null;

  if (!gameId || !text) return null;

  return {
    id: pickString(payload, ["_id", "messageId", "id"]),
    gameId,
    type: pickString(payload, ["type", "messageType"]) ?? "TEXT",
    text,
    createdAt,
    createdTs: createdTs ?? (createdAt ? Date.parse(createdAt) : 0) ?? 0,
    sender: senderPayload ? normalizeChatMessageSender(senderPayload) : null,
    deleted: toBoolean(payload.deleted) ?? false,
  };
}

function extractPadelGameChatMessages(payload: unknown): PadelGameChatMessagesPage | null {
  if (Array.isArray(payload)) {
    const messages = payload
      .map((item) => normalizePadelGameChatMessage(item))
      .filter((item): item is PadelGameChatMessage => item !== null)
      .sort((a, b) => a.createdTs - b.createdTs);

    return {
      gameId: messages[0]?.gameId ?? "",
      phone: null,
      totalFetched: messages.length,
      hasMore: false,
      nextBeforeTs: null,
      messages,
    };
  }

  if (!isRecord(payload)) return null;

  const rowsRaw = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.content)
        ? payload.content
        : Array.isArray(payload.data)
          ? payload.data
          : [];

  const messages = rowsRaw
    .map((item) => normalizePadelGameChatMessage(item))
    .filter((item): item is PadelGameChatMessage => item !== null)
    .sort((a, b) => a.createdTs - b.createdTs);

  return {
    gameId: pickString(payload, ["gameId"]) ?? messages[0]?.gameId ?? "",
    phone: pickString(payload, ["phone", "phoneNorm"]),
    totalFetched: pickNumber(payload, ["totalFetched", "total", "count"]) ?? messages.length,
    hasMore: toBoolean(payload.hasMore) ?? false,
    nextBeforeTs: pickNumber(payload, ["nextBeforeTs", "nextBefore", "beforeTs"]),
    messages,
  };
}

function extractPadelChatsByPhone(payload: unknown): PadelChatsByPhoneResponse | null {
  if (!isRecord(payload)) return null;

  const rowsRaw = Array.isArray(payload.chats)
    ? payload.chats
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.content)
        ? payload.content
        : [];

  const chats = rowsRaw
    .map((item) => {
      if (!isRecord(item)) return null;
      const gameId = pickString(item, ["gameId", "id"]);
      if (!gameId) return null;

      const lastMessagePayload = isRecord(item.lastMessage) ? item.lastMessage : item;
      const senderPayload = isRecord(lastMessagePayload.sender)
        ? lastMessagePayload.sender
        : null;

      return {
        gameId,
        lastMessageTs: pickNumber(lastMessagePayload, ["createdTs", "ts", "timestamp"]) ?? 0,
        lastMessageAt: pickString(lastMessagePayload, ["createdAt", "date", "created"]),
        lastMessageText: pickString(lastMessagePayload, ["text", "message", "body"]) ?? "",
        lastMessageSenderPhone:
          pickString(senderPayload ?? {}, ["phoneNorm", "phone", "phoneNumber"]) ?? null,
      } satisfies PadelChatSummaryItem;
    })
    .filter((item): item is PadelChatSummaryItem => item !== null)
    .sort((left, right) => right.lastMessageTs - left.lastMessageTs);

  return {
    phone: pickString(payload, ["phone", "phoneNorm"]),
    total: pickNumber(payload, ["total", "count"]) ?? chats.length,
    chats,
  };
}

function normalizeSupportDialogAi(payload: unknown): SupportDialogAI | null {
  if (!isRecord(payload)) return null;
  return {
    lastTopic: pickString(payload, ["lastTopic", "topic"]),
    lastSentiment: pickString(payload, ["lastSentiment", "sentiment"]),
    lastPriority: pickString(payload, ["lastPriority", "priority"]),
    topicTags: extractStringList(payload.topicTags),
    needsAttention: toBoolean(payload.needsAttention) ?? false,
  };
}

function normalizeSupportDialog(payload: unknown): SupportDialog | null {
  if (!isRecord(payload)) return null;

  const id = pickString(payload, ["id", "_id"]);
  if (!id) return null;

  const lastMessagePayload = isRecord(payload.lastMessage) ? payload.lastMessage : {};
  const aiPayload = isRecord(payload.ai) ? payload.ai : null;

  return {
    id,
    clientId: pickString(payload, ["clientId"]),
    displayName: pickString(payload, ["displayName", "clientName", "subject"]) ?? "Клиент",
    primaryPhone: pickString(payload, ["primaryPhone", "currentPhone"]),
    phoneNumbers: extractPhoneList(payload.phoneNumbers ?? payload.phones),
    stationId: pickString(payload, ["stationId"]) ?? "UNASSIGNED",
    stationName: pickString(payload, ["stationName"]) ?? "Без станции",
    status: pickString(payload, ["status"]) ?? "OPEN",
    authStatus: pickString(payload, ["authStatus"]) ?? "PENDING_CONTACT",
    workflowState: pickString(payload, ["workflowState"]) ?? "WAIT_CONTACT",
    channels: extractStringList(payload.channels).map((value) => value.toUpperCase()),
    connectors: extractStringList(payload.connectors).map((value) => value.toUpperCase()),
    lastConnector: pickString(payload, ["lastConnector", "lastInboundConnector", "lastOutboundConnector"]),
    unreadClientMessages: pickNumber(payload, ["unreadClientMessages", "unreadCount"]) ?? 0,
    pendingResponseSinceTs: pickNumber(payload, ["pendingResponseSinceTs"]),
    firstResponseMinutes: pickNumeric(payload, ["firstResponseMinutes"]),
    lastResponseMinutes: pickNumeric(payload, ["lastResponseMinutes"]),
    avgResponseMinutes: pickNumeric(payload, ["avgResponseMinutes"]),
    maxResponseMinutes: pickNumeric(payload, ["maxResponseMinutes"]),
    ai: normalizeSupportDialogAi(aiPayload),
    lastMessage: {
      preview:
        pickString(lastMessagePayload, ["preview", "textPreview", "text", "message"])
        ?? pickString(payload, ["lastMessagePreview"])
        ?? "",
      direction:
        pickString(lastMessagePayload, ["direction"])
        ?? pickString(payload, ["lastMessageDirection"])
        ?? "INBOUND",
      authorType:
        pickString(lastMessagePayload, ["authorType", "senderRole"])
        ?? pickString(payload, ["lastMessageAuthorType"])
        ?? pickString(payload, ["lastMessageSenderRole"])
        ?? "CLIENT",
      channel:
        pickString(lastMessagePayload, ["channel"])
        ?? pickString(payload, ["lastChannel"]),
      createdAt:
        pickString(lastMessagePayload, ["createdAt"])
        ?? pickString(payload, ["lastMessageAt"]),
      createdTs:
        pickNumber(lastMessagePayload, ["createdTs"])
        ?? pickNumber(payload, ["lastMessageTs"]),
    },
    createdAt: pickString(payload, ["createdAt"]),
    updatedAt: pickString(payload, ["updatedAt"]),
    updatedTs: pickNumber(payload, ["updatedTs"]),
  };
}

function normalizeSupportDialogMessageSender(payload: unknown): SupportDialogMessageSender | null {
  if (!isRecord(payload)) return null;
  return {
    id: pickString(payload, ["id", "userId", "clientId", "senderId"]),
    name: pickString(payload, ["name", "displayName", "senderName"]),
    role: pickString(payload, ["role", "type", "senderRole"]),
  };
}

function normalizeSupportDialogMessage(payload: unknown): SupportDialogMessage | null {
  if (!isRecord(payload)) return null;

  const mongoIdPayload = isRecord(payload._id) ? payload._id : null;
  const id =
    pickString(payload, ["id", "_id"])
    ?? (mongoIdPayload ? pickString(mongoIdPayload, ["$oid", "oid"]) : null);
  const dialogId = pickString(payload, ["dialogId"]);
  const text = pickString(payload, ["text", "message", "content"]) ?? "";
  const createdAt = pickString(payload, ["createdAt"]);
  const createdTsDirect = pickNumber(payload, ["createdTs", "timestamp"]);
  const createdAtTs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const createdTs = createdTsDirect ?? (Number.isFinite(createdAtTs) ? createdAtTs : 0);
  const rawEventType = pickString(payload, ["eventType", "kind"]) ?? "MESSAGE";
  const eventType = rawEventType.toUpperCase() === "TEXT" ? "MESSAGE" : rawEventType;

  if (!id || !dialogId) return null;

  return {
    id,
    dialogId,
    clientId: pickString(payload, ["clientId"]),
    stationId: pickString(payload, ["stationId"]),
    stationName: pickString(payload, ["stationName"]),
    direction: pickString(payload, ["direction"]) ?? "INBOUND",
    authorType: pickString(payload, ["authorType", "senderRole"]) ?? "CLIENT",
    eventType,
    channel:
      pickString(payload, ["channel"])
      ?? (isRecord(payload.meta) ? pickString(payload.meta, ["channel"]) : null)
      ?? "WEB",
    connector: pickString(payload, ["connector"]),
    text,
    textPreview: pickString(payload, ["textPreview", "preview"]) ?? text,
    createdAt,
    createdTs,
    sender: normalizeSupportDialogMessageSender(payload.sender) ?? normalizeSupportDialogMessageSender(payload),
    deleted: toBoolean(payload.deleted) ?? false,
    metadata:
      (isRecord(payload.metadata) ? payload.metadata : null)
      ?? (isRecord(payload.meta) ? payload.meta : null),
  };
}

function extractSupportDialogs(payload: unknown): SupportDialogsResponse | null {
  if (!isRecord(payload)) return null;

  const rowsRaw = Array.isArray(payload.dialogs)
    ? payload.dialogs
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.content)
        ? payload.content
        : Array.isArray(payload.data)
          ? payload.data
          : [];

  const dialogs = rowsRaw
    .map((item) => normalizeSupportDialog(item))
    .filter((item): item is SupportDialog => item !== null)
    .sort((left, right) => (right.updatedTs ?? 0) - (left.updatedTs ?? 0));

  const summaryPayload = isRecord(payload.summary) ? payload.summary : {};

  return {
    total: pickNumber(payload, ["total", "count"]) ?? dialogs.length,
    dialogs,
    summary: {
      unanswered:
        pickNumber(summaryPayload, ["unanswered"])
        ?? dialogs.filter((dialog) => dialog.unreadClientMessages > 0).length,
      pendingAuth:
        pickNumber(summaryPayload, ["pendingAuth"])
        ?? dialogs.filter((dialog) => dialog.authStatus !== "AUTHORIZED").length,
    },
  };
}

function extractSupportDialogMessages(payload: unknown): SupportDialogMessagesPage | null {
  if (Array.isArray(payload)) {
    const messages = payload
      .map((item) => normalizeSupportDialogMessage(item))
      .filter((item): item is SupportDialogMessage => item !== null)
      .sort((a, b) => a.createdTs - b.createdTs);

    return {
      dialogId: messages[0]?.dialogId ?? "",
      totalFetched: messages.length,
      hasMore: false,
      nextBeforeTs: null,
      messages,
    };
  }

  if (!isRecord(payload)) return null;

  const rowsRaw = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.content)
        ? payload.content
        : Array.isArray(payload.data)
          ? payload.data
          : [];

  const messages = rowsRaw
    .map((item) => normalizeSupportDialogMessage(item))
    .filter((item): item is SupportDialogMessage => item !== null)
    .sort((a, b) => a.createdTs - b.createdTs);

  return {
    dialogId: pickString(payload, ["dialogId"]) ?? messages[0]?.dialogId ?? "",
    totalFetched: pickNumber(payload, ["totalFetched", "total", "count"]) ?? messages.length,
    hasMore: toBoolean(payload.hasMore) ?? false,
    nextBeforeTs: pickNumber(payload, ["nextBeforeTs", "nextBefore", "beforeTs"]),
    messages,
  };
}

function extractSupportDialogEventResponse(payload: unknown): SupportDialogEventResponse | null {
  if (!isRecord(payload)) return null;

  return {
    ok: toBoolean(payload.ok) ?? false,
    client: isRecord(payload.client) ? payload.client : null,
    dialog: normalizeSupportDialog(payload.dialog),
    message: normalizeSupportDialogMessage(payload.message),
  };
}

function extractSupportClientResolveResult(payload: unknown): SupportClientResolveResult | null {
  if (!isRecord(payload)) return null;

  const matchedClientIds = extractStringList(payload.matchedClientIds);
  const clientPayload = isRecord(payload.client) ? payload.client : null;
  const clientId =
    (clientPayload ? pickString(clientPayload, ["id", "clientId"]) : null)
    ?? matchedClientIds[0]
    ?? null;

  return {
    found: toBoolean(payload.found) ?? Boolean(clientId),
    clientId,
  };
}

export async function apiFetchPadelGamesByPhone(
  phone: string,
  clientId?: string | null,
  includePast = false,
  options: {
    limit?: number;
  } = {},
) {
  const normalizedPhone = phone.replace(/\D/g, "");
  if (!normalizedPhone) {
    return {
      data: { games: [] as PadelGameRecord[], total: 0 } as PadelGamesByPhoneResponse,
      error: { status: 400, message: "Телефон не указан для получения игр" },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const normalizedClientId = clientId?.trim() || "";
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(1000, Math.floor(options.limit as number)))
    : null;
  const buildQuery = (resolvedClientId?: string | null) => {
    const query = new URLSearchParams({ phone: normalizedPhone });
    const trimmedClientId = resolvedClientId?.trim() || "";
    if (trimmedClientId) {
      query.set("clientId", trimmedClientId);
    }
    if (includePast) {
      // Keep both flags for backward compatibility with older Node-RED handlers.
      query.set("includePast", "true");
      query.set("past", "true");
    }
    if (limit) {
      query.set("limit", String(limit));
    }

    if (!IS_DEV_RELEASE_CHANNEL) {
      // Prevent stale 304 responses from hiding past games in "Все".
      query.set("_ts", String(Date.now()));
    }
    return query.toString();
  };

  const queryVariants = [buildQuery(normalizedClientId)];
  if (normalizedClientId) {
    // Some handlers narrow the result too aggressively when clientId is present,
    // so keep a pure phone lookup as a fallback and merge both result sets.
    queryVariants.push(buildQuery(null));
  }

  const endpoints = queryVariants.flatMap((query) => [
    `/lk/games/by-phone?${query}`,
    `/lk/games?${query}`,
  ]);

  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;
  let firstSuccessStatus: ApiStatus = null;
  let reportedTotal = 0;
  const recordsById = new Map<string, PadelGameRecord>();

  for (const endpoint of endpoints) {
    const response = await request<unknown>(endpoint, {
      method: "GET",
      baseUrl,
      retries: 1,
      ...(IS_DEV_RELEASE_CHANNEL
        ? {
            cacheTtlMs: DEV_GAMES_CACHE_TTL_MS,
            dedupe: true,
          }
        : {
            cache: "no-store" as RequestCache,
          }),
    });
    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }
    if (firstSuccessStatus == null) {
      firstSuccessStatus = response.status;
    }

    const records = extractPadelGameRecordList(response.data);
    const endpointTotal = extractPadelGameRecordListTotal(response.data);
    if (endpointTotal !== null) {
      reportedTotal = Math.max(reportedTotal, endpointTotal);
    }
    if (records.length === 0) continue;
    records.forEach((record) => {
      if (!record?.id) return;
      recordsById.set(record.id, mergePadelGameRecord(recordsById.get(record.id), record));
    });
  }

  if (recordsById.size > 0) {
    const sorted = Array.from(recordsById.values()).sort((left, right) => {
      const toTimestamp = (record: PadelGameRecord) => {
        const date = record.booking?.date || "9999-12-31";
        const time = record.booking?.timeFrom || "23:59";
        const parsed = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
        if (!Number.isFinite(parsed.getTime())) return Number.MAX_SAFE_INTEGER;
        return parsed.getTime();
      };
      return toTimestamp(left) - toTimestamp(right);
    });
    const total = Math.max(reportedTotal, sorted.length);
    const games = limit ? sorted.slice(0, limit) : sorted;

    return {
      data: { games, total },
      error: null,
      status: firstSuccessStatus,
    };
  }

  if (firstSuccessStatus != null) {
    return {
      data: { games: [] as PadelGameRecord[], total: reportedTotal } as PadelGamesByPhoneResponse,
      error: null,
      status: firstSuccessStatus,
    };
  }

  return {
    data: { games: [] as PadelGameRecord[], total: 0 } as PadelGamesByPhoneResponse,
    error: firstError,
    status: firstStatus,
  };
}

export async function apiFetchPadelAvailableGames(options: {
  limit?: number;
  offset?: number;
  date?: string | null;
  stationId?: string | null;
  stationName?: string | null;
} = {}) {
  const baseUrl = getServ2Origin() || "";
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(50, Math.floor(options.limit as number)))
    : 12;
  const offset = Number.isFinite(options.offset)
    ? Math.max(0, Math.floor(options.offset as number))
    : 0;
  const query = new URLSearchParams({
    public: "true",
    available: "true",
    limit: String(limit),
    offset: String(offset),
  });
  const stationId = options.stationId?.trim() || "";
  const stationName = options.stationName?.trim() || "";
  const date = options.date?.trim() || "";

  if (date) {
    query.set("date", date);
  }
  if (stationId) {
    query.set("stationId", stationId);
    query.set("studioId", stationId);
  }
  if (stationName) {
    query.set("stationName", stationName);
    query.set("studioName", stationName);
  }
  if (!IS_DEV_RELEASE_CHANNEL) {
    query.set("_ts", String(Date.now()));
  }

  const endpoint = `/lk/games?${query.toString()}`;
  const response = await request<unknown>(endpoint, {
    method: "GET",
    baseUrl,
    retries: 1,
    ...(IS_DEV_RELEASE_CHANNEL
      ? {
          cacheTtlMs: DEV_GAMES_CACHE_TTL_MS,
          dedupe: true,
        }
      : {
          cache: "no-store" as RequestCache,
        }),
  });

  const games = extractPadelGameRecordList(response.data);
  const total = extractPadelGameRecordListTotal(response.data) ?? games.length + offset;
  const hasMore = extractPadelGameRecordListHasMore(response.data) ?? (offset + games.length < total);

  return {
    data: {
      games,
      total,
      hasMore,
      limit,
      offset,
    } satisfies PadelAvailableGamesResponse,
    error: response.error,
    status: response.status,
  };
}

export async function apiFetchPadelGameRecord(gameId: string) {
  const normalizedGameId = gameId.trim();
  if (!normalizedGameId) {
    return {
      data: null as PadelGameRecord | null,
      error: { status: 400, message: "Не указан gameId для получения игры" },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const endpoints = [`/lk/games/${encodeURIComponent(normalizedGameId)}`];

  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;

  for (const endpoint of endpoints) {
    const response = await request<unknown>(endpoint, {
      method: "GET",
      baseUrl,
      retries: 1,
    });
    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }

    const parsed = normalizePadelGameRecord(response.data);
    if (parsed) {
      return {
        data: parsed,
        error: null,
        status: response.status,
      };
    }
  }

  return {
    data: null as PadelGameRecord | null,
    error:
      firstError ??
      {
        status: firstStatus,
        message: "Не удалось получить запись игры",
      },
    status: firstStatus,
  };
}

export async function apiFetchPadelGameChatMessages(params: {
  gameId: string;
  phone: string;
  limit?: number;
  beforeTs?: number;
}) {
  const gameId = params.gameId.trim();
  const phone = normalizePhoneForChat(params.phone);
  if (!gameId || !phone) {
    return {
      data: null as PadelGameChatMessagesPage | null,
      error: {
        status: 400,
        message: "Недостаточно данных для загрузки чата",
      },
      status: 400 as ApiStatus,
    };
  }

  const safeLimit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(200, Math.floor(params.limit as number)))
    : 80;
  const beforeTs = Number.isFinite(params.beforeTs)
    ? Math.floor(params.beforeTs as number)
    : Date.now();

  const baseUrl = getServ2Origin() || "";
  const query = new URLSearchParams({
    phone,
    limit: String(safeLimit),
    beforeTs: String(beforeTs),
  });

  const response = await request<unknown>(
    `/lk/games/${encodeURIComponent(gameId)}/chat/messages?${query.toString()}`,
    {
      method: "GET",
      baseUrl,
      retries: 1,
    },
  );

  if (response.error) {
    return {
      data: null as PadelGameChatMessagesPage | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = extractPadelGameChatMessages(response.data);
  if (!parsed) {
    return {
      data: null as PadelGameChatMessagesPage | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать сообщения чата",
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiSendPadelGameChatMessage(params: {
  gameId: string;
  senderPhone: string;
  text: string;
  senderName?: string | null;
  senderId?: string | null;
}) {
  const gameId = params.gameId.trim();
  const senderPhone = normalizePhoneForChat(params.senderPhone);
  const text = params.text.trim();
  if (!gameId || !senderPhone || !text) {
    return {
      data: null as PadelGameChatMessage | null,
      error: {
        status: 400,
        message: "Недостаточно данных для отправки сообщения",
      },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const response = await request<unknown>(
    `/lk/games/${encodeURIComponent(gameId)}/chat/messages`,
    {
      method: "POST",
      baseUrl,
      retries: 1,
      body: JSON.stringify({
        senderPhone,
        senderName: params.senderName?.trim() || null,
        senderId: params.senderId?.trim() || null,
        type: "TEXT",
        text,
      }),
    },
  );

  if (response.error) {
    return {
      data: null as PadelGameChatMessage | null,
      error: response.error,
      status: response.status,
    };
  }

  const nestedData = isRecord(response.data) ? response.data.data : null;
  const message =
    normalizePadelGameChatMessage(response.data) ??
    normalizePadelGameChatMessage(nestedData);

  if (!message) {
    return {
      data: null as PadelGameChatMessage | null,
      error: {
        status: response.status,
        message: "Не удалось прочитать отправленное сообщение",
      },
      status: response.status,
    };
  }

  return {
    data: message,
    error: null,
    status: response.status,
  };
}

export async function apiMarkPadelGameChatRead(params: {
  gameId: string;
  phone: string;
  lastReadTs: number;
}) {
  const gameId = params.gameId.trim();
  const phone = normalizePhoneForChat(params.phone);
  const lastReadTs = Number.isFinite(params.lastReadTs)
    ? Math.floor(params.lastReadTs)
    : Date.now();

  if (!gameId || !phone) {
    return {
      data: null as PadelGameChatReadResponse | null,
      error: {
        status: 400,
        message: "Недостаточно данных для отметки прочитанного",
      },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const response = await request<unknown>(
    `/lk/games/${encodeURIComponent(gameId)}/chat/read`,
    {
      method: "POST",
      baseUrl,
      retries: 0,
      body: JSON.stringify({ phone, lastReadTs }),
    },
  );

  if (response.error) {
    return {
      data: null as PadelGameChatReadResponse | null,
      error: response.error,
      status: response.status,
    };
  }

  const payload = isRecord(response.data) ? response.data : {};
  const read = isRecord(payload.read) ? payload.read : null;

  return {
    data: {
      ok: toBoolean(payload.ok) ?? true,
      read: read
        ? {
            gameId: pickString(read, ["gameId"]) ?? gameId,
            phoneNorm: pickString(read, ["phoneNorm", "phone"]) ?? phone,
            lastReadTs: pickNumber(read, ["lastReadTs", "readTs"]) ?? lastReadTs,
            updatedAt: pickString(read, ["updatedAt", "createdAt"]),
          }
        : null,
    },
    error: null,
    status: response.status,
  };
}

export async function apiFetchPadelChatsByPhone(phoneRaw: string) {
  const phone = normalizePhoneForChat(phoneRaw);
  if (!phone) {
    return {
      data: null as PadelChatsByPhoneResponse | null,
      error: {
        status: 400,
        message: "Недостаточно данных для загрузки списка чатов",
      },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const query = new URLSearchParams({ phone });

  const response = await request<unknown>(`/lk/chats/by-phone?${query.toString()}`, {
    method: "GET",
    baseUrl,
    retries: 1,
    ...(IS_DEV_RELEASE_CHANNEL
      ? {
          cacheTtlMs: DEV_CHAT_SUMMARY_CACHE_TTL_MS,
          dedupe: true,
        }
      : {}),
  });

  if (response.error) {
    return {
      data: null as PadelChatsByPhoneResponse | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = extractPadelChatsByPhone(response.data);
  if (!parsed) {
    return {
      data: null as PadelChatsByPhoneResponse | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать список чатов",
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

function trimTrailingSlashes(value: string | null | undefined): string {
  return String(value || "").trim().replace(/\/+$/g, "");
}

function buildSupportEndpointCandidates(suffix: string): string[] {
  const origin = trimTrailingSlashes(getServ2Origin() || "");
  const explicitBase = trimTrailingSlashes(SUPPORT_API_BASE);
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;

  if (explicitBase) {
    return [`${explicitBase}${normalizedSuffix}`];
  }

  const candidates = [
    `${origin}/lk${normalizedSuffix}`,
    `${origin}/api${normalizedSuffix}`,
  ];

  return Array.from(new Set(candidates.filter((value): value is string => Boolean(value))));
}

async function requestSupportWithFallback<T>(
  suffix: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const candidates = buildSupportEndpointCandidates(suffix);
  const method = String(options.method || "GET").trim().toUpperCase();
  const isReadLikeMethod = method === "GET" || method === "HEAD" || method === "OPTIONS";
  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;
  const seenErrors: ApiError[] = [];

  for (const url of candidates) {
    const response = await request<T>(url, { ...options, baseUrl: undefined });
    if (!response.error) {
      return response;
    }

    seenErrors.push(response.error);

    if (!firstError) {
      firstError = response.error;
      firstStatus = response.status;
    }

    // For write operations we still allow safe routing fallbacks when the first endpoint
    // is clearly unavailable for this request and therefore could not have accepted a write.
    if (
      !isReadLikeMethod
      && response.status !== 401
      && response.status !== 403
      && response.status !== 404
      && response.status !== 405
    ) {
      return response;
    }
  }

  if (seenErrors.length > 0 && seenErrors.every((error) => error.status === 404)) {
    return {
      data: null,
      error: {
        status: 404,
        message: "Support endpoints не опубликованы на сервере",
        raw: { suffix, candidates },
      },
      status: 404,
    };
  }

  return {
    data: null,
    error:
      firstError
      ?? {
        status: firstStatus,
        message: "Не удалось связаться с support backend",
      },
    status: firstStatus,
  };
}

async function apiResolveSupportClientByPhone(params: {
  phone: string;
  channel?: string;
}) {
  const phone = normalizePhoneForChat(params.phone);
  if (!phone) {
    return {
      data: null as SupportClientResolveResult | null,
      error: {
        status: 400,
        message: "Недостаточно данных для поиска клиента поддержки",
      },
      status: 400 as ApiStatus,
    };
  }

  const query = new URLSearchParams({ phone });
  const channel = (params.channel || "").trim().toUpperCase();
  if (channel) {
    query.set("channel", channel);
  }

  const response = await requestSupportWithFallback<unknown>(`/support/clients/resolve?${query.toString()}`, {
    method: "GET",
    retries: 1,
  });

  if (response.error) {
    return {
      data: null as SupportClientResolveResult | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = extractSupportClientResolveResult(response.data);
  if (!parsed) {
    return {
      data: null as SupportClientResolveResult | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать ответ resolve клиента поддержки",
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiFetchSupportDialogs(params: {
  phone: string;
  channel?: string;
  includeClosed?: boolean;
  clientId?: string | null;
}) {
  const phone = normalizePhoneForChat(params.phone);
  if (!phone) {
    return {
      data: null as SupportDialogsResponse | null,
      error: {
        status: 400,
        message: "Недостаточно данных для загрузки диалогов поддержки",
      },
      status: 400 as ApiStatus,
    };
  }

  const requestedChannel = (params.channel || "WEB").trim().toUpperCase();
  const requestedClientId = params.clientId?.trim() || null;
  const fetchDialogs = async (channel: string | null, clientId: string | null) => {
    const query = new URLSearchParams({ phone });
    if (clientId) {
      query.set("clientId", clientId);
    }
    if (channel) {
      query.set("channel", channel);
    }
    if (params.includeClosed) {
      query.set("includeClosed", "1");
    }

    const response = await requestSupportWithFallback<unknown>(`/support/dialogs?${query.toString()}`, {
      method: "GET",
      retries: 1,
    });

    if (response.error) {
      return {
        data: null as SupportDialogsResponse | null,
        error: response.error,
        status: response.status,
      };
    }

    const parsed = extractSupportDialogs(response.data);
    if (!parsed) {
      return {
        data: null as SupportDialogsResponse | null,
        error: {
          status: response.status,
          message: "Не удалось разобрать список диалогов поддержки",
        },
        status: response.status,
      };
    }

    return {
      data: parsed,
      error: null,
      status: response.status,
    };
  };

  const fetchWithRelaxedChannel = async (clientId: string | null) => {
    const primary = await fetchDialogs(requestedChannel, clientId);
    if (primary.error || !primary.data) {
      return primary;
    }

    if (requestedChannel && primary.data.dialogs.length === 0) {
      const relaxed = await fetchDialogs(null, clientId);
      if (!relaxed.error && relaxed.data && relaxed.data.dialogs.length > 0) {
        return relaxed;
      }
      if (!relaxed.error && relaxed.data) {
        return relaxed;
      }
    }

    return primary;
  };

  const direct = await fetchWithRelaxedChannel(requestedClientId);
  if (direct.error || !direct.data) {
    return direct;
  }

  if (direct.data.dialogs.length > 0 || requestedClientId) {
    return direct;
  }

  const resolvedClient = await apiResolveSupportClientByPhone({
    phone,
    channel: requestedChannel,
  });
  if (resolvedClient.error || !resolvedClient.data?.found || !resolvedClient.data.clientId) {
    return direct;
  }

  const byClientId = await fetchWithRelaxedChannel(resolvedClient.data.clientId);
  if (!byClientId.error && byClientId.data && byClientId.data.dialogs.length > 0) {
    return byClientId;
  }
  if (byClientId.error || !byClientId.data) {
    return direct;
  }

  return byClientId;
}

export async function apiFetchSupportDialogMessages(params: {
  dialogId: string;
  limit?: number;
  beforeTs?: number;
}) {
  const dialogId = params.dialogId.trim();
  if (!dialogId) {
    return {
      data: null as SupportDialogMessagesPage | null,
      error: {
        status: 400,
        message: "Не указан dialogId для загрузки переписки",
      },
      status: 400 as ApiStatus,
    };
  }

  const safeLimit = Number.isFinite(params.limit)
    ? Math.max(1, Math.min(300, Math.floor(params.limit as number)))
    : 200;
  const beforeTs = Number.isFinite(params.beforeTs)
    ? Math.floor(params.beforeTs as number)
    : Date.now() + 1;

  const query = new URLSearchParams({
    limit: String(safeLimit),
    beforeTs: String(beforeTs),
  });

  const response = await requestSupportWithFallback<unknown>(
    `/support/dialogs/${encodeURIComponent(dialogId)}/messages?${query.toString()}`,
    {
      method: "GET",
      retries: 1,
    },
  );

  if (response.error) {
    return {
      data: null as SupportDialogMessagesPage | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = extractSupportDialogMessages(response.data);
  if (!parsed) {
    return {
      data: null as SupportDialogMessagesPage | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать сообщения поддержки",
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiCreateSupportDialogEvent(payload: SupportDialogEventPayload) {
  const text =
    payload.text?.trim()
    || payload.message?.trim()
    || payload.content?.trim()
    || "";
  const phone =
    normalizePhoneForChat(payload.phone || "")
    || normalizePhoneForChat(payload.phoneNumber || "")
    || normalizePhoneForChat(payload.primaryPhone || "");

  if (!text || !phone) {
    return {
      data: null as SupportDialogEventResponse | null,
      error: {
        status: 400,
        message: "Недостаточно данных для отправки сообщения в поддержку",
      },
      status: 400 as ApiStatus,
    };
  }

  const connector = payload.connector?.trim().toUpperCase() || "WEB_LK";
  const externalUserId =
    payload.channelUserId?.trim()
    || payload.userId?.trim()
    || payload.clientId?.trim()
    || payload.senderId?.trim()
    || phone;
  const externalChatId =
    payload.chatId?.trim()
    || payload.externalThreadId?.trim()
    || `lk:${externalUserId}`;
  const stationId = payload.stationId?.trim() || null;
  const stationName = payload.stationName?.trim() || null;
  const displayName =
    payload.displayName?.trim()
    || payload.senderName?.trim()
    || payload.clientName?.trim()
    || `Клиент ${phone}`;

  const body = SUPPORT_API_BASE
    ? {
        connector,
        externalUserId,
        externalChatId,
        displayName,
        phone,
        text,
        kind: "TEXT",
        ...(stationId ? { stationId, selectedStationId: stationId } : {}),
        ...(stationName ? { stationName, selectedStationName: stationName } : {}),
        meta: {
          ...(payload.metadata ?? {}),
          channel: (payload.channel || "WEB").trim().toUpperCase(),
          direction: payload.direction || "INBOUND",
          authorType: payload.authorType || "CLIENT",
          eventType: payload.eventType || "MESSAGE",
          sourceChatId: payload.chatId?.trim() || null,
          sourceThreadId: payload.externalThreadId?.trim() || null,
        },
      }
    : {
        ...payload,
        phone,
        primaryPhone: phone,
        text,
        connector,
        channel: (payload.channel || "WEB").trim().toUpperCase(),
      };

  const response = await requestSupportWithFallback<unknown>(`/support/dialogs/events`, {
    method: "POST",
    retries: 0,
    body: JSON.stringify(body),
  });

  if (response.error) {
    return {
      data: null as SupportDialogEventResponse | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = extractSupportDialogEventResponse(response.data);
  if (!parsed) {
    return {
      data: null as SupportDialogEventResponse | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать ответ поддержки",
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

async function writePadelGameRecord(
  candidates: Array<{ url: string; method: "POST" | "PATCH" }>,
  payload: Record<string, unknown>,
  fallbackId: string | null = null,
  fallbackInviteUrl: string | null = null,
  requestOptions: {
    retries?: number;
    keepalive?: boolean;
  } = {},
): Promise<ApiResult<PadelGameRecord>> {
  const baseUrl = getServ2Origin() || "";
  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;
  let firstSuccessStatus: ApiStatus = null;
  let sawSuccessWithoutParsedRecord = false;
  const retries = Number.isFinite(requestOptions.retries)
    ? Math.max(0, Math.floor(requestOptions.retries as number))
    : 1;
  const keepalive = requestOptions.keepalive === true;

  for (const candidate of candidates) {
    const response = await request<unknown>(candidate.url, {
      method: candidate.method,
      baseUrl,
      retries,
      keepalive,
      body: JSON.stringify(payload),
    });

    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }

    if (firstSuccessStatus == null) {
      firstSuccessStatus = response.status;
    }

    const parsed = normalizePadelGameRecord(response.data);
    if (parsed) {
      return { data: parsed, error: null, status: response.status };
    }

    sawSuccessWithoutParsedRecord = true;
  }

  // Fallback by local gameId is valid only when backend accepted a request
  // but returned a body we cannot parse. Do not mask full request failures.
  if (fallbackId && sawSuccessWithoutParsedRecord) {
    return {
      data: {
        id: fallbackId,
        inviteUrl: fallbackInviteUrl,
        status: null,
      },
      error: null,
      status: firstSuccessStatus,
    };
  }

  return {
    data: null,
    error:
      firstError ??
      { status: firstStatus, message: "Не удалось сохранить запись игры в padlhub" },
    status: firstStatus,
  };
}

export async function apiCreatePadelGameRecord(
  payload: PadelGameRecordPayload,
  requestOptions: {
    retries?: number;
    keepalive?: boolean;
  } = {},
) {
  const fallbackId = payload.gameId?.trim() || null;
  const fallbackInviteUrl = payload.invite?.inviteUrl?.trim() || null;

  return writePadelGameRecord(
    [{ url: "/lk/games", method: "POST" }],
    payload as unknown as Record<string, unknown>,
    fallbackId,
    fallbackInviteUrl,
    requestOptions,
  );
}

export async function apiCreatePadelGameDraft(
  payload: PadelGameRecordPayload,
  requestOptions: {
    retries?: number;
    keepalive?: boolean;
  } = {},
) {
  const fallbackId = payload.gameId?.trim() || null;
  const fallbackInviteUrl = payload.invite?.inviteUrl?.trim() || null;

  return writePadelGameRecord(
    [
      { url: "/lk/games/drafts", method: "POST" },
      { url: "/lk/games/draft", method: "POST" },
      { url: "/lk/games", method: "POST" },
    ],
    payload as unknown as Record<string, unknown>,
    fallbackId,
    fallbackInviteUrl,
    requestOptions,
  );
}

export async function apiConfirmPadelGamePayment(
  payload: PadelGameRecordPayload,
  requestOptions: {
    retries?: number;
    keepalive?: boolean;
  } = {},
) {
  const fallbackId = payload.gameId?.trim() || null;
  const fallbackInviteUrl = payload.invite?.inviteUrl?.trim() || null;

  return writePadelGameRecord(
    [
      { url: "/lk/games/payment/confirm", method: "POST" },
      { url: "/lk/games/confirm", method: "POST" },
      { url: "/lk/games", method: "POST" },
    ],
    payload as unknown as Record<string, unknown>,
    fallbackId,
    fallbackInviteUrl,
    requestOptions,
  );
}

export async function apiFetchPadelGameByPaymentRef(
  paymentRefRaw: string,
  bookingIdsRaw: string[] = [],
) {
  const paymentRef = paymentRefRaw.trim();
  const bookingIds = bookingIdsRaw
    .map((item) => item.trim())
    .filter(Boolean);

  if (!paymentRef && bookingIds.length === 0) {
    return {
      data: null as PadelGameRecord | null,
      error: { status: 400, message: "Не указан paymentRef/bookingIds для поиска игры" },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const query = new URLSearchParams();
  if (paymentRef) query.set("paymentRef", paymentRef);
  if (bookingIds.length > 0) query.set("bookingIds", bookingIds.join(","));

  const endpoints = [
    `/lk/games/by-payment-ref?${query.toString()}`,
    `/lk/games?${query.toString()}`,
    `/lk/games/by-phone?${query.toString()}`,
  ];

  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;
  let firstSuccessStatus: ApiStatus = null;

  for (const endpoint of endpoints) {
    const response = await request<unknown>(endpoint, {
      method: "GET",
      baseUrl,
      retries: 1,
    });
    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }

    if (firstSuccessStatus == null) {
      firstSuccessStatus = response.status;
    }

    const single = normalizePadelGameRecord(response.data);
    if (single) {
      return {
        data: single,
        error: null,
        status: response.status,
      };
    }

    const records = extractPadelGameRecordList(response.data);
    if (records.length > 0) {
      return {
        data: records[0],
        error: null,
        status: response.status,
      };
    }
  }

  if (firstSuccessStatus != null) {
    return {
      data: null as PadelGameRecord | null,
      error: { status: firstSuccessStatus, message: "Игра по paymentRef не найдена" },
      status: firstSuccessStatus,
    };
  }

  return {
    data: null as PadelGameRecord | null,
    error:
      firstError
      ?? {
        status: firstStatus,
        message: "Не удалось найти игру по paymentRef",
      },
    status: firstStatus,
  };
}

export async function apiUpdatePadelGameRecord(
  gameId: string,
  payload: Partial<PadelGameRecordPayload>,
) {
  const normalizedGameId = gameId.trim();
  if (!normalizedGameId) {
    return {
      data: null as PadelGameRecord | null,
      error: { status: 400, message: "Не указан gameId для обновления записи" },
      status: 400 as ApiStatus,
    };
  }

  return writePadelGameRecord(
    [{ url: `/lk/games/${encodeURIComponent(normalizedGameId)}`, method: "PATCH" }],
    payload as unknown as Record<string, unknown>,
    normalizedGameId,
    payload.invite?.inviteUrl?.trim() || null,
  );
}

function normalizePadelSplitPaymentResult(payload: unknown): PadelSplitPaymentResult | null {
  if (!isRecord(payload)) return null;

  const data = isRecord(payload.data) ? payload.data : payload;
  const toPayMinor = pickNumeric(data, ["toPayMinor", "amountMinor"]);
  const toPayRaw = pickNumeric(data, ["toPay", "amount"]) ?? 0;
  const toPay = toPayMinor != null
    ? toPayMinor / 100
    : (toPayRaw > 10000 ? toPayRaw / 100 : toPayRaw);

  return {
    paymentRef: pickString(data, ["paymentRef", "ref"]) ?? null,
    paymentUrl: extractPaymentUrl(data),
    toPay,
    toPayMinor,
    shareAmount: pickNumeric(data, ["shareAmount"]) ?? null,
    shareAmountMinor: pickNumeric(data, ["shareAmountMinor"]) ?? null,
    baseShareAmount: pickNumeric(data, ["baseShareAmount"]) ?? null,
    baseShareAmountMinor: pickNumeric(data, ["baseShareAmountMinor"]) ?? null,
    discountAmount: pickNumeric(data, ["discountAmount"]) ?? null,
    discountAmountMinor: pickNumeric(data, ["discountAmountMinor"]) ?? null,
    deadlineAt: pickString(data, ["deadlineAt"]) ?? null,
    exerciseId: pickString(data, ["exerciseId", "vivaExerciseId"]) ?? null,
    bookingId: pickString(data, ["bookingId"]) ?? null,
    productId: pickString(data, ["productId"]) ?? null,
    transactionId: pickString(data, ["transactionId"]) ?? null,
    spot: pickNumeric(data, ["spot"]) ?? null,
    raw: payload,
  };
}

function buildPadelSplitPaymentPayload(params: PadelSplitPaymentParams): Record<string, unknown> {
  return {
    date: params.date,
    fromTime: params.fromTime,
    toTime: params.toTime,
    activeTo: params.activeTo ?? null,
    studioId: params.studioId,
    roomId: params.roomId,
    studioName: params.studioName ?? null,
    roomName: params.roomName ?? null,
    clientId: params.clientId ?? null,
    clientPhone: params.clientPhone ?? null,
    paymentRef: params.paymentRef ?? null,
    baseRedirectUrl: params.baseRedirectUrl ?? null,
    successUrl: params.successUrl ?? params.baseRedirectUrl ?? null,
    failUrl: params.failUrl ?? params.baseRedirectUrl ?? null,
    shareCount: params.shareCount,
    shareAmount: params.shareAmount,
    shareAmountIncludesDuration: params.shareAmountIncludesDuration === true,
    durationMinutes: params.durationMinutes ?? null,
    maxClientsCount: params.maxClientsCount ?? params.shareCount,
    spot: params.spot ?? null,
    vivaDirectionId: params.vivaDirectionId ?? null,
    vivaExerciseTypeId: params.vivaExerciseTypeId ?? null,
  };
}

export async function apiCreatePadelSplitGamePayment(params: PadelSplitPaymentParams) {
  const baseUrl = getServ2Origin() || "";
  const studioId = params.studioId?.trim() || null;
  const roomId = params.roomId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;
  const clientPhone = params.clientPhone?.trim() || null;

  if (!studioId || !roomId || !fromDate || !fromTime || !toTime || !clientPhone) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: {
        status: 400,
        message: "Недостаточно данных для split-оплаты",
      },
      status: 400 as ApiStatus,
    };
  }

  const response = await request<unknown>("/lk/games/split/create", {
    method: "POST",
    baseUrl,
    retries: 0,
    body: JSON.stringify(buildPadelSplitPaymentPayload(params)),
  });

  if (response.error) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = normalizePadelSplitPaymentResult(response.data);
  if (!parsed) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать ответ split-оплаты",
        raw: response.data,
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiCreatePadelSplitParticipantPayment(
  gameId: string,
  params: PadelSplitPaymentParams,
) {
  const normalizedGameId = gameId.trim();
  const baseUrl = getServ2Origin() || "";
  const clientPhone = params.clientPhone?.trim() || null;

  if (!normalizedGameId || !clientPhone) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: {
        status: 400,
        message: "Недостаточно данных для оплаты участия",
      },
      status: 400 as ApiStatus,
    };
  }

  const response = await request<unknown>(
    `/lk/games/${encodeURIComponent(normalizedGameId)}/split/join`,
    {
      method: "POST",
      baseUrl,
      retries: 0,
      body: JSON.stringify(buildPadelSplitPaymentPayload(params)),
    },
  );

  if (response.error) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: response.error,
      status: response.status,
    };
  }

  const parsed = normalizePadelSplitPaymentResult(response.data);
  if (!parsed) {
    return {
      data: null as PadelSplitPaymentResult | null,
      error: {
        status: response.status,
        message: "Не удалось разобрать ответ оплаты участия",
        raw: response.data,
      },
      status: response.status,
    };
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

function extractPadelPlayerItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];

  const listKeys = ["content", "data", "result", "items", "players", "clients", "records"];
  for (const key of listKeys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function normalizePadelPlayerCandidate(item: unknown): PadelPlayerCandidate | null {
  if (!isRecord(item)) return null;
  const id = pickString(item, ["id", "clientId", "userId", "uuid"]);
  const firstName = pickString(item, ["firstName", "name"]);
  const lastName = pickString(item, ["lastName", "surname"]);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const name = fullName || pickString(item, ["displayName", "title"]) || "Игрок";
  const phone = pickString(item, ["phone", "phoneNumber", "mobile"]);
  const photo = pickString(item, ["photo", "avatar", "imageUrl"]);
  const rating = pickString(item, ["rating", "level", "grade"]);
  const ratingNumeric = pickNumeric(item, ["ratingNumeric", "numericRating", "levelNumeric"]);

  return {
    id: id ?? null,
    name,
    phone: phone ?? null,
    photo: photo ?? null,
    rating: rating ?? null,
    ratingNumeric: ratingNumeric ?? null,
  };
}

export async function apiSearchPadelPlayers(query: string, limit = 8) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return {
      data: [] as PadelPlayerCandidate[],
      error: null,
      status: 200 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const encodedQuery = encodeURIComponent(normalizedQuery);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Math.floor(limit))) : 8;
  const endpoints = [
    `/lk/games/players/search?q=${encodedQuery}&limit=${safeLimit}`,
    `/lk/players/search?q=${encodedQuery}&limit=${safeLimit}`,
    `/lk/clients/search?q=${encodedQuery}&limit=${safeLimit}`,
  ];

  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;

  for (const endpoint of endpoints) {
    const response = await request<unknown>(endpoint, {
      method: "GET",
      baseUrl,
      retries: 1,
    });
    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }

    const items = extractPadelPlayerItems(response.data)
      .map((item) => normalizePadelPlayerCandidate(item))
      .filter((item): item is PadelPlayerCandidate => item !== null);
    return {
      data: items,
      error: null,
      status: response.status,
    };
  }

  return {
    data: [] as PadelPlayerCandidate[],
    error: firstError,
    status: firstStatus,
  };
}

function normalizePadelLiveRatingItem(item: unknown): PadelLiveRatingItem | null {
  if (!isRecord(item)) return null;
  const clientId = pickString(item, ["clientId", "id", "playerId"]);
  const phoneNorm = pickString(item, ["phoneNorm", "phone", "phoneNumber"]);
  const name = pickString(item, ["name", "playerName", "fullName"]);
  const rating = pickString(item, ["rating", "level", "grade", "levelLetter"]);
  const ratingNumeric = pickNumeric(item, ["ratingNumeric", "numericRating", "levelNumeric"]);
  const source = pickString(item, ["source", "ratingSource"]);

  return {
    clientId: clientId ?? null,
    phoneNorm: phoneNorm ?? null,
    name: name ?? null,
    rating: rating ?? null,
    ratingNumeric: ratingNumeric ?? null,
    source: source ?? null,
  };
}

export async function apiFetchPadelLiveRatings(players: PadelLiveRatingRequestPlayer[]) {
  const body = {
    players: (Array.isArray(players) ? players : [])
      .map((player) => ({
        clientId: (player?.clientId || "").trim() || null,
        phone: (player?.phone || "").trim() || null,
        name: (player?.name || "").trim() || null,
        rating: (player?.rating || "").trim() || null,
        ratingNumeric:
          typeof player?.ratingNumeric === "number" && Number.isFinite(player.ratingNumeric)
            ? player.ratingNumeric
            : null,
      }))
      .filter((player) => player.clientId || player.phone),
  };

  if (body.players.length === 0) {
    return {
      data: [] as PadelLiveRatingItem[],
      error: null,
      status: 200 as ApiStatus,
    };
  }

  const endpoints = [
    { url: "/lk/games/ratings/live", method: "POST" as const },
  ];
  const baseUrl = getServ2Origin() || "";

  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;

  for (const endpoint of endpoints) {
    const response = await request<unknown>(endpoint.url, {
      method: endpoint.method,
      baseUrl,
      retries: 1,
      body: JSON.stringify(body),
    });

    if (response.error) {
      if (!firstError) {
        firstError = response.error;
        firstStatus = response.status;
      }
      continue;
    }

    const payload = response.data;
    const rawItems = Array.isArray(payload)
      ? payload
      : (
          isRecord(payload)
            ? (
                Array.isArray(payload.items)
                  ? payload.items
                  : (
                      Array.isArray(payload.data)
                        ? payload.data
                        : (
                            Array.isArray(payload.result) ? payload.result : []
                          )
                    )
              )
            : []
        );

    const items = rawItems
      .map((item) => normalizePadelLiveRatingItem(item))
      .filter((item): item is PadelLiveRatingItem => item !== null);

    return {
      data: items,
      error: null,
      status: response.status,
    };
  }

  return {
    data: [] as PadelLiveRatingItem[],
    error: firstError,
    status: firstStatus,
  };
}

interface MasterServicePriceParams {
  date: string;
  fromTime: string;
  toTime: string;
  studioId: string;
  roomId: string;
  subServiceIds: string[];
  masterServiceId?: string | null;
}

interface MasterServicePayParams extends MasterServicePriceParams {
  clientId?: string | null;
  clientPhone?: string | null;
  baseRedirectUrl?: string | null;
  promoCode?: string | null;
}

interface MasterServicePromoCheckParams extends MasterServicePriceParams {
  promoCode: string;
}

interface MasterServicePromoDiscountParams extends MasterServicePromoCheckParams {
  clientId: string;
}

export async function apiFetchMasterServicePrice(params: MasterServicePriceParams) {
  const studioId = params.studioId?.trim() || null;
  const roomId = params.roomId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;

  if (!studioId || !roomId || !fromDate || !fromTime || !toTime) {
    return {
      data: null as number | null,
      error: {
        status: 400,
        message: "Недостаточно данных для расчета стоимости",
      },
      status: 400 as ApiStatus,
    };
  }

  const explicitMasterServiceId = params.masterServiceId?.trim() || null;
  const resolvedByStudio =
    ENABLE_MASTER_SERVICE_AUTO_DISCOVERY && !explicitMasterServiceId && studioId
      ? await resolveMasterServiceIdByStudio(studioId)
      : null;
  const fallbackMasterServiceId = studioId ? null : DEFAULT_GAMES_MASTER_SERVICE_ID;
  const masterServiceId =
    explicitMasterServiceId ??
    resolvedByStudio ??
    fallbackMasterServiceId;

  if (!masterServiceId) {
    return {
      data: null as number | null,
      error: {
        status: studioId ? 404 : 400,
        message: studioId
          ? "Для выбранной станции не настроен master-service ID"
          : "Не задан master-service ID",
      },
      status: (studioId ? 404 : 400) as ApiStatus,
    };
  }

  await bootstrapMasterService(masterServiceId, studioId);

  const cacheKey = `${masterServiceId}:${studioId}`;
  const preferredSubServiceId = masterServiceStudioPreferredSubServiceCache.get(cacheKey) ?? null;
  const cachedSubServiceIds = masterServiceStudioSubServicesCache.get(cacheKey) ?? [];
  const requestSubServiceIds = uniqueIds(params.subServiceIds ?? []);
  const fallbackSubServiceIds = uniqueIds([
    ...(preferredSubServiceId ? [preferredSubServiceId] : []),
    ...(cachedSubServiceIds.length > 0 ? [cachedSubServiceIds[0]] : []),
  ]);
  const subServiceIds =
    requestSubServiceIds.length > 0 ? requestSubServiceIds : fallbackSubServiceIds;

  if (subServiceIds.length === 0) {
    return {
      data: null as number | null,
      error: {
        status: 400,
        message: "Для выбранной станции не найдены подуслуги",
      },
      status: 400 as ApiStatus,
    };
  }

  const query = new URLSearchParams({
    studioId,
    roomId,
    subServiceIds: subServiceIds.join(","),
    fromTime,
    toTime,
    fromDate,
  });

  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/master-services/${masterServiceId}/price?${query.toString()}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );

  if (result.error) {
    return {
      data: null as number | null,
      error: result.error,
      status: result.status,
    };
  }

  const price =
    extractPriceAmountForSubServices(result.data, subServiceIds) ??
    extractPriceAmount(result.data);
  if (price === null) {
    return {
      data: null as number | null,
      error: {
        status: result.status,
        message: "Не удалось определить стоимость",
        raw: result.data,
      },
      status: result.status,
    };
  }

  return {
    data: price,
    error: null,
    status: result.status,
  };
}

export async function apiCheckMasterServicePromoCode(params: MasterServicePromoCheckParams) {
  const studioId = params.studioId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;
  const promoCode = params.promoCode?.trim() || null;
  const subServiceIds = uniqueIds(params.subServiceIds ?? []);

  if (!studioId || !fromDate || !fromTime || !toTime || !promoCode || subServiceIds.length === 0) {
    return {
      data: null as { message: string | null } | null,
      error: {
        status: 400,
        message: "Недостаточно данных для проверки промокода",
      },
      status: 400 as ApiStatus,
    };
  }

  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/promo/code/check?productIds=${encodeURIComponent(subServiceIds.join(","))}&promoCode=${encodeURIComponent(promoCode)}&studioId=${encodeURIComponent(studioId)}`,
    { method: "GET", auth: true, retries: 0 },
  );

  if (result.error) {
    return {
      data: null as { message: string | null } | null,
      error: result.error,
      status: result.status,
    };
  }

  const isValid = extractPromoValidationState(result.data);
  if (isValid === false) {
    return {
      data: null as { message: string | null } | null,
      error: {
        status: result.status,
        message: extractPromoMessage(result.data) || "Промокод не прошел проверку",
        raw: result.data,
      },
      status: result.status,
    };
  }

  return {
    data: {
      message: extractPromoMessage(result.data),
    },
    error: null,
    status: result.status,
  };
}

export async function apiFetchMasterServicePromoDiscounts(params: MasterServicePromoDiscountParams) {
  const studioId = params.studioId?.trim() || null;
  const roomId = params.roomId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;
  const promoCode = params.promoCode?.trim() || null;
  const clientId = params.clientId?.trim() || null;
  const subServiceIds = uniqueIds(params.subServiceIds ?? []);

  if (
    !studioId
    || !roomId
    || !fromDate
    || !fromTime
    || !toTime
    || !promoCode
    || !clientId
    || subServiceIds.length === 0
  ) {
    return {
      data: null as PromoDiscountSummary | null,
      error: {
        status: 400,
        message: "Недостаточно данных для расчета скидки по промокоду",
      },
      status: 400 as ApiStatus,
    };
  }

  const fromDateTimeLocal = `${fromDate}T${fromTime}:00`;
  const toDateTimeLocal = `${fromDate}T${toTime}:00`;
  const discountsUrl =
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/promo/discounts`
    + `?productIds=${encodeURIComponent(subServiceIds.join(","))}`
    + `&clientId=${encodeURIComponent(clientId)}`
    + `&studioId=${encodeURIComponent(studioId)}`
    + `&timeFrom=${encodeURIComponent(fromDateTimeLocal)}`
    + `&timeTo=${encodeURIComponent(toDateTimeLocal)}`
    + `&roomId=${encodeURIComponent(roomId)}`
    + `&promoCode=${encodeURIComponent(promoCode)}`;

  const result = await request<unknown>(discountsUrl, {
    method: "GET",
    auth: true,
    retries: 0,
  });

  if (result.error) {
    return {
      data: null as PromoDiscountSummary | null,
      error: result.error,
      status: result.status,
    };
  }

  const summary = extractPromoDiscountSummary(result.data);
  if (!summary) {
    return {
      data: null as PromoDiscountSummary | null,
      error: {
        status: result.status,
        message: "Не удалось определить скидку по промокоду",
        raw: result.data,
      },
      status: result.status,
    };
  }

  return {
    data: summary,
    error: null,
    status: result.status,
  };
}

export async function apiPayMasterService(params: MasterServicePayParams) {
  const studioId = params.studioId?.trim() || null;
  const roomId = params.roomId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;
  const promoCode = params.promoCode?.trim() || null;

  if (!studioId || !roomId || !fromDate || !fromTime || !toTime) {
    return {
      data: null as PaymentUrl | null,
      error: {
        status: 400,
        message: "Недостаточно данных для оплаты",
      },
      status: 400 as ApiStatus,
    };
  }

  const explicitMasterServiceId = params.masterServiceId?.trim() || null;
  const resolvedByStudio =
    ENABLE_MASTER_SERVICE_AUTO_DISCOVERY && !explicitMasterServiceId && studioId
      ? await resolveMasterServiceIdByStudio(studioId)
      : null;
  const fallbackMasterServiceId = studioId ? null : DEFAULT_GAMES_MASTER_SERVICE_ID;
  const masterServiceId =
    explicitMasterServiceId ??
    resolvedByStudio ??
    fallbackMasterServiceId;

  if (!masterServiceId) {
    return {
      data: null as PaymentUrl | null,
      error: {
        status: studioId ? 404 : 400,
        message: studioId
          ? "Для выбранной станции не настроен master-service ID"
          : "Не задан master-service ID",
      },
      status: (studioId ? 404 : 400) as ApiStatus,
    };
  }

  await bootstrapMasterService(masterServiceId, studioId);

  const cacheKey = `${masterServiceId}:${studioId}`;
  const preferredSubServiceId = masterServiceStudioPreferredSubServiceCache.get(cacheKey) ?? null;
  const cachedSubServiceIds = masterServiceStudioSubServicesCache.get(cacheKey) ?? [];
  const requestSubServiceIds = uniqueIds(params.subServiceIds ?? []);
  const fallbackSubServiceIds = uniqueIds([
    ...(preferredSubServiceId ? [preferredSubServiceId] : []),
    ...(cachedSubServiceIds.length > 0 ? [cachedSubServiceIds[0]] : []),
  ]);
  const subServiceIds =
    requestSubServiceIds.length > 0 ? requestSubServiceIds : fallbackSubServiceIds;

  if (subServiceIds.length === 0) {
    return {
      data: null as PaymentUrl | null,
      error: {
        status: 400,
        message: "Для выбранного слота не найдены подуслуги",
      },
      status: 400 as ApiStatus,
    };
  }

  const latestPrice = await apiFetchMasterServicePrice({
    date: fromDate,
    fromTime,
    toTime,
    studioId,
    roomId,
    subServiceIds,
    masterServiceId,
  });
  if (latestPrice.error && latestPrice.data == null) {
    return {
      data: null as PaymentUrl | null,
      error: latestPrice.error,
      status: latestPrice.status,
    };
  }

  const fromDateTimeWithOffset = `${fromDate}T${fromTime}:00+03:00`;
  const toDateTimeWithOffset = `${fromDate}T${toTime}:00+03:00`;
  const fromDateTimeLocal = `${fromDate}T${fromTime}:00`;
  const toDateTimeLocal = `${fromDate}T${toTime}:00`;
  const clientId = params.clientId?.trim() || null;
  let promoDiscountAmount: number | null = null;
  if (clientId) {
    const discountsUrl =
      `${API_BASE}/end-user/api/v1/${TENANT_KEY}/promo/discounts`
      + `?productIds=${encodeURIComponent(subServiceIds.join(","))}`
      + `&clientId=${encodeURIComponent(clientId)}`
      + `&studioId=${encodeURIComponent(studioId)}`
      + `&timeFrom=${encodeURIComponent(fromDateTimeLocal)}`
      + `&timeTo=${encodeURIComponent(toDateTimeLocal)}`
      + `&roomId=${encodeURIComponent(roomId)}`
      + (promoCode ? `&promoCode=${encodeURIComponent(promoCode)}` : "");
    const promoDiscountsResult = await request<unknown>(
      discountsUrl,
      { method: "GET", auth: true, retries: 0 },
    );
    if (!promoDiscountsResult.error && promoCode) {
      const promoSummary = extractPromoDiscountSummary(promoDiscountsResult.data);
      if (promoSummary) {
        promoDiscountAmount = Math.max(0, promoSummary.discount);
      }
    }
  }

  await request<unknown>(`${API_BASE}/end-user/api/v1/${TENANT_KEY}/messenger/bots`, {
    method: "GET",
    auth: true,
    retries: 0,
  });

  const oneTimesFilterResult = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/one-times/filter?subServiceIds=${encodeURIComponent(subServiceIds.join(","))}&studioId=${encodeURIComponent(studioId)}&exerciseStartDateTime=${encodeURIComponent(fromDateTimeWithOffset)}&exerciseEndDateTime=${encodeURIComponent(toDateTimeWithOffset)}`,
    { method: "GET", auth: true, retries: 0 },
  );
  const oneTimeCandidates = oneTimesFilterResult.error
    ? []
    : extractOneTimeCandidates(oneTimesFilterResult.data);
  const oneTimeIds = oneTimesFilterResult.error
    ? []
    : selectOneTimeIdsForPay(oneTimeCandidates, {
        roomId,
        subServiceIds,
        fromDateTimeWithOffset,
        toDateTimeWithOffset,
        fromDateTimeLocal,
        toDateTimeLocal,
      });

  const basePayUrl =
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/master-services/${masterServiceId}/pay`;
  const baseRedirectUrl =
    params.baseRedirectUrl?.trim() ||
    `${SUCCESS_URL}?PadlTerekhovo_date=${encodeURIComponent(fromDate)}&instanceName=PadlTerekhovo`;
  const primaryPayPayload = {
    subServiceIds,
    studioId,
    roomId,
    trainers: { type: "NO_TRAINER" as const },
    paymentMethod: "WIDGET",
    baseRedirectUrl,
    successUrl: baseRedirectUrl,
    failUrl: baseRedirectUrl,
    comment: null,
    marketingAttribution: {},
    timeFrom: fromDateTimeWithOffset,
    timeTo: toDateTimeWithOffset,
    ...(promoCode ? { promoCode } : {}),
  };

  const payResult = await request<unknown>(
    basePayUrl,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify(primaryPayPayload),
    },
  );

  if (payResult.error) {
    if (oneTimeIds.length > 0) {
      const primaryOneTimeId = oneTimeIds[0];
      const clientPhone = params.clientPhone?.trim() || null;
      const txPayloads: Record<string, unknown>[] = [
        {
          ...(clientPhone ? { clientPhone } : {}),
          failUrl: baseRedirectUrl,
          paymentMethod: "WIDGET",
          products: [{ id: primaryOneTimeId, type: "ONE_TIME", count: 1 }],
          count: 1,
          id: primaryOneTimeId,
          type: "ONE_TIME",
          successUrl: baseRedirectUrl,
          baseRedirectUrl,
          ...(promoCode ? { promoCode } : {}),
        },
        {
          ...(clientPhone ? { clientPhone } : {}),
          failUrl: baseRedirectUrl,
          paymentMethod: "WIDGET",
          products: [{ id: primaryOneTimeId, type: "ONE_TIME", count: 1 }],
          successUrl: baseRedirectUrl,
          baseRedirectUrl,
          ...(promoCode ? { promoCode } : {}),
        },
      ];

      for (const payload of txPayloads) {
        const txResult = await request<unknown>(
          `${API_BASE}/end-user/api/v1/${TENANT_KEY}/transactions`,
          {
            method: "POST",
            auth: true,
            retries: 1,
            body: JSON.stringify(payload),
          },
        );
        if (txResult.error) continue;

        const txPaymentUrl = extractPaymentUrl(txResult.data);
        const txBookingIds = extractBookingIdsFromPaymentPayload(txResult.data);
        const txToPay =
          extractPriceAmountForSubServices(txResult.data, subServiceIds) ??
          extractPriceAmount(txResult.data) ??
          latestPrice.data ??
          0;
        if (!txPaymentUrl && txToPay <= 0) {
          return {
            data: {
              paymentUrl: null,
              toPay: txToPay,
              bookingIds: txBookingIds,
              paid: true,
            },
            error: null,
            status: txResult.status,
          };
        }
        if (!txPaymentUrl) continue;

        return {
          data: {
            paymentUrl: txPaymentUrl,
            toPay: txToPay,
            bookingIds: txBookingIds,
            paid: txToPay <= 0 ? true : null,
          },
          error: null,
          status: txResult.status,
        };
      }
    }

    return {
      data: null as PaymentUrl | null,
      error: payResult.error,
      status: payResult.status,
    };
  }

  const discountedLatestPrice =
    promoDiscountAmount != null && latestPrice.data != null
      ? Math.max(latestPrice.data - promoDiscountAmount, 0)
      : null;
  const toPay =
    extractPriceAmountForSubServices(payResult.data, subServiceIds) ??
    extractPriceAmount(payResult.data) ??
    discountedLatestPrice ??
    latestPrice.data ??
    0;
  const paymentUrl = extractPaymentUrl(payResult.data);
  const bookingIds = extractBookingIdsFromPaymentPayload(payResult.data);
  if (!paymentUrl) {
    if (toPay <= 0) {
      return {
        data: {
          paymentUrl: null,
          toPay,
          bookingIds,
          paid: true,
        },
        error: null,
        status: payResult.status,
      };
    }
    return {
      data: null as PaymentUrl | null,
      error: {
        status: payResult.status,
        message: "Не удалось получить ссылку на оплату",
        raw: payResult.data,
      },
      status: payResult.status,
    };
  }

  return {
    data: {
      paymentUrl,
      toPay,
      bookingIds,
      paid: toPay <= 0 ? true : null,
    },
    error: null,
    status: payResult.status,
  };
}

export async function apiFetchMasterServiceTimeslots(
  date: string,
  options: {
    studioId?: string | null;
    masterServiceId?: string | null;
    preferredSubServiceId?: string | null;
    preferredSubServiceIds?: string[];
    preferredRoomIds?: string[];
  } = {},
) {
  const explicitMasterServiceId = options.masterServiceId?.trim() || null;
  const studioId = options.studioId?.trim() || null;
  const resolvedByStudio =
    ENABLE_MASTER_SERVICE_AUTO_DISCOVERY && !explicitMasterServiceId && studioId
      ? await resolveMasterServiceIdByStudio(studioId)
      : null;
  const fallbackMasterServiceId = studioId ? null : DEFAULT_GAMES_MASTER_SERVICE_ID;
  const masterServiceId =
    explicitMasterServiceId ??
    resolvedByStudio ??
    fallbackMasterServiceId;

  if (!masterServiceId) {
    return {
      data: [] as GameTimeSlot[],
      error: {
        status: studioId ? 404 : 400,
        message: studioId
          ? "Для выбранной станции не найден master-service"
          : "Не задан master-service ID",
      },
      status: studioId ? 404 : 400,
    };
  }

  await bootstrapMasterService(masterServiceId, studioId);

  const cacheKey = `${masterServiceId}:${studioId ?? ""}`;
  const explicitPreferredIds = uniqueIds(options.preferredSubServiceIds ?? []).filter((value) =>
    isUuidLike(value),
  );
  const explicitPreferredSubServiceId = options.preferredSubServiceId?.trim() || null;
  const cachedPreferredSubServiceId = studioId
    ? (masterServiceStudioPreferredSubServiceCache.get(cacheKey) ?? null)
    : null;
  const preferredSubServiceIds = uniqueIds([
    ...explicitPreferredIds,
    ...(explicitPreferredSubServiceId ? [explicitPreferredSubServiceId] : []),
    ...(cachedPreferredSubServiceId ? [cachedPreferredSubServiceId] : []),
  ]);
  const hasExplicitPreferredRoomIds = Object.prototype.hasOwnProperty.call(options, "preferredRoomIds");
  const explicitPreferredRoomIds = uniqueIds(options.preferredRoomIds ?? []).filter((value) =>
    isUuidLike(value),
  );
  const preferredRoomIds = hasExplicitPreferredRoomIds
    ? explicitPreferredRoomIds
    : (studioId ? (masterServiceStudioPreferredRoomIdsCache.get(cacheKey) ?? []) : []);

  const requestPayload: {
    date: string;
    trainers: { type: "NO_TRAINER" };
    roomFormat: "FULL_ROOM";
    subServiceIds?: string[];
  } = {
    date,
    trainers: { type: "NO_TRAINER" },
    roomFormat: "FULL_ROOM",
  };
  if (preferredSubServiceIds.length > 0) {
    requestPayload.subServiceIds = preferredSubServiceIds;
  }

  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/master-services/${masterServiceId}/timeslots`,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify(requestPayload),
    },
  );

  if (result.error) {
    return {
      data: [] as GameTimeSlot[],
      error: result.error,
      status: result.status,
    };
  }

  const items = extractMasterServiceTimeslotItems(result.data);
  let parsed = items
    .map((item, index) => normalizeMasterServiceTimeslot(item, index))
    .filter((item): item is GameTimeSlot => item !== null);
  const slotsWithExplicitDate = parsed.filter((slot) => slot.date !== null);
  if (slotsWithExplicitDate.length > 0) {
    parsed = slotsWithExplicitDate.filter((slot) => slot.date === date);
  }
  if (preferredSubServiceIds.length > 0) {
    const preferredSet = new Set(preferredSubServiceIds);
    parsed = parsed.filter((slot) =>
      slot.subServiceIds.length === 0 || slot.subServiceIds.some((id) => preferredSet.has(id)),
    );
  }
  if (preferredRoomIds.length > 0) {
    const roomSet = new Set(preferredRoomIds);
    parsed = parsed.filter((slot) => roomSet.has(slot.roomId));
  }

  const unique = new Map<string, GameTimeSlot>();
  parsed.forEach((slot) => {
    const key = `${slot.date ?? date}-${slot.roomId}-${slot.time}`;
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, slot);
      return;
    }
    if (existing.price == null && slot.price != null) {
      unique.set(key, slot);
    }
  });

  return {
    data: Array.from(unique.values()),
    error: null,
    status: result.status,
  };
}

export async function apiFetchMasterServiceGameModes(options: {
  studioId?: string | null;
  masterServiceId?: string | null;
} = {}) {
  const studioId = options.studioId?.trim() || null;
  const explicitMasterServiceId = options.masterServiceId?.trim() || null;
  const resolvedByStudio =
    ENABLE_MASTER_SERVICE_AUTO_DISCOVERY && !explicitMasterServiceId && studioId
      ? await resolveMasterServiceIdByStudio(studioId)
      : null;
  const fallbackMasterServiceId = studioId ? null : DEFAULT_GAMES_MASTER_SERVICE_ID;
  const masterServiceId =
    explicitMasterServiceId ??
    resolvedByStudio ??
    fallbackMasterServiceId;

  if (!studioId || !masterServiceId) {
    return {
      data: { doubles: null, singles: null } as StudioGameModes,
      error: {
        status: 400,
        message: "Недостаточно данных для определения форматов игры",
      },
      status: 400 as ApiStatus,
    };
  }

  await bootstrapMasterService(masterServiceId, studioId);

  const cacheKey = `${masterServiceId}:${studioId}`;
  return {
    data: masterServiceStudioGameModesCache.get(cacheKey) ?? { doubles: null, singles: null },
    error: null,
    status: 200 as ApiStatus,
  };
}

export async function apiFetchSubscriptioName(subId: string, phone: string) {
  const primary = `${SERV2}?type=get_sub_name&phone=${phone}&subId=${subId}`;
  const fallback = SERV2_FALLBACK
    ? `${SERV2_FALLBACK}?type=get_sub_name&phone=${phone}&subId=${subId}`
    : undefined;
  return requestWithFallback<SubscriptionName>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}

export async function apiBuySubscroption(
  subscroptionId: string,
  phone: string,
) {
  return request<PaymentUrl>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/transactions`,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify({
        clientPhone: phone,
        failUrl: FAIL_URL,
        paymentMethod: "WIDGET",
        products: [
          {
            id: subscroptionId,
            type: "SUBSCRIPTION",
            count: 1,
          },
        ],
        count: 1,
        id: subscroptionId,
        type: "SUBSCRIPTION",
        successUrl: SUCCESS_URL,
      }),
    },
  );
}

export async function apiGetSubscriptionsForSale() {
  const primary = `${SERV2}?type=sub_for_sale`;
  const fallback = SERV2_FALLBACK ? `${SERV2_FALLBACK}?type=sub_for_sale` : undefined;
  return requestWithFallback<apiSubscription[]>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}

export async function apiGetAdvertisement() {
  const primary = `${SERV2}?type=advertisement`;
  const fallback = SERV2_FALLBACK ? `${SERV2_FALLBACK}?type=advertisement` : undefined;
  return requestWithFallback<AdvertisementType>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}

function normalizeCabinetHomeAdvertisingSettingsPayload(
  value: unknown,
): CabinetHomeAdvertisingSettings | null {
  if (!isRecord(value)) return null;

  const ads = Array.isArray(value.ads)
    ? value.ads
      .map((item, index): CabinetHomeAdvertisingItem | null => {
        if (!isRecord(item)) return null;

        const href = pickString(item, ["href", "url", "link"]);
        const imgUrl = pickString(item, ["imgUrl", "imageUrl", "photo", "image"]);
        if (!href || !imgUrl) return null;

        return {
          id: pickString(item, ["id"]) ?? `${href}::${imgUrl}::${index}`,
          title: pickString(item, ["title", "name"]) ?? undefined,
          href,
          imgUrl,
        };
      })
      .filter((item): item is CabinetHomeAdvertisingItem => Boolean(item))
    : [];

  return {
    placement: "cabinet_home",
    rotationEnabled: value.rotationEnabled === true,
    ads,
    updatedAt: pickString(value, ["updatedAt"]) ?? undefined,
  };
}

function mapLegacyAdvertisementToCabinetSettings(
  advertisement: AdvertisementType | null,
): CabinetHomeAdvertisingSettings | null {
  if (!advertisement?.href || !advertisement.imgUrl) {
    return null;
  }

  return {
    placement: "cabinet_home",
    rotationEnabled: false,
    ads: [
      {
        id: advertisement.id ?? `${advertisement.href}::${advertisement.imgUrl}`,
        title: advertisement.title,
        href: advertisement.href,
        imgUrl: advertisement.imgUrl,
      },
    ],
  };
}

function normalizeMoneyAmount(value: unknown, fallback: number): number {
  const parsed = toNumeric(value);
  if (parsed === null || parsed < 0) return fallback;
  return Math.round(parsed);
}

function normalizeIntegerSetting(value: unknown, fallback: number): number {
  const parsed = toNumeric(value);
  if (parsed === null) return fallback;
  return Math.round(parsed);
}

function normalizePadelSplitPaymentPromoConfigPayload(
  value: unknown,
  options?: { fallbackToDefaultRestrictions?: boolean },
): PadelSplitPaymentPromoConfig {
  const source = isRecord(value) && isRecord(value.data) ? value.data : value;
  const data = isRecord(source) ? source : {};
  const shareAmounts = isRecord(data.shareAmounts) ? data.shareAmounts : {};
  const rawPromos = Array.isArray(data.promos)
    ? data.promos.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
  const fallbackToDefaults = options?.fallbackToDefaultRestrictions !== false;

  const stationIds = uniqueIds(extractStringList(data.stationIds));
  const stationNameIncludes = uniqueIds(extractStringList(data.stationNameIncludes));
  const roomIds = uniqueIds(extractStringList(data.roomIds));
  const roomNameIncludes = uniqueIds(extractStringList(data.roomNameIncludes));

  return {
    id: pickString(data, ["id"]) ?? undefined,
    title: pickString(data, ["title"]) ?? undefined,
    enabled: toBoolean(data.enabled) ?? DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.enabled,
    activeTo:
      normalizeDateLabel(
        pickString(data, ["activeTo", "dateTo", "validUntil", "expiresAt"]),
      ) ?? undefined,
    stationIds:
      stationIds.length > 0
        ? stationIds
        : fallbackToDefaults
          ? DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.stationIds
          : [],
    stationNameIncludes:
      stationNameIncludes.length > 0
        ? stationNameIncludes
        : fallbackToDefaults
          ? DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.stationNameIncludes
          : [],
    roomIds,
    roomNameIncludes:
      roomNameIncludes.length > 0
        ? roomNameIncludes
        : fallbackToDefaults
          ? DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.roomNameIncludes
          : [],
    shareAmounts: {
      twoTeams: normalizeMoneyAmount(
        pickNumeric(shareAmounts, ["twoTeams", "two", "2"]) ??
          data.twoTeamsShareAmount ??
          data.teamShareAmount,
        DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.shareAmounts.twoTeams,
      ),
      fourPlayers: normalizeMoneyAmount(
        pickNumeric(shareAmounts, ["fourPlayers", "four", "4"]) ??
          data.fourPlayersShareAmount ??
          data.playerShareAmount,
        DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.shareAmounts.fourPlayers,
      ),
    },
    baseShareAmount: normalizeMoneyAmount(
      data.baseShareAmount,
      DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.baseShareAmount,
    ),
    vivaDirectionId: normalizeIntegerSetting(
      data.vivaDirectionId ?? data.directionId,
      DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.vivaDirectionId,
    ),
    vivaExerciseTypeId: normalizeIntegerSetting(
      data.vivaExerciseTypeId ?? data.exerciseTypeId,
      DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG.vivaExerciseTypeId,
    ),
    promos: rawPromos.map((promo) =>
      normalizePadelSplitPaymentPromoConfigPayload(promo, {
        fallbackToDefaultRestrictions: false,
      }),
    ),
    updatedAt: pickString(data, ["updatedAt"]) ?? undefined,
    updatedBy: pickString(data, ["updatedBy"]) ?? undefined,
  };
}

export async function apiGetCabinetHomeAdvertisingSettings() {
  const supportResponse = await requestSupportWithFallback<unknown>("/advertising/cabinet-home", {
    method: "GET",
    retries: 1,
    cacheTtlMs: DEV_CABINET_ADVERTISING_CACHE_TTL_MS,
    dedupe: true,
  });

  const normalizedSupportData = normalizeCabinetHomeAdvertisingSettingsPayload(supportResponse.data);
  if (normalizedSupportData) {
    return {
      data: normalizedSupportData,
      error: null,
      status: supportResponse.status,
    } satisfies ApiResult<CabinetHomeAdvertisingSettings>;
  }

  const legacyResponse = await apiGetAdvertisement();
  const normalizedLegacyData = mapLegacyAdvertisementToCabinetSettings(legacyResponse.data);
  if (normalizedLegacyData) {
    return {
      data: normalizedLegacyData,
      error: null,
      status: legacyResponse.status,
    } satisfies ApiResult<CabinetHomeAdvertisingSettings>;
  }

  if (supportResponse.error) {
    return {
      data: null,
      error: supportResponse.error,
      status: supportResponse.status,
    } satisfies ApiResult<CabinetHomeAdvertisingSettings>;
  }

  return {
    data: null,
    error: legacyResponse.error,
    status: legacyResponse.status,
  } satisfies ApiResult<CabinetHomeAdvertisingSettings>;
}

export async function apiFetchPadelSplitPaymentPromoConfig() {
  const query = new URLSearchParams({
    force_ts: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  const supportResponse = await requestSupportWithFallback<unknown>(
    `/advertising/split-payment-promo?${query.toString()}`,
    {
      method: "GET",
      retries: 1,
      cache: "no-store",
      cacheTtlMs: DEV_SPLIT_PAYMENT_PROMO_CACHE_TTL_MS,
      dedupe: true,
    },
  );

  if (supportResponse.error && supportResponse.data == null) {
    return {
      data: { ...DEFAULT_PADEL_SPLIT_PAYMENT_PROMO_CONFIG, enabled: false },
      error: supportResponse.error,
      status: supportResponse.status,
    } satisfies ApiResult<PadelSplitPaymentPromoConfig>;
  }

  return {
    data: normalizePadelSplitPaymentPromoConfigPayload(supportResponse.data),
    error: supportResponse.error,
    status: supportResponse.status,
  } satisfies ApiResult<PadelSplitPaymentPromoConfig>;
}
