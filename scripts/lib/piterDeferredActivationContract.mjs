import { PITER_ATOMIC_ACTIVATION as TARGET, classifyPiterPaidProviderTransaction,
  derivePiterLegacyBaseline, sha256, stableJson } from './piterAtomicActivationContract.mjs';

export { sha256, stableJson };
export const DEFERRED = Object.freeze({
  kind: 'PADLHUB_PITER_DEFERRED_ACTIVATION_V1',
  attestationKind: 'PADLHUB_PITER_LEGACY_TERMINAL_ATTESTATION_V1',
  productId: '8bf334ba-3050-4017-b40a-7eef2db1eb16',
  deploymentId: 'piter-only-graph-20260905',
  sourceSha256: 'e38f844343ef290aa49f2583861dfc4488031b97d303ccbe36b3a5e12c292ec3',
  candidateSha256: '5b098143325f249eb466f76ad76776a97f54b3c90e51b6c11eac3e8a62d29be8',
  forwardContractSha256: 'ed9c5904ed27348a63b6a680835af261a072bb136c19ae3e130481ca5bcf9d43',
  runtimeSourceTree: '52ccd473459df5bba76da374ef3e20925802c5b9',
  maxAgeMs: 300_000, maxSkewMs: 60_000,
});

// Exact historical record pins; never supplied by a caller, CLI or environment.
// Any provider record change requires a new reviewed source change, not tolerance.
const REFUND_PINS = Object.freeze([
  Object.freeze({ transactionSha256: '5a767f0afc30be3391d4320837c2659c01f422ceaa7076543c5d120a1d988ab4',
    subscriptionSha256: 'bbdfa1edbac637a2e8bf57c4185b40e0f0feb8eba7afce7a64428ab0340c832d', hasLocal: false }),
  Object.freeze({ transactionSha256: 'd0f1d173fc4b6bc7518b552751650af0a3414382ceea4b1057bf743630ff1079',
    subscriptionSha256: 'dcfa52f47214270df63891a47d792e26f6303efaf25ee3e7cec0c0ce502d70db', hasLocal: true }),
]);
const fail = code => { throw new Error(`Piter deferred contract: ${code}`); };
const eq = (a, b) => stableJson(a) === stableJson(b);
// Match the JSON snapshot collector, including BSON Date/ObjectId toJSON values.
const jsonValue = value => JSON.parse(JSON.stringify(value));
const digest = value => sha256(stableJson(jsonValue(value)));
const str = v => typeof v === 'string' && v.trim() === v && v.length > 0 ? v : null;
const status = v => str(v)?.toUpperCase();
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const hex = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const time = v => {
  if (!str(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) fail('EXACT_TIME');
  return Date.parse(v);
};
const aliases = (values, required = true) => {
  const present = values.filter(v => v !== undefined && v !== null && v !== '');
  if ((!present.length && required) || present.some(v => !str(v) || v !== present[0])) fail('IDENTITY_ALIASES');
  return present[0] ?? null;
};
const transactionId = t => aliases([t.transactionId, t.paymentId, t.externalId, t.id, t.uuid]);
const clientId = t => aliases([t.clientId, t.client?.id, t.client?.uuid, t.client?.clientId]);
const productId = p => aliases([p.id, p.uuid, p.productId, p.subscriptionId, p.product?.id, p.product?.uuid]);
const providerStatus = t => aliases([t.status, t.state, t.paymentStatus]);
const phone = v => {
  if (v == null || v === '') return null;
  let n = String(v).replace(/\D/g, '');
  if (n.length === 10) n = `7${n}`;
  if (n.length === 11 && n[0] === '8') n = `7${n.slice(1)}`;
  if (!/^7\d{10}$/.test(n)) fail('PHONE_SHAPE');
  return n;
};
const phoneOf = t => {
  const values = [t.clientPhone, t.client?.phone, t.client?.mobile, t.client?.phoneNumber].map(phone).filter(Boolean);
  if (values.some(v => v !== values[0])) fail('PHONE_ALIASES');
  return values[0] ?? null;
};
const positiveInt = v => Number.isSafeInteger(v) && v > 0;

export const digestDeferredDocuments = rows => digest(jsonValue(rows).sort((a, b) => stableJson(a).localeCompare(stableJson(b))));

// Pure subordinate verifier for synthetic tests; it cannot build/authorize a packet.
export function validateDeferredRefundCaseAgainstExpectedPin({ transaction: t, subscription: s, hasLocal }, pin) {
  if (!isObject(t) || !isObject(s) || typeof hasLocal !== 'boolean'
    || !hex(pin?.transactionSha256) || !hex(pin?.subscriptionSha256)
    || digest(t) !== pin.transactionSha256 || digest(s) !== pin.subscriptionSha256 || hasLocal !== pin.hasLocal) fail('REFUND_PIN');
  const tid = transactionId(t), cid = clientId(t);
  if (!['REFUND', 'REFUNDED'].includes(providerStatus(t))
    || aliases([s.status, s.subscriptionStatus, s.state]) !== 'REFUNDED'
    || aliases([s.transactionId, s.transactionUuid, s.transaction?.id, s.transaction?.uuid, s.transaction?.transactionId]) !== tid
    || aliases([s.productId, s.subscriptionProductId, s.product?.id, s.product?.uuid]) !== DEFERRED.productId
    || (aliases([s.clientId, s.client?.id], false) && aliases([s.clientId, s.client?.id], false) !== cid)
    || !Array.isArray(t.products) || t.products.length !== 1 || productId(t.products[0]) !== DEFERRED.productId
    || !positiveInt(t.refundSum) || s.refundSum !== t.refundSum || t.refundSum > t.toPay
    || !str(t.refundedAt) || !str(s.refundedAt) || t.refundedAt === s.refundedAt
    || !Number.isFinite(Date.parse(t.refundedAt)) || !Number.isFinite(Date.parse(s.refundedAt))) fail('REFUND_FACTS');
  const sid = aliases([s.subscriptionId, s.clientSubscriptionId, s.id, s.uuid]);
  return { transactionId: tid, subscriptionId: sid, clientId: cid, productId: DEFERRED.productId,
    refundSumMinor: t.refundSum, providerStatus: providerStatus(t), subscriptionStatus: 'REFUNDED',
    providerRefundedAt: t.refundedAt, subscriptionRefundedAt: s.refundedAt,
    ...pin, disposition: hasLocal ? 'LOCAL_PAID_REFUND_EXCLUDED' : 'PROVIDER_ONLY_REFUND_EXCLUDED' };
}

export function validateProductionDeferredRefundCases(cases) {
  if (!Array.isArray(cases) || cases.length !== 2) fail('EXACT_TWO_REFUNDS');
  const remaining = new Map(REFUND_PINS.map(p => [p.transactionSha256, p]));
  const verified = cases.map(c => {
    const key = digest(c.transaction), pin = remaining.get(key);
    if (!pin) fail('REFUND_SET');
    remaining.delete(key);
    return validateDeferredRefundCaseAgainstExpectedPin(c, pin);
  });
  if (remaining.size) fail('REFUND_SET');
  return verified.sort((a, b) => a.transactionSha256.localeCompare(b.transactionSha256));
}

function snapshot(e, source, query, rowsKey, now) {
  if (!isObject(e) || e.formatVersion !== 1 || e.source !== source || e.complete !== true || !eq(e.query, query)
    || !Array.isArray(e[rowsKey]) || !e.pagination || e.pagination.complete !== true
    || !positiveInt(e.pagination.pages) || e.pagination.rowCount !== e[rowsKey].length) fail('SNAPSHOT_SCOPE_OR_PAGES');
  const captured = time(e.capturedAt);
  if (captured > now || now - captured >= DEFERRED.maxAgeMs) fail('STALE_SNAPSHOT');
  return e[rowsKey];
}

function finance(t, row) {
  const line = t.products?.[0];
  if (t.products?.length !== 1 || productId(line) !== DEFERRED.productId
    || (t.productId != null && t.productId !== DEFERRED.productId)
    || t.sum !== TARGET.providerCostMinor || line.cost !== TARGET.providerCostMinor || line.count !== 1
    || !Number.isSafeInteger(t.discount) || t.discount < 0 || line.discount !== t.discount
    || !Number.isSafeInteger(t.toPay) || t.toPay < 0 || t.toPay + t.discount !== t.sum) fail('FINANCIAL_FACTS');
  clientId(t); phoneOf(t);
  if (row && (row.productId !== DEFERRED.productId || row.amountMinor !== t.toPay || row.amountMinor <= 0
    || row.providerProductCostMinor !== t.sum || row.discountMinor !== t.discount
    || (!str(row.clientId) && !phone(row.clientPhone))
    || (row.clientId && row.clientId !== clientId(t))
    || (row.clientPhone && phone(row.clientPhone) !== phoneOf(t)))) fail('LOCAL_FINANCIAL_CLIENT_FACTS');
}

export function buildPiterDeferredAttestation(input) {
  const { ledgerEvidence, providerEvidence, subscriptionEvidence, createdAt } = input;
  if (!eq(Object.keys(input).sort(), ['createdAt','ledgerEvidence','providerEvidence','subscriptionEvidence'].sort())) fail('UNEXPECTED_INPUT');
  const now = time(createdAt);
  const rows = snapshot(ledgerEvidence, 'MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES',
    { inventoryId: TARGET.inventoryId, counterKey: TARGET.counterKey }, 'rows', now);
  const transactions = snapshot(providerEvidence, 'VIVA_TRANSACTIONS', { productId: DEFERRED.productId }, 'transactions', now);
  const byTid = new Map(), byLocal = new Map(), refs = new Set(), ids = new Set();
  for (const t of transactions) {
    if (!isObject(t)) fail('PROVIDER_ROW');
    const id = transactionId(t);
    if (byTid.has(id)) fail('DUPLICATE_PROVIDER');
    finance(t); byTid.set(id, t);
  }
  for (const row of rows) {
    if (!isObject(row) || !str(row._id) || row._id === TARGET.ledgerId || row._id.startsWith('piter-sale:')
      || row.inventoryId !== TARGET.inventoryId || row.counterKey !== TARGET.counterKey
      || !str(row.paymentRef) || refs.has(row.paymentRef) || ids.has(row._id)) fail('LOCAL_SCOPE_ID_OR_ATTEMPT');
    const tid = transactionId({ transactionId: row.transactionId, paymentId: row.paymentId });
    aliases([row.status, row.paymentStatus]);
    if (byLocal.has(tid) || !byTid.has(tid)) fail('LOCAL_TRANSACTION_SET');
    finance(byTid.get(tid), row); byLocal.set(tid, row); refs.add(row.paymentRef); ids.add(row._id);
  }
  const refundTransactions = transactions.filter(t => ['REFUND','REFUNDED'].includes(providerStatus(t)));
  const refundIds = refundTransactions.map(transactionId).sort();
  const clients = snapshot(subscriptionEvidence, 'VIVA_CLIENT_SUBSCRIPTIONS',
    { productId: DEFERRED.productId, transactionIds: refundIds, includeFinished: true }, 'clients', now);
  const seenClients = new Set(), matches = new Map(refundIds.map(id => [id, []]));
  for (const c of clients) {
    if (!str(c.clientId) || seenClients.has(c.clientId) || c.complete !== true || !Array.isArray(c.subscriptions)
      || c.pagination?.complete !== true || !positiveInt(c.pagination.pages)
      || c.pagination.rowCount !== c.subscriptions.length) fail('SUBSCRIPTION_PAGES');
    seenClients.add(c.clientId);
    for (const s of c.subscriptions) {
      const explicitIds = [s.transactionId, s.transactionUuid, s.transaction?.id, s.transaction?.uuid, s.transaction?.transactionId].filter(Boolean);
      for (const tid of refundIds) if (explicitIds.includes(tid)) {
        if (clientId(byTid.get(tid)) !== c.clientId) fail('SUBSCRIPTION_CLIENT');
        matches.get(tid).push(s);
      }
    }
  }
  if (!eq([...seenClients].sort(), [...new Set(refundTransactions.map(clientId))].sort())) fail('SUBSCRIPTION_CLIENT_SCOPE');
  const cases = validateProductionDeferredRefundCases(refundTransactions.map(t => {
    const tid = transactionId(t), list = matches.get(tid);
    if (list.length !== 1) fail('SUBSCRIPTION_LINK_CARDINALITY');
    return { transaction: t, subscription: list[0], hasLocal: byLocal.has(tid) };
  }));
  const paidRows = [], paidTransactions = [], terminal = [], freeIssues = [];
  for (const t of transactions) {
    const tid = transactionId(t), row = byLocal.get(tid), state = providerStatus(t);
    let classification;
    if (['PAID','SUCCESS','SUCCEEDED','COMPLETE','COMPLETED','APPROVED'].includes(state)) {
      classification = classifyPiterPaidProviderTransaction(t, DEFERRED.productId, time(providerEvidence.capturedAt));
      if (classification === 'FREE_ISSUE') {
        if (row) fail('FREE_ISSUE_LOCAL_ROW');
        freeIssues.push({ transactionSha256: digest(t), transactionId: tid });
      } else {
        if (!row || !['PAID','SUCCESS','SUCCEEDED','COMPLETE','COMPLETED','APPROVED'].includes(status(row.status))
          || row.refundedAt || row.refundSumMinor
          || (row.paidAt && (!Number.isFinite(Date.parse(row.paidAt)) || Date.parse(row.paidAt) > time(ledgerEvidence.capturedAt)))) fail('CASH_PAID_LOCAL_STATE');
        paidRows.push(row); paidTransactions.push(t);
      }
    } else if (state === 'UNPAID') {
      if (!row || status(row.status) !== 'PAYMENT_PENDING' || !positiveInt(t.toPay)
        || !str(t.paymentDueDate) || !Number.isFinite(Date.parse(t.paymentDueDate))
        || Date.parse(t.paymentDueDate) > time(providerEvidence.capturedAt)
        || t.paymentDate || t.refundedAt || (t.refundSum != null && t.refundSum !== 0)
        || row.paidAt || row.refundedAt || row.refundSumMinor) fail('EXPIRED_UNPAID_FACTS');
      classification = 'PROVIDER_EXPIRED_UNPAID_LOCAL_UNCHANGED';
    } else if (['REFUND','REFUNDED'].includes(state)) {
      if (row && status(row.status) !== 'PAID') fail('PINNED_LOCAL_REFUND_STATE');
      classification = 'REFUND_TIMESTAMP_RECONCILIATION_DEFERRED';
    } else fail('UNRESOLVED_PROVIDER_STATE');
    terminal.push({ transactionId: tid, classification, providerSha256: digest(t), localSha256: row ? digest(row) : null });
  }
  const times = [ledgerEvidence, providerEvidence, subscriptionEvidence].map(e => time(e.capturedAt));
  if (Math.max(...times) - Math.min(...times) > DEFERRED.maxSkewMs) fail('CAPTURE_SKEW');
  // This helper derives CASH entries only; it never rewrites or creates evidence.
  const cash = derivePiterLegacyBaseline({ ledgerRows: paidRows, providerTransactions: paidTransactions,
    productId: DEFERRED.productId, providerCapturedAt: providerEvidence.capturedAt });
  if (cash.paidCount > 50) fail('CASH_BASELINE_EXCEEDS_INITIAL_QUOTA');
  const body = { kind: DEFERRED.attestationKind, formatVersion: 1, outcome: 'DEFERRED', mutationPerformed: false,
    createdAt, expiresAt: new Date(Math.min(...times) + DEFERRED.maxAgeMs).toISOString(),
    snapshots: { ledgerEvidence, providerEvidence, subscriptionEvidence },
    snapshotDigests: [ledgerEvidence, providerEvidence, subscriptionEvidence].map(digest),
    // Complete original envelopes bind pagination, all original timestamps and rows.
    refunds: cases, terminal: terminal.sort((a,b) => a.transactionId.localeCompare(b.transactionId)),
    providerOnlyFreeIssueCount: freeIssues.length, freeIssues: freeIssues.sort((a,b) => a.transactionId.localeCompare(b.transactionId)),
    baseline: { ...cash, legacyLedgerDigest: digestDeferredDocuments(rows) },
    launchQuota: { initialBatchRemaining: 50, batchSize: 100, adjustment: 50 - cash.paidCount } };
  return { ...body, attestationDigest: digest(body) };
}

export function validatePiterDeferredAttestation(a, { now = new Date() } = {}) {
  if (!isObject(a)) fail('ATTESTATION_REQUIRED');
  const rebuilt = buildPiterDeferredAttestation({ ...a.snapshots, createdAt: a.createdAt });
  if (!eq(a, rebuilt)) fail('ATTESTATION_RECOMPUTATION');
  const n = time(now instanceof Date ? now.toISOString() : now);
  if (n < time(a.createdAt) || n >= time(a.expiresAt)) fail('ATTESTATION_EXPIRED');
  return a;
}

export function buildPiterDeferredActivationPacket(input) {
  if (!eq(Object.keys(input).sort(), ['attestation','productEvidence','bindingEvidence','attemptEvidence','publication','createdAt'].sort())) fail('UNEXPECTED_PACKET_INPUT');
  const { attestation: a, productEvidence: p, bindingEvidence: b, attemptEvidence: attempts, publication, createdAt } = input;
  const now = time(createdAt);
  validatePiterDeferredAttestation(a, { now: createdAt });
  const products = snapshot(p, 'VIVA_PRODUCTS', { productId: DEFERRED.productId }, 'products', now);
  const bindings = snapshot(b, 'NODE_RED_GLOBAL_CONTEXT', { key: TARGET.productBindingKey }, 'values', now);
  const current = snapshot(attempts, 'MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES', {
    inventoryId: TARGET.inventoryId, counterKey: TARGET.counterKey, includeSentinel: true, includeAtomicSales: true,
  }, 'rows', now);
  if (digestDeferredDocuments(current) !== a.baseline.legacyLedgerDigest) fail('ATTEMPTS_OR_LEGACY_DRIFT');
  if (!hex(attempts.canonicalDocumentsSha256)) fail('CANONICAL_MONGO_CAPTURE_REQUIRED');
  if (products.length !== 1 || !isObject(products[0])) fail('PRODUCT_CARDINALITY');
  const product = products[0];
  const purchaseDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(p.capturedAt));
  const projectedDate = new Date(Date.parse(`${purchaseDate}T00:00:00.000Z`) + product.activationDays * 86400000);
  if (aliases([product.id, product.uuid]) !== DEFERRED.productId
    || aliases([product.productType, product.type]) !== 'SUBSCRIPTION'
    || product.cost !== TARGET.providerCostMinor || product.validityDays !== 365 || product.visits !== 365
    || !Number.isSafeInteger(product.activationDays) || product.activationDays < 0
    || !Number.isFinite(projectedDate.getTime()) || purchaseDate > TARGET.activationNotBeforeDate
    || projectedDate.toISOString().slice(0,10) < TARGET.activationNotBeforeDate) fail('PRODUCT_LIFECYCLE');
  if (!eq(bindings, [{ key: TARGET.productBindingKey, value: DEFERRED.productId }])) fail('PRODUCT_BINDING');
  if (!isObject(publication) || !eq(Object.keys(publication).sort(), ['runtimeSourceTree','sourceCommit','releaseManifestSha256','candidateSha256','forwardContractSha256'].sort())
    || publication.runtimeSourceTree !== DEFERRED.runtimeSourceTree || publication.candidateSha256 !== DEFERRED.candidateSha256
    || publication.forwardContractSha256 !== DEFERRED.forwardContractSha256
    || !/^[a-f0-9]{40}$/.test(publication.sourceCommit) || !hex(publication.releaseManifestSha256)) fail('PUBLICATION_BINDING');
  const allEvidence = [...Object.values(a.snapshots), p, b, attempts];
  const times = allEvidence.map(e => time(e.capturedAt));
  if (Math.max(...times) - Math.min(...times) > DEFERRED.maxSkewMs) fail('PACKET_CAPTURE_SKEW');
  const body = { kind: DEFERRED.kind, formatVersion: 1, createdAt,
    expiresAt: new Date(Math.min(...times) + DEFERRED.maxAgeMs).toISOString(),
    deployment: { deploymentId: DEFERRED.deploymentId, sourceSha256: DEFERRED.sourceSha256,
      candidateSha256: DEFERRED.candidateSha256, forwardContractSha256: DEFERRED.forwardContractSha256 },
    target: { collection:'lk_tournament_subscription_sales', ledgerId:TARGET.ledgerId,
      counterKey:TARGET.counterKey, inventoryId:TARGET.inventoryId, totalLimit:400, batchSize:100 },
    evidence: { ledgerCapturedAt:a.snapshots.ledgerEvidence.capturedAt, providerCapturedAt:a.snapshots.providerEvidence.capturedAt,
      subscriptionCapturedAt:a.snapshots.subscriptionEvidence.capturedAt, productCapturedAt:p.capturedAt,
      bindingCapturedAt:b.capturedAt, attemptsCapturedAt:attempts.capturedAt,
      snapshotDigests:allEvidence.map(digest), providerOnlyFreeIssueCount:a.providerOnlyFreeIssueCount,
      canonicalLegacyDocumentsSha256:attempts.canonicalDocumentsSha256 },
    attestation:a, baseline:a.baseline, launchQuota:a.launchQuota, product,
    inputs:{ productEvidence:p, bindingEvidence:b, attemptEvidence:attempts, publication },
    reconciliationOutcome:'DEFERRED', legacyMutationPerformed:false, publicationCustody:'REQUIRES_PROTECTED_READBACK' };
  return { ...body, contractDigest:digest(body) };
}

