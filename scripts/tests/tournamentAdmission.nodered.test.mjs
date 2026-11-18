import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import crypto from 'node:crypto';
import { composeTournamentAdmissionCandidate } from '../prepare_tournament_admission_candidate.mjs';
import { patchTournamentAdmissionSource } from '../lib/tournamentAdmissionSource.mjs';
const base = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const source = patchTournamentAdmissionSource(base);
const run = new Function('msg', 'env', 'global', 'node', source);
const env = { get: key => key === 'TOURNAMENT_OWNER_API_BASE' ? 'https://cup.example/api' : undefined };
const context = (extra = {}) => ({ step: 'operation_insert', category: 'tournament', action: 'book', actorClientId: 'actor',
  exerciseId: 'exercise', operationKey: 'op-key', operationId: 'op-id', tenantKey: 'fixture',
  clientSubscriptionId: 'subscription', serviceDate: '2026-11-18', authHeader: 'Bearer synthetic', ...extra });
function step(ctx, payload, extra = {}) {
  const msg = { _subscriptionBooking: ctx, payload, ...extra };
  const out = run(msg, env, { get: () => undefined }, { warn() {}, error() {} });
  return { msg, out };
}
function response(ctx, status, payload) {
  return step(ctx, payload, { statusCode: status, url: ctx.tournamentAdmissionRequestedUrl,
    responseUrl: ctx.tournamentAdmissionRequestedUrl, method: 'POST', followRedirects: false, maxRedirects: 0 });
}
function refused() {
  const ctx = context();
  step(ctx, { acknowledged: true, insertedId: 'op-key' });
  assert.equal(ctx.step, 'tournament_admission');
  const result = response(ctx, 403, { code: 'LEVEL_NOT_ALLOWED' });
  return { ctx, ...result };
}
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
test('patch guards composed daily acquisition before reservation, and preserves unrelated source', () => {
  const guard = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/daily_visit_guard.js', import.meta.url), 'utf8');
  const composed = base.replace('const ctx = isObj(msg._subscriptionBooking)', guard + '\nconst ctx = isObj(msg._subscriptionBooking)');
  const patched = patchTournamentAdmissionSource(composed);
  new Function('msg', 'env', 'global', 'node', patched);
  assert.match(patched, /const lk1DailyVisitAcquire = \(ctx\) => \{\n {2}const admission = tournamentAdmissionGate/);
  assert.match(patched, /\$unset: \{ admissionRelease: "" \}/);
  assert.throws(() => patchTournamentAdmissionSource(patched), /already installed/);
});


test('candidate validates exact graph preimage and preserves every unrelated node and wire', () => {
  const nodes = [{ id: 'untouched', type: 'comment', name: 'fixture' },
    { id: 'lk_subscription_booking_router_20260804', type: 'function', outputs: 5, wires: [['fixture'], [], [], [], []], func: base }];
  const raw = Buffer.from(JSON.stringify(nodes));
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const candidate = composeTournamentAdmissionCandidate(raw, digest);
  assert.deepEqual(candidate[0], nodes[0]);
  assert.deepEqual({ ...candidate[1], func: '' }, { ...nodes[1], func: '' });
  assert.throws(() => composeTournamentAdmissionCandidate(raw, '0'.repeat(64)), /preimage mismatch/);
  assert.match(candidate[1].func, /tournamentAdmissionGate/);
});


test('LK1 completion preserves the existing payment safety check before telling CUP booking is complete', () => {
  const gateway = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const finish = gateway.slice(gateway.indexOf('const lk1Finish ='), gateway.indexOf('// EVENT_PAYMENT_ROUTES'));
  const composed = base.replace('const ctx = isObj(msg._subscriptionBooking)', finish + '\nconst ctx = isObj(msg._subscriptionBooking)')
    .replace('if (ctx.managedCreateBinding !== undefined) {', 'if (ctx.step === "fixture_finish") return lk1Finish(ctx);\nif (ctx.managedCreateBinding !== undefined) {');
  const execute = new Function('msg', 'env', 'global', 'node', 'lk1Stop', patchTournamentAdmissionSource(composed));
  for (const price of [0, 100]) {
    const ctx = context({ step: 'fixture_finish', confirmedBookingId: 'confirmed-booking',
      lk1: { decision: { benefit: { finalPriceMinor: price } } } });
    const msg = { _subscriptionBooking: ctx };
    const result = execute(msg, { get: key => key === 'TOURNAMENT_OWNER_INTEGRATION_TOKEN' ? 'synthetic-integration' : env.get(key) },
      { get: () => undefined }, { warn() {}, error() {} }, (_ctx, code) => ({ refused: code }));
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
  run(msg, env, { get: key => key === 'vivacrm_access_token' ? 'synthetic-token' : undefined }, { warn() {}, error() {} });
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
