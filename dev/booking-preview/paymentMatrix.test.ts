import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaymentOptions, PRIVILEGE_PROFILES, SERVICES, readMatrixSettings } from './paymentMatrix.ts';

const freeHour = { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes: 60 } as const;
const expectedOwned = [ ['full'], ['residency'], ['subscription'], ['subscription', 'residency'], ['pass'], ['pass', 'residency'], ['subscription', 'pass'], ['subscription', 'pass', 'residency'] ];
for (const [index, profile] of PRIVILEGE_PROFILES.entries()) {
  test(`matrix row: ${profile.name} across all services`, () => {
    for (const service of ['game', 'training', 'tournament'] as const) {
      const options = buildPaymentOptions(service, profile, { subscription: true, pass: true }, freeHour);
      assert.deepEqual(new Set(options.filter(option => option.mode === 'book').map(option => option.kind)), new Set(expectedOwned[index]));
      assert.equal(options.length, 4, 'Alternatives must remain visible');
      assert.equal(new Set(options.map(option => option.kind)).size, 4);
      assert.equal(options.find(option => option.kind === 'full')?.mode, index === 0 ? 'book' : 'reference');
      assert.equal(options.find(option => option.kind === 'subscription')?.amount, 0);
      assert.equal(options.find(option => option.kind === 'pass')?.amount, null, 'A visit is not money or a free subscription');
    }
  });
}
test('prices match the supplied matrix and do not stack privileges', () => {
  assert.deepEqual(Object.values(SERVICES).map(service => [service.price, service.residentPrice]), [[4000, 2800], [5500, 2750], [8000, 4000]]);
  for (const profile of PRIVILEGE_PROFILES) {
    assert.equal(buildPaymentOptions('training', profile, { subscription: true, pass: true }).find(option => option.kind === 'residency')?.amount, 2750);
  }
});
test('inapplicable subscriptions and passes never authorize free booking or a visit debit', () => {
  for (const profile of PRIVILEGE_PROFILES) {
    for (const subscription of [false, true]) for (const pass of [false, true]) {
      const options = buildPaymentOptions('game', profile, { subscription, pass }, freeHour);
      assert.equal(options.find(option => option.kind === 'subscription')?.mode, !subscription ? 'unavailable' : profile.subscription ? 'book' : 'offer');
      assert.equal(options.find(option => option.kind === 'pass')?.mode, !pass ? 'unavailable' : profile.pass ? 'book' : 'offer');
      assert.ok(options.some(option => option.mode === 'book'), 'A paid fallback must stay available');
    }
  }
});
test('ownership of an inapplicable product does not cross out the only payable price', () => {
  assert.equal(buildPaymentOptions('tournament', PRIVILEGE_PROFILES[6], { subscription: false, pass: false })[0].mode, 'book');
});
test('unknown URL profiles are treated as no privileges; applicability is independently preserved', () => {
  const settings = readMatrixSettings(new URLSearchParams('privileges=unknown&subscriptionFits=0&passFits=1'));
  assert.equal(settings.profile.id, 'none');
  assert.deepEqual(settings.applicability, { subscription: false, pass: true });
});

