import {
  apiConfirmPadelGamePayment,
  apiFetchPadelGameByPaymentRef,
  type PadelGameRecord,
  type PadelGameRecordPayload,
} from "./apiClient";
import { trackAnalyticsEvent } from "./analytics";
import {
  advancePaymentSyncFailure,
  isPaymentSyncExhausted,
  removePaymentSyncQueueItem,
  shouldClaimPaymentSyncItem,
  type PaymentSyncQueueStatus,
} from "./paymentSyncPolicy";
import {
  attachPaymentSyncExerciseId,
  collectPaymentSyncPayloadExerciseIds,
} from "./paymentSyncBookingResolution";
import { recoverGameExerciseId } from "./gameExerciseIdRecovery";
import {
  buildPendingPaidGameDraftFromRecord,
  isConfirmedPaymentReadbackBound,
  isPersistedGamePaymentFailedTerminal,
  isPersistedGamePaymentTerminal,
  resolvePaymentSyncExpectedGameId,
} from "./paymentSyncDraftRecovery";

export {
  buildPendingPaidGameDraftFromRecord,
  isPersistedGamePaymentFailedTerminal,
  isPersistedGamePaymentTerminal,
} from "./paymentSyncDraftRecovery";

export const PAYMENT_REF_QUERY_KEY = "phPaymentRef";
export const PENDING_GAME_DRAFT_KEY = "padlhub.pendingPaidGameDraft.v1";
const PENDING_GAME_DRAFTS_MAP_KEY = "padlhub.pendingPaidGameDraft.map.v1";
const PAYMENT_SYNC_QUEUE_KEY = "padlhub.pendingPaymentSyncQueue.v1";
const PAYMENT_SYNC_WEB_LOCK_NAME = "padlhub.payment-sync.v1";

const DEFAULT_MAX_BATCH = 4;
const claimedPaymentRefs = new Set<string>();

