import { createHash } from 'node:crypto';
import { annualHistory } from './annualSubscriptionHistory.mjs';

export const historyDigest = value => createHash('sha256').update(annualHistory.stable(value)).digest('hex');
const exact = (value, keys) => value && Object.keys(value).sort().join() === [...keys].sort().join();
const hashKeys = ['packetDigest', 'preimageDigest', 'postimageDigest', 'crossInventoryDigest', 'deployLeaseDigest', 'publicationDigest', 'flowSha256', 'hostIdentitySha256', 'mongoIdentitySha256', 'runtimeDefinitionDigest'];
const keys = ['kind', 'operationId', 'action', 'inventoryId', 'issuedAt', 'expiresAt', ...hashKeys];

export function validateHistoryMaintenanceGrant(grant, expected, { now, minRemainingMs = 10_000 } = {}) {
  if (!exact(grant, keys) || grant.kind !== 'ANNUAL_HISTORY_MAINTENANCE_GRANT_V1'
    || !/^[a-zA-Z0-9_-]{8,100}$/.test(grant.operationId || '')
    || !['reconcile-refunds', 'seed', 'activate'].includes(grant.action)
    || !Object.values(annualHistory.products).some(p => p.inventoryId === grant.inventoryId)
    || hashKeys.some(k => !/^[a-f0-9]{64}$/.test(grant[k] || '') || grant[k] !== expected[k])
    || ['operationId', 'action', 'inventoryId'].some(k => grant[k] !== expected[k])) throw Error('history maintenance grant scope mismatch');
  const start = Date.parse(grant.issuedAt), end = Date.parse(grant.expiresAt), clock = Date.parse(now);
  if (![start, end, clock].every(Number.isFinite) || end <= start || end - start > 300_000
    || start > clock || end - clock < minRemainingMs) throw Error('history maintenance grant expired or insufficient');
  return grant;
}

export function assertHistoryMaintenanceCustody({ grant, expected, initialRuntime, currentRuntime,
  publicationDigest, flowSha256, quiescence, lockHeld, now, minRemainingMs = 10_000 }) {
  validateHistoryMaintenanceGrant(grant, expected, { now, minRemainingMs });
  if (lockHeld !== true || publicationDigest !== expected.publicationDigest || flowSha256 !== expected.flowSha256
    || currentRuntime?.status !== 'stopped' || currentRuntime.pid !== 0 || currentRuntime.salesFlagsOff !== true
    || !Number.isSafeInteger(currentRuntime.restartCount) || currentRuntime.restartCount < 0
    || currentRuntime.definitionDigest !== expected.runtimeDefinitionDigest
    || annualHistory.stable(initialRuntime) !== annualHistory.stable(currentRuntime)) throw Error('history runtime/publication/lock custody drift');
  if (!exact(quiescence, ['kind', 'operationId', 'inventoryId', 'hostIdentitySha256', 'mongoIdentitySha256',
    'externalWritersPaused', 'runtimeStopped', 'checkedAt', 'expiresAt'])
    || quiescence.kind !== 'ANNUAL_HISTORY_QUIESCENCE_V1' || quiescence.externalWritersPaused !== true
    || quiescence.runtimeStopped !== true
    || ['operationId', 'inventoryId', 'hostIdentitySha256', 'mongoIdentitySha256'].some(k => quiescence[k] !== expected[k])
    || !Number.isFinite(Date.parse(quiescence.checkedAt)) || Date.parse(quiescence.checkedAt) > Date.parse(now)
    || Date.parse(now) - Date.parse(quiescence.checkedAt) > 60_000
    || !Number.isFinite(Date.parse(quiescence.expiresAt)) || Date.parse(quiescence.expiresAt) - Date.parse(now) < minRemainingMs
    || Date.parse(quiescence.expiresAt) > Date.parse(grant.expiresAt)) throw Error('history writer quiescence is unproven');
}

