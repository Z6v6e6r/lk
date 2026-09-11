/**
 * Storefront-owned payment adapter.
 *
 * The storefront used to only navigate to the LK1 `/ab_leto` page. The CTA now
 * creates the payment in LK1 directly and redirects the visitor to the bank URL
 * returned by the payment provider. Authentication, price and inventory stay
 * owned by LK1: this module only wires the existing contracts together.
 */
import {
  apiBuySubscroption,
  apiConfirmTournamentSubscriptionPurchase,
  apiCreateTournamentSubscriptionPurchase,
  apiFetchProfile,
} from '../../utils/apiClient';
import { appendCurrentAuthModeToNavigableUrl } from '../../utils/authMode';
import { resolveTournamentSubscriptionDirectProductId } from '../../utils/tournamentSubscriptionCatalog';

/** Query parameter used by LK1 to resolve the payment after returning from the bank. */
export const PAYMENT_REF_QUERY_KEY = 'summerPaymentRef';

/** Reuses the LK1 pending-payment storage so both surfaces share confirmation state. */
const PENDING_PAYMENT_STORAGE_KEY = 'padlhub_tournament_subscription_pending_refs';
const PENDING_PAYMENT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type StorefrontBillingOptionId = 'monthly' | 'annual' | 'monthly-two-hours';

export interface StorefrontBillingTarget {
  counterKey: 'friendship' | 'network_friendship' | 'ra' | 'academy';
  /** Direct product purchase (`apiBuySubscroption`) when the plan has a catalog product. */
  directProductId: string | null;
  /** Summer-plan purchase mode used for counter based plans. */
  planType: 'friendship';
}

export interface PendingPaymentEntry {
  counterKey: 'friendship' | 'network_friendship' | 'ra' | 'academy' | null;
  paymentRef: string;
  planId: StorefrontBillingOptionId | null;
  campaignKey: string | null;
  createdAt: string;
}

export type StorefrontPurchaseOutcome =
  | { status: 'redirect'; paymentUrl: string; paymentRef: string }
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
  if (billingOptionId === 'monthly-two-hours') return null;
  if (planId === 'friendship' && billingOptionId === 'annual') {
    return { counterKey: 'network_friendship', directProductId: null, planType: 'friendship' };
  }
  if (billingOptionId !== 'monthly') return null;
  if (planId === 'friendship') {
    return { counterKey: 'friendship', directProductId: null, planType: 'friendship' };
  }
  if (planId === 'ra' || planId === 'academy') {
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
 * payment reference so the widget can confirm the payment after the bank
 * redirects back; only then the visitor is sent to the cabinet.
 */
export function buildStorefrontReturnUrl(paymentRef: string): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  url.searchParams.set(PAYMENT_REF_QUERY_KEY, paymentRef);
  return appendCurrentAuthModeToNavigableUrl(url).toString();
}

export function readStorefrontPaymentRef(search: string): string | null {
  const value = new URLSearchParams(search).get(PAYMENT_REF_QUERY_KEY);
  const normalized = String(value || '').trim();
  return normalized || null;
}

export function clearStorefrontPaymentRef(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PAYMENT_REF_QUERY_KEY)) return;
  url.searchParams.delete(PAYMENT_REF_QUERY_KEY);
  window.history.replaceState(
    window.history.state,
    document.title,
    `${url.pathname}${url.search}${url.hash}`,
  );
}

function normalizePendingCounterKey(value: string): PendingPaymentEntry['counterKey'] {
  return value === 'friendship' || value === 'network_friendship' || value === 'ra' || value === 'academy'
    ? value
    : null;
}

function normalizePendingPlanId(value: string): PendingPaymentEntry['planId'] {
  return value === 'monthly' || value === 'annual' || value === 'monthly-two-hours' ? value : null;
}

export function readPendingPaymentEntries(now = Date.now()): PendingPaymentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const deduped = new Map<string, PendingPaymentEntry>();
    parsed.forEach((candidate) => {
      if (!candidate || typeof candidate !== 'object') return;
      const record = candidate as Partial<PendingPaymentEntry>;
      const paymentRef = String(record.paymentRef || '').trim();
      if (!paymentRef) return;
      const createdAt = String(record.createdAt || '').trim() || new Date(now).toISOString();
      const createdAtMs = Date.parse(createdAt);
      if (Number.isFinite(createdAtMs) && createdAtMs < now - PENDING_PAYMENT_MAX_AGE_MS) return;
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

function writePendingPaymentEntries(entries: PendingPaymentEntry[]): void {
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
  const current = readPendingPaymentEntries().filter((item) => item.paymentRef !== entry.paymentRef);
  current.unshift(entry);
  writePendingPaymentEntries(current.slice(0, 12));
}

export function removePendingPaymentEntry(paymentRef: string | null | undefined): void {
  const normalized = String(paymentRef || '').trim();
  if (!normalized) return;
  writePendingPaymentEntries(
    readPendingPaymentEntries().filter((item) => item.paymentRef !== normalized),
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

  const paymentRef = buildStorefrontPaymentRef(target.counterKey);
  const returnUrl = buildStorefrontReturnUrl(paymentRef);

  if (target.directProductId) {
    const result = await apiBuySubscroption(target.directProductId, params.phone, {
      baseRedirectUrl: returnUrl,
      successUrl: returnUrl,
      failUrl: returnUrl,
    });
    if (result.error || !result.data) {
      throw new StorefrontPaymentError(
        describePaymentFailure(result.error, 'Не удалось создать оплату абонемента'),
      );
    }
    if (result.data.paymentUrl) {
      return { status: 'redirect', paymentUrl: result.data.paymentUrl, paymentRef };
    }
    if (result.data.paid === true || result.data.toPay <= 0) {
      return { status: 'settled', message: 'Оплата подтверждена без перехода в банк.' };
    }
    throw new StorefrontPaymentError('Банк не вернул ссылку на оплату');
  }

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
  status: 'paid' | 'failed' | 'pending';
  message: string;
  paymentRef: string;
}

/** Confirms one payment reference through the LK1 confirm contract. */
export async function confirmStorefrontPayment(entry: {
  paymentRef: string;
  counterKey?: PendingPaymentEntry['counterKey'];
  planId?: PendingPaymentEntry['planId'];
  campaignKey?: string | null;
}): Promise<ConfirmedStorefrontPayment> {
  const result = await apiConfirmTournamentSubscriptionPurchase(entry.paymentRef, {
    counterKey: entry.counterKey ?? null,
    planType: entry.planId === 'annual' ? null : 'friendship',
    campaignKey: entry.campaignKey ?? null,
  });

  if (result.error || !result.data) {
    return {
      status: 'pending',
      paymentRef: entry.paymentRef,
      message: 'Статус оплаты обновится автоматически через несколько минут.',
    };
  }

  if (result.data.paid && String(result.data.status || '').toUpperCase() === 'PAID') {
    removePendingPaymentEntry(entry.paymentRef);
    return { status: 'paid', paymentRef: entry.paymentRef, message: 'Оплата подтверждена. Подписка оформлена.' };
  }
  if (result.data.failed) {
    removePendingPaymentEntry(entry.paymentRef);
    return { status: 'failed', paymentRef: entry.paymentRef, message: 'Оплата не прошла. Можно попробовать снова.' };
  }
  return {
    status: 'pending',
    paymentRef: entry.paymentRef,
    message: 'Платеж ещё обрабатывается банком. Статус обновится автоматически.',
  };
}
