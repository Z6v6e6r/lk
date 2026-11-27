import type {
  PadelGameRecord,
  PadelGameRecordPayload,
} from "./apiClient";

export interface ServerGameDraftApiResult {
  data: PadelGameRecord | null;
  error: { message: string } | null;
  missing?: true;
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

export interface SplitSurchargeDraftBinding {
  exerciseId: string;
  transactionId: string;
  operationId: string;
  clientId: string | null;
  amountMinor: number;
  canWrite: () => boolean;
}

export function isSplitSurchargeGameReadback(
  record: PadelGameRecord | null | undefined,
  paymentRef: string,
  bookingIds: string[],
  binding: SplitSurchargeDraftBinding,
): record is PadelGameRecord {
  if (!isExactServerGameDraftReadback(record, paymentRef, bookingIds) || bookingIds.length !== 1) return false;
  const split = record.metadata?.splitPayment as Record<string, unknown> | undefined;
  const payments = Array.isArray(split?.payments) ? split.payments as Array<Record<string, unknown>> : [];
  const organizerPayments = payments.filter(item => item?.role === "ORGANIZER" && item.paymentRef === paymentRef);
  const payment = organizerPayments[0];
  const paid = record.status === "PAID" || record.status === "PAYED";
  return record.archived !== true && (paid || record.status === "PAYMENT_PENDING")
    && (record.booking?.exerciseId || record.booking?.vivaExerciseId) === binding.exerciseId
    && Boolean(binding.clientId) && record.organizer?.id === binding.clientId
    && split?.createOperationId === binding.operationId
    && organizerPayments.length === 1 && payment.transactionId === binding.transactionId
    && payment.clientId === binding.clientId && payment.bookingId === bookingIds[0]
    && payment.amountMinor === binding.amountMinor && record.payment?.amount === binding.amountMinor / 100
    && (paid ? record.payment.paid === true && payment.status === "PAID" && !record.payment.paymentUrl && !payment.paymentUrl
      : record.payment.paid !== true && payment.status === "PAYMENT_PENDING");
}

export async function persistServerGameDraftWithReadback(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[],
  dependencies: ServerGameDraftPersistenceDependencies,
  splitSurcharge?: SplitSurchargeDraftBinding,
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

  const isExpectedDraft = (record: PadelGameRecord | null): record is PadelGameRecord => splitSurcharge
    ? isSplitSurchargeGameReadback(record, paymentRef, bookingIds, splitSurcharge)
    : isExactServerGameDraftReadback(record, paymentRef, bookingIds);
  if (splitSurcharge) {
    const existing = await dependencies.lookupDraft(paymentRef, bookingIds);
    if (isExpectedDraft(existing.data)) return { record: existing.data, error: null };
    // Only complete independent reads by booking and payment reference can
    // establish absence. A combined query could hide a conflicting alias.
    if (existing.status !== 200 || existing.data || existing.error || existing.missing !== true) {
      return { record: null, error: existing.error?.message || "Найденная игра не соответствует исходной операции" };
    }
  }

  if (splitSurcharge && !splitSurcharge.canWrite()) {
    return { record: null, error: "Проверка создания игры остановлена" };
  }

  // The split/create request has already created Viva state. Never repeat a
  // draft write after an ambiguous transport result; recover only by readback.
  const writeResult = await dependencies.createDraft(payload, { retries: 0, keepalive: true });
  const writeError = writeResult.error?.message ?? null;

  let lastLookupError: string | null = null;
  for (const delayMs of readbackDelaysMs) {
    if (delayMs > 0) await wait(delayMs);
    const lookupResult = await dependencies.lookupDraft(paymentRef, bookingIds);
    if (isExpectedDraft(lookupResult.data)) {
      return { record: lookupResult.data, error: null };
    }
    lastLookupError = lookupResult.error?.message || lastLookupError;
  }

  return {
    record: null,
    error: lastLookupError || writeError || "Сервер не подтвердил сохранение черновика игры",
  };
}


export async function persistRecoveredSubscriptionGameWithReadback(
  payload: PadelGameRecordPayload,
  existingCardOnly: boolean,
  canWrite: () => boolean,
  dependencies: Pick<ServerGameDraftPersistenceDependencies, "lookupDraft" | "wait" | "readbackDelaysMs"> & {
    createGame: ServerGameDraftPersistenceDependencies["createDraft"];
  },
): Promise<ServerGameDraftPersistenceResult & { reused?: boolean }> {
  const ref = payload.paymentRef;
  const bookingIds = payload.booking.bookingIds ?? [];
  const exerciseId = payload.booking.exerciseId;
  if (!ref || bookingIds.length !== 1 || !exerciseId || !payload.organizer.id) {
    return { record: null, error: "Не удалось связать игру с подтверждённой бронью" };
  }
  const lookup = () => dependencies.lookupDraft(ref, bookingIds);
  const matches = (game: PadelGameRecord | null): game is PadelGameRecord => {
    const booking = game?.booking;
    const split = game?.metadata?.splitPayment as Record<string, unknown> | undefined;
    const bookingExerciseIds = [booking?.exerciseId, booking?.vivaExerciseId, split?.vivaExerciseId]
      .filter(value => value != null);
    return !!game?.id && game.archived !== true && (game.status === "PAID" || game.status === "PAYED")
      && game.payment?.paid === true && game.payment.amount === 0 && !game.payment.paymentUrl
      && game.settings?.payMode === "split" && split?.selectedPaymentMode === "subscription"
      && split.organizerBookingId === bookingIds[0]
      && game.organizer?.id === payload.organizer.id
      && bookingExerciseIds.length > 0 && bookingExerciseIds.every(id => id === exerciseId)
      && recordBookingIds(game).includes(bookingIds[0])
      && booking?.studioId === payload.booking.studioId && booking?.roomId === payload.booking.roomId
      && Date.parse(booking.timeFromIso ?? "") === Date.parse(payload.booking.timeFromIso)
      && Date.parse(booking.timeToIso ?? "") === Date.parse(payload.booking.timeToIso)
      && game.invite?.maxPlayers === payload.invite?.maxPlayers;
  };
  const complete = (result: ServerGameDraftApiResult) => result.status === 200 && !result.error;
  const existing = await lookup();
  if (complete(existing) && matches(existing.data)) return { record: existing.data, error: null, reused: true };
  if (existingCardOnly && complete(existing) && existing.missing === true && !existing.data) {
    return { record: null, error: "Бронь подтверждена. Обратитесь в поддержку для восстановления карточки." };
  }
  if (existingCardOnly || !complete(existing) || existing.missing !== true || existing.data || !canWrite()) {
    return { record: null, error: existing.error?.message || "Не удалось подтвердить карточку по исходной брони" };
  }

  // Independent lookups of both aliases proved absence. The original
  // server receipt supplies the same paymentRef as the initial publisher.
  // The revision-fenced writer admits only the first insert for that identity.
  let writeError: string | null = null;
  let acknowledged = false;
  try {
    const write = await dependencies.createGame(payload, { retries: 0, keepalive: true });
    writeError = write.error?.message ?? null;
    acknowledged = !write.error && write.status === 200;
  } catch {
    // A lost response may still have committed. Resolve it only by readback.
  }

  const wait = dependencies.wait ?? ((delayMs: number) => new Promise<void>(resolve => globalThis.setTimeout(resolve, delayMs)));
  for (const delay of dependencies.readbackDelaysMs ?? DEFAULT_READBACK_DELAYS_MS) {
    if (delay > 0) await wait(delay);
    if (!canWrite()) break;
    const saved = await lookup();
    if (complete(saved) && matches(saved.data)) return { record: saved.data, error: null, reused: !acknowledged };
    if (saved.data) break;
  }
  return { record: null, error: writeError || "Сохранение карточки пока не подтверждено" };
}
