import type {
  PadelGameRecord,
  PadelGameRecordPayload,
} from "./apiClient";

export interface ServerGameDraftApiResult {
  data: PadelGameRecord | null;
  error: { message: string } | null;
  status: number | null;
}

export interface ServerGameDraftPersistenceDependencies {
  createDraft: (
    payload: PadelGameRecordPayload,
    options: { retries: number; keepalive: boolean },
  ) => Promise<ServerGameDraftApiResult>;
  lookupDraft: (
    paymentRef: string,
    bookingIds: string[],
  ) => Promise<ServerGameDraftApiResult>;
  wait?: (delayMs: number) => Promise<void>;
  readbackDelaysMs?: number[];
}

export interface ServerGameDraftPersistenceResult {
  record: PadelGameRecord | null;
  error: string | null;
}

const DEFAULT_READBACK_DELAYS_MS = [0, 250, 750, 1_500, 3_000, 5_000];

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function recordPaymentRefs(record: PadelGameRecord): string[] {
  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata
    : {};
  const splitPayment = metadata.splitPayment && typeof metadata.splitPayment === "object"
    ? metadata.splitPayment as Record<string, unknown>
    : {};
  const payments = Array.isArray(splitPayment.payments)
    ? splitPayment.payments.filter((item): item is Record<string, unknown> => (
      Boolean(item) && typeof item === "object" && !Array.isArray(item)
    ))
    : [];

  return uniqueStrings([
    typeof metadata.paymentRef === "string" ? metadata.paymentRef : null,
    typeof splitPayment.paymentRef === "string" ? splitPayment.paymentRef : null,
    ...payments.map((item) => typeof item.paymentRef === "string" ? item.paymentRef : null),
  ]);
}

function recordBookingIds(record: PadelGameRecord): string[] {
  const metadata = record.metadata && typeof record.metadata === "object"
    ? record.metadata
    : {};
  const metadataBookingIds = Array.isArray(metadata.bookingIds)
    ? metadata.bookingIds
    : [];
  return uniqueStrings([
    record.booking?.bookingId,
    ...(record.booking?.bookingIds ?? []),
    ...metadataBookingIds.map((value) => typeof value === "string" ? value : null),
  ]);
}

export function isExactServerGameDraftReadback(
  record: PadelGameRecord | null | undefined,
  paymentRefRaw: string,
  expectedBookingIdsRaw: string[],
): record is PadelGameRecord {
  if (!record?.id) return false;
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef || !recordPaymentRefs(record).includes(paymentRef)) return false;

  const expectedBookingIds = uniqueStrings(expectedBookingIdsRaw);
  if (expectedBookingIds.length === 0) return true;
  const actualBookingIds = new Set(recordBookingIds(record));
  return expectedBookingIds.every((bookingId) => actualBookingIds.has(bookingId));
}

export async function persistServerGameDraftWithReadback(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[],
  dependencies: ServerGameDraftPersistenceDependencies,
): Promise<ServerGameDraftPersistenceResult> {
  const paymentRef = paymentRefRaw.trim();
  const bookingIds = uniqueStrings(bookingIdsRaw);
  if (!paymentRef) {
    return { record: null, error: "Не удалось определить ссылку платежа для сохранения игры" };
  }

  const wait = dependencies.wait ?? ((delayMs: number) => new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  }));
  const readbackDelaysMs = dependencies.readbackDelaysMs ?? DEFAULT_READBACK_DELAYS_MS;

  // The split/create request has already created Viva state. Never repeat a
  // draft write after an ambiguous transport result; recover only by readback.
  const writeResult = await dependencies.createDraft(payload, { retries: 0, keepalive: true });
  const writeError = writeResult.error?.message ?? null;

  let lastLookupError: string | null = null;
  for (const delayMs of readbackDelaysMs) {
    if (delayMs > 0) await wait(delayMs);
    const lookupResult = await dependencies.lookupDraft(paymentRef, bookingIds);
    if (isExactServerGameDraftReadback(lookupResult.data, paymentRef, bookingIds)) {
      return { record: lookupResult.data, error: null };
    }
    lastLookupError = lookupResult.error?.message || lastLookupError;
  }

  return {
    record: null,
    error: lastLookupError || writeError || "Сервер не подтвердил сохранение черновика игры",
  };
}
