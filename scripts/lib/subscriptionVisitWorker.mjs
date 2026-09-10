import { pendingVisitTask, claimVisitLimitMutation, visitMutationAfterAck, recordVisitLimitResponse,
  markVisitLimitUnknown, requestVisitReturn, visitJobCas, visitAllowanceRelease, releaseVisitAllowanceUpdate } from './subscriptionVisitLifecycle.mjs';

const options = { writeConcern: { w: 'majority', j: true } };
const matched = ack => ack?.acknowledged === true && ack.matchedCount === 1 && ack.modifiedCount === 1;
const lockId = job => `subscription-visit-lock:${JSON.stringify([job.tenantKey, job.actorClientId, job.clientSubscriptionId])}`;
const owner = (job, leg) => ({ _id: lockId(job), operationKey: job.operationKey, jobId: job.id, leg });
const validateOperation = (operation, operationKey) => {
  const job = operation?.lk1?.visitJob;
  if (!job || operation._id !== operationKey || job.operationKey !== operationKey
    || operation.action !== 'JOIN_GAME' || operation.bookingPaymentType !== 'ON_PLACE'
    || job.operationId !== operation.operationId
    || ['tenantKey', 'actorClientId', 'clientSubscriptionId', 'exerciseId', 'bookingId', 'serviceDate'].some(k => operation[k] !== job[k])
    || job.productId !== operation.lk1.rule?.productId) throw new Error('VISIT_OPERATION_BINDING_INVALID');
  pendingVisitTask(job);
  return job;
};
const nowDefault = () => new Date().toISOString();

// Never steals an expired lock: a process may have sent its non-idempotent PUT.
// Locks with unknown outcomes require operator reconciliation, not lease expiry.
export async function runSubscriptionVisitJob({ operationKey, operations, locks, provider, leaveOperations, now = nowDefault }) {
  let operation = await operations.findOne({ _id: operationKey });
  let job = operation?.lk1?.visitJob;
  if (!job || operation.state !== 'CONFIRMED') return { state: 'NOT_PENDING' };
  validateOperation(operation, operationKey);
  // A worker also discovers cancellations performed outside split_leave (cabinet,
  // organizer cleanup and unpaid expiry), using the exact provider booking.
  // Money refunds remain owned by the existing cancellation path.
  if (!job.cancellation && !job.returnPolicy && provider.readCancellation
    && ['DEBIT_PENDING', 'DEBIT_CONFIRMED'].includes(job.phase)) {
    let cancellation;
    try { cancellation = await provider.readCancellation(job); } catch { return { state: 'PRECHECK_REQUIRED' }; }
    if (cancellation) {
      // The durable staff command precedes its Viva cancellation. Consult it
      // after provider readback, closing the race before the post-cancel hook.
      if (!leaveOperations) return { state: 'PRECHECK_REQUIRED' };
      let retain;
      try { retain = await leaveOperations.findOne({ exerciseId: job.exerciseId, targetClientId: job.actorClientId,
        bookingIds: job.bookingId, mode: 'STAFF_TARGET', reason: 'CUP_STAFF_REMOVAL', requestedRefundMethod: 'NONE' }); }
      catch { return { state: 'PRECHECK_REQUIRED' }; }
      if (retain) return { state: 'VISIT_RETAINED_BY_STAFF' };
      const next = requestVisitReturn(job, cancellation, now());
      const command = visitJobCas(job, next); command.query.state = 'CONFIRMED';
      command.update.$set['lk1.visitNextCheckAt'] = now();
      if (!matched(await operations.updateOne(command.query, command.update, command.options))) return { state: 'RETRY_STORE' };
      job = next;
    }
  }
  const task = pendingVisitTask(job); // validates restored journal before any I/O
  if (task?.action === 'MANUAL_REVIEW') return { state: 'MANUAL_REVIEW', reason: task.reason };
  if (visitAllowanceRelease(job)) {
    const update = releaseVisitAllowanceUpdate(job, now());
    const ack = await operations.updateOne(update.query, update.update, update.options);
    if (!matched(ack)) return { state: 'RETRY_STORE' };
    await locks.deleteOne(owner(job, job.phase === 'RETURN_CONFIRMED' ? 'RETURN' : 'DEBIT'), options);
    return { state: 'RELEASED' };
  }
  if (!task || !['DEBIT', 'RETURN'].includes(task.action)) return { state: 'NOT_PENDING' };
  try { await locks.insertOne({ ...owner(job, task.action), tenantKey: job.tenantKey, createdAt: now() }, options); }
  catch (error) {
    if (error?.code !== 11000) throw error;
    const held = await locks.findOne({ _id: lockId(job) });
    if (held?.operationKey !== job.operationKey || held?.jobId !== job.id) return { state: 'BUSY' };
    if (held.leg !== task.action) {
      if (held.leg !== 'DEBIT' || task.action !== 'RETURN') return { state: 'BUSY' };
      const upgraded = await locks.updateOne(owner(job, 'DEBIT'), { $set: { leg: 'RETURN' } }, options);
      if (!matched(upgraded)) return { state: 'BUSY' };
    }
  }
  // Recheck after lock acquisition. Cancellation can win the same operation CAS.
  operation = await operations.findOne({ _id: operationKey });
  job = operation?.lk1?.visitJob;
  if (!job || operation.state !== 'CONFIRMED') return { state: 'RETRY_STORE' };
  validateOperation(operation, operationKey);
  if (pendingVisitTask(job)?.action !== task.action) return { state: 'RETRY_STORE' };
  let claim;
  try {
    const snapshot = await provider.read(job);
    claim = claimVisitLimitMutation(job, snapshot, now());
  } catch {
    // No PUT has been claimed here. Keep the owned lock to avoid deleting a
    // concurrent same-job worker's lock after it wins its own CAS.
    return { state: 'PRECHECK_REQUIRED' };
  }
  claim.query.state = 'CONFIRMED';
  const ack = await operations.updateOne(claim.query, claim.update, claim.options);
  const intent = visitMutationAfterAck(claim, ack);
  if (!intent) return { state: 'RETRY_STORE' };
  let response;
  try { response = await provider.adjust(intent); } catch { response = null; }
  // Retry only storing the exact in-memory response, NEVER the provider PUT.
  for (let retry = 0; retry < 3; retry += 1) {
    operation = await operations.findOne({ _id: operationKey });
    const current = operation?.lk1?.visitJob;
    if (!current || operation.state !== 'CONFIRMED') return { state: 'MANUAL_REVIEW' };
    validateOperation(operation, operationKey);
    let next;
    try { next = recordVisitLimitResponse(current, intent.action, intent.requestId, response?.status, response?.body, now()); }
    catch {
      try { next = markVisitLimitUnknown(current, intent.action, now()); }
      catch { return { state: 'MANUAL_REVIEW' }; }
    }
    if (next.revision === current.revision) return { state: current.phase }; // replayed persisted ACK
    const update = visitJobCas(current, next);
    update.query.state = 'CONFIRMED';
    const saved = await operations.updateOne(update.query, update.update, update.options);
    if (!matched(saved)) continue;
    if (next.phase.endsWith('_UNKNOWN')) return { state: 'MANUAL_REVIEW' };
    // The leg in the delete predicate cannot remove a lock already upgraded
    // by a return worker after this ACK, or a later booking's lock.
    await locks.deleteOne(owner(next, intent.action), options);
    return { state: next.phase };
  }
  return { state: 'MANUAL_REVIEW' };
}

