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
const source = patchTournamentAdmissionSource(composed);
const run = new Function('msg', 'env', 'global', 'node', source);
const ctxFor = (operationId = 'operation-1') => ({ category: 'tournament', action: 'book', actorClientId: 'actor', exerciseId: 'exercise',
  operationId, operationKey: operationId, tenantKey: 'fixture', clientSubscriptionId: 'subscription', serviceDate: '2026-11-18',
  authHeader: 'Bearer synthetic', lk1: { dailyVisitPolicyVersion: 1, decision: { subscriptionVisitCount: 1 } } });
const env = { get: key => key === 'TOURNAMENT_OWNER_API_BASE' ? 'https://cup.example/api' : undefined };
const execute = msg => run(msg, env, { get: () => undefined }, { warn() {}, error() {} });
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
  console.log('PASS physical Mongo Node-RED refusal, process restart, own-day release, takeover, stale cleanup and dispatch-marker fences');
} finally { await client.db(database).dropDatabase(); await client.close(); }
