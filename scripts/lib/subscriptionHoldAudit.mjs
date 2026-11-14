// Read-only audit of subscription holds in `lk_subscription_daily_booking_ops`.
//
// The booking gateway counts every operation that is not FAILED/RELEASED as a used
// allowance, and a `lk1-daily-visit` guard document keeps the whole Moscow day of a
// subscription instance owned by one operation. Neither is released when a trainer,
// an administrator or the provider cancels the booking or the whole exercise in Viva:
// the runtime only releases on a later request path with its own proof chain.
//
// This module answers one question per operation: "does this record still hold the
// allowance while the provider no longer holds the booking?" It is pure: no I/O, no
// clock of its own, and it builds no write command. It never decides a release; it
// classifies evidence for an operator report and for the future invariant
// "a hold exists only while the provider booking is active or the attempt is in
// flight within its lease".

import {
  AUDIT_ONLY_CLAIM_STATES,
  claimBookingId,
  exactId,
  hasCreateAttempt,
  isProviderCancelled,
  normalizeId,
  readCompleteBookingRows,
} from './hungClaimRelease.mjs';

export const HOLDING_STATES = Object.freeze(['PREPARED', 'PENDING_CONFIRMATION', 'CONFIRMED',
  ...AUDIT_ONLY_CLAIM_STATES]);
export const NOT_HOLDING_STATES = Object.freeze(['FAILED', 'RELEASED']);
export const DAILY_VISIT_GUARD_KIND = 'LK1_DAILY_VISIT_V1';

/** Verdicts. Only the two DEAD_HOLD_* verdicts are the defect this audit measures. */
export const HOLD_VERDICT = Object.freeze({
  NOT_HOLDING: 'NOT_HOLDING',
  LIVE: 'LIVE',
  DEAD_HOLD_CANCELLED: 'DEAD_HOLD_CANCELLED',
  DEAD_HOLD_ABSENT: 'DEAD_HOLD_ABSENT',
  UNBOUND: 'UNBOUND',
  PRECREATE_MANUAL: 'PRECREATE_MANUAL',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  EVIDENCE_MISSING: 'EVIDENCE_MISSING',
  EVIDENCE_INCOMPLETE: 'EVIDENCE_INCOMPLETE',
  EVIDENCE_CONFLICT: 'EVIDENCE_CONFLICT',
});

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const isObj = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const rowBookingId = row => exactId([row?.id, row?.bookingId, row?.uuid]);
const rowClientId = row => exactId([row?.clientId, row?.client?.id, row?.client?.clientId,
  row?.playerId, row?.userId]);
const rowSubscriptionId = row => exactId([row?.clientSubscriptionId, row?.subscriptionId,
  row?.clientSubId, row?.subscription?.clientSubscriptionId, row?.subscription?.subscriptionId,
  row?.subscription?.id, row?.subscription?.uuid, row?.clientSubscription?.clientSubscriptionId,
  row?.clientSubscription?.subscriptionId, row?.clientSubscription?.id,
  row?.clientSubscription?.uuid]);

/** Money or visit side effects that a hold release must never be confused with. */
export function moneyMarkers(operation) {
  const lk1 = isObj(operation?.lk1) ? operation.lk1 : {};
  const markers = [];
  for (const key of ['transactionAttemptedAt', 'transactionIntent', 'transactionId', 'checkout', 'visitJob']) {
    if (lk1[key] != null) markers.push(`lk1.${key}`);
  }
  if (operation?.transactionId != null) markers.push('transactionId');
  if (operation?.managedEntitlementOperationId || operation?.managedSubscriptionInstanceId) markers.push('managed');
  const price = lk1.decision?.benefit?.finalPriceMinor;
  if (Number.isSafeInteger(price) && price > 0) markers.push('finalPriceMinor>0');
  return markers;
}

/** Everything in the report except the verdict: safe, non-identifying attributes. */
function attributes(operation) {
  const visits = operation?.lk1?.decision?.subscriptionVisitCount;
  return {
    state: toStr(operation?.state),
    category: toStr(operation?.category),
    serviceDate: toStr(operation?.serviceDate),
    subscriptionVisitCount: Number.isSafeInteger(visits) ? visits : null,
    moneyMarkers: moneyMarkers(operation),
    createAttempt: hasCreateAttempt(operation),
  };
}

