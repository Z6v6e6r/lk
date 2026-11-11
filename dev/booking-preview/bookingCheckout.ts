import { formatRubles, type PaymentKind, type PaymentOption } from './paymentMatrix.ts';

export const ENERGY_PASS_PRICE = 19800;
export const PREVIEW_RESIDENCY_PRICE = 790;
export type PreviewOrder = { method: PaymentKind; bookingAmount: number; product: 'residency' | 'pass' | null; productAmount: number; total: number };

export function isSelectableMethod(option: PaymentOption) {
  return option.mode === 'book' || option.mode === 'offer';
}

export function bookingButtonText(option: PaymentOption | undefined) {
  if (!option) return 'Стоимость уточняется';
  if (option.kind === 'pass') return option.mode === 'offer' ? `Записаться за ${formatRubles(ENERGY_PASS_PRICE)}` : 'Списать 1 посещение и записаться';
  if (option.amount == null) return option.kind === 'subscription' ? 'Выбрать подписку для записи' : 'Стоимость уточняется';
  return option.amount === 0 ? 'Записаться бесплатно' : `Записаться за ${formatRubles(option.amount)}`;
}

// Synthetic order only. No booking, payment link or entitlement API is called.
export function createPreviewOrder(option: PaymentOption, residencyPrice: number | null = null): PreviewOrder | null {
  if (!isSelectableMethod(option)) return null;
  if (option.kind === 'subscription' && option.mode === 'offer') return null;
  if (option.kind === 'pass') return { method: 'pass', bookingAmount: 0, product: option.mode === 'offer' ? 'pass' : null,
    productAmount: option.mode === 'offer' ? ENERGY_PASS_PRICE : 0, total: option.mode === 'offer' ? ENERGY_PASS_PRICE : 0 };
  if (option.amount == null || !Number.isFinite(option.amount) || option.amount < 0) return null;
  const addsResidency = option.kind === 'residency' && option.mode === 'offer';
  if (addsResidency && (residencyPrice == null || !Number.isFinite(residencyPrice) || residencyPrice <= 0)) return null;
  const bookingAmount = Math.round(option.amount * 100) / 100;
  const productAmount = addsResidency ? Math.round(residencyPrice! * 100) / 100 : 0;
  if (!Number.isSafeInteger(Math.round(bookingAmount * 100)) || !Number.isSafeInteger(Math.round(productAmount * 100)) || (addsResidency && productAmount <= 0)) return null;
  return { method: option.kind, bookingAmount, product: addsResidency ? 'residency' : null, productAmount,
    total: (Math.round(bookingAmount * 100) + Math.round(productAmount * 100)) / 100 };
}

export function readResidencyPrice(params: URLSearchParams): number | null {
  const value = params.get('residencyPrice');
  if (value === null) return PREVIEW_RESIDENCY_PRICE;
  if (!value?.trim()) return null;
  const amount = Number(value);
  const rounded = Math.round(amount * 100) / 100;
  return Number.isSafeInteger(Math.round(amount * 100)) && rounded > 0 ? rounded : null;
}
