import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  DAILY_VISIT_GUARD_KIND,
  HOLD_VERDICT,
  classifySubscriptionHold,
  moscowDate,
  readOnlyCollection,
  summarizeSubscriptionHolds,
} from '../lib/subscriptionHoldAudit.mjs';
import { auditLabel, auditWindow, parseAuditArgs } from '../audit_subscription_holds.mjs';

// Synthetic identities only: the fixture must never carry a real actor or subscription.
const NOW = '2026-11-14T09:00:00.000Z';
const ACTOR = 'fixture-actor-0001';
const SUB = 'fixture-subscription-0001';
const EXERCISE = 'fixture-exercise-0001';
const BOOKING = 'fixture-booking-0001';

const operation = (extra = {}) => ({
  _id: `lk1-product:["fixture","${ACTOR}","fixture-operation-0001"]`,
  operationId: 'fixture-operation-0001',
  tenantKey: 'fixture',
  actorClientId: ACTOR,
  clientSubscriptionId: SUB,
  exerciseId: EXERCISE,
  bookingId: BOOKING,
  category: 'group_training',
  serviceDate: '2026-11-15',
  state: 'CONFIRMED',
  updatedAt: '2026-11-13T10:00:00.000Z',
  lk1: { decision: { subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } },
  ...extra,
});
const row = (extra = {}) => ({ id: BOOKING, clientId: ACTOR, clientSubscriptionId: SUB, exerciseId: EXERCISE,
  status: 'ACTIVE', ...extra });
const cancelled = (extra = {}) => row({ status: 'CANCELLED', isCancelled: true, ...extra });
const classify = (op, bookings) => classifySubscriptionHold({ operation: op, bookings });

test('an active bound booking is a live hold', () => {
  assert.equal(classify(operation(), [row()]).verdict, HOLD_VERDICT.LIVE);
});

test('a trainer-cancelled booking of a visit-consuming training is a dead hold', () => {
  const decision = classify(operation(), [cancelled(), row({ id: 'fixture-booking-0002', clientId: 'fixture-actor-0002' })]);
  assert.equal(decision.verdict, HOLD_VERDICT.DEAD_HOLD_CANCELLED);
  assert.equal(decision.subscriptionVisitCount, 1);
  assert.equal(decision.exerciseCancelledSignal, false);
});

test('a whole cancelled exercise is flagged as such', () => {
  const decision = classify(operation(), [cancelled(), cancelled({ id: 'fixture-booking-0002', clientId: 'fixture-actor-0002' })]);
  assert.equal(decision.verdict, HOLD_VERDICT.DEAD_HOLD_CANCELLED);
  assert.equal(decision.exerciseCancelledSignal, true);
});

test('a bound booking absent from a complete readback is a dead hold unless another booking is live', () => {
  assert.equal(classify(operation(), []).verdict, HOLD_VERDICT.DEAD_HOLD_ABSENT);
  const other = classify(operation(), [row({ id: 'fixture-booking-0009' })]);
  assert.equal(other.verdict, HOLD_VERDICT.LIVE);
  assert.equal(other.detail, 'OTHER_ACTIVE_BOOKING');
});

test('missing or incomplete provider evidence is never a dead hold', () => {
  assert.equal(classify(operation(), null).verdict, HOLD_VERDICT.EVIDENCE_MISSING);
  assert.equal(classify(operation(), { content: [cancelled()], last: false }).verdict, HOLD_VERDICT.EVIDENCE_INCOMPLETE);
  assert.equal(classify(operation(), { content: [cancelled()], totalElements: 5 }).verdict, HOLD_VERDICT.EVIDENCE_INCOMPLETE);
  const full = Array.from({ length: 200 }, (_, index) => row({ id: `fixture-booking-x${index}`, clientId: `fixture-actor-x${index}` }));
  assert.equal(classify(operation(), full).verdict, HOLD_VERDICT.EVIDENCE_INCOMPLETE);
});

