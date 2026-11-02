import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { monthlyFriendshipCustody as c } from '../lib/monthlyFriendshipCustody.mjs';
const ci = process.env.GITHUB_ACTIONS === 'true', uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if (ci && uri !== 'mongodb://127.0.0.1:27017') throw Error('Monthly purchase requires existing CI loopback Mongo fixture');
if (!ci && uri) throw Error('Monthly purchase Mongo tests refuse local/shared targets');
const options = { skip: !ci ? 'CI-only existing Mongo; no local provisioning' : false };
const at = '2026-11-02T12:00:00.000Z', scope = { tenant_id: 'fixture-tenant', counterKey: 'friendship', inventoryId: 'fixture-monthly' };
const phone = '+7' + '9990000000';
const request = (n = 0) => ({ ...scope, paymentRef: 'fixture-payment-' + n, clientId: 'fixture-client-' + n, clientPhone: phone,
  productId: 'fixture-product', productName: 'Fixture monthly', campaignKey: 'fixture-campaign', amountMinor: 980000,
  providerProductCostMinor: 980000, discountMinor: 0, releasePhase: null, dailyDropDate: null, counterEpoch: null,
  providerPayload: { clientPhone: phone, paymentMethod: 'CARD', deposit: 0, offlineTillId: null,
    products: [{ id: 'fixture-product', count: 1, type: 'SUBSCRIPTION', customAmount: null, discount: 0 }],
    successUrl: 'https://example.test/return', failUrl: 'https://example.test/return' } });
const capacity = l => ({ ledgerRevision: l.revision, inventoryId: l.inventoryId, counterKey: 'friendship', remaining: 1 });
async function fixture(t) {
  const { MongoClient } = await import('mongodb');
  const clients = Array.from({ length: 4 }, () => new MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 5000 }));
  const name = 'r1_monthly_purchase_' + crypto.randomUUID().replaceAll('-', ''); assert.match(name, /^r1_monthly_purchase_[a-f0-9]{32}$/);
  t.after(async () => { try { await clients[0].db(name).dropDatabase(); } finally { await Promise.all(clients.map(c => c.close())); } });
  await Promise.all(clients.map(c => c.connect())); return clients.map(c => c.db(name).collection('lk_tournament_subscription_sales'));
}
test('real Mongo monthly: concurrent initialization produces one exact inventory owner', options, async t => {
  const db = await fixture(t), initial = c.initial(scope, at);
  const results = await Promise.allSettled(db.map(d => d.updateOne({ _id: initial._id }, { $setOnInsert: structuredClone(initial) }, { upsert: true })));
  for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 11000);
  assert.equal(results.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.upsertedCount : 0), 0), 1);
  assert.equal(await db[0].countDocuments({}), 1); assert.equal(c.validate(await db[0].findOne({ _id: initial._id })), true);
});
test('real Mongo monthly: independent last-slot clients have one reservation CAS winner', options, async t => {
  const db = await fixture(t), initial = c.initial(scope, at); await db[0].insertOne(structuredClone(initial));
  const mutations = db.map((_, i) => c.reserve(initial, request(i), capacity(initial), at));
  const results = await Promise.all(db.map((d, i) => d.updateOne(mutations[i].query, mutations[i].update)));
  assert.equal(results.reduce((n, r) => n + r.modifiedCount, 0), 1);
  const saved = await db[0].findOne({ _id: initial._id }); assert.equal(saved.operations.length, 1);
  assert.equal(c.validate(saved), true); assert.equal(saved.revision, 1);
});
test('real Mongo monthly: concurrent dispatch, lost ACK and restarted readers authorize at most one POST', options, async t => {
  const db = await fixture(t), initial = c.initial(scope, at), reserved = c.reserve(initial, request(), capacity(initial), at).next;
  await db[0].insertOne(structuredClone(reserved)); const mutations = db.map(() => c.dispatch(reserved, request(), at));
  const results = await Promise.all(db.map((d, i) => d.updateOne(mutations[i].query, mutations[i].update)));
  assert.equal(results.reduce((n, r, i) => n + Number(c.acknowledgedDispatch(mutations[i], r)), 0), 1);
  const saved = await db[0].findOne({ _id: initial._id });
  assert.equal(c.acknowledgedDispatch(mutations[0], undefined), false);
  for (const d of db) {
    const replay = c.dispatch(await d.findOne({ _id: initial._id }), request(), '2027-01-01T00:00:00.000Z');
    assert.equal(replay.existing.state, 'DISPATCHING'); assert.equal(replay.next, undefined);
  }
  assert.throws(() => c.reserve(saved, { ...request(), paymentRef: 'new-key' }, capacity(saved), '2027-01-01T00:00:00.000Z'), /CLIENT_PURCHASE_PENDING/);
});
test('real Mongo monthly: full preimage rejects same-revision corruption and foreign tenant mutation', options, async t => {
  const db = await fixture(t), initial = c.initial(scope, at); await db[0].insertOne(structuredClone(initial));
  const mutation = c.reserve(initial, request(), capacity(initial), at);
  await db[1].updateOne({ _id: initial._id }, { $set: { updatedAt: '2026-11-02T12:00:01.000Z' } });
  assert.equal((await db[2].updateOne(mutation.query, mutation.update)).modifiedCount, 0);
  const foreign = { ...mutation.query, tenant_id: 'foreign-tenant' };
  assert.equal((await db[3].updateOne(foreign, mutation.update)).modifiedCount, 0);
  assert.equal((await db[0].findOne({ _id: initial._id })).operations.length, 0);
});
