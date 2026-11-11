import assert from 'node:assert/strict';
import test from 'node:test';
import { bookingButtonText, combineResidencyBoost, combineSubscriptionBoost, createPreviewOrder, defaultPaymentOption, isSelectableMethod, passBalanceText, readPassRemaining, readResidencyPrice, trainingCount, withPassBalance, withPersonalSubscription, withoutRedundantBoost } from './bookingCheckout.ts';
import { buildBookingPaymentOptions, PRIVILEGE_PROFILES, readMatrixSettings, type PaymentOption } from './paymentMatrix.ts';

test('subscription and Boost become one card using the lower quote and preserving the entitlement method', () => {
  for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    for (const durationMinutes of [60, 90, 120]) {
      const profile = PRIVILEGE_PROFILES[2];
      const raw = buildBookingPaymentOptions('game', profile, { subscription: true, pass: false },
        { subscriptionPlan, boost: true, durationMinutes }, 'quarter', durationMinutes / 60 * 4000);
      const base = raw.find(option => option.kind === 'subscription')!;
      const boost = raw.find(option => option.kind === 'boost')!;
      const options = combineSubscriptionBoost(raw, profile);
      const combined = options.find(option => option.withSubscription)!;
      assert.equal(options.filter(option => option.kind === 'subscription' || option.kind === 'boost').length, 1);
      assert.equal(combined.amount, Math.min(base.amount!, boost.amount!));
      assert.equal(combined.kind, base.amount! <= boost.amount! ? 'subscription' : 'boost');
      assert.equal(defaultPaymentOption(options)?.kind, 'residency', 'Residency retains the explicitly requested default');
      assert.equal(createPreviewOrder(combined)?.method, combined.kind);
      assert.equal(createPreviewOrder(combined)?.product, null, 'Owned products are never purchased again');
      assert.equal(raw.some(option => option.withSubscription), false);
    }
  }
});

test('a combined subscription keeps the exact paid copay and uses Boost for expanded event coverage', () => {
  const profile = PRIVILEGE_PROFILES[2];
  const raw = buildBookingPaymentOptions('game', profile, { subscription: true, pass: false },
    { subscriptionPlan: 'friendship-2', boost: true, durationMinutes: 90, dailyQuota: 'used', dailyUsage: 'game-hour' }, 'quarter', 6000);
  const combined = combineSubscriptionBoost(raw, profile).find(option => option.withSubscription)!;
  assert.equal(combined.amount, 350);
  assert.deepEqual(createPreviewOrder(combined), { method: 'boost', bookingAmount: 350, product: null, productAmount: 0, total: 350 });
  for (const service of ['training', 'tournament'] as const) {
    const event = buildBookingPaymentOptions(service, profile, { subscription: true, pass: false }, { subscriptionPlan: 'friendship', boost: true });
    const free = combineSubscriptionBoost(event, profile).find(option => option.withSubscription)!;
    assert.equal(free.kind, 'boost');
    assert.equal(free.amount, 0);
  }
  const pro = buildBookingPaymentOptions('training', profile, { subscription: true, pass: false }, { subscriptionPlan: 'ra', boost: true, proDirection: true });
  assert.equal(pro.find(option => option.kind === 'subscription')?.mode, 'unavailable');
  const freePro = combineSubscriptionBoost(pro, profile).find(option => option.withSubscription)!;
  assert.equal(freePro.kind, 'boost');
  assert.equal(freePro.amount, 0);
});

test('when both products give the same discount, the combined card keeps the subscription method', () => {
  const profile = PRIVILEGE_PROFILES[3];
  const raw = buildBookingPaymentOptions('game', profile, { subscription: true, pass: true },
    { subscriptionPlan: 'ra', boost: true, durationMinutes: 90, dailyQuota: 'used', dailyUsage: 'two-events' }, 'quarter', 6000);
  const options = combineResidencyBoost(combineSubscriptionBoost(raw, profile), profile);
  const combined = options.find(option => option.withSubscription)!;
  assert.equal(combined.kind, 'subscription');
  assert.equal(combined.amount, 1050);
  assert.equal(combined.withResidency, undefined);
  assert.ok(options.some(option => option.kind === 'residency'));
  const lower: PaymentOption[] = [{ kind: 'subscription', mode: 'book', amount: 0 }, { kind: 'boost', mode: 'book', amount: 350 }];
  assert.equal(combineSubscriptionBoost(lower, profile).find(option => option.withSubscription)?.amount, 0);
});

