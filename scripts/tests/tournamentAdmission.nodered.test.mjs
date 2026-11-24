import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';
import * as url from 'node:url';
import { composeTournamentAdmissionCandidate } from '../prepare_tournament_admission_candidate.mjs';
import { patchTournamentAdmissionFinalizeSource, patchTournamentAdmissionSource } from '../lib/tournamentAdmissionSource.mjs';
const base = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const source = patchTournamentAdmissionSource(base);
const run = new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', source);
const env = { get: key => key === 'TOURNAMENT_OWNER_API_BASE' ? 'https://cup.example/api' : undefined };
const context = (extra = {}) => ({ step: 'operation_insert', category: 'tournament', action: 'book', actorClientId: 'actor',
  exerciseId: 'exercise', operationKey: 'op-key', operationId: 'op-id', tenantKey: 'fixture',
  clientSubscriptionId: 'subscription', serviceDate: '2026-11-18', authHeader: 'Bearer synthetic', ...extra });
function step(ctx, payload, extra = {}) {
  const msg = { _subscriptionBooking: ctx, payload, ...extra };
  const out = run(msg, env, { get: () => undefined }, { warn() {}, error() {} }, url);
  return { msg, out };
}
function response(ctx, status, payload) {
  return step(ctx, payload, { statusCode: status, url: ctx.tournamentAdmissionRequestedUrl,
    responseUrl: ctx.tournamentAdmissionRequestedUrl, method: 'POST', followRedirects: false, maxRedirects: 0 });
}
function refused(extra = {}, code = 'LEVEL_NOT_ALLOWED') {
  const ctx = context(extra);
  step(ctx, { acknowledged: true, insertedId: 'op-key' });
  assert.equal(ctx.step, 'tournament_admission');
  const result = response(ctx, 403, { code });
  return { ctx, ...result };
}

const managedFinalizeSource = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/finalize.js', import.meta.url), 'utf8');
const finalize = new Function('msg', 'global', 'node',
  'const ctx = msg._subscriptionBooking; const payload = msg.payload; const responseStatus = Number(msg.statusCode);\n'
  + patchTournamentAdmissionFinalizeSource(managedFinalizeSource));
test('actual booking router requests durable owner admission before preaccept, not GET preview', () => {
  const ctx = context(); const { msg } = step(ctx, { acknowledged: true, insertedId: 'op-key' });
  assert.equal(msg.method, 'POST'); assert.match(msg.url, /\/subscription-admission$/);
  assert.deepEqual(msg.payload, { operationId: 'op-id', clientSubscriptionId: 'subscription' });
  const admitted = response(ctx, 200, { schemaVersion: 1, state: 'ADMITTED', operationId: 'owner-op',
    requestOperationId: 'op-id', actorClientId: 'actor', exerciseId: 'exercise', clientSubscriptionId: 'subscription' });
  assert.equal(ctx.step, 'operation_preaccept');
  assert.equal(admitted.msg.payload[0].state, 'PREPARED');
});
test('definitive refusal fences exact predispatch operation and reads back after a lost ACK', () => {
  const { ctx, msg } = refused(); const [query, update] = msg.payload;
  assert.equal(query.operationId, 'op-id'); assert.deepEqual(query.upstreamAttemptedAt, { $exists: false });
  assert.deepEqual(query['lk1.transactionAttemptedAt'], { $exists: false });
  assert.equal(update.$set.state, 'FAILED');
  step(ctx, null, { error: Error('lost ACK') });
  assert.equal(ctx.step, 'tournament_admission_refusal_read');
  const row = { ...context(), _id: 'op-key', ...update.$set };
  step(ctx, [row]); assert.equal(ctx.step, 'tournament_admission_guard_read');
  const guard = { _id: 'lk1-daily-visit:["fixture","subscription","2026-11-18"]', kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: 'op-key', ownerOperationId: 'op-id' };
  const release = step(ctx, [guard]).msg.payload;
  assert.equal(release[0].ownerOperationId, 'op-id');
  assert.deepEqual(release[1].$set.admissionRelease, { operationKey: 'op-key', operationId: 'op-id' });
});

