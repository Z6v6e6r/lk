import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  DEAD_HOLD_RELEASE_REASON, buildDeadHoldReleaseCommands, dailyVisitGuardKey, deadHoldPlanDigest,
  inFlightReason, planDeadHoldRelease,
} from '../lib/deadHoldRelease.mjs';
import { applyPlan, buildPlan, isPlainJson, parseReleaseArgs, restoreBackup, runScheduledTick, verifyApplied } from '../release_dead_subscription_holds.mjs';

// Synthetic identities only.
const NOW = '2026-11-14T09:00:00.000Z';
const TODAY = '2026-11-14';
const operation = (extra = {}) => ({
  _id: 'lk1-product:["fixture","fixture-actor-0001","fixture-operation-0001"]',
  operationId: 'fixture-operation-0001', tenantKey: 'fixture', actorClientId: 'fixture-actor-0001',
  clientSubscriptionId: 'Fixture-Subscription-0001', exerciseId: 'fixture-exercise-0001',
  bookingId: 'fixture-booking-0001', category: 'group_training', serviceDate: '2026-11-15', state: 'CONFIRMED',
  updatedAt: '2026-11-13T10:00:00.000Z',
  lk1: { decision: { subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } },
  ...extra,
});
const guardOf = (op, extra = {}) => ({ _id: dailyVisitGuardKey(op), kind: 'LK1_DAILY_VISIT_V1', tenantKey: op.tenantKey,
  clientSubscriptionId: op.clientSubscriptionId.toLowerCase(), serviceDate: op.serviceDate,
  ownerOperationKey: op._id, ownerOperationId: op.operationId, ...extra });
const row = (extra = {}) => ({ id: 'fixture-booking-0001', clientId: 'fixture-actor-0001',
  clientSubscriptionId: 'Fixture-Subscription-0001', exerciseId: 'fixture-exercise-0001', status: 'ACTIVE', ...extra });
const cancelled = (extra = {}) => row({ status: 'CANCELLED', isCancelled: true, ...extra });
const plan = (op, bookings, guard = null) => planDeadHoldRelease({ operation: op, bookings, guard, today: TODAY });

test('a cancelled confirmed booking is released together with the guard it owns', () => {
  const op = operation();
  const decision = plan(op, [cancelled()], guardOf(op));
  assert.equal(decision.eligible, true);
  assert.equal(decision.releaseGuard, true);
});

test('the guard key matches the gateway format', () => {
  assert.equal(dailyVisitGuardKey(operation()), 'lk1-daily-visit:["fixture","fixture-subscription-0001","2026-11-15"]');
});

test('everything that is not an explicit cancellation is left alone', () => {
  const op = operation();
  const denied = [
    [plan(op, [row()]), 'VERDICT_LIVE'],
    [plan(op, []), 'VERDICT_DEAD_HOLD_ABSENT'],
    [plan(op, null), 'VERDICT_EVIDENCE_MISSING'],
    [plan(op, { content: [cancelled()], last: false }), 'VERDICT_EVIDENCE_INCOMPLETE'],
    [plan(operation({ state: 'PENDING_CONFIRMATION' }), [cancelled()]), 'STATE_NOT_CONFIRMED'],
    [plan(operation({ state: 'RELEASED' }), [cancelled()]), 'STATE_NOT_CONFIRMED'],
    [plan(operation({ serviceDate: '2026-11-13' }), [cancelled()]), 'SERVICE_DATE_PAST'],
    [plan(operation({ lk1: { transactionId: 'fixture-tx', decision: { subscriptionVisitCount: 1 } } }), [cancelled()]), 'MONEY_MARKERS'],
    [plan(operation({ lk1: { visitJob: {}, decision: { subscriptionVisitCount: 1 } } }), [cancelled()]), 'MONEY_MARKERS'],
    [plan(operation({ lk1: { decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 100 } } } }), [cancelled()]), 'MONEY_MARKERS'],
    [plan(operation({ managedSubscriptionInstanceId: 'fixture-managed' }), [cancelled()]), 'MONEY_MARKERS'],
    [plan(operation({ activationState: 'PENDING' }), [cancelled()]), 'ACTIVATION_PENDING'],
    [plan(operation({ lk1: { decision: {} } }), [cancelled()]), 'VISIT_COUNT_UNRESOLVED'],
    [plan(op, [cancelled({ clientId: 'fixture-actor-0002' })]), 'VERDICT_EVIDENCE_CONFLICT'],
    [plan(op, [row({ isCancelled: false, status: 'CANCELLED' })]), 'VERDICT_LIVE'],
    [plan(op, [cancelled()], guardOf(op, { ownerOperationId: 'other' })), 'GUARD_BINDING_INVALID'],
    [plan(op, [cancelled()], guardOf(op, { serviceDate: '2026-11-16' })), 'GUARD_BINDING_INVALID'],
    [plan(op, [cancelled()], guardOf(op, { kind: 'OTHER' })), 'GUARD_INVALID'],
  ];
  for (const [decision, reason] of denied) {
    assert.equal(decision.eligible, false, reason);
    assert.equal(decision.reason, reason);
  }
});

