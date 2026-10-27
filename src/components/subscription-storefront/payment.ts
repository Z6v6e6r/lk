import { withSubscriptionPromoLock } from './promoCodeAttempt';
/**
 * Storefront-owned payment adapter.
 *
 * The storefront used to only navigate to the LK1 `/ab_leto` page. The CTA now
 * keeps LK-sale purchases and direct Viva products on separate return contracts.
 * A bank redirect alone never proves a payment or a subscription was completed.
 */
import {
  apiBuySubscroption,
  apiConfirmTournamentSubscriptionPurchase,
  apiCreateTournamentSubscriptionPurchase,
  apiFetchProfile,
  apiGetSubscriptionProduct,
  apiFetchTournamentSubscriptionStatus,
} from '../../utils/apiClient';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';
import { resolveTournamentSubscriptionDirectProductId } from '../../utils/tournamentSubscriptionCatalog';
import { ATLANTY_ANNUAL_PRODUCT_ID, ATLANTY_MONTHLY_PRODUCT_ID, FRIENDSHIP_TWO_HOURS_PRODUCT_ID, FRIENDSHIP_TWO_HOURS_PRICE_MINOR, parseFriendshipTwoHoursProduct, PATRIOTS_PLAN_ID, PATRIOTS_PRODUCT_ID, TOPOCRATY_PLAN_ID, TOPOCRATY_PRODUCT_ID } from './catalog';

/** Query parameter used by LK1 to resolve the payment after returning from the bank. */
export const PAYMENT_REF_QUERY_KEY = 'summerPaymentRef';
export const DIRECT_PAYMENT_RETURN_QUERY_KEY = 'subscriptionDirectReturn';
export const STOREFRONT_PAYMENT_UNKNOWN_MESSAGE = 'Не удалось подтвердить результат оплаты. Проверьте абонементы в личном кабинете или обратитесь в поддержку перед повторной оплатой.';

/** Reuses the LK1 pending-payment storage so both surfaces share confirmation state. */
const PENDING_PAYMENT_STORAGE_KEY = 'padlhub_tournament_subscription_pending_refs';
const PENDING_PAYMENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type StorefrontBillingOptionId = 'monthly' | 'annual' | 'monthly-two-hours';

export interface StorefrontBillingTarget {
  counterKey: 'friendship' | 'friendship_two_hours' | 'network_friendship' | 'ra' | 'academy' | 'energy5' | 'atlanty' | 'topocraty' | 'patriots';
  /** Direct product purchase (`apiBuySubscroption`) when the plan has a catalog product. */
  directProductId: string | null;
  /** Summer-plan purchase mode used for counter based plans. */
  planType: 'friendship';
}

export interface PendingPaymentEntry {
  counterKey: 'friendship' | 'friendship_two_hours' | 'network_friendship' | 'ra' | 'academy' | 'energy5' | 'atlanty' | 'topocraty' | 'patriots' | null;
  paymentRef: string;
  planId: StorefrontBillingOptionId | 'friendship' | 'sport' | null;
  campaignKey: string | null;
  createdAt: string;
}

export type StorefrontPurchaseOutcome =
  | { status: 'redirect'; paymentUrl: string; paymentRef: string | null }
  | { status: 'settled'; message: string };

export class StorefrontPaymentError extends Error {}

/**
 * Surfaces the gateway's own reason instead of a generic message: a failed
 * purchase must tell the visitor (and support) whether the provider rejected
 * the request (`418` and friends) or the bank simply returned nothing.
 */
export function describePaymentFailure(error: { status?: number | null; message?: string | null } | null | undefined, fallback: string): string {
  const message = String(error?.message || '').trim() || fallback;
  const status = typeof error?.status === 'number' ? error.status : null;
  return status === null ? message : `${message} (код ${status})`;
}

