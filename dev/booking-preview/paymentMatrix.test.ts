import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaymentOptions, PRIVILEGE_PROFILES, SERVICES, readMatrixSettings } from './paymentMatrix.ts';

const expectedOwned = [ ['full'], ['residency'], ['subscription'], ['subscription', 'residency'], ['pass'], ['pass', 'residency'], ['subscription', 'pass'], ['subscription', 'pass', 'residency'] ];
for (const [index, profile] of PRIVILEGE_PROFILES.entries()) {
  test(`matrix row: ${profile.name} across all services`, () => {
    for (const service of ['game', 'training', 'tournament'] as const) {
      const options = buildPaymentOptions(service, profile, { subscription: true, pass: true });
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
      const options = buildPaymentOptions('game', profile, { subscription, pass });
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
