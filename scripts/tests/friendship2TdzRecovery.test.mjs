import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { planFriendship2TdzRecovery as plan, dailyGuardKey, FRIENDSHIP2_PRODUCT, digest } from '../lib/friendship2TdzRecovery.mjs';
import { parseRecoveryArgs, readApprovedRecoveryPlan } from '../recover_friendship2_tdz.mjs';

function fixture(create = false) {
  const now = '2026-11-12T09:00:00.000Z', incidentEnd = '2026-11-12T08:50:00.000Z';
  const operation = { _id: 'lk1-product:["iSkq6G","fixture-actor","fixture-operation"]',
    tenantKey: 'iSkq6G', actorClientId: 'fixture-actor', clientSubscriptionId: 'fixture-subscription',
    operationId: 'fixture-operation', exerciseId: create ? 'preflight:fixture-operation' : 'fixture-exercise',
    category: 'open_game', serviceDate: '2026-11-13', state: 'PREPARED', attempts: 5,
    createdAt: '2026-11-12T07:10:00.000Z', updatedAt: '2026-11-12T07:15:00.000Z',
    lk1: { rule: { productId: FRIENDSHIP2_PRODUCT }, fingerprint: 'fixture-fingerprint',
      dailyVisitPolicyVersion: 1, decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } },
      target: { eventId: create ? 'preflight:fixture-operation' : 'fixture-exercise', startsAt: '2026-11-13T10:00:00+03:00',
        durationMinutes: 120, stationId: 'fixture-studio', roomId: 'fixture-room' },
      ...(create ? { createPayload: { roomId: 'fixture-room', timeFrom: '2026-11-13T10:00:00+03:00', timeTo: '2026-11-13T12:00:00+03:00' } } : {}) } };
  const evidence = (scope, rows) => ({ complete: true, scope, observedAt: now, rows });
  return { operation, now, incidentEnd,
    subscription: evidence('fixture-actor', [{ subscriptionId: 'fixture-subscription', status: 'ACTIVE', product: { id: FRIENDSHIP2_PRODUCT }, visitsTotal: 30, visitsLeft: 30, bookings: [] }]),
    target: evidence(create ? operation.serviceDate : operation.exerciseId, []), guard: evidence(dailyGuardKey(operation), []) };
}
test('CREATE/JOIN invalidate only local obsolete quote with durable cause and exact full CAS', () => {
  for (const create of [false, true]) {
    const f = fixture(create), p = plan(f); assert.equal(p.recoverable, true);
    assert.equal(p.command.update.$set.state, 'FAILED');
    assert.equal(p.command.update.$set.failure.rawCode, 'LK1_DAILY_VISIT_CHANGED');
    assert.equal(p.proof.cause, 'LK1_PREWRITE_RUNTIME_INTERRUPTED');
    assert.equal(p.proof.operationDigest, digest(f.operation));
    assert.equal(p.proof.previousAttempts, 5); assert.equal(p.proof.providerWrites, 0);
    for (const [k, v] of Object.entries(f.operation)) assert.deepEqual(p.command.query[k], { $eq: v });
    assert.deepEqual(p.command.query.$expr, { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(f.operation).length] });
    assert.equal(p.command.options.writeConcern.w, 'majority'); assert.equal(p.command.options.writeConcern.j, true);
    assert.equal('lk1' in p.command.update.$set, false); assert.equal('upstreamAttemptedAt' in p.command.update.$set, false);
  }
});
test('hung RELEASED source is retained for audit; money/native returns are excluded', () => {
  const f = fixture(); Object.assign(f.operation, { state: 'RELEASED', releaseReason: 'RECONCILE_HUNG_DAILY_CLAIM', releasedAt: '2026-11-12T08:00:00Z', reconciliation: { source: 'hung_claim_reconciler' } });
  const p = plan(f); assert.equal(p.recoverable, true); assert.equal(p.proof.previousRelease.releaseReason, f.operation.releaseReason);
  for (const releaseReason of ['LK1_FREE_VISIT_RETURN_VERIFIED', 'LK1_UNPAID_CHECKOUT_EXPIRED', 'CANCELLED_UNPAID_BOOKING']) {
    f.operation.releaseReason = releaseReason; assert.equal(plan(f).recoverable, false);
  }
});
test('provider markers and foreign or ambiguous evidence always hold', () => {
  for (const field of ['bookingId', 'upstreamBookingId', 'upstreamAttemptedAt', 'acceptedAt', 'correlationId', 'transactionId', 'visitJob', 'managedEntitlementOperationId']) {
    const f = fixture(); f.operation[field] = 'fixture-effect'; assert.equal(plan(f).reason, 'RECORDED_EFFECT_REQUIRES_RECONCILIATION', field);
  }
  for (const field of ['createAttemptedAt', 'bookingAttemptedAt', 'transactionAttemptedAt', 'transactionId', 'transactionIntent', 'checkout', 'visitJob', 'freeCancellationReturn']) {
    const f = fixture(); f.operation.lk1[field] = {}; assert.equal(plan(f).recoverable, false, field);
  }
  for (const field of ['subscription', 'target', 'guard']) {
    for (const change of [{ complete: false }, { observedAt: '2026-11-12T08:58:59Z' }, { observedAt: 'invalid' }, { scope: 'foreign' }]) {
      const f = fixture(); Object.assign(f[field], change); assert.equal(plan(f).recoverable, false, field + JSON.stringify(change));
    }
  }
  const f = fixture(); f.guard.rows.push({ ownerOperationKey: f.operation._id }); assert.equal(plan(f).reason, 'DAILY_GUARD_OWNED_OR_AMBIGUOUS');
});
test('only the bounded incident, exact product, old local states and consistent balances qualify', () => {
  for (const patch of [{ createdAt: '2026-11-11T20:00:00Z' }, { createdAt: '2026-11-12T08:55:00Z' },
    { updatedAt: '2026-11-12T08:59:30Z' }, { state: 'CONFIRMED' }, { state: 'FAILED' }, { tenantKey: 'foreign' }, { incidentRecovery: {} }]) {
    const f = fixture(); Object.assign(f.operation, patch); assert.equal(plan(f).recoverable, false, JSON.stringify(patch));
  }
  const f = fixture(); f.subscription.rows[0].visitsLeft = 29; assert.equal(plan(f).reason, 'SUBSCRIPTION_CONSUMPTION_UNRESOLVED');
  f.subscription.rows[0].visitsLeft = 30; f.operation.lk1.rule.productId = 'foreign'; assert.equal(plan(f).recoverable, false);
});
test('an existing zero-money native booking is reported without confirming or reissuing it', () => {
  const f = fixture(), booking = { id: 'fixture-booking', client: { id: 'fixture-actor' }, clientSubscriptionId: 'fixture-subscription',
    paymentType: 'SUBSCRIPTION', exerciseId: 'fixture-exercise', isCancelled: false, receipts: [],
    amountDue: { paidKopecks: 0, dueKopecks: 0, surchargeKopecks: 0 } };
  f.target.rows.push(booking); Object.assign(f.subscription.rows[0], { visitsLeft: 29, bookings: [booking] });
  assert.equal(plan(f).reason, 'ALREADY_BOOKED_IN_VIVA_NO_REPLAY');
  assert.equal(plan(f).recoverable, false);
  booking.amountDue.dueKopecks = 1; assert.equal(plan(f).reason, 'EXISTING_BOOKING_REQUIRES_RECONCILIATION');
});
test('CREATE overlap, missing flags and mismatched saved intent never dispatch or overwrite', () => {
  const f = fixture(true); f.target.rows.push({ id: 'fixture-existing', studio: { id: 'fixture-studio' }, room: { id: 'fixture-room' },
    timeFrom: '2026-11-13T11:00:00+03:00', timeTo: '2026-11-13T13:00:00+03:00', canceled: false });
  assert.equal(plan(f).reason, 'CREATE_SLOT_OCCUPIED');
  delete f.target.rows[0].canceled; assert.equal(plan(f).reason, 'CALENDAR_ROW_UNRESOLVED');
  f.target.rows = []; f.operation.lk1.createPayload.timeTo = '2026-11-13T13:00:00+03:00'; assert.equal(plan(f).reason, 'CREATE_INTENT_UNRESOLVED');
});
test('apply requires an exact private plan path AND immutable digest; unknown arguments stop', () => {
  const args = ['--output-dir', '/private/fixture-new-output', '--incident-end', '2026-11-12T08:50:00Z', '--expected-flow-sha256', 'a'.repeat(64)];
  assert.equal(parseRecoveryArgs(args)['--approved-plan'], undefined);
  assert.equal(parseRecoveryArgs([...args, '--operation-id', 'fixture-operation'])['--operation-id'], 'fixture-operation');
  assert.throws(() => parseRecoveryArgs([...args, '--operation-id', 'foreign filter']), /OPERATION_FILTER_INVALID/);
  assert.throws(() => parseRecoveryArgs([...args, '--approved-plan', '/private/fixture-plan']), /APPROVED_PLAN_REQUIRED/);
  assert.throws(() => parseRecoveryArgs([...args, '--apply', 'true']), /ARGUMENT_INVALID/);
  assert.throws(() => parseRecoveryArgs([...args, '--output-dir', '/private/duplicate']), /ARGUMENT_INVALID/);
  assert.equal(parseRecoveryArgs([...args, '--approved-plan', '/private/fixture-plan', '--approved-plan-sha256', 'b'.repeat(64)])['--approved-plan-sha256'], 'b'.repeat(64));
});
test('approved plan is parsed from the same protected descriptor whose bytes match its digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friendship2-plan-test-'));
  try {
    const file = path.join(dir, 'plan'), bytes = JSON.stringify({ schemaVersion: 1, fixture: true });
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.equal(readApprovedRecoveryPlan(file, sha).fixture, true);
    assert.throws(() => readApprovedRecoveryPlan(file, '0'.repeat(64)), /APPROVED_PLAN_DRIFT/);
    fs.symlinkSync(file, path.join(dir, 'alias')); assert.throws(() => readApprovedRecoveryPlan(path.join(dir, 'alias'), sha));
    fs.linkSync(file, path.join(dir, 'hardlink')); assert.throws(() => readApprovedRecoveryPlan(file, sha), /PRIVATE_FILE_REQUIRED/);
    fs.unlinkSync(path.join(dir, 'hardlink')); fs.chmodSync(file, 0o644);
    assert.throws(() => readApprovedRecoveryPlan(file, sha), /PRIVATE_FILE_REQUIRED/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
