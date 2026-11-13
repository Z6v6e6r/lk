import crypto from 'node:crypto';
import { lk1ReconciledCandidate, lk1ReconciledReadback } from './lk1ReconciledCancellation.mjs';

export const repairDigest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const repairJobKey = op => `lk1-cancelled-visit-repair:${JSON.stringify([op.tenantKey, op.actorClientId, op.bookingId])}`;
export const repairLockKey = op => `lk1-free-cancel-lock:${JSON.stringify([op.tenantKey, op.clientSubscriptionId.toLowerCase()])}`;
const options = { writeConcern: { w: 'majority', j: true } };
const ack = r => r?.acknowledged === true && r.matchedCount === 1 && r.modifiedCount === 1;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const empty = v => v == null || Array.isArray(v) && v.length === 0;
const zero = v => v == null || Number.isSafeInteger(v) && v === 0;
const inactive = v => v == null || object(v) && v.available === false;
const noExecutor = v => v == null || object(v) && v.available === false && zero(v.refundSum) && empty(v.subscriptionReturns);
const noAddons = v => v == null || object(v) && empty(v.items) && zero(v.refundSum)
  && (v.available === undefined || v.available === false);
const noPackage = v => v == null || object(v) && zero(v.count) && zero(v.refundSum)
  && (v.available === undefined || v.available === false);

export function planCancelledVisitRepair({ op, booking, transaction, subscriptions, cancelOptions, now }) {
  const hold = reason => ({ recoverable: false, reason });
  if (!lk1ReconciledCandidate(op)) return hold('OPERATION_OUTSIDE_REPAIR_SCOPE');
  if (booking?.isGroup !== false || booking.groupPayerBookingId != null || booking.batchId != null) return hold('GROUP_BOOKING_HELD');
  if (cancelOptions?.bookingId !== op.bookingId || cancelOptions.subscription?.available !== true
    || cancelOptions.canCancelExercise !== false || !inactive(cancelOptions.exercise) || cancelOptions.group != null
    || !noExecutor(cancelOptions.executor) || !noAddons(cancelOptions.addons) || !noPackage(cancelOptions.packageAddons)
    || !Array.isArray(cancelOptions.refundMethods) || cancelOptions.refundMethods.length !== 0) return hold('SINGLE_SUBSCRIPTION_RETURN_UNVERIFIED');
  const list = subscriptions?.content;
  if (!Array.isArray(list) || subscriptions.last !== true || subscriptions.totalElements !== list.length) return hold('SUBSCRIPTION_LIST_INCOMPLETE');
  const matches = list.filter(s => s.subscriptionId === op.clientSubscriptionId);
  if (matches.length !== 1) return hold('SUBSCRIPTION_IDENTITY');
  const sub = matches[0];
  // Explicit repair of one missing visit: verify the expected postcondition
  // using the ordinary readback validator. This is a proposed counter value,
  // never a claim that the provider already returned the visit.
  if (!Number.isSafeInteger(sub.visitsLeft) || !Number.isSafeInteger(sub.visitsTotal)
    || sub.visitsLeft < 0 || !Array.isArray(sub.bookings)
    || sub.visitsTotal - sub.visitsLeft !== sub.bookings.length + 1) return hold('EXACT_ONE_VISIT_GAP_UNVERIFIED');
  const expected = structuredClone(subscriptions);
  expected.content.find(s => s.subscriptionId === op.clientSubscriptionId).visitsLeft++;
  const snapshot = lk1ReconciledReadback(op, booking, transaction, expected, now);
  if (!snapshot) return hold('BOOKING_MONEY_OR_CONSUMPTION_UNVERIFIED');
  return { recoverable: true, operationDigest: repairDigest(op), binding: {
    operationKey: op._id, operationId: op.operationId, tenantKey: op.tenantKey,
    actorClientId: op.actorClientId, clientSubscriptionId: op.clientSubscriptionId,
    bookingId: op.bookingId, exerciseId: op.exerciseId, serviceDate: op.serviceDate,
    transactionId: op.lk1.transactionId, chargeMinor: op.lk1.checkout.toPayMinor,
    fingerprint: op.lk1.fingerprint,
  }, before: { total: snapshot.total, left: snapshot.left - 1, targetPresent: false, other: snapshot.other },
  after: { ...snapshot, targetPresent: false } };
}

