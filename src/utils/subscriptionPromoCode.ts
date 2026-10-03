import { API_BASE, TENANT_KEY } from '../consts/api_config';
import { request } from './apiClient';

export interface SubscriptionPromoQuote {
  productId: string;
  promoCode: string;
  sumMinor: number;
  discountMinor: number;
  toPayMinor: number;
}

/** Viva transaction amounts, including `toPay`, are expressed in kopecks. */
export function normalizeSubscriptionPromoAmounts(value: unknown): Pick<SubscriptionPromoQuote, 'sumMinor' | 'discountMinor' | 'toPayMinor'> | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  function amount(keys: string[]): number | null {
    const values = keys.filter(key => row[key] !== undefined).map(key => row[key]);
    if (!values.length || values.some(v => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      || values.some(v => v !== values[0])) return null;
    return values[0] as number;
  }
  const sumMinor = amount(['sumKopecks', 'sumMinor', 'sum']);
  const discountMinor = amount(['discountKopecks', 'discountMinor', 'discount']);
  const toPayMinor = amount(['toPayKopecks', 'toPayMinor', 'toPay']);
  if (sumMinor === null || discountMinor === null || toPayMinor === null
    || sumMinor !== discountMinor + toPayMinor) return null;
  return { sumMinor, discountMinor, toPayMinor };
}

/** Preview and create must carry the same provider-owned product and promo code. */
export function buildSubscriptionPromoPayload(productId: string, phone: string, promoCode: string) {
  return { clientPhone: phone, paymentMethod: 'WIDGET',
    products: [{ id: productId, type: 'SUBSCRIPTION', count: 1 }],
    count: 1, id: productId, type: 'SUBSCRIPTION', promoCode: promoCode.trim() };
}

export async function previewSubscriptionPromoCode(productId: string, phone: string, promoCode: string): Promise<SubscriptionPromoQuote> {
  const code = promoCode.trim();
  if (!productId.trim() || !phone.trim() || !code) throw new Error('Введите промокод.');
  const result = await request<unknown>(`${API_BASE}/end-user/api/v1/${TENANT_KEY}/transactions/preview`, {
    method: 'POST', auth: true, retries: 0,
    body: JSON.stringify(buildSubscriptionPromoPayload(productId, phone, code)),
  });
  if (result.error) throw new Error(result.error.message || 'Не удалось проверить промокод.');
  const amounts = normalizeSubscriptionPromoAmounts(result.data);
  if (!amounts || amounts.discountMinor <= 0) throw new Error('Промокод не даёт скидку на выбранную подписку.');
  return { productId, promoCode: code, ...amounts };
}

/** Official Viva widget uses the v2 status endpoint for payment readback. */
export async function readSubscriptionPromoTransactionPaid(transactionId: string): Promise<boolean> {
  const result = await request<{ transactionStatus?: string }>(`${API_BASE}/end-user/api/v2/${TENANT_KEY}/transactions/${encodeURIComponent(transactionId)}/status`, {
    method: 'GET', auth: true, retries: 0,
  });
  return !result.error && result.data?.transactionStatus === 'PAID';
}