function coherentBookingState(job, row) {
  const aliases = (values, expected, required = true) => {
    const supplied = values.filter(value => value !== undefined && value !== null);
    if ((required && !supplied.length) || supplied.some(value => value !== expected)) throw new Error('VISIT_BOOKING_IDENTITY_INVALID');
  };
  aliases([row.id,row.bookingId],job.bookingId);
  aliases([row.clientId,row.client?.id],job.actorClientId);
  aliases([row.exerciseId,row.exercise?.id],job.exerciseId,false);
  aliases([row.paymentType,row.paymentMethod],'ON_PLACE');
  const evidence=[];
  for (const key of ['isCancelled','cancelled','canceled']) if (row[key] !== undefined && row[key] !== null) {
    if (typeof row[key] !== 'boolean') throw new Error('VISIT_BOOKING_STATE_INVALID');
    evidence.push(row[key]);
  }
  if (row.status !== undefined && row.status !== null) {
    if (!['ACTIVE','CONFIRMED','BOOKED','CANCELLED','CANCELED'].includes(row.status)) throw new Error('VISIT_BOOKING_STATE_INVALID');
    evidence.push(['CANCELLED','CANCELED'].includes(row.status));
  }
  for (const key of ['cancellationDate','cancelledAt','canceledAt']) if (row[key] !== undefined && row[key] !== null && row[key] !== '') {
    if (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key]))) throw new Error('VISIT_BOOKING_STATE_INVALID');
    evidence.push(true);
  }
  if (!evidence.length || evidence.some(value => value !== evidence[0])) throw new Error('VISIT_BOOKING_STATE_INVALID');
  return evidence[0];
}
function completeBookingPage(body, items, page, count) {
  if (items.length > 200) throw new Error('VISIT_BOOKING_PAGE_INVALID');
  if (Array.isArray(body)) return items.length < 200;
  if ((body.number !== undefined && body.number !== page) || (body.size !== undefined && body.size !== 200)
    || (body.numberOfElements !== undefined && body.numberOfElements !== items.length)
    || (body.pageable?.pageNumber !== undefined && body.pageable.pageNumber !== page)
    || (body.pageable?.pageSize !== undefined && body.pageable.pageSize !== 200)) throw new Error('VISIT_BOOKING_PAGE_INVALID');
  const total=body.totalElements, pages=body.totalPages;
  if (total !== undefined && (!Number.isSafeInteger(total) || total < count)) throw new Error('VISIT_BOOKING_PAGE_INVALID');
  if (pages !== undefined && (!Number.isSafeInteger(pages) || pages < 0
    || (total !== undefined && pages !== Math.ceil(total/200)))) throw new Error('VISIT_BOOKING_PAGE_INVALID');
  const endings=[];
  if (total !== undefined) endings.push(total === count);
  if (pages !== undefined) endings.push(page+1 >= pages);
  if (body.last !== undefined) {
    if (typeof body.last !== 'boolean') throw new Error('VISIT_BOOKING_PAGE_INVALID');
    endings.push(body.last);
  }
  if (!endings.length || endings.some(value => value !== endings[0]) || (!endings[0] && items.length !== 200)) throw new Error('VISIT_BOOKING_PAGE_INVALID');
  return endings[0];
}