test('combining a subscription never grants ownership, removes an unknown-price fallback or discounts a whole court', () => {
  const paid: PaymentOption = { kind: 'subscription', mode: 'book', amount: 350 };
  for (const amount of [null, NaN, Infinity, -1]) {
    const options: PaymentOption[] = [paid, { kind: 'boost', mode: 'book', amount }];
    assert.equal(combineSubscriptionBoost(options, PRIVILEGE_PROFILES[2]), options);
  }
  for (const mode of ['offer', 'quote', 'unavailable', 'reference'] as const) {
    const options: PaymentOption[] = [paid, { kind: 'boost', mode, amount: 0 }];
    assert.equal(combineSubscriptionBoost(options, PRIVILEGE_PROFILES[2]), options);
  }
  const unowned: PaymentOption[] = [{ kind: 'subscription', mode: 'offer', amount: 0 }, { kind: 'boost', mode: 'book', amount: 0 }];
  assert.equal(combineSubscriptionBoost(unowned, PRIVILEGE_PROFILES[1]), unowned);
  const court = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[7], { subscription: true, pass: true }, { boost: true }, 'court', 8000);
  assert.equal(combineSubscriptionBoost(court, PRIVILEGE_PROFILES[7]), court);
  assert.deepEqual(court, [{ kind: 'full', mode: 'book', amount: 8000 }]);
});

test('residency-backed Boost is one default final method with the actual duration-dependent quote', () => {
  const profile = PRIVILEGE_PROFILES[1];
  for (const [durationMinutes, expected] of [[60, 0], [90, 350], [120, 700]]) {
    const raw = buildBookingPaymentOptions('game', profile, { subscription: true, pass: false },
      { subscriptionPlan: 'friendship-2', boost: true, dailyQuota: 'available', durationMinutes }, 'quarter', durationMinutes / 60 * 4000);
    const options = combineResidencyBoost(raw, profile);
    assert.equal(options.filter(option => option.kind === 'boost').length, 1);
    assert.equal(options.some(option => option.kind === 'residency'), false);
    const choice = defaultPaymentOption(options)!;
    assert.equal(choice.kind, 'boost', 'Presentation must not change the actual entitlement method to residency');
    assert.equal(choice.withResidency, true);
    assert.equal(choice.amount, expected);
    assert.deepEqual(createPreviewOrder(choice), { method: 'boost', bookingAmount: expected, product: null, productAmount: 0, total: expected });
    assert.equal(raw.some(option => option.withResidency), false, 'Source quotes must remain unchanged');
  }
});

test('residency-backed Boost also combines event quotes and retains discounts after use', () => {
  for (const [service, price] of [['training', 2750], ['tournament', 4000]] as const) {
    for (const dailyQuota of ['available', 'used'] as const) {
      const profile = PRIVILEGE_PROFILES[1];
      const raw = buildBookingPaymentOptions(service, profile, { subscription: true, pass: false },
        { boost: true, subscriptionPlan: 'ra', dailyQuota, dailyUsage: dailyQuota === 'used' ? 'training' : 'none' });
      const options = combineResidencyBoost(raw, profile);
      assert.equal(options.filter(option => option.withResidency).length, 1);
      assert.equal(defaultPaymentOption(options)?.amount, dailyQuota === 'used' ? price : 0);
      assert.ok(!options.some(option => option.kind === 'residency'));
    }
  }
});

test('subscription-backed Boost, missing residency, exclusions and whole-court payment keep their own methods', () => {
  for (const profile of [PRIVILEGE_PROFILES[0], PRIVILEGE_PROFILES[2], PRIVILEGE_PROFILES[3]]) {
    const raw = buildBookingPaymentOptions('game', profile, { subscription: true, pass: false }, { boost: true, subscriptionPlan: 'ra', durationMinutes: 120 }, 'quarter', 8000);
    assert.equal(combineResidencyBoost(raw, profile), raw);
  }
  for (const proDirection of [false, true]) {
    const profile = PRIVILEGE_PROFILES[1];
    const raw = buildBookingPaymentOptions('training', profile, { subscription: true, pass: false }, { boost: true, subscriptionPlan: 'ra', excludedGroups: !proDirection, proDirection });
    assert.equal(combineResidencyBoost(raw, profile), raw);
  }
  const raw = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[1], { subscription: true, pass: false }, { boost: true }, 'court', 8000);
  assert.deepEqual(defaultPaymentOption(combineResidencyBoost(raw, PRIVILEGE_PROFILES[1])), { kind: 'full', mode: 'book', amount: 8000 });
});

