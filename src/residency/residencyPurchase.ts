export const RESIDENCY_OFFER_KEY = 'residency';
export const RESIDENCY_PRODUCT_ID = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
export const RESIDENCY_PRICE_MINOR = 79000;

export interface ResidencyPurchaseTerms {
  priceMinor: number;
  activationDays: number;
}

/** The catalog card alone is not evidence that this product is sold online. */
export function parseResidencyPurchaseTerms(payload: unknown): ResidencyPurchaseTerms {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Product unavailable');
  const product = payload as Record<string, unknown>;
  if (product.id !== RESIDENCY_PRODUCT_ID || product.productType !== 'SUBSCRIPTION'
    || product.showToUser !== true || product.cost !== RESIDENCY_PRICE_MINOR
    || product.validityDays !== 30 || product.visits !== 30
    || !Number.isSafeInteger(product.activationDays) || Number(product.activationDays) < 0) {
    throw new Error('Residency product terms unavailable');
  }
  return { priceMinor: RESIDENCY_PRICE_MINOR, activationDays: Number(product.activationDays) };
}

/** Purchase and QR/pass issuance have separate entry points. No arbitrary product IDs. */
export function isResidencyPurchaseRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  const buy = params.getAll('buyResidency');
  const returned = params.getAll('phCheckoutReturn');
  return (buy.length === 1 && buy[0] === '1' && returned.length === 0)
    || (returned.length === 1 && returned[0] === RESIDENCY_OFFER_KEY && buy.length === 0);
}