// Production transport is single-attempt: no redirects, retries, auth-refresh replay
// or provider idempotency headers. The caller owns the service credential lifecycle.
export function createVivaVisitProvider({ token, baseUrl = 'https://api.vivacrm.ru', fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = new URL(baseUrl);
  if (!(base.origin === 'https://api.vivacrm.ru'
    || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('VISIT_PROVIDER_ORIGIN_INVALID');
  async function request(method, path, body) {
    const credential = await token();
    if (typeof credential !== 'string' || !credential.trim() || /[\r\n]/.test(credential)) throw new Error('VISIT_TOKEN_UNAVAILABLE');
    const response = await fetchImpl(new URL(path, base), { method, redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    return { status: response.status, body: result };
  }
  return {
    async read(job) {
      const result = await request('GET', `/api/v1/clients/${encodeURIComponent(job.actorClientId)}/subscriptions/${encodeURIComponent(job.clientSubscriptionId)}`);
      if (result.status !== 200) throw new Error('VISIT_SNAPSHOT_UNAVAILABLE');
      return result.body;
    },
    async readCancellation(job) {
      const rows = [];
      for (let page = 0; page < 10; page += 1) {
        const response = await request('GET', `/api/v1/exercises/${encodeURIComponent(job.exerciseId)}/bookings?showCancelled=true&page=${page}&size=200`);
        const body = response.body;
        const items = Array.isArray(body) ? body : body?.content;
        if (response.status !== 200 || !Array.isArray(items)) throw new Error('VISIT_BOOKING_READ_UNAVAILABLE');
        rows.push(...items);
        const complete = completeBookingPage(body, items, page, rows.length);
        if (!complete) continue;
        const exact = rows.filter(row => row && (row.id === job.bookingId || row.bookingId === job.bookingId));
        if (exact.length !== 1) throw new Error('VISIT_BOOKING_READ_UNAVAILABLE');
        const row = exact[0];
        const cancelled = coherentBookingState(job, row);
        if (!cancelled) return null;
        return { source: 'VIVA_BOOKING_READBACK', operationId: `viva-cancel:${job.bookingId}`,
          ...Object.fromEntries(['tenantKey','actorClientId','clientSubscriptionId','exerciseId','bookingId'].map(k => [k,job[k]])),
          bookingCancelled: true, verifiedAt: new Date().toISOString(), moneyRefundState: 'EXTERNAL_CANCELLATION' };
      }
      throw new Error('VISIT_BOOKING_READ_INCOMPLETE');
    },
    async adjust(intent) {
      if (intent.method !== 'PUT' || !/^\/api\/v1\/clients\/[^/]+\/subscriptions\/[^/]+\/limit$/.test(intent.path)
        || intent.body?.type !== 'BY_VISITS' || ![-1, 1].includes(intent.body?.value)
        || Object.keys(intent.body).length !== 2) throw new Error('VISIT_INTENT_INVALID');
      return request('PUT', intent.path, intent.body);
    },
  };
}

export async function cleanupConfirmedVisitLocks({ operations, locks, tenantKey }) {
  for (const lock of await locks.find(tenantKey ? { tenantKey } : {}).limit(100).toArray()) {
    const operation = await operations.findOne({ _id: lock.operationKey });
    const job = operation?.lk1?.visitJob;
    if (!job || job.id !== lock.jobId || lock._id !== lockId(job)) continue;
    try { validateOperation(operation, lock.operationKey); } catch { continue; } // corrupt rows cannot unlock
    if ((lock.leg === 'DEBIT' && ['DEBIT_CONFIRMED', 'CANCELLED_BEFORE_DEBIT', 'RETURN_PENDING'].includes(job.phase))
      || (lock.leg === 'RETURN' && job.phase === 'RETURN_CONFIRMED')) {
      // RETURN_PENDING can acquire/upgrade this lock atomically; the old leg
      // predicate makes concurrent cleanup harmless if it already upgraded.
      await locks.deleteOne(owner(job, lock.leg), options);
    }
  }
}