export function resolveStorefrontBillingTarget(
  planId: string,
  billingOptionId: StorefrontBillingOptionId,
): StorefrontBillingTarget | null {
  if (billingOptionId === 'monthly-two-hours') return planId === 'friendship'
    ? { counterKey: 'friendship_two_hours', directProductId: FRIENDSHIP_TWO_HOURS_PRODUCT_ID, planType: 'friendship' }
    : null;
  if (planId === 'atlanty') {
    // Both club options are direct Viva products. A blank id must fail closed
    // instead of falling through to the counter purchase contour.
    if (billingOptionId === 'monthly') {
      const monthlyProductId = String(ATLANTY_MONTHLY_PRODUCT_ID || '').trim();
      return monthlyProductId
        ? { counterKey: 'atlanty', directProductId: monthlyProductId, planType: 'friendship' }
        : null;
    }
    if (billingOptionId === 'annual') {
      const annualProductId = String(ATLANTY_ANNUAL_PRODUCT_ID || '').trim();
      return annualProductId
        ? { counterKey: 'atlanty', directProductId: annualProductId, planType: 'friendship' }
        : null;
    }
    return null;
  }
  if (planId === TOPOCRATY_PLAN_ID) {
    // Клубная подписка Топократов — один прямой продукт-абонемент. Пустой id
    // закрывает вариант, а не уводит его в счётчиковый контур покупки.
    const productId = String(TOPOCRATY_PRODUCT_ID || '').trim();
    return billingOptionId === 'monthly' && productId
      ? { counterKey: TOPOCRATY_PLAN_ID, directProductId: productId, planType: 'friendship' }
      : null;
  }
  if (planId === PATRIOTS_PLAN_ID) {
    const productId = String(PATRIOTS_PRODUCT_ID || '').trim();
    return billingOptionId === 'monthly' && productId
      ? { counterKey: PATRIOTS_PLAN_ID, directProductId: productId, planType: 'friendship' }
      : null;
  }
  if (planId === 'friendship' && billingOptionId === 'annual') {
    return { counterKey: 'network_friendship', directProductId: null, planType: 'friendship' };
  }
  if (billingOptionId !== 'monthly') return null;
  if (planId === 'friendship') {
    return { counterKey: 'friendship', directProductId: null, planType: 'friendship' };
  }
  if (planId === 'ra' || planId === 'academy' || planId === 'energy5') {
    return {
      counterKey: planId,
      directProductId: resolveTournamentSubscriptionDirectProductId(planId),
      planType: 'friendship',
    };
  }
  return null;
}

export function buildStorefrontPaymentRef(counterKey: string, now = Date.now(), random = Math.random()): string {
  return `${counterKey}-summer-${now}-${random.toString(36).slice(2, 8)}`;
}

/**
 * Return URL for the bank. Keeps the visitor on the storefront page with the
 * LK-sale reference. Direct Viva products use a separate unverified-return marker.
 */
export function buildStorefrontReturnUrl(paymentRef: string | null): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  url.searchParams.delete(DIRECT_PAYMENT_RETURN_QUERY_KEY);
  url.searchParams.set('autoPurchase', '0');
  if (paymentRef) url.searchParams.set(PAYMENT_REF_QUERY_KEY, paymentRef);
  else url.searchParams.set(DIRECT_PAYMENT_RETURN_QUERY_KEY, '1');
  return appendCurrentAuthModeToNavigableUrl(url).toString();
}

export function readStorefrontPaymentRef(search: string): string | null {
  const values = new URLSearchParams(search).getAll(PAYMENT_REF_QUERY_KEY);
  if (values.length !== 1) return null;
  const normalized = values[0].trim();
  return normalized || null;
}

export function clearStorefrontPaymentRef(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PAYMENT_REF_QUERY_KEY) && !url.searchParams.has(DIRECT_PAYMENT_RETURN_QUERY_KEY)) return;
  url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  url.searchParams.delete(DIRECT_PAYMENT_RETURN_QUERY_KEY);
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function normalizePendingCounterKey(value: string): PendingPaymentEntry['counterKey'] {
  return value === 'friendship' || value === 'friendship_two_hours' || value === 'network_friendship' || value === 'ra' || value === 'academy'
    || value === 'energy5' || value === 'atlanty' || value === TOPOCRATY_PLAN_ID || value === PATRIOTS_PLAN_ID
    ? value
    : null;
}

function normalizePendingPlanId(value: string): PendingPaymentEntry['planId'] {
  return value === 'monthly' || value === 'annual' || value === 'monthly-two-hours' || value === 'friendship' || value === 'sport' ? value : null;
}

