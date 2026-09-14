import { apiBuySubscroption } from '../../utils/apiClient';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';
import { StorefrontPaymentError } from './payment';
import { buildPromoReturnUrl, resolveStorefrontPromo } from './promo';

const ATTEMPT_PREFIX = 'padlhub_storefront_promo_attempt_v1:';
export const PROMO_PENDING_MESSAGE = 'Покупка уже отправлена. Проверьте абонементы в личном кабинете. Если результат неясен, обратитесь в поддержку перед повторной оплатой.';

/** No phone, token or provider payment URL is persisted. Never expire an ambiguous create. */
export function hasPromoPaymentAttempt(offerKey: string): boolean {
  try { return window.localStorage.getItem(`${ATTEMPT_PREFIX}${offerKey}`) !== null; }
  catch { return true; }
}

export async function createStorefrontPromoPayment(offerKey: string, phone: string): Promise<
  { status: 'redirect'; paymentUrl: string } | { status: 'settled'; message: string }
> {
  const offer = resolveStorefrontPromo(offerKey);
  if (!offer || !phone.trim()) throw new StorefrontPaymentError('Не удалось определить акционное предложение или профиль.');
  if (!navigator.locks) {
    throw new StorefrontPaymentError('Этот браузер не поддерживает безопасное оформление. Откройте ссылку в актуальном Safari или Chrome.');
  }
  // A browser-wide lock prevents two tabs from crossing the check/write boundary.
  return navigator.locks.request(`${ATTEMPT_PREFIX}${offer.key}`, { ifAvailable: true }, async lock => {
    if (!lock || hasPromoPaymentAttempt(offer.key)) throw new StorefrontPaymentError(PROMO_PENDING_MESSAGE);
    const returnUrl = appendCurrentAuthModeToNavigableUrl(new URL(buildPromoReturnUrl(window.location.href))).toString();
    try {
      window.localStorage.setItem(`${ATTEMPT_PREFIX}${offer.key}`, 'pending');
      if (!hasPromoPaymentAttempt(offer.key)) throw new Error('Attempt was not saved');
    } catch {
      throw new StorefrontPaymentError('Разрешите сохранение данных сайта в браузере, чтобы продолжить оформление.');
    }

    // This API has no idempotency/confirm contract. Once sent, any uncertainty
    // retains the browser marker; neither reload nor bank return retries create.
    try {
      const result = await apiBuySubscroption(offer.productId, phone, {
        baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl, retries: 0,
      });
      if (result.error || !result.data) throw new Error('Purchase outcome unavailable');
      const { paymentUrl, paid, toPay } = result.data;
      if (typeof paymentUrl === 'string' && paymentUrl.trim()) {
        const url = new URL(paymentUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid payment URL');
        return { status: 'redirect', paymentUrl: url.toString() };
      }
      if ((paid === true && !(typeof toPay === 'number' && toPay > 0))
        || (paid !== false && typeof toPay === 'number' && Number.isFinite(toPay) && toPay === 0)) {
        // Keep a terminal marker too: a reload must not accidentally repeat a purchase.
        window.localStorage.setItem(`${ATTEMPT_PREFIX}${offer.key}`, 'settled');
        return { status: 'settled', message: 'Оплата подтверждена. Проверьте абонемент в личном кабинете.' };
      }
      throw new Error('Purchase outcome unavailable');
    } catch {
      throw new StorefrontPaymentError('Не удалось подтвердить результат оплаты. Проверьте личный кабинет или обратитесь в поддержку перед повторной оплатой.');
    }
  });
}
