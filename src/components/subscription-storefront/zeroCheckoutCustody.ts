export type ZeroPaymentAttempt = { key: string; paymentRef: string; state: 'pending' | 'paid' | 'failed'; transactionId?: string; ownerBinding?: string };
/** One parser for ordinary and coupon custody, including pre-fast-checkout records. */
export function parseZeroAttempt(raw: string | null, key: string): ZeroPaymentAttempt | null {
  try {
    const v: unknown = JSON.parse(raw || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const a = v as ZeroPaymentAttempt;
    return a.key === key && typeof a.paymentRef === 'string' && /^zero-[a-z0-9-]{36}$/.test(a.paymentRef)
      && ['pending', 'paid', 'failed'].includes(a.state)
      && (a.ownerBinding === undefined || typeof a.ownerBinding === 'string' && /^[a-f0-9]{64}$/.test(a.ownerBinding))
      && (a.transactionId === undefined || typeof a.transactionId === 'string' && !!a.transactionId.trim()) ? a : null;
  } catch { return null; }
}

/** Only a backend operator receipt of a closed payment releases an old unpaid attempt. */
export function hasVerifiedCheckoutReset(payload: unknown, paymentRef: string, counterKey: string): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>, r = p.checkoutReset as Record<string, unknown> | null;
  return p.paymentRef === paymentRef && p.counterKey === counterKey && p.status === 'FAILED'
    && p.failed === true && p.paid === false && p.paymentUrl === null
    && !!r && !Array.isArray(r) && r.version === 1 && r.state === 'PROVIDER_EXPIRED_UNPAID'
    && r.paymentRef === paymentRef && typeof r.transactionId === 'string' && r.transactionId === p.transactionId
    && /^[a-f0-9-]{36}$/i.test(r.transactionId)
    && typeof r.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(r.operationId)
    && r.closureKind === 'PROVIDER_CARD_EXPIRED_UNPAID' && r.expireAcknowledged === false
    && r.terminalCardStatus === 'REJECTED' && r.declineOutcome === 'EXPIRED'
    && typeof r.paymentIdSha256 === 'string' && /^[a-f0-9]{64}$/.test(r.paymentIdSha256)
    && typeof r.paymentUrlSha256 === 'string' && /^[a-f0-9]{64}$/.test(r.paymentUrlSha256)
    && typeof r.verifiedAt === 'string'
    && Number.isFinite(Date.parse(r.verifiedAt)) && Date.parse(r.verifiedAt) <= Date.now();
}
