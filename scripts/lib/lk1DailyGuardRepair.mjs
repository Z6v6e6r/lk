import { lk1ReconciledCandidate, lk1ReconciledReadback } from './lk1ReconciledCancellation.mjs';
import { repairDigest, repairJobKey } from './lk1CancelledVisitRepair.mjs';
import { lk1FreeServiceDate } from './lk1FreeCancellation.mjs';

export function planDailyGuardRepair({ owner, target, guard, job, booking, transaction, subscriptions, now }) {
  const hold = reason => ({ recoverable: false, reason });
  if (!lk1ReconciledCandidate(owner) || owner.dailyGuardRecovery !== undefined) return hold('OWNER_UNVERIFIED');
  const p = job?.proof, b = p?.binding;
  if (job?._id !== repairJobKey(owner) || job.kind !== 'LK1_CANCELLED_VISIT_REPAIR_V1' || job.phase !== 'DONE'
    || p?.schemaVersion !== 1 || p.source !== 'CANCELLED_BOOKING_VISIT_REPAIR' || p.method !== 'SERVICE'
    || p.directAckStatus !== 200 || !Number.isFinite(Date.parse(p.verifiedAt)) || Date.parse(p.verifiedAt) > Date.parse(now)
    || b?.operationKey !== owner._id || b.operationId !== owner.operationId || b.tenantKey !== owner.tenantKey
    || b.actorClientId !== owner.actorClientId || b.clientSubscriptionId !== owner.clientSubscriptionId
    || b.bookingId !== owner.bookingId || b.exerciseId !== owner.exerciseId || b.serviceDate !== owner.serviceDate
    || b.transactionId !== owner.lk1.transactionId || b.chargeMinor !== owner.lk1.checkout.toPayMinor
    || b.fingerprint !== owner.lk1.fingerprint || p.before?.targetPresent !== false || p.after?.targetPresent !== false
    || p.before.total !== p.after.total || p.after.left !== p.before.left + 1 || p.before.other !== p.after.other) return hold('REPAIR_PROOF_UNVERIFIED');
  const current = lk1ReconciledReadback(owner, booking, transaction, subscriptions, now);
  if (!current || repairDigest(current) !== repairDigest(p.after)) return hold('FRESH_PROVIDER_STATE_CHANGED');
  const l = target?.lk1;
  if (!target || target.state !== 'FAILED' || target.failure?.statusCode !== 409 || target.failure.rawCode !== 'LK1_DAILY_VISIT_CHANGED'
    || target.attempts !== 0 || target.dailyGuardRecovery !== undefined || target.category !== 'open_game'
    || target.actorClientId !== owner.actorClientId || target.tenantKey !== owner.tenantKey
    || target.clientSubscriptionId !== owner.clientSubscriptionId || target.serviceDate !== owner.serviceDate
    || target._id !== `lk1-product:${JSON.stringify([target.tenantKey, target.actorClientId, target.operationId])}`
    || ![target.operationId, target.exerciseId, l?.fingerprint].every(v => typeof v === 'string' && v.length > 0)
    || l.dailyVisitPolicyVersion !== 1 || target.exerciseId === owner.exerciseId || l?.target?.eventId !== target.exerciseId
    || l.target.category !== 'GAME' || lk1FreeServiceDate(l.target.startsAt) !== target.serviceDate
    || Date.parse(l.target.startsAt) <= Date.parse(now)
    || !Number.isFinite(Date.parse(l.target.startsAt)) || l.rule?.productId !== owner.lk1.rule.productId
    || l.decision?.subscriptionVisitCount !== 1 || l.decision.eligible !== true
    || ['upstreamAttemptedAt', 'bookingId', 'upstreamBookingId', 'transactionId', 'transactionAttemptedAt',
      'transactionIntent', 'checkout', 'bookingAttemptedAt', 'acceptedAt', 'correlationId', 'visitJob', 'createAttemptedAt',
      'managedEntitlementOperationId', 'managedSubscriptionInstanceId', 'managedJoinV2', 'lk2LegacyJoin'].some(k => target[k] != null)
    || target.activationState === 'PENDING' || ['createAttemptedAt', 'bookingAttemptedAt', 'transactionAttemptedAt',
      'transactionIntent', 'transactionId', 'checkout', 'visitJob'].some(k => l[k] != null)) return hold('TARGET_NOT_UNTOUCHED_REFUSAL');
  const key = 'lk1-daily-visit:' + JSON.stringify([owner.tenantKey, owner.clientSubscriptionId.toLowerCase(), owner.serviceDate]);
  if (guard?._id !== key || guard.kind !== 'LK1_DAILY_VISIT_V1' || guard.tenantKey !== owner.tenantKey
    || guard.clientSubscriptionId !== owner.clientSubscriptionId.toLowerCase() || guard.serviceDate !== owner.serviceDate
    || guard.ownerOperationKey !== owner._id || guard.ownerOperationId !== owner.operationId || guard.recovery !== undefined) return hold('GUARD_OWNER_CHANGED');
  return { recoverable: true, ownerDigest: repairDigest(owner), targetDigest: repairDigest(target),
    guardDigest: repairDigest(guard), jobDigest: repairDigest(job), jobKey: job._id,
    ownerKey: owner._id, targetKey: target._id, guardKey: guard._id };
}

