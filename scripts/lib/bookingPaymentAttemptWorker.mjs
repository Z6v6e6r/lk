import { paymentAttemptBinding, paymentAttemptDeadline, paymentAttemptInstant,
  paymentAttemptReleased, paymentAttemptTransaction, paymentAttemptBooking } from './bookingPaymentAttempt.mjs';
import { lk1FreeSubscription } from './lk1FreeCancellation.mjs';
import { visitAllowanceRelease } from './subscriptionVisitLifecycle.mjs';

const options = { writeConcern: { w: 'majority', j: true } };
export function eligiblePaymentAttempt(op) {
  const l = op?.lk1, c = l?.checkout, i = l?.transactionIntent;
  const category = { open_game: 'GAME', group_training: 'GROUP_TRAINING', tournament: 'TOURNAMENT' }[op?.category];
  return !!(category && ['CONFIRMED', 'RELEASED'].includes(op.state)
    && (c?.lifecycleVersion === 1 || op.category === 'open_game')
    // An installed older cancellation journal keeps ownership during upgrades.
    && !l?.unpaidCancellation && !l?.cancelledAllowanceRelease
    && op._id === `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`
    && [op.tenantKey, op.actorClientId, op.operationId, op.clientSubscriptionId, op.exerciseId, op.bookingId,
      l?.fingerprint, l?.rule?.productId, c?.transactionId, i?.productId].every(v => typeof v === 'string' && v.length > 0)
    && (!op.upstreamBookingId || op.upstreamBookingId === op.bookingId)
    && l.target?.category === category && l.target.eventId === op.exerciseId
    && [0, 1].includes(l.decision?.subscriptionVisitCount)
    && Number.isSafeInteger(c.toPayMinor) && c.toPayMinor > 0 && c.toPayMinor === l.decision.benefit?.finalPriceMinor
    && c.toPayMinor === i.chargeMinor && i.bookingId === op.bookingId && i.actorClientId === op.actorClientId
    && i.studioId === l.target.stationId && l.transactionId === c.transactionId
    && paymentAttemptDeadline(c, l.transactionAttemptedAt) !== null
    && paymentAttemptInstant(l.target.startsAt) !== null
    && !op.managedEntitlementOperationId && !op.managedJoinV2 && !op.lk2LegacyJoin);
}

