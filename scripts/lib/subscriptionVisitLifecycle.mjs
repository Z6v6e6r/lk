// Server-only local journal contract. This module performs no provider/network I/O.
// A provider adapter must prove an operation-linked outcome, not a balance delta.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 1000;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const dateKey = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && instant(`${value}T00:00:00Z`) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const phases = new Set(['DEBIT_PENDING', 'DEBIT_SENT', 'DEBIT_UNKNOWN', 'DEBIT_CONFIRMED',
  'DEBIT_REJECTED', 'RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED', 'CANCELLED_BEFORE_DEBIT']);
const bindingKeys = ['tenantKey', 'actorClientId', 'clientSubscriptionId', 'exerciseId', 'bookingId'];
function valid(job) {
  if (!object(job) || job.version !== 1 || !id(job.id) || !id(job.operationKey)
    || !id(job.operationId) || bindingKeys.some(key => !id(job[key]))
    || job.id !== `subscription-visit:${job.operationKey}`
    || !Number.isSafeInteger(job.revision) || job.revision < 0 || !phases.has(job.phase)
    || job.count !== 1 || !Number.isSafeInteger(job.freeMinutes) || job.freeMinutes < 1 || job.freeMinutes > 60
    || !dateKey(job.serviceDate)
    || !instant(job.createdAt) || !instant(job.updatedAt)) throw new Error('VISIT_JOB_INVALID');
  if (job.cancellation !== undefined && !validCancellation(job, job.cancellation)) throw new Error('VISIT_CANCEL_UNVERIFIED');
  if (job.debitReceipt !== undefined && !validReceipt(job, 'DEBIT', job.debitReceipt)) throw new Error('VISIT_RECEIPT_INVALID');
  if (job.returnReceipt !== undefined && !validReceipt(job, 'RETURN', job.returnReceipt)) throw new Error('VISIT_RECEIPT_INVALID');
  if (['DEBIT_SENT', 'DEBIT_UNKNOWN', 'DEBIT_CONFIRMED', 'DEBIT_REJECTED', 'RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED'].includes(job.phase)
    && !validAttempt(job, 'DEBIT')) throw new Error('VISIT_DEBIT_ATTEMPT_MISSING');
  if (['RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED'].includes(job.phase)
    && !validAttempt(job, 'RETURN')) throw new Error('VISIT_RETURN_ATTEMPT_MISSING');
  if (['DEBIT_CONFIRMED', 'RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED'].includes(job.phase)
    && job.debitReceipt?.outcome !== 'APPLIED') throw new Error('VISIT_DEBIT_RECEIPT_MISSING');
  if (['RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED', 'CANCELLED_BEFORE_DEBIT'].includes(job.phase)
    && !job.cancellation) throw new Error('VISIT_CANCEL_UNVERIFIED');
  if (job.phase === 'RETURN_CONFIRMED' && job.returnReceipt?.outcome !== 'APPLIED') throw new Error('VISIT_RETURN_RECEIPT_MISSING');
  if (job.phase === 'CANCELLED_BEFORE_DEBIT' && job.debitAttempt && job.debitReceipt?.outcome !== 'NOT_APPLIED') throw new Error('VISIT_DEBIT_OUTCOME_UNRESOLVED');
  if (job.phase === 'DEBIT_REJECTED' && job.debitReceipt?.outcome !== 'NOT_APPLIED') throw new Error('VISIT_DEBIT_OUTCOME_UNRESOLVED');
  if (job.debitReceipt?.outcome === 'APPLIED' && !['DEBIT_CONFIRMED', 'RETURN_PENDING', 'RETURN_SENT', 'RETURN_UNKNOWN', 'RETURN_CONFIRMED'].includes(job.phase)) throw new Error('VISIT_PHASE_RECEIPT_CONFLICT');
  if (job.debitReceipt?.outcome === 'NOT_APPLIED' && !['DEBIT_REJECTED', 'CANCELLED_BEFORE_DEBIT'].includes(job.phase)) throw new Error('VISIT_PHASE_RECEIPT_CONFLICT');
  if (job.returnReceipt !== undefined && (job.returnReceipt.outcome !== 'APPLIED' || job.phase !== 'RETURN_CONFIRMED')) throw new Error('VISIT_PHASE_RECEIPT_CONFLICT');
  if (job.cancellation && ['DEBIT_PENDING', 'DEBIT_CONFIRMED', 'DEBIT_REJECTED'].includes(job.phase)) throw new Error('VISIT_PHASE_CANCEL_CONFLICT');
  return job;
}
function changed(job, fields, now) {
  if (!instant(now) || Date.parse(now) < Date.parse(job.updatedAt) || job.revision >= Number.MAX_SAFE_INTEGER) throw new Error('VISIT_JOB_TIME_INVALID');
  return valid({ ...structuredClone(valid(job)), ...structuredClone(fields), revision: job.revision + 1, updatedAt: now });
}
function sameBinding(left, right) {
  return bindingKeys.every(key => left[key] === right[key]);
}
function attemptId(job, action) { return `${job.id}:${action.toLowerCase()}`; }
function validAttempt(job, action) {
  const attempt = job[`${action.toLowerCase()}Attempt`];
  return object(attempt) && attempt.id === attemptId(job, action) && id(attempt.adapterContractId) && instant(attempt.startedAt);
}
function validCancellation(job, value) {
  return object(value) && value.source === 'VIVA_BOOKING_READBACK' && id(value.operationId)
    && sameBinding(job, value) && value.bookingCancelled === true && instant(value.verifiedAt)
    && ['REQUEST_ACCEPTED', 'NOT_CHARGED'].includes(value.moneyRefundState);
}
function validReceipt(job, action, value) {
  const attempt = job[`${action.toLowerCase()}Attempt`];
  return object(value) && value.source === 'VIVA_OPERATION_READBACK' && sameBinding(job, value)
    && value.action === action && value.idempotencyKey === attemptId(job, action)
    && validAttempt(job, action) && value.adapterContractId === attempt.adapterContractId && id(value.providerOperationId)
    && instant(value.verifiedAt) && value.count === job.count && ['APPLIED', 'NOT_APPLIED', 'UNKNOWN'].includes(value.outcome)
    && (action !== 'RETURN' || value.reversesProviderOperationId === job.debitReceipt?.providerOperationId);
}
const receiptFields = ['source', ...bindingKeys, 'action', 'idempotencyKey', 'adapterContractId',
  'providerOperationId', 'count', 'outcome', 'verifiedAt', 'reversesProviderOperationId'];
