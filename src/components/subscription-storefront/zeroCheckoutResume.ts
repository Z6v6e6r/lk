/** Provider readback only: terminal/expired payloads take priority over leftover links. */
export function parseZeroOperationLink(payload: unknown, now = Date.now()): string | null {
  const links = new Set<string>();
  let unsafe = false;
  function visit(value: unknown, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 6) return;
    if (Array.isArray(value)) { value.forEach(row => visit(row, depth + 1)); return; }
    const row = value as Record<string, unknown>;
    for (const field of ['status', 'state', 'transactionStatus']) {
      if (typeof row[field] === 'string' && /^(FAILED|FAIL|CANCELLED|CANCELED|EXPIRED|PAID|REFUND|REFUNDED)$/i.test(row[field])) unsafe = true;
    }
    if (row.failed === true || row.paid === true) unsafe = true;
    for (const field of ['paymentDueDate', 'paymentExpiresAt', 'expiresAt']) {
      if (row[field] != null && (typeof row[field] !== 'string' || !Number.isFinite(Date.parse(row[field])) || Date.parse(row[field]) <= now)) unsafe = true;
    }
    if (row.paymentUrl != null) {
      try {
        const url = new URL(String(row.paymentUrl));
        if (url.protocol !== 'https:' || url.username || url.password) unsafe = true;
        else links.add(url.toString());
      } catch { unsafe = true; }
    }
    for (const field of ['transactionStatus', 'cardPaymentStatus', 'payment', 'paymentInfo', 'data', 'payload', 'result']) visit(row[field], depth + 1);
  }
  visit(payload);
  return !unsafe && links.size === 1 ? [...links][0] : null;
}