export function buildHistoryMaintenanceMutation({ opening, documents, action, now }) {
  if (opening.kind !== 'ANNUAL_SUBSCRIPTION_HISTORY_OPENING_PLAN_V1' || opening.executionAuthorized !== false
    || !annualHistory.validate(opening.document) || opening.document.ready !== false
    || opening.document.reservations.length || opening.document.history.settlements.length
    || !Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(opening.createdAt)
    || Date.parse(now) >= Date.parse(opening.expiresAt)) throw Error('fresh inactive opening plan required');
  const ledgerId = opening.document._id;
  if (!Array.isArray(documents) || documents.some(d => d.inventoryId !== opening.inventoryId)
    || new Set(documents.map(d => String(d._id))).size !== documents.length) throw Error('history inventory scope mismatch');
  const ledgers = documents.filter(d => d._id === ledgerId), rows = documents.filter(d => d._id !== ledgerId);
  const expectedRows = opening.document.history.entries.filter(e => e.localRowId).map(e => e.localPreimage);
  const ordered = list => [...list].sort((a,b) => String(a._id).localeCompare(String(b._id)));
  if (annualHistory.stable(ordered(rows)) !== annualHistory.stable(ordered(expectedRows))) throw Error('history row preimage mismatch');
  let after = structuredClone(documents), mutations = [];
  if (action === 'reconcile-refunds') {
    if (ledgers.length) throw Error('refund preparation must precede seed');
    for (const m of opening.localRefunds) {
      const row = after.find(r => r._id === m.rowId);
      if (!row || annualHistory.stable(row) !== annualHistory.stable(m.preimage) || row.status !== 'PAID'
        || m.fields.status !== 'REFUNDED') throw Error('history refund preimage mismatch');
      mutations.push({ type: 'updateOne', before: structuredClone(row), set: m.fields }); Object.assign(row, m.fields);
    }
  } else if (action === 'seed') {
    if (ledgers.length || opening.localRefunds.length) throw Error('seed requires absent sentinel and reconciled refunds');
    after.push(structuredClone(opening.document)); mutations.push({ type: 'insertOne', document: opening.document });
  } else if (action === 'activate') {
    const ledger = ledgers[0];
    const immutableEntries = l => l.history.entries.map(e => Object.fromEntries(Object.entries(e).filter(([key]) => !["lastCheckedAt", "lastAttemptAt"].includes(key))));
    if (ledgers.length !== 1 || !annualHistory.validate(ledger) || ledger.ready !== false
      || ledger.reservations.length || ledger.history.settlements.length || opening.localRefunds.length
      || ledger.quotaAdjustment !== opening.document.quotaAdjustment
      || ledger.history.openingPaidCount !== opening.document.history.openingPaidCount
      || annualHistory.stable(ledger.legacyPaymentRefs) !== annualHistory.stable(opening.document.legacyPaymentRefs)
      || annualHistory.stable(immutableEntries(ledger)) !== annualHistory.stable(immutableEntries(opening.document))) throw Error('activation history drift');
    mutations.push({ type: 'updateOne', before: ledger, set: { ready: true, revision: ledger.revision + 1, updatedAt: opening.createdAt } });
    Object.assign(after.find(d => d._id === ledgerId), mutations[0].set);
  } else throw Error('unsupported history maintenance action');
  return { action, inventoryId: opening.inventoryId, mutations, before: documents, after };
}

export function assertHistoryDeployLease(lease, now) {
  if (lease === null) return historyDigest(null);
  // Match the reviewed deploy owner's own expiry rule (readDeploymentLease):
  // only v2 soaking expires; applying/recovery/legacy-unknown never do. Preserve
  // the file and bind its digest instead of extending or unlinking it.
  if (!lease || lease.formatVersion !== 2 || lease.phase !== 'soaking'
    || typeof lease.deploymentId !== 'string' || !lease.deploymentId || typeof lease.token !== 'string' || !lease.token
    || !Number.isSafeInteger(lease.acquiredAtMs) || !Number.isSafeInteger(lease.expiresAtMs)
    || lease.expiresAtMs <= lease.acquiredAtMs || lease.expiresAtMs > Date.parse(now)
    || !/^[a-f0-9]{64}$/.test(lease.sourceSha256 || '') || !/^[a-f0-9]{64}$/.test(lease.candidateSha256 || '')) throw Error('existing deploy lease requires owner resolution');
  return historyDigest(lease);
}
