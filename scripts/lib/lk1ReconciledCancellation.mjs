import { classifyLk1Transaction as lk1ReconciledTransaction } from './lk1UnpaidBookingCancellation.mjs';
import { lk1FreeBinding, lk1FreeBooking, lk1FreeSubscription, lk1FreeServiceDate } from './lk1FreeCancellation.mjs';

export const lk1ReconciledDraftReceipts = receipts => receipts == null || Array.isArray(receipts)
  && receipts.every(r => r && typeof r === 'object' && !Array.isArray(r)
    && r.status === 'new' && r.type === 'SERVICE_SELL'
    && ['url', 'fnNumber', 'fiscalReceiptNumber', 'fiscalDocumentNumber', 'fiscalDocumentAttribute',
      'printedAt', 'closedAt', 'paymentDate', 'paidAt', 'errorCode', 'errorText']
      .every(k => r[k] == null || r[k] === ''));

// A historical reconciler release is not a refund receipt. This compatibility
// path proves current non-consumption with fresh provider reads on every request.
export function lk1ReconciledCandidate(op) {
  const l = op?.lk1, t = l?.transactionIntent, c = l?.checkout;
  return !!(op && op.state === 'RELEASED' && op.category === 'open_game'
    && op.releaseReason === 'RECONCILE_HUNG_DAILY_CLAIM'
    && op.reconciliation?.source === 'hung_claim_reconciler'
    && op.reconciliation.decision === 'SAFE_TO_RELEASE'
    && op.reconciliation.observedState === 'CONFIRMED'
    && Number.isFinite(Date.parse(op.releasedAt)) && Number.isFinite(Date.parse(op.updatedAt))
    && [op.tenantKey, op.actorClientId, op.operationId, op.bookingId, op.exerciseId,
      op.clientSubscriptionId, l?.fingerprint, l?.rule?.productId].every(v => typeof v === 'string' && v.length > 0)
    && op._id === `lk1-product:${JSON.stringify([op.tenantKey, op.actorClientId, op.operationId])}`
    && (!op.upstreamBookingId || op.upstreamBookingId === op.bookingId)
    && l.target?.eventId === op.exerciseId && l.target.category === 'GAME'
    && op.serviceDate === lk1FreeServiceDate(l.target.startsAt)
    && l.decision?.eligible === true && l.decision.subscriptionVisitCount === 1
    && Number.isSafeInteger(t?.chargeMinor) && t.chargeMinor > 0
    && t.chargeMinor === l.decision.benefit?.finalPriceMinor && t.chargeMinor === c?.toPayMinor
    && t.bookingId === op.bookingId && t.actorClientId === op.actorClientId
    && t.studioId === l.target.stationId && typeof t.productId === 'string' && t.productId.length > 0
    && typeof l.transactionId === 'string' && l.transactionId.length > 0
    && c.transactionId === l.transactionId && Number.isFinite(Date.parse(l.transactionAttemptedAt))
    && !op.managedEntitlementOperationId && !op.managedJoinV2 && !op.lk2LegacyJoin
    && !op.managedSubscriptionInstanceId && op.activationState !== 'PENDING'
    && !op.visitJob && !op.transactionId && !op.transactionAttemptedAt && !op.transactionIntent && !op.checkout
    && !l.visitJob && !l.createAttemptedAt && !l.bookingAttemptedAt && !op.createAttemptedAt
    && !l.freeCancellationReturn && !l.unpaidCancellation);
}

export function lk1ReconciledReadback(op, booking, transaction, subscriptions, now) {
  if (!lk1ReconciledCandidate(op)) return null;
  const b = lk1FreeBinding(op);
  if (lk1FreeBooking(booking, b)?.cancelled !== true || booking.visitConfirmed !== false
    || lk1ReconciledTransaction(op, transaction, now).reason !== 'DUE') return null;
  // A closed SMS link does not exclude a separate cash/terminal settlement.
  if ([booking.paid, booking.isPaid].some(v => v != null && v !== false)
    || ['paidAt', 'paymentDate', 'refundDate', 'refundedAt', 'refundMethod', 'oneTimeRefundMethod']
      .some(k => booking[k] != null && booking[k] !== '')
    || ['paidAmount', 'paidAmountMinor', 'refundSum', 'refundedAmountMinor']
      .some(k => booking[k] != null && booking[k] !== 0)
    || (booking.receipts != null && (!Array.isArray(booking.receipts) || booking.receipts.length !== 0))
    || booking.paymentStatus != null || booking.transactionStatus != null
    || booking.amountDue != null && (typeof booking.amountDue !== 'object' || Array.isArray(booking.amountDue)
      || ['paidKopecks', 'refundedKopecks'].some(k => booking.amountDue[k] != null && booking.amountDue[k] !== 0))) return null;
  if (![transaction.clientId, transaction.client?.id, transaction.client?.uuid].some(v => v === op.actorClientId)
    || !Array.isArray(transaction.products) || transaction.products.length !== 1
    || transaction.products[0].id !== op.lk1.transactionIntent.productId
    || !Array.isArray(transaction.products[0].paymentBookingIds)
    || transaction.products[0].paymentBookingIds.length !== 1
    || transaction.products[0].paymentBookingIds[0] !== op.bookingId) return null;
  // Require the old online attempt to be closed, not merely currently UNPAID.
  const card = transaction.cardPaymentInfo;
  if (card?.status !== 'REJECTED' || !['EXPIRED', 'CANCELLED'].includes(card.declineOutcome)
    || transaction.possibleDoublePayment === true || (transaction.deposit != null && transaction.deposit !== 0)
    || !lk1ReconciledDraftReceipts(transaction.receipts)
    || (transaction.refundSum != null && transaction.refundSum !== 0)
    || (transaction.transactionRefunds != null && (!Array.isArray(transaction.transactionRefunds)
      || transaction.transactionRefunds.length !== 0))) return null;
  const snapshot = lk1FreeSubscription(subscriptions, b, op.lk1.rule.productId);
  if (!snapshot || snapshot.left < 1 || snapshot.targetPresent) return null;
  const rows = Array.isArray(subscriptions) ? subscriptions : subscriptions.content;
  const sub = rows.find(row => row.subscriptionId === b.clientSubscriptionId);
  const agrees = (values, expected) => values.every(v => v == null || v === expected);
  if (sub.status !== 'ACTIVE' || sub.variant !== 'BY_VISITS'
    || !agrees([sub.id, sub.clientSubscriptionId], b.clientSubscriptionId)
    || !agrees([sub.clientId, sub.client?.id, sub.client?.clientId], b.actorClientId)) return null;
  for (const row of sub.bookings) {
    if (!agrees([row.clientId, row.client?.id, row.client?.clientId], b.actorClientId)
      || !agrees([row.clientSubscriptionId, row.clientSubscription?.id], b.clientSubscriptionId)
      || !row.exerciseId || (row.exercise?.id && row.exerciseId !== row.exercise.id)
      || row.cancelled === true || row.isCancelled === true) return null;
    // Another real use of the same day must enter the ordinary paid quote path.
    const day = lk1FreeServiceDate(row.exerciseDate);
    if (!day || day === op.serviceDate) return null;
  }
  return snapshot;
}
