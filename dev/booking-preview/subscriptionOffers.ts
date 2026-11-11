import { buildBookingPaymentOptions, type GamePaymentScope, type PaymentContext, type PaymentOption, type ServiceKind, type SubscriptionPlan } from './paymentMatrix.ts';

export type SubscriptionOffer = { id: string; name: string; plan: SubscriptionPlan; price: number; services: readonly ServiceKind[]; available: boolean };
// Public catalog snapshot, read 2026-11-11. No customer data or live writes.
export const SUBSCRIPTION_CATALOG_SOURCE = 'https://padlhub.su/lk/tournaments/summer-subscription/status';
export const SUBSCRIPTION_OFFERS: readonly SubscriptionOffer[] = [
  { id: 'friendship', name: 'Дружба', plan: 'daily-hour', price: 9800, services: ['game'], available: true },
  { id: 'ra', name: 'РА', plan: 'ra', price: 23800, services: ['game', 'training', 'tournament'], available: true },
  { id: 'academy', name: 'Академия', plan: 'daily-hour', price: 23800, services: ['training'], available: true },
];

export function eligibleSubscriptionOffers(service: ServiceKind, context: Partial<PaymentContext>, offers = SUBSCRIPTION_OFFERS) {
  if (service === 'training' && context.excludedGroups) return [];
  return offers.filter(offer => offer.available && Number.isFinite(offer.price) && offer.price > 0
    && offer.services.includes(service) && !(offer.plan === 'ra' && context.raFits === false))
    .sort((a, b) => a.price - b.price || (a.id === b.id ? 0 : a.id === 'ra' ? -1 : b.id === 'ra' ? 1 : a.id.localeCompare(b.id)));
}

export function subscriptionOfferQuote(offer: SubscriptionOffer, service: ServiceKind, context: Partial<PaymentContext>, gameScope?: GamePaymentScope, courtAmount: number | null = null): PaymentOption | undefined {
  if (!eligibleSubscriptionOffers(service, context, [offer]).length) return undefined;
  return buildBookingPaymentOptions(service, { residency: false, subscription: false, pass: false }, { subscription: true, pass: false },
    { ...context, subscriptionPlan: offer.plan }, gameScope, courtAmount).find(option => option.kind === 'subscription' && option.mode === 'offer');
}
