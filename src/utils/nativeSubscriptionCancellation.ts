import type { ApiResult } from './apiClient';

type VerifiedCancellation = { ok: true; state: 'RELEASED'; bookingId: string; operationId: string };
const verified = new Map<string, VerifiedCancellation>();
let cacheSession: string | null = null;
function bindSession(session: string | null) {
  if (session !== cacheSession) { verified.clear(); cacheSession = session; }
}
export function nativeSubscriptionCancellationVerified(bookingId: string, session: string | null): VerifiedCancellation | null {
  bindSession(session);
  if (!session) return null;
  return verified.get(bookingId) || null;
}
export function nativeCancellationRequestId(bookingId: string): string | null {
  if (!globalThis.crypto?.getRandomValues) return null;
  const bytes = globalThis.crypto.getRandomValues(new Uint32Array(4));
  const id = `lk-subscription-cancel:${bookingId}:${Array.from(bytes, n => n.toString(16).padStart(8, '0')).join('')}`;
  return id.length <= 200 ? id : null;
}
export async function pollNativeSubscriptionCancellation(
  bookingId: string,
  send: () => Promise<ApiResult<unknown>>,
  options: { attempts?: number; wait?: () => Promise<void>; session?: () => string | null } = {},
): Promise<ApiResult<unknown>> {
  const attempts = options.attempts ?? 30;
  const wait = options.wait ?? (() => new Promise(resolve => setTimeout(resolve, 2000)));
  const session = options.session?.() ?? null;
  bindSession(session);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const currentSession = options.session?.() ?? null;
    if (currentSession !== session) { bindSession(currentSession); return { data: null, status: 409,
      error: { status: 409, message: 'Сессия изменилась. Откройте запись заново.' } }; }
    const result = await send();
    const afterSession = options.session?.() ?? null;
    if (afterSession !== session) { bindSession(afterSession); return { data: null, status: 409,
      error: { status: 409, message: 'Сессия изменилась. Откройте запись заново.' } }; }
    if (result.error) return result;
    const row = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : null;
    if (row?.bookingId !== bookingId) return { data: null, status: 502,
      error: { status: 502, message: 'Ответ отмены не совпал с записью' } };
    if (row.state === 'NOT_MANAGED' && attempt === 0 && result.status === 200) return result;
    if (row.state === 'RELEASED' && result.status === 200 && typeof row.operationId === 'string' && row.operationId) {
      const proof: VerifiedCancellation = { ok: true, state: 'RELEASED', bookingId, operationId: row.operationId };
      if (session) verified.set(bookingId, proof);
      if (verified.size > 100) verified.delete(verified.keys().next().value!);
      return { data: proof, error: null, status: 200 };
    }
    if (row.state !== 'PENDING_CONFIRMATION' || row.accepted !== true || result.status !== 202) return { data: null, status: 502,
      error: { status: 502, message: 'Не удалось подтвердить возврат посещения' } };
    if (attempt + 1 < attempts) await wait();
  }
  return { data: null, status: 202, error: { status: 202,
    message: 'Запрос отмены принят. Возврат посещения проверяется автоматически; повторная отмена не требуется.' } };
}
