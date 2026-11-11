import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBookingPaymentOptions, PRIVILEGE_PROFILES } from './paymentMatrix.ts';

const doesNotFit = { subscription: false, pass: false };
const hour = { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes: 60 } as const;

test('missing subscriptions and passes are purchasable for training and tournaments even without existing applicable products', () => {
  for (const service of ['training', 'tournament'] as const) {
    const options = buildBookingPaymentOptions(service, PRIVILEGE_PROFILES[0], doesNotFit, hour);
    assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'offer');
    assert.equal(options.find(option => option.kind === 'subscription')?.amount, 0);
    assert.equal(options.find(option => option.kind === 'pass')?.mode, 'offer');
    assert.equal(options.find(option => option.kind === 'full')?.mode, 'book');
  }
});
test('purchase offers never turn an owned inapplicable product into a bookable entitlement', () => {
  for (const service of ['game', 'training', 'tournament'] as const) {
    const options = buildBookingPaymentOptions(service, PRIVILEGE_PROFILES[7], doesNotFit, hour, service === 'game' ? 'quarter' : undefined, 4000);
    assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'unavailable');
    assert.equal(options.find(option => option.kind === 'pass')?.mode, service === 'game' ? undefined : 'unavailable');
  }
});
test('games hide inapplicable Energy 5 for every privilege profile instead of offering purchase', () => {
  for (const profile of PRIVILEGE_PROFILES) {
    const options = buildBookingPaymentOptions('game', profile, doesNotFit, hour, 'quarter', 4000);
    assert.ok(!options.some(option => option.kind === 'pass'));
    assert.ok(options.some(option => option.kind === 'full'));
    assert.ok(options.some(option => option.kind === 'residency'));
    assert.ok(options.some(option => option.kind === 'subscription'));
  }
});
test('applicable Energy 5 remains available for purchase or a visit debit in games', () => {
  for (const profile of PRIVILEGE_PROFILES) {
    const option = buildBookingPaymentOptions('game', profile, { ...doesNotFit, pass: true }, hour, 'quarter', 4000).find(option => option.kind === 'pass');
    assert.equal(option?.mode, profile.pass ? 'book' : 'offer');
  }
});
test('excluded groups reject subscription purchases but still offer an eligible visit pack', () => {
  const options = buildBookingPaymentOptions('training', PRIVILEGE_PROFILES[0], doesNotFit, { ...hour, excludedGroups: true });
  assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'unavailable');
  assert.equal(options.find(option => option.kind === 'residency')?.mode, 'unavailable');
  assert.equal(options.find(option => option.kind === 'pass')?.mode, 'offer');
});
test('a training-only tariff leads to tariff selection for tournaments, without promising free entry', () => {
  const option = buildBookingPaymentOptions('tournament', PRIVILEGE_PROFILES[0], doesNotFit, { subscriptionPlan: 'daily-training' }).find(option => option.kind === 'subscription')!;
  assert.equal(option.mode, 'offer');
  assert.equal(option.reason, 'training-only');
  assert.equal(option.amount, null);
});
test('full court remains unconditionally paid without purchase offers or discounts', () => {
  assert.deepEqual(buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[0], doesNotFit, hour, 'court', 8000), [{ kind: 'full', mode: 'book', amount: 8000 }]);
});
