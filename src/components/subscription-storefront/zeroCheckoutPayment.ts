import { parseZeroAttempt, type ZeroPaymentAttempt as Attempt } from './zeroCheckoutCustody';
import { withSubscriptionPromoLock, recordOrdinarySubscriptionAttempt } from './promoCodeAttempt';
import { readSubscriptionPromoTransactionPaid } from '../../utils/subscriptionPromoCode';
import { apiBuySubscroption, apiConfirmTournamentSubscriptionPurchase, apiCreateTournamentSubscriptionPurchase, request, getServ2Origin } from '../../utils/apiClient';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';
import { API_BASE, TENANT_KEY } from '../../consts/api_config';
import { resolveStorefrontBillingTarget, resolveStorefrontPromoTarget, StorefrontPaymentError } from './payment';
import { createStorefrontPromoPayment, hasPromoPaymentAttempt } from './promoPayment';
import { resolveStorefrontPromo } from './promo';
import { ATLANTY_ANNUAL_PRICE_MINOR, ATLANTY_MONTHLY_PRICE_MINOR, PATRIOTS_MONTHLY_PRICE_MINOR, PATRIOTS_PLAN_ID, PATRIOTS_PRODUCT_ID, TOPOCRATY_MONTHLY_PRICE_MINOR, TOPOCRATY_PLAN_ID, VSK_PRODUCT_ID } from './catalog';

export const ZERO_CHECKOUT_RETURN = 'phCheckoutReturn';
const ATTEMPT_PREFIX = 'padlhub_zero_checkout_attempt_v1:';
export const ZERO_PENDING_MESSAGE = 'Покупка уже отправлена. Проверьте результат в личном кабинете. Если результат неясен, обратитесь в поддержку перед повторной оплатой.';