test('a day owned by another operation is not touched', () => {
  const op = operation();
  const decision = plan(op, [cancelled()], guardOf(op, { ownerOperationKey: 'lk1-product:other', ownerOperationId: 'other' }));
  assert.equal(decision.eligible, true);
  assert.equal(decision.releaseGuard, false);
});

test('commands are exact compare-and-swap and never forge a visit-return proof', () => {
  const op = operation();
  const { operationCommand, guardCommand } = buildDeadHoldReleaseCommands({ operation: op, guard: guardOf(op), now: NOW });
  assert.deepEqual(operationCommand.query.state, { $eq: 'CONFIRMED' });
  assert.deepEqual(operationCommand.query.lk1, { $eq: op.lk1 });
  assert.deepEqual(operationCommand.query.upstreamBookingId, { $exists: false });
  assert.equal(operationCommand.update.$set.state, 'RELEASED');
  assert.equal(operationCommand.update.$set.releaseReason, DEAD_HOLD_RELEASE_REASON);
  assert.equal(operationCommand.update.$set.visitReturn, 'UNVERIFIED');
  assert.notEqual(operationCommand.update.$set.reconciliation.decision, 'SAFE_TO_RELEASE');
  assert.equal(operationCommand.update.$set.releaseSource, undefined);
  assert.equal(operationCommand.update.$set.releaseBookingId, undefined);
  assert.deepEqual(guardCommand.query.ownerOperationKey, { $eq: op._id });
  assert.equal(buildDeadHoldReleaseCommands({ operation: op, guard: null, now: NOW }).guardCommand, null);
});

test('the plan digest changes with any target document', () => {
  const op = operation();
  const a = deadHoldPlanDigest([{ operation: op, guard: guardOf(op) }]);
  assert.equal(a, deadHoldPlanDigest([{ operation: { ...op }, guard: guardOf(op) }]));
  assert.notEqual(a, deadHoldPlanDigest([{ operation: { ...op, updatedAt: NOW }, guard: guardOf(op) }]));
  assert.notEqual(a, deadHoldPlanDigest([{ operation: op, guard: null }]));
});

test('the CLI refuses an apply without backup and approved digest', () => {
  const base = ['--flows', '/x', '--token-file', '/t'];
  assert.throws(() => parseReleaseArgs([...base, '--apply']), /ARGUMENT_REQUIRED/);
  assert.throws(() => parseReleaseArgs([...base, '--apply', '--backup-dir', '/b']), /ARGUMENT_REQUIRED/);
  assert.throws(() => parseReleaseArgs([...base, '--force']), /UNKNOWN_ARGUMENT/);
  assert.equal(parseReleaseArgs(base).apply, false);
  assert.equal(isPlainJson({ a: [1, 'x', null, { b: true }] }), true);
  assert.equal(isPlainJson({ a: new Date() }), false);
});

test('a cancellation the client is making in LK right now is never raced', () => {
  const op = operation();
  const job = (extra = {}) => ({ kind: 'LK1_FREE_CANCEL_JOB_V1', phase: 'CANCEL_INTENT',
    clientSubscriptionId: 'fixture-subscription-0001', binding: { bookingId: 'fixture-booking-0001' }, ...extra });
  assert.equal(inFlightReason({ operation: op, jobs: [job()], now: NOW }), 'IN_FLIGHT_JOB');
  assert.equal(inFlightReason({ operation: op, jobs: [job({ clientSubscriptionId: 'other', binding: { bookingId: 'fixture-booking-0001' } })], now: NOW }), 'IN_FLIGHT_JOB');
  assert.equal(inFlightReason({ operation: op, jobs: [job({ clientSubscriptionId: undefined, binding: {} })], now: NOW }), 'IN_FLIGHT_JOB_UNRESOLVED');
  assert.equal(inFlightReason({ operation: op, jobs: [job({ phase: 'DONE' }), job({ phase: 'DECLINED' })], now: NOW }), null);
  assert.equal(inFlightReason({ operation: op, jobs: [job({ clientSubscriptionId: 'other', binding: { bookingId: 'other' } })], now: NOW }), null);
  assert.equal(inFlightReason({ operation: op, now: NOW, quietMs: 5 * 60000 }), null);
  assert.equal(inFlightReason({ operation: operation({ updatedAt: '2026-11-14T08:57:00.000Z' }), now: NOW, quietMs: 5 * 60000 }), 'UPDATED_RECENTLY');
  assert.equal(inFlightReason({ operation: operation({ updatedAt: undefined }), now: NOW, quietMs: 5 * 60000 }), 'UPDATED_RECENTLY');
});

