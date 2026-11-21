import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// Drives the real /lk/subscription-bookings router: the CUP level decision is consulted before a
// NEW tournament booking operation is created. No Viva, Mongo or CUP call is made by the test.
const source = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const router = new Function('msg', 'global', source);
const base = 'https://api.vivacrm.ru/end-user/api/v2/fixture/bookings?size=1000';
const row = id => ({ id: `booking-${id}`, clientId: 'owner' });
const firstRows = Array.from({ length: 1000 }, (_, i) => row(i));
const page = (number = 0, extra = {}) => ({ content: number ? [row(1000)] : firstRows,
  number, totalElements: 1001, totalPages: 2, last: number === 1, ...extra });

function flowAtOperationFind({ gate = false, category = 'tournament', apiBase } = {}) {
  const values = { vivacrm_access_token: 'fixture-service-token',
    ...(gate ? { tournament_level_gate_enabled: true } : {}),
    ...(apiBase ? { tournament_level_decision_api_base: apiBase } : {}) };
  const globals = { get: key => values[key] ?? null };
  const ctx = { tenantKey: 'fixture', actorClientId: 'owner', auth: 'Bearer fixture-user',
    authHeader: 'Bearer fixture-user', startedAt: Date.now(), caller: 'http', action: 'book',
    clientSubscriptionId: 'subscription', exerciseId: 'exercise-tournament', serviceDate: '2099-01-01',
    operationKey: 'fixture-operation', operationId: 'op-1', planKey: 'sport', category, limitMode: 'shared_day',
    activePayload: [], activeBookingsPayload: [], ruleProductIds: [], step: 'active_bookings' };
  const msg = { method: 'GET', url: base, responseUrl: base, statusCode: 200, payload: page(), _subscriptionBooking: ctx };
  const run = () => router(msg, globals);
  const reply = (payload, extra = {}) => {
    Object.assign(msg, { payload, statusCode: 200, responseUrl: msg.url }, extra);
    return run();
  };
  run();
  reply(page(1));
  reply(page(0, { content: firstRows.map(r => ({ ...r, cancelled: true })) }));
  reply(page(1));
  assert.equal(ctx.step, 'operation_find');
  return { ctx, msg, run, reply };
}

const decision = (overrides = {}) => ({
  enforced: true, allowed: true, reasonCode: 'LEVEL_ALLOWED', message: 'ok', ruleKind: 'RANGE',
  baseRange: { min: 3, max: 3.5 }, levelTolerance: 0.2, effectiveRange: { min: 2.8, max: 3.7 },
  playerLevel: 3.31, ruleVersion: 'tournament-level-v2:0123456789abcdef', ...overrides,
});

test('gate off: tournament booking goes straight to the operation insert (unchanged behavior)', () => {
  const flow = flowAtOperationFind({ gate: false });
  flow.reply([]);
  assert.equal(flow.ctx.step, 'operation_insert');
});

test('gate on: a new tournament operation first asks CUP with the user token and no level data', () => {
  const flow = flowAtOperationFind({ gate: true });
  flow.reply([]);
  assert.equal(flow.ctx.step, 'tournament_level_decision');
  assert.equal(flow.msg.method, 'GET');
  assert.equal(flow.msg.url, 'https://padlhub.su/api/tournaments/exercise-tournament/level-decision');
  assert.equal(flow.msg.headers.Authorization, 'Bearer fixture-user');
  assert.equal(flow.msg.payload, undefined, 'no level, range or tolerance is sent');
  assert(flow.msg.requestTimeout > 0 && flow.msg.requestTimeout <= 10000);
});

test('allowed (incl. tolerance) resumes the original operation insert', () => {
  for (const reasonCode of ['LEVEL_ALLOWED', 'LEVEL_ALLOWED_WITH_TOLERANCE', 'LEVEL_NOT_RESTRICTED']) {
    const flow = flowAtOperationFind({ gate: true });
    flow.reply([]);
    flow.reply(decision({ reasonCode }));
    assert.equal(flow.ctx.step, 'operation_insert', reasonCode);
    assert.equal(flow.ctx.tournamentLevelDecision.reasonCode, reasonCode);
    assert.equal(flow.msg.payload.operationId, 'op-1');
  }
});

