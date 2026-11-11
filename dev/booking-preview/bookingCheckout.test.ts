import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingButtonText, createPreviewOrder, isSelectableMethod, passBalanceText, readPassRemaining, readResidencyPrice, trainingCount, withPassBalance } from './bookingCheckout.ts';
import { buildBookingPaymentOptions, PRIVILEGE_PROFILES, type PaymentOption } from './paymentMatrix.ts';

test('selecting an unowned residency is possible and uses the event discount on the primary button', () => {
  const options = buildBookingPaymentOptions('training', PRIVILEGE_PROFILES[0], { subscription: false, pass: false });
  const full = options.find(option => option.kind === 'full')!;
  const resident = options.find(option => option.kind === 'residency')!;
  assert.equal(bookingButtonText(full), 'Записаться за 5 500 ₽');
  assert.equal(isSelectableMethod(resident), true);
  assert.equal(bookingButtonText(resident), 'Записаться за 2 750 ₽');
  assert.equal(createPreviewOrder(resident), null, 'The discount offer cannot skip buying residency');
});
test('owned residency pays only for the discounted event', () => {
  assert.deepEqual(createPreviewOrder({ kind: 'residency', mode: 'book', amount: 2750 }, 790),
    { method: 'residency', bookingAmount: 2750, product: null, productAmount: 0, total: 2750 });
});
test('adding residency creates one order with the discounted event and product', () => {
  assert.deepEqual(createPreviewOrder({ kind: 'residency', mode: 'offer', amount: 2750 }, 790),
    { method: 'residency', bookingAmount: 2750, product: 'residency', productAmount: 790, total: 3540 });
});
test('all paid and free methods keep their quoted amounts without stacking', () => {
  assert.equal(createPreviewOrder({ kind: 'full', mode: 'book', amount: 5500 }, 790)?.total, 5500);
  assert.equal(createPreviewOrder({ kind: 'subscription', mode: 'book', amount: 500, benefit: 'partial-hour' })?.total, 500);
  assert.equal(createPreviewOrder({ kind: 'subscription', mode: 'book', amount: 0 })?.total, 0);
  assert.equal(createPreviewOrder({ kind: 'subscription', mode: 'offer', amount: 0 }), null, 'Missing subscriptions must go through purchase first');
  assert.equal(createPreviewOrder({ kind: 'pass', mode: 'offer', amount: null })?.total, 19800);
  assert.equal(createPreviewOrder({ kind: 'pass', mode: 'book', amount: null })?.total, 0);
});
test('invalid prices and unavailable methods cannot create a payable order', () => {
  for (const amount of [null, NaN, Infinity, -1, Number.MAX_VALUE]) {
    assert.equal(createPreviewOrder({ kind: 'full', mode: 'book', amount }), null);
  }
  for (const residencyPrice of [null, 0, -1, NaN, Infinity, 0.001, Number.MAX_VALUE]) {
    assert.equal(createPreviewOrder({ kind: 'residency', mode: 'offer', amount: 2750 }, residencyPrice), null);
  }
  for (const mode of ['unavailable', 'quote', 'reference'] as const) {
    const option: PaymentOption = { kind: 'residency', mode, amount: 2750 };
    assert.equal(isSelectableMethod(option), false);
    assert.equal(createPreviewOrder(option, 790), null);
  }
});
test('residency price is a validated local setting and decimals add as cents', () => {
  for (const value of ['', '-1', '0', 'no', 'Infinity']) assert.equal(readResidencyPrice(new URLSearchParams({ residencyPrice: value })), null);
  assert.equal(readResidencyPrice(new URLSearchParams('residencyPrice=790')), 790);
  assert.equal(readResidencyPrice(new URLSearchParams()), 790);
  assert.equal(createPreviewOrder({ kind: 'residency', mode: 'offer', amount: 0.1 }, 0.2)?.total, 0.3);
});
test('subscription purchase requires a valid product price and a known participation quote', () => {
  const free: PaymentOption = { kind: 'subscription', mode: 'offer', amount: 0 };
  assert.equal(createPreviewOrder(free, null, 23800)?.product, 'subscription');
  for (const price of [null, 0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(createPreviewOrder(free, null, price), null);
  assert.equal(createPreviewOrder({ ...free, amount: null }, null, 23800), null);
  assert.equal(createPreviewOrder({ ...free, mode: 'book' }, null, 23800)?.total, 0, 'An owned subscription is never bought again');
});
test('Energy 5 balance is validated and displayed as remaining training sessions', () => {
  assert.equal(readPassRemaining(new URLSearchParams()), 3);
  for (const count of [0, 1, 3, 5]) assert.equal(readPassRemaining(new URLSearchParams({ passRemaining: String(count) })), count);
  for (const value of ['', '-1', '6', '2.5', 'no', 'Infinity']) assert.equal(readPassRemaining(new URLSearchParams({ passRemaining: value })), 0);
  assert.equal(passBalanceText(3), 'Осталось 3 тренировки');
  assert.equal(passBalanceText(1), 'Осталась 1 тренировка');
  assert.equal(trainingCount(5), '5 тренировок');
});
test('an exhausted owned pack offers a replacement and keeps the paid fallback selectable', () => {
  const options = buildBookingPaymentOptions('training', PRIVILEGE_PROFILES[4], { subscription: false, pass: true });
  assert.equal(withPassBalance(options, 0).find(option => option.kind === 'pass')?.mode, 'offer');
  assert.equal(withPassBalance(options, 0).find(option => option.kind === 'full')?.mode, 'book');
  assert.equal(withPassBalance(options, 3).find(option => option.kind === 'pass')?.mode, 'book');
  assert.equal(bookingButtonText(options.find(option => option.kind === 'pass')), 'Списать 1 тренировку и записаться');
});
