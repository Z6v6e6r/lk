import { apiBuySubscroption, apiConfirmTournamentSubscriptionPurchase, apiCreateTournamentSubscriptionPurchase, request, getServ2Origin } from '../../utils/apiClient';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';
import { resolveStorefrontBillingTarget, StorefrontPaymentError } from './payment';
import { createStorefrontPromoPayment, hasPromoPaymentAttempt } from './promoPayment';
import { resolveStorefrontPromo } from './promo';
import { ATLANTY_MONTHLY_PRICE_MINOR } from './catalog';

export const ZERO_CHECKOUT_RETURN = 'phCheckoutReturn';
const ATTEMPT_PREFIX = 'padlhub_zero_checkout_attempt_v1:';
export const ZERO_PENDING_MESSAGE = 'Покупка уже отправлена. Проверьте результат в личном кабинете. Если результат неясен, обратитесь в поддержку перед повторной оплатой.';

/** Strict opt-in parser: legacy status clients keep their existing compatibility defaults. */
export function parseZeroPrice(payload: unknown, counterKey: string): number {
  let data = payload;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.ok === false) throw new Error('Status unavailable');
    data = record.data ?? data;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    if (record.ok === false) throw new Error('Status unavailable');
    data = record.plans ?? record.statuses ?? [data];
  }
  const matches = (Array.isArray(data) ? data : []).filter(row => row && row.counterKey === counterKey);
  if (matches.length !== 1) throw new Error('Counter mismatch');
  const row = matches[0];
  if (!Number.isSafeInteger(row.priceMinor) || row.priceMinor <= 0 || row.canPurchase !== true || row.bindingReady !== true
    || typeof row.unlimited !== 'boolean'
    || (!row.unlimited && (!Number.isSafeInteger(row.remainingCount) || row.remainingCount <= 0
      || !Number.isSafeInteger(row.totalLimit) || row.totalLimit < row.remainingCount))) throw new Error('Incomplete or unavailable status');
  return row.priceMinor;
}

export async function withZeroDeadline<T>(operation: Promise<T>, timeoutMs = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new StorefrontPaymentError('Время ожидания истекло. Если покупка отправлена, проверьте её статус перед новой попыткой.')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** One resolved Zero Block offer. `staticPriceMinor` marks an offer with no LK counter. */
export interface ZeroOffer {
  key: string;
  label: string;
  period: string;
  planId: string;
  billingOptionId: 'monthly' | 'annual';
  target: ReturnType<typeof resolveStorefrontBillingTarget> | null;
  promo: ReturnType<typeof resolveStorefrontPromo> | null;
  /** Catalogue price for direct products the status API does not know about. */
  staticPriceMinor?: number;
}

export function resolveZeroOffer(key: string): ZeroOffer | null {
  const promo = resolveStorefrontPromo(key);
  if (promo) return { key, label: `${promo.planKey === 'friendship' ? 'Дружба' : promo.planKey === 'academy' ? 'Академия' : 'РА'} · Питер`,
    period: '30 дней', promo, planId: promo.planKey, billingOptionId: 'monthly', target: null };
  // The club subscription is a direct product without a counter: its price is the
  // catalogue price, so it must never be looked up through the status API.
  if (key === 'atlanty') return { key, label: 'ДРУЖБА.АТЛАНТЫ', period: '30 дней', planId: 'atlanty',
    billingOptionId: 'monthly', target: resolveStorefrontBillingTarget('atlanty', 'monthly'), promo: null,
    staticPriceMinor: ATLANTY_MONTHLY_PRICE_MINOR };
  const labels: Record<string, string> = { friendship: 'Дружба', 'friendship-year': 'Дружба', academy: 'Академия', ra: 'РА', energy5: 'Энергия 5' };
  if (!Object.prototype.hasOwnProperty.call(labels, key)) return null;
  const planId = key === 'friendship-year' ? 'friendship' : key;
  const billingOptionId = key === 'friendship-year' ? 'annual' as const : 'monthly' as const;
  return { key, label: labels[key], period: key === 'friendship-year' ? 'год' : key === 'energy5' ? '60 дней, 5 занятий' : '30 дней',
    planId, billingOptionId, target: resolveStorefrontBillingTarget(planId, billingOptionId), promo: null };
}

export async function loadZeroOfferPrice(key: string, signal?: AbortSignal): Promise<number> {
  const offer = resolveZeroOffer(key);
  if (!offer) throw new StorefrontPaymentError('Предложение не найдено.');
  if (offer.promo) return offer.promo.priceMinor;
  if (typeof offer.staticPriceMinor === 'number') {
    if (!Number.isSafeInteger(offer.staticPriceMinor) || offer.staticPriceMinor <= 0) throw new StorefrontPaymentError('Предложение недоступно.');
    return offer.staticPriceMinor;
  }
  if (!offer.target) throw new StorefrontPaymentError('Предложение недоступно.');
  const result = await request<unknown>('/lk/tournaments/summer-subscription/status?counterKey=' + encodeURIComponent(offer.target.counterKey),
    { method: 'GET', baseUrl: getServ2Origin() || '', signal, retries: 0 });
  try {
    if (result.error) throw new Error('Status unavailable');
    return parseZeroPrice(result.data, offer.target.counterKey);
  } catch { throw new StorefrontPaymentError('Не удалось подтвердить доступность подписки. Обновите данные или попробуйте позже.'); }
}

type Attempt = { key: string; paymentRef: string; state: 'pending' | 'paid' | 'failed' };

function saveAttempt(attempt: Attempt) {
  const value = JSON.stringify(attempt);
  window.localStorage.setItem(ATTEMPT_PREFIX + attempt.key, value);
  if (window.localStorage.getItem(ATTEMPT_PREFIX + attempt.key) !== value) throw new Error('Storage unavailable');
}

export function hasZeroAttempt(key: string): boolean {
  try { return window.localStorage.getItem(ATTEMPT_PREFIX + key) !== null
    || (Boolean(resolveZeroOffer(key)?.promo) && hasPromoPaymentAttempt(key)); }
  catch { return true; }
}

function readAttempt(key: string): Attempt | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ATTEMPT_PREFIX + key) || 'null');
    if (!value || typeof value !== 'object') return null;
    const row = value as Attempt;
    if (row.key !== key || typeof row.paymentRef !== 'string' || !/^zero-[a-z0-9-]{36}$/.test(row.paymentRef)
      || !['pending', 'paid', 'failed'].includes(row.state)) return null;
    return row;
  } catch { return null; }
}

