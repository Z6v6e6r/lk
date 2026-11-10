import { ATLANTY_MONTHLY_PRODUCT_ID, ATLANTY_ANNUAL_PRODUCT_ID, FRIENDSHIP_MONTHLY_PRODUCT_ID, FRIENDSHIP_TWO_HOURS_PRODUCT_ID, TOPOCRATY_PRODUCT_ID, PATRIOTS_PRODUCT_ID } from './catalog.ts';
import { resolveTournamentSubscriptionDirectProductId } from '../../utils/tournamentSubscriptionCatalog.ts';
import { resolveStorefrontPromo } from './promo.ts';
/** Fixed legacy offer/product aliases; no page-provided ids or inferred ownership. */
export function legacyZeroOffersForProduct(productId: string): string[] {
  if (!productId) return [];
  const bindings = [
    ['residency', '4037a3a3-e551-4f9a-a9db-1410e46b8635'],
    ['friendship', FRIENDSHIP_MONTHLY_PRODUCT_ID], ['friendship-two-hours', FRIENDSHIP_TWO_HOURS_PRODUCT_ID],
    ['atlanty', ATLANTY_MONTHLY_PRODUCT_ID], ['atlanty-year', ATLANTY_ANNUAL_PRODUCT_ID],
    ['topocraty', TOPOCRATY_PRODUCT_ID], ['patriots', PATRIOTS_PRODUCT_ID],
    ...['ra', 'academy', 'energy5'].map(key => [key, resolveTournamentSubscriptionDirectProductId(key)]),
    ...['friendship-promo', 'academy-promo', 'ra-promo'].map(key => [key, resolveStorefrontPromo(key)?.productId]),
  ];
  return bindings.filter(([, id]) => id === productId).map(([key]) => key!);
}