test('a daily training allowance only makes a training free before use', () => {
  const profile = PRIVILEGE_PROFILES[2];
  const context = { subscriptionPlan: 'daily-training', dailyQuota: 'available' } as const;
  for (const service of ['game', 'training', 'tournament'] as const) {
    const options = buildPaymentOptions(service, profile, { subscription: true, pass: false }, context);
    const subscription = options.find(option => option.kind === 'subscription')!;
    if (service === 'training') {
      assert.equal(subscription.mode, 'book');
      assert.equal(subscription.amount, 0);
      assert.equal(subscription.benefit, 'free-training');
    } else {
      assert.equal(subscription.mode, 'unavailable');
      assert.equal(subscription.reason, 'training-only');
      assert.equal(options[0].mode, 'book');
    }
  }
});
test('using either daily allowance keeps the subscription bookable at the special price', () => {
  for (const subscriptionPlan of ['daily-training', 'daily-hour'] as const) {
    for (const [service, expected] of [['game', 2800], ['training', 2750], ['tournament', 4000]] as const) {
      const options = buildPaymentOptions(service, PRIVILEGE_PROFILES[7], { subscription: true, pass: true }, { subscriptionPlan, dailyQuota: 'used' });
      const subscription = options.find(option => option.kind === 'subscription')!;
      assert.equal(subscription.mode, 'book');
      assert.equal(subscription.amount, expected);
      assert.equal(subscription.benefit, 'discount');
      assert.equal(options.find(option => option.kind === 'residency')?.amount, expected, 'The two discounts must not stack');
      assert.equal(options.find(option => option.kind === 'pass')?.mode, 'book');
    }
  }
});
test('an excluded group category rejects residency and subscription, including paid subscription discounts', () => {
  for (const profile of PRIVILEGE_PROFILES) for (const dailyQuota of ['available', 'used'] as const) {
    for (const pass of [false, true]) {
      const options = buildPaymentOptions('training', profile, { subscription: true, pass }, { dailyQuota, excludedGroups: true });
      for (const kind of ['subscription', 'residency']) {
        const option = options.find(option => option.kind === kind)!;
        assert.equal(option.mode, 'unavailable');
        assert.equal(option.reason, 'excluded-group');
        assert.equal(option.amount, null);
      }
      assert.equal(options.find(option => option.kind === 'pass')?.mode, !pass ? 'unavailable' : profile.pass ? 'book' : 'offer');
      assert.equal(options[0].mode, profile.pass && pass ? 'reference' : 'book');
    }
  }
});
test('the exclusion applies only to grouped training, not games or tournaments', () => {
  for (const service of ['game', 'tournament'] as const) {
    const options = buildPaymentOptions(service, PRIVILEGE_PROFILES[7], { subscription: true, pass: true }, { excludedGroups: true, dailyQuota: 'used' });
    assert.equal(options.find(option => option.kind === 'residency')?.mode, 'book');
    assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'book');
  }
});
test('a remaining hour covers a short event but does not invent a copay for a longer event', () => {
  for (const durationMinutes of [30, 60, 90, 120, 180]) {
    const options = buildPaymentOptions('game', PRIVILEGE_PROFILES[2], { subscription: true, pass: false }, { ...freeHour, durationMinutes });
    const option = options.find(option => option.kind === 'subscription')!;
    if (durationMinutes <= 60) {
      assert.equal(option.mode, 'book');
      assert.equal(option.amount, 0);
      assert.equal(option.freeMinutes, durationMinutes);
    } else {
      assert.equal(option.mode, 'quote');
      assert.equal(option.amount, null);
      assert.equal(option.freeMinutes, 60);
      assert.equal(option.paidMinutes, durationMinutes - 60);
      assert.equal(options[0].mode, 'book', 'Keep a priced fallback while the copay formula is undefined');
    }
  }
});
test('inapplicability never becomes a subscription discount just because the daily quota was used', () => {
  const options = buildPaymentOptions('training', PRIVILEGE_PROFILES[2], { subscription: false, pass: false }, { dailyQuota: 'used' });
  assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'unavailable');
  assert.equal(options.find(option => option.kind === 'subscription')?.reason, 'not-applicable');
  assert.equal(options[0].mode, 'book');
});
test('unknown duration never grants a free hour', () => {
  for (const durationMinutes of [0, -1, NaN, Infinity]) {
    const option = buildPaymentOptions('game', PRIVILEGE_PROFILES[2], { subscription: true, pass: false }, { ...freeHour, durationMinutes }).find(option => option.kind === 'subscription')!;
    assert.equal(option.mode, 'unavailable');
    assert.equal(option.reason, 'unknown-duration');
  }
});
test('shared URL preserves tariff, quota and group category independently', () => {
  const settings = readMatrixSettings(new URLSearchParams('privileges=subscription&subscriptionPlan=daily-hour&dailyQuota=used&groupCategory=excluded&subscriptionFits=1&passFits=0'));
  assert.equal(settings.subscriptionPlan, 'daily-hour');
  assert.equal(settings.dailyQuota, 'used');
  assert.equal(settings.excludedGroups, true);
  assert.deepEqual(settings.applicability, { subscription: true, pass: false });
});
