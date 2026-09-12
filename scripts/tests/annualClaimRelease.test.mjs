import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { annualHistory } from '../lib/annualSubscriptionHistory.mjs';
import { claimDeadlineTs, findAnnualClaim, listAnnualClaims, releaseAllAnnualClaims, releaseAnnualClaim, RELEASE_REASON } from '../lib/annualClaimRelease.mjs';

// Sanitized capture of the production HUB annual ledger (client identifiers,
// phones and provider references redacted). Real schema, real reservation
// shapes: one expired terminal claim, one expired pending claim and one pending
// claim whose checkout window is still open.
const FIXTURE_URL = new URL('../tests/fixtures/annualHubLedger.networkFriendshipEpoch.json', import.meta.url);
const fixture = () => JSON.parse(fs.readFileSync(fileURLToPath(FIXTURE_URL), 'utf8'));

const EXPIRED_REF = 'fixture-payment-ref-3';
const TERMINAL_REF = 'fixture-payment-ref-1';
const OTHER_TERMINAL_REF = 'fixture-payment-ref-2';
// The open claim expires at 2026-09-11T18:04:46.206Z, so this instant is after
// every deadline in the fixture while the fixture's Moscow daily seat is unchanged.
const NOW = '2026-09-11T19:00:00.000Z';

test('captured annual ledger fixture stays valid for its own schema', () => {
  const ledger = fixture();
  assert.equal(annualHistory.validate(ledger), true);
  assert.equal(ledger.counterKey, 'network_friendship');
  assert.equal(ledger.schemaVersion, 3);
  assert.equal(ledger.reservations.length, 3);
});

test('every captured reservation is free of client identifiers and provider links', () => {
  const serialized = JSON.stringify(fixture());
  assert.doesNotMatch(serialized, /\b[78]\d{10}\b/);
  assert.doesNotMatch(serialized, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  assert.doesNotMatch(serialized, /pay\.vivacrm\.ru/i);
  assert.doesNotMatch(serialized, /network_friendship-summer/i);
  assert.doesNotMatch(serialized, /"(clientPhone|phone|email)":\s*"(?!null)/);
  for (const reservation of fixture().reservations) {
    assert.equal(reservation.clientPhone, null);
    assert.match(reservation.clientId, /^fixture-client-\d+$/);
    assert.match(reservation.paymentRef, /^fixture-payment-ref-\d+$/);
  }
});

test('the claim scanner reports one releasable expired pending claim', () => {
  const claims = listAnnualClaims(fixture(), { now: NOW });
  assert.equal(claims.length, 3);
  assert.deepEqual(claims.filter((claim) => claim.releasable).map((claim) => claim.paymentRef), [EXPIRED_REF]);
  assert.equal(claims.find((claim) => claim.paymentRef === TERMINAL_REF).reason, 'STATE_TERMINAL');
  assert.equal(claims.find((claim) => claim.paymentRef === OTHER_TERMINAL_REF).reason, 'STATE_TERMINAL');
});

test('the scanner never marks a claim releasable before its own deadline', () => {
  const claims = listAnnualClaims(fixture(), { now: '2026-09-11T17:00:00.000Z' });
  assert.equal(claims.find((claim) => claim.paymentRef === EXPIRED_REF).reason, 'DEADLINE_NOT_REACHED');
  assert.equal(claims.some((claim) => claim.releasable), false);
});

test('a claim without a parseable deadline is never releasable', () => {
  const ledger = fixture();
  const pending = ledger.reservations.find((item) => item.paymentRef === EXPIRED_REF);
  pending.expiresAt = null;
  assert.equal(claimDeadlineTs(pending), null);
  // The ledger schema still accepts the document, so the claim guard is what stops the release.
  assert.equal(annualHistory.validate(ledger), true);
  const claim = listAnnualClaims(ledger, { now: NOW }).find((item) => item.paymentRef === EXPIRED_REF);
  assert.equal(claim.releasable, false);
  assert.equal(claim.reason, 'DEADLINE_MISSING');
  assert.equal(releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW }).code, 'DEADLINE_MISSING');
});

