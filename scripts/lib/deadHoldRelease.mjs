// One-off release of "dead holds": CONFIRMED subscription operations whose Viva
// booking is explicitly cancelled, together with the daily-visit guard they own.
//
// Why both documents: the gateway hands a `lk1-daily-visit` guard to a new operation
// only when the old owner carries a proof of visit return. Releasing the operation
// alone would make usage say "visit available" while the guard still says "taken",
// and every new booking of that day would loop on 409 LK1_DAILY_VISIT_CHANGED. A
// guard that does not exist is simply created again by the next booking.
//
// This release does not claim the visit was returned to the Viva balance: it marks
// `visitReturn: 'UNVERIFIED'` and leaves refunds manual (ADR 0004). Pure module: no
// I/O, no clock. Commands are compare-and-swap on the exact observed documents.

import crypto from 'node:crypto';
import { CLAIM_CAS_FIELDS, normalizeId, WRITE_OPTIONS } from './hungClaimRelease.mjs';
import { DAILY_VISIT_GUARD_KIND, HOLD_VERDICT, classifySubscriptionHold } from './subscriptionHoldAudit.mjs';

export const DEAD_HOLD_RELEASE_REASON = 'DEAD_HOLD_PROVIDER_CANCELLED';
export const DEAD_HOLD_RELEASE_SOURCE = 'dead_hold_release_20261114';
export { WRITE_OPTIONS };

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

/** Guard id exactly as the gateway builds it. */
export const dailyVisitGuardKey = operation => `lk1-daily-visit:${JSON.stringify([
  operation?.tenantKey, normalizeId(operation?.clientSubscriptionId), operation?.serviceDate])}`;

/**
 * Decide one operation. `guard` is the document at `dailyVisitGuardKey(operation)` or
 * null. Returns { eligible, reason, releaseGuard }.
 */
export function planDeadHoldRelease({ operation, bookings, guard, today }) {
  const deny = reason => ({ eligible: false, reason, releaseGuard: false });
  if (!operation || typeof operation !== 'object') return deny('OPERATION_INVALID');
  if (operation.state !== 'CONFIRMED') return deny('STATE_NOT_CONFIRMED');
  if (!today || !toStr(operation.serviceDate) || operation.serviceDate < today) return deny('SERVICE_DATE_PAST');
  if (operation.activationState === 'PENDING') return deny('ACTIVATION_PENDING');
  const decision = classifySubscriptionHold({ operation, bookings });
  // Only an explicitly cancelled bound row. A booking missing from the readback is
  // reported by the audit, but this one-off run does not act on absence.
  if (decision.verdict !== HOLD_VERDICT.DEAD_HOLD_CANCELLED) return deny(`VERDICT_${decision.verdict}`);
  if (decision.moneyMarkers.length) return deny('MONEY_MARKERS');
  if (![0, 1].includes(decision.subscriptionVisitCount)) return deny('VISIT_COUNT_UNRESOLVED');
  if (!guard) return { eligible: true, reason: null, releaseGuard: false, decision };
  if (guard._id !== dailyVisitGuardKey(operation) || guard.kind !== DAILY_VISIT_GUARD_KIND) return deny('GUARD_INVALID');
  // Another operation owns the day: this release must not touch it.
  if (guard.ownerOperationKey !== operation._id) return { eligible: true, reason: null, releaseGuard: false, decision };
  if (guard.ownerOperationId !== operation.operationId || guard.tenantKey !== operation.tenantKey
    || guard.clientSubscriptionId !== normalizeId(operation.clientSubscriptionId)
    || guard.serviceDate !== operation.serviceDate) return deny('GUARD_BINDING_INVALID');
  return { eligible: true, reason: null, releaseGuard: true, decision };
}

const exactQuery = (document, keys) => Object.fromEntries(keys.map(key => [key,
  Object.hasOwn(document, key) ? { $eq: document[key] } : { $exists: false }]));

/** Commands for one eligible target. `guard` only when the plan releases it. */
export function buildDeadHoldReleaseCommands({ operation, guard, now }) {
  const nowIso = new Date(Date.parse(now)).toISOString();
  const operationCommand = {
    query: exactQuery(operation, CLAIM_CAS_FIELDS),
    update: {
      $set: {
        state: 'RELEASED',
        releasedAt: nowIso,
        releaseReason: DEAD_HOLD_RELEASE_REASON,
        visitReturn: 'UNVERIFIED',
        reconciliation: {
          source: DEAD_HOLD_RELEASE_SOURCE,
          // Deliberately not SAFE_TO_RELEASE: the gateway treats that value as part of
          // a visit-return proof chain, which this release does not provide.
          decision: 'PROVIDER_BOOKING_CANCELLED',
          reconciledAt: nowIso,
          observedState: operation.state,
          observedUpdatedAt: operation.updatedAt ?? null,
        },
        updatedAt: nowIso,
      },
      $unset: { pendingUntil: '', leaseUntil: '', precreateLeaseUntil: '' },
    },
  };
  const guardCommand = guard ? { query: exactQuery(guard, Object.keys(guard)) } : null;
  return { operationCommand, guardCommand };
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};
const sha = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Digest of the exact target set: any change to a target document changes it. */
export function deadHoldPlanDigest(targets) {
  const rows = targets.map(target => [target.operation._id, sha(canonical(target.operation)),
    target.guard ? target.guard._id : null, target.guard ? sha(canonical(target.guard)) : null]);
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sha(canonical(rows));
}

/**
 * Restore commands from a backup entry: only an operation still carrying exactly this
 * release is put back, and the guard is recreated only if no guard exists now.
 */
export function buildDeadHoldRestoreCommands({ operation, guard }) {
  return {
    operationCommand: {
      query: { _id: operation._id, state: 'RELEASED', releaseReason: DEAD_HOLD_RELEASE_REASON,
        'reconciliation.source': DEAD_HOLD_RELEASE_SOURCE },
      replacement: operation,
    },
    guardDocument: guard ?? null,
  };
}
