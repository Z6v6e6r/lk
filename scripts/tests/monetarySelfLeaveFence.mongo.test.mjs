import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  serviceSnapshot,
  copy,
  run,
  context,
  birth,
  casMessage,
  acknowledge,
  dispatchIntent,
  recover,
  proof,
  respond,
  booking,
} from './helpers/monetarySelfLeaveFenceHarness.mjs';
const ci = process.env.GITHUB_ACTIONS === 'true';
const uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
if (ci && uri !== 'mongodb://127.0.0.1:27017')
  throw Error('Requires exact existing CI Mongo fixture');
if (!ci && uri) throw Error('Refusing local/shared Mongo target');
const options = { skip: ci ? false : 'CI-only existing disposable Mongo; no local provisioning' };
async function fixture(t) {
  const { MongoClient } = await import('mongodb');
  const clients = Array.from(
    { length: 4 },
    () => new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }),
  );
  const name = 'r1_money_leave_' + crypto.randomUUID().replaceAll('-', '');
  assert.match(name, /^r1_money_leave_[a-f0-9]{32}$/);
  let connected = false;
  t.after(async () => {
    try {
      if (connected) await clients[0].db(name).dropDatabase();
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
  await Promise.all(clients.map((c) => c.connect()));
  connected = true;
  return clients.map((c) => c.db(name).collection('lk_game_leave_operations'));
}
async function seed(db) {
  const now = Date.now(),
    h = birth(context(), now);
  await db.insertOne(copy(h.row));
  h.intent = dispatchIntent(h.msg, 'booking-a', 'CURRENCY', now)[7];
  return h;
}
async function write(db, msg) {
  msg = casMessage(msg);
  const ack = await db.updateOne(...msg.payload);
  return { msg, ack, out: acknowledge(msg, ack) };
}
async function reclaim(db, row) {
  // Age only the owned fixture's lease, never a production/readback fact.
  await db.updateOne(
    { _id: row._id },
    { $set: { claimLeaseUntil: new Date(Date.now() - 1000).toISOString() } },
  );
  row = await db.findOne({ _id: row._id });
  const result = await write(db, recover(row, Date.now(), crypto.randomUUID())[3]);
  assert.equal(result.ack.modifiedCount, 1);
  return result.out[0];
}
test(
  'Mongo: each original booking has one dispatch winner across independent connections',
  options,
  async (t) => {
    const db = await fixture(t),
      h = await seed(db[0]);
    const intents = [casMessage(copy(h.intent)), casMessage(copy(h.intent))];
    let replies = await Promise.all(intents.map((m, i) => db[i].updateOne(...m.payload)));
    assert.equal(
      replies.reduce((n, a) => n + a.modifiedCount, 0),
      1,
    );
    let providerCalls = 0;
    for (let i = 0; i < 2; i++) {
      const next = acknowledge(intents[i], replies[i])[0];
      if (next) {
        assert.equal(run('router', next)[0].method, 'DELETE');
        providerCalls++;
      }
    }
    assert.equal(providerCalls, 1);
    let row = await db[2].findOne({ _id: h.row._id });
    let msg = await reclaim(db[2], row);
    let request = proof(msg, ['booking-b'], ['booking-a'])[7];
    msg = (await write(db[2], request)).out[0];
    let probe = run('router', msg)[0];
    request = respond(probe, { cancellationOptions: { money: { available: true } } })[7];
    const second = [casMessage(copy(request)), casMessage(copy(request))];
    replies = await Promise.all(second.map((m, i) => db[i + 2].updateOne(...m.payload)));
    assert.equal(
      replies.reduce((n, a) => n + a.modifiedCount, 0),
      1,
    );
    row = await db[3].findOne({ _id: h.row._id });
    assert.deepEqual(
      row.monetarySelfLeave.markers.map((m) => m.bookingId),
      ['booking-a', 'booking-b'],
    );
    assert.equal(row.moneyRefundState, 'UNVERIFIED');
  },
);
test(
  'Mongo: lost dispatch CAS ACK and provider timeout never repeat marked A; active A blocks B',
  options,
  async (t) => {
    const db = await fixture(t),
      h = await seed(db[0]),
      cmd = casMessage(h.intent);
    assert.equal((await db[0].updateOne(...cmd.payload)).modifiedCount, 1); // ACK lost: no provider invocation
    const row = await db[1].findOne({ _id: h.row._id });
    const msg = await reclaim(db[1], row);
    let get = run('router', msg)[0];
    assert.equal(get.method, 'GET');
    get = respond(get, { content: [booking('booking-a'), booking('booking-b')], last: true })[0];
    const out = respond(get, { content: [booking('booking-a', true)], last: true });
    assert.equal(out[0], null);
    assert.equal(out[1].statusCode, 202);
    const after = await db[2].findOne({ _id: row._id });
    assert.equal(after.monetarySelfLeave.markers.length, 1);
    assert.equal(after.monetarySelfLeave.readbacks.length, 0);
  },
);
test(
  'Mongo: expired pre-dispatch claim is reclaimable; stale executor cannot dispatch',
  options,
  async (t) => {
    const db = await fixture(t),
      h = await seed(db[0]),
      old = casMessage(copy(h.intent));
    await db[0].updateOne(
      { _id: h.row._id },
      { $set: { claimLeaseUntil: new Date(Date.now() - 1000).toISOString() } },
    );
    const row = await db[1].findOne({ _id: h.row._id });
    const retry = recover(row, Date.now(), 'new-claim')[3];
    const result = await write(db[1], retry);
    assert.equal(result.ack.modifiedCount, 1);
    assert.equal((await db[2].updateOne(...old.payload)).matchedCount, 0);
    assert.equal((await db[3].findOne({ _id: row._id })).monetarySelfLeave.markers.length, 0);
  },
);
test(
  'Mongo: cancellation readback and local-confirm ACK loss preserve immutable original evidence',
  options,
  async (t) => {
    const db = await fixture(t),
      h = await seed(db[0]);
    const sent = await write(db[0], h.intent);
    assert.equal(sent.ack.modifiedCount, 1);
    let msg = await reclaim(db[1], await db[1].findOne({ _id: h.row._id }));
    const proven = proof(msg, [], ['booking-a', 'booking-b'])[7];
    const read = await write(db[1], proven);
    assert.equal(read.ack.modifiedCount, 1);
    // Lose readback ACK; fresh lease recovery does not erase prior proof or invent B dispatch.
    msg = await reclaim(db[2], await db[2].findOne({ _id: h.row._id }));
    msg = (await write(db[2], proof(msg, [], ['booking-a', 'booking-b'])[7])).out[0];
    assert.ok(msg);
    const local = run('router', msg)[3],
      save = run('operation_viva_confirmed', local)[0];
    assert.equal((await db[2].updateOne(...save.payload)).modifiedCount, 1); // local phase ACK lost
    const row = await db[3].findOne({ _id: h.row._id });
    assert.equal(row.state, 'VIVA_CONFIRMED');
    assert.equal(row.monetarySelfLeave.markers.length, 1);
    assert.equal(row.monetarySelfLeave.readbacks.length, 2);
    assert.equal(row.moneyRefundState, 'UNVERIFIED');
    assert.equal((await db[0].updateOne(...save.payload)).matchedCount, 0);
  },
);
test(
  'Mongo: exact preimage refuses foreign binding, changed marker array, generation and old journal',
  options,
  async (t) => {
    const db = await fixture(t),
      h = await seed(db[0]);
    const cmd = casMessage(h.intent);
    for (const field of [
      'actorClientId',
      'exerciseId',
      'membershipVersion',
      'requestedRefundMethod',
    ]) {
      const bad = copy(cmd.payload);
      bad[0][field] = 'foreign';
      assert.equal((await db[1].updateOne(...bad)).matchedCount, 0);
    }
    const changed = copy(cmd.payload);
    changed[0].monetarySelfLeave.markers.push({ bookingId: 'booking-b' });
    assert.equal((await db[1].updateOne(...changed)).matchedCount, 0);
    await db[0].updateOne({ _id: h.row._id }, { $unset: { monetarySelfLeave: '' } });
    assert.equal((await db[2].updateOne(...cmd.payload)).matchedCount, 0);
  },
);

test(
  'Mongo: mixed SERVICE/money in both orders persists baseline before dispatch and survives lost ACK/reload',
  options,
  async (t) => {
    for (const moneyFirst of [true, false]) {
      const db = await fixture(t),
        h = birth(context(['booking-a', 'booking-b'], null), Date.now());
      await db[0].insertOne(copy(h.row));
      const first = moneyFirst
        ? dispatchIntent(h.msg, 'booking-a', 'CURRENCY')[7]
        : serviceSnapshot(h.msg, 'booking-a', Date.now())[7];
      const sent = await write(db[0], first);
      assert.equal(sent.ack.modifiedCount, 1);
      assert.equal(run('router', sent.out[0])[0].method, 'DELETE'); // fake provider only, ACK discarded
      let row = await db[1].findOne({ _id: h.row._id });
      if (!moneyFirst) assert.equal(row.subscriptionReturnChecks[0].visitsLeftBefore, 8);
      let msg = await reclaim(db[1], row);
      msg = (await write(db[1], proof(msg, ['booking-b'], ['booking-a'])[7])).out[0];
      const probe = run('router', msg)[0];
      const second = moneyFirst
        ? serviceSnapshot(probe, 'booking-b', Date.now())[7]
        : respond(probe, { cancellationOptions: { money: { available: true } } })[7];
      const next = await write(db[2], second);
      assert.equal(next.ack.modifiedCount, 1);
      assert.equal(run('router', next.out[0])[0].method, 'DELETE');
      row = await db[3].findOne({ _id: h.row._id });
      const serviceId = moneyFirst ? 'booking-b' : 'booking-a';
      assert.deepEqual(row.subscriptionReturnChecks, [
        {
          bookingId: serviceId,
          clientSubscriptionId: 'subscription-synthetic',
          visitsLeftBefore: 8,
          expectedReturnCount: 1,
        },
      ]);
      assert.equal(row.subscriptionReturnState, 'RETURN_PENDING');
      assert.deepEqual(
        row.monetarySelfLeave.markers.find((m) => m.refundMethod === 'SERVICE')
          .subscriptionBaseline,
        row.subscriptionReturnChecks[0],
      );
      msg = await reclaim(db[3], row);
      msg = (await write(db[3], proof(msg, [], ['booking-a', 'booking-b'])[7])).out[0];
      const local = run('router', msg)[3];
      assert.equal(local._splitLeaveCtx.subscriptionReturnState, 'RETURN_PENDING');
      assert.equal(local._splitLeaveCtx.subscriptionReturnChecks[0].visitsLeftBefore, 8);
      const final = run('operation_viva_confirmed', local)[0];
      await db[0].updateOne(
        { _id: row._id },
        { $set: { 'subscriptionReturnChecks.0.visitsLeftBefore': 9 } },
      );
      assert.equal((await db[1].updateOne(...final.payload)).matchedCount, 0);
      const corrupt = await db[2].findOne({ _id: row._id });
      assert.equal(recover(corrupt, Date.now(), 'new-corrupt-retry')[3], undefined);
    }
  },
);
