import type { ApiResult } from './apiClient';

export interface SplitCreateResultBinding {
  operationId: string;
  paymentRef: string;
  clientSubscriptionId: string;
  studioId: string;
  roomId: string;
  fromTime: string;
  toTime: string;
}
type Result = ApiResult<unknown>;
export const SPLIT_CREATE_RECOVERY_DELAYS_MS = [0, 1200, 2200, 3500, 5000] as const;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export function isAmbiguousSplitCreate(result: Result): boolean {
  if (result.status === null || (result.status >= 500) || result.status === 408) return true;
  if (result.error) return false;
  const data = record(result.data) && record(result.data.data) ? result.data.data : result.data;
  return !record(data) || (data.state != null && !['CONFIRMED', 'FULL_PRICE_WITHOUT_SUBSCRIPTION'].includes(String(data.state)))
    || !uuid(data.exerciseId) || !uuid(data.bookingId)
    || !['subscription', 'one_time'].includes(String(data.selectedPaymentMode))
    || typeof data.toPayMinor !== 'number' || !Number.isSafeInteger(data.toPayMinor) || data.toPayMinor < 0;
}
export function confirmedSplitCreateResult(value: unknown, binding: SplitCreateResultBinding): boolean {
  if (!record(value) || value.schemaVersion !== 1 || value.recovery !== 'SPLIT_CREATE_RESULT_V1'
    || value.state !== 'CONFIRMED' || value.mode !== 'create' || value.selectedPaymentMode !== 'subscription'
    || !Object.entries(binding).filter(([key]) => key !== 'paymentRef').every(([key, expected]) => value[key] === expected)
    || !(value.referenceSource === 'STORED_RECEIPT' && typeof value.paymentRef === 'string'
        && /^[A-Za-z0-9._:-]{1,200}$/.test(value.paymentRef)
      || value.referenceSource === 'LEGACY_OPERATION' && value.paymentRef === null && value.toPayMinor === 0)
    || !uuid(value.exerciseId) || !uuid(value.bookingId)
    || typeof value.toPayMinor !== 'number' || !Number.isSafeInteger(value.toPayMinor)
    || typeof value.shareAmountMinor !== 'number' || !Number.isSafeInteger(value.shareAmountMinor)
    || value.shareAmountMinor < 0 || value.shareAmountMinor > 1_000_000 || value.shareAmount !== value.shareAmountMinor / 100
    || value.toPayMinor < 0 || value.toPayMinor > 1_000_000 || value.toPay !== value.toPayMinor / 100) return false;
  if (value.toPayMinor === 0) return value.settlementState === 'CONFIRMED' && !value.paymentUrl && !value.transactionId;
  try {
    const url = new URL(String(value.paymentUrl));
    return value.settlementState === 'PAYMENT_REQUIRED' && uuid(value.transactionId)
      && url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

export const pendingSplitCreateResult = (operationId: string): Result => ({ data: {
  state: 'PENDING_CONFIRMATION', operationId, code: 'SPLIT_CREATE_RESULT_UNCONFIRMED',
  message: 'Создание отправлено. Подтверждение пока не получено. Проверьте результат этой попытки — повторное создание не требуется.',
}, error: null, status: 202 });

export function waitForSplitCreateResult(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
  });
}

export async function recoverSplitCreateResult(
  binding: SplitCreateResultBinding,
  read: (remainingMs: number) => Promise<Result>,
  options: { signal?: AbortSignal; session: () => string | null; delaysMs?: readonly number[];
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number } ,
): Promise<Result> {
  const session = options.session();
  const current = () => !!session && options.session() === session && !options.signal?.aborted;
  const stopped = (): Result => ({ data: null, status: 409, error: { status: 409,
    message: 'Проверка остановлена. Откройте бронирования в личном кабинете.', raw: { code: 'SPLIT_CREATE_RESULT_CANCELLED' } } });
  const now = options.now ?? Date.now;
  const deadline = now() + 60000;
  for (const delay of options.delaysMs ?? SPLIT_CREATE_RECOVERY_DELAYS_MS) {
    if (!current()) return stopped();
    if (now() + delay >= deadline) break;
    try { await (options.wait ?? waitForSplitCreateResult)(delay, options.signal); }
    catch { return stopped(); }
    if (!current()) return stopped();
    let result: Result;
    try { result = await read(Math.min(10000, Math.max(1, deadline - now()))); }
    catch { if (!current()) return stopped(); continue; }
    if (!current()) return stopped();
    if (result.status === 401 || result.status === 403) return result;
    if (!result.error && result.status === 200 && confirmedSplitCreateResult(result.data, binding)) {
      const data = result.data as Record<string, unknown>;
      return { ...result, data: { ...data, paymentRef: data.referenceSource === 'STORED_RECEIPT' ? data.paymentRef : binding.paymentRef } };
    }
    // A missing/newer backend never falls through to POST. Keep the attempt unresolved.
    if (result.status === 404 || result.status === 405) break;
  }
  return pendingSplitCreateResult(binding.operationId);
}

interface AttemptStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem?(key: string): void }
// Persist only opaque attempt/ref pairs, never profile, target or token. An entry
// survives reload until the LK card is saved; it never authorizes another CREATE.
export class SplitCreateAttempts {
  private readonly refs = new Map<string, string>();
  private readonly storage: AttemptStorage | null;
  private readonly key = 'lk_split_create_attempt_refs_v1:';
  private storageWritable = true;
  constructor(storage: AttemptStorage | null = null) { this.storage = storage; }
  private sync(operationId: string): void {
    if (!this.storage || !this.storageWritable) return;
    let raw: string | null;
    try { raw = this.storage.getItem(this.key + operationId); } catch { this.storageWritable = false; return; }
    if (!raw) return;
    if (raw.length > 512) throw new Error('SPLIT_CREATE_JOURNAL_INVALID');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error('SPLIT_CREATE_JOURNAL_INVALID'); }
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
      throw new Error('SPLIT_CREATE_JOURNAL_INVALID');
    }
    this.refs.set(operationId, value);
  }
  private persist(operationId: string): void {
    if (!this.storage || !this.storageWritable) return;
    try {
      const ref = this.refs.get(operationId);
      if (ref) this.storage.setItem(this.key + operationId, JSON.stringify(ref));
      else if (this.storage.removeItem) this.storage.removeItem(this.key + operationId);
      else this.storage.setItem(this.key + operationId, '');
    }
    catch { this.storageWritable = false; /* Never replace newer memory with stale persisted refs. */ }
  }
  begin(operationId: string, paymentRef: string): { paymentRef: string; recoveryOnly: boolean } {
    this.sync(operationId);
    const existing = this.refs.get(operationId);
    if (existing) return { paymentRef: existing, recoveryOnly: true };
    if (this.refs.size >= 64) throw new Error('SPLIT_CREATE_PENDING_LIMIT');
    this.refs.set(operationId, paymentRef);
    this.persist(operationId);
    return { paymentRef, recoveryOnly: false };
  }
  complete(operationId: string): void { this.refs.delete(operationId); this.persist(operationId); }
  adopt(operationId: string, paymentRef: string): void { this.refs.set(operationId, paymentRef); this.persist(operationId); }
  has(operationId: string): boolean { this.sync(operationId); return this.refs.has(operationId); }
  paymentRef(operationId: string): string | undefined { this.sync(operationId); return this.refs.get(operationId); }
}
