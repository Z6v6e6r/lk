// Ordinary split checkout adapter. This module is portable into Node-RED's
// function scope: callers own durable Mongo writes and provider dispatch.
export const SPLIT_PAYMENT_ATTEMPT_WINDOW_MS = 15 * 60_000;
export const splitAttemptInstant = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function splitAttemptWindow(payment, transaction, attemptedAt) {
  // A later provider alias/readback cannot restart a persisted attempt window.
  const candidates = [transaction?.createDate, transaction?.createdAt,
    payment?.paymentAttemptCreatedAt, payment?.createdAt, attemptedAt]
    .map(splitAttemptInstant).filter(value => value !== null);
  if (!candidates.length) return null;
  const created = Math.min(...candidates);
  const due = splitAttemptInstant(transaction?.paymentDueDate);
  return { createdAt: new Date(created).toISOString(),
    expiresAt: new Date(Math.min(created + SPLIT_PAYMENT_ATTEMPT_WINDOW_MS, due ?? Infinity)).toISOString() };
}
export function splitAttemptTransaction(transaction, expected) {
  const tx = transaction;
  const agrees = (values, value) => {
    const supplied = values.filter(v => v != null && v !== '');
    return supplied.length > 0 && supplied.every(v => v === value);
  };
  if (!tx || !expected || !Number.isSafeInteger(expected.amountMinor) || expected.amountMinor <= 0
    || !agrees([tx.id, tx.transactionId], expected.transactionId)
    || !agrees([tx.clientId, tx.client?.id, tx.client?.uuid], expected.clientId)
    || !agrees([tx.toPay, tx.toPayMinor], expected.amountMinor)
    || (tx.currency != null && tx.currency !== 'RUB')
    || !Array.isArray(tx.products) || tx.products.length !== 1
    || typeof tx.products[0].id !== 'string' || !tx.products[0].id
    || expected.productId && tx.products[0].id !== expected.productId
    || !Array.isArray(tx.products[0].paymentBookingIds)
    || tx.products[0].paymentBookingIds.length !== 1 || tx.products[0].paymentBookingIds[0] !== expected.bookingId
    || [tx.bookingId, tx.exerciseId, tx.exercise?.id].some((v, i) => v != null
      && v !== (i === 0 ? expected.bookingId : expected.exerciseId))) return 'UNKNOWN';
  const statuses = [tx.status, tx.state, tx.paymentStatus, tx.transactionStatus].filter(v => v != null && v !== '');
  if (!statuses.length || !statuses.every(v => v === statuses[0])) return 'UNKNOWN';
  if (statuses[0] === 'PAID') return 'PAID';
  if (!['UNPAID', 'WAITING', 'PENDING'].includes(statuses[0]) || tx.possibleDoublePayment === true
    || [tx, tx.cardPaymentInfo, tx.cardPaymentStatus].some(row => row && (
      ['paidAt', 'paymentDate', 'refundDate', 'refundedAt'].some(k => row[k] != null && row[k] !== '')
      || ['deposit', 'refundSum', 'paidAmount', 'paidAmountMinor', 'refundedAmountMinor'].some(k => row[k] != null && row[k] !== 0)))
    || tx.transactionRefunds != null && (!Array.isArray(tx.transactionRefunds) || tx.transactionRefunds.length > 0)
    || tx.receipts != null && (!Array.isArray(tx.receipts) || tx.receipts.some(r => r?.status !== 'new'
      || ['url', 'fnNumber', 'fiscalReceiptNumber', 'fiscalDocumentNumber', 'printedAt', 'closedAt', 'paymentDate', 'paidAt'].some(k => r[k])))) return 'UNKNOWN';
  if (tx.paymentLegs != null && (!Array.isArray(tx.paymentLegs) || tx.paymentLegs.length !== 1
    || tx.paymentLegs[0]?.source !== 'CARD_ONLINE' || tx.paymentLegs[0].amountKopecks !== expected.amountMinor
    || Object.keys(tx.paymentLegs[0]).sort().join(',') !== 'amountKopecks,source')) return 'UNKNOWN';
  if (tx.processingStatus != null && tx.processingStatus !== '') return 'UNKNOWN';
  const cards = [tx.cardPaymentInfo, tx.cardPaymentStatus].filter(v => v != null);
  if (!cards.length) return 'UNKNOWN';
  if (statuses[0] === 'UNPAID' && cards.every(c => c.status === 'REJECTED'
    && ['EXPIRED', 'CANCELLED'].includes(c.declineOutcome))) return 'CLOSED';
  return cards.every(c => ['NEW', 'UNPAID', 'WAITING', 'PENDING'].includes(c.status)) ? 'OPEN' : 'UNKNOWN';
}
export function splitAttemptResume(payment, transaction, booking, actor, exerciseId, now = Date.now()) {
  const bound = payment && payment.clientId === actor && payment.bookingId && payment.transactionId;
  const ids = [booking?.id, booking?.bookingId].filter(v => v != null);
  const owners = [booking?.clientId, booking?.client?.id].filter(v => v != null);
  const flags = [booking?.isCancelled, booking?.cancelled, booking?.canceled].filter(v => v != null);
  const active = ids.length && ids.every(v => v === payment?.bookingId)
    && owners.length && owners.every(v => v === actor)
    && [booking?.exerciseId, booking?.exercise?.id].every(v => v == null || v === exerciseId)
    && flags.length && flags.every(v => v === false)
    && booking?.paymentType === 'ON_PLACE' && !booking.clientSubscriptionId;
  const amountMinor = payment?.amountMinor ?? (Number.isFinite(payment?.amount) ? Math.round(payment.amount * 100) : null);
  const kind = bound ? splitAttemptTransaction(transaction, { ...payment, amountMinor, clientId: actor, exerciseId }) : 'UNKNOWN';
  const window = splitAttemptWindow(payment, transaction);
  if (!active || kind === 'UNKNOWN' || !window || Date.parse(window.createdAt) > now) return { state: 'CLOSING' };
  if (kind !== 'PAID' && ([booking.paid, booking.isPaid, booking.visitConfirmed].some(v => v != null && v !== false)
    || ['paidAt', 'paymentDate', 'refundDate', 'refundedAt', 'refundMethod', 'oneTimeRefundMethod', 'paymentStatus', 'transactionStatus']
      .some(k => booking[k] != null && booking[k] !== '')
    || ['paidAmount', 'paidAmountMinor', 'refundSum', 'refundedAmountMinor'].some(k => booking[k] != null && booking[k] !== 0)
    || (booking.receipts != null && (!Array.isArray(booking.receipts) || booking.receipts.length))
    || (booking.pendingPayments != null && (!Array.isArray(booking.pendingPayments) || booking.pendingPayments.length))
    || booking.amountDue != null && (typeof booking.amountDue !== 'object' || Array.isArray(booking.amountDue)
      || ['paidKopecks', 'refundedKopecks'].some(k => booking.amountDue[k] != null && booking.amountDue[k] !== 0)))) return { state: 'CLOSING', window };
  if (kind === 'PAID') return { state: 'CONFIRMED', window };
  if (kind !== 'OPEN' || now >= Date.parse(window.expiresAt)) return { state: 'CLOSING', window };
  const urls = [transaction.paymentUrl, transaction.paymentLink, transaction.cardPaymentInfo?.paymentUrl,
    transaction.cardPaymentInfo?.paymentLink, transaction.cardPaymentStatus?.paymentUrl,
    transaction.cardPaymentStatus?.paymentLink].filter(v => v != null && v !== '');
  if (!urls.length || urls.some(v => v !== payment.paymentUrl)
    || !/^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?(?:[/?#][^\s\\]*)?$/i.test(payment.paymentUrl)
    || payment.paymentUrl.length > 4096) return { state: 'CLOSING', window };
  return { state: 'PAYMENT_REQUIRED', paymentUrl: payment.paymentUrl, window };
}
export function splitAttemptHeadKey(ctx, actor) {
  const fallbackTime = (date, time) => date && time ? `${date}T${time}${time.length === 5 ? ':00' : ''}+03:00` : null;
  let endDate = ctx.date;
  if (!ctx.timeTo && ctx.date && ctx.fromTime && ctx.toTime && ctx.toTime <= ctx.fromTime) {
    const day = Date.parse(`${ctx.date}T00:00:00Z`);
    endDate = Number.isFinite(day) ? new Date(day + 86400000).toISOString().slice(0, 10) : null;
  }
  let identity;
  if (ctx.action === 'join') {
    if (typeof ctx.exerciseId !== 'string' || !ctx.exerciseId) return null;
    identity = ['EVENT', ctx.exerciseId];
  } else if (ctx.action === 'create') {
    const start = splitAttemptInstant(ctx.timeFrom || fallbackTime(ctx.date, ctx.fromTime));
    const end = splitAttemptInstant(ctx.timeTo || fallbackTime(endDate, ctx.toTime));
    const duration = start !== null && end !== null ? (end - start) / 60000 : null;
    if (typeof ctx.studioId !== 'string' || !ctx.studioId || typeof ctx.roomId !== 'string' || !ctx.roomId
      || !Number.isSafeInteger(duration) || duration <= 0
      || ctx.durationMinutes != null && ctx.durationMinutes !== duration) return null;
    identity = ['CREATE', ctx.studioId, ctx.roomId, new Date(start).toISOString(), duration];
  } else return null;
  if (typeof actor !== 'string' || !actor) return null;
  return 'booking-payment-head:' + JSON.stringify(['iSkq6G', actor, identity]);
}

export function splitAttemptCloseIntent(ctx, leg) {
  const p = ctx.currentTimedOutPayment;
  if (!['EXPIRE', 'CANCEL'].includes(leg) || !ctx.sourceTenantKey || !ctx.gameId
    || !ctx.currentBookingId || !ctx.currentClientId || !p?.transactionId) return null;
  const binding = { tenantKey: ctx.sourceTenantKey, gameId: ctx.gameId, bookingId: ctx.currentBookingId,
    clientId: ctx.currentClientId, transactionId: p.transactionId, leg };
  return { _id: 'split-booking-payment-close:' + JSON.stringify(Object.values(binding)),
    kind: 'SPLIT_BOOKING_PAYMENT_CLOSE_V1', binding, createdAt: new Date().toISOString() };
}
// Invoke only after the existing canonical cleanup write/readback owner succeeds.
// The raw cleanup router carries a proposal; it does not release the active head.
export function splitAttemptHeadClosure(proposal, game, receipt) {
  if (!proposal || !receipt || receipt._id !== proposal.receiptKey
    || receipt.kind !== 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1'
    || JSON.stringify(receipt.proposal) !== JSON.stringify(proposal)
    || proposal.receiptKey !== 'split-booking-payment-closure:' + JSON.stringify([
      proposal.tenantKey, proposal.gameId, proposal.clientId, proposal.bookingId, proposal.transactionId])
    || proposal.transactionState !== 'UNPAID_CLOSED' || proposal.bookingState !== 'CANCELLED'
    || !proposal.headKey?.startsWith('booking-payment-head:')
    || game?.id !== proposal.gameId || game.tenantKey !== proposal.tenantKey
    || !Number.isSafeInteger(game.revision) || game.revision <= proposal.sourceRevision
    || game.participants?.some(p => p.id === proposal.clientId)) return null;
  const rows = game.metadata?.splitPayment?.payments?.filter(p => p.bookingId === proposal.bookingId
    && p.transactionId === proposal.transactionId && p.clientId === proposal.clientId);
  if (!rows || rows.length !== 1 || !['EXPIRED', 'LEFT', 'CANCELLED', 'CANCELED'].includes(rows[0].status)
    || JSON.stringify(rows[0].paymentAttemptClosure) !== JSON.stringify(proposal)) return null;
  return [{ _id: proposal.headKey, kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', actorClientId: proposal.clientId,
    phase: 'PAYMENT_REQUIRED', 'payment.bookingId': proposal.bookingId,
    'payment.transactionId': proposal.transactionId, 'payment.amountMinor': proposal.amountMinor },
    { $set: { phase: 'CLOSED', closure: { ...proposal, rosterRevision: game.revision }, updatedAt: game.updatedAt } },
    { writeConcern: { w: 'majority', j: true } }];
}
