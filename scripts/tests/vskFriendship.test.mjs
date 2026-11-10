import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  VSK_FRIENDSHIP_PRODUCT_ID as VSK,
  ORDINARY_FRIENDSHIP_PRODUCT_ID as FRIENDSHIP,
  VSK_FRIENDSHIP_NODE_IDS as IDS,
  buildVskFriendshipTransition,
  patchVskFriendshipRouterBody,
  composeVskFriendshipArtifacts,
  revertVskFriendshipArtifacts,
} from '../patch_live_lk1_vsk_friendship.mjs';

const livePath = process.env.VSK_FRIENDSHIP_LIVE_FLOW;
const ordinary = { productId: FRIENDSHIP, planKey: 'friendship', enforceFrom: '2026-09-01',
  maxActiveBookings: 8, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const prior = { formatVersion: 1, rules: [ordinary, { ...ordinary,
  productId: '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e', planKey: 'friendship_two_hours', freeGameMinutesPerDay: 120 }] };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const globals = initial => {
  const values = new Map(initial ? [['subscriptions_lk1_plan_rules', initial]] : []);
  return { get: key => values.get(key), set: (key, value) => values.set(key, value) };
};

test('Vsk clones the installed ordinary rule and preserves every existing rule', () => {
  const saved = structuredClone(prior);
  const transition = buildVskFriendshipTransition(prior);
  assert.deepEqual(prior, saved);
  assert.deepEqual(transition.desired.rules, [...saved.rules, { ...ordinary, productId: VSK }]);
  assert.equal(transition.desired.rules.at(-1).planKey, 'friendship');
  const changedOrdinary = { ...ordinary, maxActiveBookings: 9, enforceFrom: '2026-10-01' };
  assert.deepEqual(buildVskFriendshipTransition({ formatVersion: 1, rules: [changedOrdinary] }).desired.rules.at(-1),
    { ...changedOrdinary, productId: VSK }, 'copy the reviewed installed rule, not a second numeric policy');
});

test('writer accepts its exact prior, replay and fresh context; foreign state stays untouched', () => {
  const transition = buildVskFriendshipTransition(prior);
  for (const initial of [prior, transition.desired, undefined]) {
    const store = globals(initial);
    new Function('global', transition.initialize)(store);
    assert.deepEqual(store.get('subscriptions_lk1_plan_rules'), transition.desired);
    new Function('global', transition.initialize)(store);
    assert.deepEqual(store.get('subscriptions_lk1_plan_rules'), transition.desired);
  }
  const foreign = { formatVersion: 1, rules: [] };
  const store = globals(foreign);
  assert.throws(() => new Function('global', transition.initialize)(store), /prior mismatch/);
  assert.equal(store.get('subscriptions_lk1_plan_rules'), foreign);
  assert.throws(() => buildVskFriendshipTransition(foreign), /ordinary Friendship/);
  assert.throws(() => buildVskFriendshipTransition({ formatVersion: 1, rules: [{ ...ordinary, planKey: 'other' }] }), /ordinary Friendship/);
  assert.throws(() => buildVskFriendshipTransition(transition.desired), /already present/);
});

test('pure patch helpers fail closed on missing or ambiguous anchors', () => {
  assert.throws(() => patchVskFriendshipRouterBody('return msg;'), /Plan identity anchor drift/);
  const identity = '  const normalized = markers.map(normalizeMarker).filter(Boolean);\n';
  assert.throws(() => patchVskFriendshipRouterBody(identity.repeat(2)), /Plan identity anchor drift/);
  assert.throws(() => patchVskFriendshipRouterBody(identity), /VSK category anchor drift/);
  const category = '  if (typeId === 2349 && directionId === 6181) return "open_game";\n';
  assert.throws(() => patchVskFriendshipRouterBody(identity + category, { preview: true }), /VSK game preview scope anchor drift/);
  assert.throws(() => composeVskFriendshipArtifacts(Buffer.from('[]')), /Live flow preimage drift/);
});

test('the canonical resolver keeps the same purchase cohort and unknown-date refusal', () => {
  const source = fs.readFileSync(new URL('../lib/lk1PlanRules.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const desired = buildVskFriendshipTransition(prior).desired;
  for (const productId of [FRIENDSHIP, VSK]) {
    for (const [purchaseDate, legacy, code] of [['2026-08-31', true], ['2026-09-01', false],
      ['2026-10-21', false], [undefined, undefined, 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED']]) {
      const resolve = new Function('normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence',
        'isValidDateKey', 'lk1ReadBoundPolicy', 'global', source + '\nreturn resolveLk1Rule;')(
        value => typeof value === 'string' ? value.trim().toLowerCase() : null, () => [],
        () => ({ dates: purchaseDate ? [purchaseDate] : [], invalid: false }),
        value => /^\d{4}-\d{2}-\d{2}$/.test(value), () => null, globals());
      const result = resolve({ owned: [{ productId }], planRules: desired });
      assert.equal(result.matched, true);
      assert.equal(result.legacy, legacy);
      assert.equal(result.code, code);
    }
  }
});

let artifacts;
function liveArtifacts() {
  if (!artifacts) {
    const raw = fs.readFileSync(livePath);
    const composed = composeVskFriendshipArtifacts(raw);
    const flow = JSON.parse(composed.candidateBytes);
    artifacts = { ...composed, raw, flow,
      gateway: flow.find(node => node.id === IDS.gateway),
      preview: flow.find(node => node.id === IDS.preview),
      evaluator: flow.find(node => node.id === 'lk_subscription_managed_policy_20260820') };
  }
  return artifacts;
}

function canonicalApi(source, store) {
  return new Function('global', source.slice(0, source.indexOf('const pricing =')) + '\nreturn canonical;')(store);
}

test('private live composition changes only the three allowed fields and restores exact bytes', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const before = JSON.parse(a.raw);
  assert.equal(a.flow.length, 4941);
  assert.equal(a.transition.expectedPrior.rules.length, 11);
  assert.equal(a.transition.desired.rules.length, 12);
  assert.deepEqual(a.transition.desired.rules.slice(0, -1), a.transition.expectedPrior.rules);
  const base = a.transition.expectedPrior.rules.find(rule => rule.productId === FRIENDSHIP);
  assert.deepEqual(a.transition.desired.rules.at(-1), { ...base, productId: VSK });
  const changed = a.flow.flatMap((node, i) => Object.keys(node)
    .filter(key => JSON.stringify(node[key]) !== JSON.stringify(before[i][key])).map(key => `${node.id}.${key}`));
  assert.deepEqual(changed.sort(), [`${IDS.gateway}.func`, `${IDS.gateway}.initialize`, `${IDS.preview}.func`].sort());
  assert.deepEqual(revertVskFriendshipArtifacts(a.raw, a.candidateBytes), a.raw);
  assert.throws(() => composeVskFriendshipArtifacts(Buffer.concat([a.raw, Buffer.from(' ')])), /preimage drift/);
  assert.throws(() => composeVskFriendshipArtifacts(a.candidateBytes), /preimage drift/);
  assert.throws(() => revertVskFriendshipArtifacts(a.raw, Buffer.concat([a.candidateBytes, Buffer.from(' ')])), /Rollback candidate drift/);
  for (const initial of [a.transition.expectedPrior, undefined]) {
    const store = globals(initial);
    new Function('global', a.gateway.initialize)(store);
    assert.deepEqual(store.get('subscriptions_lk1_plan_rules'), a.transition.desired);
  }
});

test('rollback requires a fresh memory context rather than a hot import retaining the new rule', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const original = JSON.parse(a.raw).find(node => node.id === IDS.gateway);
  const retained = globals(a.transition.desired);
  assert.throws(() => new Function('global', original.initialize)(retained), /prior mismatch/);
  assert.deepEqual(retained.get('subscriptions_lk1_plan_rules'), a.transition.desired);
  const restarted = globals();
  new Function('global', original.initialize)(restarted);
  assert.deepEqual(restarted.get('subscriptions_lk1_plan_rules'), a.transition.expectedPrior);
});

test('both installed routers resolve UUID aliases and only the exact corporate pairs', { skip: !livePath }, () => {
  const a = liveArtifacts();
  for (const node of [a.gateway, a.preview]) {
    let api;
    if (node.id === IDS.preview) api = canonicalApi(node.func, globals(a.transition.desired));
    else {
      const start = node.func.indexOf('const PLAN_PRODUCT_IDS');
      const end = node.func.indexOf('function normalizeServiceDateMoscow', start);
      api = new Function('isObj', 'toStr', 'normalizeId', 'normalizeMarker', 'SHARED_LIMIT_FROM',
        node.func.slice(start, end) + '\nreturn { resolvePlanKey, resolveCategory, resolveLimitMode, PLAN_CATEGORIES };')(
        object, value => value == null ? null : String(value).trim() || null,
        value => String(value ?? '').trim().toLowerCase(),
        value => String(value ?? '').toLowerCase().replace(/[^a-z0-9а-я]+/gi, ''), '2026-08-01');
    }
    for (const record of [{ productId: VSK }, { product: { id: VSK } }, { name: 'Дружба.Патриоты' }]) {
      assert.equal(api.resolvePlanKey(record), 'friendship', node.id);
    }
    assert.equal(api.resolvePlanKey({ productId: '82caad6f-4d19-4d01-852b-932bdbb0f405', product: { id: VSK } }), 'sport');
    for (const [directionId, typeId, category] of [[6975, 2349, 'open_game'], [6181, 2349, 'open_game'], [6306, 2349, 'tournament'],
      [6307, 2349, 'group_training'], [5278, 839, 'tournament'], [4588, 1613, 'open_game'],
      [6182, 2349, 'open_game'], [6246, 2349, 'tournament'], [6152, 2349, null], [6307, 2348, null]]) {
      assert.equal(api.resolveCategory({ direction: { id: directionId, name: 'нейтрально' },
        type: { id: typeId, name: 'нейтрально' } }), category, `${node.id}: ${directionId}/${typeId}`);
    }
    assert.deepEqual(api.PLAN_CATEGORIES.friendship, ['open_game', 'tournament']);
    assert.equal(api.resolveLimitMode('friendship', '2026-10-21'), 'shared_day');
  }
});

function evaluate(productId, category, durationMinutes, activeServices, usedMinutes) {
  const a = liveArtifacts();
  const policy = a.transition.desired.rules.find(rule => rule.productId === productId);
  const msg = { _managedSubscriptionPolicyInput: {
    evaluatedAt: '2030-10-21T06:00:00.000Z',
    action: { GAME: 'JOIN_GAME', GROUP_TRAINING: 'BOOK_GROUP_TRAINING', TOURNAMENT: 'BOOK_TOURNAMENT' }[category],
    lk1Policy: policy,
    lk1ProductBinding: { policyProductId: productId, ownedProductId: productId, clientSubscriptionId: 'fixture-subscription' },
    target: { resolutionSource: 'SERVER', category, externalEventTypeId: 'viva:direction:4588:type:1613',
      stationId: 'fixture-station', eventId: 'fixture-exercise', durationMinutes,
      startsAt: '2030-10-22T08:00:00.000Z', basePriceMinor: 300000, currency: 'RUB', priceSource: 'VIVA_EXISTING_TARIFF' },
    usage: { activeServiceScope: 'SUBSCRIPTION_BENEFIT_ONLY', dailyBucketLocalDate: '2030-10-22', activeServices,
      usedOrReservedFreeMinutesToday: usedMinutes, usedOrReservedVisitsToday: usedMinutes ? 1 : 0, freeFirstEvent: { covered: false } },
  } };
  const result = new Function('msg', a.evaluator.func)(msg);
  return result.find(Boolean)._managedSubscriptionPolicyDecision;
}

test('unchanged live evaluator produces identical benefits at minute and cap boundaries', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const api = canonicalApi(a.preview.func, globals(a.transition.desired));
  for (const category of ['group_training', 'tournament']) {
    assert.equal(api.lk1FreeFirstEventCovers(FRIENDSHIP, category, 5278), false);
    assert.equal(api.lk1FreeFirstEventCovers(VSK, category, 5278), false);
  }
  for (const category of ['GAME', 'GROUP_TRAINING', 'TOURNAMENT']) {
    for (const duration of [60, 90, 120]) for (const active of [0, 7, 8]) for (const used of [0, 60]) {
      const ordinaryDecision = evaluate(FRIENDSHIP, category, duration, active, used);
      const vskDecision = evaluate(VSK, category, duration, active, used);
      assert.deepEqual(vskDecision, ordinaryDecision, `${category}/${duration}/${active}/${used}`);
      assert.equal(vskDecision.eligible, true);
      if (category !== 'GAME') {
        assert.equal(vskDecision.benefit.finalPriceMinor, 150000);
        assert.equal(vskDecision.subscriptionVisitCount, 0);
      }
    }
  }
  assert.equal(evaluate(VSK, 'GAME', 90, 0, 0).benefit.finalPriceMinor, 70000);
  assert.equal(evaluate(VSK, 'GAME', 90, 8, 0).benefit.finalPriceMinor, 210000);
});

function previewContext(directionId, typeId, eventCategory) {
  const a = liveArtifacts();
  const subscriptionId = 'fixture-subscription';
  const live = { subscriptionId, productId: VSK, name: 'Дружба.Патриоты',
    clientId: 'fixture-actor', purchaseDate: '2026-10-01', status: 'ACTIVE',
    activationDate: '2026-10-01', expirationDate: '2031-01-01', visitsLeft: 30,
    hasTypeLimitation: true, hasDirectionLimitation: true, hasStudioLimitation: false,
    availableTypes: [{ id: 1613 }, { id: 2349 }], availableDirections: [{ id: 4588 }, { id: 6975 }] };
  const exercise = { id: 'fixture-exercise', direction: { id: directionId }, type: { id: typeId },
    timeFrom: '2030-10-22T11:00:00+03:00', timeTo: '2030-10-22T12:30:00+03:00',
    studio: { id: 'fixture-station' }, room: { id: 'fixture-room' }, availableClientSubscriptions: [live] };
  return { done: false, step: 'next', startedAt: Date.now(), tenantKey: 'fixture', auth: 'fixture-auth',
    actorClientId: 'fixture-actor', exerciseId: exercise.id, exercise,
    existingGame: !eventCategory, eventCategory, target: { targetKind: eventCategory || 'EXISTING_GAME',
      gameId: 'fixture-game', startsAt: exercise.timeFrom, durationMinutes: 90,
      stationId: 'fixture-station', roomId: 'fixture-room' },
    pending: [subscriptionId], subscriptions: { [subscriptionId]: live },
    metadata: { [subscriptionId]: { productId: VSK } }, catalog: { [VSK]: 'Дружба.Патриоты' },
    basePriceMinor: 550000, priceProductId: 'fixture-tariff', selectionKey: 'fixture-selection',
    quotes: [], bookings: [], activeBookings: [], operations: [], ruleProductIds: a.transition.desired.rules.map(rule => rule.productId) };
}

test('actual preview accepts the corporate game scope and retains ordinary game scope', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const run = new Function('msg', 'global', a.preview.func);
  const store = globals(a.transition.desired);
  assert.equal(canonicalApi(a.preview.func, store).supportsPatriotsGameScope, true);
  for (const [directionId, typeId] of [[6975, 2349], [6975, 1613], [4588, 1613]]) {
    const msg = { _subscriptionPricePreview: previewContext(directionId, typeId) };
    const result = run(msg, store);
    assert.ok(result?.some(value => value?._managedSubscriptionPolicyInput), JSON.stringify(msg._subscriptionPricePreview));
  }
  for (const [directionId, typeId] of [[6975, 839], [6181, 2349], [6152, 2349], [6307, 2349]]) {
    const msg = { _subscriptionPricePreview: previewContext(directionId, typeId) };
    run(msg, store);
    assert.equal(msg._subscriptionPricePreview.quotes[0]?.reasonCode, 'EVENT_NOT_INCLUDED');
  }
});

test('actual event preview produces 50 percent quotes including out-of-visit-scope friends', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const run = new Function('msg', 'global', a.preview.func);
  const store = globals(a.transition.desired);
  for (const [directionId, typeId, category] of [[5278, 839, 'TOURNAMENT']]) {
    const msg = { _subscriptionPricePreview: previewContext(directionId, typeId, category) };
    const output = run(msg, store)?.find(value => value?._managedSubscriptionPolicyInput);
    assert.ok(output, JSON.stringify(msg._subscriptionPricePreview));
    new Function('msg', a.evaluator.func)(output);
    assert.equal(output._managedSubscriptionPolicyDecision.subscriptionVisitCount, 0);
    run(output, store);
    const quote = output._subscriptionPricePreview.quotes[0];
    assert.equal(quote.status, 'AVAILABLE');
    assert.equal(quote.discountPercent, 50);
    assert.equal(quote.amountMinor, 275000);
  }
});