const clean = (value, fields) => Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]));

export function createSubscriptionVisitJob(operation, now) {
  const decision = operation?.lk1?.decision;
  if (!object(operation) || operation.action !== 'JOIN_GAME' || operation.bookingPaymentType !== 'ON_PLACE' || operation.state !== 'CONFIRMED' || !id(operation._id)
    || !id(operation.operationId) || bindingKeys.some(key => !id(operation[key]))
    || operation.lk1?.target?.eventId !== operation.exerciseId
    || decision?.eligible !== true || operation.lk1?.target?.category !== 'GAME'
    || decision.subscriptionVisitCount !== 1 || !Number.isSafeInteger(decision.benefit?.finalPriceMinor)
    || decision.benefit.finalPriceMinor <= 0 || decision.gameMinutes?.localDate !== operation.serviceDate
    || !instant(now)) throw new Error('VISIT_JOB_BINDING_INVALID');
  const job = { version: 1, id: `subscription-visit:${operation._id}`, operationKey: operation._id,
    operationId: operation.operationId, ...Object.fromEntries(bindingKeys.map(key => [key, operation[key]])),
    serviceDate: operation.serviceDate, count: 1, freeMinutes: decision.gameMinutes.freeMinutes,
    revision: 0, phase: 'DEBIT_PENDING', createdAt: now, updatedAt: now };
  valid(job);
  if (operation.lk1.visitJob !== undefined) {
    const prior = valid(operation.lk1.visitJob);
    if (prior.id !== job.id || prior.operationId !== job.operationId || !sameBinding(prior, job)
      || prior.serviceDate !== job.serviceDate || prior.freeMinutes !== job.freeMinutes) throw new Error('VISIT_JOB_IDENTITY_CHANGED');
    return structuredClone(prior);
  }
  return job;
}