test('releasing an expired claim fails it, recomputes counters and bumps the revision once', () => {
  const ledger = fixture();
  const outcome = releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.before.revision, ledger.revision);
  assert.equal(outcome.after.revision, ledger.revision + 1);
  assert.equal(outcome.before.reservedCount, ledger.reservedCount);
  assert.equal(outcome.after.reservedCount, ledger.reservedCount - 1);
  assert.equal(outcome.after.dailyReservedCount, ledger.dailyReservedCount - 1);
  assert.equal(outcome.after.paidCount, ledger.paidCount);

  const released = outcome.next.reservations.find((item) => item.paymentRef === EXPIRED_REF);
  assert.equal(released.state, 'FAILED');
  assert.equal(released.releaseReason, RELEASE_REASON);
  assert.equal(released.releasedAt, NOW);
  assert.equal(annualHistory.validate(outcome.next), true);

  for (const other of [TERMINAL_REF, OTHER_TERMINAL_REF]) {
    assert.deepEqual(
      outcome.next.reservations.find((item) => item.paymentRef === other),
      ledger.reservations.find((item) => item.paymentRef === other),
    );
  }
});

test('release is a pure transformation of the input ledger', () => {
  const ledger = fixture();
  const snapshot = JSON.stringify(ledger);
  releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(JSON.stringify(ledger), snapshot);
});

test('the same claim cannot be released twice', () => {
  const first = releaseAnnualClaim(fixture(), { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(first.ok, true);
  const second = releaseAnnualClaim(first.next, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'STATE_TERMINAL');
});

test('a claim inside its checkout window is refused even when the ledger is otherwise releasable', () => {
  const outcome = releaseAnnualClaim(fixture(), { paymentRef: EXPIRED_REF, now: '2026-09-11T17:00:00.000Z' });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'DEADLINE_NOT_REACHED');
});

test('a claim from another Moscow daily seat is refused', () => {
  const ledger = fixture();
  const other = ledger.reservations.find((item) => item.paymentRef === EXPIRED_REF);
  other.dailyDate = '2026-09-10';
  Object.assign(ledger, annualHistory.counts(ledger, ledger.dailyDate));
  const outcome = releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'NOT_CURRENT_DAILY_SEAT');
});

test('a ledger that fails its own validation is never repaired', () => {
  const ledger = fixture();
  ledger.reservedCount += 1;
  const outcome = releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'LEDGER_INVALID');
});

test('only the annual HUB ledger is repairable', () => {
  const ledger = { ...fixture(), counterKey: 'piter_friendship' };
  const outcome = releaseAnnualClaim(ledger, { paymentRef: EXPIRED_REF, now: NOW });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'COUNTER_NOT_ANNUAL_HUB');
});

test('an ambiguous or unknown payment reference is refused', () => {
  assert.equal(releaseAnnualClaim(fixture(), { paymentRef: 'missing', now: NOW }).code, 'CLAIM_NOT_UNIQUE');
  assert.equal(findAnnualClaim(fixture(), 'missing'), null);

  // The ambiguity guard is checked before the ledger guards, so a structurally
  // invalid duplicate cannot be released either.
  const ambiguous = { ...fixture(), reservations: [
    { paymentRef: EXPIRED_REF, state: 'PAYMENT_PENDING' },
    { paymentRef: EXPIRED_REF, state: 'PAYMENT_PENDING' },
  ] };
  assert.equal(findAnnualClaim(ambiguous, EXPIRED_REF), null);
  assert.equal(releaseAnnualClaim(ambiguous, { paymentRef: EXPIRED_REF, now: NOW }).code, 'CLAIM_NOT_UNIQUE');
});