function readStoredPendingPaymentEntries(): unknown[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PENDING_PAYMENT_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function readPendingPaymentEntries(now = Date.now()): PendingPaymentEntry[] {
  try {
    const parsed = readStoredPendingPaymentEntries();
    const deduped = new Map<string, PendingPaymentEntry>();
    parsed.forEach((candidate) => {
      if (!candidate || typeof candidate !== 'object') return;
      const record = candidate as Partial<PendingPaymentEntry>;
      const paymentRef = String(record.paymentRef || '').trim();
      if (!paymentRef) return;
      const createdAt = String(record.createdAt || '').trim();
      const createdAtMs = Date.parse(createdAt);
      if (!Number.isFinite(createdAtMs) || createdAtMs < now - PENDING_PAYMENT_MAX_AGE_MS) return;
      deduped.set(paymentRef, {
        paymentRef,
        counterKey: normalizePendingCounterKey(String(record.counterKey || '')),
        planId: normalizePendingPlanId(String(record.planId || '')),
        campaignKey: String(record.campaignKey || '').trim() || null,
        createdAt,
      });
    });
    return Array.from(deduped.values());
  } catch {
    return [];
  }
}

function writePendingPaymentEntries(entries: unknown[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(PENDING_PAYMENT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore storage write failures: they must not block the payment.
  }
}

export function upsertPendingPaymentEntry(entry: PendingPaymentEntry): void {
  // This key is shared with /ab_leto: preserve unrelated records and extension fields.
  const current = readStoredPendingPaymentEntries();
  const previous = current.find(item => item && typeof item === 'object'
    && (item as Partial<PendingPaymentEntry>).paymentRef === entry.paymentRef);
  writePendingPaymentEntries([{ ...(previous && typeof previous === 'object' ? previous : {}), ...entry },
    ...current.filter(item => !item || typeof item !== 'object'
      || (item as Partial<PendingPaymentEntry>).paymentRef !== entry.paymentRef)]);
}

export function removePendingPaymentEntry(paymentRef: string | null | undefined): void {
  const normalized = String(paymentRef || '').trim();
  if (!normalized) return;
  writePendingPaymentEntries(
    readStoredPendingPaymentEntries().filter(item => !item || typeof item !== 'object'
      || (item as Partial<PendingPaymentEntry>).paymentRef !== normalized),
  );
}

export async function resolvePaymentPhone(fallbackPhone = ''): Promise<string> {
  const fallback = fallbackPhone.trim();
  if (fallback) return fallback;
  const result = await apiFetchProfile();
  const phone = String(result.data?.phone || '').trim();
  if (result.error || !phone) {
    throw new StorefrontPaymentError('Не удалось определить номер телефона в профиле');
  }
  return phone;
}

export async function validateStorefrontDirectPurchase(target: StorefrontBillingTarget): Promise<void> {
  if (!target.directProductId) throw new StorefrontPaymentError('Промокод недоступен для этого варианта подписки.');
  if (target.counterKey === 'friendship_two_hours') {
    // A static card price is not purchase authority. Re-read the provider product
    // — identity, price, period and the promised direction scope, including
    // «Время на друзей» — immediately before the non-idempotent transaction.
    const product = await apiGetSubscriptionProduct(target.directProductId);
    if (product.error || parseFriendshipTwoHoursProduct(product.data) !== FRIENDSHIP_TWO_HOURS_PRICE_MINOR) {
      throw new StorefrontPaymentError('Стоимость подписки не подтверждена; оформление временно недоступно');
    }
    const readiness = await apiFetchTournamentSubscriptionStatus({ counterKey: 'friendship_two_hours' });
    const exact = readiness.data?.find(status => status.counterKey === 'friendship_two_hours');
    if (readiness.error || !exact || !exact.bindingReady || !exact.canPurchase
      || exact.priceMinor !== FRIENDSHIP_TWO_HOURS_PRICE_MINOR
      || (!exact.unlimited && exact.remainingCount <= 0)) {
      throw new StorefrontPaymentError('Правила подписки не подтверждены; оформление временно недоступно');
    }
  }
}

/**
 * Creates the LK1 payment for the chosen billing option and returns the bank URL.
 * Mirrors the `/ab_leto` purchase branches so price, inventory and reservation
 * semantics stay identical to the existing page.
 */
export async function createStorefrontSubscriptionPayment(params: {
  planId: string;
  billingOptionId: StorefrontBillingOptionId;
  phone: string;
}): Promise<StorefrontPurchaseOutcome> {
  const target = resolveStorefrontBillingTarget(params.planId, params.billingOptionId);
  if (!target) {
    throw new StorefrontPaymentError('Этот вариант подписки пока недоступен для оплаты');
  }

  if (target.directProductId) {
    // Viva does not register an LK sale. Never send a fabricated ref to LK confirm.
    const returnUrl = buildStorefrontReturnUrl(null);
    const directProductId = target.directProductId;
    return withSubscriptionPromoLock<StorefrontPurchaseOutcome>(directProductId, params.phone, async () => {
      await validateStorefrontDirectPurchase(target);
      const result = await apiBuySubscroption(directProductId, params.phone, {
        baseRedirectUrl: returnUrl,
        successUrl: returnUrl,
        failUrl: returnUrl,
        // The provider contract has no idempotency key: retrying an ambiguous
        // create can charge twice, so a direct product is sent exactly once.
        retries: 0,
      });
      if (result.error || !result.data) {
        throw new StorefrontPaymentError(
          describePaymentFailure(result.error, 'Не удалось создать оплату абонемента'),
        );
      }
      if (result.data.paymentUrl) {
        return { status: 'redirect', paymentUrl: result.data.paymentUrl, paymentRef: null };
      }
      if (result.data.paid === true || result.data.toPay === 0) {
        return { status: 'settled', message: 'Оплата подтверждена без перехода в банк.' };
      }
      throw new StorefrontPaymentError('Банк не вернул ссылку на оплату');
    }).catch(failure => {
      throw failure instanceof Error ? new StorefrontPaymentError(failure.message) : failure;
    });
  }

  const paymentRef = buildStorefrontPaymentRef(target.counterKey);
  const returnUrl = buildStorefrontReturnUrl(paymentRef);
  const result = await apiCreateTournamentSubscriptionPurchase({
    clientPhone: params.phone,
    counterKey: target.counterKey,
    planType: target.planType,
    paymentRef,
    baseRedirectUrl: returnUrl,
    successUrl: returnUrl,
    failUrl: returnUrl,
  });
  if (result.error || !result.data) {
    throw new StorefrontPaymentError(
      describePaymentFailure(result.error, 'Не удалось создать оплату подписки'),
    );
  }

  const resolvedPaymentRef = result.data.paymentRef || paymentRef;
  if (result.data.paymentUrl) {
    upsertPendingPaymentEntry({
      counterKey: target.counterKey,
      paymentRef: resolvedPaymentRef,
      planId: params.billingOptionId,
      campaignKey: result.data.campaignKey || null,
      createdAt: new Date().toISOString(),
    });
    return { status: 'redirect', paymentUrl: result.data.paymentUrl, paymentRef: resolvedPaymentRef };
  }
  if ((result.data.toPayMinor ?? 0) > 0) {
    throw new StorefrontPaymentError('Банк не вернул ссылку на оплату');
  }
  return { status: 'settled', message: 'Оплата подтверждена без перехода в банк.' };
}

export interface ConfirmedStorefrontPayment {
  status: 'paid' | 'failed' | 'pending' | 'unknown';
  message: string;
  paymentRef: string | null;
}

function unknownPayment(paymentRef: string | null): ConfirmedStorefrontPayment {
  return { status: 'unknown', paymentRef, message: STOREFRONT_PAYMENT_UNKNOWN_MESSAGE };
}

/** Storage is local correlation with a purchase, never payment or ownership authority. */
export function resolveStorefrontPaymentReturn(search: string): {
  entry: PendingPaymentEntry | null; outcome: ConfirmedStorefrontPayment;
} | null {
  const query = new URLSearchParams(search);
  if (!query.has(PAYMENT_REF_QUERY_KEY) && !query.has(DIRECT_PAYMENT_RETURN_QUERY_KEY)) return null;
  const paymentRef = readStorefrontPaymentRef(search);
  const entry = !query.has(DIRECT_PAYMENT_RETURN_QUERY_KEY) && paymentRef
    ? readPendingPaymentEntries().find(item => item.paymentRef === paymentRef) ?? null : null;
  return { entry, outcome: unknownPayment(paymentRef) };
}

/** Confirms only a locally correlated LK-sale. Errors are not bank-pending evidence. */
export async function confirmStorefrontPayment(
  entry: PendingPaymentEntry, isCancelled: () => boolean = () => false,
): Promise<ConfirmedStorefrontPayment> {
  try {
    const result = await apiConfirmTournamentSubscriptionPurchase(entry.paymentRef, {
      counterKey: entry.counterKey ?? null,
      planType: entry.planId === 'annual' ? null : entry.planId === 'sport' ? 'sport' : 'friendship',
      campaignKey: entry.campaignKey ?? null,
    });
    if (isCancelled()) return unknownPayment(entry.paymentRef);
    const data = result.data;
    if (result.error || !data || data.paymentRef !== entry.paymentRef) return unknownPayment(entry.paymentRef);
    const status = String(data.status || '').trim().toUpperCase();
    if (data.paid === true && status === 'PAID' && data.failed !== true) {
      removePendingPaymentEntry(entry.paymentRef);
      return { status: 'paid', paymentRef: entry.paymentRef, message: 'Оплата подтверждена. Подписка оформлена.' };
    }
    // FAILED can mean the local confirmation budget expired, not a declined bank charge.
    if (data.failed === true) return unknownPayment(entry.paymentRef);
    if (data.paid !== true && ['PAYMENT_PENDING', 'UNPAID'].includes(status)) {
      return { status: 'pending', paymentRef: entry.paymentRef,
        message: 'Сервер ещё не подтвердил оплату. Проверьте статус в личном кабинете перед повторной оплатой.' };
    }
    return unknownPayment(entry.paymentRef);
  } catch {
    return unknownPayment(entry.paymentRef);
  }
}

/** Poll only an explicit pending result; never replay a failed/ambiguous confirmation. */
export async function runStorefrontPaymentConfirmation(
  entry: PendingPaymentEntry, isCancelled: () => boolean,
): Promise<ConfirmedStorefrontPayment | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isCancelled()) return null;
    const result = await confirmStorefrontPayment(entry, isCancelled);
    if (isCancelled()) return null;
    if (result.status !== 'pending' || attempt === 2) return result;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  return null;
}
