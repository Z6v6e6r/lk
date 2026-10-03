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
    if (!Object.keys(window.localStorage).some(key => key.startsWith(ATTEMPT_PREFIX))) return false;
    const key = await subscriptionPromoAttemptKey(productId, phone);
    const raw = window.localStorage.getItem(key);
    if (raw === null) return false;
    let transactionId: unknown;
    try { transactionId = JSON.parse(raw)?.transactionId; } catch { return true; }
    if (typeof transactionId === 'string' && transactionId.trim() && await readSubscriptionPromoTransactionPaid(transactionId) && readAuthToken() === actor) {
      // A completed prior purchase no longer blocks a later renewal.
      window.localStorage.removeItem(key);
      return false;
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
