// Server-only local journal contract. This module performs no provider/network I/O.
// Provider outcomes require either operation-linked readback or the exact direct PUT response.
// A later balance delta never proves authorship of a lost request.
const clone = value => JSON.parse(JSON.stringify(value));
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
  for (const action of ['DEBIT', 'RETURN']) {
    const attempt = job[`${action.toLowerCase()}Attempt`];
    if (attempt?.kind === 'DELTA_LIMIT_DIRECT_ACK') {
      if (!validAttempt(job, action) || attempt.adapterContractId !== limitContract) throw new Error('VISIT_LIMIT_ATTEMPT_INVALID');
      const snap = attempt.before;
      limitSnapshot(job, { ...snap, product: { id: snap?.productId } });
    }
  }
  if (job.returnPolicy !== undefined && (!object(job.returnPolicy) || job.returnPolicy.kind !== 'STAFF_NO_RETURN'
    || !id(job.returnPolicy.staffActorId) || job.returnPolicy.bookingId !== job.bookingId
    || !id(job.returnPolicy.operationId) || !instant(job.returnPolicy.verifiedAt))) throw new Error('VISIT_RETURN_POLICY_INVALID');
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
  return valid({ ...clone(valid(job)), ...clone(fields), revision: job.revision + 1, updatedAt: now });
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
    && ['REQUEST_ACCEPTED', 'NOT_CHARGED', 'NO_REFUND_REQUESTED', 'EXTERNAL_CANCELLATION'].includes(value.moneyRefundState);
}
function validReceipt(job, action, value) {
  const attempt = job[`${action.toLowerCase()}Attempt`];
  if (value?.source === 'VIVA_LIMIT_DIRECT_ACK') return validLimitReceipt(job, action, value);
  if (attempt?.kind === 'DELTA_LIMIT_DIRECT_ACK') return false;
  return object(value) && value.source === 'VIVA_OPERATION_READBACK' && sameBinding(job, value)
    && value.action === action && value.idempotencyKey === attemptId(job, action)
    && validAttempt(job, action) && value.adapterContractId === attempt.adapterContractId && id(value.providerOperationId)
    && instant(value.verifiedAt) && value.count === job.count && ['APPLIED', 'NOT_APPLIED', 'UNKNOWN'].includes(value.outcome)
    && (action !== 'RETURN' || value.reversesProviderOperationId === job.debitReceipt?.providerOperationId);
}
const receiptFields = ['source', ...bindingKeys, 'action', 'idempotencyKey', 'adapterContractId',
  'providerOperationId', 'count', 'outcome', 'verifiedAt', 'reversesProviderOperationId',
  'requestId', 'reversesRequestId', 'subscriptionId', 'productId', 'variant', 'visitsTotal', 'visitsLeft'];
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
    ...(operation.lk1.rule?.productId ? { productId: operation.lk1.rule.productId } : {}),
    serviceDate: operation.serviceDate, count: 1, freeMinutes: decision.gameMinutes.freeMinutes,
    revision: 0, phase: 'DEBIT_PENDING', createdAt: now, updatedAt: now };
  valid(job);
  if (operation.lk1.visitJob !== undefined) {
    const prior = valid(operation.lk1.visitJob);
    if (prior.id !== job.id || prior.operationId !== job.operationId || !sameBinding(prior, job)
      || prior.serviceDate !== job.serviceDate || prior.freeMinutes !== job.freeMinutes) throw new Error('VISIT_JOB_IDENTITY_CHANGED');
    return clone(prior);
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
    || before.serviceDate !== after.serviceDate || before.productId !== after.productId) throw new Error('VISIT_JOB_CAS_INVALID');
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
  if (action.startsWith('VERIFY_') && job[`${action.slice(7).toLowerCase()}Attempt`]?.kind === 'DELTA_LIMIT_DIRECT_ACK') {
    return { action: 'MANUAL_REVIEW', jobId: job.id, reason: 'VIVA_LIMIT_OUTCOME_UNKNOWN' };
  }
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
  return clone(claim.task);
}

