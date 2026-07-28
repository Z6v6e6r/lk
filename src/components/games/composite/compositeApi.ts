import { API_BASE } from "../../../consts/api_config";
import { trackClientError } from "../../../utils/analytics";
import { readAuthToken } from "../../../utils/authTokenStorage";
import { resolvePreferredLkApiBaseUrl } from "../../../utils/lkApiBaseUrls";
import type { GameTimeSlot } from "../../../utils/apiClient";
import type { CompositeSlotCandidate, CompositeSlotSegment } from "./compositeSlotBuilder";

type CompositePatternKey =
  | "single-60"
  | "double-30-30"
  | "double-60-30"
  | "double-30-60"
  | "double-60-60";

export interface CompositeApiSegment extends CompositeSlotSegment {
  stationId: string;
  studioId: string;
  date: string;
  index?: number;
  startAt?: string | null;
  endAt?: string | null;
}

export interface CompositeApiCandidate extends Omit<CompositeSlotCandidate, "segments" | "patternKey"> {
  patternKey: CompositePatternKey;
  segments: CompositeApiSegment[];
}

export interface CompositeBookingRecord {
  id: string;
  status: string;
  paymentStatus: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  compositeBooking?: {
    dedupeKey?: string | null;
    status?: string | null;
    paymentStatus?: string | null;
    segmentCount?: number | null;
    transitionCount?: number | null;
    targetDurationMinutes?: number | null;
    patternKey?: string | null;
    patternLabel?: string | null;
    roomsLabel?: string | null;
    totalPrice?: number | null;
  } | null;
  payment?: {
    paymentRef?: string | null;
    status?: string | null;
    ready?: boolean | null;
  } | null;
}

interface CompositeApiError {
  status: number | null;
  message: string;
  raw?: unknown;
}

interface CompositeApiResult<T> {
  data: T | null;
  error: CompositeApiError | null;
  status: number | null;
}

interface CompositeOptionsPayload {
  stationId: string;
  studioId?: string | null;
  date: string;
  slots: GameTimeSlot[];
}

interface CompositeCreatePayload {
  stationId: string;
  studioId?: string | null;
  date: string;
  clientPhone?: string | null;
  clientName?: string | null;
  segments: CompositeApiSegment[];
}

function getCompositeApiBaseUrl(): string {
  return resolvePreferredLkApiBaseUrl(API_BASE, null) || API_BASE;
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

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => toTrimmedString(item)).filter((item): item is string => Boolean(item))));
}

function extractErrorMessage(payload: unknown, fallbackStatus: number | null): string {
  if (isRecord(payload)) {
    return (
      toTrimmedString(payload.message)
      || toTrimmedString(payload.error_description)
      || toTrimmedString(payload.error)
      || `Ошибка запроса${fallbackStatus ? ` (${fallbackStatus})` : ""}`
    );
  }
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  return `Ошибка запроса${fallbackStatus ? ` (${fallbackStatus})` : ""}`;
}