test('event preview keeps freeze, expiry and product identity refusals', { skip: !livePath }, () => {
  const a = liveArtifacts();
  const run = new Function('msg', 'global', a.preview.func);
  const store = globals(a.transition.desired);
  for (const patch of [{ isFrozen: true }, { expirationDate: '2026-01-01' },
    { status: 'NEW', activationDate: null, expirationDate: null }]) {
    const ctx = previewContext(5278, 839, 'TOURNAMENT');
    Object.assign(ctx.subscriptions['fixture-subscription'], patch);
    run({ _subscriptionPricePreview: ctx }, store);
    assert.equal(ctx.quotes[0]?.reasonCode, 'LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN');
  }
  const ctx = previewContext(5278, 839, 'TOURNAMENT');
  ctx.subscriptions['fixture-subscription'].product = { id: FRIENDSHIP };
  run({ _subscriptionPricePreview: ctx }, store);
  assert.equal(ctx.error, 'PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED');
});

test('CLI writes only private external artifacts and refuses to overwrite its output', { skip: !livePath }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsk-parity-test-'));
  const output = path.join(temp, 'candidate');
  const script = new URL('../patch_live_lk1_vsk_friendship.mjs', import.meta.url);
  try {
    execFileSync(process.execPath, [fileURLToPath(script), path.resolve(livePath), output]);
    assert.equal(fs.statSync(output).mode & 0o777, 0o700);
    for (const file of ['candidate.flow.json', 'contract.json', 'plan-rules.json']) {
      assert.equal(fs.statSync(path.join(output, file)).mode & 0o777, 0o600);
    }
    assert.throws(() => execFileSync(process.execPath, [fileURLToPath(script), path.resolve(livePath), output], { stdio: 'pipe' }), /Output already exists/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