/**
 * Classify one operation against the provider readback of its exercise. `bookings` is
 * the raw admin payload of `GET /exercises/{id}/bookings?showCancelled=true`, or null
 * when it could not be read. Missing evidence is reported as such; it is never a verdict.
 */
export function classifySubscriptionHold({ operation, bookings }) {
  const base = attributes(operation);
  const verdict = (name, extra = {}) => ({ ...base, verdict: name, ...extra });
  if (!isObj(operation)) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'OPERATION_INVALID' });
  if (NOT_HOLDING_STATES.includes(base.state)) return verdict(HOLD_VERDICT.NOT_HOLDING);
  if (!HOLDING_STATES.includes(base.state)) return verdict(HOLD_VERDICT.UNKNOWN_STATE);
  if (AUDIT_ONLY_CLAIM_STATES.includes(base.state)) return verdict(HOLD_VERDICT.PRECREATE_MANUAL);

  const anyBound = claimBookingId(operation);
  if (!anyBound) return verdict(HOLD_VERDICT.UNBOUND);
  const boundId = exactId([operation.bookingId, operation.upstreamBookingId]);
  if (!boundId) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'BOOKING_ID_CONFLICT' });
  const actor = exactId([operation.actorClientId]);
  const subscription = exactId([operation.clientSubscriptionId]);
  if (!actor || !subscription) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'IDENTITY_UNRESOLVED' });
  if (!toStr(operation.exerciseId)) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'EXERCISE_ID_MISSING' });

  if (bookings === null || bookings === undefined) return verdict(HOLD_VERDICT.EVIDENCE_MISSING);
  const rows = readCompleteBookingRows(bookings);
  if (!rows) return verdict(HOLD_VERDICT.EVIDENCE_INCOMPLETE);
  if (rows.some(row => !isObj(row))) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'ROW_INVALID' });

  // A whole cancelled exercise shows every row cancelled. Report it as a signal only:
  // it explains who cancelled, it does not change the verdict of the bound row.
  const exerciseCancelledSignal = rows.length > 0 && rows.every(row => isProviderCancelled(row));
  const matches = rows.filter(row => [row.id, row.bookingId, row.uuid].some(id => normalizeId(id) === boundId));
  if (matches.length > 1) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'BOUND_BOOKING_AMBIGUOUS' });
  if (matches.length === 1) {
    const row = matches[0];
    if (rowBookingId(row) !== boundId) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'BOUND_BOOKING_UNRESOLVED' });
    if (rowClientId(row) !== actor || rowSubscriptionId(row) !== subscription) {
      return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'BOUND_BOOKING_IDENTITY_MISMATCH' });
    }
    const exerciseAliases = [row.exerciseId, row.exercise?.id, row.exercise?.exerciseId].filter(value => value != null);
    if (exerciseAliases.length && exactId(exerciseAliases) !== normalizeId(operation.exerciseId)) {
      return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'BOUND_EXERCISE_MISMATCH' });
    }
    if (!isProviderCancelled(row)) return verdict(HOLD_VERDICT.LIVE);
    return verdict(HOLD_VERDICT.DEAD_HOLD_CANCELLED, { exerciseCancelledSignal });
  }
  // The bound booking is absent from a complete readback. Another active booking of the
  // same actor and subscription on this exercise is still a live hold.
  for (const row of rows) {
    if (isProviderCancelled(row)) continue;
    const client = rowClientId(row);
    if (!client) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'PROVIDER_IDENTITY_UNRESOLVED' });
    if (client !== actor) continue;
    const sub = rowSubscriptionId(row);
    if (!sub) return verdict(HOLD_VERDICT.EVIDENCE_CONFLICT, { detail: 'PROVIDER_SUBSCRIPTION_ID_UNRESOLVED' });
    if (sub === subscription) return verdict(HOLD_VERDICT.LIVE, { detail: 'OTHER_ACTIVE_BOOKING' });
  }
  return verdict(HOLD_VERDICT.DEAD_HOLD_ABSENT, { exerciseCancelledSignal });
}

