import { createPreviewOrder } from './bookingCheckout.ts';
import type { PaymentOption, Privileges } from './paymentMatrix.ts';
import type { PreviewStage } from './previewStage.ts';
import type { subscriptionPurchaseChoices, SubscriptionOffer } from './subscriptionOffers.ts';

export type PurchaseChoice = {
  id: string; name: string; days: number; price: number | null;
  option: PaymentOption; subscription?: SubscriptionOffer;
};

// Display grouping only: quotes and eligibility still come from the existing rules.
export function bookingPurchaseChoices(subscriptions: ReturnType<typeof subscriptionPurchaseChoices>, boost: PaymentOption | undefined, boostPrice: number | null, profile: Privileges, stage: PreviewStage): PurchaseChoice[] {
  const choices: PurchaseChoice[] = profile.subscription ? [] : subscriptions.map(({ offer, option }) => ({
    id: offer.id, name: offer.name, days: 30, price: offer.price, option, subscription: offer,
  }));
  if (stage === 'full' && (profile.subscription || profile.residency) && boost?.kind === 'boost' && boost.mode === 'offer') {
    choices.push({ id: 'boost', name: 'РАбуста', days: 7, price: boostPrice, option: boost });
  }
  return choices;
}

export function purchaseChoiceOrder(choice: PurchaseChoice | undefined) {
  if (!choice) return null;
  return createPreviewOrder(choice.option, null, choice.option.kind === 'subscription' ? choice.price : null, choice.option.kind === 'boost' ? choice.price : null);
}

export function recommendedPurchaseChoice(choices: PurchaseChoice[]) {
  return choices.filter(choice => purchaseChoiceOrder(choice)).sort((a, b) => a.option.amount! - b.option.amount! || a.price! - b.price!)[0];
}

export function purchasePickerOption(choices: PurchaseChoice[]): PaymentOption | undefined {
  const recommended = recommendedPurchaseChoice(choices) || choices[0];
  if (!recommended) return undefined;
  return { kind: 'subscription', mode: 'offer', amount: purchaseChoiceOrder(recommended)?.bookingAmount ?? null };
}

export function paymentOptionKey(option: PaymentOption) {
  return `${option.kind}:${option.mode === 'offer' ? 'offer' : 'book'}`;
}
