import { createHash } from 'node:crypto';
import { annualHistory } from './annualSubscriptionHistory.mjs';

const digest = x => createHash('sha256').update(annualHistory.stable(x)).digest('hex');
const fail = message => { throw Error(`ANNUAL_OPENING_${message}`); };
const snapshot = (e, source, query, key, now) => {
  const age = Date.parse(now) - Date.parse(e?.capturedAt);
  if (e?.formatVersion !== 1 || e.source !== source || e.complete !== true
    || annualHistory.stable(e.query) !== annualHistory.stable(query)
    || !Array.isArray(e[key]) || e.pagination?.complete !== true
    || !Number.isSafeInteger(e.pagination.pages) || e.pagination.pages < 1
    || e.pagination.rowCount !== e[key].length || !Number.isFinite(age) || age < 0 || age > 300_000) fail('EVIDENCE_INVALID');
  return e[key];
};

// Offline only: this result is not an execution grant or a substitute for BSON
// custody. The execution operator must bind it to a freshly observed preimage.
export function buildAnnualSubscriptionOpening({ counterKey, accountingScope, ledgerEvidence,
  providerEvidence, subscriptionEvidence, crossInventoryEvidence, productEvidence, runtimeBinding, now }) {
  const spec = annualHistory.products[counterKey];
  if (!spec || accountingScope !== 'ALL_PROVIDER_PAID') fail('ACCOUNTING_SCOPE_REQUIRED');
  const rows = snapshot(ledgerEvidence, 'MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES', { inventoryId: spec.inventoryId }, 'rows', now);
  const transactions = snapshot(providerEvidence, 'VIVA_TRANSACTIONS', { productId: spec.productId }, 'transactions', now);
  const transactionIds = transactions.map(t => t.id).sort();
  if (transactionIds.some(id => typeof id !== 'string' || !id) || new Set(transactionIds).size !== transactionIds.length) fail('TRANSACTION_DUPLICATE');
  const cross = snapshot(crossInventoryEvidence, 'MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES',
    { transactionId: { $in: transactionIds } }, 'rows', now);
  const clientIds = [...new Set(transactions.map(t => t.clientId || t.client?.id || t.client?.uuid))].sort();
  const clients = snapshot(subscriptionEvidence, 'VIVA_CLIENT_SUBSCRIPTIONS',
    { clientIds, includeFinished: true }, 'clients', now);
  const clientMap = new Map();
  for (const c of clients) {
    if (!clientIds.includes(c.clientId) || clientMap.has(c.clientId) || c.complete !== true
      || c.pagination?.complete !== true || !Number.isSafeInteger(c.pagination.pages) || c.pagination.pages < 1
      || !Array.isArray(c.subscriptions) || c.pagination.rowCount !== c.subscriptions.length) fail('CLIENT_SNAPSHOT_INVALID');
    clientMap.set(c.clientId, c);
  }
  if (clientMap.size !== clientIds.length) fail('CLIENT_COVERAGE_INVALID');
  const captures = [ledgerEvidence, providerEvidence, subscriptionEvidence, crossInventoryEvidence, productEvidence, runtimeBinding]
    .map(e => Date.parse(e?.capturedAt));
  if (captures.some(t => !Number.isFinite(t) || Date.parse(now) - t > 300_000 || t > Date.parse(now))
    || Math.max(...captures) - Math.min(...captures) > 60_000) fail('EVIDENCE_SKEW');
  const p = productEvidence.product;
  if (productEvidence.source !== 'VIVA_PRODUCT' || p?.id !== spec.productId || p.productType !== 'SUBSCRIPTION'
    || p.cost !== (counterKey === 'network_friendship' ? 9800000 : 5680000)
    || p.activationDays !== 1 || p.validityDays !== 365 || p.visits !== 365) fail('PRODUCT_DRIFT');
  if (runtimeBinding.kind !== 'ANNUAL_HISTORY_RUNTIME_BINDING_V1' || runtimeBinding.salesFlagsOff !== true
    || !/^[a-f0-9]{64}$/.test(runtimeBinding.flowSha256 || '')
    || !/^[a-f0-9]{64}$/.test(runtimeBinding.publicationDigest || '')) fail('RUNTIME_BINDING_INVALID');
  const localMap = new Map(), paymentRefs = new Set();
  for (const r of rows) {
    if (r.inventoryId !== spec.inventoryId || r.counterKey !== counterKey || r.productId !== spec.productId
      || !transactionIds.includes(r.transactionId) || localMap.has(r.transactionId) || r.requestFingerprint
      || typeof r._id !== 'string' || !r._id || typeof r.paymentRef !== 'string' || !r.paymentRef
      || paymentRefs.has(r.paymentRef) || !['PAID', 'PAYMENT_PENDING', 'PROVIDER_UNKNOWN', 'FAILED', 'REFUNDED'].includes(r.status)) fail('LOCAL_SCOPE_INVALID');
    localMap.set(r.transactionId, r); paymentRefs.add(r.paymentRef);
  }
  if (digest([...cross].sort((a,b) => a._id.localeCompare(b._id))) !== digest([...rows].sort((a,b) => a._id.localeCompare(b._id)))) fail('CROSS_INVENTORY_COLLISION');
  const entries = [], localRefunds = [];
  for (const t of transactions) {
    const row = localMap.get(t.id) || null;
    const c = clientMap.get(t.clientId || t.client?.id || t.client?.uuid);
    const fact = annualHistory.observe(t, { productId: spec.productId, subscriptions: c.subscriptions, clientId: c.clientId, localRow: row });
    if (row && ((row.status === 'REFUNDED' && fact.state !== 'REFUNDED')
      || (row.status === 'PAID' && fact.state === 'UNPAID')
      || (fact.state === 'PAID' && row.status !== 'PAID'))) fail('LOCAL_RECONCILIATION_REQUIRED');
    const ref = row ? row.paymentRef : `viva-legacy:${spec.productId}:${t.id}`;
    entries.push({ transactionId: t.id, source: row ? 'LOCAL' : 'PROVIDER_ONLY',
      kind: fact.state === 'PAID' ? fact.amountMinor > 0 ? (row ? 'LOCAL_PAID' : 'PROVIDER_ONLY_PAID') : 'FREE_ISSUE'
        : fact.state === 'REFUNDED' ? fact.amountMinor > 0 ? 'REFUNDED' : 'FREE_ISSUE_RETURN' : 'UNPAID_WATCH',
      ref, localRowId: row?._id || null, paymentRef: row?.paymentRef || null,
      localPreimage: row, fact, lastCheckedAt: now });
    if (row?.status === 'PAID' && fact.state === 'REFUNDED') localRefunds.push({ rowId: row._id,
      preimage: row, fields: { status: 'REFUNDED', refundedAt: fact.refundProof.transactionRefundedAt,
        refundSumMinor: fact.refundProof.refundSumMinor, refundedSubscriptionId: fact.subscriptionId,
        annualHistoryRefundProof: fact.refundProof, updatedAt: now, lastCheckedAt: now } });
  }
  entries.sort((a,b) => a.transactionId.localeCompare(b.transactionId));
  const paid = entries.filter(e => annualHistory.counted(e.fact));
  const quotaAdjustment = counterKey === 'piter_friendship' ? 52 - paid.length : 0;
  if (quotaAdjustment < 0) fail('PITER_OPENING_EXCEEDS_52');
  const document = { _id: `inventory:${spec.inventoryId}`, inventoryId: spec.inventoryId, counterKey,
    documentType: counterKey === 'network_friendship' ? 'HUB_ATOMIC_INVENTORY_LEDGER' : 'PITER_ATOMIC_INVENTORY_LEDGER',
    schemaVersion: 3, ready: false, revision: 0, quotaAdjustment, baselineDigest: digest(entries),
    baselineCapturedAt: now, legacyPaymentRefs: paid.map(e => e.ref), reservations: [],
    history: { version: 1, accountingScope, openingPaidCount: paid.length, entries, settlements: [] },
    dailyDate: annualHistory.date(now), createdAt: now, updatedAt: now };
  Object.assign(document, annualHistory.counts(document));
  if (!annualHistory.validate(document)) fail('POSTIMAGE_INVALID');
  return { kind: 'ANNUAL_SUBSCRIPTION_HISTORY_OPENING_PLAN_V1', executionAuthorized: false,
    counterKey, inventoryId: spec.inventoryId, accountingScope, createdAt: now,
    expiresAt: new Date(Math.min(...captures) + 300_000).toISOString(), runtimeBinding,
    evidenceDigest: digest({ ledgerEvidence, providerEvidence, subscriptionEvidence, crossInventoryEvidence, productEvidence }),
    localRefunds, document, summary: { providerTransactions: entries.length,
      localRows: rows.length, paidCount: paid.length, quotaAdjustment,
      unpaidWatches: entries.filter(e => e.kind === 'UNPAID_WATCH').length,
      providerOnlyPaid: entries.filter(e => e.kind === 'PROVIDER_ONLY_PAID').length,
      dailyPaidCount: document.dailyPaidCount, dailyRemaining: Math.max(0, 1 - document.dailyPaidCount),
      remaining: Math.max(0, spec.totalLimit - paid.length), mutationPerformed: false } };
}
