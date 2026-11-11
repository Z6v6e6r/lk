import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBookingPaymentOptions, readMatrixSettings, type PaymentContext, type PaymentKind, type Privileges, type ServiceKind } from './paymentMatrix.ts';
import { createPreviewOrder, withPersonalSubscription } from './bookingCheckout.ts';

const subscriber = { subscription: true, residency: false, pass: false };
const resident = { subscription: false, residency: true, pass: false };
const none = { subscription: false, residency: false, pass: false };
const base = { subscriptionPlan: 'friendship', dailyQuota: 'available', durationMinutes: 60 } as const;
function options(service: ServiceKind, context: Partial<PaymentContext> = {}, profile: Privileges = subscriber) {
  const duration = context.durationMinutes ?? 60;
  return buildBookingPaymentOptions(service, profile, { subscription: true, pass: false }, { ...base, ...context }, service === 'game' ? 'quarter' : undefined, 4000 * duration / 60);
}
function method(service: ServiceKind, context: Partial<PaymentContext> = {}, kind: PaymentKind = 'subscription', profile = subscriber) {
  return options(service, context, profile).find(option => option.kind === kind)!;
}

test('independent product flags override old profile URLs; Boost cannot exist without a prerequisite', () => {
  const settings = readMatrixSettings(new URLSearchParams('privileges=all&subscription=0&residency=0&pass=1&boost=1&subscriptionPlan=friendship-2&activeLimitExceeded=1&groupCategory=pro&dailyUsage=training&proQuotaUsed=1'));
  assert.equal(settings.profile.id, 'pass');
  assert.equal(settings.boost, false);
  assert.equal(settings.subscriptionPlan, 'friendship-2');
  assert.equal(settings.activeLimitExceeded, true);
  assert.equal(settings.proDirection, true);
  assert.equal(settings.dailyUsage, 'training');
  assert.equal(settings.proQuotaUsed, true);
  assert.equal(readMatrixSettings(new URLSearchParams('privileges=residency&boost=1')).boost, true);
  assert.equal(readMatrixSettings(new URLSearchParams('subscription=1&boost=1')).boost, true);
});

test('Friendship covers one game hour and discounts only overtime by 30 percent', () => {
  for (const [durationMinutes, amount] of [[60, 0], [90, 350], [120, 700], [180, 1400]]) {
    const option = method('game', { durationMinutes });
    assert.equal(option.amount, amount);
    assert.equal(option.mode, 'book');
    assert.equal(createPreviewOrder(option)?.total, amount);
  }
  assert.equal(method('training').amount, 2750);
  assert.equal(method('tournament').amount, 4000);
});

test('Friendship 2.0 covers two game hours and Time for Friends, other events keep the discount', () => {
  const context = { subscriptionPlan: 'friendship-2' } as const;
  assert.equal(method('game', { ...context, durationMinutes: 120 }).amount, 0);
  assert.equal(method('game', { ...context, durationMinutes: 180 }).amount, 700);
  assert.equal(method('tournament', { ...context, friendsTournament: true }).amount, 0);
  assert.equal(method('tournament', context).amount, 4000);
  assert.equal(method('training', context).amount, 2750);
});

test('RA covers one game hour or a whole regular training/tournament', () => {
  const context = { subscriptionPlan: 'ra' } as const;
  assert.equal(method('game', { ...context, durationMinutes: 120 }).amount, 700);
  for (const service of ['training', 'tournament'] as const) {
    assert.equal(method(service, { ...context, durationMinutes: 180 }).amount, 0);
  }
});

test('used daily quota or more than eight active records retains paid discounts, including Boost', () => {
  for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    for (const context of [{ dailyQuota: 'used' as const }, { activeLimitExceeded: true }]) {
      for (const [service, amount] of [['game', 700], ['training', 2750], ['tournament', 4000]] as const) {
        const option = method(service, { subscriptionPlan, ...context });
        assert.equal(option.mode, 'book');
        assert.equal(option.amount, amount);
        if (context.activeLimitExceeded) assert.equal(method(service, { subscriptionPlan, ...context, boost: true }, 'boost').amount, amount);
      }
    }
  }
});

