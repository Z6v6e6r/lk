// BEGIN storefront verified checkout reset receipt
// An operator writes this after exact unpaid + terminal EXPIRED card readback; it is not actor identity proof.
const checkoutReset = record.checkoutReset;
if (record.counterKey === "friendship" && record.status === "FAILED" && !record.paidAt && !record.clientSubscriptionId
  && checkoutReset?.version === 1 && checkoutReset.state === "PROVIDER_EXPIRED_UNPAID"
  && checkoutReset.paymentRef === record.paymentRef && checkoutReset.transactionId === record.transactionId
  && checkoutReset.closureKind === 'PROVIDER_CARD_EXPIRED_UNPAID' && checkoutReset.expireAcknowledged === false
  && checkoutReset.terminalCardStatus === 'REJECTED' && checkoutReset.declineOutcome === 'EXPIRED'
  && /^[a-f0-9]{64}$/.test(checkoutReset.paymentIdSha256 || '') && /^[a-f0-9]{64}$/.test(checkoutReset.paymentUrlSha256 || '')
  && /^[a-f0-9-]{36}$/i.test(checkoutReset.operationId || "")
  && typeof checkoutReset.verifiedAt === "string" && Number.isFinite(Date.parse(checkoutReset.verifiedAt))
  && Date.parse(checkoutReset.verifiedAt) <= Date.now()) {
  return [null, Object.assign({}, msg, { statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: { ok: true, counterKey: record.counterKey, paymentRef: record.paymentRef,
      transactionId: record.transactionId, status: "FAILED", paid: false, failed: true, paymentUrl: null,
      checkoutReset: { version: 1, state: checkoutReset.state, paymentRef: record.paymentRef,
        transactionId: record.transactionId, operationId: checkoutReset.operationId,
        closureKind: checkoutReset.closureKind, expireAcknowledged: false, terminalCardStatus: 'REJECTED', declineOutcome: 'EXPIRED',
        paymentIdSha256: checkoutReset.paymentIdSha256, paymentUrlSha256: checkoutReset.paymentUrlSha256, verifiedAt: checkoutReset.verifiedAt } } }), null];
}
// END storefront verified checkout reset receipt
