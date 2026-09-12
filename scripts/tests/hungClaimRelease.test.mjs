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
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
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
  status: 'ACTIVE',
  exerciseDate: '2026-09-11T07:00:00.000Z',
  ...extra,
});

test('the declared deadline wins over the observed write time', () => {
  assert.equal(hungClaimDeadlineTs(operation({ pendingUntil: '2026-09-11T06:00:00.000Z' })),
    Date.parse('2026-09-11T06:00:00.000Z'));
  assert.equal(hungClaimDeadlineTs(operation({ leaseUntil: '2026-09-11T05:30:00.000Z' })),
    Date.parse('2026-09-11T05:30:00.000Z'));
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
    [operation({ bookingId: 'fixture-booking-0001' }), [], 'PROVIDER_BOOKING_BOUND'],
    [operation({ upstreamBookingId: 'fixture-booking-0001' }), [], 'PROVIDER_BOOKING_BOUND'],
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
  assert.equal(planHungClaimRelease({ operation: operation(), bookings: [exerciseScoped], now: NOW, ttlMs }).releasable, true);
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
  assert.deepEqual(command.query, { _id: row._id, operationId: row.operationId, state: row.state, updatedAt: row.updatedAt });
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
  assert.deepEqual(summary.byReason, { RELEASABLE: 1, STATE_TERMINAL: 1, PROVIDER_BOOKING_BOUND: 1 });
});

test('the HUB pre-accept writes the same bounded pending window as the daily gateway', () => {
  const hooks = read('../nodered_lk1_hub_nodes/gateway_hooks.js');
  const booking = read('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js');
  const helpers = hooks.slice(hooks.indexOf('// HUB_HELPERS'), hooks.indexOf('// HUB_PROFILE'));
  const fragment = hooks.slice(hooks.indexOf('// HUB_PREACCEPT'), hooks.indexOf('// HUB_BOOKING'));
  assert.match(helpers, /const HUB_PENDING_CONFIRMATION_MS = 15 \* 60 \* 1000;/);
  const dailyWindow = Number(booking.match(/const PENDING_CONFIRMATION_MS = (\d+) \* 60 \* 1000;/)?.[1]);
  assert.equal(dailyWindow, 15, 'the daily pending window is the reference');

  const updates = [];
  const prepareMongoUpdate = (ctx, step, query, update) => {
    updates.push({ step, query, update });
    return updates.length;
  };
  const now = new Date('2026-09-12T08:00:00.000Z');
  const ctx = {
    lk1: {},
    lk1BeforeCreate: true,
    operationKey: 'lk1-product:["fixture","fixture-actor","fixture-operation"]',
    operationId: 'fixture-operation',
  };
  new Function('ctx', 'now', 'prepareMongoUpdate', 'HUB_PENDING_CONFIRMATION_MS', fragment)(
    ctx, now, prepareMongoUpdate, 15 * 60 * 1000,
  );
  assert.equal(updates.length, 1);
  const [{ step, query, update }] = updates;
  assert.equal(step, 'lk1_create_attempt_saved');
  assert.deepEqual(query, {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: 'PREPARED',
    'lk1.createAttemptedAt': { $exists: false },
  });
  assert.equal(update.$set.state, 'PENDING_CONFIRMATION');
  assert.equal(update.$set['lk1.createAttemptedAt'], '2026-09-12T08:00:00.000Z');
  // The declared deadline is what the reconciler reads instead of its own fallback.
  assert.equal(update.$set.pendingUntil, '2026-09-12T08:15:00.000Z');
  assert.deepEqual(update.$unset, { leaseUntil: '' });
  assert.equal(update.$inc.attempts, 1);
  assert.equal(hungClaimDeadlineTs({ pendingUntil: update.$set.pendingUntil }), Date.parse('2026-09-12T08:15:00.000Z'));
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
