import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  ownerDoc,
  terminal,
  readMessage,
  run,
  legacy,
  resumeFreshToClaim,
} from './helpers/managedSelfLeaveOwnerHarness.mjs';
const ci = process.env.GITHUB_ACTIONS === 'true';
const uri = process.env.COMMUNITY_MONTHLY_TEST_MONGO_URI;
// This suite never provisions a database service and cannot use an arbitrary URI.
// CI must execute against the existing monthly workflow's exact disposable service.
if (ci && uri !== 'mongodb://127.0.0.1:27017')
  throw Error('Managed SELF Mongo tests require the existing CI loopback fixture');
if (!ci && uri) throw Error('Managed SELF Mongo tests refuse local/shared Mongo targets');
const options = { skip: !ci ? 'CI-only disposable Mongo fixture; no local provisioning' : false };
async function fixture(t) {
  const { MongoClient } = await import('mongodb');
  const clients = Array.from(
    { length: 4 },
    () => new MongoClient(uri, { serverSelectionTimeoutMS: 5000 }),
  );
  const name = 'r1_managed_self_owner_' + crypto.randomUUID().replaceAll('-', '');
  assert.match(name, /^r1_managed_self_owner_[a-f0-9]{32}$/);
  t.after(async () => {
    try {
      await clients[0].db(name).dropDatabase();
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }
  });
  await Promise.all(clients.map((c) => c.connect()));
  return clients.map((c) => c.db(name));
}
const update = (collection, payload) => collection.updateOne(...payload);
test(
  'real Mongo owner: independent admission writers converge, changed key binding cannot overwrite, old selectors exclude kind',
  options,
  async (t) => {
    const db = await fixture(t);
    const doc = ownerDoc();
    const payload = [{ _id: doc._id }, { $setOnInsert: doc }, { upsert: true }];
    const results = await Promise.all(
      db.map((d) => update(d.collection('lk_subscription_daily_booking_ops'), payload)),
    );
    assert.equal(
      results.reduce((n, r) => n + r.upsertedCount, 0),
      1,
    );
    const rows = await db[1].collection('lk_subscription_daily_booking_ops').find({}).toArray();
    assert.equal(rows.length, 1);
    const changed = structuredClone(doc);
    changed.request.target.expectedRevision++;
    await update(db[2].collection('lk_subscription_daily_booking_ops'), [
      { _id: doc._id },
      { $setOnInsert: changed },
      { upsert: true },
    ]);
    assert.deepEqual(
      (await db[3].collection('lk_subscription_daily_booking_ops').findOne({ _id: doc._id }))
        .request,
      doc.request,
    );
    const queryMsg = legacy('daily_limit_find', {
      _splitLeaveCtx: {
        targetClientId: doc.providerClientId,
        exerciseId: doc.originalJoinReceipt.providerExerciseId,
        initialBookingIds: [doc.originalJoinReceipt.bookingId],
      },
    })[0];
    assert.equal(
      await db[0].collection('lk_subscription_daily_booking_ops').countDocuments(queryMsg.payload),
      0,
    );
    assert.equal(
      await db[0].collection('lk_subscription_daily_booking_ops').countDocuments({
        tenantKey: doc.tenantKey,
        actorClientId: doc.providerClientId,
        serviceDate: '2026-10-31',
      }),
      0,
    );
    assert.equal(
      await db[0].collection('lk_subscription_daily_booking_ops').countDocuments({
        state: 'CONFIRMED',
        'lk1.visitJob.phase': { $in: ['ATTEMPTING', 'PENDING'] },
      }),
      0,
    );
  },
);
test(
  'real Mongo owner: one admission lease wins; lost claim ACK never dispatches; canonical original-generation CAS rejects replacement',
  options,
  async (t) => {
    const db = await fixture(t);
    const doc = ownerDoc();
    const collection = 'lk_subscription_daily_booking_ops';
    await db[0].collection(collection).insertOne(doc);
    const attempts = db.map(() => resumeFreshToClaim(doc));
    const results = await Promise.all(
      attempts.map((m, i) => update(db[i].collection(collection), m.payload)),
    );
    assert.equal(
      results.reduce((n, r) => n + r.modifiedCount, 0),
      1,
    );
    const winner = results.findIndex((r) => r.modifiedCount === 1);
    attempts[winner].payload = undefined;
    attempts[winner].error = { message: 'synthetic lost ACK' };
    const out = run('router', attempts[winner]);
    assert.equal(out[7].payload.status, 'UNKNOWN');
    assert.equal(out[6], null);
    const actual = await db[2].collection(collection).findOne({ _id: doc._id });
    assert.equal(actual.state, 'ATTEMPTING');
    const recovery = readMessage(actual, 'admit', { recovery_only: true });
    recovery.m.payload = [];
    assert.equal(run('router', recovery.m)[7].payload.status, 'UNKNOWN');
    const { leave, bind } = terminal(doc);
    Object.assign(leave, {
      state: 'STARTED',
      claimToken: 'expired-claim',
      claimLeaseUntil: '2000-01-01T00:00:00.000Z',
    });
    await db[0].collection('lk_game_leave_operations').insertOne(leave);
    assert.equal(
      await db[1]
        .collection('lk_game_leave_operations')
        .countDocuments(legacy('retry_query', {}).payload),
      0,
    );
    assert.equal(
      legacy('retry_select', {
        payload: [await db[2].collection('lk_game_leave_operations').findOne({ _id: leave._id })],
      })[0],
      null,
    );
    const ctx = {
      managedSelfLeaveOwner: bind,
      mode: 'SELF',
      gameId: doc.legacyGameId,
      operationId: doc.ownerLeaveOperationId,
      operationKey: doc.ownerLeaveOperationKey,
      operationState: 'STARTED',
      actorClientId: doc.providerClientId,
      targetClientId: doc.providerClientId,
      claimToken: 'fresh-claim',
      membershipVersion: doc.membershipVersion,
      initialBookingIds: [doc.originalJoinReceipt.bookingId],
    };
    const m = { _splitLeaveCtx: ctx, payload: [leave] };
    assert.equal(legacy('operation_route', m)[3], m);
    assert.equal(legacy('operation_claim', m)[0], m);
    await db[1]
      .collection('lk_game_leave_operations')
      .updateOne(
        { _id: leave._id },
        { $set: { membershipVersion: 'replacement', bookingIds: ['replacement-booking'] } },
      );
    const result = await update(db[2].collection('lk_game_leave_operations'), m.payload);
    assert.equal(result.matchedCount, 0);
    assert.equal(
      (await db[3].collection('lk_game_leave_operations').findOne({ _id: leave._id })).claimToken,
      'expired-claim',
    );
  },
);
test(
  'real Mongo owner: exact terminal proof CAS survives lost ACK and mismatched generation never finalizes',
  options,
  async (t) => {
    const db = await fixture(t);
    const doc = ownerDoc();
    const rows = terminal(doc);
    const daily = 'lk_subscription_daily_booking_ops';
    await db[0].collection(daily).insertMany([doc, rows.booking]);
    await db[0].collection('lk_game_leave_operations').insertOne(rows.leave);
    const { m } = readMessage(await db[1].collection(daily).findOne({ _id: doc._id }));
    m.payload = await db[1].collection('lk_game_leave_operations').find(m.payload).toArray();
    assert.equal(run('router', m)[0], m);
    m.payload = await db[2].collection(daily).find(m.payload).toArray();
    assert.equal(run('router', m)[2], m);
    const result = await update(db[2].collection(daily), m.payload);
    assert.equal(result.modifiedCount, 1);
    m.error = { message: 'synthetic committed but response lost' };
    m.payload = undefined;
    assert.equal(run('router', m)[0], m);
    m.payload = await db[3].collection(daily).find(m.payload).toArray();
    assert.equal(run('router', m)[7].payload.status, 'CONFIRMED');
    const stored = await db[0].collection(daily).findOne({ _id: doc._id });
    assert.equal(stored.receipt.reservationId, doc.request.reservationId);
    assert.equal(
      await db[0]
        .collection(daily)
        .countDocuments({ kind: 'MANAGED_SELF_LEAVE_ADMISSION', state: 'CONFIRMED' }),
      1,
    );
    await db[1].collection(daily).updateOne(
      { _id: rows.booking._id },
      {
        $set: {
          operationId: crypto.randomUUID(),
          bookingId: 'replacement-booking',
          state: 'CONFIRMED',
        },
      },
    );
    const replay = readMessage(await db[3].collection(daily).findOne({ _id: doc._id }));
    assert.equal(replay.out[7].payload.status, 'CONFIRMED');
    assert.equal(replay.out.filter(Boolean).length, 1);
    assert.equal(replay.out[7].payload.receipt.providerBookingId, rows.booking.bookingId);
    // An unfinished admission cannot adopt proof belonging to a new generation.
    await db[0].collection(daily).replaceOne({ _id: doc._id }, doc);
    await db[0]
      .collection('lk_game_leave_operations')
      .updateOne({ _id: rows.leave._id }, { $set: { membershipVersion: 'replacement' } });
    const fresh = readMessage(await db[1].collection(daily).findOne({ _id: doc._id }));
    fresh.m.payload = await db[1]
      .collection('lk_game_leave_operations')
      .find(fresh.m.payload)
      .toArray();
    run('router', fresh.m);
    fresh.m.payload = await db[2].collection(daily).find(fresh.m.payload).toArray();
    assert.equal(run('router', fresh.m)[7].payload.status, 'UNKNOWN');
    assert.equal((await db[3].collection(daily).findOne({ _id: doc._id })).state, 'PENDING');
  },
);

