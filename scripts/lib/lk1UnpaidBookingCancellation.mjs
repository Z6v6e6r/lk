// LK1 money bookings are Viva ON_PLACE carriers, but only a durable LK1 SMS
// checkout can make one eligible for automatic unpaid cancellation.
const text = value => typeof value === 'string' ? value.trim() : '';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const same = (values, expected) => values.filter(value => value !== undefined && value !== null && value !== '')
  .every(value => text(record(value) ? value.id : value) === expected);
const iso = value => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, zone] = match;
  const calendar = new Date(Date.UTC(+year, +month - 1, +day));
  if (calendar.getUTCFullYear() !== +year || calendar.getUTCMonth() !== +month - 1
    || calendar.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59
    || (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
export const isValidLk1ZonedInstant = value => iso(value) !== null;
const nowIso = () => new Date().toISOString();
const writeOptions = { writeConcern: { w: 'majority', j: true } };

export function buildLk1UnpaidScanQuery({ tenantKey, cohortFrom, afterId = null }) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tenantKey || '') || iso(cohortFrom) === null) {
    throw new Error('COHORT_OR_TENANT_INVALID');
  }
  return { tenantKey, state: 'CONFIRMED', createdAt: { $gte: new Date(cohortFrom).toISOString() },
    category: { $in: ['group_training', 'tournament'] },
    'lk1.checkout.toPayMinor': { $gt: 0 },
    'lk1.decision.subscriptionVisitCount': 0,
    ...(afterId ? { _id: { $gt: afterId } } : {}),
    $or: [{ 'lk1.unpaidCancellation': { $exists: false } }, { 'lk1.unpaidCancellation.phase': 'INTENT' }],
  };
}

