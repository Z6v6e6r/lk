import { createHash } from 'node:crypto';
import { annualHistory } from './annualSubscriptionHistory.mjs';
import { subscriptionCounterEpoch as epoch } from './subscriptionCounterEpoch.mjs';
// Offline empty-inventory plan. Old inventories are neither queried nor changed.
// A deployment/maintenance grant, drain fence and installed source proof remain
// necessary; this function does not authorize or perform any live write.
export function buildEmptyCounterEpochOpening({ counterKey, startedAt, capturedAt, now, rows, product, flowSha256 }) {
  const spec = annualHistory.products[counterKey];
  const age = Date.parse(now) - Date.parse(capturedAt);
  if (!spec || !epoch.iso(startedAt) || !epoch.iso(now) || !epoch.iso(capturedAt)
    || !Number.isFinite(age) || age < 0 || age > 300000 || Date.parse(startedAt) > Date.parse(now)
    || !/^[a-f0-9]{64}$/.test(flowSha256 || '') || !Array.isArray(rows) || rows.length) throw Error('Fresh empty epoch evidence required');
  if (product?.id !== spec.productId || product.productType !== 'SUBSCRIPTION'
    || product.cost !== (counterKey === 'network_friendship' ? 9800000 : 5680000)
    || product.activationDays !== 1 || product.validityDays !== 365 || product.visits !== 365) throw Error('Epoch product drift');
  const inventoryId = epoch.inventories[counterKey], descriptor = epoch.descriptor(startedAt);
  const baselineDigest = createHash('sha256').update(annualHistory.stable({ inventoryId, epoch: descriptor, entries: [] })).digest('hex');
  const document = { _id: `inventory:${inventoryId}`, inventoryId, counterKey,
    documentType: counterKey === 'network_friendship' ? 'HUB_ATOMIC_INVENTORY_LEDGER' : 'PITER_ATOMIC_INVENTORY_LEDGER',
    schemaVersion: 3, ready: false, revision: 0, epoch: descriptor,
    quotaAdjustment: counterKey === 'piter_friendship' ? 52 : 0,
    baselineDigest, baselineCapturedAt: capturedAt, legacyPaymentRefs: [], reservations: [],
    history: { version: 1, accountingScope: 'NEW_EPOCH_RESERVATIONS_ONLY', openingPaidCount: 0, entries: [], settlements: [] },
    dailyDate: annualHistory.date(now), createdAt: now, updatedAt: now };
  Object.assign(document, annualHistory.counts(document));
  if (!annualHistory.validate(document)) throw Error('Invalid empty epoch postimage');
  return { kind: 'EMPTY_COUNTER_EPOCH_OPENING_PLAN_V1', executionAuthorized: false, mutationPerformed: false,
    flowSha256, capturedAt, expiresAt: new Date(Date.parse(capturedAt) + 300000).toISOString(),
    requiredQuery: { inventoryId }, requiresAdmissionDrain: true, requiresExclusiveDeploymentLock: true,
    document, insert: { operation: 'insertOne', document },
    activate: { operation: 'updateOne', filter: { _id: document._id, $expr: { $eq: ['$$ROOT', { $literal: document }] } },
      update: { $set: { ready: true, updatedAt: now }, $inc: { revision: 1 } }, options: { upsert: false } } };
}