async function rawCompositeRequest<T>(
  path: string,
  init: RequestInit,
  normalize: (payload: unknown) => T | null,
): Promise<CompositeApiResult<T>> {
  const headers = new Headers(init.headers ?? {});
  const token = readAuthToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const fullUrl = `${getCompositeApiBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(fullUrl, {
      ...init,
      headers,
    });
  } catch (error) {
    trackClientError(
      "composite_api.network_error",
      error,
      { path, method: init.method ?? "GET" },
      { handled: true, severity: "error" },
    );
    return {
      data: null,
      error: {
        status: null,
        message: "Ошибка сети",
        raw: error,
      },
      status: null,
    };
  }

  const status = response.status;
  const contentType = response.headers.get("Content-Type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);

  if (!response.ok) {
    const message = extractErrorMessage(payload, status);
    trackClientError(
      "composite_api.http_error",
      new Error(message),
      { path, method: init.method ?? "GET", status },
      { handled: true, severity: status >= 500 ? "error" : "warning" },
    );
    return {
      data: null,
      error: {
        status,
        message,
        raw: payload,
      },
      status,
    };
  }

  const normalized = normalize(payload);
  if (normalized == null) {
    const message = "Composite API вернул некорректный ответ";
    trackClientError(
      "composite_api.invalid_payload",
      new Error(message),
      { path, method: init.method ?? "GET", status },
      { handled: true, severity: "error" },
    );
    return {
      data: null,
      error: {
        status,
        message,
        raw: payload,
      },
      status,
    };
  }

  return {
    data: normalized,
    error: null,
    status,
  };
}

function isCompositePatternKey(value: string | null): value is CompositePatternKey {
  return value === "single-60"
    || value === "double-30-30"
    || value === "double-60-30"
    || value === "double-30-60"
    || value === "double-60-60";
}

function normalizeCompositeSegment(value: unknown): CompositeApiSegment | null {
  if (!isRecord(value)) return null;
  const slotId = toTrimmedString(value.slotId);
  const stationId = toTrimmedString(value.stationId);
  const studioId = toTrimmedString(value.studioId);
  const date = toTrimmedString(value.date);
  const roomId = toTrimmedString(value.roomId);
  const roomName = toTrimmedString(value.roomName) || "Корт";
  const fromTime = toTrimmedString(value.timeFrom);
  const toTime = toTrimmedString(value.timeTo);
  const durationMinutes = toNumberOrNull(value.durationMinutes);

  if (!slotId || !stationId || !studioId || !date || !roomId || !fromTime || !toTime || durationMinutes == null) {
    return null;
  }

  return {
    slotId,
    stationId,
    studioId,
    date,
    roomId,
    roomName,
    fromTime,
    toTime,
    durationMinutes,
    price: toNumberOrNull(value.price),
    subServiceIds: toStringArray(value.subServiceIds),
    index: toNumberOrNull(value.index) ?? undefined,
    startAt: toTrimmedString(value.startAt),
    endAt: toTrimmedString(value.endAt),
  };
}

function normalizeCompositeCandidate(value: unknown): CompositeApiCandidate | null {
  if (!isRecord(value)) return null;
  const patternKey = toTrimmedString(value.patternKey);
  const patternLabel = toTrimmedString(value.patternLabel);
  const fromTime = toTrimmedString(value.fromTime);
  const toTime = toTrimmedString(value.toTime);
  const roomsLabel = toTrimmedString(value.roomsLabel);
  const targetDurationMinutes = toNumberOrNull(value.targetDurationMinutes);
  const transitionCount = toNumberOrNull(value.transitionCount);
  const segmentCount = toNumberOrNull(value.segmentCount);
  const segments = Array.isArray(value.segments)
    ? value.segments.map((segment) => normalizeCompositeSegment(segment)).filter((segment): segment is CompositeApiSegment => segment !== null)
    : [];

  if (
    !isCompositePatternKey(patternKey)
    || !patternLabel
    || !fromTime
    || !toTime
    || !roomsLabel
    || targetDurationMinutes == null
    || transitionCount == null
    || segmentCount == null
    || segments.length === 0
  ) {
    return null;
  }

  return {
    id: toTrimmedString(value.id) || `${patternKey}:${segments.map((segment) => segment.slotId).join(">")}`,
    patternKey,
    patternLabel,
    targetDurationMinutes: targetDurationMinutes as 60 | 90 | 120,
    fromTime,
    toTime,
    transitionCount: transitionCount as 0 | 1,
    segmentCount: segmentCount as 1 | 2,
    roomsLabel,
    totalPrice: toNumberOrNull(value.totalPrice),
    segments,
  };
}

function normalizeCompositeOptionsPayload(payload: unknown): CompositeApiCandidate[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return null;
  return payload.candidates
    .map((candidate) => normalizeCompositeCandidate(candidate))
    .filter((candidate): candidate is CompositeApiCandidate => candidate !== null);
}

function normalizeCompositeBookingRecord(payload: unknown): CompositeBookingRecord | null {
  if (!isRecord(payload)) return null;
  const id = toTrimmedString(payload.id);
  const status = toTrimmedString(payload.status);
  const paymentStatus = toTrimmedString(payload.paymentStatus);
  if (!id || !status || !paymentStatus) return null;

  const compositeBooking = isRecord(payload.compositeBooking)
    ? {
      dedupeKey: toTrimmedString(payload.compositeBooking.dedupeKey),
      status: toTrimmedString(payload.compositeBooking.status),
      paymentStatus: toTrimmedString(payload.compositeBooking.paymentStatus),
      segmentCount: toNumberOrNull(payload.compositeBooking.segmentCount),
      transitionCount: toNumberOrNull(payload.compositeBooking.transitionCount),
      targetDurationMinutes: toNumberOrNull(payload.compositeBooking.targetDurationMinutes),
      patternKey: toTrimmedString(payload.compositeBooking.patternKey),
      patternLabel: toTrimmedString(payload.compositeBooking.patternLabel),
      roomsLabel: toTrimmedString(payload.compositeBooking.roomsLabel),
      totalPrice: toNumberOrNull(payload.compositeBooking.totalPrice),
    }
    : null;

  const payment = isRecord(payload.payment)
    ? {
      paymentRef: toTrimmedString(payload.payment.paymentRef),
      status: toTrimmedString(payload.payment.status),
      ready: toBooleanOrNull(payload.payment.ready),
    }
    : null;

  return {
    id,
    status,
    paymentStatus,
    createdAt: toTrimmedString(payload.createdAt),
    updatedAt: toTrimmedString(payload.updatedAt),
    compositeBooking,
    payment,
  };
}

export async function apiFetchCompositeOptions(
  payload: CompositeOptionsPayload,
): Promise<CompositeApiResult<CompositeApiCandidate[]>> {
  return rawCompositeRequest(
    "/lk/games/composite/options",
    {
      method: "POST",
      body: JSON.stringify({
        stationId: payload.stationId,
        studioId: payload.studioId || payload.stationId,
        date: payload.date,
        slots: payload.slots,
      }),
    },
    normalizeCompositeOptionsPayload,
  );
}

export async function apiCreateCompositeBooking(
  payload: CompositeCreatePayload,
): Promise<CompositeApiResult<CompositeBookingRecord>> {
  return rawCompositeRequest(
    "/lk/games/composite/create",
    {
      method: "POST",
      body: JSON.stringify({
        stationId: payload.stationId,
        studioId: payload.studioId || payload.stationId,
        date: payload.date,
        clientPhone: payload.clientPhone || null,
        clientName: payload.clientName || null,
        segments: payload.segments.map((segment) => ({
          slotId: segment.slotId,
          stationId: segment.stationId || payload.stationId,
          studioId: segment.studioId || payload.studioId || payload.stationId,
          roomId: segment.roomId,
          roomName: segment.roomName,
          date: segment.date || payload.date,
          timeFrom: segment.fromTime,
          timeTo: segment.toTime,
          price: segment.price,
          subServiceIds: segment.subServiceIds,
        })),
      }),
    },
    normalizeCompositeBookingRecord,
  );
}

export async function apiConfirmCompositeBooking(
  compositeId: string,
): Promise<CompositeApiResult<CompositeBookingRecord>> {
  return rawCompositeRequest(
    "/lk/games/composite/confirm",
    {
      method: "POST",
      body: JSON.stringify({ compositeId }),
    },
    normalizeCompositeBookingRecord,
  );
}
