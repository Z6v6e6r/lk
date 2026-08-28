import { IS_DEV_RELEASE_CHANNEL, SERV2 } from "../../consts/api_config";
import { readAuthToken } from "../../utils/authTokenStorage";

export interface A3PayDevVivaBookingSelection {
  date: string;
  fromTime: string;
  toTime: string;
  studioId: string;
  roomId: string;
  masterServiceId: string;
  subServiceIds: string[];
}

export interface A3PayDevVivaBookingResponse {
  ok: boolean;
  state:
    | "VIVA_BOOKING_CREATED"
    | "CANCELLED"
    | "CANCEL_PENDING"
    | "PREPARED"
    | "IN_PROGRESS"
    | "PROVIDER_UNVERIFIED";
  operationId: string;
  bookingId?: string | null;
  exerciseId?: string | null;
  message?: string;
}

export interface A3PayDevVivaBookingResult {
  data: A3PayDevVivaBookingResponse | null;
  error: string | null;
  status: number | null;
}

const ENDPOINT = "/lk/games/a3pay/dev/viva-booking";

function normalizeError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const candidate = payload as { error?: unknown; message?: unknown };
  for (const value of [candidate.error, candidate.message]) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return fallback;
}

async function requestA3PayDevVivaBooking(
  action: "create" | "cancel" | "status",
  operationId: string,
  selection?: A3PayDevVivaBookingSelection,
): Promise<A3PayDevVivaBookingResult> {
  if (!IS_DEV_RELEASE_CHANNEL) {
    return { data: null, error: "Сценарий доступен только в lk_dev", status: 404 };
  }

  const token = readAuthToken();
  if (!token) {
    return { data: null, error: "Не авторизован", status: 401 };
  }

  const url = `${SERV2}${ENDPOINT}/${action}?operationId=${encodeURIComponent(operationId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-PadlHub-Release-Channel": "dev",
      },
      body: JSON.stringify(selection ? { selection } : {}),
    });
  } catch {
    return {
      data: null,
      error: "Dev-сервис бронирования недоступен. Повторный запрос автоматически не отправлялся.",
      status: null,
    };
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      data: null,
      error: normalizeError(payload, `Не удалось выполнить запрос Viva (HTTP ${response.status})`),
      status: response.status,
    };
  }

  return {
    data: payload as A3PayDevVivaBookingResponse,
    error: null,
    status: response.status,
  };
}

export function createA3PayDevVivaBooking(
  operationId: string,
  selection: A3PayDevVivaBookingSelection,
) {
  return requestA3PayDevVivaBooking("create", operationId, selection);
}

export function cancelA3PayDevVivaBooking(operationId: string) {
  return requestA3PayDevVivaBooking("cancel", operationId);
}

export function getA3PayDevVivaBookingStatus(operationId: string) {
  return requestA3PayDevVivaBooking("status", operationId);
}

function simpleStableHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function buildA3PayDevVivaBookingSelectionKey(selection: A3PayDevVivaBookingSelection) {
  return [
    selection.date,
    selection.fromTime,
    selection.toTime,
    selection.studioId,
    selection.roomId,
    selection.masterServiceId,
    [...selection.subServiceIds].sort().join(","),
  ].join("|");
}

const ACTIVE_OPERATION_STORAGE_KEY = "lk-a3pay-dev-viva-active-operation-v1";

interface StoredActiveOperation {
  operationId: string;
  selectionKey: string;
  createdAt: string;
}

function parseStoredActiveOperation(value: string | null): StoredActiveOperation | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<StoredActiveOperation>;
    if (!parsed.operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(parsed.operationId)) return null;
    if (!parsed.selectionKey || typeof parsed.selectionKey !== "string") return null;
    return {
      operationId: parsed.operationId,
      selectionKey: parsed.selectionKey,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

export function getOrCreateA3PayDevVivaOperationId(selectionKey: string) {
  try {
    const stored = parseStoredActiveOperation(window.localStorage.getItem(ACTIVE_OPERATION_STORAGE_KEY));
    if (stored) return { ...stored, restored: true };
    const uuid = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const operationId = `a3dev-v1:${simpleStableHash(selectionKey)}:${uuid}`;
    const next = { operationId, selectionKey, createdAt: new Date().toISOString() };
    window.localStorage.setItem(ACTIVE_OPERATION_STORAGE_KEY, JSON.stringify(next));
    const persisted = parseStoredActiveOperation(window.localStorage.getItem(ACTIVE_OPERATION_STORAGE_KEY));
    if (!persisted || persisted.operationId !== operationId) return null;
    return { ...persisted, restored: false };
  } catch {
    return null;
  }
}

export function clearA3PayDevVivaOperationId(operationId: string) {
  try {
    const stored = parseStoredActiveOperation(window.localStorage.getItem(ACTIVE_OPERATION_STORAGE_KEY));
    if (!stored || stored.operationId !== operationId) return;
    window.localStorage.removeItem(ACTIVE_OPERATION_STORAGE_KEY);
  } catch {
    // A failed clear remains fail-closed: no second operation can be persisted.
  }
}