test('unknown Boost prices or unavailable Boost never replace a priced residency fallback', () => {
  const residency: PaymentOption = { kind: 'residency', mode: 'book', amount: 700 };
  for (const amount of [null, NaN, Infinity, -1]) {
    const options: PaymentOption[] = [residency, { kind: 'boost', mode: 'book', amount }];
    assert.equal(combineResidencyBoost(options, PRIVILEGE_PROFILES[1]), options);
    assert.equal(defaultPaymentOption(options), residency);
  }
  for (const mode of ['quote', 'offer', 'unavailable', 'reference'] as const) {
    const options: PaymentOption[] = [residency, { kind: 'boost', mode, amount: 0 }];
    assert.equal(combineResidencyBoost(options, PRIVILEGE_PROFILES[1]), options);
  }
});

test('Friendship 2.0 hides duplicate free Boost in games while retaining its extra free group/tournament option', () => {
  const settings = readMatrixSettings(new URLSearchParams('subscription=1&residency=0&pass=0&boost=1&subscriptionPlan=friendship-2&dailyQuota=available'));
  for (const service of ['game', 'training', 'tournament'] as const) {
    const raw = buildBookingPaymentOptions(service, settings.profile, settings.applicability, { ...settings, durationMinutes: 90 }, service === 'game' ? 'quarter' : undefined, 4000);
    const visible = withoutRedundantBoost(raw);
    assert.equal(visible.some(option => option.kind === 'boost'), service !== 'game');
    assert.equal(visible.find(option => option.kind === 'subscription')?.amount, service === 'game' ? 0 : service === 'training' ? 2750 : 4000);
    assert.equal(defaultPaymentOption(visible)?.kind, 'residency');
    if (service === 'game') {
      assert.equal(visible.filter(option => option.mode === 'book' && option.amount === 0).length, 1);
      assert.equal(createPreviewOrder(visible.find(option => option.kind === 'subscription')!)?.method, 'subscription');
    }
  }
});

test('duplicate Boost discounts and RA events keep the subscription method and other independent alternatives', () => {
  for (const service of ['training', 'tournament'] as const) {
    for (const dailyQuota of ['available', 'used'] as const) {
      const raw = buildBookingPaymentOptions(service, PRIVILEGE_PROFILES[7], { subscription: true, pass: true },
        { subscriptionPlan: 'ra', boost: true, dailyQuota, dailyUsage: dailyQuota === 'used' ? 'two-events' : 'none' });
      const visible = withoutRedundantBoost(raw);
      assert.ok(!visible.some(option => option.kind === 'boost'));
      for (const kind of ['subscription', 'residency', 'pass']) assert.ok(visible.some(option => option.kind === kind));
    }
  }
});

test('Boost remains distinct when it improves the price, the subscription is unowned or its quote is unknown', () => {
  for (const [subscriptionPlan, dailyUsage, proDirection] of [['friendship', 'none', false], ['friendship-2', 'game-hour', false], ['ra', 'none', true]] as const) {
    const raw = buildBookingPaymentOptions(proDirection ? 'training' : 'game', PRIVILEGE_PROFILES[2], { subscription: true, pass: false },
      { subscriptionPlan, boost: true, durationMinutes: 90, dailyUsage, dailyQuota: dailyUsage === 'none' ? 'available' : 'used', proDirection }, proDirection ? undefined : 'quarter', 6000);
    assert.ok(withoutRedundantBoost(raw).some(option => option.kind === 'boost' && option.mode === 'book'));
  }
  const boost: PaymentOption = { kind: 'boost', mode: 'book', amount: 0 };
  for (const mode of ['offer', 'quote', 'unavailable', 'reference'] as const) {
    const options: PaymentOption[] = [{ kind: 'subscription', mode, amount: 0 }, boost];
    assert.deepEqual(withoutRedundantBoost(options), options);
  }
  for (const amount of [null, NaN, Infinity, -1]) {
    const options: PaymentOption[] = [{ kind: 'subscription', mode: 'book', amount }, { ...boost, amount }];
    assert.deepEqual(withoutRedundantBoost(options), options);
  }
});

test('residency is preselected for every profile and subscription plan, including purchase offers', () => {
  for (const profile of PRIVILEGE_PROFILES) for (const subscriptionPlan of ['friendship', 'friendship-2', 'ra'] as const) {
    for (const service of ['game', 'training', 'tournament'] as const) {
      const options = buildBookingPaymentOptions(service, profile, { subscription: true, pass: true },
        { subscriptionPlan, durationMinutes: 90, boost: true }, service === 'game' ? 'quarter' : undefined, 6000);
      const choice = defaultPaymentOption(service === 'game' ? withPersonalSubscription(options, profile.subscription) : options)!;
      assert.equal(choice.kind, 'residency');
      assert.equal(choice.mode, profile.residency ? 'book' : 'offer');
    }
  }
});

