import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DEFAULT_HUNG_CLAIM_TTL_MS,
  RELEASE_REASON,
  buildHungClaimReleaseCommand,
  hungClaimDeadlineTs,
  planHungClaimRelease,
  summarizeHungClaims,
} from '../lib/hungClaimRelease.mjs';

const NOW = '2026-09-12T08:00:00.000Z';
const ttlMs = DEFAULT_HUNG_CLAIM_TTL_MS;
// Synthetic identities only: the fixture must never carry a real actor or subscription.
const ACTOR = 'fixture-actor-0001';
const SUB = 'fixture-subscription-0001';
const EXERCISE = 'fixture-exercise-0001';

const operation = (extra = {}) => ({
  _id: `fixture-tenant:${SUB}:2026-09-11`,
  operationId: 'fixture-operation-0001',
  tenantKey: 'fixture',
  actorClientId: ACTOR,
  clientSubscriptionId: SUB,
  exerciseId: EXERCISE,
  serviceDate: '2026-09-11',
  state: 'PENDING_CONFIRMATION',
  updatedAt: '2026-09-11T05:00:00.000Z',
  ...extra,
});

const booking = (extra = {}) => ({
  id: 'fixture-booking-0001',
  clientId: ACTOR,
  clientSubscriptionId: SUB,
  status: extra.isCancelled === true || extra.cancellationDate ? 'CANCELLED' : 'ACTIVE',
  exerciseDate: '2026-09-11T07:00:00.000Z',
  ...extra,
});

test('the declared deadline wins over the observed write time', () => {
  assert.equal(hungClaimDeadlineTs(operation({ pendingUntil: '2026-09-11T06:00:00.000Z' })),
    Date.parse('2026-09-11T06:00:00.000Z'));
  assert.equal(hungClaimDeadlineTs(operation({ leaseUntil: '2026-09-11T05:30:00.000Z' })),
    Date.parse('2026-09-11T05:30:00.000Z'));
  assert.equal(hungClaimDeadlineTs(operation({ pendingUntil: '2026-09-11T06:00:00Z', leaseUntil: '2026-09-13T06:00:00Z' })), Date.parse('2026-09-13T06:00:00Z'));
  assert.equal(hungClaimDeadlineTs(operation()), Date.parse('2026-09-11T05:00:00.000Z') + ttlMs);
  assert.equal(hungClaimDeadlineTs(operation({ createdAt: '2026-09-11T04:00:00.000Z', updatedAt: null })),
    Date.parse('2026-09-11T04:00:00.000Z') + ttlMs);
  assert.equal(hungClaimDeadlineTs({ state: 'PENDING_CONFIRMATION' }), null);
  assert.equal(hungClaimDeadlineTs(operation({ pendingUntil: 'not-a-date', updatedAt: 'not-a-date', createdAt: null })), null);
});

test('a claim inside its TTL is never released', () => {
  const decision = planHungClaimRelease({
    operation: operation({ updatedAt: '2026-09-12T07:45:00.000Z' }),
    bookings: [],
    now: NOW,
    ttlMs,
  });
  assert.equal(decision.releasable, false);
  assert.equal(decision.reason, 'DEADLINE_NOT_REACHED');
});

test('an expired unbound claim is releasable once the provider shows no active booking', () => {
  const decision = planHungClaimRelease({ operation: operation(), bookings: [], now: NOW, ttlMs });
  assert.equal(decision.releasable, true);
  assert.equal(decision.reason, null);
  assert.equal(decision.deadline, new Date(Date.parse('2026-09-11T05:00:00.000Z') + ttlMs).toISOString());
});

