import assert from 'node:assert/strict';
import test from 'node:test';
import { previewCourtPrice } from './gamePreviewPrice.ts';
import { buildGamePaymentOptions } from './paymentMatrix.ts';
import { gameSubscriptionComparison } from './gameSubscriptionComparison.ts';

test('duration updates court, personal, residency and subscription comparison prices together', () => {
  for (const [end, durationMinutes, court, quarter, resident, subscription] of [
    ['21:30', 60, 4000, 1000, 700, 0],
    ['22:00', 90, 6000, 1500, 1050, 500],
    ['22:30', 120, 8000, 2000, 1400, 1000],
  ] as const) {
    const amount = previewCourtPrice('20:30', end);
    assert.equal(amount, court);
    const options = buildGamePaymentOptions(amount, 'quarter', { subscription: false, residency: false, pass: false }, { subscription: false, pass: false });
    assert.equal(options.find(option => option.kind === 'full')?.amount, quarter);
    assert.equal(options.find(option => option.kind === 'residency')?.amount, resident);
    assert.equal(buildGamePaymentOptions(amount, 'court', { subscription: true, residency: true, pass: true }, { subscription: true, pass: true })[0].amount, court);
    assert.equal(gameSubscriptionComparison(amount, { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes })?.amount, subscription);
  }
});
test('time crossing midnight keeps the selected duration', () => {
  assert.equal(previewCourtPrice('23:30', '01:00'), 6000);
});
test('invalid or zero-length intervals never become a fixed price or a free quote', () => {
  for (const [from, to] of [[null, '21:30'], ['20:30', undefined], ['25:00', '21:30'], ['20:99', '22:00'], ['20:30', '20:30'], [2030, '21:30']]) {
    assert.equal(previewCourtPrice(from, to), null);
  }
});
