import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBookingPaymentOptions, PRIVILEGE_PROFILES, readMatrixSettings } from './paymentMatrix.ts';
import { bookingButtonText, createPreviewOrder, withPassBalance } from './bookingCheckout.ts';

const doesNotFit = { subscription: false, pass: false };
const hour = { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes: 60 } as const;

test('missing subscriptions remain purchasable but missing Energy 5 is hidden for training and tournaments', () => {
  for (const service of ['training', 'tournament'] as const) {
    const options = buildBookingPaymentOptions(service, PRIVILEGE_PROFILES[0], doesNotFit, hour);
    assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'offer');
    assert.equal(options.find(option => option.kind === 'subscription')?.amount, 0);
    assert.equal(options.find(option => option.kind === 'pass')?.mode, undefined);
    assert.equal(options.find(option => option.kind === 'full')?.mode, 'book');
  }
});
test('purchase offers never turn an owned inapplicable product into a bookable entitlement outside standard tournaments', () => {
  for (const service of ['game', 'training', 'tournament'] as const) {
    const options = buildBookingPaymentOptions(service, PRIVILEGE_PROFILES[7], doesNotFit, { ...hour, proDirection: service === 'tournament' }, service === 'game' ? 'quarter' : undefined, 4000);
    assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'unavailable');
    assert.equal(options.find(option => option.kind === 'pass')?.mode, undefined);
  }
});
test('the reported ordinary tournament configuration offers an owned Energy debit despite passFits=0', () => {
  const settings = readMatrixSettings(new URLSearchParams('subscription=1&residency=0&pass=1&boost=0&passFits=0&subscriptionPlan=friendship&dailyQuota=available&groupCategory=standard&passRemaining=3'));
  const options = buildBookingPaymentOptions('tournament', settings.profile, settings.applicability, settings);
  const pass = withPassBalance(options, 3).find(option => option.kind === 'pass')!;
  assert.equal(pass.mode, 'book');
  assert.equal(bookingButtonText(pass), 'Списать 1 тренировку и записаться');
  assert.deepEqual(createPreviewOrder(pass), { method: 'pass', bookingAmount: 0, product: null, productAmount: 0, total: 0 });
  assert.equal(options.find(option => option.kind === 'subscription')?.amount, 4000, 'The independent subscription discount remains available');
  assert.equal(withPassBalance(options, 0).find(option => option.kind === 'pass'), undefined, 'An empty pack is hidden without a replacement purchase');
});
test('standard tournament pass eligibility preserves ownership, while PRO still checks applicability', () => {
  for (const profile of PRIVILEGE_PROFILES) for (const passFits of [false, true]) {
    const fits = { subscription: true, pass: passFits };
    assert.equal(buildBookingPaymentOptions('tournament', profile, fits, hour).find(option => option.kind === 'pass')?.mode, profile.pass ? 'book' : undefined);
    if (profile.pass) assert.equal(buildBookingPaymentOptions('tournament', profile, fits, { ...hour, proDirection: true }).find(option => option.kind === 'pass')?.mode, passFits ? 'book' : undefined);
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
test('applicable Energy 5 is only available for an owned visit debit in games', () => {
  for (const profile of PRIVILEGE_PROFILES) {
    const option = buildBookingPaymentOptions('game', profile, { ...doesNotFit, pass: true }, hour, 'quarter', 4000).find(option => option.kind === 'pass');
    assert.equal(option?.mode, profile.pass ? 'book' : undefined);
  }
});
test('excluded groups reject subscription purchases and never offer to buy a visit pack', () => {
  const options = buildBookingPaymentOptions('training', PRIVILEGE_PROFILES[0], doesNotFit, { ...hour, excludedGroups: true });
  assert.equal(options.find(option => option.kind === 'subscription')?.mode, 'unavailable');
  assert.equal(options.find(option => option.kind === 'residency')?.mode, 'unavailable');
  assert.equal(options.find(option => option.kind === 'pass')?.mode, undefined);
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

// Both published stages use the same rule across create/join/comparison cards.
test('Energy 5 never becomes a purchase offer in any stage, profile, event or balance', () => {
  for (const stage of ['current', 'full']) for (const service of ['game', 'training', 'tournament'] as const) {
    for (const profile of PRIVILEGE_PROFILES) for (const passFits of [true, false]) for (const remaining of [0, 1, 3, 5]) {
      const settings = readMatrixSettings(new URLSearchParams({ stage, privileges: profile.id, passFits: passFits ? '1' : '0', boost: '1', subscriptionPlan: 'ra' }));
      const options = withPassBalance(buildBookingPaymentOptions(service, settings.profile, settings.applicability, settings, service === 'game' ? 'quarter' : undefined, 6000), remaining);
      const pass = options.find(option => option.kind === 'pass');
      const eligible = profile.pass && remaining > 0 && (service === 'tournament' || passFits);
      assert.equal(Boolean(pass), eligible, `${stage}/${service}/${profile.id}/${passFits}/${remaining}`);
      if (pass) {
        assert.equal(pass.mode, 'book');
        assert.deepEqual(createPreviewOrder(pass), { method: 'pass', bookingAmount: 0, product: null, productAmount: 0, total: 0 });
      }
    }
  }
});
