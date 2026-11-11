// Native, zero-money subscription cancellation. The HTTP graph and recovery
// worker run this same state machine; only the winner of the durable intent CAS
// may issue SERVICE. Unknown dispatch is reconciled by reads, never repeated.
export const lk1FreeObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const lk1FreeText = v => typeof v === 'string' && v.trim() ? v.trim() : null;
export const lk1FreePending = Object.freeze(['QUEUED', 'CANCEL_INTENT', 'RETURN_PENDING']);
export const lk1FreeJobKey = (b, requestId) => `lk1-free-cancel-job:${JSON.stringify([b.tenantKey, b.actorClientId, b.bookingId, requestId])}`;
export const lk1FreeLockKey = b => `lk1-free-cancel-lock:${JSON.stringify([b.tenantKey, b.clientSubscriptionId.toLowerCase()])}`;
export function lk1FreeServiceDate(startsAt) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric',
      month: '2-digit', day: '2-digit' }).formatToParts(new Date(startsAt));
    const part = type => parts.find(p => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch { return null; }
}
export const lk1FreeNativeOperation = op => lk1FreeObject(op) && lk1FreeObject(op.lk1)
  && op._id === `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`
  && ['group_training', 'tournament', 'open_game'].includes(op.category)
  && op.lk1.decision?.eligible === true && op.lk1.decision.subscriptionVisitCount === 1
  && op.lk1.decision.benefit?.finalPriceMinor === 0 && !op.lk1.visitJob
  && !op.transactionId && !op.visitJob
  && ['transactionAttemptedAt', 'transactionId', 'transactionIntent', 'checkout']
    .every(key => op.lk1[key] === undefined)
  && !op.managedEntitlementOperationId && !op.managedJoinV2 && !op.lk2LegacyJoin
  && op.lk1.target?.eventId === op.exerciseId && !!lk1FreeText(op.lk1.fingerprint)
  && op.lk1.target.category === ({ group_training: 'GROUP_TRAINING', tournament: 'TOURNAMENT', open_game: 'GAME' })[op.category]
  && op.serviceDate === lk1FreeServiceDate(op.lk1.target.startsAt)
  && !!lk1FreeText(op.lk1.rule?.productId)
  && [op.tenantKey, op.actorClientId, op.operationId, op.bookingId, op.exerciseId,
    op.clientSubscriptionId, op.serviceDate, op.updatedAt].every(v => !!lk1FreeText(v))
  && (!op.upstreamBookingId || op.upstreamBookingId === op.bookingId);
export const lk1FreeBinding = op => ({ tenantKey: op.tenantKey, actorClientId: op.actorClientId,
  clientSubscriptionId: op.clientSubscriptionId, bookingId: op.bookingId, exerciseId: op.exerciseId,
  operationKey: op._id, operationId: op.operationId, serviceDate: op.serviceDate,
  fingerprint: op.lk1.fingerprint });
export const lk1FreeSame = (a, b) => lk1FreeObject(a) && lk1FreeObject(b)
  && Object.keys(a).sort().join(',') === Object.keys(b).sort().join(',')
  && Object.keys(a).every(k => a[k] === b[k]);
