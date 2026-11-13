import { buildBookingPaymentOptions, type GamePaymentScope, type PaymentContext, type PaymentOption, type ServiceKind, type SubscriptionPlan } from './paymentMatrix.ts';

export type SubscriptionOffer = { id: string; name: string; plan: SubscriptionPlan; price: number; services: readonly ServiceKind[]; available: boolean };
// Public catalog snapshot, read 2026-11-11. No customer data or live writes.
export const SUBSCRIPTION_CATALOG_SOURCE = 'https://padlhub.su/lk/tournaments/summer-subscription/status';
export const SUBSCRIPTION_OFFERS: readonly SubscriptionOffer[] = [
  { id: 'friendship', name: 'Дружба', plan: 'friendship', price: 9800, services: ['game'], available: true },
  { id: 'ra', name: 'РА', plan: 'ra', price: 23800, services: ['game', 'training', 'tournament'], available: true },
  // Price from the existing two-hour storefront product; local availability.
  { id: 'friendship-2', name: 'Дружба 2.0', plan: 'friendship-2', price: 19800, services: ['game', 'tournament'], available: true },
];

export function eligibleSubscriptionOffers(service: ServiceKind, context: Partial<PaymentContext>, offers = SUBSCRIPTION_OFFERS) {
  if (service === 'training' && context.excludedGroups) return [];
  if (service !== 'game' && context.proDirection) return [];
  return offers.filter(offer => offer.available && Number.isFinite(offer.price) && offer.price > 0
    && offer.services.includes(service) && !(offer.plan === 'ra' && context.raFits === false)
    && !(offer.plan === 'friendship-2' && service === 'tournament' && !context.friendsTournament))
    .sort((a, b) => a.price - b.price || (a.id === b.id ? 0 : a.id === 'ra' ? -1 : b.id === 'ra' ? 1 : a.id.localeCompare(b.id)));
}

export function subscriptionOfferQuote(offer: SubscriptionOffer, service: ServiceKind, context: Partial<PaymentContext>, gameScope?: GamePaymentScope, courtAmount: number | null = null): PaymentOption | undefined {
  if (!eligibleSubscriptionOffers(service, context, [offer]).length) return undefined;
  return buildBookingPaymentOptions(service, { residency: false, subscription: false, pass: false }, { subscription: true, pass: false },
    { ...context, subscriptionPlan: offer.plan }, gameScope, courtAmount).find(option => option.kind === 'subscription' && option.mode === 'offer');
}

export function subscriptionPurchaseChoices(service: ServiceKind, context: Partial<PaymentContext>, gameScope?: GamePaymentScope, courtAmount: number | null = null, offers = SUBSCRIPTION_OFFERS) {
  return eligibleSubscriptionOffers(service, context, offers).flatMap(offer => {
    const option = subscriptionOfferQuote(offer, service, context, gameScope, courtAmount);
    return option ? [{ offer, option }] : [];
  });
}

// Prefer the least expensive plan that includes participation in full. A paid
// copay remains visible when no eligible plan can cover the selected event.
export function recommendedSubscriptionChoice(choices: ReturnType<typeof subscriptionPurchaseChoices>) {
  return choices.find(choice => choice.option.amount === 0) || choices[0];
}
