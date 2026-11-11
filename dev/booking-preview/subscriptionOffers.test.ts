import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleSubscriptionOffers, SUBSCRIPTION_OFFERS, subscriptionOfferQuote } from './subscriptionOffers.ts';
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
  assert.equal(eligibleSubscriptionOffers('training', { ...context, raFits: false })[0].id, 'academy');
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
  assert.equal(option.amount, 500);
  assert.equal(createPreviewOrder(option, null, friendship.price)?.total, 10300);
  assert.equal(subscriptionOfferQuote(friendship, 'game', context, 'court', 6000), undefined);
});
test('using the daily quota retains the established subscription discount', () => {
  assert.equal(subscriptionOfferQuote(SUBSCRIPTION_OFFERS[1], 'training', { ...context, dailyQuota: 'used' })?.amount, 2750);
});
