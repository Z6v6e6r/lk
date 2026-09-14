import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
const uri = process.env.PAYMENT_POLLING_TEST_MONGO_URI;
const now = Date.parse('2026-09-14T06:00:00.000Z');
function run(name, msg, time = now) {
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [time])); } static now() { return time; } }
  const code = fs.readFileSync(new URL(`../nodered_games_nodes/fn_tournament_subscription_${name}.js`, import.meta.url), 'utf8');
  return vm.runInNewContext(`(function(msg,global){${code}\n})(msg,global)`, { msg, Date: FixedDate, global: { get: () => undefined } });
}
const plain = value => JSON.parse(JSON.stringify(value));
const record = (id, extra = {}) => ({ _id: id, inventoryId: 'ab_leto_2026_50_v1', paymentRef: id,
  transactionId: `tx-${id}`, status: 'PAYMENT_PENDING', createdAt: new Date(now).toISOString(), ...extra });
const prepare = (row, time = now) => run('poll_admit', { _paymentPollingRecord: row,
  _summerSubscriptionCtx: { action: 'confirm', reconcile: true } }, time);

test('real Mongo: concurrent claims, restart, expiry/PAID race, history CAS and backlog fairness', { skip: !uri }, async () => {
  assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:\d+\/?$/, 'Only an isolated localhost Mongo is permitted');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  const db = client.db(`polling_test_${randomUUID().replaceAll('-', '')}`);
  await client.connect();
  try {
    const sales = db.collection('sales');
    const original = record('concurrent'); await sales.insertOne(original);
    const contenders = Array.from({ length: 30 }, () => prepare(structuredClone(original))[0]);
    const results = await Promise.all(contenders.map(m => sales.findOneAndUpdate(...plain(m.payload))));
    assert.equal(results.filter(Boolean).length, 1);
    const after = await sales.findOne({ _id: original._id }); assert.equal(after.paymentPolling.checks, 1);
    assert.equal(prepare(after), null); // process restart/lost acknowledgement cannot dispatch again
    const next = prepare(after, now + 120_000)[0];
    const second = await sales.findOneAndUpdate(...plain(next.payload)); assert.equal(second.paymentPolling.checks, 2);

    for (const paidFirst of [true, false]) {
      const old = record(`race-${paidFirst}`, { createdAt: new Date(now - 20 * 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
      await sales.insertOne(old); const request = prepare(old)[0];
      if (paidFirst) await sales.updateOne({ _id: old._id }, { $set: { status: 'PAID' } });
      const archive = await sales.findOneAndUpdate(...plain(request.payload));
      if (!paidFirst) await sales.updateOne({ _id: old._id }, { $set: { status: 'PAID' } });
      assert.equal(!!archive, !paidFirst);
      const final = await sales.findOne({ _id: old._id }); assert.equal(final.status, 'PAID'); assert.equal(final.expiresAt, old.expiresAt);
    }
    const fact = { state: 'UNPAID', productId: 'fixture-product' };
    const history = { _id: 'history', paidCount: 5, reservedCount: 1,
      history: { version: 1, entries: [{ transactionId: 'history-tx', fact, localPreimage: { original: true } }] } };
    await sales.insertOne(history);
    const job = { _id: history._id, documentType: 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1', transactionId: 'history-tx',
      pollingFact: fact, pollingRow: { status: 'UNPAID', transactionId: 'history-tx', createdAt: new Date(now - 20 * 60_000).toISOString() } };
    const historyRequest = prepare(job)[0];
    const historyResult = await sales.findOneAndUpdate(...plain(historyRequest.payload));
    assert.equal(historyResult.history.entries[0].paymentPolling.status, 'FAILED');
    assert.deepEqual(historyResult.history.entries[0].fact, fact); assert.equal(historyResult.reservedCount, 1);
    assert.equal(await sales.findOneAndUpdate(...plain(historyRequest.payload)), null);

    const backlog = db.collection('backlog');
    await backlog.insertMany(Array.from({ length: 679 }, (_, i) => record(`old-${String(i).padStart(4, '0')}`, { createdAt: new Date(now - 3_600_000).toISOString() })));
    const seen = new Set();
    for (let tick = 0; tick < 12; tick++) {
      const time = now + tick * 120_000, q = run('reconcile_query', {}, time);
      const batch = await backlog.find(...plain(q.payload)).toArray(); assert.ok(batch.length <= 60);
      for (const row of batch) {
        assert.equal(seen.has(row._id), false); seen.add(row._id);
        const request = prepare(row, time)[0]; assert.equal(request._paymentPollingClaim.dispatch, false);
        assert.ok(await backlog.findOneAndUpdate(...plain(request.payload)));
      }
    }
    assert.equal(seen.size, 679); assert.equal(await backlog.countDocuments({ status: 'PAYMENT_PENDING', 'paymentPolling.status': 'FAILED' }), 679);

    const repairs = db.collection('repairs');
    await repairs.insertMany([...Array.from({ length: 60 }, (_, i) => record(`a-repair-${i}`, { status: 'PAID_PENDING_INSTANCE_BINDING', counterKey: 'network_friendship', clientSubscriptionId: 'fixture-instance' })),
      ...Array.from({ length: 60 }, (_, i) => record(`z-new-${i}`))]);
    const firstBatch = await repairs.find(...plain(run('reconcile_query', {}).payload)).toArray();
    assert.equal(firstBatch.every(r => r._id.startsWith('a-')), true);
    for (const row of firstBatch) await repairs.findOneAndUpdate(...plain(prepare(row)[0].payload));
    const secondBatch = await repairs.find(...plain(run('reconcile_query', {}, now + 120_000).payload)).toArray();
    assert.equal(secondBatch.every(r => r._id.startsWith('z-')), true);
  } finally { await db.dropDatabase(); await client.close(); }
});
