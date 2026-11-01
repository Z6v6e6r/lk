import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { OwnerHarness } from './helpers/gameCreateOwnerHarness.mjs';
const ci = process.env.GITHUB_ACTIONS === 'true', uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if (ci && uri !== 'mongodb://127.0.0.1:27017') throw Error('CREATE owner requires existing CI loopback Mongo fixture');
if (!ci && uri) throw Error('CREATE owner Mongo tests refuse local/shared targets');
const options = { skip: !ci ? 'CI-only existing Mongo; no local provisioning' : false };
async function fixture(t) {
  const { MongoClient } = await import('mongodb');
  const clients = Array.from({ length: 4 }, () => new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000 }));
  const name = 'r1_quarter_create_' + crypto.randomUUID().replaceAll('-', '');
  assert.match(name, /^r1_quarter_create_[a-f0-9]{32}$/);
  t.after(async () => { try { await clients[0].db(name).dropDatabase(); } finally { await Promise.all(clients.map(c => c.close())); } });
  await Promise.all(clients.map(c => c.connect()));
  return clients.map(c => c.db(name).collection('lk_subscription_daily_booking_ops'));
}
function capture(step, h = new OwnerHarness(), options = {}) {
  let message; const stop = Symbol('capture');
  h.onBeforeMongo = msg => { if (msg._subscriptionBooking?.step === step || msg._gameCreateOwner?.step === step) {
    message = structuredClone(msg); throw stop;
  } };
  assert.throws(() => h.execute(options), e => e === stop);
  delete h.onBeforeMongo;
  return { h, message, rows: structuredClone([...h.rows.values()]) };
}
test('real Mongo: concurrent original admissions converge and foreign tenant cannot overwrite original namespace', options, async t => {
  const db = await fixture(t), { message, h } = capture('inserted');
  const [query, update, settings] = message.payload;
  const results = await Promise.allSettled(db.map(c => c.updateOne(structuredClone(query), structuredClone(update), settings)));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 11000);
  assert.equal(results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.upsertedCount : 0), 0), 1);
  const row = await db[0].findOne(query); assert.equal(await db[1].countDocuments({}), 1);
  message.payload = undefined; message.error = { code: 11000 };
  const reread = h.invokeOwner('router', message)[0];
  assert.deepEqual(reread.payload, { _id: row._id, tenant_id: row.tenant_id });
  assert.equal(typeof row.createdAt, 'string'); assert.equal(row.state, undefined); assert.equal(row.actorClientId, undefined);
  assert.equal(await db[2].countDocuments({ state: 'CONFIRMED' }), 0);
  const foreign = structuredClone(message); foreign._gameCreateOwner.claims.tenant_id = '22222222-2222-4222-8222-222222222222';
  foreign._gameCreateOwner.step = 'found'; foreign.payload = [row];
  const refused = h.invokeOwner('router', foreign)[5];
  assert.equal(refused.statusCode, 409); assert.equal(await db[3].countDocuments({}), 1);
});
test('real Mongo: rejected outer receipt survives two new-operation reclaim CAS contenders and lost ACK', options, async t => {
  const db = await fixture(t), original = new OwnerHarness();
  original.onHttp = msg => { if (msg.method === 'POST' && msg.url.endsWith('/api/v1/exercises')) { msg.statusCode = 422; msg.payload = {}; } };
  const receipt = original.execute().payload.operation.receipt;
  assert.equal(receipt.outcome, 'REJECTED');
  const first = new OwnerHarness({ key: 'physical-new-original-one', revision: 2 }); first.rows = original.rows;
  const a = capture('operation_reclaim', first);
  const second = new OwnerHarness({ key: 'physical-new-original-two', revision: 3 }); second.rows = original.rows;
  const b = capture('operation_reclaim', second);
  await db[0].insertMany(structuredClone([...original.rows.values()]));
  const results = await Promise.all([db[1].updateOne(...a.message.payload), db[2].updateOne(...b.message.payload)]);
  assert.equal(results.reduce((n, r) => n + r.modifiedCount, 0), 1);
  const winner = results[0].modifiedCount ? a : b;
  winner.message.error = { code: 'LOST_RECLAIM_ACK' }; winner.message.payload = undefined;
  const read = winner.h.invokeOwner('gateway', winner.message)[1];
  const row = await db[3].findOne(read.payload);
  assert.equal(row.operationId, winner.h.claims.operation_id); assert.equal(row.state, 'PREPARED');
  const old = await db[3].findOne({ kind: 'GAME_CREATE_ADMISSION', phase: 'CREATE_REJECTED' });
  assert.deepEqual(old.rejectionReceipt, receipt);
  assert.equal(await db[3].countDocuments({ kind: 'GAME_CREATE_ADMISSION' }), 3);
  assert.equal(row.managedCreateReleaseProof, undefined); assert.equal(row.providerCreateReceipt, undefined);
});
test('real Mongo: independent contenders only one RESERVED→ATTEMPTING nonce; lost ACK reads exact winner without new authority', options, async t => {
  const db = await fixture(t), { h, message, rows } = capture('operation_precreated_attempt');
  await db[0].insertMany(structuredClone(rows));
  const commands = db.map((_, n) => {
    const msg = structuredClone(message); const nonce = crypto.randomUUID();
    msg._subscriptionBooking.quarterAttemptId = nonce;
    msg.payload[1].$set.providerCreateAttemptId = nonce;
    return { msg, nonce, index: n };
  });
  const result = await Promise.all(commands.map((c, n) => db[n].updateOne(...c.msg.payload)));
  assert.equal(result.reduce((n, r) => n + r.modifiedCount, 0), 1);
  const winner = result.findIndex(r => r.modifiedCount === 1), saved = await db[3].findOne({ _id: message.payload[0]._id });
  assert.equal(saved.providerCreateAttemptId, commands[winner].nonce);
  for (const [n, command] of commands.entries()) {
    command.msg.error = { code: 'LOST_ACK' }; command.msg.payload = undefined;
    const read = h.invokeOwner('gateway', command.msg)[1];
    assert.equal(read.payload.providerCreateAttemptId, command.nonce);
    read.payload = await db[n].find(read.payload).toArray(); delete read.error;
    const returned = h.invokeOwner('gateway', read);
    assert.equal(returned[0], null); // Mongo read cannot itself issue a provider request.
    if (n === winner) assert.equal(returned[4].payload.state, 'PREFLIGHT_ATTEMPT_BOUND');
    else assert.notEqual(returned[4].payload.state, 'PREFLIGHT_ATTEMPT_BOUND');
  }
});
test('real Mongo: original CREATE-ID CAS and one organizer fence survive ACK loss, stale nonce/context cannot replace ID', options, async t => {
  const db = await fixture(t), { h, message, rows } = capture('quarter_create_response_ack');
  await db[0].insertMany(structuredClone(rows));
  const result = await db[0].updateOne(...message.payload); assert.equal(result.modifiedCount, 1);
  const corrupt = structuredClone(message.payload); corrupt[0].providerCreateAttemptId = crypto.randomUUID(); corrupt[1].$set.exerciseId = 'exercise:foreign';
  assert.equal((await db[1].updateOne(...corrupt)).matchedCount, 0);
  message.error = { code: 'LOST_ACK' }; message.payload = undefined;
  const read = h.invokeOwner('gateway', message)[1]; read.payload = await db[2].find(read.payload).toArray(); delete read.error;
  let next = h.invokeOwner('gateway', read);
  for (let i = 0; i < 3; i++) { assert.ok(next[0]); h.provider(next[0], 'synthetic-actor-read'); next = h.invokeOwner('gateway', next[0]); }
  const promotion = next[3]; assert.ok(promotion);
  const promotions = await Promise.all(db.map(c => c.updateOne(...structuredClone(promotion.payload))));
  assert.equal(promotions.reduce((n, r) => n + r.modifiedCount, 0), 1);
  const current = await db[3].findOne({ _id: promotion.payload[0]._id });
  assert.equal(current.state, 'PENDING_CONFIRMATION'); assert.equal(current.exerciseId, 'exercise:original');
  assert.equal(current.providerCreateReceipt.exerciseId, 'exercise:original');
  assert.equal((await db[0].updateOne(...structuredClone(promotion.payload))).modifiedCount, 0);
});

