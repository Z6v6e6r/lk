import { formatRubles, type PaymentKind, type PaymentOption, type Privileges } from './paymentMatrix.ts';

export const PREVIEW_RESIDENCY_PRICE = 790;
export type PreviewOrder = { method: PaymentKind; bookingAmount: number; product: 'residency' | 'subscription' | null; productAmount: number; total: number };

export function isSelectableMethod(option: PaymentOption) {
  if (option.kind === 'pass') return option.mode === 'book';
  return option.mode === 'book' || option.mode === 'offer';
}

export function defaultPaymentOption(options: PaymentOption[]): PaymentOption | undefined {
  return options.find(option => (option.kind === 'residency' || option.withResidency) && isSelectableMethod(option)) || options.find(isSelectableMethod);
}

// Keep Boost as the actual booking method; only combine its presentation with
// the owned residency that enables it. Subscription-backed Boost stays separate.
export function combineResidencyBoost(options: PaymentOption[], privileges: Privileges): PaymentOption[] {
  if (!privileges.residency || privileges.subscription) return options;
  const residency = options.find(option => option.kind === 'residency' && option.mode === 'book');
  const boost = options.find(option => option.kind === 'boost' && option.mode === 'book'
    && option.amount != null && Number.isFinite(option.amount) && option.amount >= 0);
  if (!residency || !boost) return options;
  return options.filter(option => option.kind !== 'boost').map(option => option === residency ? { ...boost, withResidency: true } : option);
}

// One subscription + Boost card uses the lower known quote. Equal prices keep
// the subscription method so the same result does not use Boost unnecessarily.
export function combineSubscriptionBoost(options: PaymentOption[], privileges: Privileges): PaymentOption[] {
  if (!privileges.subscription) return options;
  const subscription = options.find(option => option.kind === 'subscription');
  const boost = options.find(option => option.kind === 'boost' && option.mode === 'book'
    && option.amount != null && Number.isFinite(option.amount) && option.amount >= 0);
  if (!subscription || !boost) return options;
  const useSubscription = subscription.mode === 'book' && subscription.amount != null
    && Number.isFinite(subscription.amount) && subscription.amount >= 0 && subscription.amount <= boost.amount!;
  const chosen = useSubscription ? subscription : boost;
  return options.filter(option => option.kind !== 'boost').map(option => option === subscription ? { ...chosen, withSubscription: true } : option);
}

// An existing subscription should cover the event without using Boost when
// both give the exact same known participation price. Purchase offers and
// visit packs remain distinct methods even if their displayed prices match.
export function withoutRedundantBoost(options: PaymentOption[]): PaymentOption[] {
  const subscription = options.find(option => option.kind === 'subscription' && option.mode === 'book'
    && option.amount != null && Number.isFinite(option.amount) && option.amount >= 0);
  if (!subscription) return options;
  return options.filter(option => !(option.kind === 'boost' && option.mode === 'book' && option.amount === subscription.amount));
}

// Keep the actual subscription method (and its quote) behind the personal-share
// row. The full quarter remains only a crossed-out price reference.
export function withPersonalSubscription(options: PaymentOption[], hasSubscription: boolean): PaymentOption[] {
  const subscription = options.find(option => option.kind === 'subscription' && option.mode === 'book'
    && option.amount != null && Number.isFinite(option.amount) && option.amount >= 0);
  if (!hasSubscription || !subscription) return options;
  const full = options.find(option => option.kind === 'full');
  const boost = options.find(option => option.kind === 'boost' && option.mode === 'book' && option.amount != null && option.amount <= subscription.amount!);
  return [...(full ? [{ ...full, mode: 'reference' as const }] : []), ...(boost ? [boost] : []), subscription,
    ...options.filter(option => option.kind !== 'full' && option.kind !== 'subscription' && option !== boost)];
}

export function bookingButtonText(option: PaymentOption | undefined) {
  if (!option) return 'Стоимость уточняется';
  if (option.kind === 'pass') return option.mode === 'book' ? 'Списать 1 тренировку и записаться' : 'Запись по абонементу недоступна';
  if (option.amount == null) return option.kind === 'subscription' ? 'Выбрать подписку для записи' : 'Стоимость уточняется';
  return option.amount === 0 ? 'Записаться бесплатно' : `Записаться за ${formatRubles(option.amount)}`;
}

// Synthetic order only. No booking, payment link or entitlement API is called.
export function createPreviewOrder(option: PaymentOption, residencyPrice: number | null = null, subscriptionPrice: number | null = null): PreviewOrder | null {
  if (!isSelectableMethod(option)) return null;
  if (option.kind === 'pass') return { method: 'pass', bookingAmount: 0, product: null, productAmount: 0, total: 0 };
  if (option.amount == null || !Number.isFinite(option.amount) || option.amount < 0) return null;
  const product = option.mode === 'offer' && (option.kind === 'residency' || option.kind === 'subscription') ? option.kind : null;
  const productPrice = product === 'residency' ? residencyPrice : product === 'subscription' ? subscriptionPrice : 0;
  if (product && (productPrice == null || !Number.isFinite(productPrice) || productPrice <= 0)) return null;
  const bookingAmount = Math.round(option.amount * 100) / 100;
  const productAmount = product ? Math.round(productPrice! * 100) / 100 : 0;
  const totalCents = Math.round(bookingAmount * 100) + Math.round(productAmount * 100);
  if (!Number.isSafeInteger(Math.round(bookingAmount * 100)) || !Number.isSafeInteger(Math.round(productAmount * 100)) || !Number.isSafeInteger(totalCents) || (product && productAmount <= 0)) return null;
  return { method: option.kind, bookingAmount, product, productAmount, total: totalCents / 100 };
}

export function readPassRemaining(params: URLSearchParams) {
  const value = params.get('passRemaining');
  if (value === null) return 3;
  const count = Number(value);
  return value.trim() && Number.isInteger(count) && count >= 0 && count <= 5 ? count : 0;
}

export function trainingCount(count: number) {
  return `${count} ${count === 1 ? 'тренировка' : count >= 2 && count <= 4 ? 'тренировки' : 'тренировок'}`;
}

export function passBalanceText(count: number) { return `${count === 1 ? 'Осталась' : 'Осталось'} ${trainingCount(count)}`; }

export function withPassBalance(options: PaymentOption[], remaining: number): PaymentOption[] {
  const usable = Number.isInteger(remaining) && remaining > 0 && remaining <= 5;
  const adjusted = options.filter(option => option.kind !== 'pass' || (usable && option.mode === 'book'));
  const hasBenefit = adjusted.some(option => option.kind !== 'full' && option.mode === 'book');
  return adjusted.map(option => option.kind === 'full' && option.mode === 'reference' && !hasBenefit ? { ...option, mode: 'book' } : option);
}

export function readResidencyPrice(params: URLSearchParams): number | null {
  const value = params.get('residencyPrice');
  if (value === null) return PREVIEW_RESIDENCY_PRICE;
  if (!value?.trim()) return null;
  const amount = Number(value);
  const rounded = Math.round(amount * 100) / 100;
  return Number.isSafeInteger(Math.round(amount * 100)) && rounded > 0 ? rounded : null;
}
