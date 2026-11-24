import { request, getServ2Origin } from '../../utils/apiClient';
import { TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS } from '../../utils/tournamentSubscriptionCatalog';
import { FRIENDSHIP_TWO_HOURS_PRODUCT_ID } from './catalog';
import { checkoutSessionToken } from './zeroCheckoutSession';

export function isDirectRecoveryProduct(productId: string | null | undefined): productId is string {
  return productId === FRIENDSHIP_TWO_HOURS_PRODUCT_ID || productId === TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.ra;
}
const uuid = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(x);
export function isFreshDirectClosure(payload: unknown, productId: string, transactionId: string, version: 1 | 2 = 1): boolean {
  if (!isDirectRecoveryProduct(productId) || !uuid(transactionId) || !payload || typeof payload !== 'object') return false;
  const body = payload as Record<string, unknown>, proof = body.directCheckoutClosure as Record<string, unknown> | null;
  if (body.ok !== true || !proof || Array.isArray(proof) || proof.version !== version || version === 2 && productId !== TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.ra || proof.productId !== productId
    || proof.transactionId !== transactionId || proof.state !== 'PROVIDER_CARD_EXPIRED_UNPAID'
    || proof.closed !== true || proof.paid !== false || (version === 1 ? !uuid(proof.operationId) : proof.operationId !== undefined)
    || typeof proof.verifiedAt !== 'string') return false;
  const observed = Date.parse(proof.verifiedAt), age = Date.now() - observed;
  return /Z$/.test(proof.verifiedAt) && Number.isFinite(observed) && age >= -5000 && age <= 30000;
}

/** The backend rechecks current owner, card fingerprint and money; this POST only reads. */
export async function readClosedDirectCheckout(productId: string, transactionId: string, canProceed: () => boolean): Promise<boolean> {
  const token = checkoutSessionToken();
  const current = () => !!token && checkoutSessionToken() === token && canProceed();
  if (!isDirectRecoveryProduct(productId) || !uuid(transactionId) || !current()) return false;
  const version = productId === TOURNAMENT_SUBSCRIPTION_DIRECT_PRODUCT_IDS.ra ? 2 : 1;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 16000);
  const read = (requestVersion: 1 | 2) => request<unknown>('/lk/tournaments/summer-subscription/confirm', {
    method: 'POST', baseUrl: getServ2Origin() || '', auth: false, headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ directCheckoutRecoveryVersion: requestVersion, transactionId }),
    retries: 0, dedupe: false, cache: 'no-store', cacheTtlMs: 0, signal: controller.signal,
  });
  try {
    const result = await read(version);
    if (!current()) return false;
    const raw = result.error?.raw;
    // An installed v1 backend explicitly rejects the new version before it
    // reads Viva. Only that response allows the exact frozen-proof lookup.
    if (version === 2 && result.status === 400 && raw && typeof raw === 'object'
      && 'code' in raw && raw.code === 'INVALID_CHECKOUT_RECOVERY') {
      const legacy = await read(1);
      return current() && !legacy.error && legacy.status === 200 && isFreshDirectClosure(legacy.data, productId, transactionId, 1);
    }
    return !result.error && result.status === 200 && isFreshDirectClosure(result.data, productId, transactionId, version);
  } finally { clearTimeout(timer); }
}