test('a durable level refusal remains terminal through the managed HTTP finalizer', () => {
  const { ctx, msg } = refused({ caller: 'http', managedAction: 'BOOK_TOURNAMENT' });
  const row = { ...context(), _id: 'op-key', ...msg.payload[1].$set };
  step(ctx, null, { error: Error('lost ACK') });
  step(ctx, [row]);
  ctx.lk1 = { fingerprint: 'original-quote' };
  const denial = step(ctx, []).msg;
  const [split, result] = finalize(denial);
  assert.equal(split, null);
  assert.equal(result.statusCode, 403);
  assert.deepEqual(result.payload, {
    error: 'Ваш игровой уровень не подходит для этого турнира.',
    details: { code: 'LEVEL_NOT_ALLOWED' },
  });
  for (const changes of [
    { tournamentLevelRefusal: undefined },
    { operationId: 'foreign' },
    { lk1: { fingerprint: 'changed' } },
    { tournamentDispatchGranted: true },
  ]) {
    const stale = { ...denial, _subscriptionBooking: { ...ctx, ...changes } };
    assert.equal(finalize(stale)[1].statusCode, 202);
  }
  const contradictory = { ...denial, payload: { ...denial.payload, details: { code: 'PLAYER_LEVEL_UNKNOWN' } } };
  assert.equal(finalize(contradictory)[1].statusCode, 202);
});
test('a durable LK1 gender refusal offers one successor after the prior visit guard is released', () => {
  for (const code of ['PLAYER_GENDER_REQUIRED', 'GENDER_NOT_ALLOWED']) {
    const operationId = 'lk-subscription-synthetic';
    const { ctx, msg } = refused({ operationId, caller: 'http', managedAction: 'BOOK_TOURNAMENT' }, code);
    const row = { ...context({ operationId }), _id: 'op-key', ...msg.payload[1].$set };
    step(ctx, {});
    step(ctx, [row]);
    ctx.lk1 = { fingerprint: 'original-quote' };
    const guard = { _id: 'lk1-daily-visit:["fixture","subscription","2026-11-18"]',
      kind: 'LK1_DAILY_VISIT_V1', ownerOperationKey: 'op-key', ownerOperationId: operationId };
    assert.equal(step(ctx, [guard]).msg.payload[1].$set.admissionRelease.operationId, operationId);
    step(ctx, {});
    guard.admissionRelease = { operationKey: 'op-key', operationId };
    const denial = step(ctx, [guard]).msg;
    const [, result] = finalize(denial);
    assert.equal(result.statusCode, 409);
    assert.deepEqual(result.payload.details, {
      code: 'SUBSCRIPTION_BOOKING_RELEASED', operationId, nextOperationId: operationId + ':rejoin:1',
    });
    const forged = { ...denial, _subscriptionBooking: { ...ctx, tournamentGenderRejoin: undefined } };
    assert.equal(finalize(forged)[1].statusCode, 202);
    const predicate = new Function(source.slice(source.indexOf('const tournamentAdmissionGenderCode'),
      source.indexOf('const tournamentAdmissionTerminal')) +
      source.slice(source.indexOf('const tournamentAdmissionEffectFields'), source.indexOf('const tournamentAdmissionDurableUpdate')) +
      '\nreturn tournamentAdmissionGenderRefused;')();
    assert.equal(predicate(row), true);
    for (const unsafe of [{ state: 'RELEASED' }, { upstreamAttemptedAt: row.failedAt }, { tournamentAdmission: {} },
      { lk1: { transactionAttemptedAt: row.failedAt } }, { operationId: operationId + ':rejoin:2' }]) {
      assert.equal(predicate({ ...row, ...unsafe }), false);
    }
  }
});
test('timeout is unknown and releases nothing; forged owner actor never authorizes preaccept', () => {
  for (const kind of ['timeout', 'wrong-actor']) {
    const ctx = context(); step(ctx, { acknowledged: true, insertedId: 'op-key' });
    const { msg } = kind === 'timeout' ? step(ctx, null, { error: Error('timeout') })
      : response(ctx, 200, { schemaVersion: 1, state: 'ADMITTED', operationId: 'owner', requestOperationId: 'op-id',
        actorClientId: 'foreign', exerciseId: 'exercise', clientSubscriptionId: 'subscription' });
    assert.equal(msg.statusCode, 202);
  }
});
test('refusal recovery never releases a foreign guard or an operation with dispatch/use markers', () => {
  for (const marker of ['upstreamAttemptedAt', 'bookingId', 'managedEntitlementOperationId']) {
    const { ctx, msg } = refused(); const update = msg.payload[1].$set;
    step(ctx, {});
    const result = step(ctx, [{ ...context(), _id: 'op-key', ...update, [marker]: 'present' }]);
    assert.equal(result.msg.statusCode, 202);
  }
  const { ctx } = refused(); ctx.step = 'tournament_admission_guard_read';
  assert.equal(step(ctx, [{ ownerOperationKey: 'foreign', ownerOperationId: 'foreign' }]).msg.statusCode, 403);
});
function withDailyGuard(source) {
  const guard = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/daily_visit_guard.js', import.meta.url), 'utf8');
  return source.replace('const ctx = isObj(msg._subscriptionBooking)', guard + '\nconst ctx = isObj(msg._subscriptionBooking)')
    .replace('const preparePreaccept = (ctx) => {', 'const preparePreaccept = (ctx) => {\n'
      + '  if (ctx.lk1?.decision?.subscriptionVisitCount === 1 && ctx.lk1DailyVisitOwned !== true) {\n    return lk1DailyVisitAcquire(ctx);\n  }')
    .replace('const prepareBookingCreate = (ctx) => {', 'const prepareBookingCreate = (ctx) => {\n'
      + '  if (ctx.lk1?.decision?.subscriptionVisitCount === 1 && ctx.lk1DailyVisitOwned !== true) {\n'
      + '    ctx.lk1DailyVisitContinuation = "booking";\n    return lk1DailyVisitAcquire(ctx);\n  }');
}