test('real Mongo attribution guard: aggregate return cannot create marker; existing APPLIED readback CAS alone releases original row', options, async (t) => {
  const db = await fixture(t), doc = ownerDoc(), rows = terminal(doc);
  const daily = 'lk_subscription_daily_booking_ops', leaves = 'lk_game_leave_operations';
  const marker = structuredClone(rows.booking.managedSelfLeaveCancellation), b = marker.binding;
  const booking = { ...rows.booking, state: 'CONFIRMED', tenantKey: b.tenantKey,
    actorClientId: b.actorClientId, exerciseId: b.exerciseId, clientSubscriptionId: b.clientSubscriptionId,
    serviceDate: b.serviceDate, managedEntitlementState: 'CONFIRMED', managedEnvironment: 'PROD' };
  const receipt = structuredClone(booking.managedSelfLeaveReceipt);
  delete booking.managedSelfLeaveCancellation; delete booking.managedSelfLeaveReceipt;
  await db[0].collection(daily).insertOne(structuredClone(booking));
  const ctx = { mode: 'SELF', requestedRefundMethod: 'SERVICE', subscriptionReturnState: 'RETURN_VERIFIED',
    actorClientId: b.actorClientId, targetClientId: b.actorClientId, exerciseId: b.exerciseId,
    clientSubscriptionId: b.clientSubscriptionId, initialBookingIds: [b.bookingId],
    vivaVerification: 'active_absent_history_cancelled', operationKey: b.leaveOperationKey,
    operationId: b.leaveOperationId, gameId: b.gameId, membershipVersion: b.membershipVersion,
    claimToken: 'fixture-original-claim', actorAuthHeader: 'Bearer synthetic-actor' };
  const canonical = msg => new Function('msg', 'global', 'env', fs.readFileSync(
    new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8'))(
    msg, { get: () => undefined }, { get: () => undefined });
  const before = await db[1].collection(daily).findOne({ _id: booking._id });
  const held = legacy('daily_limit_route', { _splitLeaveCtx: ctx, payload: [before] });
  assert.equal(held[3].payload.reason, 'RETURN_ATTRIBUTION_UNVERIFIED');
  assert.equal(held.filter(Boolean).length, 1);
  const c = { caller: 'http', action: 'release', operationId: b.leaveOperationId, tenantKey: b.tenantKey, actorClientId: b.actorClientId,
    managedSelfLeave: { ...b, leaveClaimToken: ctx.claimToken }, releaseBookingId: b.bookingId,
    releaseOperation: before, step: 'managed_leave_operation' };
  const bypass = canonical({ _subscriptionBooking: c, payload: [before] });
  assert.equal(bypass[4].payload.details.code, 'RETURN_ATTRIBUTION_UNVERIFIED');
  assert.equal(bypass.filter(Boolean).length, 1);
  assert.deepEqual(await db[2].collection(daily).findOne({ _id: booking._id }), before);
  // Historical marker is fixture preimage, never minted by the guarded runtime.
  await db[0].collection(daily).updateOne({ _id: booking._id }, { $set: { managedSelfLeaveCancellation: marker } });
  c.releaseOperation = await db[1].collection(daily).findOne({ _id: booking._id });
  c.managedLeaveReadbackUrl = 'https://owner.example.test/internal/subscriptions/entitlements/readback';
  c.step = 'managed_leave_readback';
  const none = canonical({ _subscriptionBooking: c, statusCode: 200, responseUrl: c.managedLeaveReadbackUrl,
    payload: { ...receipt, operationState: 'CONFIRMED', compensationState: 'NONE', releaseReason: null } });
  assert.equal(none[4].payload.details.code, 'RETURN_ATTRIBUTION_UNVERIFIED');
  assert.equal(none.filter(Boolean).length, 1);
  assert.deepEqual(await db[2].collection(daily).findOne({ _id: booking._id }), c.releaseOperation);
  const leave = { ...rows.leave, state: 'VIVA_CONFIRMED', localApplyClaimToken: ctx.claimToken,
    localApplyLeaseUntil: new Date(Date.now() + 120000).toISOString(), subscriptionReturnState: 'RETURN_VERIFIED',
    vivaVerification: 'active_absent_history_cancelled', vivaConfirmedAt: new Date().toISOString(),
    subscriptionReturnVerifiedAt: new Date().toISOString(), requestedRefundMethod: 'SERVICE',
    subscriptionReturnChecks: [{ bookingId: b.bookingId, clientSubscriptionId: b.clientSubscriptionId,
      visitsLeftBefore: 3, expectedReturnCount: 1 }] };
  await db[0].collection(leaves).insertOne(leave);
  c.step = 'managed_leave_readback';
  const m = { _subscriptionBooking: c, statusCode: 200, responseUrl: c.managedLeaveReadbackUrl, payload: receipt };
  assert.equal(canonical(m)[7], m);
  m.payload = await db[1].collection(leaves).find(m.payload).toArray();
  assert.equal(canonical(m)[3], m);
  const result = await update(db[2].collection(daily), m.payload);
  assert.equal(result.modifiedCount, 1);
  m.error = { message: 'synthetic committed ACK lost' }; m.payload = undefined;
  assert.equal(canonical(m)[1], m);
  m.payload = await db[3].collection(daily).find(m.payload).toArray(); delete m.error;
  assert.equal(canonical(m)[4].payload.state, 'RELEASED');
  const after = await db[0].collection(daily).findOne({ _id: booking._id });
  assert.deepEqual(after.managedSelfLeaveCancellation, marker);
  assert.deepEqual(after.managedSelfLeaveReceipt, receipt);
});