export function requestVisitReturn(job, cancellation, now) {
  valid(job);
  if (job.returnPolicy?.kind === 'STAFF_NO_RETURN') throw new Error('VISIT_RETAINED_BY_STAFF');
  if (!validCancellation(job, cancellation)) throw new Error('VISIT_CANCEL_UNVERIFIED');
  if (job.cancellation) {
    if (!sameBinding(job.cancellation, cancellation)
      || job.cancellation.operationId !== cancellation.operationId) throw new Error('VISIT_CANCEL_IDENTITY_CHANGED');
    return clone(job);
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
    return clone(job);
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


const limitContract = 'viva-limit-delta-p2-v1';
function limitSnapshot(job, dto) {
  if (!object(dto) || dto.subscriptionId !== job.clientSubscriptionId
    || !id(job.productId) || dto.product?.id !== job.productId || dto.variant !== 'BY_VISITS'
    || !Number.isSafeInteger(dto.visitsTotal) || dto.visitsTotal < 0
    || !Number.isSafeInteger(dto.visitsLeft) || dto.visitsLeft < 0 || dto.visitsLeft > dto.visitsTotal) {
    throw new Error('VISIT_LIMIT_SNAPSHOT_INVALID');
  }
  return { subscriptionId: dto.subscriptionId, productId: dto.product.id,
    variant: dto.variant, visitsTotal: dto.visitsTotal, visitsLeft: dto.visitsLeft };
}
function validLimitReceipt(job, action, value) {
  const attempt = job[`${action.toLowerCase()}Attempt`];
  const delta = action === 'DEBIT' ? -1 : 1;
  return validAttempt(job, action) && attempt.kind === 'DELTA_LIMIT_DIRECT_ACK'
    && attempt.adapterContractId === limitContract && value.adapterContractId === limitContract
    && sameBinding(job, value) && value.action === action && value.outcome === 'APPLIED'
    && value.count === 1 && value.requestId === attempt.id && instant(value.verifiedAt)
    && value.subscriptionId === job.clientSubscriptionId && value.productId === job.productId
    && value.variant === 'BY_VISITS' && Number.isSafeInteger(value.visitsTotal)
    && Number.isSafeInteger(value.visitsLeft) && value.visitsLeft >= 0 && value.visitsLeft <= value.visitsTotal
    && value.visitsTotal === attempt.before?.visitsTotal + delta
    && value.visitsLeft === attempt.before?.visitsLeft + delta
    && (action !== 'RETURN' || value.reversesRequestId === job.debitReceipt?.requestId);
}

// Both signed deltas are observed in user-supplied P2 HARs. No automatic retry,
// provider idempotency claim or fabricated provider operation ID is involved.
export function claimVisitLimitMutation(job, dto, now) {
  valid(job);
  if (!['DEBIT_PENDING', 'RETURN_PENDING'].includes(job.phase)) throw new Error('VISIT_JOB_VERIFY_ONLY');
  const action = job.phase === 'DEBIT_PENDING' ? 'DEBIT' : 'RETURN';
  const before = limitSnapshot(job, dto);
  if (action === 'DEBIT' && (dto.status !== 'ACTIVE' || before.visitsLeft < 1)) throw new Error('VISIT_LIMIT_UNAVAILABLE');
  if (action === 'RETURN' && job.debitReceipt?.source !== 'VIVA_LIMIT_DIRECT_ACK') throw new Error('VISIT_LIMIT_DEBIT_UNBOUND');
  if (action === 'RETURN' && before.visitsTotal >= Number.MAX_SAFE_INTEGER) throw new Error('VISIT_LIMIT_OVERFLOW');
  const requestId = attemptId(job, action);
  const after = changed(job, { phase: `${action}_SENT`,
    [`${action.toLowerCase()}Attempt`]: { id: requestId, kind: 'DELTA_LIMIT_DIRECT_ACK',
      adapterContractId: limitContract, startedAt: now, before } }, now);
  return { ...visitJobCas(job, after), after, task: { action, requestId,
    method: 'PUT', path: `/api/v1/clients/${encodeURIComponent(job.actorClientId)}/subscriptions/${encodeURIComponent(job.clientSubscriptionId)}/limit`,
    body: { type: 'BY_VISITS', value: action === 'DEBIT' ? -1 : 1 } } };
}

export function recordVisitLimitResponse(job, action, requestId, status, dto, now) {
  valid(job);
  if (!['DEBIT', 'RETURN'].includes(action) || requestId !== job[`${action.toLowerCase()}Attempt`]?.id
    || status !== 200) throw new Error('VISIT_LIMIT_ACK_UNVERIFIED');
  const response = limitSnapshot(job, dto);
  return recordVisitOutcome(job, action, { source: 'VIVA_LIMIT_DIRECT_ACK',
    ...Object.fromEntries(bindingKeys.map(key => [key, job[key]])), ...response,
    action, requestId, adapterContractId: limitContract, count: 1, outcome: 'APPLIED', verifiedAt: now,
    ...(action === 'RETURN' ? { reversesRequestId: job.debitReceipt?.requestId } : {}) }, now);
}

export function markVisitLimitUnknown(job, action, now) {
  valid(job);
  if (!['DEBIT', 'RETURN'].includes(action) || job[`${action.toLowerCase()}Attempt`]?.kind !== 'DELTA_LIMIT_DIRECT_ACK'
    || ![`${action}_SENT`, `${action}_UNKNOWN`].includes(job.phase)) throw new Error('VISIT_LIMIT_ATTEMPT_INVALID');
  return changed(job, { phase: `${action}_UNKNOWN` }, now);
}


export function retainVisitByStaff(job, proof, now) {
  valid(job);
  if (job.cancellation || !object(proof) || proof.kind !== 'STAFF_NO_RETURN'
    || proof.bookingId !== job.bookingId || !id(proof.staffActorId) || !id(proof.operationId)
    || !instant(proof.verifiedAt)) throw new Error('VISIT_STAFF_RETENTION_UNVERIFIED');
  if (job.returnPolicy) {
    if (job.returnPolicy.operationId !== proof.operationId || job.returnPolicy.staffActorId !== proof.staffActorId) throw new Error('VISIT_RETURN_POLICY_CONFLICT');
    return clone(job);
  }
  return changed(job, { returnPolicy: clean(proof, ['kind','bookingId','staffActorId','operationId','verifiedAt']) }, now);
}