test('patch requires composed daily guard ownership before CUP admission and before preaccept', () => {
  const composed = withDailyGuard(base);
  const patched = patchTournamentAdmissionSource(composed);
  new Function('msg', 'env', 'global', 'node', patched);
  const preaccept = patched.slice(patched.indexOf('const preparePreaccept ='), patched.indexOf('const preparePrecreatedReservationPromotion ='));
  assert.ok(preaccept.indexOf('return lk1DailyVisitAcquire(ctx)') < preaccept.indexOf('tournamentAdmissionGate(ctx, "preaccept")'));
  assert.match(patched, /\$unset: \{ admissionRelease: "" \}/);
  assert.throws(() => patchTournamentAdmissionSource(patched), /already installed/);
});


test('candidate preserves the live provider-version overlay, existing libraries and all other nodes', () => {
  const liveAdminVersion = '  const adminVersion = ctx.caller === "split" || (ctx.lk1 && payload.paymentType === "SUBSCRIPTION")\n'
    + '    || (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";';
  const func = withDailyGuard(base.replace('  const adminVersion = ctx.caller === "split" ? "v1" : "v2";', liveAdminVersion));
  const nodes = [{ id: 'untouched', type: 'comment', name: 'fixture' },
    { id: 'lk_subscription_booking_router_20260804', type: 'function', outputs: 5,
      wires: [['fixture'], [], [], [], ['lk_subscription_booking_finalize_20260804']],
      libs: [{ var: 'fixtureCrypto', module: 'crypto' }], func },
    { id: 'lk_subscription_booking_finalize_20260804', type: 'function', outputs: 2,
      wires: [[], ['fixture']], func: managedFinalizeSource }];
  const raw = Buffer.from(JSON.stringify(nodes));
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const candidate = composeTournamentAdmissionCandidate(raw, digest);
  assert.deepEqual(candidate[0], nodes[0]);
  assert.deepEqual({ ...candidate[1], func: '', libs: [] }, { ...nodes[1], func: '', libs: [] });
  assert.deepEqual(candidate[1].libs, [...nodes[1].libs, { var: 'tournamentOwnerUrl', module: 'url' }]);
  assert.ok(candidate[1].func.includes(liveAdminVersion));
  assert.throws(() => composeTournamentAdmissionCandidate(raw, '0'.repeat(64)), /preimage mismatch/);
  assert.match(candidate[1].func, /tournamentAdmissionGate/);
  assert.deepEqual({ ...candidate[2], func: '' }, { ...nodes[2], func: '' });
  assert.match(candidate[2].func, /ctx.tournamentLevelRefusal/);
  assert.throws(() => patchTournamentAdmissionFinalizeSource(candidate[2].func), /already installed/);
  assert.throws(() => patchTournamentAdmissionFinalizeSource('return [null, msg];'), /source drift/);
});