// Multi-document transaction fences both operations as well as the guard.
// No HTTP/provider dispatch is performed here. A user's subsequent retry still
// enters the normal fresh subscription/usage/price path of its FAILED operation.
export async function applyDailyGuardRepair({ operations, session, expectedPlan, providerEvidence,
  now = () => new Date().toISOString() }) {
  const readAt = Date.parse(providerEvidence.observedAt);
  return session.withTransaction(async () => {
    if (!Number.isFinite(readAt) || Date.parse(now()) - readAt < 0 || Date.parse(now()) - readAt > 30000) throw Error('HANDOFF_EVIDENCE_STALE');
    const get = key => operations.findOne({ _id: key }, { session });
    const owner = await get(expectedPlan.ownerKey), target = await get(expectedPlan.targetKey);
    const guard = await get(expectedPlan.guardKey), job = await get(expectedPlan.jobKey);
    const fresh = planDailyGuardRepair({ owner, target, guard, job, ...providerEvidence, now: now() });
    if (!fresh.recoverable || repairDigest(fresh) !== repairDigest(expectedPlan)) throw Error('HANDOFF_SNAPSHOT_DRIFT');
    const marker = { schemaVersion: 1, source: 'VERIFIED_CANCELLED_VISIT_REPAIR', jobKey: job._id,
      fromOperationKey: owner._id, toOperationKey: target._id, verifiedAt: now() };
    const exact = row => ({ _id: row._id, $expr: { $eq: ['$$ROOT', { $literal: row }] } });
    for (const row of [owner, target]) {
      const r = await operations.updateOne(exact(row), { $set: { dailyGuardRecovery: marker } }, { session });
      if (r.acknowledged !== true || r.matchedCount !== 1 || r.modifiedCount !== 1) throw Error('HANDOFF_OPERATION_CAS_LOST');
    }
    const r = await operations.updateOne(exact(guard), { $set: { ownerOperationKey: target._id,
      ownerOperationId: target.operationId, recovery: marker } }, { session });
    if (r.acknowledged !== true || r.matchedCount !== 1 || r.modifiedCount !== 1) throw Error('HANDOFF_GUARD_CAS_LOST');
    const j = await operations.updateOne(exact(job), { $set: { handoff: marker } }, { session });
    if (j.acknowledged !== true || j.matchedCount !== 1 || j.modifiedCount !== 1) throw Error('HANDOFF_PROOF_CAS_LOST');
    return { result: 'GUARD_TRANSFERRED_FOR_FRESH_RETRY', marker };
  }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true }, maxCommitTimeMS: 10000 });
}
