import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
const games = '../nodered_games_nodes/';
const owner = '../nodered_subscription_booking_nodes/';
const globals = { subscriptions_runtime_environment: 'PROD', subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
  subscriptions_entitlement_integration_token: 'synthetic-integration-value-'.repeat(2),
  subscriptions_owner_evidence_enabled: true, subscriptions_owner_evidence_secret: 'synthetic-owner-value-'.repeat(2), crypto };
const run = (path, msg, values = globals) => new Function('msg', 'global', 'env',
  fs.readFileSync(new URL(path, import.meta.url), 'utf8'))(msg, { get: key => values[key] },
  { get: key => key === 'LK1_BOOKED_OPERATION_OWNER_BASE_URL' ? 'http://127.0.0.1:1880' : key === 'LK1_BOOKED_OPERATION_OWNER_TENANT_KEY' ? 'iSkq6G' : undefined });
const router = msg => run(owner + 'fn_subscription_booking_router.js', msg);
const now = () => new Date().toISOString();
const clone = structuredClone;
function fixture() {
  const operation = { _id: 'daily:fixture', operationId: 'booking:fixture', tenantKey: 'iSkq6G', actorClientId: 'client-fixture',
    exerciseId: 'exercise-fixture', clientSubscriptionId: 'subscription-fixture', serviceDate: '2026-10-31',
    bookingId: 'provider-booking-fixture', managedEntitlementOperationId: 'usage:fixture',
    managedSubscriptionInstanceId: 'instance-fixture', managedEnvironment: 'PROD', managedEntitlementState: 'CONFIRMED', state: 'CONFIRMED' };
  const ctx = { operationId: 'self-leave:game-fixture:client-fixture:generation-fixture',
    gameId: 'game-fixture', exerciseId: operation.exerciseId, actorClientId: operation.actorClientId,
    targetClientId: operation.actorClientId, clientSubscriptionId: operation.clientSubscriptionId,
    mode: 'SELF', reason: 'PLAYER_LEFT', claimToken: 'claim:fixture', membershipVersion: 'generation-fixture',
    actorAuthHeader: 'Bearer synthetic-actor', initialBookingIds: [operation.bookingId],
    requestedRefundMethod: 'SERVICE', vivaTargetMode: 'BOOKINGS', vivaVerification: 'active_absent_history_cancelled',
    vivaVerifiedAt: now(), subscriptionReturnState: 'RETURN_PENDING',
    subscriptionReturnChecks: [{ bookingId: operation.bookingId, clientSubscriptionId: operation.clientSubscriptionId,
      visitsLeftBefore: 3, expectedReturnCount: 1 }] };
  const started = run(games + 'fn_split_leave_operation_start.js', { _splitLeaveCtx: ctx });
  const leave = clone(started[0].payload[1].$setOnInsert);
  assert.equal(leave.tenantKey, 'iSkq6G');
  // The existing provider-return evaluator supplies RETURN_VERIFIED, not a
  // fabricated new bridge status. All provider transport in this harness is inert.
  ctx.step = 'verify_subscription_return';
  const verified = run(games + 'fn_split_leave_router.js', { _splitLeaveCtx: ctx, statusCode: 200,
    payload: [{ subscriptionId: operation.clientSubscriptionId, visitsLeft: 4,
      bookings: [{ id: operation.bookingId, isCancelled: true }] }] });
  assert.equal(verified[3]._splitLeaveCtx.subscriptionReturnState, 'RETURN_VERIFIED');
  const stored = run(games + 'fn_split_leave_operation_viva_confirmed.js', verified[3]);
  Object.assign(leave, stored[0].payload[1].$set);
  const receipt = { schemaVersion: 1, operationId: operation.managedEntitlementOperationId,
    subscriptionInstanceId: operation.managedSubscriptionInstanceId, providerBookingId: operation.bookingId,
    operationState: 'CONFIRMED', compensationState: 'NONE', releaseReason: null };
  return { operation, leave, ctx, receipt, calls: [], writes: [] };
}
const equals = (actual, expected) => {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if ('$exists' in expected) return expected.$exists === (actual !== undefined);
    if ('$in' in expected) return expected.$in.includes(actual);
    if ('$ne' in expected) return actual !== expected.$ne;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
};
function apply(row, query, update) {
  if (!row || !Object.entries(query).every(([key, value]) => equals(row[key], value))) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  Object.assign(row, clone(update.$set || {}));
  for (const key of Object.keys(update.$unset || {})) delete row[key];
  for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
  for (const [key, value] of Object.entries(update.$addToSet || {})) row[key] = [...new Set([...(row[key] || []), value])];
  return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
}
function driveOwner(f, request, options = {}) {
  let output = run(owner + 'fn_subscription_booking_prepare.js', { payload: request.payload,
    req: { method: 'POST', headers: { authorization: request.headers.Authorization, 'idempotency-key': f.ctx.operationId } } });
  if (output[1]) return output[1];
  for (let count = 0; count < 35; count++) {
    if (output[4]) return output[4];
    const index = output.findIndex(Boolean); const msg = output[index];
    assert.ok(msg, 'owner must produce a bounded outcome');
    if (index === 7 || index === 1) {
      if (msg._subscriptionBooking.step === 'managed_leave_final_authority') options.beforeFinalAuthority?.(f);
      const row = index === 7 ? f.leave : f.operation;
      f.calls.push({ kind: index === 7 ? 'leave-read' : 'operation-read' });
      msg.payload = row ? [clone(row)] : []; delete msg.error;
      output = router(msg); continue;
    }
    if (index === 3) {
      const [query, update] = msg.payload;
      f.writes.push(clone(msg.payload));
      if (update.$set?.state === 'RELEASED') assert.equal(f.receipt.compensationState, 'APPLIED');
      msg.payload = apply(f.operation, query, update);
      if (options.localAckLost && update.$set?.state === 'RELEASED') msg.error = { message: 'synthetic lost local acknowledgement' };
      output = router(msg); continue;
    }
    assert.equal(index, 0);
    f.calls.push({ kind: 'http', method: msg.method, url: msg.url, body: clone(msg.payload) });
    assert.ok(msg.method === 'GET' || msg.url.startsWith('https://padlhub.su/api/internal/subscriptions/entitlements/'));
    msg.responseUrl = msg.url; msg.statusCode = 200; delete msg.error;
    if (msg._subscriptionBooking.step === 'profile') msg.payload = { id: f.ctx.actorClientId, phone: '+12025550101' /* reserved fictional NANP 555-0101 */ };
    else if (msg._subscriptionBooking.step === 'active_bookings') msg.payload = { content: [] };
    else if (msg._subscriptionBooking.step === 'history_bookings') msg.payload = { content: [{
      id: f.operation.bookingId, clientId: f.operation.actorClientId, exerciseId: f.operation.exerciseId,
      clientSubscriptionId: f.operation.clientSubscriptionId, paymentType: 'SUBSCRIPTION', status: 'CANCELLED',
      exerciseDate: f.operation.serviceDate, timeFrom: '09:00:00' }] };
    else if (msg._subscriptionBooking.step === 'managed_leave_readback') {
      if (options.readbackLost && f.receipt.compensationState === 'APPLIED') {
        msg.error = { message: 'synthetic CUP response loss' }; msg.statusCode = 503;
      }
      msg.payload = clone(options.badReceipt || f.receipt);
    } else if (msg._subscriptionBooking.step === 'managed_entitlement_release') {
      assert.ok(f.operation.managedSelfLeaveCancellation, 'marker committed before release');
      const token = msg.headers['X-Subscription-Owner-Evidence'];
      assert.ok(token.startsWith('release-v1.'));
      const [, encoded, mac] = token.split('.');
      assert.equal(mac, crypto.createHmac('sha256', globals.subscriptions_owner_evidence_secret)
        .update(`owner-evidence:release:v1\0${encoded}`).digest('hex'));
      const proof = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      assert.equal(proof.issuedAt, f.operation.managedSelfLeaveCancellation.observedAt);
      assert.equal(proof.operationId, f.operation.managedEntitlementOperationId);
      assert.equal(proof.providerBookingId, f.operation.bookingId);
      assert.equal(proof.reason, 'BOOKING_CANCELLED');
      f.receipt = { ...f.receipt, operationState: 'COMPENSATED', compensationState: 'APPLIED', releaseReason: 'BOOKING_CANCELLED' };
      msg.error = { message: 'synthetic release response lost after commit' }; msg.statusCode = 503; msg.payload = undefined;
    } else assert.fail(`unexpected owner step ${msg._subscriptionBooking.step}`);
    output = router(msg);
  }
  assert.fail('owner exceeded bounded state transitions');
}
function bridge(f, options = {}) {
  const route = run(games + 'fn_split_leave_daily_limit_route.js', { _splitLeaveCtx: f.ctx, payload: [clone(f.operation)] });
  if (!route[4]) return route;
  const probe = run(games + 'fn_split_leave_managed_compensation.js', route[4])[0];
  assert.equal(probe.method, 'GET');
  const reply = run(owner + 'fn_subscription_booking_owner_contract_probe.js', { _subscriptionBooking: { step: 'booked_operation_contract_probe' },
    req: { method: 'GET', headers: { 'x-booked-operation-owner-contract': '3' } } })[4];
  const delegated = run(games + 'fn_split_leave_managed_compensation.js', { ...probe, statusCode: 200,
    responseUrl: probe.url, payload: options.probe || reply.payload });
  if (!delegated[0]) return delegated;
  const result = driveOwner(f, delegated[0], options);
  return run(games + 'fn_split_leave_managed_compensation.js', { ...delegated[0],
    statusCode: result.statusCode, payload: result.payload, responseUrl: delegated[0].url });
}
const releases = f => f.calls.filter(call => call.url?.endsWith('/entitlements/release'));
test('SELF RETURN_VERIFIED reaches strict signed release, canonical compensation and local receipt despite lost CUP ACK', () => {
  const f = fixture(); const result = bridge(f);
  assert.ok(result[1], JSON.stringify({ result: result.map(m => m?.payload), calls: f.calls })); assert.equal(f.operation.state, 'RELEASED');
  assert.deepEqual(f.operation.managedSelfLeaveReceipt, f.receipt); assert.equal(releases(f).length, 1);
  assert.equal(result[1]._splitLeaveCtx.dailyLimitReleaseOutcome, 'RELEASED');
  assert.ok(!JSON.stringify(f.writes).includes('Bearer'));
  assert.ok(!JSON.stringify(f.writes).includes('release-v1.'));
  assert.ok(!JSON.stringify(f.writes).includes(globals.subscriptions_owner_evidence_secret));
  const prior = clone(f.calls); assert.ok(bridge(f)[1]); assert.deepEqual(f.calls, prior, 'terminal replay reads local receipt only');
});
test('lost release/readback responses keep local CONFIRMED; fresh authenticated expired-lease retry completes after original proof TTL', () => {
  const f = fixture(); assert.ok(bridge(f, { readbackLost: true })[3]);
  assert.equal(f.operation.state, 'CONFIRMED'); assert.equal(releases(f).length, 1);
  f.operation.managedSelfLeaveCancellation.observedAt = new Date(Date.now() - 120_000).toISOString();
  f.leave.localApplyLeaseUntil = new Date(Date.now() - 1).toISOString();
  const fresh = { ...clone(f.ctx), claimToken: 'fresh:claim', managedSelfLeaveReclaim: undefined };
  const route = run(games + 'fn_split_leave_operation_route.js', { _splitLeaveCtx: fresh, payload: [clone(f.leave)] });
  assert.ok(route[3], 'fresh foreground actor can reclaim the exact original return');
  const claim = run(games + 'fn_split_leave_operation_claim.js', route[3])[0];
  const [query, update] = clone(claim.payload);
  const winner = apply(f.leave, query, update); const loser = apply(f.leave, query, update);
  assert.equal(loser.matchedCount, 0);
  assert.ok(run(games + 'fn_split_leave_operation_claim_ack.js', { ...clone(claim), payload: loser })[1]);
  const ack = run(games + 'fn_split_leave_operation_claim_ack.js', { ...claim, payload: winner });
  assert.ok(ack[2], 'recovery goes directly to daily read, not provider cancellation');
  f.ctx = ack[2]._splitLeaveCtx;
  const httpBefore = f.calls.filter(call => call.kind === 'http').length;
  const result = bridge(f, { localAckLost: true }); assert.ok(result[1]);
  assert.equal(f.operation.state, 'RELEASED'); assert.equal(releases(f).length, 1);
  const newCalls = f.calls.filter(call => call.kind === 'http').slice(httpBefore);
  assert.ok(newCalls.every(call => call.url.endsWith('/profile') || call.url.endsWith('/entitlements/readback')));
});
test('wrong tenant, actor, instance, booking, generation and incomplete old leave proof cannot release usage', () => {
  const mutations = [f => { delete f.leave.tenantKey; }, f => { f.leave.tenantKey = 'foreign'; },
    f => { f.leave.actorClientId = 'foreign'; }, f => { f.leave.targetClientId = 'foreign'; },
    f => { f.leave.membershipVersion = 'new-generation'; }, f => { f.leave.bookingIds = ['rejoined-booking']; },
    f => { f.leave.subscriptionReturnState = 'RETURN_PENDING'; }, f => { f.leave.requestedRefundMethod = 'NONE'; },
    f => { f.leave.localApplyClaimToken = 'new-claim'; }, f => { f.leave.subscriptionReturnChecks = []; },
    f => { f.operation.managedSubscriptionInstanceId = ''; }, f => { f.operation.actorClientId = 'foreign'; },
    f => { f.operation.bookingId = 'rejoined-booking'; }];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f); const result = bridge(f);
    assert.ok(result[3]); assert.equal(releases(f).length, 0); assert.equal(f.operation.state, 'CONFIRMED');
  }
});
test('old owner, redirect or no actor credential never dispatches compensation; pending visit and staff modes retain existing paths', () => {
  const f = fixture();
  assert.ok(bridge(f, { probe: { contractVersion: 1, owner: 'LK1_SUBSCRIPTION_BOOKING_OWNER', policy: 'ATOMIC_MANAGED_V1' } })[3]);
  assert.equal(f.calls.length, 0);
  delete f.ctx.actorAuthHeader; assert.ok(bridge(f)[3]); assert.equal(f.calls.length, 0);
  f.ctx.subscriptionReturnState = 'RETURN_PENDING'; assert.ok(bridge(f)[1]); assert.equal(f.operation.state, 'CONFIRMED');
  f.ctx.subscriptionReturnState = null; f.ctx.mode = 'STAFF_TARGET';
  assert.ok(bridge(f)[0], 'existing local-only staff behavior remains separate'); assert.equal(releases(f).length, 0);
});
test('canonical receipt must have exact cancellation semantics and binding', () => {
  for (const bad of [{ operationState: 'FAILED' }, { compensationState: 'NONE' }, { releaseReason: 'PROVIDER_REJECTED' },
    { providerBookingId: 'new-booking' }, { subscriptionInstanceId: 'new-instance' }, { operationId: 'new-operation' }, { extra: true }]) {
    const f = fixture(); assert.ok(bridge(f, { badReceipt: { ...f.receipt, operationState: 'COMPENSATED', compensationState: 'APPLIED', releaseReason: 'BOOKING_CANCELLED', ...bad } })[3]);
    assert.equal(f.operation.state, 'CONFIRMED'); assert.equal(releases(f).length, 0);
  }
});
test('expired pending marker never renews evidence or retries release; absent signer cannot downgrade to unsigned', () => {
  const f = fixture(); bridge(f, { readbackLost: true });
  f.operation.managedSelfLeaveCancellation.observedAt = new Date(Date.now() - 120_000).toISOString();
  f.receipt = { ...f.receipt, operationState: 'CONFIRMED', compensationState: 'NONE', releaseReason: null };
  const marker = clone(f.operation.managedSelfLeaveCancellation); const before = releases(f).length;
  assert.ok(bridge(f)[3]); assert.equal(releases(f).length, before);
  assert.deepEqual(f.operation.managedSelfLeaveCancellation, marker); assert.equal(f.operation.state, 'CONFIRMED');
  const fresh = fixture(); const original = globals.subscriptions_owner_evidence_enabled;
  try { globals.subscriptions_owner_evidence_enabled = false; assert.ok(bridge(fresh)[3]); }
  finally { globals.subscriptions_owner_evidence_enabled = original; }
  assert.equal(releases(fresh).length, 0); assert.equal(fresh.operation.state, 'CONFIRMED');
});
test('strict prepare rejects malformed or downgraded bridge binding without profile I/O', () => {
  const f = fixture(); const message = run(games + 'fn_split_leave_daily_limit_route.js', { _splitLeaveCtx: f.ctx, payload: [f.operation] })[4];
  const binding = message._splitLeaveCtx.managedSelfLeave;
  for (const bad of [null, [], { ...binding, extra: true }, { ...binding, schemaVersion: 2 },
    { ...binding, tenantKey: 'foreign' }, { ...binding, actorClientId: 'bad\n' }]) {
    const response = run(owner + 'fn_subscription_booking_prepare.js', { req: { headers: { authorization: f.ctx.actorAuthHeader } },
      payload: { action: 'release', operationId: f.ctx.operationId, bookingId: f.operation.bookingId, managedSelfLeave: bad } });
    assert.equal(response[0], null); assert.equal(response[1].statusCode, 400);
  }
});
test('foreground active lease and stale claim acknowledgement cannot restart cancellation', () => {
  const f = fixture();
  const response = run(games + 'fn_split_leave_operation_route.js', { _splitLeaveCtx: { ...clone(f.ctx), claimToken: 'new:claim' }, payload: [f.leave] });
  assert.equal(response[3], undefined); assert.equal(response[2].statusCode, 202);
  f.leave.localApplyLeaseUntil = new Date(Date.now() - 1).toISOString();
  for (const change of [{ membershipVersion: 'new-generation' }, { actorClientId: 'foreign' }, { initialBookingIds: ['rejoined'] }]) {
    const output = run(games + 'fn_split_leave_operation_route.js', { _splitLeaveCtx: { ...clone(f.ctx), claimToken: 'new:claim', ...change }, payload: [clone(f.leave)] });
    assert.equal(output[0], null); assert.equal(output[3], undefined); assert.equal(output[2].statusCode, 409);
  }
});
test('rejoin or newer leave claim after CUP compensation cannot make stale owner acknowledgement release another local operation', () => {
  for (const mutate of [f => { f.operation.bookingId = 'replacement-booking'; },
    f => { f.operation.operationId = 'replacement-operation'; },
    f => { f.operation.managedSubscriptionInstanceId = 'replacement-instance'; },
    f => { f.leave.localApplyClaimToken = 'newer-claim'; },
    f => { f.leave.membershipVersion = 'newer-generation'; }]) {
    const f = fixture(); assert.ok(bridge(f, { beforeFinalAuthority: mutate })[3]);
    assert.equal(f.operation.state, 'CONFIRMED'); assert.equal(releases(f).length, 1);
    assert.ok(!f.operation.managedSelfLeaveReceipt);
  }
});
test('managed provenance with missing usage references fails closed; legacy NONE mode does not invoke CUP', () => {
  const f = fixture(); delete f.operation.managedEntitlementOperationId; delete f.operation.managedSubscriptionInstanceId;
  assert.ok(bridge(f)[3]); assert.equal(f.writes.length, 0);
  const retained = fixture(); retained.ctx.requestedRefundMethod = 'NONE';
  assert.ok(bridge(retained)[0]); assert.equal(retained.calls.length, 0);
});
test('tenantless pre-deploy ordinary LK1 same-claim return retains local apply; managed tenantless proof remains pending', () => {
  const f = fixture(); delete f.leave.tenantKey;
  const legacy = run(games + 'fn_split_leave_operation_route.js', { _splitLeaveCtx: clone(f.ctx), payload: [clone(f.leave)] });
  assert.ok(legacy[1], 'existing same claim still reaches local apply'); assert.equal(legacy[1]._splitLeaveCtx.step, 'local_apply');
  assert.ok(bridge(f)[3], 'same tenantless row cannot authorize managed CUP compensation'); assert.equal(releases(f).length, 0);
  f.leave.localApplyLeaseUntil = new Date(Date.now() - 1).toISOString();
  const retry = run(games + 'fn_split_leave_operation_route.js', { _splitLeaveCtx: { ...clone(f.ctx), claimToken: 'fresh-unknown-claim' }, payload: [clone(f.leave)] });
  assert.equal(retry[2].statusCode, 202); assert.equal(retry[3], undefined, 'no new authority inferred for tenantless historical row');
});
