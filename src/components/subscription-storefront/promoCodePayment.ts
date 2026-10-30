import { apiBuySubscroption, apiCreateTournamentSubscriptionPurchase } from '../../utils/apiClient';
import { previewSubscriptionPromoCode, type SubscriptionPromoQuote } from '../../utils/subscriptionPromoCode';
import { StorefrontPaymentError, buildStorefrontPaymentRef, upsertPendingPaymentEntry } from './payment';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';

import { subscriptionPromoAttemptKey, withSubscriptionPromoLock, SUBSCRIPTION_PROMO_PENDING_MESSAGE } from './promoCodeAttempt';

export async function createSubscriptionPromoPayment(quote: SubscriptionPromoQuote, phone: string, canProceed: () => boolean, counterKey?: 'friendship') {
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
    const paymentRef = counterKey ? buildStorefrontPaymentRef(counterKey) : null;
    if (paymentRef) query.set('summerPaymentRef', paymentRef);
    else query.set('subscriptionPromoReturn', '1');
    returnPage.search = query.toString();
    returnPage.hash = '';
    const returnUrl = appendCurrentAuthModeToNavigableUrl(returnPage).toString();
    try { window.localStorage.setItem(key, '{}'); if (window.localStorage.getItem(key) !== '{}') throw new Error(); }
    catch { throw new StorefrontPaymentError('Разрешите сохранение данных сайта, чтобы продолжить оформление.'); }
    let rejectedBeforeCreate = false;
    try {
      if (counterKey && paymentRef) {
        const result = await apiCreateTournamentSubscriptionPurchase({
          clientPhone: phone, counterKey, planType: 'friendship', productId: quote.productId,
          paymentRef, promoCode: quote.promoCode, expectedPromoQuote: quote,
          baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl,
        });
        const raw = result.error?.raw;
        const receipt = raw && typeof raw === 'object' && 'promoAttempt' in raw ? raw.promoAttempt : null;
        if (result.error && receipt && typeof receipt === 'object' && 'schemaVersion' in receipt
          && receipt.schemaVersion === 1 && 'providerAttempted' in receipt && receipt.providerAttempted === false
          && 'paymentRef' in receipt && receipt.paymentRef === paymentRef) {
          window.localStorage.removeItem(key);
          rejectedBeforeCreate = true;
          throw new StorefrontPaymentError(result.error.message);
        }
        if (result.error || !result.data || result.data.productId !== quote.productId
          || result.data.toPayMinor !== quote.toPayMinor || !result.data.transactionId
          || !result.data.paymentUrl) throw new Error();
        const url = new URL(result.data.paymentUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
        window.localStorage.setItem(key, JSON.stringify({ transactionId: result.data.transactionId }));
        upsertPendingPaymentEntry({ counterKey, planId: 'monthly', paymentRef: result.data.paymentRef || paymentRef,
          campaignKey: result.data.campaignKey, createdAt: new Date().toISOString() });
        return { status: 'redirect' as const, paymentUrl: url.toString() };
      }
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
    } catch (failure) {
      if (rejectedBeforeCreate) throw failure;
      // A failed or malformed create may already have succeeded at Viva.
      throw new StorefrontPaymentError(SUBSCRIPTION_PROMO_PENDING_MESSAGE);
    }
  }, true);
}