export function eligibleLk1UnpaidOperation(op, cohortFrom, now = nowIso(), allowStarted = false) {
  const cutoff = iso(cohortFrom), current = iso(now);
  if (cutoff === null || current === null) return { reason: 'CONFIG_INVALID' };
  if (!record(op) || op.state !== 'CONFIRMED' || !['group_training', 'tournament'].includes(op.category)) {
    return { reason: 'OUT_OF_SCOPE' };
  }
  // The live durable operation does not store an action. If an action alias is
  // present, it still has to agree with the category and target binding below.
  const expectedAction = op.category === 'group_training' ? 'BOOK_GROUP_TRAINING' : 'BOOK_TOURNAMENT';
  if ((op.action && op.action !== expectedAction)
    || (op.managedAction && op.managedAction !== expectedAction)) return { reason: 'OUT_OF_SCOPE' };
  if (iso(op.createdAt) === null || iso(op.createdAt) < cutoff) return { reason: 'BEFORE_COHORT' };
  const lk1 = op.lk1, intent = lk1?.transactionIntent, checkout = lk1?.checkout;
  if (!text(op.tenantKey) || !text(op.actorClientId) || !text(op.operationId)
    || op._id !== `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`
    || !text(op.bookingId) || !text(op.exerciseId) || !text(op.clientSubscriptionId)
    || (op.upstreamBookingId && op.upstreamBookingId !== op.bookingId)
    || !text(lk1?.fingerprint) || lk1?.target?.eventId !== op.exerciseId
    || lk1?.target?.category !== (op.category === 'group_training' ? 'GROUP_TRAINING' : 'TOURNAMENT')
    || iso(lk1?.target?.startsAt) === null || (!allowStarted && iso(lk1.target.startsAt) <= current)
    || lk1?.decision?.subscriptionVisitCount !== 0 || lk1?.decision?.benefit?.kind !== 'PERCENT_DISCOUNT'
    || lk1?.visitJob || !record(intent) || !record(checkout)
    || !text(lk1.transactionId) || checkout.transactionId !== lk1.transactionId
    || !text(lk1.transactionAttemptedAt) || !Number.isSafeInteger(checkout.toPayMinor)
    || checkout.toPayMinor <= 0 || checkout.toPayMinor !== intent.chargeMinor
    || checkout.toPayMinor !== lk1.decision.benefit.finalPriceMinor
    || intent.bookingId !== op.bookingId || intent.actorClientId !== op.actorClientId
    || intent.studioId !== lk1.target.stationId || !text(intent.productId)
    || !/^https:\/\//.test(text(checkout.paymentUrl))) return { reason: 'BINDING_INVALID' };
  return { reason: 'ELIGIBLE' };
}

function collectIds(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (record(value)) return ['id', 'uuid', 'bookingId', 'clientBookingId'].flatMap(key => collectIds(value[key]));
  return [text(value)];
}

export function classifyLk1Transaction(op, transaction, now = nowIso(), graceMs = 60_000) {
  if (!record(transaction)) return { reason: 'TRANSACTION_UNAVAILABLE' };
  const intent = op.lk1.transactionIntent, expectedId = op.lk1.checkout.transactionId;
  const ids = [transaction.id, transaction.transactionId].filter(value => value !== undefined);
  const amounts = [transaction.toPay, transaction.toPayMinor].filter(value => value !== undefined);
  const statuses = [transaction.status, transaction.state, transaction.paymentStatus, transaction.transactionStatus]
    .filter(value => value !== undefined && value !== null && value !== '').map(value => text(value).toUpperCase());
  const clientIds = [transaction.clientId, transaction.client?.id, transaction.client?.uuid].filter(value => value !== undefined);
  const exerciseIds = [transaction.exerciseId, transaction.exercise?.id].filter(value => value !== undefined);
  const bookingIds = [transaction.bookingId, transaction.bookingIds, transaction.paymentBookingIds,
    ...(Array.isArray(transaction.products) ? transaction.products.flatMap(product => [product.bookingId, product.bookingIds,
      product.paymentBookingIds, product.clientBookingId, ...(Array.isArray(product.pricingDetails)
        ? product.pricingDetails.flatMap(detail => [detail.bookingId, detail.clientBookingId]) : [])]) : [])]
    .flatMap(collectIds);
  if (!ids.length || !same(ids, expectedId) || !amounts.length
    || amounts.some(value => !Number.isSafeInteger(value) || value !== intent.chargeMinor)
    || statuses.length === 0 || new Set(statuses).size !== 1
    || !same(clientIds, op.actorClientId) || !same(bookingIds, op.bookingId)
    || !same(exerciseIds, op.exerciseId)
    || (transaction.currency !== undefined && transaction.currency !== 'RUB')
    || (transaction.products !== undefined && (!Array.isArray(transaction.products) || transaction.products.length !== 1
      || (transaction.products[0].id !== undefined && transaction.products[0].id !== intent.productId)
      || (transaction.products[0].discount !== undefined && transaction.products[0].discount !== intent.discountMinor)))) {
    return { reason: 'TRANSACTION_BINDING_INVALID' };
  }
  const status = statuses[0];
  if (status === 'PAID') return { reason: 'PAID' };
  if (status !== 'UNPAID') return { reason: 'TRANSACTION_NOT_UNPAID' };
  if ([transaction.paymentDate, transaction.paidAt, transaction.refundDate, transaction.refundedAt]
    .some(value => value !== undefined && value !== null && value !== '')) return { reason: 'PAYMENT_OR_REFUND_EVIDENCE' };
  const cardStatuses = [transaction.cardPaymentInfo?.status, transaction.cardPaymentStatus?.status]
    .filter(value => value !== undefined && value !== null && value !== '').map(value => text(value).toUpperCase());
  if (cardStatuses.some(value => !['NEW', 'UNPAID', 'EXPIRED'].includes(value))) {
    return { reason: 'PAYMENT_CARD_STATE_UNSAFE' };
  }
  for (const source of [transaction, transaction.cardPaymentInfo, transaction.cardPaymentStatus]) {
    if (!record(source)) continue;
    if ([source.paymentDate, source.paidAt, source.refundDate, source.refundedAt, source.refund]
      .some(value => value !== undefined && value !== null && value !== '')
      || [source.paidAmountMinor, source.paidAmount, source.refundedAmountMinor]
        .some(value => value !== undefined && value !== null && value !== 0)) {
      return { reason: 'PAYMENT_OR_REFUND_EVIDENCE' };
    }
  }
  const due = iso(transaction.paymentDueDate), current = iso(now);
  if (due === null || current === null || !Number.isSafeInteger(graceMs) || graceMs < 0) return { reason: 'DEADLINE_INVALID' };
  return current >= due + graceMs ? { reason: 'DUE', deadlineAt: transaction.paymentDueDate }
    : { reason: 'NOT_DUE' };
}

export function classifyLk1Booking(op, booking) {
  if (!record(booking)) return { reason: 'BOOKING_UNAVAILABLE' };
  const ids = [booking.id, booking.bookingId].filter(value => value !== undefined);
  const owners = [booking.clientId, booking.client?.id, booking.client?.clientId].filter(value => value !== undefined);
  const exercises = [booking.exerciseId, booking.exercise?.id].filter(value => value !== undefined);
  // Viva's exercise-scoped bookings list omits exerciseId on each row. The
  // adapter adds this proof only after finding one exact row in that list.
  const scopedExercise = booking.__lk1ScopedExerciseId;
  if (!ids.length || !same(ids, op.bookingId) || !owners.length || !same(owners, op.actorClientId)
    || (exercises.length ? !same(exercises, op.exerciseId) : scopedExercise !== op.exerciseId)
    || booking.isSubscriptionBooking === true || booking.clientSubscriptionId
    || (booking.paymentType !== 'ON_PLACE' && booking.paymentMethod !== 'ON_PLACE')
    || (booking.paymentType !== undefined && booking.paymentType !== 'ON_PLACE')
    || (booking.paymentMethod !== undefined && booking.paymentMethod !== 'ON_PLACE')) return { reason: 'BOOKING_BINDING_INVALID' };
  if ((booking.transactionStatus !== undefined && booking.transactionStatus !== null)
    || (booking.paymentStatus !== undefined && booking.paymentStatus !== null)
    || (booking.pendingPayments !== undefined && (!Array.isArray(booking.pendingPayments)
      || booking.pendingPayments.length !== 0))
    || booking.paid === true || booking.paymentDate || booking.paidAt) {
    return { reason: 'BOOKING_PAYMENT_STATE_UNSAFE' };
  }
  const flags = [booking.isCancelled, booking.cancelled, booking.canceled]
    .filter(value => value !== undefined && value !== null);
  if (flags.some(value => typeof value !== 'boolean')) return { reason: 'BOOKING_STATE_INVALID' };
  const statuses = [booking.status, booking.bookingStatus, booking.state]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(value => text(value).toUpperCase());
  if (statuses.some(value => !['ACTIVE', 'CONFIRMED', 'BOOKED', 'CANCELLED', 'CANCELED'].includes(value))) return { reason: 'BOOKING_STATE_INVALID' };
  const evidence = [...flags, ...statuses.map(value => ['CANCELLED', 'CANCELED'].includes(value))];
  for (const field of ['cancellationDate', 'cancelledAt', 'canceledAt']) {
    if (booking[field] !== undefined && booking[field] !== null && booking[field] !== '') {
      if (iso(booking[field]) === null) return { reason: 'BOOKING_STATE_INVALID' };
      evidence.push(true);
    }
  }
  if (!evidence.length || new Set(evidence).size !== 1) return { reason: 'BOOKING_STATE_INVALID' };
  return { reason: evidence[0] ? 'CANCELLED' : 'ACTIVE' };
}

const intentQuery = (op, attemptedAt) => ({ _id: op._id, state: 'CONFIRMED', bookingId: op.bookingId,
  'lk1.checkout.transactionId': op.lk1.checkout.transactionId,
  'lk1.unpaidCancellation.phase': 'INTENT', 'lk1.unpaidCancellation.attemptedAt': attemptedAt });
const matched = ack => ack?.acknowledged === true && ack.matchedCount === 1 && ack.modifiedCount === 1;

async function releaseConfirmed(op, operations, attemptedAt, now) {
  const at = now();
  const ack = await operations.updateOne(intentQuery(op, attemptedAt), { $set: {
    state: 'RELEASED', releaseReason: 'LK1_UNPAID_CHECKOUT_EXPIRED', releasedAt: at, updatedAt: at,
    'lk1.unpaidCancellation.phase': 'CANCELLED', 'lk1.unpaidCancellation.verifiedAt': at,
  } }, writeOptions);
  return { state: matched(ack) ? 'CANCELLED' : 'RETRY_STORE' };
}

async function markReview(op, operations, attemptedAt, reason, now) {
  const ack = await operations.updateOne(intentQuery(op, attemptedAt), { $set: {
    'lk1.unpaidCancellation.phase': 'REVIEW', 'lk1.unpaidCancellation.reason': reason,
    updatedAt: now(),
  } }, writeOptions);
  return { state: matched(ack) ? 'REVIEW' : 'RETRY_STORE', reason };
}

// One attempt per operation. The majority-committed INTENT precedes the Viva PUT.
// A crash or unknown PUT response is reconciled by exact readback, never a second PUT.
export async function reconcileLk1UnpaidBooking({ op, operations, provider, cohortFrom,
  mode = 'SHADOW', now = nowIso, shouldStop = () => false }) {
  if (!['SHADOW', 'ENFORCE_NEW'].includes(mode)) return { state: 'OFF' };
  if (shouldStop()) return { state: 'STOPPED' };
  const prior = op?.lk1?.unpaidCancellation;
  const eligible = eligibleLk1UnpaidOperation(op, cohortFrom, now(), prior?.phase === 'INTENT');
  if (eligible.reason !== 'ELIGIBLE') return { state: 'SKIPPED', reason: eligible.reason };
  if (prior && prior.phase !== 'INTENT') return { state: 'SKIPPED', reason: 'ALREADY_HANDLED' };
  if (prior && mode === 'SHADOW') return { state: 'SKIPPED', reason: 'INTENT_REQUIRES_ENFORCE_OR_REVIEW' };
  const tx = classifyLk1Transaction(op, await provider.readTransaction(op), now());
  if (prior) {
    if (tx.reason !== 'DUE') return markReview(op, operations, prior.attemptedAt, tx.reason, now);
    const booking = classifyLk1Booking(op, await provider.readBooking(op));
    if (booking.reason === 'CANCELLED') return releaseConfirmed(op, operations, prior.attemptedAt, now);
    if (booking.reason === 'ACTIVE') return markReview(op, operations, prior.attemptedAt, 'CANCEL_OUTCOME_UNKNOWN', now);
    return { state: 'PRECHECK_REQUIRED', reason: booking.reason };
  }
  if (tx.reason !== 'DUE') return { state: 'SKIPPED', reason: tx.reason };
  const booking = classifyLk1Booking(op, await provider.readBooking(op));
  if (booking.reason !== 'ACTIVE') return { state: 'SKIPPED', reason: booking.reason };
  const options = await provider.readCancelOptions(op);
  if ((options?.bookingId !== undefined && options.bookingId !== op.bookingId)
    || options?.cancellationOptions?.cancellationOnly?.available !== true) {
    return { state: 'SKIPPED', reason: 'CANCELLATION_ONLY_UNAVAILABLE' };
  }
  if (mode === 'SHADOW') return { state: 'ELIGIBLE' };
  if (shouldStop()) return { state: 'STOPPED' };
  const attemptedAt = now();
  const ack = await operations.updateOne({ _id: op._id, state: 'CONFIRMED', bookingId: op.bookingId,
    updatedAt: op.updatedAt, 'lk1.checkout.transactionId': op.lk1.checkout.transactionId,
    'lk1.unpaidCancellation': { $exists: false } }, { $set: {
    updatedAt: attemptedAt, 'lk1.unpaidCancellation': {
      phase: 'INTENT', attemptedAt, deadlineAt: tx.deadlineAt,
      transactionId: op.lk1.checkout.transactionId, bookingId: op.bookingId,
    },
  } }, writeOptions);
  if (!matched(ack)) return { state: 'RETRY_STORE' };
  // Re-read after the durable intent so a payment arriving during the first probe
  // prevents the provider write. Booking cancellation is a single-attempt command.
  const freshTx = classifyLk1Transaction(op, await provider.readTransaction(op), now());
  if (freshTx.reason !== 'DUE') return markReview(op, operations, attemptedAt, freshTx.reason, now);
  const freshBooking = classifyLk1Booking(op, await provider.readBooking(op));
  if (freshBooking.reason === 'CANCELLED') return releaseConfirmed(op, operations, attemptedAt, now);
  if (freshBooking.reason !== 'ACTIVE') return markReview(op, operations, attemptedAt, freshBooking.reason, now);
  const freshOptions = await provider.readCancelOptions(op);
  if ((freshOptions?.bookingId !== undefined && freshOptions.bookingId !== op.bookingId)
    || freshOptions?.cancellationOptions?.cancellationOnly?.available !== true) {
    return markReview(op, operations, attemptedAt, 'CANCELLATION_ONLY_UNAVAILABLE', now);
  }
  if (iso(op.lk1.target.startsAt) <= iso(now())) {
    return markReview(op, operations, attemptedAt, 'SERVICE_STARTED', now);
  }
  if (shouldStop()) return { state: 'STOPPED_AFTER_INTENT' };
  try {
    const result = await provider.cancelBooking(op, shouldStop);
    if (result?.stopped) return { state: 'STOPPED_AFTER_INTENT' };
  } catch { /* Readback resolves known success. */ }
  const after = classifyLk1Booking(op, await provider.readBooking(op));
  if (after.reason !== 'CANCELLED') return markReview(op, operations, attemptedAt, 'CANCEL_OUTCOME_UNKNOWN', now);
  const finalTx = classifyLk1Transaction(op, await provider.readTransaction(op), now());
  if (finalTx.reason !== 'DUE') return markReview(op, operations, attemptedAt, finalTx.reason, now);
  return releaseConfirmed(op, operations, attemptedAt, now);
}

export function createLk1VivaCancellationProvider({ token, baseUrl = 'https://api.vivacrm.ru',
  fetchImpl = fetch, timeoutMs = 15000 }) {
  const base = new URL(baseUrl);
  if (!(base.origin === 'https://api.vivacrm.ru'
    || (base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('VIVA_ORIGIN_INVALID');
  async function request(method, path, body, shouldStop) {
    const credential = await token();
    if (!text(credential) || /[\r\n]/.test(credential)) throw new Error('VIVA_TOKEN_UNAVAILABLE');
    if (method === 'PUT' && shouldStop?.()) return { status: 0, stopped: true };
    const response = await fetchImpl(new URL(path, base), { method, redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json',
        'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.status === 401) token.invalidate?.();
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return { status: response.status, payload };
  }
  const bookingPath = op => `/api/v1/clients/${encodeURIComponent(op.actorClientId)}/bookings/${encodeURIComponent(op.bookingId)}`;
  return {
    async readTransaction(op) {
      const result = await request('GET', `/api/v1/transactions/${encodeURIComponent(op.lk1.checkout.transactionId)}`);
      if (result.status !== 200 || !record(result.payload)) throw new Error('TRANSACTION_READ_UNAVAILABLE');
      return result.payload;
    },
    async readBooking(op) {
      // Client-scoped GET can omit owner/exercise fields. The inclusive exercise
      // list is the authoritative row for exact owner, target and cancel state.
      const rows = [];
      for (let page = 0; page < 10; page += 1) {
        const response = await request('GET', `/api/v1/exercises/${encodeURIComponent(op.exerciseId)}/bookings?showCancelled=true&page=${page}&size=200`);
        const body = response.payload, items = Array.isArray(body) ? body : body?.content;
        if (response.status !== 200 || !Array.isArray(items) || items.length > 200) throw new Error('BOOKING_PAGE_UNAVAILABLE');
        rows.push(...items);
        const last = Array.isArray(body) ? items.length < 200 : body.last;
        if (typeof last !== 'boolean' || (body.totalElements !== undefined && body.totalElements < rows.length)
          || (last && body.totalElements !== undefined && body.totalElements !== rows.length)
          || (!last && items.length !== 200)) throw new Error('BOOKING_PAGE_INCOMPLETE');
        if (!last) continue;
        const exact = rows.filter(row => row?.id === op.bookingId || row?.bookingId === op.bookingId);
        if (exact.length !== 1) throw new Error('BOOKING_NOT_UNIQUELY_FOUND');
        return { ...exact[0], __lk1ScopedExerciseId: op.exerciseId };
      }
      throw new Error('BOOKING_PAGE_LIMIT');
    },
    async readCancelOptions(op) {
      const result = await request('GET', `${bookingPath(op)}/cancel`);
      if (result.status !== 200 || !record(result.payload)) throw new Error('CANCEL_OPTIONS_UNAVAILABLE');
      return result.payload;
    },
    async cancelBooking(op, shouldStop) {
      return request('PUT', `${bookingPath(op)}/cancel`, { refundMethod: 'NONE', cancelExercise: false }, shouldStop);
    },
  };
}