test('provider-bound, terminal and foreign states keep their own reason code', () => {
  const cases = [
    [operation({ bookingId: 'fixture-booking-0001' }), [], 'BOUND_BOOKING_UNRESOLVED'],
    [operation({ upstreamBookingId: 'fixture-booking-0001' }), [], 'BOUND_BOOKING_UNRESOLVED'],
    [operation({ state: 'CONFIRMED' }), [], 'STATE_TERMINAL'],
    [operation({ state: 'RELEASED' }), [], 'STATE_TERMINAL'],
    [operation({ state: 'FAILED' }), [], 'STATE_TERMINAL'],
    [operation({ state: 'PRECREATE_RESERVING' }), [], 'STATE_REQUIRES_MANUAL_RECONCILIATION'],
    [operation({ state: 'PRECREATE_ATTEMPTING' }), [], 'STATE_REQUIRES_MANUAL_RECONCILIATION'],
    [operation({ state: 'PRECREATE_RESERVED' }), [], 'STATE_REQUIRES_MANUAL_RECONCILIATION'],
    [operation({ state: 'PRECREATE_RECONCILIATION_REQUIRED' }), [], 'STATE_REQUIRES_MANUAL_RECONCILIATION'],
    [operation({ state: 'UNKNOWN_STATE' }), [], 'STATE_NOT_HUNG'],
    [operation({ actorClientId: null }), [], 'IDENTITY_UNRESOLVED'],
    [operation({ clientSubscriptionId: '' }), [], 'IDENTITY_UNRESOLVED'],
    [operation({ exerciseId: null }), [], 'EXERCISE_ID_MISSING'],
  ];
  for (const [row, bookings, reason] of cases) {
    const decision = planHungClaimRelease({ operation: row, bookings, now: NOW, ttlMs });
    assert.equal(decision.releasable, false, `${row.state} must not be releasable`);
    assert.equal(decision.reason, reason);
  }
});

test('missing or unproven provider evidence never releases a claim', () => {
  // No readback at all.
  for (const bookings of [null, undefined]) {
    const decision = planHungClaimRelease({ operation: operation(), bookings, now: NOW, ttlMs });
    assert.equal(decision.releasable, false);
    assert.equal(decision.reason, 'PROVIDER_EVIDENCE_MISSING');
  }
  // A readback that carries no provable complete list.
  for (const bookings of [{}, { totalElements: 0 }, { items: 0 }, 'text']) {
    const decision = planHungClaimRelease({ operation: operation(), bookings, now: NOW, ttlMs });
    assert.equal(decision.releasable, false);
    assert.equal(decision.reason, 'PROVIDER_EVIDENCE_INCOMPLETE');
  }
  const envelope = planHungClaimRelease({ operation: operation(), bookings: { content: [] }, now: NOW, ttlMs });
  assert.equal(envelope.releasable, true);
});

test('a truncated or paginated provider page keeps the claim', () => {
  const row = booking({ clientId: 'fixture-actor-0002' });
  const cases = [
    // A bare array that fills the requested page size cannot be distinguished from a cut list.
    Array.from({ length: 200 }, () => structuredClone(row)),
    { content: Array.from({ length: 200 }, () => structuredClone(row)) },
    { content: [row], totalElements: 300 },
    { content: [row], totalCount: 2 },
    { content: [row], last: false },
    { content: [row], hasNext: true },
    { content: [row], number: 0, totalPages: 3 },
  ];
  for (const bookings of cases) {
    const decision = planHungClaimRelease({ operation: operation(), bookings, now: NOW, ttlMs });
    assert.equal(decision.releasable, false, `expected no release for ${JSON.stringify(bookings).slice(0, 60)}`);
    assert.equal(decision.reason, 'PROVIDER_EVIDENCE_INCOMPLETE');
  }
  // The same rows on a proven final page are a valid readback.
  const finalPage = planHungClaimRelease({
    operation: operation(),
    bookings: { content: [row], totalElements: 1, totalPages: 1, number: 0, last: true },
    now: NOW,
    ttlMs,
  });
  assert.equal(finalPage.releasable, true);
});

