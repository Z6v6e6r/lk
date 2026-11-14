import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCancellationSyncRecovery, patchCancellationSyncRouter } from '../prepare_cancellation_sync_recovery.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { fixture } from './fixtures/lk1FreeCancellationFixtures.mjs';
import { lk1SeatReleasedOperation } from '../lib/lk1FreeCancellation.mjs';
const edits = JSON.parse(fs.readFileSync('scripts/lib/cancellationSyncSourceEdits.json'));
const input = process.env.CANCELLATION_SYNC_LIVE_SOURCE;
test('owned split-leave edits reproduce maintained sources exactly and reject repeated application', () => {
  for (const file of ['scripts/nodered_games_nodes/fn_split_leave_authorize.js', 'scripts/nodered_games_nodes/fn_split_leave_router.js']) {
    const current = fs.readFileSync(file, 'utf8'); let before = current;
    for (const [a, b] of [...edits[file]].reverse()) {
      assert.equal(before.split(b).length, 2); before = before.replace(b, () => a);
    }
    let after = before;
    for (const [a, b] of edits[file]) { assert.equal(after.split(a).length, 2); after = after.replace(a, () => b); }
    assert.equal(after, current);
  }
});
test('actual compiled router recovers a cancelled guard owner and resumes exact takeover without SERVICE', {
  skip: !input && 'private production graph is intentionally absent from Git/CI',
}, async () => {
  const { candidateBytes } = composeCancellationSyncRecovery(fs.readFileSync(input));
  const body = JSON.parse(candidateBytes).find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  const run = new Function('msg', 'node', 'global', 'env', 'flow', body), f = fixture();
  f.b.isCancelled = f.b.cancelled = true;
  Object.assign(f.sub, { status: 'ACTIVE', variant: 'BY_VISITS', visitsLeft: 29,
    bookings: [{ ...f.sub.bookings[1], exerciseDate: '2099-11-10T09:00:00Z' }] });
  const key = `lk1-daily-visit:${JSON.stringify([f.op.tenantKey, f.op.clientSubscriptionId, f.op.serviceDate])}`;
  const guard = { _id: key, kind: 'LK1_DAILY_VISIT_V1', tenantKey: f.op.tenantKey,
    clientSubscriptionId: f.op.clientSubscriptionId, serviceDate: f.op.serviceDate,
    ownerOperationKey: f.op._id, ownerOperationId: f.op.operationId };
  f.db.rows.set(key, guard);
  const ctx = { ...f.op, operationKey: 'new-operation', operationId: 'lk-subscription-new', action: 'book',
    caller: 'http', exerciseId: 'new-exercise', step: 'lk1_daily_visit_owner',
    lk1DailyVisitPrevious: guard, lk1: { ...f.op.lk1, dailyVisitPolicyVersion: 1 } };
  let msg = { _subscriptionBooking: ctx, payload: [f.op] };
  const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url') + '.fixture';
  const host = { get: k => k === 'vivacrm_access_token' ? token : undefined };
  for (let i = 0; i < 100; i++) {
    const ports = run(msg, { warn() {}, error() {} }, host, host, host), port = ports.findIndex(Boolean);
    msg = ports[port]; assert.ok(msg);
    if (ctx.step === 'lk1_daily_visit_takeover') {
      assert.equal(port, 3); assert.equal(msg.payload[0].ownerOperationKey, f.op._id);
      assert.ok(lk1SeatReleasedOperation(f.db.rows.get(f.op._id)));
      assert.equal(f.provider.calls.filter(c => c.method !== 'GET').length, 0); return;
    }
    if (port === 0) {
      const u = new URL(msg.url); assert.equal(msg.method, 'GET');
      const r = await f.provider.request({ method: msg.method, path: u.pathname + u.search });
      msg.payload = r.payload; msg.statusCode = r.status; msg.responseUrl = msg.url;
    } else if (port === 1) msg.payload = await f.db.find(msg.payload).limit(1001).toArray();
    else if (port === 3) msg.payload = await f.db.updateOne(...msg.payload);
    else assert.fail(`unexpected port ${port}: ${JSON.stringify(msg.payload)}`);
  }
  assert.fail('router failed to resume guard takeover');
});
test('candidate refuses a different baseline and unreviewed protocol preimage', () => {
  assert.throws(() => composeCancellationSyncRecovery(Buffer.from('[]')), /SOURCE_DRIFT/);
  assert.throws(() => patchCancellationSyncRouter('unrelated'), /PREIMAGE_DRIFT/);
});
test('private frozen baseline yields only the reviewed delta; inverse and tampering guards hold', {
  skip: !input && 'private production graph is intentionally absent from Git/CI',
}, () => {
  const liveBytes = fs.readFileSync(input), result = composeCancellationSyncRecovery(liveBytes);
  const before = JSON.parse(liveBytes), after = JSON.parse(result.candidateBytes);
  assert.equal(after.length - before.length, 54); assert.equal(result.allowedChanges.length, 20);
  assert.ok(after.some(n => n.url === '/lk/games/:gameId/cancellation/status'));
  assert.ok(after.some(n => n.url === '/lk/games/:gameId/organizer/transfer'));
  const altered = structuredClone(after); altered.find(n => n.type === 'function').func += '\n// unauthorized drift';
  assert.throws(() => validateReviewedFlowContract({ liveBytes,
    candidateBytes: Buffer.from(JSON.stringify(altered)), contract: result.contract }));
  const changed = new Map(before.map(n => [n.id, n]));
  const restored = after.filter(n => changed.has(n.id)).map(n => changed.get(n.id));
  assert.deepEqual(restored, before);
});
