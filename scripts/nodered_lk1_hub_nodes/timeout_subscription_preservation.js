// An unpaid surcharge does not make a consumed subscription visit refundable
// by NONE. This legacy cleanup has no durable SERVICE owner: retain the booking
// and request reconciliation instead of irreversibly losing its visit.
if (ctx.currentTransactionUnpaidVerified === true) {
  const row = msg.payload;
  const agrees = (values, expected) => {
    const present = values.filter(v => v != null && v !== '');
    return present.length > 0 && present.every(v => typeof v === 'string' && v === expected);
  };
  const flags = [row?.isCancelled, row?.cancelled, row?.canceled].filter(v => v != null);
  const falseOrAbsent = v => v == null || v === false;
  const zeroOrAbsent = v => v == null || Number.isSafeInteger(v) && v === 0;
  const emptyOrAbsent = v => v == null || Array.isArray(v) && v.length === 0;
  const exercises = [row?.exerciseId, row?.exercise?.id].filter(v => v != null && v !== '');
  const expectedExercise = toStr(ctx.paymentExerciseId) || toStr(ctx.exerciseId);
  const exerciseAgrees = exercises.every(v => typeof v === 'string' && v === exercises[0]
    && (!expectedExercise || v === expectedExercise));
  const bound = row && typeof row === 'object' && !Array.isArray(row)
    && agrees([row.id, row.bookingId], bookingId)
    && agrees([row.clientId, row.client?.id, row.client?.clientId], clientId) && exerciseAgrees
    && flags.length > 0 && flags.every(v => typeof v === 'boolean') && new Set(flags).size === 1;
  const subscription = row?.paymentType === 'SUBSCRIPTION' || row?.paymentMethod === 'SUBSCRIPTION'
    || row?.clientSubscriptionId != null || row?.clientSubscription != null;
  const ordinaryUnpaid = bound && row.paymentType === 'ON_PLACE'
    && (row.paymentMethod == null || row.paymentMethod === 'ON_PLACE') && !subscription
    && row.freeVisitId == null && row.clientOneTimeId == null && row.groupPayerBookingId == null && row.batchId == null
    && [row.paid, row.isPaid, row.isGroup, row.isSubscriptionBooking].every(falseOrAbsent)
    && ['paidAt', 'paymentDate', 'refundDate', 'refundedAt', 'refundMethod', 'oneTimeRefundMethod', 'paymentStatus', 'transactionStatus']
      .every(k => row[k] == null || row[k] === '')
    && ['paidAmount', 'paidAmountMinor', 'refundedAmountMinor', 'refundSum'].every(k => zeroOrAbsent(row[k]))
    && [row.receipts, row.pendingPayments].every(emptyOrAbsent)
    && (row.amountDue == null || typeof row.amountDue === 'object' && !Array.isArray(row.amountDue)
      && ['paidKopecks', 'refundedKopecks'].every(k => zeroOrAbsent(row.amountDue[k])));
  if (!isOk(statusCode) || !ordinaryUnpaid) {
    ctx.blockLocalMutation = true;
    ctx.currentProbeRequest = null;
    ctx.blockReason = subscription ? 'timeout_subscription_return_requires_owner' : 'timeout_booking_payment_unverified';
    appendTrace(ctx, { step: 'timeout_booking_entitlement_held', bookingId, clientId,
      statusCode, reason: ctx.blockReason });
    return pushBookingFailureAndContinue(ctx, { bookingId, clientId, method: 'timeout_booking_preflight',
      statusCode, unsupportedReason: 'Unpaid surcharge cancellation requires verified booking and entitlement ownership' });
  }
  ctx.currentTimeoutBookingChecked = true;
}
