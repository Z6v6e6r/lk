// Local cancellation markers stop stale checkout links. Only the authenticated
// server response may prove that a booking and its reserved limit were released.
// One initial POST may be followed by one server-proved roster finalization;
// an unknown financial dispatch is never automatically posted again.
export type BookingPaymentTarget = { bookingId: string; transactionId: string; gameId?: string };
export type BookingPaymentCancellationState = "CLOSING" | "CLOSED" | "PAID";
export type BookingPaymentCancellationResult = { state: BookingPaymentCancellationState | "ERROR"; message: string };
type Reply = { status: number | null; data: unknown; error: { message?: string; raw?: unknown } | null };
type Marker = BookingPaymentTarget & { actor: string; session: string; state: BookingPaymentCancellationState };
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const STORAGE_KEY = "padlhub:booking-payment-cancellation:v1";
export const PAYMENT_CANCELLATION_CLOSED = "Оплата отменена. Лимит освобождён.";
export const PAYMENT_CANCELLATION_PAID = "Оплата уже прошла — отмена недоступна.";
export const PAYMENT_CANCELLATION_PENDING = "Переход к оплате заблокирован; отмена и освобождение лимита ещё проверяются.";
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const PRE_MUTATION_REFUSALS: Record<string, number> = {
  PAYMENT_CANCEL_INPUT_INVALID: 400,
  PAYMENT_CANCEL_ACTOR_UNVERIFIED: 401,
  PAYMENT_CANCEL_AUTH_REQUIRED: 401,
  PAYMENT_CANCEL_ATTEMPT_NOT_FOUND: 404,
  PAYMENT_CANCEL_METHOD_INVALID: 405,
  PAYMENT_CANCEL_UNAVAILABLE: 503,
};
function preMutationRefusal(reply: Reply, target: BookingPaymentTarget, actor: string): boolean {
  const body = object(reply.data) || object(reply.error?.raw);
  if (!body || typeof body.code !== "string" || body.accepted === true
    || PRE_MUTATION_REFUSALS[body.code] !== reply.status) return false;
  // A missing owner is authoritative only for this authenticated exact target.
  return body.code !== "PAYMENT_CANCEL_ATTEMPT_NOT_FOUND"
    || body.bookingId === target.bookingId && body.transactionId === target.transactionId
      && body.actorClientId === actor && (!target.gameId || body.gameId === target.gameId);
}
export function canCancelBookingPaymentAttempt(value: unknown): boolean {
  const row = object(value);
  return Boolean(row && row.paymentAttemptCancelSupported !== false
    && (row.paymentAttemptCancelSupported === true || text(row.paymentAttemptHeadKey)?.startsWith("booking-payment-head:")));
}
export function bookingPaymentTarget(value: unknown, gameId?: string | null): BookingPaymentTarget | null {
  const row = object(value);
  const bookingId = text(row?.bookingId), transactionId = text(row?.transactionId);
  return bookingId && transactionId ? { bookingId, transactionId, ...(gameId ? { gameId } : {}) } : null;
}
function sessionScope(token: string | null): string | null {
  if (!token) return null;
  let identity = token;
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.iss && claims.sub && claims.sid) identity = JSON.stringify([claims.iss, claims.sub, claims.sid]);
  } catch { /* Opaque credentials remain bound to their exact session. */ }
  // Persist a scope fingerprint, never the bearer credential itself.
  let hash = 2166136261;
  for (let i = 0; i < identity.length; i++) hash = Math.imul(hash ^ identity.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16) + ":" + identity.length;
}
let sessionReader: () => string | null = () => null;
export function setBookingPaymentCancellationSessionReader(read: () => string | null): void { sessionReader = read; }
function browserStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
export class BookingPaymentCancellation {
  private markers: Marker[] = [];
  private storageUnavailable = false;
  private running = new Map<string, Promise<BookingPaymentCancellationResult>>();
  constructor(privateOptions: { storage?: StorageLike | null } = {}) { this.storage = privateOptions.storage === undefined ? browserStorage() : privateOptions.storage; }
  private storage: StorageLike | null;
  private read(): Marker[] {
    if (!this.storage || this.storageUnavailable) return this.markers;
    try {
      const saved: unknown = JSON.parse(this.storage?.getItem(STORAGE_KEY) || "[]");
      if (Array.isArray(saved)) this.markers = saved.filter((m): m is Marker => Boolean(object(m)
        && text(m.actor) && text(m.session) && bookingPaymentTarget(m) && ["CLOSING", "CLOSED", "PAID"].includes(m.state)));
    } catch { /* Keep the in-memory block if storage is unavailable. */ }
    return this.markers;
  }
  private key(target: BookingPaymentTarget, actor: string, session: string) { return JSON.stringify([actor, session, target.bookingId, target.transactionId]); }
  private mark(target: BookingPaymentTarget, actor: string, session: string, state: BookingPaymentCancellationState | null) {
    const key = this.key(target, actor, session);
    this.markers = this.read().filter(m => this.key(m, m.actor, m.session) !== key);
    if (state) this.markers.push({ ...target, actor, session, state });
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.markers)); } catch { this.storageUnavailable = true; }
  }
  state(target: BookingPaymentTarget, actor: string, token: string | null): BookingPaymentCancellationState | null {
    const session = sessionScope(token);
    return session ? this.read().find(m => this.key(m, m.actor, m.session) === this.key(target, actor, session))?.state || null : null;
  }
  blocks(target: BookingPaymentTarget, token: string | null): boolean {
    const session = sessionScope(token);
    return Boolean(session && this.read().some(m => m.session === session && m.bookingId === target.bookingId && m.transactionId === target.transactionId));
  }
  cancel(target: BookingPaymentTarget, actor: string, options: {
    session: () => string | null; send: (method: "POST" | "GET", target: BookingPaymentTarget) => Promise<Reply>;
    wait?: () => Promise<void>; attempts?: number; onChange?: () => void;
  }): Promise<BookingPaymentCancellationResult> {
    const token = options.session(), scope = sessionScope(token);
    if (!actor || !scope || !bookingPaymentTarget(target)) return Promise.resolve({ state: "ERROR", message: "Не удалось подтвердить запись и сессию для отмены." });
    const key = this.key(target, actor, scope), pending = this.running.get(key);
    if (pending) return pending;
    const task = this.run(target, actor, token!, scope, options).finally(() => this.running.delete(key));
    this.running.set(key, task);
    return task;
  }
  private async run(target: BookingPaymentTarget, actor: string, token: string, scope: string, options: {
    session: () => string | null; send: (method: "POST" | "GET", target: BookingPaymentTarget) => Promise<Reply>;
    wait?: () => Promise<void>; attempts?: number; onChange?: () => void;
  }): Promise<BookingPaymentCancellationResult> {
    const previous = this.state(target, actor, token);
    const changed = () => options.onChange?.();
    const current = () => options.session() === token;
    const stopped = (): BookingPaymentCancellationResult => ({ state: "ERROR", message: "Сессия изменилась. Откройте запись заново." });
    if (previous === "CLOSED" || previous === "PAID") return { state: previous, message: previous === "CLOSED" ? PAYMENT_CANCELLATION_CLOSED : PAYMENT_CANCELLATION_PAID };
    this.mark(target, actor, scope, "CLOSING"); changed();
    const until = Date.now() + 30_000;
    let definitiveRejection = false;
    let finalizationPosted = false;
    if (!previous) {
      let posted: Reply;
      try { posted = await options.send("POST", target); }
      catch { posted = { status: null, data: null, error: { message: "Результат отправки отмены неизвестен." } }; }
      if (!current()) return stopped();
      // Cleanup can persist its marker before returning a generic 4xx/5xx.
      // Only an explicit pre-mutation controller refusal proves no acceptance.
      definitiveRejection = preMutationRefusal(posted, target, actor);
      // Even a generic successful cleanup response is not proof of closure.
      // Always reconcile the normalized authenticated GET contract below.
    }
    for (let attempt = 0; attempt < (options.attempts ?? 16); attempt++) {
      if (!current()) return stopped();
      let result: Reply;
      try { result = await options.send("GET", target); }
      catch { result = { status: null, data: null, error: { message: "Не удалось проверить отмену." } }; }
      if (!current()) return stopped();
      const row = object(result.data) || object(result.error?.raw);
      const bound = row?.bookingId === target.bookingId && row.transactionId === target.transactionId
        && row.actorClientId === actor && (!target.gameId || row.gameId == null || row.gameId === target.gameId);
      if (bound && !result.error && result.status === 200 && row.state === "CLOSED"
        && row.cancelled === true && row.limitReleased === true && row.paymentUrl === null) {
        this.mark(target, actor, scope, "CLOSED"); changed();
        return { state: "CLOSED", message: PAYMENT_CANCELLATION_CLOSED };
      }
      if (bound && !result.error && result.status === 200 && row.state === "PAID"
        && row.paid === true && row.cancelled === false && row.limitReleased === false) {
        this.mark(target, actor, scope, "PAID"); changed();
        return { state: "PAID", message: PAYMENT_CANCELLATION_PAID };
      }
      if (!finalizationPosted && bound && !result.error && result.status === 202 && row.state === "CLOSING"
        && target.gameId && row.gameId === target.gameId && row.financiallyClosed === true && row.needsFinalization === true
        && row.cancelled === false && row.limitReleased === false && row.paymentUrl === null && row.paid !== true) {
        // The authenticated GET proves that all monetary effects are complete.
        // This POST only asks the existing canonical owner to finish its roster.
        finalizationPosted = true; definitiveRejection = false;
        try { await options.send("POST", target); } catch { /* Unknown ACK: GET only for the rest of this invocation. */ }
        if (!current()) return stopped();
        // Always read normalized status after this POST, even on the last poll.
        attempt--;
        continue;
      }
      const accepted = bound && (row.accepted === true || !result.error && result.status === 202 && row.state === "CLOSING"
        && row.cancelled === false && row.limitReleased === false && row.paymentUrl === null);
      if (definitiveRejection && !accepted) {
        this.mark(target, actor, scope, null); changed();
        return { state: "ERROR", message: result.error?.message || "Отмена не принята. Запись и лимит не освобождены." };
      }
      if (result.error && result.status !== null && result.status !== 202) {
        return { state: "ERROR", message: result.error.message || "Отмена требует проверки. Освобождение лимита не подтверждено." };
      }
      if (Date.now() >= until || attempt + 1 >= (options.attempts ?? 16)) break;
      await (options.wait ?? (() => new Promise(resolve => setTimeout(resolve, 2000))))();
    }
    return { state: "CLOSING", message: PAYMENT_CANCELLATION_PENDING };
  }
}
let browserCancellation: BookingPaymentCancellation | null = null;
export function bookingPaymentCancellation(): BookingPaymentCancellation {
  return browserCancellation ??= new BookingPaymentCancellation();
}
export function paymentCancellationBlocksAttempt(value: unknown): boolean {
  const row = object(value), target = bookingPaymentTarget(row);
  return Boolean(target && bookingPaymentCancellation().blocks(target, sessionReader()));
}
