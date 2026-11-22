import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  composeSplitGameCapacity, patchGateway, patchSplitRouter,
} from '../patch_live_split_game_capacity_refusal.mjs';
import { patchTournamentCapacityRouter } from '../patch_live_tournament_capacity_refusal.mjs';
import { formatSubscriptionDecisionPresentation, resolveSubscriptionDecisionPresentation } from '../../src/utils/subscriptionDecisionUi.ts';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const livePath = process.env.SPLIT_GAME_CAPACITY_LIVE_FIXTURE;
const candidate = livePath ? JSON.parse(composeSplitGameCapacity(fs.readFileSync(livePath)).candidateBytes) : null;
const body = (id) => candidate.find(node => node.id === id).func;
const gatewayFixture = patchTournamentCapacityRouter(read(
  '../nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
)).replace('if (ctx.step === "booking_create") {', `
function lk1Find(ctx, step, query) {
  ctx.step = step;
  msg.payload = query;
  return emit(1);
}
if (ctx.step === "lk1_ingress_operation_find") {
  const operation = msg.payload[0];
  if (!operation) {
    delete ctx.lk1IngressReplay;
    ctx.step = "lk1_profile_continue";
  } else {
    const quote = operation.lk1;
    if (operation.state === "RELEASED" && ctx.caller === "split" && ctx.managedAction === "JOIN_GAME") {
      return finishPending(ctx, "Needs reconciliation");
    }
    return finishPending(ctx, "Operation already exists");
  }
}
if (ctx.step === "booking_create") {`);
const gateway = new Function('msg', 'global', 'node', 'flow', 'env', candidate
  ? body('lk_subscription_booking_router_20260804') : patchGateway(gatewayFixture));
const finalizer = new Function('msg', 'global', 'node', 'flow', 'env', candidate
  ? body('lk_subscription_booking_finalize_20260804') : `
const ctx = msg._subscriptionBooking, payload = msg.payload, responseStatus = Number(msg.statusCode);
${read('../nodered_lk1_hub_nodes/finalize.js')}
return [null, msg];`);
const splitRouter = new Function('msg', 'global', 'node', 'flow', 'env', candidate
  ? body('8f7bd5b482fe9763') : patchSplitRouter(read('../nodered_games_nodes/fn_split_router.js')));

const globals = { get() {}, set() {} };
const ack = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
const refusal = { code: 'CONFLICT', message: 'Нет свободных мест' };

function makePair() {
  const ctx = { caller: 'split', step: 'booking_create', managedAction: 'JOIN_GAME', category: 'open_game',
    tenantKey: 'fixture', operationId: 'fixture-join-operation', actorClientId: 'fixture-actor',
    clientSubscriptionId: 'fixture-subscription', exerciseId: 'fixture-game',
    lk1: { rule: { productId: 'fixture-product' }, target: { category: 'GAME', eventId: 'fixture-game' },
      decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } } };
  ctx.operationKey = `lk1-product:${JSON.stringify([ctx.tenantKey, ctx.actorClientId, ctx.operationId])}`;
  ctx.lk1.fingerprint = JSON.stringify({
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId,
    action: ctx.managedAction, rule: ctx.lk1.rule, target: ctx.lk1.target,
  });
  const split = { action: 'join', exerciseId: ctx.exerciseId, operationId: ctx.operationId,
    clientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId };
  return { ctx, split };
}
function receiveRefusal(ctx, split, error, payload = refusal) {
  const msg = { _subscriptionBooking: ctx, _splitCtx: split, statusCode: 409, payload, error };
  gateway(msg, globals);
  return msg;
}
function finish(msg, result = ack) {
  msg.payload = result;
  delete msg.error;
  gateway(msg, globals);
  assert.equal(finalizer(msg, globals)[0], null);
  return msg;
}

const fullExercise = {
  id: 'fixture-game', directionId: 6181, typeId: 2349, clientsCount: 4, maxClientsCount: 4,
};

function checkCapacity({ exercise = fullExercise, error, fresh = true, changeBinding = false,
  concurrentOperation = false } = {}) {
  const { ctx, split } = makePair();
  const quote = ctx.lk1;
  delete ctx.lk1;
  const msg = { _subscriptionBooking: ctx, _splitCtx: split, payload: [] };
  if (fresh) {
    // Use the empty actor-bound operation lookup to acquire the marker.
    Object.assign(ctx, { step: 'lk1_ingress_operation_find', lk1IngressReplay: true });
    const out = gateway(msg, globals);
    assert.ok(out.slice(1, 4).every(value => value == null));
  }
  ctx.step = 'exercise';
  if (changeBinding) split.exerciseId = 'different';
  Object.assign(msg, { statusCode: 200, payload: exercise, error });
  const out = gateway(msg, globals);
  if (ctx.step === 'lk1_ingress_operation_find') {
    assert.equal(out[1], msg);
    assert.ok(out.slice(2, 4).every(value => value == null));
    assert.deepEqual(msg.payload, { _id: ctx.operationKey });
    msg.payload = concurrentOperation ? [{
      _id: ctx.operationKey, tenantKey: ctx.tenantKey, operationId: ctx.operationId,
      actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId,
      exerciseId: ctx.exerciseId, category: ctx.category, lk1: quote, state: 'PENDING_CONFIRMATION',
    }] : [];
    const afterRead = gateway(msg, globals);
    assert.ok(afterRead.slice(0, 4).every(value => value == null));
  } else {
    assert.ok(out.slice(1, 4).every(value => value == null));
  }
  assert.equal(finalizer(msg, globals)[0], null);
  return msg;
}