// Store job in the same operation update that confirms the exact provider booking.
// No separate enqueue can be lost between a booking ACK and a checkout response.
export function initialVisitJobUpdate(operation, now) {
  const job = createSubscriptionVisitJob(operation, now);
  if (operation.lk1.visitJob !== undefined) return null;
  return { query: { _id: operation._id, operationId: operation.operationId,
    state: 'PENDING_CONFIRMATION', upstreamBookingId: operation.bookingId, 'lk1.visitJob': { $exists: false } },
  update: { $set: { state: 'CONFIRMED', bookingId: operation.bookingId, confirmedAt: now,
    'lk1.visitJob': job, updatedAt: now } }, options: { writeConcern: { w: 'majority', j: true } } };
}

export function visitJobCas(before, after) {
  valid(before); valid(after);
  if (after.revision !== before.revision + 1 || before.id !== after.id
    || before.operationId !== after.operationId || before.operationKey !== after.operationKey
    || !sameBinding(before, after) || before.count !== after.count || before.freeMinutes !== after.freeMinutes
    || before.serviceDate !== after.serviceDate) throw new Error('VISIT_JOB_CAS_INVALID');
  return { query: { _id: before.operationKey, operationId: before.operationId,
    'lk1.visitJob.id': before.id, 'lk1.visitJob.revision': before.revision,
    'lk1.visitJob.phase': before.phase }, update: { $set: { 'lk1.visitJob': after } },
  options: { writeConcern: { w: 'majority', j: true } } };
}

export function pendingVisitTask(job) {
  valid(job);
  const action = { DEBIT_PENDING: 'DEBIT', DEBIT_SENT: 'VERIFY_DEBIT', DEBIT_UNKNOWN: 'VERIFY_DEBIT',
    RETURN_PENDING: 'RETURN', RETURN_SENT: 'VERIFY_RETURN', RETURN_UNKNOWN: 'VERIFY_RETURN' }[job.phase];
  if (!action) return null;
  const leg = action.endsWith('DEBIT') ? 'DEBIT' : 'RETURN';
  return { action, jobId: job.id, operationId: job.operationId, idempotencyKey: attemptId(job, leg),
    ...Object.fromEntries(bindingKeys.map(key => [key, job[key]])), count: job.count,
    ...(leg === 'RETURN' ? { reversesProviderOperationId: job.debitReceipt?.providerOperationId || null } : {}) };
}

// A confirmed adapter capability is a construction input, never a browser field.
// Callers cannot turn verification into another debit/return after a crash.
export function claimVisitMutation(job, adapter, now) {
  valid(job);
  if (!['DEBIT_PENDING', 'RETURN_PENDING'].includes(job.phase)) throw new Error('VISIT_JOB_VERIFY_ONLY');
  if (!object(adapter) || adapter.contractVerified !== true || !id(adapter.contractId)
    || adapter.operationLinkedReadback !== true || adapter.idempotencySupported !== true) throw new Error('VISIT_PROVIDER_CONTRACT_UNVERIFIED');
  const task = pendingVisitTask(job);
  if (task.action === 'RETURN' && !id(task.reversesProviderOperationId)) throw new Error('VISIT_DEBIT_RECEIPT_MISSING');
  const after = changed(job, { phase: task.action === 'DEBIT' ? 'DEBIT_SENT' : 'RETURN_SENT',
    [`${task.action.toLowerCase()}Attempt`]: { id: task.idempotencyKey, startedAt: now, adapterContractId: adapter.contractId } }, now);
  return { ...visitJobCas(job, after), task, after };
}

