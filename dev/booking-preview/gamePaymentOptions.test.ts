import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGamePaymentOptions, PRIVILEGE_PROFILES } from './paymentMatrix.ts';

const fits = { subscription: true, pass: true };
const hour = { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes: 60 } as const;

test('full court payment never applies any entitlement, quota or discount', () => {
  for (const profile of PRIVILEGE_PROFILES) for (const dailyQuota of ['available', 'used'] as const) {
    for (const durationMinutes of [60, 90, 120]) {
      assert.deepEqual(buildGamePaymentOptions(4000, 'court', profile, fits, { ...hour, dailyQuota, durationMinutes }), [{ kind: 'full', mode: 'book', amount: 4000 }]);
    }
  }
});
test('paying for myself means one quarter of the selected court price', () => {
  for (const [court, personal] of [[4000, 1000], [6000, 1500], [10000, 2500]]) {
    const options = buildGamePaymentOptions(court, 'quarter', PRIVILEGE_PROFILES[0], fits, hour);
    assert.equal(options.find(option => option.kind === 'full')?.amount, personal);
    assert.equal(options.find(option => option.kind === 'full')?.mode, 'book');
  }
});
test('residency discounts only my quarter and crosses out the undiscounted personal amount', () => {
  const options = buildGamePaymentOptions(4000, 'quarter', PRIVILEGE_PROFILES[1], fits, hour);
  assert.deepEqual(options.find(option => option.kind === 'full'), { kind: 'full', mode: 'reference', amount: 1000 });
  assert.equal(options.find(option => option.kind === 'residency')?.amount, 700);
  assert.equal(options.find(option => option.kind === 'residency')?.mode, 'book');
});
test('an unused applicable daily hour makes my covered participation free', () => {
  const option = buildGamePaymentOptions(4000, 'quarter', PRIVILEGE_PROFILES[2], fits, hour).find(option => option.kind === 'subscription')!;
  assert.equal(option.mode, 'book');
  assert.equal(option.amount, 0);
});
test('extra time requires a copay quote and never becomes a free full booking', () => {
  const options = buildGamePaymentOptions(4000, 'quarter', PRIVILEGE_PROFILES[2], fits, { ...hour, durationMinutes: 90 });
  const option = options.find(option => option.kind === 'subscription')!;
  assert.equal(option.mode, 'quote');
  assert.equal(option.amount, null);
  assert.equal(option.freeMinutes, 60);
  assert.equal(option.paidMinutes, 30);
  assert.equal(options[0].amount, 1000);
  assert.equal(options[0].mode, 'book');
});
test('after daily use the subscription discounts my quarter by 30 percent', () => {
  const option = buildGamePaymentOptions(4000, 'quarter', PRIVILEGE_PROFILES[2], fits, { ...hour, dailyQuota: 'used' }).find(option => option.kind === 'subscription')!;
  assert.equal(option.mode, 'book');
  assert.equal(option.benefit, 'discount');
  assert.equal(option.amount, 700);
});
test('an inapplicable tariff does not authorize a free quarter or a subscription discount', () => {
  for (const dailyQuota of ['available', 'used'] as const) {
    const option = buildGamePaymentOptions(4000, 'quarter', PRIVILEGE_PROFILES[2], { subscription: false, pass: false }, { ...hour, dailyQuota }).find(option => option.kind === 'subscription')!;
    assert.equal(option.mode, 'unavailable');
    assert.equal(option.amount, null);
  }
});
test('unknown court prices do not fall back to a fixed price or a zero payment', () => {
  for (const amount of [null, 0, -100, NaN, Infinity]) for (const scope of ['quarter', 'court'] as const) {
    const options = buildGamePaymentOptions(amount, scope, PRIVILEGE_PROFILES[7], fits, hour);
    assert.equal(options.length, 1);
    assert.equal(options[0].mode, 'quote');
    assert.equal(options[0].amount, null);
  }
});