// A second stale claim on the same daily seat, built from the captured one so
// the ledger still passes its own validation (unique refs, transaction id and
// intent fingerprint), but the daily limit of the fixture is not asserted here.
const withSecondStaleClaim = () => {
  const ledger = fixture();
  const template = ledger.reservations.find((item) => item.paymentRef === EXPIRED_REF);
  const clone = JSON.parse(JSON.stringify(template));
  clone.paymentRef = 'fixture-payment-ref-4';
  clone.transactionId = 'fixture-transaction-4';
  clone.intentFingerprint = 'fixture-fingerprint-8';
  clone.requestFingerprint = 'fixture-fingerprint-7';
  clone.saleRecord = { ...clone.saleRecord, paymentRef: clone.paymentRef, requestFingerprint: clone.requestFingerprint };
  ledger.reservations.push(clone);
  Object.assign(ledger, annualHistory.counts(ledger, ledger.dailyDate));
  return ledger;
};

test('releaseAllAnnualClaims releases every stale claim in one chained transformation', () => {
  const ledger = withSecondStaleClaim();
  assert.equal(annualHistory.validate(ledger), true);
  const outcome = releaseAllAnnualClaims(ledger, { now: NOW });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.released.map((item) => item.paymentRef).sort(), ['fixture-payment-ref-3', 'fixture-payment-ref-4']);
  assert.equal(outcome.next.revision, ledger.revision + 2);
  assert.equal(outcome.next.reservedCount, ledger.reservedCount - 2);
  assert.equal(outcome.next.dailyReservedCount, ledger.dailyReservedCount - 2);
  assert.equal(outcome.next.takenCount, ledger.takenCount - 2);
  assert.equal(outcome.next.paidCount, ledger.paidCount);
  assert.equal(annualHistory.validate(outcome.next), true);
  for (const ref of ['fixture-payment-ref-3', 'fixture-payment-ref-4']) {
    assert.equal(outcome.next.reservations.find((item) => item.paymentRef === ref).state, 'FAILED');
  }
  // Terminal claims are left exactly as they were.
  for (const other of [TERMINAL_REF, OTHER_TERMINAL_REF]) {
    assert.deepEqual(
      outcome.next.reservations.find((item) => item.paymentRef === other),
      ledger.reservations.find((item) => item.paymentRef === other),
    );
  }
});

test('releaseAllAnnualClaims returns the input unchanged when nothing is stale', () => {
  const ledger = fixture();
  const outcome = releaseAllAnnualClaims(ledger, { now: '2026-09-11T17:00:00.000Z' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.released.length, 0);
  assert.equal(outcome.next, ledger);
});

test('releaseAllAnnualClaims is idempotent on an already released ledger', () => {
  const first = releaseAllAnnualClaims(fixture(), { now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.released.length, 1);
  const second = releaseAllAnnualClaims(first.next, { now: NOW });
  assert.equal(second.ok, true);
  assert.equal(second.released.length, 0);
  assert.equal(second.next, first.next);
});

test('releaseAllAnnualClaims applies the same ledger guards as a single release', () => {
  assert.equal(releaseAllAnnualClaims({ ...fixture(), counterKey: 'piter_friendship' }, { now: NOW }).code, 'COUNTER_NOT_ANNUAL_HUB');
  assert.equal(releaseAllAnnualClaims({ ...fixture(), ready: false }, { now: NOW }).code, 'LEDGER_NOT_READY_V3');
  const invalid = fixture();
  invalid.reservedCount += 1;
  assert.equal(releaseAllAnnualClaims(invalid, { now: NOW }).code, 'LEDGER_INVALID');
});

test('releaseAllAnnualClaims leaves the input ledger untouched', () => {
  const ledger = withSecondStaleClaim();
  const snapshot = JSON.stringify(ledger);
  releaseAllAnnualClaims(ledger, { now: NOW });
  assert.equal(JSON.stringify(ledger), snapshot);
});
