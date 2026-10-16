import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const moduleUrl = new URL('../patch_live_lk1_pulkovo_friendship.mjs', import.meta.url);
const livePath = process.env.PULKOVO_LIVE_FLOW;

test('actual installed history step refuses a second Pulkovo game in the same day', { skip: !livePath }, async () => {
  const { composePulkovoArtifacts } = await import(moduleUrl);
  const { candidateBytes } = composePulkovoArtifacts(fs.readFileSync(livePath));
  const source = JSON.parse(candidateBytes).find(node => node.id === 'lk_subscription_booking_router_20260804').func;
  const execute = new Function('msg', 'global', source);
  const booking = { id: 'fixture-booking', paymentType: 'SUBSCRIPTION', clientSubscriptionId: 'fixture-sub',
    exerciseId: 'fixture-previous', exerciseDate: '2026-10-17', exerciseType: { id: 2349 },
    exerciseDirection: { id: 6182 }, timeFrom: '10:00:00', timeTo: '11:00:00' };
  for (const category of ['open_game', 'tournament']) {
    const msg = { statusCode: 200, payload: [booking], _subscriptionBooking: {
      caller: 'http', step: 'history_bookings', tenantKey: 'fixture', operationId: 'fixture-operation',
      exerciseId: 'fixture-next', clientSubscriptionId: 'fixture-sub', actorClientId: 'fixture-actor',
      serviceDate: '2026-10-17', category, planKey: 'friendship', trackedDailyLimit: true,
      limitMode: 'shared_day', operationKey: 'fixture:fixture-sub:2026-10-17', studioId: 'fixture-station',
      managedEnforcement: { enabled: false } } };
    const out = execute(msg, { get: key => key === 'vivacrm_access_token' ? 'fixture-service-token' : undefined });
    assert.equal(out[4]?.payload?.details?.code, 'SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED', category);
  }
});