test('conflicting identities are reported, not judged', () => {
  const cases = [
    [operation({ upstreamBookingId: 'fixture-booking-other' }), [cancelled()], 'BOOKING_ID_CONFLICT'],
    [operation(), [cancelled({ clientId: 'fixture-actor-0002' })], 'BOUND_BOOKING_IDENTITY_MISMATCH'],
    [operation(), [cancelled({ clientSubscriptionId: 'fixture-subscription-0002' })], 'BOUND_BOOKING_IDENTITY_MISMATCH'],
    [operation(), [cancelled({ exerciseId: 'fixture-exercise-0002' })], 'BOUND_EXERCISE_MISMATCH'],
    [operation(), [cancelled(), cancelled()], 'BOUND_BOOKING_AMBIGUOUS'],
    [operation(), [row({ id: 'fixture-booking-0009', clientId: undefined })], 'PROVIDER_IDENTITY_UNRESOLVED'],
    [operation({ actorClientId: '' }), [cancelled()], 'IDENTITY_UNRESOLVED'],
    [operation({ exerciseId: null }), [cancelled()], 'EXERCISE_ID_MISSING'],
  ];
  for (const [op, bookings, detail] of cases) {
    const decision = classify(op, bookings);
    assert.equal(decision.verdict, HOLD_VERDICT.EVIDENCE_CONFLICT, detail);
    assert.equal(decision.detail, detail);
  }
});

test('a cancellation flag contradicted by an active status stays live', () => {
  assert.equal(classify(operation(), [row({ isCancelled: false, status: 'CANCELLED' })]).verdict, HOLD_VERDICT.LIVE);
});

test('states keep their own verdict', () => {
  assert.equal(classify(operation({ state: 'RELEASED' }), [row()]).verdict, HOLD_VERDICT.NOT_HOLDING);
  assert.equal(classify(operation({ state: 'FAILED' }), [row()]).verdict, HOLD_VERDICT.NOT_HOLDING);
  assert.equal(classify(operation({ state: 'PRECREATE_RESERVED' }), [cancelled()]).verdict, HOLD_VERDICT.PRECREATE_MANUAL);
  assert.equal(classify(operation({ state: 'SOMETHING_NEW' }), [cancelled()]).verdict, HOLD_VERDICT.UNKNOWN_STATE);
  assert.equal(classify(operation({ state: 'PENDING_CONFIRMATION', bookingId: undefined }), []).verdict, HOLD_VERDICT.UNBOUND);
  assert.equal(classify(operation({ state: 'PENDING_CONFIRMATION' }), [cancelled()]).verdict, HOLD_VERDICT.DEAD_HOLD_CANCELLED);
});

test('money and visit markers are reported alongside the verdict', () => {
  const decision = classify(operation({ lk1: { transactionId: 'fixture-tx', visitJob: {},
    decision: { subscriptionVisitCount: 0, benefit: { finalPriceMinor: 50000 } } } }), [cancelled()]);
  assert.equal(decision.verdict, HOLD_VERDICT.DEAD_HOLD_CANCELLED);
  assert.deepEqual(decision.moneyMarkers, ['lk1.transactionId', 'lk1.visitJob', 'finalPriceMinor>0']);
});

