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