export function visitMutationAfterAck(claim, result) {
  if (!object(result) || result.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
    || (result.upsertedCount !== undefined && result.upsertedCount !== 0)
    || (result.upsertedId !== undefined && result.upsertedId !== null)) return null;
  return structuredClone(claim.task);
}

export function requestVisitReturn(job, cancellation, now) {
  valid(job);
  if (!validCancellation(job, cancellation)) throw new Error('VISIT_CANCEL_UNVERIFIED');
  if (job.cancellation) {
    if (!sameBinding(job.cancellation, cancellation)
      || job.cancellation.operationId !== cancellation.operationId) throw new Error('VISIT_CANCEL_IDENTITY_CHANGED');
    return structuredClone(job);
  }
  const phase = ['DEBIT_PENDING', 'DEBIT_REJECTED'].includes(job.phase) ? 'CANCELLED_BEFORE_DEBIT'
    : job.phase === 'DEBIT_CONFIRMED' ? 'RETURN_PENDING' : job.phase;
  return changed(job, { phase, cancellation: clean(cancellation, ['source', 'operationId', ...bindingKeys, 'bookingCancelled', 'verifiedAt', 'moneyRefundState']) }, now);
}

export function recordVisitOutcome(job, action, receipt, now) {
  valid(job);
  if (!['DEBIT', 'RETURN'].includes(action)) throw new Error('VISIT_ACTION_INVALID');
  const existing = job[`${action.toLowerCase()}Receipt`];
  if (existing) {
    if (!validReceipt(job, action, receipt) || receiptFields.filter(key => key !== 'verifiedAt').some(key => existing[key] !== receipt[key])) throw new Error('VISIT_RECEIPT_CONFLICT');
    return structuredClone(job);
  }
  if (!(action === 'DEBIT' ? ['DEBIT_SENT', 'DEBIT_UNKNOWN'] : ['RETURN_SENT', 'RETURN_UNKNOWN']).includes(job.phase)) {
    throw new Error('VISIT_RECEIPT_UNEXPECTED');
  }
  if (!validReceipt(job, action, receipt)) throw new Error('VISIT_RECEIPT_INVALID');
  if (receipt.outcome === 'UNKNOWN') return changed(job, { phase: action === 'DEBIT' ? 'DEBIT_UNKNOWN' : 'RETURN_UNKNOWN' }, now);
  if (receipt.outcome === 'NOT_APPLIED' && action === 'RETURN') {
    // Do not invent replay semantics after a failed return. Remain read-only until resolved.
    return changed(job, { phase: 'RETURN_UNKNOWN' }, now);
  }
  const phase = action === 'RETURN' ? 'RETURN_CONFIRMED' : receipt.outcome === 'NOT_APPLIED'
    ? (job.cancellation ? 'CANCELLED_BEFORE_DEBIT' : 'DEBIT_REJECTED')
    : (job.cancellation ? 'RETURN_PENDING' : 'DEBIT_CONFIRMED');
  return changed(job, { phase, [`${action.toLowerCase()}Receipt`]: clean(receipt, receiptFields) }, now);
}

export function visitAllowanceRelease(job) {
  valid(job);
  return Boolean(job.cancellation && ['CANCELLED_BEFORE_DEBIT', 'RETURN_CONFIRMED'].includes(job.phase));
}

export function releaseVisitAllowanceUpdate(job, now) {
  valid(job);
  if (!visitAllowanceRelease(job) || !instant(now)) throw new Error('VISIT_RETURN_NOT_CONFIRMED');
  return { query: { _id: job.operationKey, operationId: job.operationId, bookingId: job.bookingId,
    clientSubscriptionId: job.clientSubscriptionId, state: 'CONFIRMED',
    'lk1.visitJob.id': job.id, 'lk1.visitJob.revision': job.revision, 'lk1.visitJob.phase': job.phase },
  update: { $set: { state: 'RELEASED', releasedAt: now, releaseBookingId: job.bookingId,
    releaseSource: 'VISIT_RETURN_CONFIRMED', releaseOperationId: job.cancellation.operationId, updatedAt: now } },
  options: { writeConcern: { w: 'majority', j: true } } };
}
