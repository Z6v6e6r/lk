export const RESIDENCY_OFFER_KEY = 'residency';
export const RESIDENCY_PRODUCT_ID = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
export const RESIDENCY_PRICE_MINOR = 79000;

export interface ResidencyPurchaseTerms {
  priceMinor: number;
  activationDays: number;
}

/** Actual Viva end-user DTO. Visibility flags are absent in this contract;
 * online sale is checked separately in Viva's product settings before release.
 * If a provider starts returning those flags, conflicting values fail closed.
 */
export function parseResidencyPurchaseTerms(payload: unknown): ResidencyPurchaseTerms {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Product unavailable');
  const product = payload as Record<string, unknown>;
  const types = product.availableTypes;
  if (product.id !== RESIDENCY_PRODUCT_ID
    || (product.productType !== undefined && product.productType !== 'SUBSCRIPTION')
    || (product.showToUser !== undefined && product.showToUser !== true)
    || product.cost !== RESIDENCY_PRICE_MINOR
    || product.validityDays !== 30 || product.visits !== 30
    || product.activationDays !== 0 || product.freezingDays !== 0
    || product.type !== 'GROUP' || product.variant !== 'BY_VISITS' || product.appliesTo !== 'BOOKING'
    || product.hasTypeLimitation !== true || !Array.isArray(types) || types.length !== 1
    || types[0]?.id !== 2572
    || product.hasStudioLimitation !== false || product.hasDirectionLimitation !== false
    || product.hasDayLimitation !== false || product.hasTimeRangeLimitation !== false
    || product.hasDayTimeLimitation !== false) {
    throw new Error('Residency product terms unavailable');
  }
  return { priceMinor: RESIDENCY_PRICE_MINOR, activationDays: 0 };
}

/** Purchase and QR/pass issuance have separate entry points. No arbitrary product IDs. */
export function isResidencyPurchaseRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  const buy = params.getAll('buyResidency');
  const returned = params.getAll('phCheckoutReturn');
  return (buy.length === 1 && buy[0] === '1' && returned.length === 0)
    || (returned.length === 1 && returned[0] === RESIDENCY_OFFER_KEY && buy.length === 0);
}