test('an active booking of the same actor and subscription protects the claim', () => {
  const cases = [
    [booking(), 'PROVIDER_BOOKING_ACTIVE'],
    [booking({ status: 'WAITING' }), 'PROVIDER_BOOKING_ACTIVE'],
    [booking({ isCancelled: true }), null],
    [booking({ status: 'CANCELLED' }), null],
    [booking({ cancellationDate: '2026-09-11T06:00:00.000Z' }), null],
    [booking({ clientId: 'fixture-actor-0002' }), null],
    [booking({ clientSubscriptionId: 'fixture-subscription-0002' }), null],
    // A live row of this actor with no resolvable subscription is an ambiguous
    // provider state: the reconciler keeps the claim instead of guessing.
    [booking({ clientSubscriptionId: null, subscriptionId: null }), 'PROVIDER_SUBSCRIPTION_ID_UNRESOLVED'],
  ];
  for (const [row, reason] of cases) {
    const decision = planHungClaimRelease({ operation: operation(), bookings: [row], now: NOW, ttlMs });
    assert.equal(decision.reason, reason, `booking ${JSON.stringify(row)} expected ${reason}`);
  }
});

test('nested provider subscription aliases are matched case-insensitively', () => {
  const row = booking({ clientSubscriptionId: null, subscription: { clientSubscriptionId: SUB.toUpperCase() } });
  assert.equal(planHungClaimRelease({ operation: operation(), bookings: [row], now: NOW, ttlMs }).reason, 'PROVIDER_BOOKING_ACTIVE');
  const exerciseScoped = booking({ exercise: { id: EXERCISE, isCancelled: true } });
  assert.equal(planHungClaimRelease({ operation: operation(), bookings: [exerciseScoped], now: NOW, ttlMs }).releasable, false);
});

test('a live row whose subscription cannot be resolved keeps the claim', () => {
  const ambiguous = booking({ clientSubscriptionId: null, subscription: null, clientSubscription: null });
  const decision = planHungClaimRelease({ operation: operation(), bookings: [ambiguous], now: NOW, ttlMs });
  assert.equal(decision.releasable, false);
  assert.equal(decision.reason, 'PROVIDER_SUBSCRIPTION_ID_UNRESOLVED');
  // The same ambiguous row for another actor cannot protect this claim.
  const foreign = planHungClaimRelease({
    operation: operation(),
    bookings: [booking({ ...ambiguous, clientId: 'fixture-actor-0002' })],
    now: NOW,
    ttlMs,
  });
  assert.equal(foreign.releasable, true);
});

test('the release command is a compare-and-swap on the observed claim', () => {
  const row = operation();
  const command = buildHungClaimReleaseCommand({ operation: row, now: NOW });
  assert.deepEqual(command.query._id, { $eq: row._id });
  assert.deepEqual(command.query.state, { $eq: row.state });
  assert.deepEqual(command.query.updatedAt, { $eq: row.updatedAt });
  assert.deepEqual(command.query.upstreamBookingId, { $exists: false });
  assert.deepEqual(command.query.lk1, { $exists: false });
  assert.equal(command.update.$set.state, 'RELEASED');
  assert.equal(command.update.$set.releasedAt, NOW);
  assert.equal(command.update.$set.releaseReason, RELEASE_REASON);
  assert.equal(command.update.$set.reconciliation.decision, 'SAFE_TO_RELEASE');
  assert.equal(command.update.$set.reconciliation.observedState, 'PENDING_CONFIRMATION');
  assert.deepEqual(Object.keys(command.update.$unset), ['pendingUntil', 'leaseUntil', 'precreateLeaseUntil']);
  assert.deepEqual(command.options, { writeConcern: { w: 'majority', j: true } });
});

test('the audit summary counts every guard separately', () => {
  const summary = summarizeHungClaims({
    operations: [operation(), operation({ state: 'CONFIRMED' }), operation({ bookingId: 'b' })],
    bookingsByExercise: new Map([[EXERCISE.toLowerCase(), []]]),
    now: NOW,
    ttlMs,
  });
  assert.equal(summary.total, 3);
  assert.equal(summary.releasable.length, 1);
  assert.deepEqual(summary.byReason, { RELEASABLE: 1, STATE_TERMINAL: 1, BOUND_BOOKING_UNRESOLVED: 1 });
});

