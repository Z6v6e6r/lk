import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleSubscriptionOffers, recommendedSubscriptionChoice, SUBSCRIPTION_OFFERS, subscriptionOfferQuote, subscriptionPurchaseChoices } from './subscriptionOffers.ts';
import { createPreviewOrder } from './bookingCheckout.ts';

const context = { dailyQuota: 'available', durationMinutes: 90, raFits: true } as const;
test('the cheapest eligible subscription is selected, with RA first on equal prices', () => {
  assert.equal(eligibleSubscriptionOffers('game', context)[0].id, 'friendship');
  assert.equal(eligibleSubscriptionOffers('game', context)[0].price, 9800);
  assert.equal(eligibleSubscriptionOffers('training', context)[0].id, 'ra');
  assert.equal(eligibleSubscriptionOffers('tournament', context)[0].id, 'ra');
  assert.ok(!SUBSCRIPTION_OFFERS.some(offer => offer.id === 'sport'), 'Retired Sport is not sold despite appearing in the public catalog');
});
test('event exclusions, unavailable offers and missing prices cannot become purchasable subscriptions', () => {
  assert.deepEqual(eligibleSubscriptionOffers('training', { ...context, excludedGroups: true }), []);
  assert.deepEqual(eligibleSubscriptionOffers('training', { ...context, raFits: false }), []);
  assert.deepEqual(eligibleSubscriptionOffers('tournament', { ...context, raFits: false }), []);
  assert.deepEqual(eligibleSubscriptionOffers('training', context, SUBSCRIPTION_OFFERS.map(offer => ({ ...offer, available: false }))), []);
  for (const price of [0, -1, NaN, Infinity]) {
    assert.deepEqual(eligibleSubscriptionOffers('training', context, [{ ...SUBSCRIPTION_OFFERS[1], price }]), []);
  }
});
test('RA includes the whole eligible class and adds only the subscription price to one order', () => {
  const ra = SUBSCRIPTION_OFFERS.find(offer => offer.id === 'ra')!;
  for (const service of ['training', 'tournament'] as const) {
    const option = subscriptionOfferQuote(ra, service, context)!;
    assert.equal(option.benefit, 'free-event');
    assert.equal(option.amount, 0);
    assert.equal(option.mode, 'offer');
    assert.deepEqual(createPreviewOrder(option, null, ra.price), { method: 'subscription', bookingAmount: 0, product: 'subscription', productAmount: 23800, total: 23800 });
    assert.equal(subscriptionOfferQuote(ra, service, { ...context, raFits: false }), undefined);
  }
});
test('a daily-hour purchase combines the subscription price and extra game time without making the order free', () => {
  const friendship = SUBSCRIPTION_OFFERS.find(offer => offer.id === 'friendship')!;
  const option = subscriptionOfferQuote(friendship, 'game', context, 'quarter', 6000)!;
  assert.equal(option.amount, 350, 'Extra half-hour receives the Friendship 30% discount');
  assert.equal(createPreviewOrder(option, null, friendship.price)?.total, 10150);
  assert.equal(subscriptionOfferQuote(friendship, 'game', context, 'court', 6000), undefined);
});
test('Friendship 2.0 is offered for games and the Time for Friends tournament only', () => {
  const twoHours = SUBSCRIPTION_OFFERS.find(offer => offer.id === 'friendship-2')!;
  assert.equal(twoHours.price, 19800);
  assert.equal(subscriptionOfferQuote(twoHours, 'game', { ...context, durationMinutes: 120 }, 'quarter', 8000)?.amount, 0);
  assert.equal(subscriptionOfferQuote(twoHours, 'tournament', context), undefined);
  assert.equal(subscriptionOfferQuote(twoHours, 'tournament', { ...context, friendsTournament: true })?.amount, 0);
  assert.equal(subscriptionOfferQuote(twoHours, 'tournament', { ...context, friendsTournament: true })?.subscriptionPlan, 'friendship-2');
  assert.deepEqual(eligibleSubscriptionOffers('training', { ...context, proDirection: true }), []);
});
test('using the daily quota retains the established subscription discount', () => {
  assert.equal(subscriptionOfferQuote(SUBSCRIPTION_OFFERS[1], 'training', { ...context, dailyQuota: 'used' })?.amount, 2750);
});

test('a 90-minute game recommends Friendship 2.0 for free participation, keeping paid alternatives explicit', () => {
  const choices = subscriptionPurchaseChoices('game', context, 'quarter', 6000);
  const selected = recommendedSubscriptionChoice(choices)!;
  assert.equal(selected.offer.id, 'friendship-2');
  assert.equal(selected.option.amount, 0);
  assert.equal(selected.option.mode, 'offer');
  assert.equal(createPreviewOrder(selected.option), null, 'Free participation still requires purchasing the selected subscription');
  assert.deepEqual(createPreviewOrder(selected.option, null, selected.offer.price), { method: 'subscription', bookingAmount: 0, product: 'subscription', productAmount: 19800, total: 19800 });
  const friendship = choices.find(choice => choice.offer.id === 'friendship')!;
  assert.equal(friendship.option.amount, 350);
  assert.equal(createPreviewOrder(friendship.option, null, friendship.offer.price)?.total, 10150);
  const ra = choices.find(choice => choice.offer.id === 'ra')!;
  assert.equal(ra.option.amount, 350);
  assert.equal(createPreviewOrder(ra.option, null, ra.offer.price)?.total, 24150);
});

test('recommendations depend on event duration, quota and actual plan availability', () => {
  for (const [durationMinutes, courtAmount, plan, amount] of [[60, 4000, 'friendship', 0], [120, 8000, 'friendship-2', 0], [180, 12000, 'friendship', 1400]] as const) {
    const selected = recommendedSubscriptionChoice(subscriptionPurchaseChoices('game', { ...context, durationMinutes }, 'quarter', courtAmount))!;
    assert.equal(selected.offer.id, plan);
    assert.equal(selected.option.amount, amount);
  }
  for (const limit of [{ dailyQuota: 'used' as const }, { activeLimitExceeded: true }]) {
    const choices = subscriptionPurchaseChoices('game', { ...context, ...limit }, 'quarter', 6000);
    assert.ok(choices.every(choice => choice.option.amount === 1050));
    assert.equal(recommendedSubscriptionChoice(choices)?.offer.id, 'friendship');
  }
  const available = SUBSCRIPTION_OFFERS.filter(offer => offer.id !== 'friendship-2');
  assert.equal(recommendedSubscriptionChoice(subscriptionPurchaseChoices('game', context, 'quarter', 6000, available))?.option.amount, 350);
});

test('excluded events, full-court payments and missing quotes never advertise a free subscription choice', () => {
  assert.deepEqual(subscriptionPurchaseChoices('training', { ...context, excludedGroups: true }), []);
  assert.deepEqual(subscriptionPurchaseChoices('tournament', { ...context, proDirection: true }), []);
  assert.deepEqual(subscriptionPurchaseChoices('game', context, 'court', 6000), []);
  for (const amount of [null, 0, -1, NaN, Infinity]) assert.deepEqual(subscriptionPurchaseChoices('game', context, 'quarter', amount), []);
  for (const durationMinutes of [0, -1, NaN, Infinity]) assert.deepEqual(subscriptionPurchaseChoices('game', { ...context, durationMinutes }, 'quarter', 6000), []);
  assert.equal(recommendedSubscriptionChoice([]), undefined);
});