test('the summary counts dead holds, blocked days and never leaks identifiers', () => {
  const dead = operation();
  const live = operation({ _id: 'fixture-live', operationId: 'fixture-operation-0002', exerciseId: 'fixture-exercise-0002',
    bookingId: 'fixture-booking-0002', serviceDate: '2026-11-10', category: 'open_game' });
  const pastDead = operation({ _id: 'fixture-past', operationId: 'fixture-operation-0003', serviceDate: '2026-11-01' });
  const guards = [
    { _id: 'lk1-daily-visit:fixture', kind: DAILY_VISIT_GUARD_KIND, ownerOperationKey: dead._id, serviceDate: '2026-11-15' },
    { _id: 'lk1-daily-visit:fixture-2', kind: DAILY_VISIT_GUARD_KIND, ownerOperationKey: live._id, serviceDate: '2026-11-10' },
  ];
  const bookingsByExercise = new Map([[EXERCISE, [cancelled()]],
    ['fixture-exercise-0002', [row({ id: 'fixture-booking-0002', exerciseId: 'fixture-exercise-0002' })]]]);
  const { summary, deadHolds } = summarizeSubscriptionHolds({ operations: [dead, live, pastDead], bookingsByExercise,
    guards, now: NOW, labelOf: auditLabel });
  assert.equal(summary.scanned, 3);
  assert.deepEqual(summary.byVerdict, { DEAD_HOLD_CANCELLED: 2, LIVE: 1 });
  assert.equal(summary.deadHolds.total, 2);
  assert.equal(summary.deadHolds.futureOrToday, 1);
  assert.equal(summary.deadHolds.past, 1);
  assert.deepEqual(summary.deadHolds.byVisitCount, { 1: 2 });
  assert.equal(summary.dailyGuardsBlockedByDeadHold, 1);
  assert.equal(deadHolds.filter(item => item.blocksDailyGuard).length, 1);
  const text = JSON.stringify({ summary, deadHolds });
  for (const secret of [ACTOR, SUB, BOOKING, EXERCISE, dead._id]) assert.equal(text.includes(secret), false, secret);
});

test('the read-only collection proxy refuses every write method', () => {
  const calls = [];
  const fake = { find: (query) => { calls.push(query); return { toArray: async () => [] }; },
    updateOne: () => assert.fail('write reached the driver'), collectionName: 'fixture' };
  const collection = readOnlyCollection(fake);
  collection.find({ a: 1 });
  assert.deepEqual(calls, [{ a: 1 }]);
  for (const method of ['updateOne', 'updateMany', 'insertOne', 'deleteOne', 'findOneAndUpdate', 'bulkWrite', 'replaceOne', 'drop']) {
    assert.throws(() => collection[method], /READ_ONLY_AUDIT/, method);
  }
});

test('the CLI has no write mode and validates its window', () => {
  assert.throws(() => parseAuditArgs(['--fixture', 'x.json', '--apply']), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseAuditArgs(['--fixture', 'x.json', '--backup-dir', '/tmp']), /UNKNOWN_ARGUMENT/);
  assert.throws(() => parseAuditArgs([]), /ARGUMENT_REQUIRED/);
  assert.throws(() => parseAuditArgs(['--fixture', 'x.json', '--days-ahead', '-1']), /ARGUMENT_INVALID/);
  const options = parseAuditArgs(['--fixture', 'x.json', '--now', NOW]);
  assert.deepEqual(auditWindow(options), { from: '2026-11-07', to: '2027-01-13', today: '2026-11-14' });
  assert.equal(moscowDate('2026-11-14T21:30:00.000Z'), '2026-11-15');
});

test('the CLI fixture run prints a redacted report', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hold-audit-'));
  const file = path.join(dir, 'fixture.json');
  fs.writeFileSync(file, JSON.stringify({ operations: [operation()], bookingsByExercise: { [EXERCISE]: [cancelled()] },
    guards: [{ kind: DAILY_VISIT_GUARD_KIND, ownerOperationKey: operation()._id, serviceDate: '2026-11-15' }] }));
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'audit_subscription_holds.mjs');
  const output = execFileSync(process.execPath, [script, '--fixture', file, '--now', NOW], { encoding: 'utf8' });
  const report = JSON.parse(output);
  assert.equal(report.mode, 'read-only-audit');
  assert.equal(report.summary.deadHolds.total, 1);
  assert.equal(report.summary.dailyGuardsBlockedByDeadHold, 1);
  assert.equal(output.includes(ACTOR), false);
  assert.equal(output.includes(SUB), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
