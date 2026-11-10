import { parseZeroAttempt } from './zeroCheckoutCustody';
import { legacyZeroOffersForProduct } from './zeroCheckoutProducts';
import { apiConfirmTournamentSubscriptionPurchase } from '../../utils/apiClient';
import { readAuthToken } from '../../utils/authTokenStorage';
import { readSubscriptionPromoTransactionPaid } from '../../utils/subscriptionPromoCode';

const ATTEMPT_PREFIX = 'padlhub_subscription_code_attempt_v1:';
export const SUBSCRIPTION_PROMO_PENDING_MESSAGE = 'Покупка уже отправлена. Проверьте личный кабинет или обратитесь в поддержку перед повторной оплатой.';

export async function subscriptionPromoAttemptKey(productId: string, phone: string): Promise<string> {
  // Persist an opaque account/product digest, never the phone, token or code.
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${productId}\n${phone.replace(/\D/g, '')}`));
  return ATTEMPT_PREFIX + Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hasSubscriptionPromoAttempt(productId: string, phone: string): Promise<boolean> {
  try {
    const actor = readAuthToken();
    const key = await subscriptionPromoAttemptKey(productId, phone);
    const raw = window.localStorage.getItem(key);
    let record: Record<string, unknown> | null = null;
    if (raw !== null) { try { record = JSON.parse(raw); } catch { return true; } }
    const represented: { key: string; raw: string }[] = [];
    for (const offer of legacyZeroOffersForProduct(productId)) {
      const zeroKey = 'padlhub_zero_checkout_attempt_v1:' + offer;
      const zeroRaw = window.localStorage.getItem(zeroKey);
      if (zeroRaw === null) continue;
      const zero = parseZeroAttempt(zeroRaw, offer);
      if (!zero) return true;
      if (zero.state === 'paid') continue;
      if (zero?.state !== 'pending' || record?.kind !== 'ordinary'
        || !(typeof record.paymentRef === 'string' && record.paymentRef === zero.paymentRef
          || typeof record.transactionId === 'string' && record.transactionId === zero.transactionId)) return true;
      represented.push({ key: zeroKey, raw: zeroRaw });
    }
    if (raw === null) return false;
    async function releaseProvenPaid(): Promise<boolean> {
      for (const zero of represented) {
        if (!navigator.locks) return false;
        const updated = await navigator.locks.request(zero.key, { ifAvailable: true }, lock => {
          if (!lock || readAuthToken() !== actor || window.localStorage.getItem(zero.key) !== zero.raw) return false;
          window.localStorage.setItem(zero.key, JSON.stringify({ ...JSON.parse(zero.raw), state: 'paid' }));
          return true;
        });
        if (!updated) return false;
      }
      if (readAuthToken() !== actor || window.localStorage.getItem(key) !== raw) return false;
      window.localStorage.removeItem(key); return true;
    }
    let transactionId: unknown;
    try {
      const record = JSON.parse(raw);
      transactionId = record?.transactionId;
      if (record?.kind === 'ordinary' && (record.paid === true || record.counterKey && record.paymentRef)) {
        const response = record.paid === true ? null : await apiConfirmTournamentSubscriptionPurchase(record.paymentRef, { counterKey: record.counterKey, planType: record.annual ? null : 'friendship' });
        if ((record.paid === true || !response?.error && response?.data?.paid === true && response.data.status === 'PAID' && !response.data.failed) && readAuthToken() === actor) {
          return !await releaseProvenPaid();
        }
      }
    } catch { return true; }
    if (typeof transactionId === 'string' && transactionId.trim() && await readSubscriptionPromoTransactionPaid(transactionId) && readAuthToken() === actor) {
      // A completed prior purchase no longer blocks a later renewal.
      return !await releaseProvenPaid();
    }
    return true;
  } catch { return true; }
}

/** Ordinary and promo CTAs share the same check/write lock across browser tabs. */
export async function withSubscriptionPromoLock<T>(productId: string, phone: string, create: () => Promise<T>, requireLock = false): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks || typeof crypto === 'undefined' || !crypto.subtle) {
    if (requireLock) throw new Error('Откройте страницу в актуальном Safari или Chrome по HTTPS.');
    if (await hasSubscriptionPromoAttempt(productId, phone)) throw new Error(SUBSCRIPTION_PROMO_PENDING_MESSAGE);
    return create();
  }
  const key = await subscriptionPromoAttemptKey(productId, phone);
  return navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock || await hasSubscriptionPromoAttempt(productId, phone)) throw new Error(SUBSCRIPTION_PROMO_PENDING_MESSAGE);
    return create();
  });
}


/** Called while holding the shared product/phone lock, before the ordinary POST. */
export async function recordOrdinarySubscriptionAttempt(productId: string, phone: string, evidence: { transactionId?: string; paymentRef?: string; counterKey?: string; annual?: boolean; paid?: boolean } = {}): Promise<void> {
  const key = await subscriptionPromoAttemptKey(productId, phone);
  const raw = JSON.stringify({ kind: 'ordinary', ...evidence });
  window.localStorage.setItem(key, raw);
  if (window.localStorage.getItem(key) !== raw) throw new Error('Не удалось сохранить попытку оплаты.');
}
