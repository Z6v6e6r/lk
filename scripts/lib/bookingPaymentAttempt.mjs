// Portable contract shared by the gateway, result reader and background closer.
// Expiry ends presentation of a link; only provider closure ends financial ownership.
export const BOOKING_PAYMENT_WINDOW_MS = 15 * 60_000;
export const paymentAttemptInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function paymentAttemptCheckout(transaction, attemptedAt) {
  const created = paymentAttemptInstant(transaction?.createDate)
    ?? paymentAttemptInstant(transaction?.createdAt) ?? paymentAttemptInstant(attemptedAt);
  if (created === null) return null;
  const due = paymentAttemptInstant(transaction?.paymentDueDate);
  return { lifecycleVersion: 1, createdAt: new Date(created).toISOString(),
    expiresAt: new Date(Math.min(created + BOOKING_PAYMENT_WINDOW_MS, due ?? Infinity)).toISOString() };
}
export function paymentAttemptDeadline(checkout, attemptedAt) {
  const created = paymentAttemptInstant(checkout?.createdAt) ?? paymentAttemptInstant(attemptedAt);
  const explicit = paymentAttemptInstant(checkout?.expiresAt);
  return created === null ? null : Math.min(created + BOOKING_PAYMENT_WINDOW_MS, explicit ?? Infinity);
}
export function paymentAttemptBinding(op) {
  return { operationKey: op._id, operationId: op.operationId, tenantKey: op.tenantKey,
    actorClientId: op.actorClientId, clientSubscriptionId: op.clientSubscriptionId,
    exerciseId: op.exerciseId, bookingId: op.bookingId,
    transactionId: op.lk1?.checkout?.transactionId, amountMinor: op.lk1?.checkout?.toPayMinor,
    fingerprint: op.lk1?.fingerprint };
}
export function paymentAttemptSame(a, b) {
  return !!a && !!b && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(k => a[k] === b[k]);
}
export function paymentAttemptReleased(op) {
  const p = op?.lk1?.paymentAttemptRelease, j = op?.lk1?.paymentAttempt;
  const credit = p?.creditProof, job = op?.lk1?.visitJob;
  const creditVerified = op?.lk1?.decision?.subscriptionVisitCount === 0 ? !credit
    : job ? credit?.kind === 'VISIT_JOB' && credit.jobId === job.id && credit.revision === job.revision
      && credit.phase === job.phase && ['RETURN_CONFIRMED', 'CANCELLED_BEFORE_DEBIT'].includes(job.phase)
      && job.bookingId === op.bookingId && job.actorClientId === op.actorClientId
      && job.clientSubscriptionId === op.clientSubscriptionId && !!job.cancellation
    : credit?.kind === 'SERVICE' && credit.before?.targetPresent === true && credit.after?.targetPresent === false
      && Number.isSafeInteger(credit.before.left) && credit.after.left === credit.before.left + 1
      && credit.before.total === credit.after.total && credit.before.other === credit.after.other;
  return !!(op?.state === 'RELEASED' && p?.schemaVersion === 1 && j?.phase === 'CLOSED'
    && paymentAttemptSame(p.binding, paymentAttemptBinding(op))
    && p.bookingState === 'CANCELLED' && p.transactionState === 'UNPAID_CLOSED'
    && p.verifiedAt === j.closedAt && paymentAttemptInstant(p.verifiedAt) !== null
    && p.creditState === (op.lk1.decision.subscriptionVisitCount === 0 ? 'NOT_CONSUMED' : 'RETURN_VERIFIED')
    && creditVerified);
}
export function paymentAttemptTransaction(op, tx) {
  const l = op.lk1, intent = l.transactionIntent, binding = paymentAttemptBinding(op);
  const agree = (values, expected) => values.filter(v => v != null && v !== '').length > 0
    && values.filter(v => v != null && v !== '').every(v => v === expected);
  if (!tx || !intent || !agree([tx.id, tx.transactionId], binding.transactionId)
    || !agree([tx.clientId, tx.client?.id, tx.client?.uuid], binding.actorClientId)
    || !agree([tx.toPay, tx.toPayMinor], binding.amountMinor)
    || (tx.currency != null && tx.currency !== 'RUB') || !Array.isArray(tx.products) || tx.products.length !== 1
    || tx.products[0].id !== intent.productId
    || !Array.isArray(tx.products[0].paymentBookingIds) || tx.products[0].paymentBookingIds.length !== 1
    || tx.products[0].paymentBookingIds[0] !== binding.bookingId
    || [tx.exerciseId, tx.exercise?.id].some(v => v != null && v !== binding.exerciseId)
    || (tx.products[0].discount != null && tx.products[0].discount !== intent.discountMinor)) return 'UNKNOWN';
  const statuses = [tx.status, tx.state, tx.paymentStatus, tx.transactionStatus].filter(v => v != null && v !== '');
  if (!statuses.length || !statuses.every(v => v === statuses[0])) return 'UNKNOWN';
  if (statuses[0] === 'PAID') return 'PAID';
  if (!['UNPAID', 'WAITING', 'PENDING'].includes(statuses[0]) || tx.possibleDoublePayment === true
    || (tx.processingStatus != null && tx.processingStatus !== '')
    || (tx.paymentLegs != null && (!Array.isArray(tx.paymentLegs) || tx.paymentLegs.length !== 1
      || tx.paymentLegs[0]?.source !== 'CARD_ONLINE' || tx.paymentLegs[0]?.amountKopecks !== binding.amountMinor
      || Object.keys(tx.paymentLegs[0]).sort().join(',') !== 'amountKopecks,source'))
    || [tx, tx.cardPaymentInfo, tx.cardPaymentStatus].some(row => row && (
      ['paymentDate', 'paidAt', 'refundDate', 'refundedAt'].some(k => row[k] != null && row[k] !== '')
      || ['deposit', 'refundSum', 'paidAmount', 'paidAmountMinor', 'refundedAmountMinor'].some(k => row[k] != null && row[k] !== 0)))
    || (tx.transactionRefunds != null && (!Array.isArray(tx.transactionRefunds) || tx.transactionRefunds.length))
    || (tx.receipts != null && (!Array.isArray(tx.receipts) || tx.receipts.some(r => r?.status !== 'new'
      || ['url', 'fnNumber', 'fiscalReceiptNumber', 'fiscalDocumentNumber', 'printedAt', 'closedAt', 'paymentDate', 'paidAt'].some(k => r[k]))))) return 'UNKNOWN';
  const cards = [tx.cardPaymentInfo, tx.cardPaymentStatus].filter(v => v != null);
  if (!cards.length) return 'UNKNOWN';
  if (statuses[0] === 'UNPAID' && cards.every(c => c.status === 'REJECTED'
    && ['EXPIRED', 'CANCELLED'].includes(c.declineOutcome))) return 'CLOSED';
  return cards.every(c => ['NEW', 'UNPAID', 'WAITING', 'PENDING'].includes(c.status)) ? 'OPEN' : 'UNKNOWN';
}
export function paymentAttemptBooking(op, booking) {
  const nativeVisit = op.lk1.decision.subscriptionVisitCount === 1 && !op.lk1.visitJob;
  if (!booking || booking.id !== op.bookingId
    || ![booking.clientId, booking.client?.id].filter(v => v != null).length
    || [booking.clientId, booking.client?.id].some(v => v != null && v !== op.actorClientId)
    || [booking.exerciseId, booking.exercise?.id, booking.__lk1ScopedExerciseId].some(v => v != null && v !== op.exerciseId)
    || ![booking.exerciseId, booking.exercise?.id, booking.__lk1ScopedExerciseId].some(v => v === op.exerciseId)
    || [booking.paid, booking.isPaid, booking.visitConfirmed].some(v => v != null && v !== false)
    || ['paidAt', 'paymentDate', 'refundDate', 'refundedAt'].some(k => booking[k] != null && booking[k] !== '')
    || ['refundMethod', 'oneTimeRefundMethod'].some(k => booking[k] != null && booking[k] !== ''
      && !(nativeVisit && booking[k] === 'SERVICE'))
    || ['paidAmount', 'paidAmountMinor', 'refundSum', 'refundedAmountMinor'].some(k => booking[k] != null && booking[k] !== 0)
    || booking.paymentStatus != null || booking.transactionStatus != null
    || (booking.receipts != null && (!Array.isArray(booking.receipts) || booking.receipts.length))
    || (booking.pendingPayments != null && (!Array.isArray(booking.pendingPayments) || booking.pendingPayments.length))
    || (booking.amountDue != null && (typeof booking.amountDue !== 'object' || Array.isArray(booking.amountDue)
      || ['paidKopecks', 'refundedKopecks'].some(k => booking.amountDue[k] != null && booking.amountDue[k] !== 0)))) return 'UNKNOWN';
  if (booking.paymentType !== (nativeVisit ? 'SUBSCRIPTION' : 'ON_PLACE')
    || (nativeVisit ? booking.clientSubscriptionId !== op.clientSubscriptionId : !!booking.clientSubscriptionId)) return 'UNKNOWN';
  const flags = [booking.isCancelled, booking.cancelled, booking.canceled].filter(v => v != null);
  if (!flags.length || flags.some(v => typeof v !== 'boolean' || v !== flags[0])) return 'UNKNOWN';
  if ([booking.status, booking.bookingStatus, booking.state].some(v => v != null
    && !(flags[0] ? ['CANCELLED', 'CANCELED'] : ['ACTIVE', 'CONFIRMED', 'BOOKED']).includes(v))) return 'UNKNOWN';
  return flags[0] ? 'CANCELLED' : 'ACTIVE';
}