export function validatePiterDeferredActivationPacket(packet, { now = new Date(), allowExpired = false } = {}) {
  if (!isObject(packet) || packet.kind !== DEFERRED.kind || packet.formatVersion !== 1) fail('PACKET_KIND');
  const rebuilt = buildPiterDeferredActivationPacket({ ...packet.inputs, attestation:packet.attestation, createdAt:packet.createdAt });
  if (!eq(packet, rebuilt)) fail('PACKET_RECOMPUTATION');
  const n = time(now instanceof Date ? now.toISOString() : now);
  if (n < time(packet.createdAt) || (!allowExpired && n >= time(packet.expiresAt))) fail('PACKET_EXPIRED');
  return packet;
}

export function buildPiterDeferredSentinel(packet, createdAt) {
  validatePiterDeferredActivationPacket(packet, { now:createdAt });
  return { _id:TARGET.ledgerId, documentType:'PITER_ATOMIC_INVENTORY_LEDGER', schemaVersion:2,
    quotaAdjustment:packet.launchQuota.adjustment, inventoryId:TARGET.inventoryId, counterKey:TARGET.counterKey,
    ready:false, revision:0, paidCount:packet.baseline.paidCount, reservedCount:0, takenCount:packet.baseline.paidCount,
    baselineDigest:packet.baseline.digest, baselineCapturedAt:packet.evidence.ledgerCapturedAt,
    legacyPaymentRefs:[...packet.baseline.legacyPaymentRefs], reservations:[], activationContractDigest:packet.contractDigest,
    createdAt, updatedAt:createdAt };
}