test('default selection skips unavailable residency and retains safe fallbacks', () => {
  const full: PaymentOption = { kind: 'full', mode: 'book', amount: 8000 };
  for (const mode of ['unavailable', 'quote', 'reference'] as const) {
    assert.equal(defaultPaymentOption([{ kind: 'residency', mode, amount: null }, full]), full);
  }
  assert.equal(defaultPaymentOption([]), undefined);
  const excluded = buildBookingPaymentOptions('training', PRIVILEGE_PROFILES[0], { subscription: true, pass: false }, { excludedGroups: true });
  assert.equal(defaultPaymentOption(excluded)?.kind, 'full');
  const pro = buildBookingPaymentOptions('tournament', PRIVILEGE_PROFILES[0], { subscription: true, pass: false }, { subscriptionPlan: 'friendship', proDirection: true });
  assert.equal(defaultPaymentOption(pro)?.kind, 'full');
  const court = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[7], { subscription: true, pass: true }, {}, 'court', 8000);
  assert.deepEqual(defaultPaymentOption(court), full);
});

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
test('an owned game subscription immediately becomes my personal share at the quoted duration price', () => {
  for (const [courtAmount, durationMinutes, amount] of [[4000, 60, 0], [6000, 90, 500], [8000, 120, 1000]]) {
    const options = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[7], { subscription: true, pass: true },
      { subscriptionPlan: 'daily-hour', dailyQuota: 'available', durationMinutes }, 'quarter', courtAmount);
    const display = withPersonalSubscription(options, true);
    const first = display.find(isSelectableMethod)!;
    assert.equal(first.kind, 'subscription', 'An owned pass or residency must not take priority over my subscription');
    assert.equal(first.amount, amount);
    assert.equal(display.find(option => option.kind === 'full')?.mode, 'reference');
    assert.equal(display.find(option => option.kind === 'full')?.amount, courtAmount / 4);
    assert.equal(display.filter(option => option.kind === 'subscription').length, 1);
    assert.equal(createPreviewOrder(first)?.total, amount);
    assert.equal(createPreviewOrder(first)?.product, null, 'An existing subscription is not purchased again');
  }
});
test('after using the daily allowance my personal share keeps the subscription discount', () => {
  const options = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[7], { subscription: true, pass: true },
    { subscriptionPlan: 'daily-hour', dailyQuota: 'used', durationMinutes: 90 }, 'quarter', 6000);
  const choice = withPersonalSubscription(options, true).find(isSelectableMethod)!;
  assert.equal(choice.kind, 'subscription');
  assert.equal(choice.amount, 1050);
});
test('missing, inapplicable or unquoted subscriptions never replace the paid share', () => {
  const noSubscription = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[0], { subscription: true, pass: false }, { subscriptionPlan: 'daily-hour', durationMinutes: 60 }, 'quarter', 4000);
  assert.equal(withPersonalSubscription(noSubscription, false), noSubscription);
  const inapplicable = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[2], { subscription: false, pass: false }, { subscriptionPlan: 'daily-hour' }, 'quarter', 4000);
  assert.equal(withPersonalSubscription(inapplicable, true), inapplicable);
  for (const amount of [null, NaN, Infinity, -1]) {
    const options: PaymentOption[] = [{ kind: 'full', mode: 'book', amount: 1000 }, { kind: 'subscription', mode: 'book', amount }];
    assert.equal(withPersonalSubscription(options, true), options);
  }
  const fullCourt = buildBookingPaymentOptions('game', PRIVILEGE_PROFILES[7], { subscription: true, pass: true }, {}, 'court', 4000);
  assert.equal(withPersonalSubscription(fullCourt, true), fullCourt);
});
test('the reported RA preview URL selects a free personal share despite a stale hourly applicability flag', () => {
  const settings = readMatrixSettings(new URLSearchParams('privileges=subscription&subscriptionFits=0&passFits=0&subscriptionPlan=ra&dailyQuota=available&groupCategory=standard&raFits=1'));
  const context = { ...settings, durationMinutes: 60 };
  const options = withPersonalSubscription(buildBookingPaymentOptions('game', settings.profile, settings.applicability, context, 'quarter', 4000), settings.profile.subscription);
  const choice = options.find(isSelectableMethod)!;
  assert.equal(choice.kind, 'subscription');
  assert.equal(choice.amount, 0);
  assert.equal(bookingButtonText(choice), 'Записаться бесплатно');
  assert.equal(createPreviewOrder(choice)?.product, null);
  assert.deepEqual(buildBookingPaymentOptions('game', settings.profile, settings.applicability, context, 'court', 4000), [{ kind: 'full', mode: 'book', amount: 4000 }]);
});
