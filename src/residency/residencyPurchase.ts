export const RESIDENCY_OFFER_KEY = 'residency';
export const RESIDENCY_PRODUCT_ID = '4037a3a3-e551-4f9a-a9db-1410e46b8635';

/** Purchase and QR/pass issuance have separate entry points. No arbitrary product IDs. */
export function isResidencyPurchaseRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  const buy = params.getAll('buyResidency');
  const returned = params.getAll('phCheckoutReturn');
  return (buy.length === 1 && buy[0] === '1' && returned.length === 0)
    || (returned.length === 1 && returned[0] === RESIDENCY_OFFER_KEY && buy.length === 0);
}