export function lk1FreeBooking(value, b) {
  if (!lk1FreeObject(value)) return null;
  const present = a => a.filter(v => v !== undefined && v !== null && v !== '');
  const agrees = (a, expected) => present(a).length > 0
    && present(a).every(v => typeof v === 'string' && v === expected);
  if (!agrees([value.id, value.bookingId], b.bookingId)
    || !agrees([value.clientId, value.client?.id, value.client?.clientId], b.actorClientId)
    || !agrees([value.exerciseId, value.exercise?.id, value.__lk1ScopedExerciseId], b.exerciseId)
    || !agrees([value.clientSubscriptionId, value.clientSubscription?.id], b.clientSubscriptionId)
    || value.paymentType !== 'SUBSCRIPTION'
    || (value.paymentMethod != null && value.paymentMethod !== 'SUBSCRIPTION')) return null;
  const flags = present([value.isCancelled, value.cancelled, value.canceled]);
  const statuses = present([value.status, value.bookingStatus, value.state]);
  if (!flags.length || flags.some(v => typeof v !== 'boolean') || new Set(flags).size !== 1
    || statuses.some(v => !['ACTIVE', 'BOOKED', 'CONFIRMED', 'CANCELLED', 'CANCELED'].includes(v))) return null;
  const cancelled = flags[0];
  if (statuses.some(v => ['CANCELLED', 'CANCELED'].includes(v) !== cancelled)) return null;
  return { cancelled };
}
export function lk1FreeSubscription(payload, b, productId) {
  const rows = Array.isArray(payload) ? payload : payload?.content;
  if (!Array.isArray(rows) || rows.length >= 200 || (!Array.isArray(payload)
    && (payload.last !== true || (payload.totalElements !== undefined && payload.totalElements !== rows.length)))) return null;
  const matches = rows.filter(r => r?.subscriptionId === b.clientSubscriptionId);
  if (matches.length !== 1) return null;
  const row = matches[0], total = row.visitsTotal, left = row.visitsLeft;
  if (row.product?.id !== productId || !Number.isSafeInteger(total) || !Number.isSafeInteger(left)
    || total < 1 || left < 0 || left > total || !Array.isArray(row.bookings)
    || row.bookings.length !== total - left || row.bookings.length > 1000) return null;
  const consumptions = [];
  for (const item of row.bookings) {
    const id = lk1FreeText(item?.id || item?.bookingId);
    if (!id || (item.id && item.bookingId && item.id !== item.bookingId)
      || (item.clientSubscriptionId && item.clientSubscriptionId !== b.clientSubscriptionId)
      || (item.client?.id && item.client.id !== b.actorClientId)
      || (item.paymentType && item.paymentType !== 'SUBSCRIPTION')) return null;
    consumptions.push([id, lk1FreeText(item.exerciseId || item.exercise?.id) || '']);
  }
  if (new Set(consumptions.map(x => x[0])).size !== consumptions.length) return null;
  consumptions.sort((a, z) => a[0].localeCompare(z[0]));
  return { total, left, targetPresent: consumptions.some(x => x[0] === b.bookingId),
    other: JSON.stringify(consumptions.filter(x => x[0] !== b.bookingId)) };
}
export function lk1FreeReturnedOperation(op) {
  if (!lk1FreeNativeOperation(op) || op.state !== 'RELEASED'
    || op.releaseReason !== 'LK1_FREE_VISIT_RETURN_VERIFIED') return false;
  const p = op.lk1.freeCancellationReturn;
  return p?.schemaVersion === 1 && p.method === 'SERVICE' && p.count === 1
    && lk1FreeSame(p.binding, lk1FreeBinding(op)) && !!lk1FreeText(p.requestId)
    && p.jobKey === lk1FreeJobKey(p.binding, p.requestId)
    && p.verifiedAt === op.releasedAt && Number.isFinite(Date.parse(p.verifiedAt))
    && p.before?.targetPresent === true && p.after?.targetPresent === false
    && Number.isSafeInteger(p.before.left) && p.after.left === p.before.left + 1
    && p.before.total === p.after.total && p.before.other === p.after.other
    && op.releaseBookingId === op.bookingId && op.releasedBookingIds?.includes(op.bookingId);
}
export function lk1FreeBegin({ tenantKey, actorClientId, bookingId, requestId = null, verifyOnly = false, job = null }) {
  const s = { tenantKey, actorClientId, bookingId, requestId: job?.requestId || requestId,
    verifyOnly, stage: job ? 'operation' : 'booking', job, accepted: false };
  if (job) { s.binding = job.binding; return { state: s, effect: { kind: 'find', query: { _id: job.binding.operationKey } } }; }
  return { state: s, effect: { kind: 'http', method: 'GET', path: `/api/v1/clients/${encodeURIComponent(actorClientId)}/bookings/${encodeURIComponent(bookingId)}` } };
}
export function lk1FreeStep(s, input, at = new Date().toISOString()) {
  const reply = (status, state, code) => ({ kind: 'reply', status, payload: { ok: status < 400,
    state, accepted: s.accepted === true, bookingId: s.bookingId, operationId: s.binding?.operationId || '', ...(code ? { details: { code } } : {}),
    message: state === 'RELEASED' ? 'Посещение возвращено, запись отменена.'
      : state === 'DECLINED' ? 'Отмена не выполнена. Дождитесь завершения текущей записи или проверьте доступный способ возврата.'
      : state === 'NOT_MANAGED' ? 'Другой контур записи.'
        : s.accepted ? 'Отмена и возврат посещения проверяются автоматически.'
          : 'Не удалось подтвердить приём отмены. Запись требует повторной проверки.' } });
  const pending = code => s.accepted ? reply(202, 'PENDING_CONFIRMATION', code) : reply(503, 'UNVERIFIED', code);
  const get = (stage, path) => { s.stage = stage; return { kind: 'http', method: 'GET', path }; };
  const find = (stage, query) => { s.stage = stage; return { kind: 'find', query }; };
  const update = (stage, query, change, options = {}) => { s.stage = stage; return { kind: 'update', query,
    change, options: { ...options, writeConcern: { w: 'majority', j: true } } }; };
  const ack = v => v?.acknowledged === true && v.matchedCount === 1 && v.modifiedCount === 1;
  const jobQuery = () => ({ _id: s.job._id, phase: s.job.phase, updatedAt: s.job.updatedAt, binding: s.job.binding });
  const jobRead = () => {
    s.jobLookupKey = s.job?._id || (s.requestId ? lk1FreeJobKey(s.binding, s.requestId)
      : s.op?.lk1.freeCancellationReturn?.jobKey);
    return s.jobLookupKey ? find('job', { _id: s.jobLookupKey }) : pending('LK1_FREE_CANCEL_BASELINE_MISSING');
  };
  const subscriptions = stage => get(stage, `/api/v1/clients/${encodeURIComponent(s.actorClientId)}/subscriptions?includeFinished=true&size=200&page=0`);
  const booking = stage => {
    s.bookingPage = { next: stage, page: 0, count: 0, matches: [] };
    return get('booking_page', `/api/v1/exercises/${encodeURIComponent(s.binding.exerciseId)}/bookings?showCancelled=true&size=200&page=0`);
  };
  const finalizeJob = () => update('done_ack', jobQuery(), { $set: { phase: 'DONE', updatedAt: at, completedAt: at } });
  const decline = code => { s.declineCode = code; return update('declined_ack', jobQuery(), { $set: { phase: 'DECLINED', updatedAt: at, reason: code } }); };
  if (input.error || (input.status !== undefined && (input.status < 200 || input.status >= 300))) return pending('LK1_FREE_CANCEL_READ_UNAVAILABLE');
  const v = input.payload;
  if (s.stage === 'booking_page') {
    const p = s.bookingPage, rows = Array.isArray(v) ? v : v?.content;
    const last = Array.isArray(v) ? rows.length < 200 : v?.last;
    if (!p || !Array.isArray(rows) || rows.length > 200 || typeof last !== 'boolean'
      || (!last && rows.length !== 200)) return pending('LK1_FREE_CANCEL_BOOKING_PAGE_INVALID');
    p.count += rows.length;
    p.matches.push(...rows.filter(row => row?.id === s.bookingId || row?.bookingId === s.bookingId));
    if (!last) {
      if (++p.page >= 10) return pending('LK1_FREE_CANCEL_BOOKING_PAGE_LIMIT');
      return get('booking_page', `/api/v1/exercises/${encodeURIComponent(s.binding.exerciseId)}/bookings?showCancelled=true&size=200&page=${p.page}`);
    }
    if (v.totalElements !== undefined && v.totalElements !== p.count || p.matches.length !== 1) return pending('LK1_FREE_CANCEL_BOOKING_NOT_UNIQUE');
    s.stage = p.next;
    return lk1FreeStep(s, { payload: { ...p.matches[0], __lk1ScopedExerciseId: s.binding.exerciseId } }, at);
  }
  if (s.stage === 'booking') {
    if (!lk1FreeObject(v) || ![v.id, v.bookingId].filter(Boolean).length
      || [v.id, v.bookingId].filter(Boolean).some(id => id !== s.bookingId)
      || ![v.clientId, v.client?.id, v.client?.clientId].filter(Boolean).length
      || [v.clientId, v.client?.id, v.client?.clientId].filter(Boolean).some(id => id !== s.actorClientId)) return reply(409, 'UNVERIFIED', 'LK1_FREE_CANCEL_OWNER_UNVERIFIED');
    if (v.paymentType !== 'SUBSCRIPTION') return ['ON_PLACE', 'ONE_TIME', 'CLIENT_ONE_TIME'].includes(v.paymentType)
      ? reply(200, 'NOT_MANAGED') : pending('LK1_FREE_CANCEL_PAYMENT_TYPE_UNVERIFIED');
    s.bookingRow = v;
    return find('operation', { tenantKey: s.tenantKey, actorClientId: s.actorClientId,
      $or: [{ bookingId: s.bookingId }, { upstreamBookingId: s.bookingId }] });
  }
  if (s.stage === 'operation') {
    if (!Array.isArray(v) || v.length > 1) return pending('LK1_FREE_CANCEL_OPERATION_AMBIGUOUS');
    if (!v.length) return s.job || s.verifyOnly ? pending('LK1_FREE_CANCEL_OPERATION_MISSING') : reply(200, 'NOT_MANAGED');
    const op = v[0];
    if (!lk1FreeNativeOperation(op)) {
      if (!s.job && !s.verifyOnly && (!op.lk1 && !op.managedEntitlementOperationId
        || op.lk1?.decision?.subscriptionVisitCount === 0 || op.lk1?.decision?.benefit?.finalPriceMinor > 0)) return reply(200, 'NOT_MANAGED');
      return pending('LK1_FREE_CANCEL_OPERATION_UNSUPPORTED');
    }
    if (op.tenantKey !== s.tenantKey || op.actorClientId !== s.actorClientId || op.bookingId !== s.bookingId
      || (s.binding && !lk1FreeSame(s.binding, lk1FreeBinding(op)))) return pending('LK1_FREE_CANCEL_BINDING_CHANGED');
    s.op = op; s.binding = lk1FreeBinding(op);
    if (s.job && (s.job.kind !== 'LK1_FREE_CANCEL_JOB_V1' || !lk1FreeText(s.job.requestId)
      || s.job._id !== lk1FreeJobKey(s.binding, s.job.requestId)
      || !lk1FreeSame(s.job.binding, s.binding))) return pending('LK1_FREE_CANCEL_JOB_INVALID');
    if (lk1FreeReturnedOperation(op)) return jobRead();
    if (op.state !== 'CONFIRMED') return pending('LK1_FREE_CANCEL_OPERATION_NOT_CONFIRMED');
    return jobRead();
  }
  if (s.stage === 'job') {
    if (!Array.isArray(v) || v.length > 1) return pending('LK1_FREE_CANCEL_JOB_READ_INVALID');
    if (!v.length) {
      if (lk1FreeReturnedOperation(s.op) && s.jobLookupKey !== s.op.lk1.freeCancellationReturn.jobKey) {
        s.jobLookupKey = s.op.lk1.freeCancellationReturn.jobKey;
        return find('job', { _id: s.jobLookupKey });
      }
      if (s.verifyOnly || s.job) return pending('LK1_FREE_CANCEL_BASELINE_MISSING');
      if (!lk1FreeText(s.requestId) || !/^[A-Za-z0-9._:-]{8,200}$/.test(s.requestId)) return pending('LK1_FREE_CANCEL_REQUEST_ID_INVALID');
      return find('prior_job', { kind: 'LK1_FREE_CANCEL_JOB_V1', tenantKey: s.tenantKey,
        'binding.actorClientId': s.actorClientId, 'binding.bookingId': s.bookingId, phase: { $in: lk1FreePending } });
    }
    const job = v[0];
    if (job.kind !== 'LK1_FREE_CANCEL_JOB_V1' || job.method !== 'SERVICE' || !lk1FreeSame(job.binding, s.binding)
      || !lk1FreeText(job.requestId) || job._id !== lk1FreeJobKey(s.binding, job.requestId)) return pending('LK1_FREE_CANCEL_JOB_BINDING_INVALID');
    s.job = job;
    // A local find after a lost insert ACK is not a durability receipt. This
    // majority+j write is an ordered barrier before promising background work.
    return update('job_durable_ack', jobQuery(), { $inc: { durableReadbacks: 1 } });
  }
  if (s.stage === 'prior_job') {
    if (!Array.isArray(v) || v.length > 1000) return pending('LK1_FREE_CANCEL_JOB_READ_INVALID');
    const dispatched = v.filter(job => job.phase !== 'QUEUED');
    if (dispatched.length > 1) return pending('LK1_FREE_CANCEL_JOB_AMBIGUOUS');
    const prior = dispatched[0] || v.sort((a, b) => a._id.localeCompare(b._id))[0];
    if (prior) { s.jobLookupKey = prior._id; return find('job', { _id: prior._id }); }
    return booking('queue_active');
  }
  if (s.stage === 'job_durable_ack') {
    if (!ack(v)) return pending('LK1_FREE_CANCEL_DURABILITY_UNVERIFIED');
    s.accepted = true;
    const job = s.job;
    if (lk1FreeReturnedOperation(s.op)) return job.phase === 'DONE' ? reply(200, 'RELEASED') : finalizeJob();
    if (job.phase === 'DECLINED') return reply(409, 'DECLINED', job.reason);
    if (job.phase === 'DONE') return pending('LK1_FREE_CANCEL_RELEASE_READBACK_REQUIRED');
    if (!lk1FreePending.includes(job.phase)) return pending('LK1_FREE_CANCEL_JOB_STATE_INVALID');
    if (job.phase !== 'QUEUED') return booking('cancelled_booking');
    return update('lock_upsert', { _id: lk1FreeLockKey(s.binding) }, { $setOnInsert: {
      kind: 'LK1_FREE_CANCEL_LOCK_V1', tenantKey: s.tenantKey, ownerJobKey: job._id } }, { upsert: true });
  }
  if (s.stage === 'queue_active') {
    if (lk1FreeBooking(v, s.binding)?.cancelled !== false) return pending('LK1_FREE_CANCEL_BASELINE_MISSING');
    const job = { _id: lk1FreeJobKey(s.binding, s.requestId), requestId: s.requestId,
      kind: 'LK1_FREE_CANCEL_JOB_V1', tenantKey: s.tenantKey,
      clientSubscriptionId: s.binding.clientSubscriptionId.toLowerCase(), binding: s.binding,
      phase: 'QUEUED', method: 'SERVICE', createdAt: at, updatedAt: at };
    return update('enqueue_ack', { _id: job._id }, { $setOnInsert: job }, { upsert: true });
  }
  if (s.stage === 'enqueue_ack') return jobRead(); // Lost ACK never grants PUT authority.
  if (s.stage === 'lock_upsert') return find('lock', { _id: lk1FreeLockKey(s.binding) });
  if (s.stage === 'lock') {
    if (!Array.isArray(v) || v.length !== 1 || v[0].kind !== 'LK1_FREE_CANCEL_LOCK_V1') return pending('LK1_FREE_CANCEL_LOCK_INVALID');
    s.lock = v[0];
    if (s.lock.ownerJobKey === s.job._id) return find('pending_operations', { tenantKey: s.tenantKey,
      clientSubscriptionId: s.binding.clientSubscriptionId, 'lk1.decision.subscriptionVisitCount': 1 });
    return find('lock_owner', { _id: s.lock.ownerJobKey });
  }
  if (s.stage === 'lock_owner') {
    if (!Array.isArray(v) || v.length !== 1 || !['DONE', 'DECLINED'].includes(v[0].phase)
      || v[0]._id !== s.lock.ownerJobKey) return pending('LK1_FREE_CANCEL_OTHER_RETURN_PENDING');
    return update('lock_takeover', { _id: s.lock._id, ownerJobKey: s.lock.ownerJobKey }, { $set: { ownerJobKey: s.job._id } });
  }
  if (s.stage === 'lock_takeover') return ack(v) ? find('lock', { _id: s.lock._id }) : pending('LK1_FREE_CANCEL_LOCK_CHANGED');
  if (s.stage === 'pending_operations') {
    if (!Array.isArray(v) || v.length > 1000) return pending('LK1_FREE_CANCEL_LEDGER_INCOMPLETE');
    const unsafe = v.some(o => o._id !== s.op._id && (!['CONFIRMED', 'RELEASED', 'FAILED'].includes(o.state)
      || o.lk1?.visitJob && !['DEBIT_CONFIRMED', 'RETURN_CONFIRMED', 'DEBIT_REJECTED', 'CANCELLED_BEFORE_DEBIT'].includes(o.lk1.visitJob.phase)
      || o.state === 'FAILED' && o.upstreamAttemptedAt && !(o.failure?.statusCode >= 400 && o.failure.statusCode < 500)));
    if (unsafe) return decline('LK1_FREE_CANCEL_VISIT_IN_FLIGHT');
    return get('options', `/api/v1/clients/${encodeURIComponent(s.actorClientId)}/bookings/${encodeURIComponent(s.bookingId)}/cancel`);
  }
  if (s.stage === 'options') {
    if (v?.bookingId !== s.bookingId || v.cancellationOptions?.subscription?.available !== true) return decline('LK1_FREE_CANCEL_SERVICE_UNAVAILABLE');
    return booking('active_booking');
  }
  if (s.stage === 'active_booking') {
    if (lk1FreeBooking(v, s.binding)?.cancelled !== false) return decline('LK1_FREE_CANCEL_ACTIVE_BOOKING_UNVERIFIED');
    return subscriptions('baseline');
  }
  if (s.stage === 'baseline') {
    const snap = lk1FreeSubscription(v, s.binding, s.op.lk1.rule.productId);
    if (!snap || !snap.targetPresent) return decline('LK1_FREE_CANCEL_BASELINE_UNAVAILABLE');
    s.baseline = snap; s.intentAt = at;
    return update('intent_ack', jobQuery(), { $set: { phase: 'CANCEL_INTENT', updatedAt: at,
      dispatchAt: at, baseline: snap, optionsVerifiedAt: at } });
  }
  if (s.stage === 'intent_ack') {
    if (!ack(v)) return pending('LK1_FREE_CANCEL_INTENT_ACK_UNKNOWN');
    s.job = { ...s.job, phase: 'CANCEL_INTENT', updatedAt: s.intentAt,
      dispatchAt: s.intentAt, baseline: s.baseline };
    s.stage = 'dispatch_ack';
    return { kind: 'http', method: 'PUT', path: `/api/v1/clients/${encodeURIComponent(s.actorClientId)}/bookings/${encodeURIComponent(s.bookingId)}/cancel`,
      body: { refundMethod: 'SERVICE', cancelExercise: false } };
  }
  if (s.stage === 'dispatch_ack') return booking('cancelled_booking');
  if (s.stage === 'cancelled_booking') {
    if (lk1FreeBooking(v, s.binding)?.cancelled !== true) return pending('LK1_FREE_CANCEL_OUTCOME_PENDING');
    return subscriptions('returned_subscription');
  }
  if (s.stage === 'returned_subscription') {
    const after = lk1FreeSubscription(v, s.binding, s.op.lk1.rule.productId), before = s.job.baseline;
    if (!before || !after || !before.targetPresent || after.targetPresent || after.total !== before.total
      || after.left !== before.left + 1 || after.other !== before.other) return pending('LK1_FREE_CANCEL_RETURN_UNVERIFIED');
    const proof = { schemaVersion: 1, method: 'SERVICE', count: 1, jobKey: s.job._id, requestId: s.job.requestId,
      binding: s.binding, before, after, verifiedAt: at };
    s.proof = proof;
    return update('release_ack', { _id: s.op._id, state: 'CONFIRMED', updatedAt: s.op.updatedAt,
      bookingId: s.bookingId, clientSubscriptionId: s.binding.clientSubscriptionId, lk1: s.op.lk1 }, { $set: {
      state: 'RELEASED', releaseReason: 'LK1_FREE_VISIT_RETURN_VERIFIED', releasedAt: at, updatedAt: at,
      releaseBookingId: s.bookingId, 'lk1.freeCancellationReturn': proof }, $addToSet: { releasedBookingIds: s.bookingId } });
  }
  if (s.stage === 'release_ack') return find('release_readback', { _id: s.op._id });
  if (s.stage === 'release_readback') {
    if (!Array.isArray(v) || v.length !== 1 || !lk1FreeReturnedOperation(v[0])
      || !lk1FreeSame(v[0].lk1.freeCancellationReturn.binding, s.binding)) return pending('LK1_FREE_CANCEL_RELEASE_UNVERIFIED');
    return finalizeJob();
  }
  if (s.stage === 'done_ack') return ack(v) ? reply(200, 'RELEASED') : pending('LK1_FREE_CANCEL_JOB_ACK_UNKNOWN');
  if (s.stage === 'declined_ack') return ack(v) ? reply(409, 'DECLINED', s.declineCode) : pending('LK1_FREE_CANCEL_DECLINE_ACK_UNKNOWN');
  return pending('LK1_FREE_CANCEL_STAGE_INVALID');
}
