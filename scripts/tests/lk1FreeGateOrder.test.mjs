import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { moveFreeCancellationStepsAfterDailyHelpers } from '../patch_live_lk1_free_cancellation.mjs';
import { composeFreeGateOrder, FREE_GATE_ROUTER_ID } from '../patch_live_lk1_free_gate_order.mjs';
const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const steps = read('../nodered_lk1_hub_nodes/free_cancel.js').split('// FREE_CANCEL_STEPS\n')[1].trim();
const guard = read('../nodered_lk1_hub_nodes/daily_visit_guard.js');
// Recreate the real dispatch order; keep guard code intact, not extracted helpers.
const fixture = `
const emit = port => { const out = Array(8).fill(null); out[port] = msg; return out; };
const OUTPUT_MONGO_UPDATE = 3;
const isObj = v => v !== null && typeof v === 'object';
const normalizeId = v => String(v || '').toLowerCase();
const isValidDateKey = v => /^\\d{4}-\\d{2}-\\d{2}$/.test(v);
const lk1Stop = (ctx, code) => { msg.statusCode = 202; msg.payload = { code }; return emit(4); };
const finishError = (ctx, status, message, details) => { msg.statusCode = status; msg.payload = { details }; return emit(4); };
const prepareMongoUpdate = (ctx, step, q, change) => { ctx.step = step; msg.payload = [q, change]; return emit(3); };
const preparePreaccept = ctx => { if (!ctx.lk1DailyVisitOwned) return lk1DailyVisitAcquire(ctx); ctx.step = 'preaccepted'; return emit(3); };
const prepareBookingCreate = ctx => { if (!ctx.lk1DailyVisitOwned) { ctx.lk1DailyVisitContinuation = 'booking'; return lk1DailyVisitAcquire(ctx); } ctx.step = 'booking'; return emit(0); };
const ctx = msg._subscriptionBooking;
${steps}
${guard}
`;
const host = { get() {} }, node = { warn() {}, error() {} };
function message(continuation = 'preaccept') { return { payload: [], _subscriptionBooking: {
  step: 'lk1_free_cancel_booking_gate', lk1FreeGateContinuation: continuation,
  tenantKey: 'fixture', actorClientId: 'actor', clientSubscriptionId: 'subscription', serviceDate: '2099-11-14',
  operationKey: 'fixture-key', operationId: 'fixture-operation',
  lk1: { dailyVisitPolicyVersion: 1, decision: { subscriptionVisitCount: 1 } },
} }; }
function execute(source, msg) { return new Function('msg', 'node', 'global', 'env', 'flow', source)(msg, node, host, host, host); }
test('old full dispatch order reproduces production ReferenceError', () => {
  assert.throws(() => execute(fixture, message()), /Cannot access 'lk1DailyVisitAcquire' before initialization/);
});
function regression(source) {
  for (const continuation of ['preaccept', 'booking']) {
    const msg = message(continuation), out = execute(source, msg);
    assert.ok(out[3]); assert.equal(out[0], null, 'no provider write before the atomic daily claim');
    assert.equal(msg._subscriptionBooking.step, 'lk1_daily_visit_claim');
    assert.equal(msg.payload[1].$setOnInsert.ownerOperationId, 'fixture-operation');
    assert.deepEqual(msg.payload[2], { upsert: true, writeConcern: { w: 'majority', j: true } });
    assert.equal(msg._subscriptionBooking.lk1FreeGateCleared, true);
    if (continuation === 'booking') assert.equal(msg._subscriptionBooking.lk1DailyVisitContinuation, 'booking');
  }
  const pending = message(); pending.payload = [{ kind: 'LK1_FREE_CANCEL_JOB_V1' }];
  assert.equal(execute(source, pending)[4].statusCode, 409);
  for (const bad of [null, {}]) {
    const msg = message(); msg.payload = bad;
    assert.equal(execute(source, msg)[4].statusCode, 202);
  }
  const failed = message(); failed.error = { message: 'fixture' };
  assert.equal(execute(source, failed)[4].statusCode, 202);
  const stale = message(); delete stale._subscriptionBooking.lk1.dailyVisitPolicyVersion;
  const fenced = execute(source, stale); assert.ok(fenced[3]); assert.equal(fenced[0], null);
  assert.equal(stale._subscriptionBooking.step, 'lk1_daily_visit_conflict_saved');
  assert.equal(stale.payload[1].$set.failure.rawCode, 'LK1_DAILY_VISIT_CHANGED');
}
test('reordered full dispatch preserves preaccept, booking and fail-closed guards', () => {
  regression(moveFreeCancellationStepsAfterDailyHelpers(fixture));
});
test('source drift or duplicate dispatch is refused', () => {
  assert.throws(() => moveFreeCancellationStepsAfterDailyHelpers(fixture + steps), /anchor drift/);
  assert.throws(() => moveFreeCancellationStepsAfterDailyHelpers(fixture.replace('const lk1DailyVisitReject =', 'const changed =')), /helper order drift/);
  assert.throws(() => composeFreeGateOrder(Buffer.from('[]')), /preimage drift/);
});
const live = process.env.LK1_FREE_GATE_LIVE_SOURCE;
test('exact live router candidate passes the same complete-router regressions', { skip: !live && 'private production flow is not exported to Git/CI' }, () => {
  const built = composeFreeGateOrder(fs.readFileSync(live));
  // Historical gate-order release stays frozen independently of current worker generation.
  assert.equal(built.candidateSha256, 'fa66595e6c4b89c853a6a6ee5cf2861791c05c1cc8eb006f59f3ee8e5f1581fa');
  assert.equal(built.gatewaySha256, 'a35313a5888f721f96d19bf5cf43e92bad5dc41757809e5ea8b8e8f7e5c2066b');
  const candidate = JSON.parse(built.candidateBytes), before = JSON.parse(fs.readFileSync(live));
  assert.equal(candidate.length, before.length);
  for (let i = 0; i < before.length; i++) {
    if (before[i].id !== FREE_GATE_ROUTER_ID) assert.deepEqual(candidate[i], before[i]);
    else { const { func: old, ...a } = before[i], { func: next, ...b } = candidate[i]; assert.deepEqual(a, b); assert.notEqual(old, next); }
  }
  regression(candidate.find(n => n.id === FREE_GATE_ROUTER_ID).func);
});