test('the scheduled mode needs no digest but always a backup dir and report', () => {
  const base = ['--flows', '/x', '--token-file', '/t'];
  assert.throws(() => parseReleaseArgs([...base, '--scheduled']), /ARGUMENT_REQUIRED/);
  assert.throws(() => parseReleaseArgs([...base, '--scheduled', '--apply', '--backup-dir', '/b', '--report', '/r']), /ARGUMENT_INVALID/);
  const options = parseReleaseArgs([...base, '--scheduled', '--backup-dir', '/b', '--report', '/r']);
  assert.equal(options.scheduled, true);
  assert.equal(options.quietMinutes, 5);
  assert.equal(parseReleaseArgs(base).quietMinutes, 0);
});

// Real replica set (scripts/run_lk1_guard_repair_replica_tests.sh pattern). Skipped
// unless DEAD_HOLD_TEST_MONGO_URI points at a disposable replica set.
const uri = process.env.DEAD_HOLD_TEST_MONGO_URI;
test('replica set: release, concurrent change and restore', { skip: !uri }, async () => {
  const require = createRequire(import.meta.url);
  const { MongoClient } = require(process.env.DEAD_HOLD_TEST_MONGODB_MODULE || 'mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const collection = client.db('dead_hold_test').collection(`ops_${Date.now()}`);
    const dead = operation();
    const drifting = operation({ _id: 'lk1-product:drift', operationId: 'fixture-operation-0002',
      clientSubscriptionId: 'fixture-subscription-0002', bookingId: 'fixture-booking-0002',
      exerciseId: 'fixture-exercise-0002' });
    const live = operation({ _id: 'lk1-product:live', operationId: 'fixture-operation-0003',
      clientSubscriptionId: 'fixture-subscription-0003', bookingId: 'fixture-booking-0003',
      exerciseId: 'fixture-exercise-0003' });
    await collection.insertMany([dead, guardOf(dead), drifting, guardOf(drifting), live, guardOf(live)]);
    const responses = {
      'fixture-exercise-0001': [cancelled()],
      'fixture-exercise-0002': [cancelled({ id: 'fixture-booking-0002', clientSubscriptionId: 'fixture-subscription-0002',
        exerciseId: 'fixture-exercise-0002' })],
      'fixture-exercise-0003': [row({ id: 'fixture-booking-0003', clientSubscriptionId: 'fixture-subscription-0003',
        exerciseId: 'fixture-exercise-0003' })],
    };
    const fetchImpl = async (url) => {
      const id = decodeURIComponent(url.split('/exercises/')[1].split('/')[0]);
      return { ok: true, json: async () => responses[id] };
    };
    const options = { now: NOW, daysAhead: 14, requestGapMs: 0, vivaBase: 'https://fixture.invalid' };
    const planned = await buildPlan({ collection, options, token: 'fixture', fetchImpl });
    assert.equal(planned.targets.length, 2);
    assert.deepEqual(planned.byReason, { ELIGIBLE: 2, VERDICT_LIVE: 1 });
    // A concurrent runtime write after the plan must win.
    await collection.updateOne({ _id: drifting._id }, { $set: { 'lk1.touched': true } });
    const results = await applyPlan({ client, collection, plan: planned, now: NOW });
    assert.deepEqual(results.map(item => item.outcome).sort(), ['OPERATION_CHANGED', 'RELEASED_WITH_GUARD']);
    assert.equal(await verifyApplied({ collection, plan: planned, results }), 0);
    assert.equal((await collection.findOne({ _id: dead._id })).state, 'RELEASED');
    assert.equal(await collection.findOne({ _id: guardOf(dead)._id }), null);
    assert.equal((await collection.findOne({ _id: drifting._id })).state, 'CONFIRMED');
    assert.ok(await collection.findOne({ _id: guardOf(drifting)._id }));
    assert.equal((await collection.findOne({ _id: live._id })).state, 'CONFIRMED');
    // Restore puts back exactly the released document and its guard.
    const restored = await restoreBackup({ client, collection, backup: { targets: planned.targets } });
    assert.deepEqual(restored.map(item => item.outcome).sort(), ['OPERATION_NOT_IN_RELEASED_STATE', 'RESTORED']);
    assert.deepEqual(await collection.findOne({ _id: dead._id }), dead);
    assert.deepEqual(await collection.findOne({ _id: guardOf(dead)._id }), guardOf(dead));
    // Scheduled tick: the restored, the drifted and a new dead hold are released; an
    // in-flight LK cancellation is not.
    const fresh = operation({ _id: 'lk1-product:fresh', operationId: 'fixture-operation-0004',
      clientSubscriptionId: 'fixture-subscription-0004', bookingId: 'fixture-booking-0004', exerciseId: 'fixture-exercise-0004' });
    const racing = operation({ _id: 'lk1-product:racing', operationId: 'fixture-operation-0005',
      clientSubscriptionId: 'fixture-subscription-0005', bookingId: 'fixture-booking-0005', exerciseId: 'fixture-exercise-0005' });
    await collection.insertMany([fresh, guardOf(fresh), racing, guardOf(racing), { _id: 'lk1-free-cancel-job:fixture',
      kind: 'LK1_FREE_CANCEL_JOB_V1', phase: 'CANCEL_INTENT', clientSubscriptionId: 'fixture-subscription-0005',
      binding: { bookingId: 'fixture-booking-0005' } }]);
    for (const n of ['0004', '0005']) {
      responses[`fixture-exercise-${n}`] = [cancelled({ id: `fixture-booking-${n}`, clientSubscriptionId: `fixture-subscription-${n}`,
        exerciseId: `fixture-exercise-${n}` })];
    }
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-hold-tick-'));
    const tickOptions = { ...options, quietMinutes: 5, maxTargets: 10, backupDir: path.join(dir, 'b'), report: path.join(dir, 'r.json') };
    const tickPlan = await buildPlan({ collection, options: tickOptions, token: 'fixture', fetchImpl });
    const tick = await runScheduledTick({ client, collection, plan: tickPlan, options: tickOptions });
    assert.equal(tick.result, 'DONE');
    assert.deepEqual(tick.outcomes, { RELEASED_WITH_GUARD: 3 });
    assert.equal(tick.byReason.IN_FLIGHT_JOB, 1);
    assert.equal((await collection.findOne({ _id: racing._id })).state, 'CONFIRMED');
    assert.ok(await collection.findOne({ _id: guardOf(racing)._id }));
    assert.equal(JSON.parse(fs.readFileSync(tickOptions.report, 'utf8')).result, 'DONE');
    const idle = await runScheduledTick({ client, collection, plan: { ...tickPlan, targets: [] }, options: tickOptions });
    assert.equal(idle.result, 'NOTHING_TO_RELEASE');
    // A driver error inside the transaction rolls back and stops the tick.
    const broken = operation({ _id: 'lk1-product:broken', operationId: 'fixture-operation-0006',
      clientSubscriptionId: 'fixture-subscription-0006', bookingId: 'fixture-booking-0006', exerciseId: 'fixture-exercise-0006' });
    await collection.insertMany([broken, guardOf(broken)]);
    const failing = new Proxy(collection, { get: (target, key) => (key === 'deleteOne'
      ? async () => { throw Object.assign(new Error('fixture'), { codeName: 'FixtureFailure', code: 1 }); }
      : Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key)) });
    const failed = await applyPlan({ client, collection: failing, now: NOW,
      plan: { targets: [{ operation: broken, guard: guardOf(broken) }, { operation: live, guard: guardOf(live) }] } });
    assert.deepEqual(failed.map(item => item.outcome), ['TRANSACTION_ERROR']);
    assert.equal(failed[0].error, 'FixtureFailure:1');
    assert.deepEqual(await collection.findOne({ _id: broken._id }), broken);
    fs.rmSync(dir, { recursive: true, force: true });
    await collection.drop();
  } finally {
    await client.close();
  }
});