test('enforced refusals finish before any operation or Viva booking', () => {
  for (const [reasonCode, status] of [['LEVEL_NOT_ALLOWED', 409], ['PLAYER_LEVEL_REQUIRED', 409],
    ['PLAYER_LEVEL_UNKNOWN', 409], ['ACTIVITY_LEVEL_INVALID', 409], ['LEVEL_CHECK_UNAVAILABLE', 503]]) {
    const flow = flowAtOperationFind({ gate: true });
    flow.reply([]);
    flow.reply(decision({ allowed: false, reasonCode, playerLevel: 3.8 }));
    assert.equal(flow.msg.statusCode, status, reasonCode);
    assert.equal(flow.msg.payload.details.code, reasonCode);
    assert.notEqual(flow.ctx.step, 'operation_insert');
    assert.equal(flow.msg.payload.details.levelDecision.playerLevel, 3.8);
  }
});

test('CUP unavailable or malformed answer fails closed; only a real tournament 404 means no CUP rule', () => {
  for (const [payload, extra] of [[null, { statusCode: 503 }], [{ message: 'oops' }, {}],
    [{ statusCode: 404, message: 'Cannot GET /api/tournaments/x/level-decision' }, { statusCode: 404 }],
    [decision({ reasonCode: 'SOMETHING_NEW' }), {}]]) {
    const flow = flowAtOperationFind({ gate: true });
    flow.reply([]);
    flow.reply(payload, extra);
    assert.equal(flow.msg.statusCode, 503);
    assert.equal(flow.msg.payload.details.code, 'LEVEL_CHECK_UNAVAILABLE');
  }
  const flow = flowAtOperationFind({ gate: true });
  flow.reply([]);
  flow.reply({ statusCode: 404, message: 'Custom tournament with slug exercise-tournament not found' }, { statusCode: 404 });
  assert.equal(flow.ctx.step, 'operation_insert');
});

test('legacy (not enforced) CUP decision never refuses', () => {
  const flow = flowAtOperationFind({ gate: true });
  flow.reply([]);
  flow.reply(decision({ enforced: false, allowed: true, reasonCode: 'LEVEL_GATE_LEGACY' }));
  assert.equal(flow.ctx.step, 'operation_insert');
});

test('non-tournament categories and existing operations are never gated', () => {
  const game = flowAtOperationFind({ gate: true, category: 'open_game' });
  game.reply([]);
  assert.equal(game.ctx.step, 'operation_insert');
  const existing = flowAtOperationFind({ gate: true });
  existing.reply([{ _id: 'fixture-operation', operationId: 'op-1', state: 'PENDING_CONFIRMATION',
    exerciseId: 'exercise-tournament', clientSubscriptionId: 'subscription' }]);
  assert.notEqual(existing.ctx.step, 'tournament_level_decision');
});

test('only an https decision base can be configured', () => {
  const flow = flowAtOperationFind({ gate: true, apiBase: 'http://evil.example/api' });
  flow.reply([]);
  assert.equal(flow.msg.url, 'https://padlhub.su/api/tournaments/exercise-tournament/level-decision');
  const custom = flowAtOperationFind({ gate: true, apiBase: 'https://lk-reserve.example.test/api' });
  custom.reply([]);
  assert.equal(custom.msg.url, 'https://lk-reserve.example.test/api/tournaments/exercise-tournament/level-decision');
});

test('router consumes the decision only and contains no level formula', () => {
  const start = source.indexOf('// Tournament level admission (CUP decision).');
  const block = source.slice(start, source.indexOf('const prepareUserGet', start));
  assert.doesNotMatch(block, /playerLevel\s*[<>]|levelTolerance\s*[+-]|ratingNumeric/);
});