// Native cancellation and this repair share a subscription lock. A stable job
// key and the direct majority ACK are essential: a find after lost ACK never
// grants another SERVICE dispatch. The provider is an injected, exact GET/PUT
// adapter; the function does not retry any external write.
export async function repairCancelledVisit({ op, operations, provider, writeReceipt, now = () => new Date().toISOString(),
  approvedPlanDigest = null, beforeApply = async () => {} }) {
  const read = async () => {
    const startedAt = Date.parse(now());
    const booking = await provider.booking(), transaction = await provider.transaction();
    const subscriptions = await provider.subscriptions(), cancelOptions = await provider.cancelOptions();
    if (!Number.isFinite(startedAt) || Date.parse(now()) - startedAt < 0 || Date.parse(now()) - startedAt > 30000) throw Error('PROVIDER_READS_STALE');
    const input = { op, booking, transaction, subscriptions, cancelOptions, now: now() };
    return { input, plan: planCancelledVisitRepair(input) };
  };
  const observed = await read();
  await writeReceipt('readback', observed);
  if (!observed.plan.recoverable) return { result: 'HELD', reason: observed.plan.reason };
  const digest = repairDigest(observed.plan);
  if (!approvedPlanDigest) return { result: 'DRY_RUN_RECOVERABLE', planDigest: digest, plan: observed.plan };
  if (digest !== approvedPlanDigest) return { result: 'HELD', reason: 'APPROVED_PLAN_DRIFT' };
  await beforeApply();
  const key = repairJobKey(op), lockKey = repairLockKey(op);
  const existing = await operations.findOne({ _id: key });
  if (existing) return { result: 'HELD', reason: 'REPAIR_ALREADY_RECORDED', phase: existing.phase };
  const decline = async reason => {
    // Only an acknowledged pre-dispatch rejection is terminal. Unknown intent
    // and SERVICE outcomes deliberately retain the common lock for readback.
    const rejected = await operations.updateOne({ _id: key, phase: 'QUEUED', planDigest: digest, intentAt: { $exists: false } },
      { $set: { phase: 'DECLINED', reason, updatedAt: now() } }, options);
    if (!ack(rejected)) return { result: 'HELD', reason: 'PRE_DISPATCH_DECLINE_ACK_UNKNOWN' };
    return { result: 'HELD', reason };
  };
  let intentAttempted = false;
  try {
    await operations.updateOne({ _id: key }, { $setOnInsert: { kind: 'LK1_CANCELLED_VISIT_REPAIR_V1',
      phase: 'QUEUED', binding: observed.plan.binding, planDigest: digest, createdAt: now() } }, { ...options, upsert: true });
    await operations.updateOne({ _id: lockKey }, { $setOnInsert: { kind: 'LK1_FREE_CANCEL_LOCK_V1',
      ownerJobKey: key, tenantKey: op.tenantKey, clientSubscriptionId: op.clientSubscriptionId.toLowerCase() } }, { ...options, upsert: true });
    let lock = await operations.findOne({ _id: lockKey });
    if (lock?.kind !== 'LK1_FREE_CANCEL_LOCK_V1') return decline('SUBSCRIPTION_LOCK_INVALID');
    if (lock.ownerJobKey !== key) {
      const owner = await operations.findOne({ _id: lock.ownerJobKey });
      if (!owner || !['DONE', 'DECLINED'].includes(owner.phase)) return decline('SUBSCRIPTION_RETURN_IN_FLIGHT');
      if (!ack(await operations.updateOne({ _id: lockKey, ownerJobKey: lock.ownerJobKey }, { $set: { ownerJobKey: key } }, options))) {
        return decline('SUBSCRIPTION_LOCK_CHANGED');
      }
      lock = await operations.findOne({ _id: lockKey });
    }
    if (lock.ownerJobKey !== key) return decline('SUBSCRIPTION_LOCK_CHANGED');
    let fresh;
    try {
      fresh = await read();
      await writeReceipt('locked-readback', fresh);
      if (!fresh.plan.recoverable || repairDigest(fresh.plan) !== digest) return decline('LOCKED_READBACK_DRIFT');
      await beforeApply();
    } catch {
      return decline('PRE_DISPATCH_CHECK_FAILED');
    }
    // Caller checks other in-flight ledger jobs and the exact unchanged owner.
    const intentAt = now();
    intentAttempted = true;
    const intent = await operations.updateOne({ _id: key, phase: 'QUEUED', planDigest: digest },
      { $set: { phase: 'SERVICE_INTENT', intentAt, baseline: fresh.plan.before } }, options);
    if (!ack(intent)) return { result: 'HELD', reason: 'SERVICE_INTENT_ACK_UNKNOWN' };
    let response;
    try { response = await provider.returnVisit(); }
    catch { return { result: 'UNKNOWN', reason: 'SERVICE_DISPATCH_UNKNOWN' }; }
    await writeReceipt('service-ack', { status: response.status, observedAt: now() });
    if (response.status !== 200) return { result: 'UNKNOWN', reason: 'SERVICE_OUTCOME_UNVERIFIED', status: response.status };
    const after = await read();
    await writeReceipt('postcheck', after.input);
    const verified = lk1ReconciledReadback(op, after.input.booking, after.input.transaction, after.input.subscriptions, now());
    if (!verified || repairDigest(verified) !== repairDigest(fresh.plan.after)) {
      return { result: 'UNKNOWN', reason: 'RETURN_POSTCHECK_UNVERIFIED' };
    }
    const proof = { schemaVersion: 1, method: 'SERVICE', source: 'CANCELLED_BOOKING_VISIT_REPAIR',
      binding: fresh.plan.binding, before: fresh.plan.before, after: verified, verifiedAt: now(), directAckStatus: 200 };
    const done = await operations.updateOne({ _id: key, phase: 'SERVICE_INTENT', intentAt, planDigest: digest },
      { $set: { phase: 'DONE', proof, updatedAt: proof.verifiedAt } }, options);
    if (!ack(done)) return { result: 'UNKNOWN', reason: 'RETURN_PROOF_ACK_UNKNOWN' };
    return { result: 'VISIT_RETURN_VERIFIED', jobKey: key, proof };
  } catch {
    if (intentAttempted) return { result: 'UNKNOWN', reason: 'SERVICE_OR_PROOF_OUTCOME_UNKNOWN' };
    return decline('PRE_DISPATCH_CHECK_FAILED');
  }
}
