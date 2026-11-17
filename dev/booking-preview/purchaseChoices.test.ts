import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingPurchaseChoices, paymentOptionKey, purchaseChoiceOrder, purchasePickerOption, recommendedPurchaseChoice } from './purchaseChoices.ts';
import { boostPurchaseOption } from './boostOffers.ts';
import { subscriptionPurchaseChoices } from './subscriptionOffers.ts';
import { defaultPaymentOption, withPersonalSubscription } from './bookingCheckout.ts';
import type { PaymentContext, PaymentOption, Privileges } from './paymentMatrix.ts';

const resident: Privileges = { residency: true, subscription: false, pass: false };
const subscriber: Privileges = { residency: false, subscription: true, pass: false };
const context: PaymentContext = { subscriptionPlan: 'friendship', dailyQuota: 'available', dailyUsage: 'none', durationMinutes: 90 };
const fits = { subscription: true, pass: false };

test('one subscription picker groups a seven-day Boost without changing its quote or charging the base again', () => {
  const normal = subscriptionPurchaseChoices('game', context, 'quarter', 6000);
  const boost = boostPurchaseOption('game', resident, fits, context, 'full', 'quarter', 6000)!;
  const choices = bookingPurchaseChoices(normal, boost, 8800, resident, 'full');
  assert.equal(choices.filter(choice => choice.id === 'boost').length, 1);
  assert.equal(choices.find(choice => choice.id === 'boost')?.days, 7);
  assert.deepEqual(purchaseChoiceOrder(choices.find(choice => choice.id === 'boost')), {
    method: 'boost', bookingAmount: 350, product: 'boost', productAmount: 8800, total: 9150,
  });
  assert.equal(recommendedPurchaseChoice(choices)?.id, 'friendship-2');
  assert.deepEqual(purchasePickerOption(choices), { kind: 'subscription', mode: 'offer', amount: 0 });
});

test('Boost is absent without an owned base, in the current stage, or when existing eligibility excludes it', () => {
  const normal = subscriptionPurchaseChoices('game', context, 'quarter', 6000);
  const boost = boostPurchaseOption('game', resident, fits, context, 'full', 'quarter', 6000)!;
  for (const choices of [
    bookingPurchaseChoices(normal, boost, 8800, { ...resident, residency: false }, 'full'),
    bookingPurchaseChoices(normal, boost, 8800, resident, 'current'),
    bookingPurchaseChoices(normal, undefined, 8800, resident, 'full'),
  ]) assert.ok(!choices.some(choice => choice.id === 'boost'));
});

test('an existing subscriber can open a Boost-only picker without repurchasing their subscription', () => {
  const boost = boostPurchaseOption('training', subscriber, fits, context, 'full')!;
  const choices = bookingPurchaseChoices(subscriptionPurchaseChoices('training', context), boost, 8800, subscriber, 'full');
  assert.deepEqual(choices.map(choice => choice.id), ['boost']);
  assert.equal(recommendedPurchaseChoice(choices)?.id, 'boost');
  assert.equal(purchaseChoiceOrder(choices[0])?.total, 8800);
  assert.equal(purchaseChoiceOrder(choices[0])?.product, 'boost');
});

test('invalid Boost prices cannot become payable or show a falsely free purchase', () => {
  const boost = boostPurchaseOption('training', subscriber, fits, context, 'full')!;
  for (const price of [null, 0, -1, NaN, Infinity]) {
    const choices = bookingPurchaseChoices([], boost, price, subscriber, 'full');
    assert.equal(purchaseChoiceOrder(choices[0]), null);
    assert.equal(recommendedPurchaseChoice(choices), undefined);
    assert.equal(purchasePickerOption(choices)?.amount, null);
  }
  assert.equal(purchasePickerOption([]), undefined);
  assert.equal(purchaseChoiceOrder(undefined), null);
});

test('personal payment keeps owned subscription and nested purchase picker distinct and never defaults to buying', () => {
  const full: PaymentOption = { kind: 'full', mode: 'book', amount: 1500 };
  const owned: PaymentOption = { kind: 'subscription', mode: 'book', amount: 350 };
  const picker: PaymentOption = { kind: 'subscription', mode: 'offer', amount: 0 };
  const visible = withPersonalSubscription([full, owned, picker], true);
  assert.equal(visible.length, 3);
  assert.notEqual(paymentOptionKey(owned), paymentOptionKey(picker));
  assert.equal(defaultPaymentOption(visible), owned);
  assert.ok(visible.includes(picker));
});

test('subscription purchases keep their product identity, amount and total after grouping', () => {
  const choices = bookingPurchaseChoices(subscriptionPurchaseChoices('game', context, 'quarter', 6000), undefined, 8800, resident, 'full');
  const friendship = choices.find(choice => choice.id === 'friendship')!;
  assert.deepEqual(purchaseChoiceOrder(friendship), { method: 'subscription', bookingAmount: 350, product: 'subscription', productAmount: 9800, total: 10150 });
});
