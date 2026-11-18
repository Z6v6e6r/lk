import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { patchTournamentAdmissionSource } from '../lib/tournamentAdmissionSource.mjs';
const uri = process.env.TEST_MONGODB_URI;
assert.ok(uri && new URL(uri).hostname === '127.0.0.1', 'explicit task-owned local Mongo required');
const client = new MongoClient(uri);
const database = 'tournament_nodered_task_' + randomUUID().replaceAll('-', '');
await client.connect();
const collection = client.db(database).collection('operations');
const base = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
const guardSource = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/daily_visit_guard.js', import.meta.url), 'utf8');
// Match the real daily patch: declarations and handlers appear after ctx initialization.
const composed = base.replace('if (ctx.managedCreateBinding !== undefined) {',
  guardSource + '\nif (ctx.managedCreateBinding !== undefined) {');
const source = patchTournamentAdmissionSource(composed).replace('if (ctx.managedCreateBinding !== undefined) {',
  'if (ctx.step === "fixture_dispatch") return prepareBookingCreate(ctx);\nif (ctx.managedCreateBinding !== undefined) {');
const run = new Function('msg', 'env', 'global', 'node', source);
const ctxFor = (operationId = 'operation-1') => ({ category: 'tournament', action: 'book', actorClientId: 'actor', exerciseId: 'exercise',
  operationId, operationKey: operationId, tenantKey: 'fixture', clientSubscriptionId: 'subscription', serviceDate: '2026-11-18',
  authHeader: 'Bearer synthetic', lk1: { dailyVisitPolicyVersion: 1, decision: { subscriptionVisitCount: 1 } } });