export interface PendingPaidGameDraft {
  paymentRef: string;
  payload: PadelGameRecordPayload;
  bookingIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface PaymentSyncQueueItem {
  paymentRef: string;
  bookingIds: string[];
  attempts: number;
  nextAttemptTs: number;
  lastAttemptTs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  status?: PaymentSyncQueueStatus;
  exhaustedAt?: string | null;
}

interface PaymentSyncQueueStore {
  [paymentRef: string]: PaymentSyncQueueItem;
}

interface PendingDraftStore {
  [paymentRef: string]: PendingPaidGameDraft;
}

export interface PaymentSyncResolvedItem {
  paymentRef: string;
  record: PadelGameRecord;
}

export interface PaymentSyncFailedItem {
  paymentRef: string;
  error: string;
  terminal?: boolean;
}

export interface PaymentSyncProcessResult {
  processed: number;
  pending: number;
  resolved: PaymentSyncResolvedItem[];
  failed: PaymentSyncFailedItem[];
}

export interface PaymentSyncProcessOptions {
  forcePaymentRef?: string | null;
  forceBookingIds?: string[];
  source?: string;
  keepalive?: boolean;
  maxItems?: number;
}

const isBrowser = typeof window !== "undefined";

function toStringSafe(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseBookingIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return unique(
      value
        .map((item) => toStringSafe(item))
        .filter((item): item is string => Boolean(item)),
    );
  }
  if (typeof value === "string") {
    return unique(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }
  return [];
}

function readLocalJson<T>(key: string, fallback: T): T {
  if (!isBrowser) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson<T>(key: string, value: T): void {
  if (!isBrowser) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore storage quota / unavailable storage
  }
}

function readQueue(): PaymentSyncQueueStore {
  const raw = readLocalJson<unknown>(PAYMENT_SYNC_QUEUE_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as PaymentSyncQueueStore;
}

function writeQueue(store: PaymentSyncQueueStore): void {
  writeLocalJson(PAYMENT_SYNC_QUEUE_KEY, store);
}

function readDraftStore(): PendingDraftStore {
  const raw = readLocalJson<unknown>(PENDING_GAME_DRAFTS_MAP_KEY, {});
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as PendingDraftStore;
}

function writeDraftStore(store: PendingDraftStore): void {
  writeLocalJson(PENDING_GAME_DRAFTS_MAP_KEY, store);
}

function clearLegacySessionDraft(paymentRef?: string): void {
  if (!isBrowser) return;
  const raw = window.sessionStorage.getItem(PENDING_GAME_DRAFT_KEY);
  if (!raw) return;

  if (!paymentRef) {
    window.sessionStorage.removeItem(PENDING_GAME_DRAFT_KEY);
    return;
  }

  try {
    const parsed = JSON.parse(raw) as { paymentRef?: unknown };
    if (toStringSafe(parsed.paymentRef) === paymentRef) {
      window.sessionStorage.removeItem(PENDING_GAME_DRAFT_KEY);
    }
  } catch {
    window.sessionStorage.removeItem(PENDING_GAME_DRAFT_KEY);
  }
}

function readLegacySessionDraft(paymentRef: string): PendingPaidGameDraft | null {
  if (!isBrowser) return null;
  const raw = window.sessionStorage.getItem(PENDING_GAME_DRAFT_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      paymentRef?: unknown;
      payload?: PadelGameRecordPayload;
      bookingIds?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const parsedPaymentRef = toStringSafe(parsed.paymentRef);
    if (!parsedPaymentRef || parsedPaymentRef !== paymentRef) return null;
    if (!parsed.payload) return null;

    const nowIso = new Date().toISOString();
    return {
      paymentRef: parsedPaymentRef,
      payload: parsed.payload,
      bookingIds: parseBookingIds(parsed.bookingIds),
      createdAt: toStringSafe(parsed.createdAt) ?? nowIso,
      updatedAt: toStringSafe(parsed.updatedAt) ?? nowIso,
    };
  } catch {
    return null;
  }
}

function getExistingBookingIdsFromPayload(payload: PadelGameRecordPayload): string[] {
  const metadata = payload.metadata && typeof payload.metadata === "object"
    ? payload.metadata
    : {};
  const metadataBookingIds = parseBookingIds(
    (metadata as Record<string, unknown>).bookingIds,
  );
  return unique([
    ...metadataBookingIds,
    ...parseBookingIds(payload.booking?.bookingIds),
    ...parseBookingIds(payload.payment?.bookingIds),
  ]);
}

function buildConfirmPayload(
  draft: PendingPaidGameDraft,
  bookingIds: string[],
): PadelGameRecordPayload {
  const payload = draft.payload;
  const metadataRaw =
    payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata as Record<string, unknown>
      : {};
  const mergedBookingIds = unique([
    ...getExistingBookingIdsFromPayload(payload),
    ...bookingIds,
  ]);

  return {
    ...payload,
    paymentRef: draft.paymentRef,
    status: "PAID",
    booking: {
      ...payload.booking,
      bookingIds: mergedBookingIds,
    },
    payment: {
      ...payload.payment,
      paid: true,
      paidAt: new Date().toISOString(),
      paymentRef: draft.paymentRef,
      bookingIds: mergedBookingIds,
    },
    metadata: {
      ...metadataRaw,
      paymentRef: draft.paymentRef,
      bookingIds: mergedBookingIds,
    },
  };
}

function trackPaymentConfirmEvent(
  stage: "requested" | "success" | "failed",
  payload: Record<string, unknown>,
): void {
  trackAnalyticsEvent(`payment_confirm_${stage}`, payload);
}

export function extractBookingIdsFromUrl(url: URL): string[] {
  return unique([
    ...url.searchParams.getAll("bookingIds").map((value) => value.trim()),
    ...url.searchParams.getAll("bookingId").map((value) => value.trim()),
  ].filter(Boolean));
}

export function savePendingPaidGameDraft(
  paymentRefRaw: string,
  payload: PadelGameRecordPayload,
  bookingIdsRaw: string[] = [],
): void {
  if (!isBrowser) return;
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const nowIso = new Date().toISOString();
  const store = readDraftStore();
  const previous = store[paymentRef];
  const bookingIds = unique([
    ...parseBookingIds(bookingIdsRaw),
    ...getExistingBookingIdsFromPayload(payload),
    ...parseBookingIds(previous?.bookingIds),
  ]);

  const draft: PendingPaidGameDraft = {
    paymentRef,
    payload: {
      ...payload,
      paymentRef,
      booking: {
        ...payload.booking,
        bookingIds,
      },
      payment: {
        ...payload.payment,
        paymentRef,
        bookingIds,
      },
      metadata: {
        ...(payload.metadata && typeof payload.metadata === "object"
          ? payload.metadata
          : {}),
        paymentRef,
        bookingIds,
      },
    },
    bookingIds,
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };

  store[paymentRef] = draft;
  writeDraftStore(store);

  try {
    window.sessionStorage.setItem(
      PENDING_GAME_DRAFT_KEY,
      JSON.stringify({
        paymentRef: draft.paymentRef,
        payload: draft.payload,
        bookingIds: draft.bookingIds,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      }),
    );
  } catch {
    // ignore
  }
}

export function getPendingPaidGameDraft(paymentRefRaw: string): PendingPaidGameDraft | null {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return null;
  const store = readDraftStore();
  const fromStore = store[paymentRef] ?? null;
  if (fromStore) return fromStore;
  return readLegacySessionDraft(paymentRef);
}

export function removePendingPaidGameDraft(paymentRefRaw: string): void {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const store = readDraftStore();
  if (store[paymentRef]) {
    delete store[paymentRef];
    writeDraftStore(store);
  }
  clearLegacySessionDraft(paymentRef);
}

export function enqueuePendingPaymentSync(
  paymentRefRaw: string,
  bookingIdsRaw: string[] = [],
  reason = "enqueue",
): void {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const queue = readQueue();
  const previous = queue[paymentRef];
  const draft = getPendingPaidGameDraft(paymentRef);
  const mergedBookingIds = unique([
    ...parseBookingIds(bookingIdsRaw),
    ...parseBookingIds(previous?.bookingIds),
    ...parseBookingIds(draft?.bookingIds),
    ...getExistingBookingIdsFromPayload(draft?.payload ?? ({
      organizer: { id: null, name: null, phone: null },
      booking: {
        studioId: "",
        studioName: "",
        masterServiceId: null,
        subServiceIds: [],
        roomId: "",
        roomName: "",
        date: "",
        timeFrom: "",
        timeTo: "",
        timeFromIso: "",
        timeToIso: "",
        durationMinutes: 0,
        slotId: null,
      },
      payment: {
        amount: null,
        paymentUrl: null,
        paymentMethod: "WIDGET",
      },
    } as PadelGameRecordPayload)),
  ]);

  queue[paymentRef] = {
    paymentRef,
    bookingIds: mergedBookingIds,
    attempts: previous?.attempts ?? 0,
    nextAttemptTs: previous && isPaymentSyncExhausted(previous)
      ? previous.nextAttemptTs
      : now,
    lastAttemptTs: previous?.lastAttemptTs ?? null,
    lastError: previous?.lastError ?? null,
    createdAt: previous?.createdAt ?? nowIso,
    updatedAt: nowIso,
    status: previous && isPaymentSyncExhausted(previous) ? "exhausted" : "pending",
    exhaustedAt: previous?.exhaustedAt ?? null,
  };
  writeQueue(queue);

  trackAnalyticsEvent("payment_sync_enqueued", {
    paymentRef,
    bookingIdsCount: mergedBookingIds.length,
    reason,
  });
}

export function registerPendingPaymentSyncFailure(
  paymentRefRaw: string,
  messageRaw: string,
): void {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const queue = readQueue();
  const current = queue[paymentRef];
  if (!current) return;
  queue[paymentRef] = advancePaymentSyncFailure(current, messageRaw, Date.now());
  writeQueue(queue);
}

export function markPendingPaymentSyncResolved(paymentRefRaw: string): void {
  const paymentRef = paymentRefRaw.trim();
  if (!paymentRef) return;
  const queue = readQueue();
  if (queue[paymentRef]) {
    writeQueue(removePaymentSyncQueueItem(queue, paymentRef));
  }
  removePendingPaidGameDraft(paymentRef);
}

function claimQueueItems(
  forcePaymentRef: string | null,
  maxItems: number,
  forceBookingIds: string[] = [],
): PaymentSyncQueueItem[] {
  const queue = readQueue();
  const now = Date.now();
  const items = Object.values(queue);
  items.sort((a, b) => {
    if (a.nextAttemptTs !== b.nextAttemptTs) return a.nextAttemptTs - b.nextAttemptTs;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const selected: PaymentSyncQueueItem[] = [];
  if (forcePaymentRef) {
    const forced = queue[forcePaymentRef];
    if (
      forced
      && shouldClaimPaymentSyncItem(forced, now, true)
      && !claimedPaymentRefs.has(forced.paymentRef)
    ) {
      claimedPaymentRefs.add(forced.paymentRef);
      selected.push(forced);
    } else if (!forced && !claimedPaymentRefs.has(forcePaymentRef)) {
      // Storage can be unavailable in private/locked-down browsers. A callback
      // paymentRef is still enough to recover the durable server draft.
      claimedPaymentRefs.add(forcePaymentRef);
      const nowIso = new Date(now).toISOString();
      selected.push({
        paymentRef: forcePaymentRef,
        bookingIds: unique(forceBookingIds),
        status: "pending",
        attempts: 0,
        lastAttemptTs: null,
        nextAttemptTs: now,
        createdAt: nowIso,
        updatedAt: nowIso,
        lastError: null,
      });
    }
  }

  for (const item of items) {
    if (selected.length >= maxItems) break;
    if (forcePaymentRef && item.paymentRef === forcePaymentRef) continue;
    if (!shouldClaimPaymentSyncItem(item, now)) continue;
    if (claimedPaymentRefs.has(item.paymentRef)) continue;
    claimedPaymentRefs.add(item.paymentRef);
    selected.push(item);
  }

  return selected;
}

async function processPendingPaymentSyncQueueUnlocked(
  options?: PaymentSyncProcessOptions,
): Promise<PaymentSyncProcessResult> {
  const forcePaymentRef = toStringSafe(options?.forcePaymentRef) ?? null;
  const maxItems = Number.isFinite(options?.maxItems)
    ? Math.max(1, Math.min(20, Math.floor(options?.maxItems as number)))
    : DEFAULT_MAX_BATCH;
  const source = toStringSafe(options?.source) ?? "app_boot";
  const keepalive = options?.keepalive === true;
  const forceBookingIds = parseBookingIds(options?.forceBookingIds ?? []);

  if (forcePaymentRef) {
    enqueuePendingPaymentSync(forcePaymentRef, forceBookingIds, `${source}:force`);
  }

  const items = claimQueueItems(forcePaymentRef, maxItems, forceBookingIds);
  const resolved: PaymentSyncResolvedItem[] = [];
  const failed: PaymentSyncFailedItem[] = [];
  let processed = 0;

  for (const item of items) {
    const paymentRef = item.paymentRef;
    try {
      processed += 1;
      const bookingIds = unique([...item.bookingIds, ...forceBookingIds]);
      const attempt = (item.attempts ?? 0) + 1;

      trackPaymentConfirmEvent("requested", {
        stage: "lookup",
        paymentRef,
        bookingIdsCount: bookingIds.length,
        attempt,
        source,
        url: "/lk/games",
      });

      const byPaymentRef = await apiFetchPadelGameByPaymentRef(paymentRef, bookingIds);
      const persistedRecord = byPaymentRef.data?.id ? byPaymentRef.data : null;
      if (persistedRecord && isPersistedGamePaymentTerminal(persistedRecord)) {
        trackPaymentConfirmEvent("success", {
          stage: "lookup",
          paymentRef,
          gameId: persistedRecord.id,
          status: byPaymentRef.status ?? null,
          source,
        });
        markPendingPaymentSyncResolved(paymentRef);
        resolved.push({ paymentRef, record: persistedRecord });
        continue;
      }

      if (persistedRecord && isPersistedGamePaymentFailedTerminal(persistedRecord)) {
        const errorMessage = "Платёж отменён или завершился с ошибкой";
        markPendingPaymentSyncResolved(paymentRef);
        failed.push({ paymentRef, error: errorMessage, terminal: true });
        continue;
      }

      const lookupErrorStatus = Number(byPaymentRef.error?.status ?? byPaymentRef.status);
      if (
        byPaymentRef.error
        && (!Number.isFinite(lookupErrorStatus) || lookupErrorStatus >= 400)
      ) {
        const errorMessage = byPaymentRef.error.message || "Не удалось проверить созданную игру";
        trackPaymentConfirmEvent("failed", {
          stage: "lookup",
          paymentRef,
          status: byPaymentRef.status ?? null,
          source,
          message: errorMessage,
        });
        registerPendingPaymentSyncFailure(paymentRef, errorMessage);
        failed.push({ paymentRef, error: errorMessage });
        continue;
      }

      // Confirmation must be bound to the latest persisted identity and revision.
      // A browser draft can survive a concurrent roster update and is therefore
      // never authoritative for the payment CAS.
      const draft = persistedRecord
        ? buildPendingPaidGameDraftFromRecord(persistedRecord, paymentRef)
        : null;
      if (!draft) {
        const errorMessage =
          byPaymentRef.error?.message || "Черновик игры после оплаты не найден";
        trackPaymentConfirmEvent("failed", {
          stage: "draft_missing",
          paymentRef,
          status: byPaymentRef.status ?? null,
          source,
          message: errorMessage,
        });
        registerPendingPaymentSyncFailure(paymentRef, errorMessage);
        failed.push({ paymentRef, error: errorMessage });
        continue;
      }

      const confirmBookingIds = unique([
        ...bookingIds,
        ...getExistingBookingIdsFromPayload(draft.payload),
      ]);
      let confirmPayload = buildConfirmPayload(draft, confirmBookingIds);
      const payloadExerciseIds = collectPaymentSyncPayloadExerciseIds(confirmPayload);
      if (payloadExerciseIds.length === 0) {
        trackPaymentConfirmEvent("requested", {
          stage: "exercise_restore",
          paymentRef,
          bookingIdsCount: confirmBookingIds.length,
          attempt,
          source,
        });
      }
      const exerciseRecovery = await recoverGameExerciseId({
        exerciseIds: payloadExerciseIds,
        bookingIds: confirmBookingIds,
      });
      if (!exerciseRecovery.ok) {
        trackPaymentConfirmEvent("failed", {
          stage: "exercise_restore",
          paymentRef,
          status: exerciseRecovery.status,
          source,
          code: exerciseRecovery.code,
          message: exerciseRecovery.message,
        });
        registerPendingPaymentSyncFailure(paymentRef, exerciseRecovery.message);
        failed.push({ paymentRef, error: exerciseRecovery.message });
        continue;
      }

      confirmPayload = attachPaymentSyncExerciseId(confirmPayload, exerciseRecovery.exerciseId);
      if (exerciseRecovery.source === "viva_bookings") {
        trackPaymentConfirmEvent("success", {
          stage: "exercise_restore",
          paymentRef,
          exerciseId: exerciseRecovery.exerciseId,
          bookingIdsCount: exerciseRecovery.bookingIds.length,
          source,
        });
      }
      trackPaymentConfirmEvent("requested", {
        stage: "confirm",
        paymentRef,
        bookingIdsCount: bookingIds.length,
        attempt,
        source,
        url: "/lk/games/payment/confirm",
      });

      const confirmResult = await apiConfirmPadelGamePayment(confirmPayload, {
        keepalive,
        retries: 0,
      });
      if (confirmResult.data?.id) {
        const confirmedReadback = await apiFetchPadelGameByPaymentRef(paymentRef, confirmBookingIds);
        const confirmedRecord = confirmedReadback.data?.id ? confirmedReadback.data : null;
        if (
          !confirmedRecord
          || !isPersistedGamePaymentTerminal(confirmedRecord)
          || !isConfirmedPaymentReadbackBound(confirmedRecord, {
            paymentRef,
            gameId: confirmResult.data.id,
            bookingIds: confirmBookingIds,
          })
        ) {
          const errorMessage = confirmedReadback.error?.message
            || "Сервер ещё не подтвердил сохранение оплаченной игры";
          registerPendingPaymentSyncFailure(paymentRef, errorMessage);
          failed.push({ paymentRef, error: errorMessage });
          continue;
        }
        trackPaymentConfirmEvent("success", {
          stage: "confirm",
          paymentRef,
          gameId: confirmedRecord.id,
          status: confirmResult.status ?? null,
          source,
        });
        markPendingPaymentSyncResolved(paymentRef);
        resolved.push({ paymentRef, record: confirmedRecord });
        continue;
      }

      trackPaymentConfirmEvent("failed", {
        stage: "confirm",
        paymentRef,
        status: confirmResult.status ?? null,
        source,
        message: confirmResult.error?.message || "unknown",
      });

      // A concurrent callback can win the CAS after this tab loaded the same
      // pending draft. Recover only through a fresh, exact terminal readback.
      const concurrentReadback = await apiFetchPadelGameByPaymentRef(paymentRef, confirmBookingIds);
      const concurrentRecord = concurrentReadback.data?.id ? concurrentReadback.data : null;
      const expectedGameId = resolvePaymentSyncExpectedGameId(
        confirmPayload.gameId,
        draft.payload.gameId,
        persistedRecord?.id,
      );
      if (
        concurrentRecord
        && expectedGameId
        && isPersistedGamePaymentTerminal(concurrentRecord)
        && isConfirmedPaymentReadbackBound(concurrentRecord, {
          paymentRef,
          gameId: expectedGameId,
          bookingIds: confirmBookingIds,
        })
      ) {
        trackPaymentConfirmEvent("success", {
          stage: "confirm_concurrent_readback",
          paymentRef,
          gameId: concurrentRecord.id,
          status: concurrentReadback.status ?? null,
          source,
        });
        markPendingPaymentSyncResolved(paymentRef);
        resolved.push({ paymentRef, record: concurrentRecord });
        continue;
      }

      const errorMessage =
        confirmResult.error?.message
        || concurrentReadback.error?.message
        || byPaymentRef.error?.message
        || "Не удалось подтвердить оплату";

      registerPendingPaymentSyncFailure(paymentRef, errorMessage);
      failed.push({ paymentRef, error: errorMessage });
    } finally {
      claimedPaymentRefs.delete(paymentRef);
    }
  }

  const pending = Object.values(readQueue())
    .filter((item) => !isPaymentSyncExhausted(item))
    .length;
  return {
    processed,
    pending,
    resolved,
    failed,
  };
}

function buildSkippedPaymentSyncResult(): PaymentSyncProcessResult {
  return {
    processed: 0,
    pending: Object.values(readQueue()).filter((item) => !isPaymentSyncExhausted(item)).length,
    resolved: [],
    failed: [],
  };
}

export async function processPendingPaymentSyncQueue(
  options?: PaymentSyncProcessOptions,
): Promise<PaymentSyncProcessResult> {
  const lockManager = isBrowser && typeof navigator !== "undefined"
    ? navigator.locks
    : null;
  if (!lockManager) {
    return processPendingPaymentSyncQueueUnlocked(options);
  }

  if (toStringSafe(options?.forcePaymentRef)) {
    return lockManager.request(
      PAYMENT_SYNC_WEB_LOCK_NAME,
      { mode: "exclusive" },
      () => processPendingPaymentSyncQueueUnlocked(options),
    );
  }

  return lockManager.request(
    PAYMENT_SYNC_WEB_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) return buildSkippedPaymentSyncResult();
      return processPendingPaymentSyncQueueUnlocked(options);
    },
  );
}