// Each external write has a majority-committed, full-preimage intent. A resumed
// intent only reads its outcome; it never retries a possibly executed command.
export async function reconcileBookingPaymentAttempt({ op, operations, provider,
  mode = 'SHADOW', now = () => new Date().toISOString(), shouldStop = () => false }) {
  if (!['SHADOW', 'ENFORCE_NEW'].includes(mode)) return { state: 'OFF' };
  if (!eligiblePaymentAttempt(op)) return { state: 'SKIPPED', reason: 'PAYMENT_ATTEMPT_OUT_OF_SCOPE' };
  if (shouldStop()) return { state: 'STOPPED' };
  let current = op;
  const resourceJobKey = 'booking-payment-close-job:' + JSON.stringify([op.tenantKey, op.actorClientId, op.operationId]);
  const pending = reason => ({ state: 'PAYMENT_CLOSING', reason });
  async function save(fields) {
    if (shouldStop()) return false;
    const at = now();
    const ack = await operations.updateOne({ _id: current._id,
      $expr: { $eq: ['$$ROOT', { $literal: current }] } }, { $set: { updatedAt: at, ...fields } }, options);
    if (ack?.acknowledged !== true || ack.matchedCount !== 1 || ack.modifiedCount !== 1) return false;
    // Re-read the committed journal. A lost ACK cannot reach a provider write.
    current = await operations.findOne({ _id: current._id });
    return !!current && eligiblePaymentAttempt(current) && Object.entries(fields).every(([path, value]) => {
      const actual = path.split('.').reduce((row, key) => row?.[key], current);
      return JSON.stringify(actual) === JSON.stringify(value);
    });
  }
  async function transaction() {
    if (shouldStop()) return 'STOPPED';
    const value = await provider.readTransaction(current);
    return shouldStop() ? 'STOPPED' : paymentAttemptTransaction(current, value);
  }
  async function serviceLock() {
    if (shouldStop()) return false;
    // Publish ownership before creating the job. A concurrent PAID CAS then
    // either fences this writer or retains a durable completion obligation.
    if (!current.lk1.paymentAttempt?.resourceJobKey) {
      if (!await save({ 'lk1.paymentAttempt': { ...current.lk1.paymentAttempt,
        resourceJobKey, resourceJobCompleted: false } })) return false;
    }
    if (current.lk1.paymentAttempt.resourceJobKey !== resourceJobKey
      || current.lk1.paymentAttempt.phase === 'PAID' || shouldStop()) return false;
    const lockKey = 'lk1-free-cancel-lock:' + JSON.stringify([current.tenantKey, current.clientSubscriptionId.toLowerCase()]);
    await operations.updateOne({ _id: resourceJobKey }, { $setOnInsert: {
      _id: resourceJobKey, kind: 'BOOKING_PAYMENT_CLOSE_JOB_V1', tenantKey: current.tenantKey,
      clientSubscriptionId: current.clientSubscriptionId.toLowerCase(), operationKey: current._id,
      phase: 'QUEUED', createdAt: now() } }, { ...options, upsert: true });
    if (shouldStop()) return false;
    await operations.updateOne({ _id: lockKey }, { $setOnInsert: {
      _id: lockKey, kind: 'LK1_FREE_CANCEL_LOCK_V1', tenantKey: current.tenantKey,
      ownerJobKey: resourceJobKey } }, { ...options, upsert: true });
    const lock = await operations.findOne({ _id: lockKey });
    if (!lock || lock.kind !== 'LK1_FREE_CANCEL_LOCK_V1') return false;
    if (lock.ownerJobKey === resourceJobKey) return true;
    const owner = await operations.findOne({ _id: lock.ownerJobKey });
    if (!owner || !['DONE', 'DECLINED'].includes(owner.phase)) return false;
    if (shouldStop()) return false;
    const ack = await operations.updateOne({ _id: lockKey, $expr: { $eq: ['$$ROOT', { $literal: lock }] } },
      { $set: { ownerJobKey: resourceJobKey } }, options);
    return ack?.acknowledged === true && ack.matchedCount === 1 && ack.modifiedCount === 1;
  }
  async function finishServiceJob() {
    if (!current.lk1.paymentAttempt?.resourceJobKey) return true;
    if (current.lk1.paymentAttempt.resourceJobKey !== resourceJobKey) return false;
    let job = await operations.findOne({ _id: resourceJobKey });
    // PAID can win after the operation claimed the resource but before the job
    // insert. Its terminal insert fences a delayed QUEUED $setOnInsert as well.
    if (!job && current.lk1.paymentAttempt.phase === 'PAID' && !current.lk1.paymentAttempt.cancelIntentAt) {
      if (shouldStop()) return false;
      await operations.updateOne({ _id: resourceJobKey }, { $setOnInsert: {
        _id: resourceJobKey, kind: 'BOOKING_PAYMENT_CLOSE_JOB_V1', tenantKey: current.tenantKey,
        clientSubscriptionId: current.clientSubscriptionId.toLowerCase(), operationKey: current._id,
        phase: 'DONE', createdAt: now(), updatedAt: now() } }, { ...options, upsert: true });
      job = await operations.findOne({ _id: resourceJobKey });
    }
    if (!job || job.operationKey !== current._id || job.kind !== 'BOOKING_PAYMENT_CLOSE_JOB_V1'
      || job.tenantKey !== current.tenantKey
      || job.clientSubscriptionId !== current.clientSubscriptionId.toLowerCase()
      || !['QUEUED', 'DONE'].includes(job.phase)) return false;
    if (job.phase !== 'DONE') {
      if (shouldStop()) return false;
      const ack = await operations.updateOne({ _id: resourceJobKey, $expr: { $eq: ['$$ROOT', { $literal: job }] } },
        { $set: { phase: 'DONE', updatedAt: now() } }, options);
      if (ack?.acknowledged !== true || ack.matchedCount !== 1) return false;
    }
    if (!current.lk1.paymentAttempt.resourceJobCompleted) return save({ 'lk1.paymentAttempt': {
      ...current.lk1.paymentAttempt, resourceJobCompleted: true } });
    return true;
  }
  if (paymentAttemptReleased(current)) {
    return mode === 'SHADOW' || await finishServiceJob() ? { state: 'CLOSED' } : { state: 'RETRY_STORE' };
  }
  async function paid() {
    const booking = await provider.readBooking(current);
    if (booking?.id !== current.bookingId || ![booking.clientId, booking.client?.id].some(v => v === current.actorClientId)
      || [booking.clientId, booking.client?.id].some(v => v != null && v !== current.actorClientId)
      || ![booking.exerciseId, booking.__lk1ScopedExerciseId].some(v => v === current.exerciseId)
      || booking.isCancelled !== false || booking.cancelled === true || current.state !== 'CONFIRMED'
      || current.lk1.paymentAttempt?.cancelIntentAt) return pending('PAYMENT_AFTER_CANCELLATION_REQUIRES_REVIEW');
    if (mode === 'SHADOW') return { state: 'PAID' };
    // PAID must fence any cancellation before releasing the shared return lock.
    // Keep the resource marker until completion so a restart can finish it.
    if (current.lk1.paymentAttempt?.phase !== 'PAID'
      && !await save({ 'lk1.paymentAttempt': { ...current.lk1.paymentAttempt, phase: 'PAID', verifiedAt: now() } })) {
      return { state: 'RETRY_STORE' };
    }
    return await finishServiceJob() ? { state: 'PAID' } : { state: 'RETRY_STORE' };
  }
  let tx = await transaction();
  if (tx === 'PAID') return paid();
  if (tx === 'STOPPED') return { state: 'STOPPED' };
  if (current.lk1.paymentAttempt?.phase === 'PAID') return pending('PAID_EVIDENCE_CHANGED');
  if (!['OPEN', 'CLOSED'].includes(tx)) return pending('TRANSACTION_UNVERIFIED');
  const deadline = paymentAttemptDeadline(current.lk1.checkout, current.lk1.transactionAttemptedAt);
  if (tx === 'OPEN' && Date.parse(now()) < deadline) return { state: 'PAYMENT_REQUIRED' };
  if (mode === 'SHADOW') return { state: 'WOULD_CLOSE' };
  if (tx === 'OPEN') {
    if (current.lk1.paymentAttempt?.expireIntentAt) return pending('EXPIRE_OUTCOME_UNKNOWN');
    const at = now();
    if (!await save({ 'lk1.paymentAttempt': { phase: 'EXPIRE_INTENT', expireIntentAt: at,
      expiresAt: new Date(deadline).toISOString(), binding: paymentAttemptBinding(current) } })) return { state: 'RETRY_STORE' };
    if (shouldStop()) return { state: 'STOPPED_AFTER_INTENT' };
    // Check once more after our durable intent: a boundary payment wins.
    tx = await transaction();
    if (tx === 'PAID') return paid();
    if (tx === 'OPEN') {
      if (shouldStop()) return { state: 'STOPPED_AFTER_INTENT' };
      try { await provider.expireTransaction(current, shouldStop); } catch { /* exact GET below */ }
      tx = await transaction();
    }
    if (tx === 'PAID') return paid();
    if (tx !== 'CLOSED') return pending('EXPIRE_OUTCOME_UNKNOWN');
  }
  let booking = await provider.readBooking(current);
  if (shouldStop()) return { state: 'STOPPED' };
  let bookingState = paymentAttemptBooking(current, booking);
  if (!['ACTIVE', 'CANCELLED'].includes(bookingState)) return pending('BOOKING_UNVERIFIED');
  const nativeVisit = current.lk1.decision.subscriptionVisitCount === 1 && !current.lk1.visitJob;
  if (nativeVisit && current.lk1.paymentAttempt?.resourceJobKey && !await serviceLock()) return pending('SUBSCRIPTION_RETURN_BUSY');
  if (bookingState === 'ACTIVE') {
    if (current.lk1.paymentAttempt?.cancelIntentAt) return pending('CANCEL_OUTCOME_UNKNOWN');
    if (Date.parse(current.lk1.target.startsAt) <= Date.parse(now())) return pending('SERVICE_STARTED');
    const refundMethod = nativeVisit ? 'SERVICE' : 'NONE';
    const cancelOptions = await provider.readCancelOptions(current);
    const option = nativeVisit ? cancelOptions?.cancellationOptions?.subscription : cancelOptions?.cancellationOptions?.cancellationOnly;
    if ((cancelOptions?.bookingId != null && cancelOptions.bookingId !== current.bookingId) || option?.available !== true) {
      return pending('CANCEL_METHOD_UNAVAILABLE');
    }
    let baseline = null;
    if (nativeVisit) {
      if (!await serviceLock()) return pending('SUBSCRIPTION_RETURN_BUSY');
      baseline = lk1FreeSubscription(await provider.readSubscriptions(current),
        { actorClientId: current.actorClientId, bookingId: current.bookingId,
          clientSubscriptionId: current.clientSubscriptionId }, current.lk1.rule.productId);
      if (!baseline?.targetPresent) return pending('VISIT_BASELINE_UNVERIFIED');
    }
    if (!await save({ 'lk1.paymentAttempt': { ...current.lk1.paymentAttempt,
      phase: 'CANCEL_INTENT', cancelIntentAt: now(), refundMethod, baseline,
      ...(nativeVisit ? { resourceJobKey, resourceJobCompleted: false } : {}),
      binding: paymentAttemptBinding(current) } })) return { state: 'RETRY_STORE' };
    if (await transaction() !== 'CLOSED') return pending('TRANSACTION_CHANGED_BEFORE_CANCEL');
    const freshBooking = await provider.readBooking(current);
    bookingState = paymentAttemptBooking(current, freshBooking);
    if (bookingState === 'ACTIVE') {
      if (shouldStop()) return { state: 'STOPPED_AFTER_INTENT' };
      try { await provider.cancelBooking(current, shouldStop, refundMethod); } catch { /* never repeat PUT */ }
    } else if (bookingState !== 'CANCELLED') return pending('BOOKING_CHANGED_BEFORE_CANCEL');
    booking = await provider.readBooking(current);
    bookingState = paymentAttemptBooking(current, booking);
  }
  if (bookingState !== 'CANCELLED') return pending('CANCEL_OUTCOME_UNKNOWN');
  if (await transaction() !== 'CLOSED') return pending('TRANSACTION_CHANGED_AFTER_CANCEL');
  let creditProof = null;
  if (current.lk1.decision.subscriptionVisitCount === 1) {
    if (current.lk1.visitJob) {
      // The existing visit journal owns the limit delta and its lock. Keep the
      // operation CONFIRMED until that worker finishes; do not issue SERVICE.
      const fresh = await operations.findOne({ _id: current._id });
      if (!fresh || !eligiblePaymentAttempt(fresh)) return pending('VISIT_OPERATION_CHANGED');
      current = fresh;
      let returned = false; try { returned = visitAllowanceRelease(current.lk1.visitJob); } catch { /* invalid journal */ }
      if (!returned) return pending('CREDIT_RETURN_PENDING');
      creditProof = { kind: 'VISIT_JOB', jobId: current.lk1.visitJob.id,
        revision: current.lk1.visitJob.revision, phase: current.lk1.visitJob.phase };
    } else {
      const baseline = current.lk1.paymentAttempt?.baseline;
      const after = lk1FreeSubscription(await provider.readSubscriptions(current),
        { actorClientId: current.actorClientId, bookingId: current.bookingId,
          clientSubscriptionId: current.clientSubscriptionId }, current.lk1.rule.productId);
      if (!baseline?.targetPresent || !after || after.targetPresent || after.left !== baseline.left + 1
        || after.total !== baseline.total || after.other !== baseline.other) return pending('CREDIT_RETURN_UNVERIFIED');
      creditProof = { kind: 'SERVICE', before: baseline, after };
    }
  }
  if (shouldStop()) return { state: 'STOPPED' };
  const at = now(), journal = { ...current.lk1.paymentAttempt, phase: 'CLOSED', closedAt: at };
  const proof = { schemaVersion: 1, binding: paymentAttemptBinding(current), verifiedAt: at,
    bookingState: 'CANCELLED', transactionState: 'UNPAID_CLOSED',
    creditState: creditProof ? 'RETURN_VERIFIED' : 'NOT_CONSUMED', creditProof };
  const fields = { state: 'RELEASED', 'lk1.paymentAttempt': journal, 'lk1.paymentAttemptRelease': proof,
    ...(current.state === 'RELEASED' ? {} : { releasedAt: at, releaseReason: 'PAYMENT_ATTEMPT_EXPIRED',
      releaseSource: 'PAYMENT_EXPIRY', releaseBookingId: current.bookingId, releaseOperationId: current.operationId }) };
  return await save(fields) && paymentAttemptReleased(current) && await finishServiceJob()
    ? { state: 'CLOSED' } : { state: 'RETRY_STORE' };
}