test('Boost alone or with Energy only never grants a benefit; paying for all stays fully paid', () => {
  for (const profile of [none, { ...none, pass: true }]) {
    assert.equal(options('game', { boost: true }, profile).some(option => option.kind === 'boost'), false);
  }
  for (const profile of [subscriber, resident, { ...subscriber, residency: true, pass: true }]) {
    assert.deepEqual(buildBookingPaymentOptions('game', profile, { subscription: true, pass: true }, { ...base, boost: true }, 'court', 8000), [{ kind: 'full', mode: 'book', amount: 8000 }]);
  }
});

test('Residency plus Boost is a single regular RA event, without PRO', () => {
  for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    const context = { subscriptionPlan, boost: true };
    assert.equal(method('game', context, 'boost', resident).amount, 0);
    assert.equal(method('game', { ...context, durationMinutes: 120 }, 'boost', resident).amount, 700);
    assert.equal(method('training', context, 'boost', resident).amount, 0);
    assert.equal(method('tournament', { ...context, dailyQuota: 'used' }, 'boost', resident).amount, 4000);
    assert.equal(method('training', { ...context, proDirection: true }, 'boost', resident).mode, 'unavailable');
  }
});

test('Friendship and RA plus Boost combine two game hours or two regular events', () => {
  for (const subscriptionPlan of ['friendship', 'ra'] as const) {
    const context = { subscriptionPlan, boost: true };
    assert.equal(method('game', { ...context, durationMinutes: 120 }, 'boost').amount, 0);
    assert.equal(method('game', { ...context, durationMinutes: 180 }, 'boost').amount, 700);
    assert.equal(method('training', { ...context, dailyQuota: 'used', dailyUsage: 'tournament' }, 'boost').amount, 0);
    assert.equal(method('tournament', { ...context, dailyQuota: 'used', dailyUsage: 'game-hour' }, 'boost').amount, 0);
    assert.equal(method('game', { ...context, dailyQuota: 'used', dailyUsage: 'training' }, 'boost').amount, 0);
    assert.equal(method('game', { ...context, dailyQuota: 'used', dailyUsage: 'game-hour', durationMinutes: 120 }, 'boost').amount, 700);
    for (const dailyUsage of ['game-two-hours', 'two-events', 'game-hour-event'] as const) {
      assert.equal(method('training', { ...context, dailyQuota: 'used', dailyUsage }, 'boost').amount, 2750);
      assert.equal(method('game', { ...context, dailyQuota: 'used', dailyUsage }, 'boost').amount, 700);
    }
  }
});

test('Friendship 2.0 plus Boost has two game hours AND one regular event', () => {
  const context = { subscriptionPlan: 'friendship-2', boost: true, dailyQuota: 'used' } as const;
  assert.equal(method('training', { ...context, dailyUsage: 'game-two-hours' }, 'boost').amount, 0);
  assert.equal(method('tournament', { ...context, dailyUsage: 'game-two-hours' }, 'boost').amount, 0);
  assert.equal(method('game', { ...context, durationMinutes: 120, dailyUsage: 'training' }, 'boost').amount, 0);
  assert.equal(method('training', { ...context, dailyUsage: 'training' }, 'boost').amount, 2750);
  assert.equal(method('game', { ...context, durationMinutes: 120, dailyUsage: 'game-hour-event' }, 'boost').amount, 700);
  assert.equal(method('tournament', { ...context, dailyUsage: 'game-two-hours-event' }, 'boost').amount, 4000);
});