export function redactPiterDeferredActivationPacket(packet) {
  validatePiterDeferredActivationPacket(packet, { now:packet.createdAt });
  return { kind:packet.kind, reconciliationOutcome:'DEFERRED', legacyMutationPerformed:false,
    paidCount:packet.baseline.paidCount, providerOnlyFreeIssueCount:packet.evidence.providerOnlyFreeIssueCount,
    deferredRefundCount:2, launchQuota:packet.launchQuota, contractDigest:packet.contractDigest,
    candidateSha256:packet.deployment.candidateSha256, createdAt:packet.createdAt, expiresAt:packet.expiresAt };
}

export function assertFreshDeferredProviderRecheck(evidence, packet, now) {
  const n = time(now instanceof Date ? now.toISOString() : now);
  const rows = snapshot(evidence, 'VIVA_TRANSACTIONS', { productId:DEFERRED.productId }, 'transactions', n);
  const captured = time(evidence.capturedAt);
  if (n - captured > 15_000 || captured < time(packet.createdAt)
    || digestDeferredDocuments(rows) !== digestDeferredDocuments(packet.attestation.snapshots.providerEvidence.transactions)) fail('PROVIDER_RECHECK_DRIFT_OR_STALE');
}

export function assertFreshDeferredActivationRecheck(bundle, packet, now) {
  if (!isObject(bundle) || !eq(Object.keys(bundle).sort(), ['providerEvidence','subscriptionEvidence','productEvidence','bindingEvidence'].sort())) fail('RECHECK_BUNDLE_SCOPE');
  assertFreshDeferredProviderRecheck(bundle.providerEvidence, packet, now);
  const expected = { subscriptionEvidence:packet.attestation.snapshots.subscriptionEvidence,
    productEvidence:packet.inputs.productEvidence, bindingEvidence:packet.inputs.bindingEvidence };
  const n = time(now instanceof Date ? now.toISOString() : now);
  for (const [key, original] of Object.entries(expected)) {
    const evidence = bundle[key], rowKey = key === 'subscriptionEvidence' ? 'clients' : key === 'productEvidence' ? 'products' : 'values';
    const rows = snapshot(evidence, original.source, original.query, rowKey, n);
    if (n - time(evidence.capturedAt) > 15_000 || time(evidence.capturedAt) < time(packet.createdAt)
      || digestDeferredDocuments(rows) !== digestDeferredDocuments(original[rowKey])) fail('EXTERNAL_RECHECK_DRIFT_OR_STALE');
  }
  const times = Object.values(bundle).map(e=>time(e.capturedAt));
  if (Math.max(...times)-Math.min(...times)>15_000) fail('RECHECK_CAPTURE_SKEW');
}
