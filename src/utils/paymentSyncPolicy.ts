export const PAYMENT_SYNC_MAX_ATTEMPTS = 20;

export type PaymentSyncQueueStatus = "pending" | "exhausted";

export type PaymentSyncLookupMode =
  | "paymentRef"
  | "bookingIds"
  | "combined"
  | "sequential";

export interface PaymentSyncRetryState {
  attempts: number;
  nextAttemptTs: number;
  lastAttemptTs: number | null;
  lastError: string | null;
  updatedAt: string;
  status?: PaymentSyncQueueStatus;
  exhaustedAt?: string | null;
}

const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 10 * 60_000;

function normalizeAttempts(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function resolvePaymentSyncLookupMode(params: {
  forcedCallback: boolean;
}): PaymentSyncLookupMode {
  if (params.forcedCallback) return "sequential";
  return "paymentRef";
}

export function computePaymentSyncRetryDelayMs(attemptsRaw: number): number {
  const attempts = normalizeAttempts(attemptsRaw);
  const power = Math.max(0, attempts - 1);
  const delay = RETRY_BASE_MS * (2 ** Math.min(power, 6));
  return Math.min(delay, RETRY_MAX_MS);
}

export function isPaymentSyncExhausted(
  item: Pick<PaymentSyncRetryState, "attempts" | "status">,
): boolean {
  return item.status === "exhausted"
    || normalizeAttempts(item.attempts) >= PAYMENT_SYNC_MAX_ATTEMPTS;
}

export function shouldClaimPaymentSyncItem(
  item: Pick<PaymentSyncRetryState, "attempts" | "nextAttemptTs" | "status">,
  now: number,
  force = false,
): boolean {
  if (isPaymentSyncExhausted(item)) return false;
  return force || item.nextAttemptTs <= now;
}

export function advancePaymentSyncFailure<T extends PaymentSyncRetryState>(
  current: T,
  messageRaw: string,
  now: number,
): T {
  const attempts = Math.min(
    PAYMENT_SYNC_MAX_ATTEMPTS,
    normalizeAttempts(current.attempts) + 1,
  );
  const exhausted = attempts >= PAYMENT_SYNC_MAX_ATTEMPTS;
  const nowIso = new Date(now).toISOString();

  return {
    ...current,
    attempts,
    nextAttemptTs: exhausted
      ? Number.MAX_SAFE_INTEGER
      : now + computePaymentSyncRetryDelayMs(attempts),
    lastAttemptTs: now,
    lastError: messageRaw.trim() || "unknown",
    updatedAt: nowIso,
    status: exhausted ? "exhausted" : "pending",
    exhaustedAt: exhausted ? (current.exhaustedAt ?? nowIso) : null,
  };
}

export function removePaymentSyncQueueItem<T>(
  store: Record<string, T>,
  paymentRef: string,
): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(store, paymentRef)) return store;
  const next = { ...store };
  delete next[paymentRef];
  return next;
}
