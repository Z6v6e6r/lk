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
function capture(step, h = new OwnerHarness()) {
  let message; const stop = Symbol('capture');
  h.onBeforeMongo = msg => { if (msg._subscriptionBooking?.step === step || msg._gameCreateOwner?.step === step) {
    message = structuredClone(msg); throw stop;
  } };
  assert.throws(() => h.execute(), e => e === stop);
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
