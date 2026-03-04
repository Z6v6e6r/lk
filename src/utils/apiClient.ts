import { getCookie } from "./cookies";
import {
  TENANT_KEY,
  API_BASE,
  SERV2,
  SERV2_FALLBACK,
  SUCCESS_URL,
  FAIL_URL,
  GAMES_MASTER_SERVICE_ID,
} from "../consts/api_config";
import { trackClientError } from "./analytics";

const DEFAULT_GAMES_MASTER_SERVICE_ID =
  GAMES_MASTER_SERVICE_ID || "2f4155ad-7bc0-4a15-a12c-da7fce15c37a";
const ENABLE_MASTER_SERVICE_AUTO_DISCOVERY = false;
const PREFERRED_PANORAMIC_SUB_SERVICE_ID = "415edff9-b4ad-4d88-8709-75f1ab7d4081";

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
  imgUrl: string;
  href: string;
}
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

export interface GameCourtOption {
  id: string;
  name: string;
  price: number | null;
}

export interface GameTimeSlot {
  id: string;
  roomId: string;
  roomName: string;
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

function extractPriceAmountForSubServices(payload: unknown, subServiceIds: string[]): number | null {
  if (!isRecord(payload)) return null;
  if (subServiceIds.length === 0) return null;

  const extractCalculatedPrice = (entryPayload: unknown): number | null => {
    if (!isRecord(entryPayload)) return null;
    const calculation = entryPayload.calculation;
    if (!isRecord(calculation)) return null;

    for (const item of Object.values(calculation)) {
      if (!isRecord(item)) continue;
      const basePrice = isRecord(item.basePrice) ? item.basePrice : null;
      const base =
        (basePrice ? pickNumeric(basePrice, ["valueFrom", "from", "value", "amount"]) : null) ??
        pickNumeric(item, ["valueFrom", "from", "value", "amount"]);
      if (base === null) continue;

      const impacts = Array.isArray(item.impacts) ? item.impacts : [];
      const impactsSum = impacts.reduce((sum, impact) => {
        if (!isRecord(impact)) return sum;
        const directImpact =
          pickNumeric(impact, ["valueFrom", "from", "value", "amount"]) ??
          (isRecord(impact.price)
            ? pickNumeric(impact.price, ["valueFrom", "from", "value", "amount"])
            : null);
        return directImpact == null ? sum : sum + directImpact;
      }, 0);

      return base + impactsSum;
    }

    return null;
  };

  for (const subServiceId of subServiceIds) {
    const calculatedBySubService = extractCalculatedPrice(payload[subServiceId]);
    if (calculatedBySubService !== null) return calculatedBySubService;
    const bySubService = extractPriceAmount(payload[subServiceId]);
    if (bySubService !== null) return bySubService;
  }

  return null;
}

function extractPaymentUrl(payload: unknown): string | null {
  if (payload == null) return null;

  if (typeof payload === "string") {
    const normalized = payload.trim();
    if (/^https?:\/\//i.test(normalized)) return normalized;
    return null;
  }

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const nested = extractPaymentUrl(item);
      if (nested) return nested;
    }
    return null;
  }

  if (!isRecord(payload)) return null;

