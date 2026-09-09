// Offline plan only. The execution owner must re-read under the existing deployment
// lock, verify the installed candidate and OFF flags, then execute one insert/CAS.
import { createHash } from 'node:crypto';
import { PITER_QUOTA48_UPDATE } from './piterAtomicQuotaUpdateContract.mjs';
export function buildHubAtomicOpeningPlan({ saleRows, capturedAt, now = new Date().toISOString(), product, activeFlowSha256 }) {
  const age = Date.parse(now) - Date.parse(capturedAt);
  if (!Number.isFinite(age) || age < 0 || age > 300_000) throw Error('HUB evidence must be at most five minutes old');
  if (activeFlowSha256 !== PITER_QUOTA48_UPDATE.candidateSha256) throw Error('HUB candidate is not installed');
  if (!Array.isArray(saleRows) || saleRows.length !== 0) throw Error('HUB inventory is not empty; reconcile without overwrite');
  if (product?.id !== 'db7a5250-7369-4f43-8ac5-9111be24bc74' || product.productType !== 'SUBSCRIPTION'
    || product.cost !== 9800000 || product.activationDays !== 1 || product.validityDays !== 365 || product.visits !== 365) throw Error('HUB product drift');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year:'numeric',month:'2-digit',day:'2-digit' })
    .formatToParts(new Date(now));
  const date = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const baselineDigest = createHash('sha256').update(JSON.stringify({inventoryId:'network_friendship_12m_2026_v1',entries:[]})).digest('hex');
  const document = { _id:'inventory:network_friendship_12m_2026_v1', documentType:'HUB_ATOMIC_INVENTORY_LEDGER',
    inventoryId:'network_friendship_12m_2026_v1', counterKey:'network_friendship', schemaVersion:1, ready:false,
    revision:0, baselineDigest, baselineCapturedAt:capturedAt, paidCount:0,reservedCount:0,takenCount:0,
    legacyPaymentRefs:[],reservations:[],dailyDate:`${date.year}-${date.month}-${date.day}`,
    dailyBaselinePaidCount:0,dailyPaidCount:0,dailyReservedCount:0,createdAt:now,updatedAt:now };
  return { kind:'HUB_EMPTY_INVENTORY_OPENING_PLAN_V1', activeFlowSha256, capturedAt,
    expiresAt:new Date(Date.parse(capturedAt)+300_000).toISOString(), collection:'lk_tournament_subscription_sales',
    requiredQuery:{inventoryId:document.inventoryId}, requiresExclusiveDeploymentLock:true, requiresSalesFlagsOff:true,
    insert:{operation:'insertOne',document},
    activate:{operation:'updateOne', filter:{...document}, update:{$set:{ready:true,updatedAt:now},$inc:{revision:1}}, options:{upsert:false}},
    deploymentPerformed:false, mutationPerformed:false };
}
