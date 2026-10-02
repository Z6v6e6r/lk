import { apiBuySubscroption } from '../../utils/apiClient';
import { previewSubscriptionPromoCode, type SubscriptionPromoQuote } from '../../utils/subscriptionPromoCode';
import { StorefrontPaymentError } from './payment';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';

import { subscriptionPromoAttemptKey, withSubscriptionPromoLock, SUBSCRIPTION_PROMO_PENDING_MESSAGE } from './promoCodeAttempt';

export async function createSubscriptionPromoPayment(quote: SubscriptionPromoQuote, phone: string, canProceed: () => boolean) {
  return withSubscriptionPromoLock(quote.productId, phone, async () => {
    const key = await subscriptionPromoAttemptKey(quote.productId, phone);
    // Reprice before any write; the visitor must approve a changed quote again.
    const fresh = await previewSubscriptionPromoCode(quote.productId, phone, quote.promoCode);
    if (!canProceed()) throw new StorefrontPaymentError('Профиль или промокод изменился. Примените промокод снова.');
    if (fresh.sumMinor !== quote.sumMinor || fresh.discountMinor !== quote.discountMinor || fresh.toPayMinor !== quote.toPayMinor)
      throw new StorefrontPaymentError('Стоимость изменилась. Примените промокод снова и подтвердите новую цену.');
    const returnPage = new URL(window.location.href);
    const query = new URLSearchParams();
    for (const name of ['variant', 'plans']) {
      const value = returnPage.searchParams.get(name);
      if (value) query.set(name, value);
    }
    query.set('subscriptionPromoReturn', '1');
    returnPage.search = query.toString();
    returnPage.hash = '';
    const returnUrl = appendCurrentAuthModeToNavigableUrl(returnPage).toString();
    try { window.localStorage.setItem(key, '{}'); if (window.localStorage.getItem(key) !== '{}') throw new Error(); }
    catch { throw new StorefrontPaymentError('Разрешите сохранение данных сайта, чтобы продолжить оформление.'); }
    try {
      const result = await apiBuySubscroption(quote.productId, phone, {
        promoCode: quote.promoCode, retries: 0,
        baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl,
      });
      if (result.error || !result.data || result.data.toPay !== quote.toPayMinor) throw new Error();
      if (result.data.paymentUrl) {
        const ids = [result.data.id, result.data.transactionId].filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
        if (ids.some(id => id !== ids[0])) throw new Error();
        if (ids[0]) window.localStorage.setItem(key, JSON.stringify({ transactionId: ids[0] }));
        const url = new URL(result.data.paymentUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
        return { status: 'redirect' as const, paymentUrl: url.toString() };
      }
      if (result.data.paid === true && result.data.toPay === 0) {
        window.localStorage.removeItem(key);
        return { status: 'settled' as const };
      }
      throw new Error();
    } catch {
      // A failed or malformed create may already have succeeded at Viva.
      throw new StorefrontPaymentError(SUBSCRIPTION_PROMO_PENDING_MESSAGE);
    }
  }, true);
}
