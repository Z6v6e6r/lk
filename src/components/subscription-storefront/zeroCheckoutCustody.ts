export type ZeroPaymentAttempt = { key: string; paymentRef: string; state: 'pending' | 'paid' | 'failed'; transactionId?: string };
/** One parser for ordinary and coupon custody, including pre-fast-checkout records. */
export function parseZeroAttempt(raw: string | null, key: string): ZeroPaymentAttempt | null {
  try {
    const v: unknown = JSON.parse(raw || 'null');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const a = v as ZeroPaymentAttempt;
    return a.key === key && typeof a.paymentRef === 'string' && /^zero-[a-z0-9-]{36}$/.test(a.paymentRef)
      && ['pending', 'paid', 'failed'].includes(a.state)
      && (a.transactionId === undefined || typeof a.transactionId === 'string' && !!a.transactionId.trim()) ? a : null;
  } catch { return null; }
}
