// Runs before the existing split + rate limiter. Bound history work per tick;
// never fan out after the limiter or let one bad watch starve other transactions.
const documents = Array.isArray(msg.payload) ? msg.payload : [];
const ledgers = documents.filter(d => d?.schemaVersion === 3 && d.history?.version === 1
  && ["HUB_ATOMIC_INVENTORY_LEDGER", "PITER_ATOMIC_INVENTORY_LEDGER"].includes(d.documentType));
const watched = new Set(ledgers.flatMap(l => (l.history.entries || []).map(e => `${l.inventoryId}:${e.transactionId}`)));
const ordinary = documents.filter(d => !ledgers.includes(d)
  && (d.requestFingerprint || !watched.has(`${d.inventoryId}:${d.transactionId}`)));
const jobs = [];
for (const ledger of ledgers) {
  // Projection recovery has priority and only needs one job for this ledger.
  if ((ledger.history.settlements || []).some(s => s.projection?.state === 'PENDING')) { jobs.push(ledger); continue; }
  for (const entry of [...(ledger.history.entries || [])]
    .sort((a,b) => String(a.lastAttemptAt || a.lastCheckedAt).localeCompare(String(b.lastAttemptAt || b.lastCheckedAt)))
    .slice(0, 40)) {
    jobs.push({ documentType: 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1', counterKey: ledger.counterKey,
      inventoryId: ledger.inventoryId, transactionId: entry.transactionId, productId: entry.fact?.productId,
      clientId: entry.fact?.clientId, localRowId: entry.localRowId, paymentRef: entry.paymentRef });
  }
}
msg.payload = [...ordinary, ...jobs];
return msg;
