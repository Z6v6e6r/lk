import { API_BASE, IS_DEV_RELEASE_CHANNEL, TENANT_KEY } from "../consts/api_config";
import {
  apiFetchBookings,
  getServ2Origin,
  request,
  type ApiResult,
  type Booking,
} from "./apiClient";
import {
  normalizePadelDaySlots,
  PADEL_DAY_DEV_DATE,
  PADEL_DAY_PROD_DATE,
  type PadelDaySlot,
} from "./padelDayScheduleModel";

export const PADEL_DAY_TARGET_DATE = IS_DEV_RELEASE_CHANNEL
  ? PADEL_DAY_DEV_DATE
  : PADEL_DAY_PROD_DATE;

export type PadelDayGuard = {
  guardId: string;
  expiresAt: string;
};

function buildGuardUrl(path = "") {
  const base = getServ2Origin().replace(/\/+$/, "");
  return `${base}/lk/padel-day/guard${path}`;
}

function buildWaitlistUrl() {
  const base = getServ2Origin().replace(/\/+$/, "");
  return `${base}/lk/padel-day/waitlist`;
}

export type PadelDayWaitlistRequest = {
  firstName: string;
  lastName: string;
  phone: string;
  personalDataConsent: boolean;
  offerConsent: boolean;
};

export async function apiFetchPadelDaySlots(
  date = PADEL_DAY_TARGET_DATE,
  bookings: Booking[] = [],
): Promise<ApiResult<PadelDaySlot[]>> {
  const result = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises?date=${encodeURIComponent(date)}`,
    { method: "GET", retries: 1, cache: "no-store" },
  );
  if (result.error) return { data: null, error: result.error, status: result.status };
  return { data: normalizePadelDaySlots(result.data, date, bookings), error: null, status: result.status };
}

export async function apiFetchPadelDayBookings() {
  return apiFetchBookings(false, { size: 1000 });
}

export async function apiAcquirePadelDayGuard(params: {
  exerciseId: string;
  eventDate: string;
  idempotencyKey: string;
}) {
  return request<PadelDayGuard>(buildGuardUrl(), {
    method: "POST",
    auth: true,
    retries: 0,
    body: JSON.stringify(params),
  });
}

export async function apiConfirmPadelDayGuard(
  guardId: string,
  data: { idempotencyKey: string; transactionId?: string | null; bookingId?: string | null; paymentUrl?: string | null },
) {
  return request<{ ok: boolean }>(buildGuardUrl(`/${encodeURIComponent(guardId)}/confirm`), {
    method: "POST",
    auth: true,
    retries: 0,
    body: JSON.stringify(data),
  });
}

export async function apiReleasePadelDayGuard(guardId: string, idempotencyKey: string) {
  return request<{ ok: boolean }>(buildGuardUrl(`/${encodeURIComponent(guardId)}/release`), {
    method: "POST",
    auth: true,
    retries: 0,
    body: JSON.stringify({ idempotencyKey }),
  });
}

export async function apiJoinPadelDayWaitlist(data: PadelDayWaitlistRequest) {
  return request<{ ok: boolean; status: string }>(buildWaitlistUrl(), {
    method: "POST",
    auth: false,
    retries: 0,
    body: JSON.stringify(data),
  });
}

export function createPadelDayIdempotencyKey(exerciseId: string) {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `padel-day:${exerciseId}:${random}`;
}

export function extractPadelDayTransactionId(value: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (candidate: unknown, depth: number): string | null => {
    if (depth > 5 || !candidate || typeof candidate !== "object" || seen.has(candidate)) return null;
    seen.add(candidate);
    const record = candidate as Record<string, unknown>;
    for (const key of ["transactionId", "transactionUUID", "transactionUuid"]) {
      const raw = record[key];
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    }
    if (typeof record.id === "string" && record.id.trim() && !record.exerciseId) return record.id.trim();
    for (const nested of Object.values(record)) {
      const found = visit(nested, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(value, 0);
}