const env = { get: key => key === 'TOURNAMENT_OWNER_API_BASE' ? 'https://cup.example/api' : key === 'TOURNAMENT_OWNER_INTEGRATION_TOKEN' ? 'synthetic-owner-token' : undefined };
const execute = msg => run(msg, env, { get: key => key === 'vivacrm_access_token' ? 'synthetic-provider-token' : undefined }, { warn() {}, error() {} });
const guardKey = 'lk1-daily-visit:["fixture","subscription","2026-11-18"]';
try {
  const ctx = ctxFor();
  await collection.insertOne({ _id: ctx.operationKey, ...ctx, state: 'PREPARED' });
  await collection.insertOne({ _id: guardKey, kind: 'LK1_DAILY_VISIT_V1', tenantKey: ctx.tenantKey,
    clientSubscriptionId: ctx.clientSubscriptionId, serviceDate: ctx.serviceDate,
    ownerOperationKey: ctx.operationKey, ownerOperationId: ctx.operationId });
  let msg = { _subscriptionBooking: { ...ctx, step: 'operation_insert' }, payload: { acknowledged: true, insertedId: ctx.operationKey } };
  execute(msg); assert.equal(msg.method, 'POST');
  msg = { ...msg, statusCode: 403, responseUrl: msg.url, payload: { code: 'LEVEL_NOT_ALLOWED' } };
  execute(msg);
  const [filter, update, options] = msg.payload;
  const result = await collection.updateOne(filter, update, options); assert.equal(result.modifiedCount, 1);
  // Simulate process death after refusal commit, before guard cleanup and without its ACK.
  const refused = await collection.findOne({ _id: ctx.operationKey });
  assert.equal(refused.state, 'FAILED');
  msg = { _subscriptionBooking: { ...ctxFor(), step: 'operation_find' }, payload: [refused] };
  execute(msg); assert.equal(msg._subscriptionBooking.step, 'tournament_admission_guard_read');
  msg.payload = await collection.find(msg.payload).toArray(); execute(msg);
  const [releaseFilter, releaseUpdate, releaseOptions] = msg.payload;
  assert.equal((await collection.updateOne(releaseFilter, releaseUpdate, releaseOptions)).modifiedCount, 1);
  const released = await collection.findOne({ _id: guardKey });
  assert.deepEqual(released.admissionRelease, { operationKey: ctx.operationKey, operationId: ctx.operationId });
  // Another operation can acquire the released day. It cannot acquire an unconfirmed/foreign reserve.
  const next = { ...ctxFor('operation-2'), step: 'lk1_daily_visit_read' };
  msg = { _subscriptionBooking: next, payload: [released] }; execute(msg);
  const [takeFilter, takeUpdate, takeOptions] = msg.payload;
  assert.equal((await collection.updateOne(takeFilter, takeUpdate, takeOptions)).modifiedCount, 1);
  assert.equal((await collection.findOne({ _id: guardKey })).ownerOperationId, 'operation-2');
  // Stale cleanup cannot release the new owner's day after CAS takeover.
  assert.equal((await collection.updateOne(releaseFilter, releaseUpdate, releaseOptions)).matchedCount, 0);
  for (const marker of ['upstreamAttemptedAt', 'bookingId', 'managedEntitlementOperationId']) {
    const marked = { ...ctxFor('marker-' + marker), _id: 'marker-' + marker, state: 'PREPARED', [marker]: 'present' };
    await collection.insertOne(marked);
    assert.equal((await collection.updateOne({ ...filter, _id: marked._id, operationId: marked.operationId }, update, options)).matchedCount, 0);
  }
  const grantFor = ctx => ({ schemaVersion: 1, state: 'ADMITTED', operationId: 'cup-' + ctx.operationId,
    requestOperationId: ctx.operationId, actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId });
  const prepare = async name => {
    const ctx = { ...ctxFor(name), lk1: undefined, step: 'operation_insert' };
    await collection.insertOne({ _id: ctx.operationKey, ...ctx, state: 'PREPARED' });
    let msg = { _subscriptionBooking: ctx, payload: { acknowledged: true, insertedId: ctx.operationKey } };
    execute(msg); const grant = grantFor(ctx);
    msg = { ...msg, statusCode: 200, responseUrl: msg.url, payload: grant };
    execute(msg); assert.equal(ctx.step, 'operation_preaccept');
    const [filter, update, options] = msg.payload;
    assert.equal((await collection.updateOne(filter, update, options)).modifiedCount, 1);
    return { ctx, grant };
  };
  const failure = ctx => {
    const msg = { _subscriptionBooking: { ...ctx, step: 'exercise_recheck' }, statusCode: 200, payload: { id: 'exercise' } };
    execute(msg); assert.equal(msg._subscriptionBooking.step, 'tournament_abort_saved'); return msg;
  };
  const prepared = await prepare('post-admission');
  let failed = failure(prepared.ctx);
  assert.equal((await collection.updateOne(...failed.payload)).modifiedCount, 1);
  const refusal = await collection.findOne({ _id: prepared.ctx.operationKey });
  assert.ok(refusal.upstreamAttemptedAt, 'preaccept marker is NOT dispatch evidence');
  assert.equal(refusal.tournamentProviderPhase, 'PRE_DISPATCH');
  const restart = () => {
    const msg = { _subscriptionBooking: { ...ctxFor('post-admission'), lk1: undefined, step: 'operation_find' }, payload: [refusal] };
    execute(msg); assert.match(msg.url, /subscription-admission\/abort$/); return msg;
  };
  msg = restart();
  assert.equal(msg.payload.ownerOperationId, prepared.grant.operationId);
  assert.equal(msg.payload.proof, 'PRE_DISPATCH_REJECTED_V1');
  // Owner commits but its HTTP ACK is lost. A new process recovers only the original abort.
  msg.error = Error('lost CUP ACK'); execute(msg); assert.equal(msg.statusCode, 202);
  msg = restart(); const abortAck = { ...prepared.grant, ownerOperationId: prepared.grant.operationId, state: 'ABORTED' };
  msg = { ...msg, statusCode: 200, responseUrl: msg.url, payload: abortAck };
  execute(msg); assert.equal(msg._subscriptionBooking.step, 'tournament_abort_ack_saved');
  assert.equal((await collection.updateOne(...msg.payload)).modifiedCount, 1);
  msg.payload = null; msg.error = Error('lost Mongo ACK'); execute(msg);
  assert.equal(msg._subscriptionBooking.step, 'tournament_abort_read');
  msg.payload = await collection.find(msg.payload).toArray(); delete msg.error; execute(msg);
  assert.equal(msg._subscriptionBooking.step, 'tournament_admission_guard_read');
  // Existing guard was taken over by operation-2; stale cleanup must leave it alone.
  msg.payload = await collection.find(msg.payload).toArray(); execute(msg);
  assert.equal(msg._subscriptionBooking.step, 'tournament_abort_cleanup_saved');
  // A new request after the CUP ACK but before guard cleanup must resume old cleanup.
  const beforeCleanup = await collection.findOne({ _id: prepared.ctx.operationKey });
  const nextRequest = { _subscriptionBooking: { ...ctxFor('new-request'), operationKey: prepared.ctx.operationKey, serviceDate: '2026-11-19', lk1: undefined, step: 'operation_find' }, payload: [beforeCleanup] };
  execute(nextRequest); assert.equal(nextRequest._subscriptionBooking.step, 'tournament_admission_guard_read');
  assert.equal(nextRequest._subscriptionBooking.operationId, 'post-admission');
  assert.equal(nextRequest._subscriptionBooking.serviceDate, '2026-11-18');
  await collection.updateOne(...msg.payload); msg.payload = { acknowledged: true, matchedCount: 1 }; execute(msg);
  msg.payload = await collection.find(msg.payload).toArray(); execute(msg);
  msg.payload = await collection.find(msg.payload).toArray(); execute(msg); assert.equal(msg.statusCode, 409);
  assert.equal((await collection.findOne({ _id: guardKey })).ownerOperationId, 'operation-2');
  for (const limitMode of ['shared_day', 'category_day']) {
    for (const acknowledged of [false, true]) {
      const key = `shared-abort-${limitMode}-${acknowledged}`;
      const row = { ...refusal, _id: key, operationKey: key, limitMode,
        tournamentAbort: { proof: 'PRE_DISPATCH_REJECTED_V1', acknowledged } };
      await collection.insertOne(row);
      const nextCtx = () => ({ ...ctxFor('other-event-request'), operationKey: key,
        exerciseId: 'other-exercise', limitMode, lk1: undefined, step: 'operation_find' });
      const blocked = { _subscriptionBooking: nextCtx(), payload: [await collection.findOne({ _id: key })] };
      execute(blocked); assert.equal(blocked.statusCode, 202);
      assert.notEqual(blocked._subscriptionBooking.step, 'operation_reclaim');
      assert.deepEqual(await collection.findOne({ _id: key }), row);

      // Even a stale read without the abort marker cannot overwrite the durable
      // proof. Exercise the actual reclaim CAS against the newer Mongo row.
      const stale = { ...row }; delete stale.tournamentAbort;
      const reclaim = { _subscriptionBooking: nextCtx(), payload: [stale] };
      execute(reclaim); assert.equal(reclaim._subscriptionBooking.step, 'operation_reclaim');
      assert.equal((await collection.updateOne(...reclaim.payload)).matchedCount, 0);
      assert.deepEqual(await collection.findOne({ _id: key }), row);

      // Once both old compensation and guard cleanup are acknowledged, the
      // ordinary cross-event reclaim works again with its original CAS binding.
      await collection.updateOne({ _id: key }, { $set: {
        'tournamentAbort.acknowledged': true, 'tournamentAbort.cleanupComplete': true } });
      const complete = { _subscriptionBooking: nextCtx(), payload: [await collection.findOne({ _id: key })] };
      execute(complete); assert.equal(complete._subscriptionBooking.step, 'operation_reclaim');
      assert.equal((await collection.updateOne(...complete.payload)).modifiedCount, 1);
      assert.equal((await collection.findOne({ _id: key })).exerciseId, 'other-exercise');
    }
  }
  for (const order of ['abort-first', 'dispatch-first', 'concurrent']) {
    const { ctx } = await prepare(order);
    const refusalMsg = failure(ctx);
    const dispatchMsg = { _subscriptionBooking: { ...ctx, step: 'fixture_dispatch' } };
    execute(dispatchMsg); assert.equal(dispatchMsg._subscriptionBooking.step, 'tournament_dispatch_saved');
    let results;
    if (order === 'concurrent') results = await Promise.all([collection.updateOne(...refusalMsg.payload), collection.updateOne(...dispatchMsg.payload)]);
    else if (order === 'abort-first') results = [await collection.updateOne(...refusalMsg.payload), await collection.updateOne(...dispatchMsg.payload)];
    else { const dispatched = await collection.updateOne(...dispatchMsg.payload); results = [await collection.updateOne(...refusalMsg.payload), dispatched]; }
    assert.equal(results[0].modifiedCount + results[1].modifiedCount, 1);
    const stored = await collection.findOne({ _id: ctx.operationKey });
    if (results[1].modifiedCount) {
      assert.equal(stored.tournamentProviderPhase, 'DISPATCHING'); assert.equal(stored.tournamentAbort, undefined);
      dispatchMsg.payload = null; dispatchMsg.error = Error('lost dispatch ACK'); execute(dispatchMsg);
      assert.equal(dispatchMsg.statusCode, 202); assert.notEqual(dispatchMsg._subscriptionBooking.step, 'booking_create');
      // A replay must not infer permission to abort from timeout, nor resend a POST.
      const replay = { _subscriptionBooking: { ...ctx, step: 'operation_find' }, payload: [stored] };
      execute(replay); assert.notEqual(replay._subscriptionBooking.step, 'tournament_abort');
      assert.notEqual(replay._subscriptionBooking.step, 'booking_create');
    } else assert.equal(stored.state, 'FAILED');
  }
  console.log('PASS physical Mongo Node-RED admission/preaccept/recheck abort, lost ACK/restart, dispatch/abort CAS races, own-day takeover, cross-event reclaim fencing and stale cleanup');
} finally { await client.db(database).dropDatabase(); await client.close(); }
