import { resolveTournamentSubscriptionPromoOffer } from '../../utils/tournamentSubscriptionCatalog';

/** An empty/unknown offer is an invalid promo link, never the regular catalogue. */
export function readStorefrontPromoKey(search: string): string | null {
  const params = new URLSearchParams(search);
  const values = [...params.getAll('offer'), ...params.getAll('offerKey')]
    .map(value => value.trim().toLowerCase());
  if (!values.length) return null;
  return values.every(value => value === values[0]) ? values[0] : '';
}

export function resolveStorefrontPromo(key: string) {
  const offer = resolveTournamentSubscriptionPromoOffer(key);
  if (!offer) return null;
  const planKey = key === 'friendship-promo' ? 'friendship'
    : key === 'academy-promo' ? 'academy' : key === 'ra-promo' ? 'ra' : null;
  return planKey ? { ...offer, key, planKey } as const : null;
}

export const PROMO_RETURN_QUERY_KEY = 'promoPaymentReturn';

/** A promo URL must not present an arbitrary external site as the cabinet. */
export function resolvePromoCabinetUrl(href: string, candidate?: string | null): string {
  const current = new URL(href);
  const fallback = new URL('/lk_new', current);
  let target = fallback;
  try {
    const parsed = new URL(candidate || fallback.toString(), current);
    if ((parsed.protocol === 'https:' || (parsed.protocol === 'http:' && parsed.origin === current.origin))
      && (parsed.origin === current.origin || parsed.origin === 'https://padlhub.ru')
      && !parsed.username && !parsed.password) target = parsed;
  } catch { /* Invalid cabinet input keeps the safe local fallback. */ }
  const authMode = current.searchParams.get('authMode');
  if (authMode === 'viva' || authMode === 'legacy') target.searchParams.set('authMode', authMode);
  return target.toString();
}

export function buildPromoReturnUrl(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('summerPaymentRef');
  url.searchParams.set(PROMO_RETURN_QUERY_KEY, '1');
  url.searchParams.set('autoPurchase', '0');
  return url.toString();
}