/** Strict opt-in parser: legacy status clients keep their existing compatibility defaults. */
export function parseZeroPrice(payload: unknown, counterKey: string, productId?: string): number {
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
  if ((productId && row.productId !== productId) || !Number.isSafeInteger(row.priceMinor) || row.priceMinor <= 0 || row.canPurchase !== true || row.bindingReady !== true
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
  billingOptionId: 'monthly' | 'annual' | 'monthly-two-hours';
  target: ReturnType<typeof resolveStorefrontBillingTarget> | null;
  promo: ReturnType<typeof resolveStorefrontPromo> | null;
  /** Catalogue price for direct products the status API does not know about. */
  staticPriceMinor?: number;
  /** Exact opt-in direct product; quote is read from the public Viva resource. */
  liveProductId?: string;
}

const liveProductIds: Record<string, string> = {
  vsk: VSK_PRODUCT_ID,
  residency: '4037a3a3-e551-4f9a-a9db-1410e46b8635',
  'friendship-two-hours': '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e',
};

export interface ZeroOfferQuote { priceMinor: number; activationDays?: number }

/** Public subscription resources omit admin-only productType/showToUser fields.
 * This proves exact product terms, not catalogue visibility or resident benefits.
 */
export function parseZeroLiveProductQuote(payload: unknown, key: string): ZeroOfferQuote {
  if (!Object.prototype.hasOwnProperty.call(liveProductIds, key)
    || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Product unavailable');
  const product = payload as Record<string, unknown>;
  if (product.id !== liveProductIds[key] || !Number.isSafeInteger(product.cost) || Number(product.cost) <= 0
    || product.validityDays !== 30 || product.visits !== 30
    || !Number.isSafeInteger(product.activationDays) || Number(product.activationDays) < 0
    || product.type !== 'GROUP' || product.variant !== 'BY_VISITS' || product.appliesTo !== 'BOOKING'
    || ('showToUser' in product && product.showToUser !== true)
    || ('productType' in product && product.productType !== 'SUBSCRIPTION')) throw new Error('Product terms mismatch');
  const priceMinor = product.discountPrice ?? product.cost;
  if (!Number.isSafeInteger(priceMinor) || Number(priceMinor) <= 0 || Number(priceMinor) > Number(product.cost)) {
    throw new Error('Invalid product price');
  }
  function scope(limited: unknown, value: unknown, required: readonly number[]) {
    if (limited === false) return true;
    if (limited !== true || !Array.isArray(value)) return false;
    const ids = value.map(row => row && typeof row === 'object' ? row.id : row);
    return ids.every(id => Number.isSafeInteger(id)) && required.every(id => ids.includes(id));
  }
  if (key === 'vsk') {
    const ids = (value: unknown) => Array.isArray(value) ? value.map(row => row && typeof row === 'object' ? row.id : row).sort((a, b) => a - b) : [];
    if (product.hasStudioLimitation !== false || product.hasDirectionLimitation !== true || product.hasTypeLimitation !== true
      || JSON.stringify(ids(product.availableDirections)) !== JSON.stringify([4588, 6975])
      || JSON.stringify(ids(product.availableTypes)) !== JSON.stringify([1613, 2349])
      || product.hasDayLimitation !== false || product.hasTimeRangeLimitation !== false || product.hasDayTimeLimitation !== false) {
      throw new Error('VSK product coverage mismatch');
    }
  } else if (key === 'friendship-two-hours') {
    if (!scope(product.hasDirectionLimitation, product.availableDirections, [4588, 5278])
      || !scope(product.hasTypeLimitation, product.availableTypes, [1613, 839])) throw new Error('Product coverage mismatch');
  } else if (product.activationDays !== 0 || product.hasStudioLimitation !== false || product.hasDirectionLimitation !== false
    || product.hasTypeLimitation !== true || !Array.isArray(product.availableTypes)
    || product.availableTypes.length !== 1 || product.availableTypes[0]?.id !== 2572) {
    throw new Error('Residency product coverage mismatch');
  }
  return { priceMinor: Number(priceMinor), activationDays: Number(product.activationDays) };
}

export function resolveZeroOffer(key: string): ZeroOffer | null {
  if (Object.prototype.hasOwnProperty.call(liveProductIds, key)) return {
    key, label: key === 'vsk' ? 'Дружба.ВСК' : key === 'residency' ? 'Резидентство ПадлхАБ' : 'Дружба 2.0', period: '30 дней',
    planId: key === 'vsk' || key === 'residency' ? key : 'friendship',
    billingOptionId: key === 'vsk' || key === 'residency' ? 'monthly' : 'monthly-two-hours',
    target: null, promo: null, liveProductId: liveProductIds[key],
  };
  const promo = resolveStorefrontPromo(key);
  if (promo) return { key, label: `${promo.planKey === 'friendship' ? 'Дружба' : promo.planKey === 'academy' ? 'Академия' : 'РА'} · Питер`,
    period: '30 дней', promo, planId: promo.planKey, billingOptionId: 'monthly', target: null };
  // The club subscription is a direct product without a counter: its price is the
  // catalogue price, so it must never be looked up through the status API.
  if (key === 'atlanty' || key === 'atlanty-year') return { key, label: 'ДРУЖБА.АТЛАНТЫ', period: key === 'atlanty-year' ? 'год' : '30 дней', planId: 'atlanty',
    billingOptionId: key === 'atlanty-year' ? 'annual' : 'monthly', target: resolveStorefrontBillingTarget('atlanty', key === 'atlanty-year' ? 'annual' : 'monthly'), promo: null,
    staticPriceMinor: key === 'atlanty-year' ? ATLANTY_ANNUAL_PRICE_MINOR : ATLANTY_MONTHLY_PRICE_MINOR };
  // Клубная подписка Топократов — такой же прямой продукт без счётчика LK.
  if (key === TOPOCRATY_PLAN_ID) return { key, label: 'ДРУЖБА.ТОПОКРАТЫ', period: '30 дней', planId: TOPOCRATY_PLAN_ID,
    billingOptionId: 'monthly', target: resolveStorefrontBillingTarget(TOPOCRATY_PLAN_ID, 'monthly'), promo: null,
    staticPriceMinor: TOPOCRATY_MONTHLY_PRICE_MINOR };
  if (key === PATRIOTS_PLAN_ID) return { key, label: 'ДРУЖБА.ПАТРИОТЫ', period: '30 дней', planId: PATRIOTS_PLAN_ID,
    billingOptionId: 'monthly', target: resolveStorefrontBillingTarget(PATRIOTS_PLAN_ID, 'monthly'), promo: null,
    staticPriceMinor: PATRIOTS_MONTHLY_PRICE_MINOR };
  const labels: Record<string, string> = { friendship: 'Дружба', 'friendship-year': 'Дружба', academy: 'Академия', ra: 'РА', energy5: 'Энергия 5' };
  if (!Object.prototype.hasOwnProperty.call(labels, key)) return null;
  const planId = key === 'friendship-year' ? 'friendship' : key;
  const billingOptionId = key === 'friendship-year' ? 'annual' as const : 'monthly' as const;
  return { key, label: labels[key], period: key === 'friendship-year' ? 'год' : key === 'energy5' ? '60 дней, 5 занятий' : '30 дней',
    planId, billingOptionId, target: resolveStorefrontBillingTarget(planId, billingOptionId), promo: null };
}

/** The public Viva product proves visit redemption coverage; discounts are priced separately at booking. */
export function parsePatriotsProductPrice(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Product unavailable');
  const product = payload as Record<string, unknown>;
  const ids = (value: unknown): number[] => Array.isArray(value)
    ? value.map(row => row && typeof row === 'object' && !Array.isArray(row)
      ? (row as Record<string, unknown>).id : null).filter((id): id is number => Number.isSafeInteger(id))
    : [];
  const directions = ids(product.availableDirections);
  const types = ids(product.availableTypes);
  // 5278/839 grants a booking discount only; adding either to Viva redemption would change the offer.
  if (product.id !== PATRIOTS_PRODUCT_ID || product.cost !== PATRIOTS_MONTHLY_PRICE_MINOR
    || product.validityDays !== 30 || product.visits !== 30
    || product.hasDirectionLimitation !== true || product.hasTypeLimitation !== true
    || ![6181, 6306, 6307].every(id => directions.includes(id))
    || directions.includes(5278) || !types.includes(2349) || types.includes(839)) throw new Error('Product terms mismatch');
  return product.cost;
}

export async function loadZeroOfferQuote(key: string, signal?: AbortSignal): Promise<ZeroOfferQuote> {
  const offer = resolveZeroOffer(key);
  if (!offer?.liveProductId) return { priceMinor: await loadZeroOfferPrice(key, signal) };
  const product = await request<unknown>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/subscriptions/${offer.liveProductId}`,
    { method: 'GET', cache: 'no-store', signal, retries: 0 },
  );
  try {
    if (product.error) throw new Error('Product unavailable');
    const quote = parseZeroLiveProductQuote(product.data, key);
    if (key === 'friendship-two-hours') {
      const status = await request<unknown>('/lk/tournaments/summer-subscription/status?counterKey=friendship_two_hours',
        { method: 'GET', cache: 'no-store', baseUrl: getServ2Origin() || '', signal, retries: 0 });
      if (status.error || parseZeroPrice(status.data, 'friendship_two_hours', offer.liveProductId) !== quote.priceMinor) {
        throw new Error('Product and booking status disagree');
      }
    }
    return quote;
  } catch { throw new StorefrontPaymentError('Не удалось подтвердить цену и условия подписки. Обновите данные.'); }
}

export async function loadZeroOfferPrice(key: string, signal?: AbortSignal): Promise<number> {
  const offer = resolveZeroOffer(key);
  if (!offer) throw new StorefrontPaymentError('Предложение не найдено.');
  if (offer.promo) return offer.promo.priceMinor;
  if (offer.liveProductId) return (await loadZeroOfferQuote(key, signal)).priceMinor;
  // A direct product without an issued id must fail closed before any price is
  // shown: otherwise the dialog opens, the visitor starts a purchase and the
  // durable attempt marker blocks this browser for nothing.
  if (!offer.target) throw new StorefrontPaymentError('Предложение недоступно.');
  if (key === PATRIOTS_PLAN_ID) {
    const result = await request<unknown>(
      `${API_BASE}/end-user/api/v1/${TENANT_KEY}/products/subscriptions/${encodeURIComponent(PATRIOTS_PRODUCT_ID)}`,
      { method: 'GET', cache: 'no-store', signal, retries: 0 },
    );
    try {
      if (result.error) throw new Error('Product unavailable');
      return parsePatriotsProductPrice(result.data);
    } catch { throw new StorefrontPaymentError('Условия подписки пока не подтверждены. Попробуйте позже.'); }
  }
  if (typeof offer.staticPriceMinor === 'number') {
    if (!Number.isSafeInteger(offer.staticPriceMinor) || offer.staticPriceMinor <= 0) throw new StorefrontPaymentError('Предложение недоступно.');
    return offer.staticPriceMinor;
  }
  const result = await request<unknown>('/lk/tournaments/summer-subscription/status?counterKey=' + encodeURIComponent(offer.target.counterKey),
    { method: 'GET', cache: 'no-store', baseUrl: getServ2Origin() || '', signal, retries: 0 });
  try {
    if (result.error) throw new Error('Status unavailable');
    return parseZeroPrice(result.data, offer.target.counterKey);
  } catch { throw new StorefrontPaymentError('Не удалось подтвердить доступность подписки. Обновите данные или попробуйте позже.'); }
}


function saveAttempt(attempt: Attempt) {
  const value = JSON.stringify(attempt);
  window.localStorage.setItem(ATTEMPT_PREFIX + attempt.key, value);
  if (window.localStorage.getItem(ATTEMPT_PREFIX + attempt.key) !== value) throw new Error('Storage unavailable');
}

/** Never discard an ambiguous legacy pending entry based on its age. */
function hasLegacyPending(key: string): boolean {
  const offer = resolveZeroOffer(key), target = offer?.target;
  if (!target) return false;
  const raw = window.localStorage.getItem('padlhub_tournament_subscription_pending_refs');
  if (!raw) return false;
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries)) return true;
  return entries.some(e => !e || typeof e !== 'object' || !e.counterKey
    || e.counterKey === target.counterKey);
}
export function hasRecordedZeroAttempt(key: string): boolean {
  try { return window.localStorage.getItem(ATTEMPT_PREFIX + key) !== null; } catch { return true; }
}
export function hasZeroAttempt(key: string): boolean {
  try {
    const recorded = hasRecordedZeroAttempt(key);
    return (recorded && readAttempt(key)?.state !== 'paid') || hasLegacyPending(key)
      || (Boolean(resolveZeroOffer(key)?.promo) && hasPromoPaymentAttempt(key));
  } catch { return true; }
}

function readAttempt(key: string): Attempt | null {
  try { return parseZeroAttempt(window.localStorage.getItem(ATTEMPT_PREFIX + key), key); } catch { return null; }
}

export function buildZeroReturnUrl(key: string): string {
  const url = new URL(window.location.href);
  // Never echo an OAuth code, tokens or another payment's return parameters to the bank.
  const query = new URLSearchParams();
  for (const name of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
    const value = url.searchParams.get(name);
    if (value && value.length <= 500) query.set(name, value);
  }
  for (const name of ['offer', 'offerKey']) { const value = url.searchParams.get(name); if (value && resolveStorefrontPromo(value)) query.set(name, value); }
  if (url.searchParams.get('variant') === 'atlanty') query.set('variant', 'atlanty');
  if (url.searchParams.get('plans') === 'ra,academy') query.set('plans', 'ra,academy');
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

/** All creates follow an explicit trusted card gesture or authenticated dialog confirmation.
 * Durable markers contain no phone, access token or bank URL and never expire on ambiguity.
 */
export async function createZeroPayment(key: string, phone: string, expectedPrice: number, canProceed: () => boolean, expectedQuote?: ZeroOfferQuote | null) {
  const offer = resolveZeroOffer(key);
  if (!offer || !phone.trim() || !Number.isSafeInteger(expectedPrice) || expectedPrice <= 0) throw new StorefrontPaymentError('Проверьте предложение и профиль.');
  if (!navigator.locks || !window.crypto?.randomUUID) throw new StorefrontPaymentError('Для оформления откройте страницу в актуальном Safari или Chrome по HTTPS.');
  const sharedProductId = offer.liveProductId || offer.promo?.productId || resolveStorefrontPromoTarget(offer.planId, offer.billingOptionId)?.directProductId;
  const create = () => navigator.locks.request(ATTEMPT_PREFIX + key, { ifAvailable: true }, async lock => {
    if (!lock || hasZeroAttempt(key)) throw new StorefrontPaymentError(ZERO_PENDING_MESSAGE);
    const quote = await loadZeroOfferQuote(key);
    const price = quote.priceMinor;
    if (!canProceed()) throw new StorefrontPaymentError('Оформление закрыто.');
    if (price !== expectedPrice) throw new StorefrontPaymentError('Цена изменилась. Обновите данные и подтвердите новую цену.');
    if (offer.liveProductId && (!expectedQuote || expectedQuote.priceMinor !== price
      || expectedQuote.activationDays !== quote.activationDays)) {
      throw new StorefrontPaymentError('Условия активации изменились. Обновите данные перед оплатой.');
    }
    const attempt: Attempt = { key, paymentRef: `zero-${window.crypto.randomUUID()}`, state: 'pending' };
    const returnUrl = buildZeroReturnUrl(key);
    try { saveAttempt(attempt); }
    catch { throw new StorefrontPaymentError('Разрешите сохранение данных сайта, чтобы продолжить оформление.'); }
    try {
      if (sharedProductId) await recordOrdinarySubscriptionAttempt(sharedProductId, phone, { paymentRef: attempt.paymentRef, ...(!offer.promo && !offer.liveProductId && !offer.target?.directProductId && offer.target ? { counterKey: offer.target.counterKey, annual: offer.billingOptionId === 'annual' } : {}) });
      if (!canProceed()) throw new Error('Checkout cancelled');
      if (offer.promo) {
        // Share the existing promo lock/marker with sub_hab. Only return URL differs.
        const result = await createStorefrontPromoPayment(key, phone, returnUrl, expectedPrice);
        if (result.transactionId) saveAttempt({ ...attempt, transactionId: result.transactionId });
        return result;
      }
      const target = offer.target;
      const directProductId = offer.liveProductId || target?.directProductId;
      if (directProductId) {
        const result = await apiBuySubscroption(directProductId, phone, {
          baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl, retries: 0,
        });
        if (result.error || !result.data) throw new Error('Unknown result');
        const { paymentUrl, paid, toPay } = result.data;
        const ids = [result.data.transactionId, result.data.id].filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
        if (new Set(ids).size > 1) throw new Error('Conflicting transaction ids');
        const transactionId = ids[0];
        if (transactionId) { saveAttempt({ ...attempt, transactionId }); if (sharedProductId) await recordOrdinarySubscriptionAttempt(sharedProductId, phone, { transactionId }); }
        // The read-only product check precedes the write; the transaction response
        // must still confirm the amount before the visitor is sent to the bank.
        if (toPay !== price && !(paid === true && toPay === 0)) throw new Error('Transaction price mismatch');
        if (paymentUrl) return { status: 'redirect' as const, paymentUrl: bankUrl(paymentUrl) };
        if (paid === true && (toPay == null || toPay === 0)) {
          saveAttempt({ ...attempt, state: 'paid', ...(transactionId ? { transactionId } : {}) });
          if (sharedProductId) await recordOrdinarySubscriptionAttempt(sharedProductId, phone, { paid: true });
          return { status: 'settled' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
        }
        throw new Error('Unknown result');
      }
      if (!target) throw new Error('Missing purchase target');
      const result = await apiCreateTournamentSubscriptionPurchase({
        clientPhone: phone, counterKey: target.counterKey, planType: target.planType,
        paymentRef: attempt.paymentRef, baseRedirectUrl: returnUrl, successUrl: returnUrl, failUrl: returnUrl,
      });
      if (result.error || !result.data || (result.data.paymentRef && result.data.paymentRef !== attempt.paymentRef)) throw new Error('Unknown result');
      if (result.data.paymentUrl) {
        if (result.data.toPayMinor !== price) throw new Error('Transaction price mismatch');
        return { status: 'redirect' as const, paymentUrl: bankUrl(result.data.paymentUrl) };
      }
      // Missing price/URL is never payment evidence. Confirm the already stored ref.
      const confirmed = await confirmZeroPaymentOwned(key);
      return { status: 'settled' as const, message: confirmed.message };
    } catch {
      throw new StorefrontPaymentError('Не удалось подтвердить результат покупки. Не повторяйте оплату: проверьте статус или обратитесь в поддержку.');
    }
  });
  return sharedProductId ? withSubscriptionPromoLock(sharedProductId, phone, create, true) : create();
}

export async function confirmZeroPayment(key: string) {
  if (!navigator.locks) return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
  return navigator.locks.request(ATTEMPT_PREFIX + key, { ifAvailable: true }, lock => lock
    ? confirmZeroPaymentOwned(key) : Promise.resolve({ status: 'pending' as const, message: ZERO_PENDING_MESSAGE }));
}
/** Caller holds the same offer lock used by create/renewal. */
async function confirmZeroPaymentOwned(key: string) {
  const offer = resolveZeroOffer(key);
  const attempt = readAttempt(key);
  if (attempt?.state === 'paid') return { status: 'paid' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
  if (offer && attempt?.state === 'pending' && attempt.transactionId) {
    const paid = await readSubscriptionPromoTransactionPaid(attempt.transactionId);
    if (readAttempt(key)?.paymentRef !== attempt.paymentRef) return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
    if (paid) {
      saveAttempt({ ...attempt, state: 'paid' });
      return { status: 'paid' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
    }
  }
  if (!offer || !attempt || !offer.target || offer.target.directProductId) {
    return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
  }
  if (attempt.state !== 'pending') return { status: attempt.state,
    message: 'Оплата не прошла. Обратитесь в поддержку перед новой попыткой.' };
  const result = await apiConfirmTournamentSubscriptionPurchase(attempt.paymentRef, {
    counterKey: offer.target.counterKey, planType: offer.billingOptionId === 'annual' ? null : 'friendship',
  });
  if (readAttempt(key)?.paymentRef !== attempt.paymentRef) return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
  if (!result.error && result.data?.paid === true && result.data.status === 'PAID' && !result.data.failed) {
    saveAttempt({ ...attempt, state: 'paid' });
    return { status: 'paid' as const, message: 'Оплата подтверждена. Подписка оформлена.' };
  }
  // FAILED can be a locally archived, uncertain payment. Never release its guard.
  return { status: 'pending' as const, message: ZERO_PENDING_MESSAGE };
}