test('real resolver preserves ordinary Friendship purchase cutoff and refuses unknown purchase dates', async () => {
  const { buildPulkovoTransition, PULKOVO_PRODUCT_ID, FRIENDSHIP_PRODUCT_ID } = await import(moduleUrl);
  const source = fs.readFileSync(new URL('../lib/lk1PlanRules.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const ordinary = { productId: FRIENDSHIP_PRODUCT_ID, planKey: 'friendship', enforceFrom: '2026-09-01',
    maxActiveBookings: 8, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
    groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const { desired } = buildPulkovoTransition({ formatVersion: 1, rules: [ordinary] });
  for (const [dates, legacy, code] of [[['2026-08-31'], true, undefined], [['2026-09-01'], false, undefined],
    [['2026-10-16'], false, undefined], [[], undefined, 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED']]) {
    const resolve = new Function('normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence',
      'isValidDateKey', 'lk1ReadBoundPolicy', 'global', source + '\nreturn resolveLk1Rule;')(
      value => typeof value === 'string' ? value.trim().toLowerCase() : null, () => [],
      () => ({ dates, invalid: false }), value => /^\d{4}-\d{2}-\d{2}$/.test(value), () => null, { get: () => undefined });
    const result = resolve({ owned: [{ productId: PULKOVO_PRODUCT_ID }], planRules: desired });
    assert.equal(result.matched, true);
    assert.equal(result.legacy, legacy);
    assert.equal(result.code, code);
  }
});


test('Pulkovo receives exactly the installed ordinary Friendship rule, preserving all prior rules', async () => {
  assert.equal(fs.existsSync(moduleUrl), true, 'Pulkovo migration is not implemented');
  const { buildPulkovoTransition, PULKOVO_PRODUCT_ID } = await import(moduleUrl);
  const ordinary = { productId: 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b', planKey: 'friendship',
    enforceFrom: '2026-09-01', maxActiveBookings: 8, freeGameMinutesPerDay: 60,
    gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const prior = { formatVersion: 1, rules: [ordinary, { ...ordinary,
    productId: '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e', planKey: 'friendship_two_hours', freeGameMinutesPerDay: 120 }] };
  const saved = structuredClone(prior);
  const transition = buildPulkovoTransition(prior);
  assert.deepEqual(prior, saved);
  assert.deepEqual(transition.desired.rules, [...saved.rules, { ...ordinary, productId: PULKOVO_PRODUCT_ID }]);
  const values = new Map([['subscriptions_lk1_plan_rules', prior]]);
  const global = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  new Function('global', transition.initialize)(global);
  assert.deepEqual(values.get('subscriptions_lk1_plan_rules'), transition.desired);
  new Function('global', transition.initialize)(global);
  assert.deepEqual(values.get('subscriptions_lk1_plan_rules'), transition.desired);
  values.clear();
  new Function('global', transition.initialize)(global);
  assert.deepEqual(values.get('subscriptions_lk1_plan_rules'), transition.desired);
  values.set('subscriptions_lk1_plan_rules', { formatVersion: 1, rules: [] });
  assert.throws(() => new Function('global', transition.initialize)(global), /prior mismatch/);
  assert.throws(() => buildPulkovoTransition({ formatVersion: 1, rules: [] }), /ordinary Friendship/);
  assert.throws(() => buildPulkovoTransition(transition.desired), /already/);
});

test('live graph composition and paired revert preserve unrelated bytes', { skip: !livePath }, async () => {
  const { composePulkovoArtifacts, revertPulkovoArtifacts, PULKOVO_PRODUCT_ID } = await import(moduleUrl);
  const raw = fs.readFileSync(livePath);
  const { candidateBytes, contract, transition } = composePulkovoArtifacts(raw);
  const before = JSON.parse(raw);
  const after = JSON.parse(candidateBytes);
  assert.equal(after.length, before.length);
  assert.deepEqual(transition.desired.rules.slice(0, -1), transition.expectedPrior.rules);
  assert.equal(transition.desired.rules.at(-1).productId, PULKOVO_PRODUCT_ID);
  const changes = after.flatMap((node, i) => Object.keys(node)
    .filter(key => JSON.stringify(node[key]) !== JSON.stringify(before[i][key]))
    .map(field => `${node.id}.${field}`));
  assert.deepEqual(changes.sort(), ['lk_subscription_booking_router_20260804.func',
    'lk_subscription_booking_router_20260804.initialize', 'lk_subscription_price_preview_20260908_router.func'].sort());
  assert.ok(contract);
  assert.deepEqual(revertPulkovoArtifacts(raw, candidateBytes), raw);
  assert.throws(() => composePulkovoArtifacts(Buffer.from(raw.toString() + ' ')), /preimage/);
  assert.throws(() => composePulkovoArtifacts(candidateBytes), /preimage/);
});

test('both installed routers resolve unnamed Pulkovo records into the ordinary daily seat', { skip: !livePath }, async () => {
  const { composePulkovoArtifacts, PULKOVO_NODE_IDS, PULKOVO_PRODUCT_ID } = await import(moduleUrl);
  const { candidateBytes } = composePulkovoArtifacts(fs.readFileSync(livePath));
  for (const id of Object.values(PULKOVO_NODE_IDS)) {
    const source = JSON.parse(candidateBytes).find(node => node.id === id).func;
    const a = source.indexOf('const PLAN_PRODUCT_IDS');
    const b = source.indexOf('function normalizeServiceDateMoscow', a);
    const api = new Function('isObj', 'toStr', 'normalizeId', 'normalizeMarker', 'SHARED_LIMIT_FROM',
      source.slice(a, b) + '\nreturn { resolvePlanKey, resolveCategory, resolveLimitMode, PLAN_CATEGORIES };')(
      value => value !== null && typeof value === 'object' && !Array.isArray(value),
      value => value === null || value === undefined ? null : String(value).trim() || null,
      value => String(value ?? '').trim().toLowerCase(),
      value => String(value ?? '').toLowerCase().replace(/[^a-z0-9а-я]+/gi, ''), '2026-08-01');
    for (const record of [{ productId: PULKOVO_PRODUCT_ID }, { product: { id: PULKOVO_PRODUCT_ID } },
      { name: 'Дружба.Пулково' }]) {
      assert.equal(api.resolvePlanKey(record), 'friendship', id);
    }
    assert.equal(api.resolveLimitMode('friendship', '2026-10-17'), 'shared_day');
    assert.deepEqual(api.PLAN_CATEGORIES.friendship, ['open_game', 'tournament']);
    for (const [direction, category] of [[6182, 'open_game'], [6246, 'tournament']]) {
      assert.equal(api.resolveCategory({ type: { id: 2349 }, direction: { id: direction } }), category, id);
      assert.equal(api.resolveCategory({ type: { id: 9999 }, direction: { id: direction } }), null, id);
    }
    assert.equal(api.resolveCategory({ type: { id: 2349 }, direction: { id: 9999 } }), null);
  }
});

test('installed evaluator quotes Pulkovo exactly like ordinary Friendship at the cap and minute boundaries', { skip: !livePath }, async () => {
  const { composePulkovoArtifacts, PULKOVO_PRODUCT_ID, FRIENDSHIP_PRODUCT_ID } = await import(moduleUrl);
  const { candidateBytes, transition } = composePulkovoArtifacts(fs.readFileSync(livePath));
  const source = JSON.parse(candidateBytes).find(node => node.id === 'lk_subscription_managed_policy_20260820').func;
  const evaluate = (productId, category, durationMinutes, activeServices) => {
    const input = {
      evaluatedAt: '2026-10-16T09:00:00.000Z',
      action: { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING', TOURNAMENT: 'BOOK_TOURNAMENT' }[category],
      lk1Policy: transition.desired.rules.find(rule => rule.productId === productId),
      lk1ProductBinding: { policyProductId: productId, ownedProductId: productId, clientSubscriptionId: 'fixture:pulkovo' },
      target: { resolutionSource: 'SERVER', category, externalEventTypeId: category === 'TOURNAMENT'
        ? 'viva:direction:6246:type:2349' : 'viva:direction:6182:type:2349',
      stationId: 'fixture-station', eventId: 'fixture-event', durationMinutes,
      startsAt: '2026-10-17T08:00:00.000Z', basePriceMinor: 300000,
      currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF' },
      usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY', dailyBucketLocalDate: '2026-10-17',
        activeServices, usedOrReservedFreeMinutesToday: 0, freeFirstEvent: { covered: false } },
    };
    const msg = { _managedSubscriptionPolicyInput: input };
    const output = new Function('msg', source)(msg);
    return (output[0] || output[1])._managedSubscriptionPolicyDecision;
  };
  for (const category of ['GAME', 'GROUP_TRAINING', 'TOURNAMENT']) {
    for (const minutes of [60, 90, 120]) {
      for (const active of [0, 7, 8]) {
        const pulkovo = evaluate(PULKOVO_PRODUCT_ID, category, minutes, active);
        const ordinary = evaluate(FRIENDSHIP_PRODUCT_ID, category, minutes, active);
        assert.equal(pulkovo.eligible, true, JSON.stringify(pulkovo));
        // The binding identity in the decision is allowed to differ, not the benefit.
        for (const key of ['subscriptionVisitCount', 'gameMinutes', 'eventDiscountPercent', 'benefit']) {
          assert.deepEqual(pulkovo[key], ordinary[key], `${category}/${minutes}/${active}/${key}`);
        }
        if (category === 'GAME') {
          assert.equal(pulkovo.gameMinutes.freeMinutes, active >= 8 ? 0 : 60);
          assert.equal(pulkovo.gameMinutes.discountPercent, 30);
        } else {
          assert.equal(pulkovo.subscriptionVisitCount, 0);
          assert.equal(pulkovo.eventDiscountPercent, 50);
        }
      }
    }
  }
});