for (const winner of ['abort', 'attempt']) test('real Mongo: unused expiry versus dispatch CAS, '+winner+' wins irreversibly', options, async t => {
  const db = await fixture(t), original = new OwnerHarness({ now: Date.now() - 120000 });
  const attempt = capture('operation_precreated_attempt', original);
  original.now = Date.now();
  const abort = capture('quarter_unused_abort_ack', original, { recoveryOnly: true });
  await db[0].insertMany(structuredClone(attempt.rows));
  const first = winner === 'abort' ? abort : attempt, second = winner === 'abort' ? attempt : abort;
  assert.equal((await db[1].updateOne(...first.message.payload)).modifiedCount, 1);
  assert.equal((await db[2].updateOne(...second.message.payload)).modifiedCount, 0);
  let saved = await db[3].findOne({ _id: attempt.message.payload[0]._id });
  if (winner === 'attempt') {
    assert.equal(saved.state, 'PRECREATE_ATTEMPTING'); assert.equal(saved.quarterPrecreateAbort, undefined);
    original.rows.set(saved._id, saved); original.execute({ recoveryOnly: true });
    assert.equal(original.releaseCalls, 0); assert.equal(original.providerCreates, 0); assert.equal(original.bookingCreates, 0); return;
  }
  assert.equal(saved.state, 'PRECREATE_ABORTING'); assert.equal(typeof saved.quarterPrecreateAbort.abortedAt, 'string');
  assert.ok(Date.parse(saved.quarterPrecreateAbort.abortedAt) >= Date.parse(original.preparation.expiresAt));
  original.now = Date.now() + 120000; // marker survives original proof TTL; a fresh read is required.
  abort.message.error = { code: 'LOST_ABORT_ACK' }; abort.message.payload = undefined;
  const read = original.invokeOwner('gateway', abort.message)[1]; read.payload = await db[2].find(read.payload).toArray(); delete read.error;
  const release = original.invokeOwner('gateway', read)[0];
  assert.equal(release.payload.reason, 'PRECREATE_EXPIRED_NOT_DISPATCHED');
  assert.match(release.headers['X-Subscription-Owner-Evidence'], /^release-v1\./);
  original.rows.set(saved._id, saved);
  const finish = capture('quarter_unused_release_ack', original, { recoveryOnly: true });
  assert.equal((await db[1].updateOne(...finish.message.payload)).modifiedCount, 1);
  saved = await db[3].findOne({ _id: saved._id }); original.rows.set(saved._id, saved);
  const outer = capture('completed_ack', original, { recoveryOnly: true });
  assert.equal((await db[2].updateOne(...outer.message.payload)).modifiedCount, 1);
  const durableOuter = await db[3].findOne({ _id: outer.message.payload[0]._id });
  assert.match(durableOuter.rejectionReceiptSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(durableOuter.rejectionReceiptSha256, outer.message.payload[1].$set.rejectionReceiptSha256);
  original.rows.set(durableOuter._id, durableOuter);
  const receipt = original.execute({ mode: 'read' }).payload.operation.receipt;
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.abortId, saved.quarterPrecreateAbort.abortId);
  assert.equal(original.providerCreates, 0); assert.equal(original.bookingCreates, 0);
  assert.deepEqual(original.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
  const later = new OwnerHarness({ key: 'synthetic-new-after-unused-abort', revision: 2, now: original.now });
  for (const row of await db[0].find({}).toArray()) later.rows.set(row._id, row);
  const reclaim = capture('operation_reclaim', later);
  assert.equal((await db[1].updateOne(...reclaim.message.payload)).modifiedCount, 1);
  const reclaimed = await db[2].findOne({ _id: saved._id });
  assert.equal(reclaimed.quarterPrecreateAbort, undefined);
  original.rows.set(reclaimed._id,reclaimed);
  assert.deepEqual(original.execute({ recoveryOnly: true }).payload.operation.receipt, receipt);
  assert.equal(original.providerCreates,0);assert.equal(original.bookingCreates,0);
});
test('real Mongo: expiry uses database clock and abort CAS rejects foreign decision or provider evidence', options, async t => {
  const db = await fixture(t), h = new OwnerHarness({ now: Date.now() - 120000 });
  const held = capture('operation_precreated_attempt', h); h.now = Date.now();
  const abort = capture('quarter_unused_abort_ack', h, { recoveryOnly: true });
  const row = held.rows.find(x => x.managedCreateBinding);
  await db[0].insertOne(structuredClone(row));
  const future = structuredClone(abort.message.payload);
  future[0].$expr.$lte[0].$dateFromString.dateString.$literal = new Date(Date.now()+60000).toISOString();
  assert.equal((await db[1].updateOne(...future)).modifiedCount, 0);
  await db[0].updateOne({ _id: row._id }, { $set: { providerCreateAttemptId: null } });
  assert.equal((await db[2].updateOne(...abort.message.payload)).modifiedCount, 0);
  await db[0].updateOne({ _id: row._id }, { $unset: { providerCreateAttemptId: '' }, $set: { 'managedDecision.usageUnits': 2 } });
  assert.equal((await db[3].updateOne(...abort.message.payload)).modifiedCount, 0);
});
