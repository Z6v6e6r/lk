import { formatRubles, type PaymentKind, type PaymentOption } from './paymentMatrix.ts';

export const ENERGY_PASS_PRICE = 19800;
export const PREVIEW_RESIDENCY_PRICE = 790;
export type PreviewOrder = { method: PaymentKind; bookingAmount: number; product: 'residency' | 'pass' | 'subscription' | null; productAmount: number; total: number };

export function isSelectableMethod(option: PaymentOption) {
  return option.mode === 'book' || option.mode === 'offer';
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
  if (option.kind === 'pass') return option.mode === 'offer' ? `Записаться за ${formatRubles(ENERGY_PASS_PRICE)}` : 'Списать 1 тренировку и записаться';
  if (option.amount == null) return option.kind === 'subscription' ? 'Выбрать подписку для записи' : 'Стоимость уточняется';
  return option.amount === 0 ? 'Записаться бесплатно' : `Записаться за ${formatRubles(option.amount)}`;
}

// Synthetic order only. No booking, payment link or entitlement API is called.
export function createPreviewOrder(option: PaymentOption, residencyPrice: number | null = null, subscriptionPrice: number | null = null): PreviewOrder | null {
  if (!isSelectableMethod(option)) return null;
  if (option.kind === 'pass') return { method: 'pass', bookingAmount: 0, product: option.mode === 'offer' ? 'pass' : null,
    productAmount: option.mode === 'offer' ? ENERGY_PASS_PRICE : 0, total: option.mode === 'offer' ? ENERGY_PASS_PRICE : 0 };
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
  if (remaining > 0) return options;
  const adjusted = options.map(option => option.kind === 'pass' && option.mode === 'book' ? { ...option, mode: 'offer' as const } : option);
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
