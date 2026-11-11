import assert from 'node:assert/strict';
import test from 'node:test';
import { gameSubscriptionComparison } from './gameSubscriptionComparison.ts';

const hour = { subscriptionPlan: 'daily-hour', dailyQuota: 'available' } as const;

test('a prospective subscription covers up to one hour without granting booking access', () => {
  for (const durationMinutes of [30, 60]) {
    const option = gameSubscriptionComparison(4000, { ...hour, durationMinutes })!;
    assert.equal(option.amount, 0);
    assert.equal(option.mode, 'offer');
  }
});
test('only time beyond the free hour is priced proportionally to my quarter', () => {
  for (const [courtAmount, durationMinutes, expected, paidMinutes] of [[4000, 90, 333.33, 30], [6000, 90, 500, 30], [4000, 120, 500, 60]]) {
    const option = gameSubscriptionComparison(courtAmount, { ...hour, durationMinutes })!;
    assert.equal(option.amount, expected);
    assert.equal(option.freeMinutes, 60);
    assert.equal(option.paidMinutes, paidMinutes);
    assert.equal(option.mode, 'offer');
  }
});
test('a used quota still shows the subscription discount without stacking residency', () => {
  assert.equal(gameSubscriptionComparison(4000, { ...hour, dailyQuota: 'used', durationMinutes: 90 })?.amount, 700);
});
test('unknown prices or duration and a training-only tariff never promise a free game', () => {
  for (const amount of [null, 0, -1, NaN, Infinity]) {
    assert.equal(gameSubscriptionComparison(amount, { ...hour, durationMinutes: 90 }), undefined);
  }
  for (const durationMinutes of [0, -1, NaN, Infinity]) {
    assert.equal(gameSubscriptionComparison(4000, { ...hour, durationMinutes })?.mode, 'unavailable');
  }
  assert.equal(gameSubscriptionComparison(4000, { ...hour, subscriptionPlan: 'daily-training', durationMinutes: 90 })?.reason, 'training-only');
});