  const direct = pickString(payload, [
    "paymentUrl",
    "url",
    "redirectUrl",
    "paymentLink",
    "checkoutUrl",
    "link",
  ]);
  if (direct && /^https?:\/\//i.test(direct)) return direct;

  const nestedKeys = [
    "data",
    "payload",
    "result",
    "transactionStatus",
    "cardPaymentStatus",
    "payment",
  ];
  for (const key of nestedKeys) {
    const nested = extractPaymentUrl(payload[key]);
    if (nested) return nested;
  }

  for (const value of Object.values(payload)) {
    const nested = extractPaymentUrl(value);
    if (nested) return nested;
  }

  return null;
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
    const selectedSubService = pickPreferredSubService(studioSubServicesResult.data, studioId);
    if (selectedSubService.allIds.length > 0) {
      masterServiceStudioSubServicesCache.set(cacheKey, selectedSubService.allIds);
    }
    if (selectedSubService.preferredId) {
      masterServiceStudioPreferredSubServiceCache.set(cacheKey, selectedSubService.preferredId);
    }
    if (selectedSubService.preferredRoomIds.length > 0) {
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

export interface AmericanoTournamentPayload {
  tournamentId: string;
  tenantKey: string;
  createdAt: string;
  organizer: {
    id: string | null;
    phone: string | null;
    tenantKey: string;
  };
  tournamentType: "americano";
  targetScore: number;
  courts: string[];
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
    matches: Array<{
      id: string;
      court: string;
      pair1: string[];
      pair2: string[];
      score1: number | null;
      score2: number | null;
    }>;
  }>;
}

export interface AmericanoResultsPayload {
  tournamentId: string;
  results: Array<{
    roundId: string;
    matchId: string;
    score1: number;
    score2: number;
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
    }
  >;
  rounds?: unknown[];
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
  source?: "ORGANIZER" | "INVITE_LINK" | "MANUAL_LIST" | "MANUAL_PHONE" | "ADMIN";
  status?: "CONFIRMED" | "WAITLIST" | "PENDING";
}

export interface PadelGameRecordPayload {
  gameId?: string | null;
  tenantKey?: string | null;
  status?: "PAYMENT_PENDING" | "PAID" | "CANCELLED";
  organizer: {
    id: string | null;
    name: string | null;
    phone: string | null;
    photo?: string | null;
    rating?: string | null;
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
  };
  payment: {
    amount: number | null;
    paymentUrl: string | null;
    paymentMethod: "WIDGET";
    baseRedirectUrl?: string | null;
    paid?: boolean;
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
  organizer?: {
    id: string | null;
    name: string | null;
    phone: string | null;
    photo: string | null;
    rating: string | null;
  } | null;
  settings?: {
    ratingGame: boolean | null;
    minRating: string | null;
    maxRating: string | null;
    isPrivate: boolean | null;
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
  paymentUrl: string;
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

interface RequestOptions extends RequestInit {
  auth?: boolean;
  retries?: number;
  baseUrl?: string;
  signal?: AbortSignal
}

async function rawRequest<T>(
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { auth = false, baseUrl = API_BASE, ...fetchOptions } = options;

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

  let payload: any = null;
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => null);
  }

  if (!response.ok) {
    const message =
      (payload && (payload.message || payload.error_description)) ||
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
  if (retries > 0) {
    return withRetry(() => rawRequest<T>(url, options), { retries });
  }
  return rawRequest<T>(url, options);
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
  let attempt = 0;
  while (true) {
    try {
      const res = await fn();
      if (res.status !== 200 && res.status !== 204 && res.status !== 304) {
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
  const baseUrl = getServ2Origin() || "";
  return request<{ ok: boolean }>(`/lk/onboarding/level`, {
    method: "POST",
    baseUrl,
    retries: 1,
    body: JSON.stringify(payload),
  });
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

export async function apiFetchBookings(includeCanceled: boolean) {
  const url = includeCanceled
    ? `/end-user/api/v2/${TENANT_KEY}/bookings/history?includeCanceled=true&size=1000`
    : `/end-user/api/v2/${TENANT_KEY}/bookings?size=1000`;

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
      body: JSON.stringify({}),
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

export async function apiFetchExercisesByDate(date: string) {
  return request<Exercise[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises?date=${date}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
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
      retries: 1,
    },
  );
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
        }
      : null;

    if (organizer && participants.length === 0) {
      participants.push({
        id: organizer.id ?? null,
        name: organizer.name || "Организатор",
        phone: organizer.phone ?? null,
        photo: organizer.photo ?? null,
        rating: organizer.rating ?? null,
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
            date: pickString(bookingPayload, ["date", "exerciseDate", "day"]),
            timeFrom: pickString(bookingPayload, [
              "timeFrom",
              "fromTime",
              "startTime",
              "timeFromIso",
            ]),
            timeTo: pickString(bookingPayload, [
              "timeTo",
              "toTime",
              "endTime",
              "timeToIso",
            ]),
            durationMinutes: pickNumber(bookingPayload, [
              "durationMinutes",
              "duration",
              "durationMin",
            ]),
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
  if (normalized && !bucket.has(normalized.id)) {
    bucket.set(normalized.id, normalized);
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

export async function apiFetchPadelGamesByPhone(phone: string, clientId?: string | null) {
  const normalizedPhone = phone.replace(/\D/g, "");
  if (!normalizedPhone) {
    return {
      data: [] as PadelGameRecord[],
      error: { status: 400, message: "Телефон не указан для получения игр" },
      status: 400 as ApiStatus,
    };
  }

  const baseUrl = getServ2Origin() || "";
  const query = new URLSearchParams({ phone: normalizedPhone });
  const normalizedClientId = clientId?.trim() || "";
  if (normalizedClientId) {
    query.set("clientId", normalizedClientId);
  }

  const endpoints = [
    `/lk/games/by-phone?${query.toString()}`,
    `/lk/games?${query.toString()}`,
    `/lk/games/records?${query.toString()}`,
    `/lk/games/list?${query.toString()}`,
    `/lk/games/by-client?${query.toString()}`,
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

    const records = extractPadelGameRecordList(response.data);
    if (records.length === 0) continue;

    const sorted = records.sort((left, right) => {
      const toTimestamp = (record: PadelGameRecord) => {
        const date = record.booking?.date || "9999-12-31";
        const time = record.booking?.timeFrom || "23:59";
        const parsed = new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`);
        if (!Number.isFinite(parsed.getTime())) return Number.MAX_SAFE_INTEGER;
        return parsed.getTime();
      };
      return toTimestamp(left) - toTimestamp(right);
    });

    return {
      data: sorted,
      error: null,
      status: response.status,
    };
  }

  if (firstSuccessStatus != null) {
    return {
      data: [] as PadelGameRecord[],
      error: null,
      status: firstSuccessStatus,
    };
  }

  return {
    data: [] as PadelGameRecord[],
    error: firstError,
    status: firstStatus,
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
  const endpoints = [
    `/lk/games/${encodeURIComponent(normalizedGameId)}`,
    `/lk/games/records/${encodeURIComponent(normalizedGameId)}`,
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

async function writePadelGameRecord(
  candidates: Array<{ url: string; method: "POST" | "PATCH" }>,
  payload: Record<string, unknown>,
  fallbackId: string | null = null,
  fallbackInviteUrl: string | null = null,
): Promise<ApiResult<PadelGameRecord>> {
  const baseUrl = getServ2Origin() || "";
  let firstError: ApiError | null = null;
  let firstStatus: ApiStatus = null;

  for (const candidate of candidates) {
    const response = await request<unknown>(candidate.url, {
      method: candidate.method,
      baseUrl,
      retries: 1,
      body: JSON.stringify(payload),
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
      return { data: parsed, error: null, status: response.status };
    }

    if (fallbackId) {
      return {
        data: {
          id: fallbackId,
          inviteUrl: fallbackInviteUrl,
          status: null,
        },
        error: null,
        status: response.status,
      };
    }
  }

  if (fallbackId) {
    return {
      data: {
        id: fallbackId,
        inviteUrl: fallbackInviteUrl,
        status: null,
      },
      error: null,
      status: firstStatus,
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

export async function apiCreatePadelGameRecord(payload: PadelGameRecordPayload) {
  const fallbackId = payload.gameId?.trim() || null;
  const fallbackInviteUrl = payload.invite?.inviteUrl?.trim() || null;

  return writePadelGameRecord(
    [
      { url: "/lk/games", method: "POST" },
      { url: "/lk/games/records", method: "POST" },
      { url: "/lk/games/create", method: "POST" },
    ],
    payload as unknown as Record<string, unknown>,
    fallbackId,
    fallbackInviteUrl,
  );
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
    [
      { url: `/lk/games/${encodeURIComponent(normalizedGameId)}`, method: "PATCH" },
      { url: `/lk/games/${encodeURIComponent(normalizedGameId)}`, method: "POST" },
      { url: `/lk/games/records/${encodeURIComponent(normalizedGameId)}`, method: "PATCH" },
      { url: `/lk/games/records/${encodeURIComponent(normalizedGameId)}`, method: "POST" },
    ],
    payload as unknown as Record<string, unknown>,
    normalizedGameId,
    payload.invite?.inviteUrl?.trim() || null,
  );
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

  return {
    id: id ?? null,
    name,
    phone: phone ?? null,
    photo: photo ?? null,
    rating: rating ?? null,
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

export async function apiPayMasterService(params: MasterServicePayParams) {
  const studioId = params.studioId?.trim() || null;
  const roomId = params.roomId?.trim() || null;
  const fromDate = params.date?.trim() || null;
  const fromTime = params.fromTime?.trim() || null;
  const toTime = params.toTime?.trim() || null;

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
  if (clientId) {
    await request<unknown>(
      `${API_BASE}/end-user/api/v1/${TENANT_KEY}/promo/discounts?productIds=${encodeURIComponent(subServiceIds.join(","))}&clientId=${encodeURIComponent(clientId)}&studioId=${encodeURIComponent(studioId)}&timeFrom=${encodeURIComponent(fromDateTimeLocal)}&timeTo=${encodeURIComponent(toDateTimeLocal)}&roomId=${encodeURIComponent(roomId)}`,
      { method: "GET", auth: true, retries: 0 },
    );
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
    comment: null,
    marketingAttribution: {},
    timeFrom: fromDateTimeWithOffset,
    timeTo: toDateTimeWithOffset,
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
          failUrl: FAIL_URL,
          paymentMethod: "WIDGET",
          products: [{ id: primaryOneTimeId, type: "ONE_TIME", count: 1 }],
          count: 1,
          id: primaryOneTimeId,
          type: "ONE_TIME",
          successUrl: SUCCESS_URL,
        },
        {
          ...(clientPhone ? { clientPhone } : {}),
          failUrl: FAIL_URL,
          paymentMethod: "WIDGET",
          products: [{ id: primaryOneTimeId, type: "ONE_TIME", count: 1 }],
          successUrl: SUCCESS_URL,
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
        if (!txPaymentUrl) continue;

        const txToPay =
          extractPriceAmountForSubServices(txResult.data, subServiceIds) ??
          extractPriceAmount(txResult.data) ??
          latestPrice.data ??
          0;

        return {
          data: { paymentUrl: txPaymentUrl, toPay: txToPay },
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

  const paymentUrl = extractPaymentUrl(payResult.data);
  if (!paymentUrl) {
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

  const toPay =
    extractPriceAmountForSubServices(payResult.data, subServiceIds) ??
    extractPriceAmount(payResult.data) ??
    latestPrice.data ??
    0;

  return {
    data: { paymentUrl, toPay },
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
  const preferredRoomIds = studioId
    ? (masterServiceStudioPreferredRoomIdsCache.get(cacheKey) ?? [])
    : [];

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
    const key = `${slot.roomId}-${slot.time}`;
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
