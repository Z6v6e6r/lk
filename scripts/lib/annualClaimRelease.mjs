// Guarded release of stale HUB annual reservations.
//
// The atomic annual inventory keeps a bounded daily seat occupied while the
// provider transaction is non-terminal — provider state, not the local checkout
// deadline, is authoritative for releasing HUB inventory. This module does not
// change that rule. It provides the reviewed, offline escape hatch for the case
// where the provider stays non-terminal long after the local checkout deadline
// has passed: an operator can move exactly one named reservation to the terminal
// FAILED state that the ledger schema already allows.
//
// The release is a pure transformation with explicit guards, so it can be unit
// tested without a database and replayed against a captured ledger.

import { annualHistory } from './annualSubscriptionHistory.mjs';

export const RELEASE_REASON = 'REPAIR_STALE_LOCAL_RESERVATION_PROVIDER_NON_TERMINAL';
export const ACTIVE_CLAIM_STATES = Object.freeze(['CLAIMED', 'DISPATCHING', 'PAYMENT_PENDING', 'PROVIDER_UNKNOWN']);

const moscowDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date(iso));

/** Latest of the local checkout deadlines recorded on a reservation, or null. */
export function claimDeadlineTs(reservation) {
  const deadlines = [reservation?.expiresAt, reservation?.paymentExpiresAt]
    .map((value) => (value ? Date.parse(value) : null))
    .filter((value) => Number.isFinite(value));
  return deadlines.length ? Math.max(...deadlines) : null;
}

/**
 * List reservations that a guarded release may move to FAILED.
 * Returns one entry per active reservation with a decision and a reason code.
 */
export function listAnnualClaims(ledger, { now = new Date().toISOString() } = {}) {
  const nowTs = Date.parse(now);
  const ledgerDate = moscowDate(now);
  return (ledger?.reservations ?? []).map((reservation, index) => {
    const deadlineTs = claimDeadlineTs(reservation);
    const base = {
      index,
      paymentRef: reservation?.paymentRef ?? null,
      state: reservation?.state ?? null,
      createdAt: reservation?.createdAt ?? null,
      expiresAt: reservation?.expiresAt ?? null,
      deadline: Number.isFinite(deadlineTs) ? new Date(deadlineTs).toISOString() : null,
      dailyDate: reservation?.dailyDate ?? null,
    };
    if (!ACTIVE_CLAIM_STATES.includes(reservation?.state)) {
      return { ...base, releasable: false, reason: 'STATE_TERMINAL' };
    }
    if (!Number.isFinite(deadlineTs)) {
      return { ...base, releasable: false, reason: 'DEADLINE_MISSING' };
    }
    if (deadlineTs > nowTs) {
      return { ...base, releasable: false, reason: 'DEADLINE_NOT_REACHED' };
    }
    if (reservation.dailyDate !== ledgerDate || ledger?.dailyDate !== ledgerDate) {
      return { ...base, releasable: false, reason: 'NOT_CURRENT_DAILY_SEAT' };
    }
    return { ...base, releasable: true, reason: null };
  });
}

/** Reservation for a paymentRef, or null when absent or ambiguous. */
export function findAnnualClaim(ledger, paymentRef) {
  const matches = (ledger?.reservations ?? []).filter((item) => item?.paymentRef === paymentRef);
  if (matches.length !== 1) return null;
  return matches[0];
}

/**
 * Pure release transformation.
 * Returns { ok: true, next, before, after, deadline } or { ok: false, code, message }.
 * Never mutates the input ledger.
 */
export function releaseAnnualClaim(ledger, { paymentRef, now = new Date().toISOString() } = {}) {
  const deny = (code, message) => ({ ok: false, code, message });
  if (!paymentRef) return deny('PAYMENT_REF_REQUIRED', 'paymentRef is required');
  if (ledger?.counterKey !== 'network_friendship') {
    return deny('COUNTER_NOT_ANNUAL_HUB', `Unexpected counterKey: ${ledger?.counterKey}`);
  }
  if (ledger?.schemaVersion !== 3 || ledger?.ready !== true) {
    return deny('LEDGER_NOT_READY_V3', 'Ledger is not a ready schemaVersion 3 document');
  }
  // The ambiguity guard runs before the structural guard so an operator sees
  // "which claim" problems before "the document is inconsistent" problems.
  if (!findAnnualClaim(ledger, paymentRef)) {
    const count = (ledger?.reservations ?? []).filter((item) => item?.paymentRef === paymentRef).length;
    return deny('CLAIM_NOT_UNIQUE', `Expected exactly one reservation for ${paymentRef}, found ${count}`);
  }
  if (!annualHistory.validate(ledger)) return deny('LEDGER_INVALID', 'Ledger fails its own validation before the repair');

  const reservation = findAnnualClaim(ledger, paymentRef);
  const decision = listAnnualClaims(ledger, { now }).find((item) => item.paymentRef === paymentRef);
  // Every guard keeps its own reason code so an operator can tell a claim that is
  // still inside its checkout window from one that is terminal or stale.
  if (!decision?.releasable) return deny(decision?.reason ?? 'CLAIM_NOT_RELEASABLE', `Reservation is not releasable: ${decision?.reason}`);

  const next = JSON.parse(JSON.stringify(ledger));
  const target = findAnnualClaim(next, paymentRef);
  target.state = 'FAILED';
  target.releasedAt = now;
  target.releaseReason = RELEASE_REASON;
  next.revision = ledger.revision + 1;
  next.updatedAt = now;
  Object.assign(next, annualHistory.counts(next, next.dailyDate));
  if (!annualHistory.validate(next)) return deny('REPAIRED_LEDGER_INVALID', 'Repaired ledger fails validation');

  const counters = (value) => ({
    paidCount: value.paidCount,
    reservedCount: value.reservedCount,
    takenCount: value.takenCount,
    dailyPaidCount: value.dailyPaidCount,
    dailyReservedCount: value.dailyReservedCount,
    revision: value.revision,
  });
  return {
    ok: true,
    next,
    reservation,
    deadline: decision.deadline,
    before: counters(ledger),
    after: counters(next),
  };
}