test('owner URL is resolved through the Function library and malformed bases fail closed', () => {
  const execute = new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', 'URL', source);
  for (const [base, accepted] of [
    ['https://cup.example/api/', true], ['http://cup.example/api', false], ['https://cup.example/notapi', false],
    ['https://cup.example/api?', false], ['https://cup.example/api#', false],
    [['https://user', 'cup.example/api'].join('@'), false],
  ]) {
    const ctx = context();
    const msg = { _subscriptionBooking: ctx, payload: { acknowledged: true, insertedId: ctx.operationKey } };
    execute(msg, { get: () => base }, { get: () => undefined }, {}, url, undefined);
    assert.equal(ctx.step === 'tournament_admission', accepted, base);
    if (accepted) assert.equal(msg.url, 'https://cup.example/api/tournaments/exercise/subscription-admission');
    else assert.equal(msg.statusCode, 202);
  }
});


test('LK1 completion preserves the existing payment safety check before telling CUP booking is complete', () => {
  const gateway = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const finish = gateway.slice(gateway.indexOf('const lk1Finish ='), gateway.indexOf('// EVENT_PAYMENT_ROUTES'));
  const composed = base.replace('const ctx = isObj(msg._subscriptionBooking)', finish + '\nconst ctx = isObj(msg._subscriptionBooking)')
    .replace('if (ctx.managedCreateBinding !== undefined) {', 'if (ctx.step === "fixture_finish") return lk1Finish(ctx);\nif (ctx.managedCreateBinding !== undefined) {');
  const execute = new Function('msg', 'env', 'global', 'node', 'lk1Stop', 'tournamentOwnerUrl', patchTournamentAdmissionSource(composed));
  for (const price of [0, 100]) {
    const ctx = context({ step: 'fixture_finish', confirmedBookingId: 'confirmed-booking',
      lk1: { decision: { benefit: { finalPriceMinor: price } } } });
    const msg = { _subscriptionBooking: ctx };
    const result = execute(msg, { get: key => key === 'TOURNAMENT_OWNER_INTEGRATION_TOKEN' ? 'synthetic-integration' : env.get(key) },
      { get: () => undefined }, { warn() {}, error() {} }, (_ctx, code) => ({ refused: code }), url);
    if (price) {
      assert.equal(result.refused, 'LK1_PAYMENT_RECONCILIATION_REQUIRED');
      assert.equal(msg.method, undefined);
    } else {
      assert.equal(msg.method, 'POST');
      assert.match(msg.url, /subscription-admission\/complete$/);
      assert.equal(msg.payload.bookingId, 'confirmed-booking');
    }
  }
});

test('confirmed replay restores only a tracked original tournament and fences the completion ACK', () => {
  const fixture = source.replace('if (ctx.managedCreateBinding !== undefined) {', `
    if (ctx.step === "fixture_replay") {
      const pending = tournamentAdmissionRestoreCompletion(ctx, msg.payload);
      if (pending) return pending;
      return tournamentAdmissionComplete(ctx, "original-booking") ?? finishConfirmed(ctx, "original-booking");
    }
    if (ctx.managedCreateBinding !== undefined) {`);
  const execute = new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', fixture);
  const config = { get: key => key === 'TOURNAMENT_OWNER_INTEGRATION_TOKEN' ? 'synthetic-integration' : env.get(key) };
  const invoke = msg => execute(msg, config, { get: () => undefined }, { warn() {}, error() {} }, url);
  const replay = tournamentAdmission => {
    const msg = { _subscriptionBooking: context({ step: 'fixture_replay', category: undefined }),
      payload: { category: 'tournament', ...(tournamentAdmission !== undefined ? { tournamentAdmission } : {}) } };
    invoke(msg);
    return msg;
  };
  const grant = { schemaVersion: 1, state: 'ADMITTED', operationId: 'original-owner', actorClientId: 'actor',
    requestOperationId: 'op-id', clientSubscriptionId: 'subscription', exerciseId: 'exercise' };
  const legacy = replay(undefined);
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.method, undefined);
  const foreign = replay({ ...grant, exerciseId: 'foreign-exercise' });
  assert.equal(foreign.statusCode, 202);
  assert.equal(foreign.method, undefined);

  const completed = { state: 'COMPLETED', bookingId: 'original-booking', requestOperationId: 'op-id' };
  for (const [payload, redirect, expected] of [
    [completed, false, 200],
    [{ ...completed, bookingId: 'another-booking' }, false, 202],
    [{ ...completed, requestOperationId: 'another-request' }, false, 202],
    [{ state: 'LEGACY_UNTRACKED', requestOperationId: 'op-id' }, false, 202],
    [completed, true, 202],
  ]) {
    const msg = replay(grant);
    assert.match(msg.url, /subscription-admission\/complete$/);
    assert.deepEqual(msg.payload, { operationId: 'op-id', clientSubscriptionId: 'subscription',
      bookingId: 'original-booking', ownerOperationId: 'original-owner' });
    invoke(Object.assign(msg, { statusCode: 201, responseUrl: msg.url, payload, followRedirects: redirect }));
    assert.equal(msg.statusCode, expected);
  }
});

