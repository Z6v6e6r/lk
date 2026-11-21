import crypto from 'node:crypto';

const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const phone = x => typeof x === 'string' ? x.replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7') : null;
export const checkoutDigest = x => crypto.createHash('sha256').update(String(x)).digest('hex');

/** Only a closed provider card attempt with no money or issued service permits release. */
export function expiredSubscriptionCheckoutReason(sale, transaction, now = Date.now()) {
  const t = transaction, card = t?.cardPaymentInfo, line = t?.products?.[0];
  if (!object(sale) || sale.status !== 'PAYMENT_PENDING' || !uuid(sale.transactionId)
    || !sale.paymentRef || !sale.counterKey || sale.paidAt || sale.clientSubscriptionId || sale.checkoutReset) return 'SALE_NOT_PENDING';
  // The installed receipt consumer is explicitly bound to this counter.
  if (sale.counterKey !== 'friendship') return 'UNSUPPORTED_COUNTER';
  if (!object(t) || t.id !== sale.transactionId || [t.uuid, t.transactionId].some(x => x != null && x !== t.id) || ![t.status, t.state, t.paymentStatus, t.transactionStatus]
    .filter(x => x != null).every(x => x === 'UNPAID') || t.status !== 'UNPAID') return 'PROVIDER_NOT_UNPAID';
  const ids = [t.clientId, t.client?.id, t.client?.uuid, t.client?.clientId].filter(x => x != null);
  const phones = [t.clientPhone, t.client?.phone, t.client?.mobile, t.client?.phoneNumber].filter(x => x != null).map(phone);
  // The purchase endpoint supports phone-only records (clientId: null). Resolve
  // those through this exact provider transaction; never override an explicit ID.
  if (!ids.length || !uuid(ids[0]) || ids.some(x => x !== ids[0])
    || sale.clientId != null && (!uuid(sale.clientId) || ids[0] !== sale.clientId)
    || !/^7\d{10}$/.test(phone(sale.clientPhone) || '') || !phones.length || phones.some(x => x !== phone(sale.clientPhone))) return 'OWNER_MISMATCH';
  if (!Array.isArray(t.products) || t.products.length !== 1 || !object(line) || !uuid(sale.productId)
    || line.id !== sale.productId || [line.uuid, line.productId, line.product?.id, t.productId].some(x => x != null && x !== sale.productId)
    || line.type !== 'SUBSCRIPTION' || line.count !== 1 || line.cost !== sale.amountMinor
    || !Number.isSafeInteger(line.cost) || line.cost <= 0 || line.discount !== 0 || t.discount !== 0
    || t.sum !== line.cost || t.toPay !== line.cost || sale.toPayMinor !== line.cost || t.deposit !== 0) return 'PRODUCT_OR_MONEY_MISMATCH';
  for (const key of ['paymentDate', 'paidAt', 'refundDate', 'refundedAt', 'refundSum', 'refundedAmount', 'paidAmount', 'paidAmountMinor', 'paidAmountKopecks', 'clientSubscriptionId']) {
    if (t[key] != null && t[key] !== 0 && t[key] !== false) return 'MONEY_OR_SERVICE_PRESENT';
  }
  if (t.paid === true || [line.used, line.refunded].some(x => x !== null && x !== false) || line.clientSubscriptionId
    || t.clientSubscription?.id || line.clientSubscription?.id) return 'MONEY_OR_SERVICE_PRESENT';
  if (!object(card) || Object.keys(card).some(k => !['paymentId', 'paymentUrl', 'status', 'declineOutcome', 'declineReason', 'declineMessage'].includes(k))
    || card.status !== 'REJECTED' || card.declineOutcome !== 'EXPIRED' || card.declineReason !== 'OTHER'
    || card.declineMessage !== null || typeof card.paymentId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(card.paymentId)
    || typeof card.paymentUrl !== 'string' || !/^https:\/\/pay\.vivacrm\.ru\/[A-Za-z0-9_/?=&.%~-]+$/.test(card.paymentUrl)
    || card.paymentUrl.length > 4096 || card.paymentUrl !== sale.paymentUrl) return 'CARD_NOT_CLOSED';
  if (!['SMS', 'WIDGET', 'CARD'].includes(t.paymentMethod) || !Array.isArray(t.paymentLegs) || t.paymentLegs.length !== 1
    || !object(t.paymentLegs[0]) || t.paymentLegs[0].source !== 'CARD_ONLINE' || t.paymentLegs[0].amountKopecks !== t.toPay
    || Object.keys(t.paymentLegs[0]).some(k => !['source', 'amountKopecks'].includes(k))) return 'PAYMENT_LEGS_UNCERTAIN';
  if (t.processingStatus !== null || t.possibleDoublePayment !== false || t.receiptPending !== false
    || t.acquiringAuthCode || t.acquiringRrnCode) return 'PAYMENT_PROCESSING';
  for (const key of ['purchasedServices', 'receipts', 'executedSurcharges', 'paidByOtherSaleBookingIds', 'transactionRefunds']) {
    if (!Array.isArray(t[key]) || t[key].length) return 'MONEY_OR_SERVICE_PRESENT';
  }
  for (const key of ['cardPaymentStatus', 'payments', 'cardPayments', 'paymentAttempts', 'payment', 'paymentInfo']) {
    if (t[key] != null) return 'PAYMENT_EVIDENCE_UNCERTAIN';
  }
  const created = Date.parse(t.createDate), due = Date.parse(t.paymentDueDate);
  if (!Number.isFinite(created) || !Number.isFinite(due) || !Number.isFinite(now)
    || now < Math.max(due, created + 25 * 60_000) + 60_000) return 'PAYMENT_WINDOW_OPEN';
  return null;
}

export function expiredSubscriptionCheckoutUpdate(sale, transaction, operationId, now = Date.now()) {
  const reason = expiredSubscriptionCheckoutReason(sale, transaction, now);
  if (reason || !uuid(operationId)) throw new Error(reason || 'INVALID_OPERATION');
  const verifiedAt = new Date(now).toISOString();
  return {
    status: 'FAILED', paymentUrl: null, updatedAt: verifiedAt,
    checkoutReset: {
      version: 1, state: 'PROVIDER_EXPIRED_UNPAID', paymentRef: sale.paymentRef,
      transactionId: sale.transactionId, operationId, verifiedAt,
      closureKind: 'PROVIDER_CARD_EXPIRED_UNPAID', expireAcknowledged: false,
      terminalCardStatus: 'REJECTED', declineOutcome: 'EXPIRED',
      paymentIdSha256: checkoutDigest(transaction.cardPaymentInfo.paymentId),
      paymentUrlSha256: checkoutDigest(transaction.cardPaymentInfo.paymentUrl),
    },
  };
}