test('the CLI rehearses offline, refuses --apply with --fixture and never writes in dry-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hung-claims-'));
  const fixturePath = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixturePath, `${JSON.stringify({
    operations: [operation({ _id: 'fixture-doc-1' }), operation({ _id: 'fixture-doc-2', state: 'CONFIRMED' })],
    bookingsByExercise: { [EXERCISE]: [] },
  }, null, 2)}\n`);
  const script = fileURLToPath(new URL('../reconcile_hung_subscription_claims.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [script, '--fixture', fixturePath, '--now', NOW], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.scanned, 2);
  assert.equal(report.releasable.length, 1);
  assert.equal(report.backupPath, null);
  assert.equal(report.decisions.length, 2);
  // Reports carry a stable hash label, never the raw claim id.
  assert.ok(report.decisions.every((item) => /^[0-9a-f]{12}$/.test(item.claim)));
  assert.equal(out.includes('fixture-doc-1'), false);
  assert.throws(() => execFileSync(process.execPath,
    [script, '--fixture', fixturePath, '--apply', '--backup-dir', dir], { encoding: 'utf8', stdio: 'pipe' }),
  /--apply cannot be combined with --fixture/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exact bound cancellation releases only that exhausted pending claim', () => {
  const op = operation({ upstreamBookingId: 'fixture-booking-0001' });
  const cancelled = booking({ isCancelled: true });
  const decision = planHungClaimRelease({ operation: op, bookings: [cancelled], now: NOW });
  assert.equal(decision.releasable, true);
  assert.equal(decision.evidence, 'EXACT_CANCELLED_BOOKING');
  assert.equal(planHungClaimRelease({ operation: { ...op, state: 'RELEASED' }, bookings: [cancelled], now: NOW }).reason, 'STATE_TERMINAL');
  const cases = [
    [op, [], 'BOUND_BOOKING_UNRESOLVED'],
    [op, [cancelled, cancelled], 'BOUND_BOOKING_UNRESOLVED'],
    [{ ...op, bookingId: 'other' }, [cancelled], 'BOOKING_ID_CONFLICT'],
    [op, [{ ...cancelled, clientId: 'other' }], 'BOUND_BOOKING_IDENTITY_MISMATCH'],
    [op, [{ ...cancelled, clientSubscriptionId: 'other' }], 'BOUND_BOOKING_IDENTITY_MISMATCH'],
    [op, [{ ...cancelled, exerciseId: 'other' }], 'BOUND_EXERCISE_MISMATCH'],
    [op, [booking({ status: 'FAILED' })], 'BOUND_BOOKING_NOT_CANCELLED'],
    [op, [{ ...cancelled, isCancelled: false }], 'BOUND_BOOKING_NOT_CANCELLED'],
    [op, [{ ...cancelled, cancelled: false }], 'BOUND_BOOKING_NOT_CANCELLED'],
    [op, [{ ...cancelled, status: 'ACTIVE' }], 'BOUND_BOOKING_NOT_CANCELLED'],
    [op, [cancelled, booking({ id: 'active-neighbor' })], 'PROVIDER_BOOKING_ACTIVE'],
  ];
  for (const [operation, bookings, reason] of cases) {
    assert.equal(planHungClaimRelease({ operation, bookings, now: NOW }).reason, reason);
  }
});

test('ambiguous provider aliases and unresolved active clients fail closed', () => {
  for (const row of [booking({ clientId: null }), booking({ client: { id: 'other' } }), null]) {
    assert.equal(planHungClaimRelease({ operation: operation(), bookings: [row], now: NOW }).reason, 'PROVIDER_IDENTITY_UNRESOLVED');
  }
  assert.equal(planHungClaimRelease({ operation: operation(), bookings: [booking({ subscriptionId: 'other' })], now: NOW }).reason, 'PROVIDER_SUBSCRIPTION_ID_UNRESOLVED');
  for (const status of ['FAILED', 'REFUNDED', 'EXPIRED', 'ERROR']) {
    assert.equal(planHungClaimRelease({ operation: operation(), bookings: [booking({ status })], now: NOW }).reason, 'PROVIDER_BOOKING_ACTIVE');
  }
});

test('CREATE and external side effects remain manual even after exact cancellation', () => {
  const cancelled = booking({ isCancelled: true });
  for (const extra of [
    { lk1: { createAttemptedAt: NOW } }, { lk1: { bookingAttemptedAt: NOW } },
    { createAttemptedAt: NOW }, { lk1: { createPayload: {} } },
  ]) {
    assert.equal(planHungClaimRelease({ operation: operation({ upstreamBookingId: cancelled.id, ...extra }), bookings: [cancelled], now: NOW }).reason, 'CREATE_ATTEMPT_REQUIRES_MANUAL_RECONCILIATION');
  }
  for (const extra of [
    { managedEntitlementOperationId: 'entitlement' }, { managedSubscriptionInstanceId: 'instance' },
    { activationState: 'PENDING' }, ...['visitJob', 'transactionAttemptedAt', 'transactionIntent', 'transactionId', 'checkout'].map(key => ({ lk1: { [key]: {} } })),
  ]) {
    assert.equal(planHungClaimRelease({ operation: operation({ upstreamBookingId: cancelled.id, ...extra }), bookings: [cancelled], now: NOW }).reason, 'RELATED_OPERATION_REQUIRES_RECONCILIATION');
  }
});

test('cursor traverses permanently skipped prefixes and wraps without updatedAt', async () => {
  const { readHungClaimPage, readScanCursor, writeScanCursor } = await import('../lib/hungClaimScan.mjs');
  const rows = ['a', 'b', 'c', 'd', 'e'].map(_id => ({ _id }));
  const collection = { find(query) {
    const after = query.$and?.[1]?._id.$gt;
    let result = rows.filter(row => !after || row._id > after);
    return { sort() { return this; }, limit(n) { result = result.slice(0, n); return this; }, async toArray() { return result; } };
  } };
  const first = await readHungClaimPage({ collection, query: {}, limit: 2 });
  const second = await readHungClaimPage({ collection, query: {}, limit: 2, afterId: first.afterId });
  const third = await readHungClaimPage({ collection, query: {}, limit: 2, afterId: second.afterId });
  const wrap = await readHungClaimPage({ collection, query: {}, limit: 2, afterId: third.afterId });
  assert.deepEqual([...first.operations, ...second.operations, ...third.operations].map(row => row._id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(wrap.afterId, 'b');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-cursor-'));
  try {
    const file = path.join(dir, 'cursor.json');
    writeScanCursor(file, 'scope-a', second.afterId);
    assert.equal(readScanCursor(file, 'scope-a'), 'd');
    assert.equal(readScanCursor(file, 'scope-b'), null);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(planHungClaimRelease({ operation: operation({ updatedAt: undefined, createdAt: '2026-09-01T00:00:00Z' }), bookings: [], now: NOW }).releasable, true);
});

test('Mongo/CLI rehearsal: fresh evidence, CAS, retry and cursor', { skip: !process.env.HUNG_CLAIM_TEST_MONGO_URI }, async t => {
  const uri = process.env.HUNG_CLAIM_TEST_MONGO_URI;
  assert.ok(/^mongodb:\/\/127\.0\.0\.1:\d+\/?$/.test(uri), 'Only an isolated loopback Mongo is allowed');
  const { MongoClient } = await import('mongodb');
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const client = await MongoClient.connect(uri);
  const name = `hung_claim_verify_${process.pid}_${Date.now()}`;
  const db = client.db(name);
  const collection = db.collection('claims');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hung-cli-mongo-'));
  let reads = 0;
  let onRead = async () => ({ content: [booking({ isCancelled: true })], totalElements: 1, last: true });
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'GET');
      assert.ok(req.url.includes('showCancelled=true'));
      const body = await onRead(++reads);
      res.writeHead(body === null ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const script = fileURLToPath(new URL('../reconcile_hung_subscription_claims.mjs', import.meta.url));
  const cli = async (args = []) => {
    const common = [script, '--mongo-url', uri, '--database', name, '--collection', 'claims',
      '--viva-base', base, '--viva-token', 'fixture-only-token', '--limit', '1', ...args];
    try { const { stdout } = await run(process.execPath, common); return { code: 0, report: JSON.parse(stdout) }; }
    catch (error) { return { code: error.code, report: JSON.parse(error.stdout) }; }
  };
  const reset = async extra => {
    await collection.deleteMany({}); reads = 0;
    await collection.insertOne(operation({ upstreamBookingId: 'fixture-booking-0001', ...extra }));
  };
  try {
    await t.test('dry-run writes neither claim nor cursor, apply releases once', async () => {
      await reset({});
      const cursor = path.join(dir, 'dry-cursor.json');
      const dry = await cli(['--cursor-file', cursor]);
      assert.equal(dry.report.releasable.length, 1);
      assert.equal(fs.existsSync(cursor), false);
      assert.equal((await collection.findOne({})).state, 'PENDING_CONFIRMATION');
      const backup = path.join(dir, 'success');
      const applied = await cli(['--apply', '--backup-dir', backup]);
      assert.equal(applied.report.released.length, 1);
      assert.equal(reads, 3); // dry read + initial/fresh apply reads
      assert.equal((await collection.findOne({})).state, 'RELEASED');
      assert.ok(fs.existsSync(applied.report.backupPath));
      assert.equal(JSON.parse(fs.readFileSync(applied.report.backupPath))[0].state, 'PENDING_CONFIRMATION');
      const again = await cli(['--apply', '--backup-dir', backup]);
      assert.equal(again.report.released.length, 0);
      assert.equal(again.report.backupPath, null);
    });
    await t.test('fresh provider error prevents write and cursor advancement', async () => {
      await reset({});
      onRead = async n => n === 1 ? { content: [booking({ isCancelled: true })], last: true } : null;
      const result = await cli(['--apply', '--backup-dir', path.join(dir, 'error')]);
      assert.equal(result.code, 2);
      assert.equal(result.report.freshReadFailures, 1);
      assert.equal(result.report.cursorAdvanced, false);
      assert.equal((await collection.findOne({})).state, 'PENDING_CONFIRMATION');
    });
    await t.test('fresh active booking overrides cached cancellation', async () => {
      await reset({});
      onRead = async n => ({ content: [booking({ isCancelled: n === 1 })], last: true });
      const result = await cli(['--apply', '--backup-dir', path.join(dir, 'active')]);
      assert.equal(result.report.released.length, 0);
      assert.equal(result.report.skipped[0].reason, 'BOUND_BOOKING_NOT_CANCELLED');
      assert.equal((await collection.findOne({})).state, 'PENDING_CONFIRMATION');
    });
    await t.test('lk1 changes without updatedAt defeat CAS after provider read', async () => {
      await reset({});
      onRead = async n => {
        if (n === 2) await collection.updateOne({}, { $set: { lk1: { bookingAttemptedAt: NOW } } });
        return { content: [booking({ isCancelled: true })], last: true };
      };
      const result = await cli(['--apply', '--backup-dir', path.join(dir, 'cas')]);
      assert.equal(result.code, 2);
      assert.equal(result.report.compareAndSwapFailures.length, 1);
      assert.equal(result.report.released.length, 0);
      assert.equal((await collection.findOne({})).state, 'PENDING_CONFIRMATION');
    });
    await t.test('cursor progresses past skipped rows to legacy createdAt-only claim', async () => {
      await reset({ _id: 'a', state: 'PRECREATE_RESERVED' });
      const legacy = operation({ _id: 'b', createdAt: '2026-09-01T00:00:00Z', upstreamBookingId: 'fixture-booking-0001' });
      delete legacy.updatedAt;
      await collection.insertOne(legacy);
      onRead = async () => ({ content: [booking({ isCancelled: true })], last: true });
      const backup = path.join(dir, 'cursor');
      const first = await cli(['--apply', '--backup-dir', backup]);
      assert.equal(first.report.released.length, 0);
      assert.equal(first.report.cursorAdvanced, true);
      const second = await cli(['--apply', '--backup-dir', backup]);
      assert.equal(second.report.released.length, 1);
      assert.equal((await collection.findOne({ _id: 'b' })).state, 'RELEASED');
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await db.dropDatabase(); await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