test('a fresh join with a full Viva exercise ends before reserving a visit or launching checkout', () => {
  const msg = checkCapacity();
  assert.equal(msg.statusCode, 409);
  assert.equal(msg.payload.details.code, 'GAME_FULL');
  assert.equal(msg.payload.error, 'Все места в игре заняты. Состав игры можно уточнить у администратора станции.');

  const presentation = resolveSubscriptionDecisionPresentation({
    action: 'JOIN_GAME', requestedPaymentMode: 'subscription',
    error: { status: msg.statusCode, message: msg.payload.error, raw: msg.payload },
  });
  assert.equal(formatSubscriptionDecisionPresentation(presentation), msg.payload.error);
  assert.equal(presentation.retryable, false);
  assert.equal(presentation.continueWithoutSubscription, false);
});

test('an unbound, unclear or non-full exercise read does not become a capacity refusal', () => {
  for (const params of [
    { fresh: false }, { changeBinding: true }, { error: new Error('read failed') },
    { exercise: { ...fullExercise, id: 'different' } },
    { exercise: { ...fullExercise, clientsCount: 3 } },
    { exercise: { ...fullExercise, clientsCount: '4' } },
    { exercise: { ...fullExercise, clientsCount: undefined } },
    { exercise: { ...fullExercise, canceled: true } },
    { exercise: { ...fullExercise, archived: true } },
    { exercise: { ...fullExercise, directionId: 6306 } },
  ]) assert.notEqual(checkCapacity(params).payload.details?.code, 'GAME_FULL');
});

test('a concurrent claim found after the full exercise read keeps its reconciliation outcome', () => {
  const msg = checkCapacity({ concurrentOperation: true });
  assert.equal(msg.statusCode, 202);
  assert.equal(msg.payload.state, 'PENDING_CONFIRMATION');
});

test('capacity races after the subscription write still use reconciliation', () => {
  const { ctx, split } = makePair();
  const msg = finish(receiveRefusal(ctx, split));
  assert.equal(msg.statusCode, 202);
  assert.equal(msg.payload.state, 'PENDING_CONFIRMATION');
});

test('a reconciled old refusal describes that attempt and never books the game again', () => {
  const { ctx, split } = makePair();
  Object.assign(ctx, { step: 'lk1_ingress_operation_find', lk1IngressReplay: true });
  const releasedAt = '2026-01-01T01:10:00Z';
  const operation = { _id: ctx.operationKey, tenantKey: ctx.tenantKey, operationId: ctx.operationId,
    actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId, exerciseId: ctx.exerciseId,
    category: 'open_game', lk1: ctx.lk1, state: 'RELEASED', releaseReason: 'RECONCILE_HUNG_DAILY_CLAIM',
    releasedAt, previousFailureAt: '2026-01-01T01:05:00Z',
    previousFailure: { statusCode: 409, rawCode: refusal.code, message: refusal.message },
    reconciliation: { observedState: 'PREPARED', source: 'hung_claim_reconciler', decision: 'SAFE_TO_RELEASE',
      reconciledAt: releasedAt } };
  const run = (record) => {
    const msg = { _subscriptionBooking: structuredClone(ctx), _splitCtx: { ...split }, payload: [record] };
    const out = gateway(msg, globals);
    assert.ok(out.slice(0, 4).every(value => value == null));
    assert.equal(finalizer(msg, globals)[0], null);
    return msg;
  };
  const msg = run(operation);
  assert.equal(msg.statusCode, 409);
  assert.equal(msg.payload.details.code, 'GAME_FULL');
  assert.match(msg.payload.error, /^На момент вашей попытки/);
  assert.notEqual(run({ ...operation, transactionId: 'fixture-payment' }).payload.details?.code, 'GAME_FULL');
});

test('only the direct join booking refusal becomes game-full, never a payment or CREATE failure', () => {
  for (const [action, step, error, expected] of [
    ['join', 'create_booking', undefined, 'GAME_FULL'],
    ['join', 'transaction', undefined, 'CONFLICT'],
    ['create', 'create_booking', undefined, 'CONFLICT'],
    ['join', 'create_booking', new Error('transport issue'), 'CONFLICT'],
  ]) {
    const msg = { _splitCtx: { action, step }, statusCode: 409, payload: refusal, error };
    splitRouter(msg, globals);
    assert.equal(msg.payload.details.code, expected);
  }
});

test('the candidate composer requires the reviewed whole-flow preimage', () => {
  assert.throws(() => composeSplitGameCapacity(Buffer.from('[]')), /whole-flow preimage drift/);
});