function admitted() {
  const ctx = context(); step(ctx, { acknowledged: true, insertedId: 'op-key' });
  const grant = { schemaVersion: 1, state: 'ADMITTED', operationId: 'owner-op', requestOperationId: ctx.operationId,
    actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId, clientSubscriptionId: ctx.clientSubscriptionId };
  const { msg } = response(ctx, 200, grant);
  return { ctx, grant, persisted: { _id: ctx.operationKey, ...context(), ...msg.payload[1].$set } };
}
test('ADMITTED preaccept persists explicit predispatch phase; recheck refusal is fenced without mistaking upstreamAttemptedAt for POST', () => {
  const { ctx, grant, persisted } = admitted();
  assert.equal(persisted.tournamentProviderPhase, 'PRE_DISPATCH'); assert.ok(persisted.upstreamAttemptedAt);
  assert.deepEqual(persisted.tournamentAdmission, grant);
  ctx.step = 'exercise_recheck';
  const { msg } = step(ctx, { id: 'exercise' }, { statusCode: 200 });
  const [filter, update, options] = msg.payload;
  assert.equal(ctx.step, 'tournament_abort_saved');
  assert.equal(filter.tournamentProviderPhase, 'PRE_DISPATCH'); assert.equal(filter.upstreamAttemptedAt, undefined);
  assert.equal(filter.operationId, 'op-id'); assert.deepEqual(filter.tournamentAdmission, grant);
  assert.deepEqual(filter.managedEntitlementOperationId, { $exists: false });
  assert.equal(update.$set.tournamentAbort.proof, 'PRE_DISPATCH_REJECTED_V1');
  assert.equal(options.writeConcern.w, 'majority');
  step(ctx, null, { error: Error('ACK lost') }); assert.equal(ctx.step, 'tournament_abort_read');
});
test('managed quote compensation requires an owned daily guard and a valid quote from the same fresh provider read', () => {
  const harness = source.replace('if (ctx.managedCreateBinding !== undefined) {', `
    if (ctx.step === "exercise_recheck") {
      return tournamentAdmissionManagedAbort(ctx, msg.payload.exercise, msg.payload.quote)
        || tournamentAdmissionPending(ctx);
    }
    if (ctx.managedCreateBinding !== undefined) {`);
  const execute = new Function('msg', 'env', 'global', 'node', 'tournamentOwnerUrl', harness);
  const exercise = { id: 'exercise', typeId: 839, directionId: 2617 };
  const getUrl = 'https://api.vivacrm.ru/end-user/api/v1/fixture/exercises/exercise';
  for (const [name, contextDelta, body, httpDelta] of [
    ['fresh change', {}, {}, {}],
    ['foreign guard', { lk1DailyVisitOwned: false }, {}, {}],
    ['already dispatching', { tournamentDispatchGranted: true }, {}, {}],
    ['wrong exercise', {}, { exercise: { ...exercise, id: 'other' } }, {}],
    ['unavailable quote', {}, { quote: { code: 'LK1_EVENT_TARIFF_UNVERIFIED' } }, {}],
    ['redirected read', {}, {}, { responseUrl: 'https://elsewhere.example/fixture' }],
    ['transport failure', {}, {}, { statusCode: 503, error: { message: 'fixture error' } }],
  ]) {
    const { ctx, grant } = admitted();
    Object.assign(ctx, { step: 'exercise_recheck', caller: 'http', managedAction: 'BOOK_TOURNAMENT',
      lk1DailyVisitOwned: true, lk1: { fingerprint: 'original', dailyVisitPolicyVersion: 1,
        decision: { subscriptionVisitCount: 1 } }, ...contextDelta });
    const msg = { _subscriptionBooking: ctx, payload: { exercise, quote: { fingerprint: 'changed' }, ...body },
      statusCode: 200, method: 'GET', url: getUrl, responseUrl: getUrl, followRedirects: false, maxRedirects: 0, ...httpDelta };
    execute(msg, env, {}, {}, url);
    if (name !== 'fresh change') {
      assert.equal(msg.statusCode, 202, name);
      assert.notEqual(ctx.step, 'tournament_abort_saved', name);
      continue;
    }
    assert.equal(ctx.step, 'tournament_abort_saved');
    const [query, update, options] = msg.payload;
    assert.equal(query['lk1.fingerprint'], 'original');
    assert.equal(query['lk1.decision.subscriptionVisitCount'], 1);
    assert.equal(query.serviceDate, ctx.serviceDate);
    assert.equal(query.tournamentProviderPhase, 'PRE_DISPATCH');
    assert.deepEqual(query.tournamentAdmission, grant);
    for (const marker of ['lk1.checkout', 'lk1.transactionId', 'lk1.transactionIntent', 'acceptedAt', 'correlationId']) {
      assert.deepEqual(query[marker], { $exists: false });
    }
    assert.equal(update.$set.tournamentAbort.recheck, 'LK1_QUOTE_CHANGED');
    assert.equal(options.writeConcern.w, 'majority');
  }
});
test('CUP abort timeout never acknowledges compensation or releases guard', () => {
  const { ctx, grant } = admitted(); ctx.step = 'tournament_abort'; ctx.tournamentAdmission = grant;
  const { msg } = step(ctx, null, { error: Error('timeout') });
  assert.equal(msg.statusCode, 202); assert.equal(ctx.step, 'tournament_abort');
});
test('lost dispatch ACK cannot issue the booking POST', () => {
  const { ctx } = admitted(); ctx.step = 'tournament_dispatch_saved';
  const { msg } = step(ctx, { acknowledged: true, matchedCount: 1 }, { error: Error('ACK lost') });
  assert.equal(msg.statusCode, 202); assert.notEqual(ctx.step, 'booking_create');
  assert.equal(ctx.tournamentDispatchGranted, undefined);
});
test('acknowledged dispatch emits one provider POST through the actual booking builder', () => {
  const { ctx } = admitted(); ctx.step = 'tournament_dispatch_saved';
  const msg = { _subscriptionBooking: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null } };
  run(msg, env, { get: key => key === 'vivacrm_access_token' ? 'synthetic-token' : undefined }, { warn() {}, error() {} }, url);
  assert.equal(ctx.step, 'booking_create'); assert.equal(msg.method, 'POST'); assert.match(msg.url, /\/exercises\/exercise\/bookings$/);
});

test('a different event cannot reclaim a shared-day ledger before tournament abort cleanup', () => {
  for (const limitMode of ['shared_day', 'category_day']) {
    for (const category of ['tournament', 'group_training']) {
      for (const acknowledged of [false, true]) {
        const original = context({ _id: 'op-key', operationId: 'original', limitMode,
          state: 'FAILED', tournamentProviderPhase: 'PRE_DISPATCH',
          tournamentAbort: { proof: 'PRE_DISPATCH_REJECTED_V1', acknowledged },
          failure: { rawCode: 'SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE' },
          tournamentAdmission: { operationId: 'cup-original', requestOperationId: 'original',
            actorClientId: 'actor', exerciseId: 'exercise', clientSubscriptionId: 'subscription' } });
        const next = context({ step: 'operation_find', operationId: 'next',
          exerciseId: 'other-exercise', category, limitMode });
        const { msg } = step(next, [original]);
        assert.equal(msg.statusCode, 202, `${limitMode}/${category}/ack=${acknowledged}`);
        assert.notEqual(next.step, 'operation_reclaim');
        assert.equal(next.operationId, 'next');
        assert.equal(next.exerciseId, 'other-exercise');
      }
    }
  }
});
