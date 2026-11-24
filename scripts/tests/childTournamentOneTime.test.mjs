import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isChildTournamentExercise } from '../../src/utils/tournamentSubscriptionDiscount.ts';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const preview = read('../nodered_subscription_price_preview_nodes/router.js');
const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
const hooks = read('../nodered_lk1_hub_nodes/gateway_hooks.js');
const booking = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

const childDirections = [
  { direction: { id: 7108 } },
  { exerciseDirection: { directionId: '7108' } },
  { directionId: 7108 },
  { exerciseDirectionId: '7108' },
  { direction: 7108 },
];
const sibling = { direction: { id: 2617, name: 'Детский турнир' }, type: { id: 839 } };

test('checkout identifies the direction without relying on the title or tournament type', () => {
  for (const exercise of childDirections) assert.equal(isChildTournamentExercise(exercise), true);
  for (const exercise of [sibling, { directionId: 7108.1 }, null]) assert.equal(isChildTournamentExercise(exercise), false);
});

test('preview clears all subscription quotes for the child direction and continues for its neighbour', () => {
  const resolver = between(preview, 'const previewDirectionId =', '\n};') + '\n};';
  const step = between(preview, "if (ctx.step === 'groupExercise') {", "if (ctx.step === 'game') {");
  const run = new Function('ctx', 'msg', 'canonical', 'ok', 'eventRoute', 'out', 'http', resolver + '\n' + step);
  const finalize = new Function('msg', 'global', read('../nodered_subscription_price_preview_nodes/final.js'));
  const exercise = { id: 'fixture-event', studioId: 'fixture-studio', timeFrom: '2099-11-23T07:00:00+03:00' };
  const canonical = {
    unwrapRecord: value => value, eventStartsAt: event => event.timeFrom, eventDurationMinutes: () => 90,
    resolveCategory: () => 'tournament', exerciseRoomId: () => 'fixture-room',
    managedExternalEventTypeId: () => 'fixture-tournament-type', isObj: value => value !== null && typeof value === 'object',
    isSpanishTrainingExercise: () => false,
  };
  for (const direction of childDirections) {
    const ctx = { step: 'groupExercise', exerciseId: exercise.id, quotes: [{ amountMinor: 0 }] };
    const msg = { payload: { ...exercise, ...direction }, statusCode: 200, _subscriptionPricePreview: ctx };
    assert.equal(run(ctx, msg, canonical, () => true, { category: 'tournament' }, index => index,
      () => assert.fail('must not read subscriptions or invoke the provider')), 4);
    const result = finalize(msg, undefined);
    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.payload.quotes, []);
    assert.match(result.headers['Cache-Control'], /no-store/);
  }
  const ctx = { step: 'groupExercise', exerciseId: exercise.id, target: {} };
  assert.equal(run(ctx, { payload: { ...exercise, ...sibling }, statusCode: 200 }, {
    ...canonical, isProTrainingExercise: () => false,
  }, () => true, { category: 'tournament' }, () => assert.fail('sibling must still be evaluated'), step => step), 'subscriptions');
});

test('fresh, managed recheck and legacy recheck refuse subscription writes for the child direction', () => {
  const resolver = between(gateway, 'const exerciseDirectionId =', '\n};') + '\n};';
  const quote = between(gateway, 'const lk1Quote =', '  // The station');
  const fresh = between(hooks, 'if (exerciseDirectionId(exercise) === 7108) {', '// Resolve the instance first.');
  const recheck = between(booking.slice(booking.indexOf('if (ctx.step === "exercise_recheck")')), '  const direction = exercise?.direction ?? exercise?.exerciseDirection;',
    '  const actualExerciseId = toStr(exercise?.id || exercise?.exerciseId || exercise?.uuid);');
  const isObj = value => value !== null && typeof value === 'object';
  const runQuote = new Function('isObj', 'isSpanishTrainingExercise',
    resolver + '\n' + quote + '\n}; return lk1Quote;')(isObj, () => false);
  const runFresh = new Function('isObj', 'finishError', 'ctx', 'exercise', resolver + '\n' + fresh);
  const runRecheck = new Function('isObj', 'prepareFailedUpdate', 'ctx', 'exercise', recheck);
  const refused = (_ctx, status, _message, code) => ({ status, code: code?.code ?? code });
  const code = 'CHILD_TOURNAMENT_SUBSCRIPTION_UNAVAILABLE';
  for (const exercise of childDirections) {
    assert.deepEqual(runQuote({}, exercise, []), { code });
    assert.deepEqual(runFresh(isObj, refused, {}, exercise), { status: 409, code });
    assert.deepEqual(runRecheck(isObj, refused, {}, exercise), { status: 409, code });
  }
  assert.equal(runQuote({}, sibling, []), undefined);
  assert.equal(runFresh(isObj, refused, {}, sibling), undefined);
  assert.equal(runRecheck(isObj, refused, {}, sibling), undefined);
});

