// Bound the entire expanded batch, including history watches, before dispatch.
const documents = Array.isArray(msg.payload) ? msg.payload.slice(0, 60) : [];
const now = new Date().toISOString();
const ledgers = documents.filter(d => d?.schemaVersion === 3 && d.history?.version === 1
  && ["HUB_ATOMIC_INVENTORY_LEDGER", "PITER_ATOMIC_INVENTORY_LEDGER"].includes(d.documentType));
const watched = new Set(ledgers.flatMap(l => (l.history.entries || []).map(e => `${l.inventoryId}:${e.transactionId}`)));
const ordinary = documents.filter(d => !ledgers.includes(d)
  && (d.requestFingerprint || !watched.has(`${d.inventoryId}:${d.transactionId}`)));
const jobs = [];
for (const ledger of ledgers) {
  if ((ledger.history.settlements || []).some(s => s.projection?.state === 'PENDING')) { jobs.push(ledger); continue; }
  for (const entry of [...(ledger.history.entries || [])]
    .filter(e => !e.paymentPolling?.nextCheckAt || e.paymentPolling.nextCheckAt <= now)
    .sort((a,b) => String(a.paymentPolling?.nextCheckAt || a.lastAttemptAt || a.lastCheckedAt || '').localeCompare(String(b.paymentPolling?.nextCheckAt || b.lastAttemptAt || b.lastCheckedAt || ''))
      || a.transactionId.localeCompare(b.transactionId))
    .slice(0, 10)) {
    jobs.push({ _id: ledger._id, documentType: 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1', counterKey: ledger.counterKey,
      inventoryId: ledger.inventoryId, transactionId: entry.transactionId, productId: entry.fact?.productId,
      clientId: entry.fact?.clientId, localRowId: entry.localRowId, paymentRef: entry.paymentRef,
      pollingFact: entry.fact, pollingRow: { status: entry.fact?.state, transactionId: entry.transactionId,
        createdAt: entry.localPreimage?.createdAt, paymentPolling: entry.paymentPolling } });
  }
}
const history = jobs.slice(0, 20);
msg.payload = [...history, ...ordinary.slice(0, 60 - history.length)];
return msg;