test('only RA or Friendship 2.0 plus Boost covers PRO, once per day; limits never grant PRO discounts', () => {
  for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    for (const service of ['training', 'tournament'] as const) {
      const context = { subscriptionPlan, proDirection: true };
      assert.equal(method(service, context).mode, 'unavailable');
      assert.equal(method(service, context, 'residency', resident).mode, 'unavailable');
      assert.equal(method(service, { ...context, boost: true }, 'boost').mode, subscriptionPlan === 'friendship' ? 'unavailable' : 'book');
      for (const limit of [{ proQuotaUsed: true }, { activeLimitExceeded: true }]) {
        assert.equal(method(service, { ...context, boost: true, ...limit }, 'boost').mode, 'unavailable');
      }
    }
  }
});

test('excluded groups hide all free/discount privilege methods even with Boost; base stays payable', () => {
  for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    const list = options('training', { subscriptionPlan, boost: true, excludedGroups: true });
    for (const kind of ['boost', 'subscription', 'residency']) assert.equal(list.find(option => option.kind === kind)?.mode, 'unavailable');
    assert.equal(list.find(option => option.kind === 'full')?.mode, 'book');
  }
});

test('PRO consumes a slot inside the common Boost daily quota, never an additional event', () => {
  const context = { boost: true, dailyQuota: 'used' } as const;
  // RA: a two-hour game consumes both slots; a one-hour game leaves one PRO.
  assert.equal(method('training', { ...context, subscriptionPlan: 'ra', proDirection: true, dailyUsage: 'game-two-hours' }, 'boost').mode, 'unavailable');
  assert.equal(method('training', { ...context, subscriptionPlan: 'ra', proDirection: true, dailyUsage: 'game-hour' }, 'boost').amount, 0);
  assert.equal(method('training', { ...context, subscriptionPlan: 'ra', dailyUsage: 'pro' }, 'boost').amount, 0);
  assert.equal(method('game', { ...context, subscriptionPlan: 'ra', dailyUsage: 'pro', durationMinutes: 120 }, 'boost').amount, 700);
  assert.equal(method('tournament', { ...context, subscriptionPlan: 'ra', dailyUsage: 'game-hour-pro' }, 'boost').amount, 4000);
  // Friendship 2.0: two-hour game plus PRO uses the entire allowance.
  const twoHours = { ...context, subscriptionPlan: 'friendship-2' } as const;
  assert.equal(method('training', { ...twoHours, proDirection: true, dailyUsage: 'game-two-hours' }, 'boost').amount, 0);
  assert.equal(method('training', { ...twoHours, proDirection: true, dailyUsage: 'training' }, 'boost').mode, 'unavailable');
  assert.equal(method('training', { ...twoHours, dailyUsage: 'game-two-hours-pro' }, 'boost').amount, 2750);
  assert.equal(method('tournament', { ...twoHours, dailyUsage: 'game-two-hours-pro' }, 'boost').amount, 4000);
  assert.equal(method('game', { ...twoHours, dailyUsage: 'pro', durationMinutes: 120 }, 'boost').amount, 0);
  for (const subscriptionPlan of ['ra', 'friendship-2'] as const) {
    assert.equal(method('training', { ...context, subscriptionPlan, proDirection: true, dailyUsage: 'pro' }, 'boost').mode, 'unavailable');
  }
  // Standalone legacy counter also consumes a slot, without double counting presets.
  assert.equal(method('training', { ...twoHours, dailyUsage: 'none', proQuotaUsed: true }, 'boost').amount, 2750);
  assert.equal(method('training', { ...context, subscriptionPlan: 'ra', dailyUsage: 'pro', proQuotaUsed: true }, 'boost').amount, 0);
});

test('personal game starts with the better Boost benefit and creates a free local order', () => {
  const list = withPersonalSubscription(options('game', { durationMinutes: 120, boost: true }), true);
  assert.equal(list.filter(option => option.mode === 'book')[0].kind, 'boost');
  assert.equal(new Set(list.map(option => option.kind)).size, list.length);
  assert.deepEqual(createPreviewOrder(list.find(option => option.kind === 'boost')!), { method: 'boost', bookingAmount: 0, product: null, productAmount: 0, total: 0 });
});
