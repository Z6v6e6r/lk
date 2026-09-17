// Diagnostics of the subscription price preview's target refusals.
//
// 2026-09-17: `PRICE_PREVIEW_GAME_UNRESOLVED` and `*_TARGET_UNRESOLVED` answered every
// refusal with a bare code, so production traffic could only be guessed at — the burst of
// 47 `PRICE_PREVIEW_GAME_UNRESOLVED` between 15:00 and 17:00 MSK and the steady
// `GROUP_DISCOUNT_TARGET_UNRESOLVED` / `TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED` stream had
// no named sub-condition in the response. The refusal now carries `error.details` naming
// the stage and the observed shape (booleans, counts, enum and id values only — never
// amounts, names or client identity).
//
// The accept/reject decision is untouched: every test below pins the same code, the same
// output shape and the same absence of details on the accepted path. The router body is
// executed with a stub `canonical`, so these run without a private live-flow fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const routerSource = fs.readFileSync(
  new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
const finalSource = fs.readFileSync(
  new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8');

const TENANT = 'iSkq6G';
const EXERCISE = '00000000-0000-4000-8000-000000000003';
const GAME = 'pay_00000000-0000-4000-8000-000000000004';
const STATION = '00000000-0000-4000-8000-000000000005';
const ROOM = '00000000-0000-4000-8000-000000000006';
const MASTER = '00000000-0000-4000-8000-000000000007';
const SUB_SERVICE = '00000000-0000-4000-8000-000000000008';
const SUB = '00000000-0000-4000-8000-000000000002';

const minutes = (from, to) => {
  const parse = (value) => {
    const parts = String(value || '').split(':');
    return parts.length >= 2 ? Number(parts[0]) * 60 + Number(parts[1]) : NaN;
  };
  const start = parse(from); const end = parse(to);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : NaN;
};

/** Execute the router body with a stub `canonical` and return its outputs plus the message. */
function runRouter({ ctx, msg = {}, canonical = {} }) {
  const sandbox = {
    msg: { statusCode: 200, _subscriptionPricePreview: ctx, ...msg },
    canonical,
    global: { get: () => undefined },
    Date, Math, Number, String, Set, Map, JSON, Intl, Boolean, Array, Object,
    encodeURIComponent,
  };
  const outputs = vm.runInNewContext(`(function(){${routerSource}\n})()`, sandbox);
  return { outputs, msg: sandbox.msg };
}

/** Render the reviewed final node for the refusal body, exactly as Node-RED does. */
function renderFinal(message) {
  const sandbox = { msg: { _subscriptionPricePreview: message } };
  const finalMsg = vm.runInNewContext(`(function(){${finalSource}\n})()`, sandbox);
  return JSON.parse(JSON.stringify(finalMsg.payload));
}

const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = (value) => JSON.parse(JSON.stringify(value));

const canonicalStub = (overrides = {}) => ({
  isObj,
  unwrapRecord: (value) => (isObj(value?.exercise) ? value.exercise : value),
  extractItems: (payload) => (Array.isArray(payload) ? payload
    : Array.isArray(payload?.content) ? payload.content : []),
  hasCompleteBookingList: () => true,
  eventStartsAt: (value) => value?.timeFromIso || value?.startsAt || value?.timeFrom || null,
  eventDurationMinutes: (value) => (Number.isFinite(value?.durationMinutes)
    ? value.durationMinutes : minutes(value?.timeFrom, value?.timeTo)),
  exerciseRoomId: (value) => value?.room?.id || value?.roomId || null,
  resolveCategory: (value) => value?.category || null,
  managedExternalEventTypeId: (value) => value?.externalEventTypeId || null,
  identityMoneyOwned: () => [],
  normalizeId: (value) => (typeof value === 'string' ? value.trim().toLowerCase() : null),
  ...overrides,
});

const previewCtx = (overrides = {}) => ({
  tenantKey: TENANT, actorClientId: 'actor', step: 'groupExercise', done: false,
  exerciseId: EXERCISE, requestedIds: [SUB], quotes: [], basePriceMinor: 550000,
  eventCategory: 'GROUP_TRAINING',
  target: { targetKind: 'GROUP_TRAINING', exerciseId: EXERCISE },
  ...overrides,
});

const eventExercise = (overrides = {}) => ({
  id: EXERCISE, category: 'group_training', status: 'ACTIVE',
  timeFromIso: '2099-09-21T08:00:00+03:00', durationMinutes: 60,
  studio: { id: STATION }, room: { id: ROOM }, externalEventTypeId: 'viva:direction:4588:type:605',
  ...overrides,
});

const gameDoc = (overrides = {}) => ({
  id: GAME, status: 'ACTIVE',
  booking: {
    date: '2099-09-21', timeFrom: '08:00', timeTo: '09:00',
    studioId: STATION, roomId: ROOM, masterServiceId: MASTER, subServiceIds: [SUB_SERVICE],
  },
  metadata: { splitPayment: { enabled: true }, vivaExerciseId: EXERCISE },
  ...overrides,
});

const gameCtx = (overrides = {}) => previewCtx({
  existingGame: true, eventCategory: null, step: 'game',
  target: { targetKind: 'EXISTING_GAME', gameId: GAME, startsAt: '2099-09-21T08:00:00+03:00',
    durationMinutes: 60, stationId: STATION, roomId: ROOM },
  ...overrides,
});

test('an accepted group event carries no refusal details', () => {
  const { outputs, msg } = runRouter({
    ctx: previewCtx(), msg: { payload: eventExercise() }, canonical: canonicalStub(),
  });
  assert.equal(JSON.stringify(outputs.map(Boolean)), JSON.stringify([true, false, false, false, false, false]));
  const ctx = msg._subscriptionPricePreview;
  assert.equal(ctx.error, undefined);
  assert.equal(ctx.errorDetails, undefined);
  assert.equal(ctx.target.durationMinutes, 60);
});

test('an event that has already started answers 200 with no quotes', () => {
  // 2026-09-17: every observed refusal of this class had `startsInPast: true` with all
  // other target checks green - the cabinet was told "не удалось проверить скидку" for a
  // tournament that had simply begun. The advisory read no longer fails on that state and
  // advertises no price, so nothing becomes bookable.
  const { outputs, msg } = runRouter({
    ctx: previewCtx(),
    msg: { payload: eventExercise({ timeFromIso: '2020-01-01T08:00:00+03:00' }) },
    canonical: canonicalStub(),
  });
  const ctx = msg._subscriptionPricePreview;
  assert.equal(JSON.stringify(outputs.map(Boolean)), JSON.stringify([false, false, false, false, true, false]));
  assert.equal(ctx.done, true);
  assert.equal(ctx.statusCode, 200);
  assert.deepEqual(plain(ctx.quotes), []);
  assert.equal(ctx.error, undefined);
  assert.equal(ctx.errorDetails, undefined);
  const body = renderFinal(ctx);
  assert.deepEqual(body, { quotes: [] });
});

test('a started event with any other anomaly still fails closed with its details', () => {
  const { msg } = runRouter({
    ctx: previewCtx(),
    msg: { payload: eventExercise({ timeFromIso: '2020-01-01T08:00:00+03:00', externalEventTypeId: undefined }) },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'GROUP_DISCOUNT_TARGET_UNRESOLVED');
  assert.equal(body.error.details.stage, 'event_target');
  assert.equal(body.error.details.observed.startsInPast, true);
  assert.equal(body.error.details.observed.externalEventTypeId, null);
  const cancelled = runRouter({
    ctx: previewCtx(),
    msg: { payload: eventExercise({ timeFromIso: '2020-01-01T08:00:00+03:00', status: 'CANCELLED', isCancelled: true }) },
    canonical: canonicalStub(),
  });
  assert.equal(renderFinal(cancelled.msg._subscriptionPricePreview).error.code,
    'GROUP_DISCOUNT_TARGET_UNRESOLVED');
});

test('a tournament event with another category names the category mismatch', () => {
  const { msg } = runRouter({
    ctx: previewCtx({ eventCategory: 'TOURNAMENT' }),
    msg: { payload: eventExercise({ category: 'group_training' }) },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED');
  assert.equal(body.error.details.stage, 'event_target');
  assert.deepEqual(plain(body.error.details.observed.category), 'group_training');
  assert.deepEqual(plain(body.error.details.observed.expectedCategory), 'tournament');
});

test('a group event without the managed type identity names the missing field', () => {
  const { msg } = runRouter({
    ctx: previewCtx(),
    msg: { payload: eventExercise({ externalEventTypeId: undefined }) },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'GROUP_DISCOUNT_TARGET_UNRESOLVED');
  assert.equal(body.error.details.observed.externalEventTypeId, null);
  assert.equal(body.error.details.observed.startsInPast, false);
});

test('a missing game record is named as a record-stage refusal', () => {
  const { msg } = runRouter({ ctx: gameCtx(), msg: { payload: [] }, canonical: canonicalStub() });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'PRICE_PREVIEW_GAME_UNRESOLVED');
  assert.equal(body.error.details.stage, 'game_record');
  assert.equal(body.error.details.observed.documents, 0);
  assert.equal(body.error.details.observed.idMatch, false);
});

test('a game whose stored duration differs names both durations', () => {
  const { msg } = runRouter({
    ctx: gameCtx({ target: { targetKind: 'EXISTING_GAME', gameId: GAME,
      startsAt: '2099-09-21T08:00:00+03:00', durationMinutes: 90, stationId: STATION, roomId: ROOM } }),
    msg: { payload: [gameDoc()] },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'PRICE_PREVIEW_GAME_UNRESOLVED');
  assert.equal(body.error.details.stage, 'game_metadata');
  assert.equal(body.error.details.observed.storedDurationMinutes, 60);
  assert.equal(body.error.details.observed.requestedDurationMinutes, 90);
  assert.equal(body.error.details.observed.startsAtMatch, true, 'only the duration refused');
  assert.equal(body.error.details.observed.exerciseIdCount, 1);
  assert.equal(body.error.details.observed.subServicesValid, true);
});

test('a game with a non-uuid room names the invalid field', () => {
  const doc = gameDoc();
  doc.booking.roomId = 'room-7';
  const { msg } = runRouter({ ctx: gameCtx(), msg: { payload: [doc] }, canonical: canonicalStub() });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.details.stage, 'game_metadata');
  assert.equal(body.error.details.observed.roomIdValid, false);
  assert.equal(body.error.details.observed.stationIdValid, true);
  assert.equal(body.error.details.observed.masterServiceIdValid, true);
});

test('a game whose viva exercise lacks the subscription list names the exercise stage', () => {
  const exercise = {
    id: EXERCISE, category: 'open_game', status: 'ACTIVE',
    studio: { id: STATION }, room: { id: ROOM },
    timeFromIso: '2099-09-21T08:00:00+03:00', durationMinutes: 60,
  };
  const { msg } = runRouter({
    ctx: gameCtx({ step: 'exercise', exerciseId: EXERCISE }),
    msg: { payload: exercise },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  assert.equal(body.error.code, 'PRICE_PREVIEW_GAME_UNRESOLVED');
  assert.equal(body.error.details.stage, 'game_exercise');
  assert.equal(body.error.details.observed.availableClientSubscriptions, false);
  assert.equal(body.error.details.observed.category, 'open_game');
  assert.equal(body.error.details.observed.stationMatch, true);
  assert.equal(body.error.details.observed.roomMatch, true);
  assert.equal(body.error.details.observed.startsAtMatch, true);
});

test('an accepted game exercise still carries no refusal details', () => {
  const exercise = {
    id: EXERCISE, category: 'open_game', status: 'ACTIVE',
    studio: { id: STATION }, room: { id: ROOM },
    timeFromIso: '2099-09-21T08:00:00+03:00', durationMinutes: 60,
    availableClientSubscriptions: [{ subscriptionId: SUB }],
  };
  const { outputs, msg } = runRouter({
    ctx: gameCtx({ step: 'exercise', exerciseId: EXERCISE }),
    msg: { payload: exercise },
    canonical: canonicalStub(),
  });
  assert.equal(JSON.stringify(outputs.map(Boolean)), JSON.stringify([true, false, false, false, false, false]));
  assert.equal(msg._subscriptionPricePreview.errorDetails, undefined);
  assert.equal(msg._subscriptionPricePreview.error, undefined);
});

test('the refusal details never carry a name, an amount or a phone number', () => {
  const { msg } = runRouter({
    ctx: gameCtx({ target: { targetKind: 'EXISTING_GAME', gameId: GAME,
      startsAt: '2099-09-21T08:00:00+03:00', durationMinutes: 90, stationId: STATION, roomId: ROOM } }),
    msg: { payload: [gameDoc({ metadata: { splitPayment: { enabled: true, customerName: 'Иван' },
      vivaExerciseId: EXERCISE } })] },
    canonical: canonicalStub(),
  });
  const body = renderFinal(msg._subscriptionPricePreview);
  const serialized = JSON.stringify(body);
  assert.match(serialized, /"stage":"game_metadata"/);
  for (const forbidden of ['Иван', 'price', 'amount', 'phone', 'clientId', 'customerName']) {
    assert.equal(serialized.includes(forbidden), false, `details must not carry ${forbidden}`);
  }
});

// The started-event mapping refactored the twelve-condition target conjunction into named
// checks. This enumerates all 4096 combinations of those twelve conditions against the
// reviewed source and asserts the refactor is decision-identical: it accepts, refuses and
// answers the client-visible "unavailable" exactly where the original conjunction did.
const TARGET_CHECK_KEYS = Object.freeze(['httpOk', 'resolved', 'idMatch', 'category', 'startsAtParsed',
  'startsInFuture', 'durationValid', 'hasRoom', 'hasStudio', 'hasExternalEventType', 'notCancelled', 'statusActive']);

const compiledRouterFactory = vm.compileFunction(
  `return function (canonical) { return function (msg) { ${routerSource} }; };`, [],
  { parsingContext: vm.createContext({ Date, Math, Number, String, Set, Map, JSON, Intl, Boolean, Array, Object,
    encodeURIComponent, global: { get: () => undefined } }) });

function runGroupExercise(bits) {
  const canonical = {
    isObj,
    unwrapRecord: (value) => (isObj(value?.exercise) ? value.exercise : value),
    identityMoneyOwned: () => [],
    eventStartsAt: () => (bits.startsAtParsed ? (bits.startsInFuture ? '2099-09-21T08:00:00+03:00' : '2020-01-01T08:00:00+03:00') : 'not-a-date'),
    eventDurationMinutes: () => (bits.durationValid ? 90 : 0),
    resolveCategory: () => (bits.category ? 'group_training' : 'tournament'),
    exerciseRoomId: () => (bits.hasRoom ? ROOM : null),
    managedExternalEventTypeId: () => (bits.hasExternalEventType ? 'viva:direction:4588:type:605' : null),
  };
  const exercise = { id: bits.idMatch ? EXERCISE : 'other-id', timeFromIso: 'x', durationMinutes: 90,
    status: bits.statusActive ? 'ACTIVE' : 'CANCELLED', isCancelled: !bits.notCancelled,
    studio: bits.hasStudio ? { id: STATION } : {}, room: bits.hasRoom ? { id: ROOM } : {} };
  const ctx = previewCtx();
  const msg = { statusCode: bits.httpOk ? 200 : 503, _subscriptionPricePreview: ctx,
    payload: bits.resolved ? exercise : null };
  const outputs = compiledRouterFactory()(canonical)(msg);
  const state = msg._subscriptionPricePreview;
  const wired = outputs.findIndex(Boolean);
  if (wired === 0) return 'accepted';
  if (state.error) return 'refused';
  if (wired === 4 && state.done === true && state.statusCode === 200
    && Array.isArray(state.quotes) && state.quotes.length === 0) return 'client-unavailable';
  return 'unexpected:' + wired;
}

test('the twelve target conditions keep their exact decision across all 4096 combinations', () => {
  let accepted = 0; let refused = 0; let unavailable = 0;
  for (let mask = 0; mask < (1 << TARGET_CHECK_KEYS.length); mask += 1) {
    const bits = Object.fromEntries(TARGET_CHECK_KEYS.map((key, index) => [key, Boolean(mask & (1 << index))]));
    const healthy = bits.httpOk && bits.resolved && bits.idMatch && bits.category && bits.startsAtParsed
      && bits.durationValid && bits.hasRoom && bits.hasStudio && bits.hasExternalEventType
      && bits.notCancelled && bits.statusActive;
    const startsInFuture = bits.startsAtParsed && bits.startsInFuture;
    const expected = !healthy ? 'refused' : startsInFuture ? 'accepted' : 'client-unavailable';
    assert.equal(runGroupExercise(bits), expected,
      `combination ${mask} (${JSON.stringify(bits)}) must be ${expected}`);
    if (expected === 'accepted') accepted += 1;
    else if (expected === 'refused') refused += 1;
    else unavailable += 1;
  }
  // The enumeration really covers all three outcomes.
  assert.ok(accepted > 0 && refused > 0 && unavailable > 0,
    `expected every outcome to appear, got ${accepted}/${refused}/${unavailable}`);
  assert.equal(accepted + refused + unavailable, 4096);
});