test('kids academy permits only a proven visit pack while the monetary preview returns no quote', () => {
  const collect = between(booking, 'const collectExactProductIds =', 'const collectSubscriptionPurchaseDateEvidence =');
  const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : null;
  const excludes = new Function('isObj', 'normalizeId', collect + '\nreturn kidsTrainingExcludesSubscription;')(isObj, normalize);
  const pack = '4d43f97e-c71e-450b-8b99-02db47b4a64f';
  const piterPack = '707b5c25-86e3-4ce7-a509-03fee3d193f1';
  const piterStudio = '1ea77cbf-bc36-49a1-96d6-f35c216a409b';
  const expected = 'KIDS_TRAINING_SUBSCRIPTION_UNAVAILABLE';
  const fresh = between(hooks, 'if (kidsTrainingExcludesSubscription(exercise, selectedOwned)) {', 'const proTrainingEnergyAllowed');
  const recheck = between(booking, '  if (kidsTrainingExcludesSubscription(exercise, ownedSubscriptions)) {\n    return prepareFailedUpdate',
    '  if (!exercise || ownedSubscriptions.length === 0)');
  const compile = (code, fn, read) => new Function('kidsTrainingExcludesSubscription', fn, 'ctx', 'exercise', read, code);
  const status = (_ctx, value, _message, code) => [value, code?.code ?? code];
  const previewStep = between(preview, "if (ctx.step === 'groupExercise') {", "if (ctx.step === 'game') {");
  const previewDirection = between(preview, 'const previewDirectionId =', '\n};') + '\n};';
  const runPreview = new Function('ctx', 'msg', 'canonical', 'ok', 'eventRoute', 'out', 'http', previewDirection + '\n' + previewStep);
  const canonical = {
    isObj, unwrapRecord: value => value, eventStartsAt: value => value.timeFrom, eventDurationMinutes: () => 60,
    resolveCategory: () => 'group_training', exerciseRoomId: () => 'fixture-room', managedExternalEventTypeId: () => 'fixture-type',
    isSpanishTrainingExercise: () => false, isProTrainingExercise: () => false,
  };
  for (const id of [2468, 2975, 3163, 6234]) {
    const exercise = { id: 'fixture', exerciseDirectionId: String(id), studioId: 'fixture-studio', timeFrom: '2099-11-25T17:00:00+03:00' };
    const ctx = { step: 'groupExercise', exerciseId: exercise.id, target: {}, quotes: [{ amountMinor: 0 }] };
    const child = id !== 6234;
    assert.equal(runPreview(ctx, { payload: exercise, statusCode: 200 }, canonical, () => true,
      { category: 'group_training' }, index => index, step => step), child ? 4 : 'subscriptions');
    if (child) assert.deepEqual(ctx.quotes, []);
    for (const [fragment, fn, rows] of [[fresh, 'finishError', 'selectedOwned'], [recheck, 'prepareFailedUpdate', 'ownedSubscriptions']]) {
      const run = compile(fragment, fn, rows);
      for (const deny of [[], [{ productId: 'adult' }], [{ productId: pack, product: { id: 'conflict' } }],
        [{ productId: pack }, { productId: pack }]]) {
        assert.deepEqual(run(excludes, status, {}, exercise, deny), child ? [409, expected] : undefined);
      }
      assert.equal(run(excludes, status, {}, exercise, [{ product: { id: pack } }]), undefined);
      const piter = { ...exercise, studioId: piterStudio };
      const localSubscription = [{ productId: piterPack }];
      assert.equal(run(excludes, status, {}, piter, localSubscription), undefined);
      for (const notPiter of [exercise, { ...exercise, studioId: undefined },
        { ...exercise, studioId: [piterStudio] }, { ...piter, studio: { id: 'conflict' } }]) {
        assert.deepEqual(run(excludes, status, {}, notPiter, localSubscription), child ? [409, expected] : undefined);
      }
      assert.deepEqual(run(excludes, status, {}, piter, [{ productId: piterPack, templateId: pack }]),
        child ? [409, expected] : undefined);
    }
  }
});