export function buildZeroReturnUrl(key: string): string {
  const url = new URL(window.location.href);
  // Never echo an OAuth code, tokens or another payment's return parameters to the bank.
  const query = new URLSearchParams();
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = url.searchParams.get(name);
    if (value && value.length <= 500) query.set(name, value);
  }
  query.set(ZERO_CHECKOUT_RETURN, key);
  url.search = query.toString();
  url.hash = '';
  return appendCurrentAuthModeToNavigableUrl(url).toString();
}

function bankUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid payment URL');
  return url.toString();
}

/** All creates happen only after an explicit authenticated confirmation in the dialog.
 * Durable markers contain no phone, access token or bank URL and never expire on ambiguity.
 */
export async function createZeroPayment(key: string, phone: string, expectedPrice: number, canProceed: () => boolean) {
  const offer = resolveZeroOffer(key);
  if (!offer || !phone.trim() || !Number.isSafeInteger(expectedPrice) || expectedPrice <= 0) throw new StorefrontPaymentError('Проверьте предложение и профиль.');
  if (!navigator.locks || !window.crypto?.randomUUID) throw new StorefrontPaymentError('Для оформления откройте страницу в актуальном Safari или Chrome по HTTPS.');
  return navigator.locks.request(ATTEMPT_PREFIX + key, { ifAvailable: true }, async lock => {
    if (!lock || hasZeroAttempt(key)) throw new StorefrontPaymentError(ZERO_PENDING_MESSAGE);
    const price = await loadZeroOfferPrice(key);
    if (!canProceed()) throw new StorefrontPaymentError('Оформление закрыто.');
    if (price !== expectedPrice) throw new StorefrontPaymentError('Цена изменилась. Обновите данные и подтвердите новую цену.');
    const attempt: Attempt = { key, paymentRef: `zero-${window.crypto.randomUUID()}`, state: 'pending' };
    const returnUrl = buildZeroReturnUrl(key);
    try { saveAttempt(attempt); }
    catch { throw new StorefrontPaymentError('Разрешите сохранение данных сайта, чтобы продолжить оформление.'); }
    try {
      if (offer.promo) {
        // Share the existing promo lock/marker with sub_hab. Only return URL differs.
        return await createStorefrontPromoPayment(key, phone, returnUrl);
      }
      const target = offer.target!;
      if (target.directProductId) {
        const result = await apiBuySubscroption(target.directProductId, phone, {
          baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl, retries: 0,
        });
        if (result.error || !result.data) throw new Error('Unknown result');
        const { paymentUrl, paid, toPay } = result.data;
        if (paymentUrl) return { status: 'redirect' as const, paymentUrl: bankUrl(paymentUrl) };
        if (paid === true && (toPay == null || toPay === 0)) {
          saveAttempt({ ...attempt, state: 'paid' });
          return { status: 'settled' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
        }
        throw new Error('Unknown result');
      }
      const result = await apiCreateTournamentSubscriptionPurchase({
        clientPhone: phone, counterKey: target.counterKey, planType: target.planType,
        paymentRef: attempt.paymentRef, baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl,
      });
      if (result.error || !result.data || (result.data.paymentRef && result.data.paymentRef !== attempt.paymentRef)) throw new Error('Unknown result');
      if (result.data.paymentUrl) return { status: 'redirect' as const, paymentUrl: bankUrl(result.data.paymentUrl) };
      // Missing price/URL is never payment evidence. Confirm the already stored ref.
      const confirmed = await confirmZeroPayment(key);
      return { status: 'settled' as const, message: confirmed.message };
    } catch {
      throw new StorefrontPaymentError('Не удалось подтвердить результат покупки. Не повторяйте оплату: проверьте статус или обратитесь в поддержку.');
    }
  });
}

export async function confirmZeroPayment(key: string) {
  const offer = resolveZeroOffer(key);
  const attempt = readAttempt(key);
  if (!offer || !attempt || !offer.target || offer.target.directProductId) {
    return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
  }
  if (attempt.state !== 'pending') return { status: attempt.state,
    message: attempt.state === 'paid' ? 'Оплата подтверждена. Подписка оформлена.' : 'Оплата не прошла. Обратитесь в поддержку перед новой попыткой.' };
  const result = await apiConfirmTournamentSubscriptionPurchase(attempt.paymentRef, {
    counterKey: offer.target.counterKey, planType: offer.billingOptionId === 'annual' ? null : 'friendship',
  });
  if (!result.error && result.data?.paid === true && result.data.status === 'PAID' && !result.data.failed) {
    saveAttempt({ ...attempt, state: 'paid' });
    return { status: 'paid' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
  }
  // FAILED can be a locally archived, uncertain payment. Never release its guard.
  return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
}
