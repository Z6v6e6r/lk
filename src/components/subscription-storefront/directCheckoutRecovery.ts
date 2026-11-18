import { request, getServ2Origin } from '../../utils/apiClient';
import { checkoutSessionToken } from './zeroCheckoutSession';

export const DIRECT_RECOVERY_PRODUCT = '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e';
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
export function isFreshDirectClosure(payload: unknown, productId: string, transactionId: string): boolean {
  if (productId !== DIRECT_RECOVERY_PRODUCT || !uuid(transactionId) || !payload || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>, proof = body.directCheckoutClosure as Record<string, unknown> | null;
  if (body.ok !== true || !proof || Array.isArray(proof) || proof.version !== 1 || proof.productId !== productId
    || proof.transactionId !== transactionId || proof.state !== 'PROVIDER_CARD_EXPIRED_UNPAID'
    || proof.closed !== true || proof.paid !== false || !uuid(proof.operationId) || typeof proof.verifiedAt !== 'string') return false;
  const observed = Date.parse(proof.verifiedAt), age = Date.now() - observed;
  return /Z$/.test(proof.verifiedAt) && Number.isFinite(observed) && age >= -5000 && age <= 30000;
}

/** The backend rechecks current owner, card fingerprint and money; this POST only reads. */
export async function readClosedDirectCheckout(productId: string, transactionId: string, canProceed: () => boolean): Promise<boolean> {
  const token = checkoutSessionToken();
  const current = () => !!token && checkoutSessionToken() === token && canProceed();
  if (productId !== DIRECT_RECOVERY_PRODUCT || !uuid(transactionId) || !current()) return false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 16000);
  try {
    const result = await request<unknown>('/lk/tournaments/summer-subscription/confirm', {
      method: 'POST', baseUrl: getServ2Origin() || '', auth: false, headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ directCheckoutRecoveryVersion: 1, transactionId }),
      retries: 0, dedupe: false, cache: 'no-store', cacheTtlMs: 0, signal: controller.signal,
    });
    return current() && !result.error && result.status === 200 && isFreshDirectClosure(result.data, productId, transactionId);
  } finally { clearTimeout(timer); }
}