export const isDeadHold = decision => [HOLD_VERDICT.DEAD_HOLD_CANCELLED, HOLD_VERDICT.DEAD_HOLD_ABSENT]
  .includes(decision?.verdict);

/** Moscow date of an instant, as the gateway stores `serviceDate`. */
export function moscowDate(nowIso) {
  const ts = Date.parse(nowIso);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const increment = (object, key) => { object[key] = (object[key] ?? 0) + 1; };

/**
 * Aggregate an audit. `guards` are the `LK1_DAILY_VISIT_V1` documents of the scanned
 * window; a guard owned by a dead hold blocks the whole day of that subscription.
 * The summary carries counts only. `labelOf` maps an operation key to a report label.
 */
export function summarizeSubscriptionHolds({ operations, bookingsByExercise, guards = [], now, labelOf }) {
  const today = moscowDate(now);
  const list = Array.isArray(operations) ? operations : [];
  const decisions = list.map((operation) => {
    const key = normalizeId(operation?.exerciseId);
    const bookings = bookingsByExercise instanceof Map && key ? bookingsByExercise.get(key) ?? null : null;
    return classifySubscriptionHold({ operation, bookings });
  });
  const deadOwnerKeys = new Set(list.filter((_, index) => isDeadHold(decisions[index]))
    .map(operation => toStr(operation?._id)).filter(Boolean));
  const blockedDayGuards = (Array.isArray(guards) ? guards : [])
    .filter(guard => guard?.kind === DAILY_VISIT_GUARD_KIND && deadOwnerKeys.has(toStr(guard.ownerOperationKey)));

  const summary = {
    scanned: list.length,
    byVerdict: {},
    deadHolds: {
      total: 0,
      byCategory: {},
      byVisitCount: {},
      withMoneyMarkers: 0,
      exerciseCancelledSignal: 0,
      futureOrToday: 0,
      past: 0,
    },
    dailyGuardsScanned: Array.isArray(guards) ? guards.length : 0,
    dailyGuardsBlockedByDeadHold: blockedDayGuards.length,
  };
  const deadHoldLabels = [];
  decisions.forEach((decision, index) => {
    increment(summary.byVerdict, decision.verdict);
    if (!isDeadHold(decision)) return;
    const dead = summary.deadHolds;
    dead.total += 1;
    increment(dead.byCategory, decision.category ?? 'unknown');
    increment(dead.byVisitCount, String(decision.subscriptionVisitCount ?? 'unknown'));
    if (decision.moneyMarkers.length) dead.withMoneyMarkers += 1;
    if (decision.exerciseCancelledSignal) dead.exerciseCancelledSignal += 1;
    if (today && decision.serviceDate && decision.serviceDate >= today) dead.futureOrToday += 1;
    else dead.past += 1;
    if (typeof labelOf === 'function') {
      deadHoldLabels.push({
        operation: labelOf(toStr(list[index]?._id)),
        verdict: decision.verdict,
        category: decision.category,
        serviceDate: decision.serviceDate,
        subscriptionVisitCount: decision.subscriptionVisitCount,
        moneyMarkers: decision.moneyMarkers,
        exerciseCancelledSignal: decision.exerciseCancelledSignal,
        blocksDailyGuard: blockedDayGuards.some(guard => toStr(guard.ownerOperationKey) === toStr(list[index]?._id)),
      });
    }
  });
  return { summary, deadHolds: deadHoldLabels, decisions };
}

/**
 * Wrap a driver collection so that only read methods exist. Any other property access
 * throws, so a later edit cannot add a write to this audit by accident.
 */
export function readOnlyCollection(collection) {
  const allowed = new Set(['find', 'countDocuments', 'estimatedDocumentCount', 'collectionName']);
  return new Proxy(collection, {
    get(target, property, receiver) {
      if (typeof property === 'symbol' || property === 'then') return Reflect.get(target, property, receiver);
      if (!allowed.has(property)) throw new Error(`READ_ONLY_AUDIT: ${String(property)} is not allowed`);
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
