/** Explicit public offer keys; never accept a product id from a page or URL. */
export const FAST_OFFER_KEYS = ['residency', 'friendship-two-hours', 'friendship', 'friendship-year', 'academy', 'ra', 'energy5', 'friendship-promo', 'academy-promo', 'ra-promo', 'atlanty', 'atlanty-year', 'topocraty', 'patriots'] as const;
export const isFastOffer = (key: string) => (FAST_OFFER_KEYS as readonly string[]).includes(key);
export function fastOfferKey(planId: string, billing: string): string | null {
  const key = billing === 'promo' ? ['friendship-promo', 'academy-promo', 'ra-promo'].includes(planId) ? planId : '' : planId === 'friendship'
    ? billing === 'annual' ? 'friendship-year' : billing === 'monthly-two-hours' ? 'friendship-two-hours' : billing === 'monthly' ? 'friendship' : ''
    : planId === 'atlanty' && billing === 'annual' ? 'atlanty-year' : billing === 'monthly' && ['residency', 'ra', 'academy', 'energy5', 'atlanty', 'topocraty', 'patriots'].includes(planId) ? planId : '';
  return isFastOffer(key) ? key : null;
}
export function isCheckoutReturn(href = window.location.href): boolean {
  const p = new URL(href).searchParams;
  return ['phCheckoutReturn', 'summerPaymentRef', 'promoPaymentReturn', 'subscriptionPromoReturn'].some(k => p.has(k));
}
