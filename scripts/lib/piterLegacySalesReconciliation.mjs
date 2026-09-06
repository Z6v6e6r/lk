import {
  PITER_ATOMIC_ACTIVATION,
  classifyPiterPaidProviderTransaction,
  digestPiterLegacyLedgerRows,
  hashId,
  projectPiterLegacyLedgerRow,
  sha256,
  stableJson,
} from "./piterAtomicActivationContract.mjs";

export const PITER_LEGACY_RECONCILIATION = Object.freeze({
  kind: "PADLHUB_PITER_LEGACY_SALES_RECONCILIATION_V1",
  markerKind: "PITER_LEGACY_SALE_RECONCILIATION_V1",
  deploymentId: PITER_ATOMIC_ACTIVATION.deploymentId,
  maxEvidenceAgeMs: 5 * 60 * 1000,
  maxEvidenceSkewMs: 60 * 1000,
  applyReceiptKind: "PADLHUB_PITER_LEGACY_SALES_RECONCILIATION_APPLY_RECEIPT_V1",
});

const PAID_STATUSES = new Set(["PAID", "SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "APPROVED"]);
const FAILED_STATUSES = new Set(["FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);
const REFUNDED_STATUSES = new Set(["REFUND", "REFUNDED"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const fail = (message) => {
  throw new Error(`Piter legacy reconciliation failed: ${message}`);
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toInteger = (value) => (typeof value === "number" && Number.isInteger(value) ? value : null);
const normalizeStatus = (value) => String(value || "").trim().toUpperCase();
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : null;
};

const parseIso = (value, label) => {
  const text = toStr(value);
  const timestamp = text ? Date.parse(text) : Number.NaN;
  if (!text || !Number.isFinite(timestamp)) fail(`${label} must be an ISO timestamp`);
  return { text, timestamp };
};

const exactEvidence = ({ payload, rowsKey, source, query, label, nowMs }) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail(`${label} envelope is required`);
  const captured = parseIso(payload.capturedAt, `${label}.capturedAt`);
  if (payload.formatVersion !== 1 || payload.complete !== true || payload.source !== source
    || stableJson(payload.query) !== stableJson(query)
    || captured.timestamp > nowMs + 60_000
    || nowMs - captured.timestamp > PITER_LEGACY_RECONCILIATION.maxEvidenceAgeMs
    || !Array.isArray(payload[rowsKey])
    || !payload.pagination || payload.pagination.complete !== true
    || !Number.isInteger(payload.pagination.pages) || payload.pagination.pages < 1
    || payload.pagination.rowCount !== payload[rowsKey].length) {
    fail(`${label} must be a fresh complete exact v1 snapshot`);
  }
  return { capturedAt: captured.text, capturedAtMs: captured.timestamp, rows: payload[rowsKey] };
};

const pickTransactionId = (value) => (
  toStr(value?.transactionId)
  || toStr(value?.paymentId)
  || toStr(value?.externalId)
  || toStr(value?.id)
  || toStr(value?.uuid)
);

const pickProviderClientId = (value) => (
  toStr(value?.clientId)
  || toStr(value?.client?.id)
  || toStr(value?.client?.uuid)
  || toStr(value?.client?.clientId)
);

const pickProviderClientPhone = (value) => normalizePhone(
  value?.clientPhone || value?.client?.phone || value?.client?.mobile || value?.client?.phoneNumber,
);

const productLineMatches = (line, productId) => Boolean(line && typeof line === "object" && [
  line.id,
  line.uuid,
  line.productId,
  line.subscriptionId,
  line.product?.id,
  line.product?.uuid,
].some((value) => toStr(value) === productId));

const pickSubscriptionId = (value) => (
  toStr(value?.subscriptionId) || toStr(value?.clientSubscriptionId) || toStr(value?.id) || toStr(value?.uuid)
);

const exactExplicitValues = (values, expected) => {
  const present = values.map(toStr).filter(Boolean);
  return present.length > 0 && present.every((value) => value === expected);
};

const subscriptionTransactionMatches = (subscription, transactionId) => exactExplicitValues([
  subscription?.transactionId,
  subscription?.transactionUuid,
  subscription?.transaction?.id,
  subscription?.transaction?.uuid,
  subscription?.transaction?.transactionId,
], transactionId);

const subscriptionProductMatches = (subscription, productId) => exactExplicitValues([
  subscription?.productId,
  subscription?.subscriptionProductId,
  subscription?.product?.id,
  subscription?.product?.uuid,
], productId);

const refundFacts = (transaction) => ({
  refundSumMinor: toInteger(transaction?.refundSum),
  refundedAt: toStr(transaction?.refundedAt),
});

const classifyProviderTransaction = (transaction, productId, capturedAtMs) => {
  const transactionId = pickTransactionId(transaction);
  if (!transactionId) fail("provider transaction ID is missing");
  const lines = Array.isArray(transaction?.products) ? transaction.products : [];
  if (lines.length !== 1 || !productLineMatches(lines[0], productId)
    || (toStr(transaction?.productId) && toStr(transaction.productId) !== productId)) {
    fail(`provider transaction ${hashId(transactionId)} product mismatch`);
  }
  const status = normalizeStatus(transaction?.status || transaction?.state || transaction?.paymentStatus);
  const refund = refundFacts(transaction);
  if (PAID_STATUSES.has(status)) {
    if ((refund.refundSumMinor !== null && refund.refundSumMinor > 0) || refund.refundedAt) {
      fail(`paid provider transaction ${hashId(transactionId)} contains refund evidence`);
    }
    const kind = classifyPiterPaidProviderTransaction(transaction, productId, capturedAtMs);
    return { kind, status, transactionId, line: lines[0] };
  }
  if (REFUNDED_STATUSES.has(status)) {
    if (!Number.isInteger(refund.refundSumMinor) || refund.refundSumMinor <= 0 || !refund.refundedAt
      || !Number.isFinite(Date.parse(refund.refundedAt))) {
      fail(`refunded provider transaction ${hashId(transactionId)} lacks exact refund evidence`);
    }
    return { kind: "REFUNDED", status, transactionId, line: lines[0], ...refund };
  }
  if (status === "UNPAID") {
    const due = parseIso(transaction?.paymentDueDate, `provider transaction ${hashId(transactionId)} paymentDueDate`);
    if (due.timestamp > capturedAtMs || toStr(transaction?.paymentDate)
      || (refund.refundSumMinor !== null && refund.refundSumMinor > 0) || refund.refundedAt
      || !Number.isInteger(toInteger(transaction?.toPay)) || toInteger(transaction?.toPay) <= 0) {
      fail(`provider transaction ${hashId(transactionId)} UNPAID state is not safely expired`);
    }
    return { kind: "EXPIRED_UNPAID", status, transactionId, line: lines[0], paymentDueDate: due.text };
  }
  if (FAILED_STATUSES.has(status)) return { kind: "FAILED", status, transactionId, line: lines[0] };
  fail(`provider transaction ${hashId(transactionId)} is nonterminal`);
};

const validateFinancialAndClientFacts = (row, provider, productId) => {
  const transactionHash = hashId(provider.transactionId);
  const amountMinor = toInteger(row?.amountMinor);
  const providerProductCostMinor = toInteger(row?.providerProductCostMinor);
  const discountMinor = toInteger(row?.discountMinor);
  if (toStr(row?.productId) !== productId
    || !Number.isInteger(amountMinor) || amountMinor <= 0
    || providerProductCostMinor !== PITER_ATOMIC_ACTIVATION.providerCostMinor
    || !Number.isInteger(discountMinor) || discountMinor < 0
    || amountMinor + discountMinor !== providerProductCostMinor
    || toInteger(provider.line?.discount) !== discountMinor) {
    fail(`ledger financial facts mismatch for ${transactionHash}`);
  }
  const localClientId = toStr(row?.clientId);
  const localPhone = normalizePhone(row?.clientPhone);
  const providerClientId = pickProviderClientId(provider.transaction);
  const providerPhone = pickProviderClientPhone(provider.transaction);
  if ((!localClientId && !localPhone)
    || (localClientId && providerClientId !== localClientId)
    || (localPhone && providerPhone !== localPhone)) {
    fail(`ledger/provider client mismatch for ${transactionHash}`);
  }
  if (provider.kind === "PAID" && (toInteger(provider.transaction?.toPay) !== amountMinor
    || toInteger(provider.transaction?.sum) !== providerProductCostMinor
    || toInteger(provider.transaction?.discount) !== discountMinor)) {
    fail(`paid provider amount mismatch for ${transactionHash}`);
  }
  if (provider.kind === "EXPIRED_UNPAID" && toInteger(provider.transaction?.toPay) !== amountMinor) {
    fail(`UNPAID provider balance mismatch for ${transactionHash}`);
  }
  if (provider.kind === "REFUNDED" && provider.refundSumMinor > amountMinor) {
    fail(`refund exceeds the paid amount for ${transactionHash}`);
  }
  if (provider.kind === "REFUNDED"
    && (toInteger(provider.transaction?.toPay) !== amountMinor
      || toInteger(provider.transaction?.sum) !== providerProductCostMinor)) {
    fail(`refunded provider amount mismatch for ${transactionHash}`);
  }
};

const indexRefundedSubscriptions = (clients, refundProviderById, productId) => {
  const byTransactionId = new Map();
  const seenClients = new Set();
  for (const snapshot of clients) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) fail("subscription client snapshot is invalid");
    const clientId = toStr(snapshot.clientId);
    if (!clientId || seenClients.has(clientId)) fail("subscription client snapshots contain a missing or duplicate client");
    seenClients.add(clientId);
    if (snapshot.complete !== true || !snapshot.pagination || snapshot.pagination.complete !== true
      || !Number.isInteger(snapshot.pagination.pages) || snapshot.pagination.pages < 1
      || !Array.isArray(snapshot.subscriptions)
      || snapshot.pagination.rowCount !== snapshot.subscriptions.length) {
      fail(`subscription snapshot for client ${hashId(clientId)} is incomplete`);
    }
    for (const subscription of snapshot.subscriptions) {
      const transactionMatches = [...refundProviderById.keys()].filter((transactionId) => (
        subscriptionTransactionMatches(subscription, transactionId)
      ));
      for (const transactionId of transactionMatches) {
        const provider = refundProviderById.get(transactionId);
        if (pickProviderClientId(provider.transaction) !== clientId
          || (toStr(subscription?.clientId) && toStr(subscription.clientId) !== clientId)
          || !subscriptionProductMatches(subscription, productId)
          || normalizeStatus(subscription?.status || subscription?.subscriptionStatus || subscription?.state) !== "REFUNDED"
          || !pickSubscriptionId(subscription)) {
          continue;
        }
        const current = byTransactionId.get(transactionId) || [];
        current.push({ clientId, subscription });
        byTransactionId.set(transactionId, current);
      }
    }
  }
  for (const [transactionId, provider] of refundProviderById) {
    const matches = byTransactionId.get(transactionId) || [];
    if (matches.length !== 1) fail(`refund subscription evidence is not exact for ${hashId(transactionId)}`);
    const subscription = matches[0].subscription;
    const subscriptionRefund = refundFacts(subscription);
    if (subscriptionRefund.refundSumMinor !== provider.refundSumMinor
      || subscriptionRefund.refundedAt !== provider.refundedAt) {
      fail(`refund subscription facts mismatch for ${hashId(transactionId)}`);
    }
  }
  return new Map([...byTransactionId].map(([transactionId, matches]) => [transactionId, matches[0]]));
};

const validateCandidateReport = (report) => {
  if (!report || typeof report !== "object" || Array.isArray(report)
    || report.ok !== true || report.deploymentId !== PITER_LEGACY_RECONCILIATION.deploymentId
    || report.ledgerActivationRequired !== true || report.deploymentPerformed !== false
    || report.activationPerformed !== false
    || !SHA256_PATTERN.test(String(report.sourceSha256 || ""))
    || !SHA256_PATTERN.test(String(report.candidateSha256 || ""))) {
    fail("candidate report identity mismatch");
  }
  return {
    deploymentId: report.deploymentId,
    sourceSha256: report.sourceSha256,
    candidateSha256: report.candidateSha256,
  };
};

const marker = ({ operationId, outcome, transactionId, provider, subscription, reconciledAt, evidenceDigest }) => ({
  kind: PITER_LEGACY_RECONCILIATION.markerKind,
  operationId,
  outcome,
  providerStatus: provider.status,
  transactionHash: hashId(transactionId),
  subscriptionHash: subscription ? hashId(pickSubscriptionId(subscription)) : null,
  evidenceDigest,
  reconciledAt,
});

const assertExistingReconciliationMarker = (row, outcome, transactionId) => {
  const existing = row?.piterLegacyReconciliation;
  if (existing?.kind !== PITER_LEGACY_RECONCILIATION.markerKind
    || existing?.outcome !== outcome
    || existing?.transactionHash !== hashId(transactionId)
    || !/^[a-f0-9]{32}$/.test(String(existing?.operationId || ""))
    || !SHA256_PATTERN.test(String(existing?.evidenceDigest || ""))) {
    fail(`existing reconciliation marker mismatch for ${hashId(transactionId)}`);
  }
};

export function buildPiterLegacyReconciliationPacket({
  ledgerEvidence,
  providerEvidence,
  subscriptionEvidence,
  candidateReport,
  productId,
  createdAt = new Date().toISOString(),
}) {
  const created = parseIso(createdAt, "createdAt");
  const expectedProductId = toStr(productId);
  if (!expectedProductId) fail("productId is required");
  const ledger = exactEvidence({
    payload: ledgerEvidence,
    rowsKey: "rows",
    source: "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES",
    query: { inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId, counterKey: PITER_ATOMIC_ACTIVATION.counterKey },
    label: "ledger evidence",
    nowMs: created.timestamp,
  });
  const provider = exactEvidence({
    payload: providerEvidence,
    rowsKey: "transactions",
    source: "VIVA_TRANSACTIONS",
    query: { productId: expectedProductId },
    label: "provider evidence",
    nowMs: created.timestamp,
  });
  const providerById = new Map();
  for (const transaction of provider.rows) {
    const classified = classifyProviderTransaction(transaction, expectedProductId, provider.capturedAtMs);
    if (providerById.has(classified.transactionId)) fail(`duplicate provider transaction ${hashId(classified.transactionId)}`);
    providerById.set(classified.transactionId, { ...classified, transaction });
  }
  const refundProviderById = new Map([...providerById].filter(([, item]) => item.kind === "REFUNDED"));
  const refundTransactionIds = [...refundProviderById.keys()].sort();
  const subscriptions = exactEvidence({
    payload: subscriptionEvidence,
    rowsKey: "clients",
    source: "VIVA_CLIENT_SUBSCRIPTIONS",
    query: { productId: expectedProductId, transactionIds: refundTransactionIds, includeFinished: true },
    label: "subscription evidence",
    nowMs: created.timestamp,
  });
  const evidenceTimes = [ledger.capturedAtMs, provider.capturedAtMs, subscriptions.capturedAtMs];
  if (Math.max(...evidenceTimes) - Math.min(...evidenceTimes) > PITER_LEGACY_RECONCILIATION.maxEvidenceSkewMs) {
    fail("evidence snapshots exceed the allowed capture-time skew");
  }
  const refundedSubscriptions = indexRefundedSubscriptions(
    subscriptions.rows,
    refundProviderById,
    expectedProductId,
  );
  const deployment = validateCandidateReport(candidateReport);
  const ledgerById = new Map();
  const paymentRefs = new Set();
  for (const row of ledger.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || toStr(row.inventoryId) !== PITER_ATOMIC_ACTIVATION.inventoryId
      || toStr(row.counterKey) !== PITER_ATOMIC_ACTIVATION.counterKey
      || row._id === PITER_ATOMIC_ACTIVATION.ledgerId
      || String(row._id || "").startsWith(`piter-sale:${PITER_ATOMIC_ACTIVATION.inventoryId}:`)) {
      fail("ledger snapshot contains a non-legacy or out-of-scope row");
    }
    const transactionId = pickTransactionId(row);
    const paymentRef = toStr(row.paymentRef);
    if (!transactionId || !paymentRef || ledgerById.has(transactionId) || paymentRefs.has(paymentRef)) {
      fail("ledger snapshot contains a missing or duplicate payment identity");
    }
    ledgerById.set(transactionId, row);
    paymentRefs.add(paymentRef);
  }
  const ledgerDigest = digestPiterLegacyLedgerRows(ledger.rows);
  const providerDigest = sha256(stableJson(provider.rows));
  const subscriptionDigest = sha256(stableJson(subscriptions.rows));
  const evidenceDigest = sha256(stableJson({ ledgerDigest, providerDigest, subscriptionDigest }));
  const operationId = sha256(stableJson({ evidenceDigest, createdAt: created.text, deployment })).slice(0, 32);
  const changes = [];
  const unchanged = { paid: 0, failed: 0, refunded: 0 };
  for (const [transactionId, row] of ledgerById) {
    const providerTransaction = providerById.get(transactionId);
    if (!providerTransaction) fail(`ledger transaction ${hashId(transactionId)} lacks provider evidence`);
    if (providerTransaction.kind === "FREE_ISSUE") fail(`free provider issue ${hashId(transactionId)} conflicts with the ledger`);
    validateFinancialAndClientFacts(row, providerTransaction, expectedProductId);
    const localStatus = normalizeStatus(row.status);
    if (providerTransaction.kind === "PAID") {
      if (!PAID_STATUSES.has(localStatus)) fail(`paid status mismatch for ${hashId(transactionId)}`);
      unchanged.paid += 1;
      continue;
    }
    if (providerTransaction.kind === "EXPIRED_UNPAID") {
      if (toStr(row.expiresAt) !== providerTransaction.paymentDueDate || toStr(row.paidAt)) {
        fail(`expired UNPAID deadline mismatch for ${hashId(transactionId)}`);
      }
      if (FAILED_STATUSES.has(localStatus)) {
        assertExistingReconciliationMarker(row, "PROVIDER_UNPAID_EXPIRED", transactionId);
        unchanged.failed += 1;
        continue;
      }
      if (localStatus !== "PAYMENT_PENDING") fail(`UNPAID local status mismatch for ${hashId(transactionId)}`);
      changes.push({
        action: "MARK_FAILED",
        transactionId,
        transactionHash: hashId(transactionId),
        paymentRef: toStr(row.paymentRef),
        fromStatus: localStatus,
        sourceUpdatedAt: toStr(row.updatedAt),
        preimageDigest: sha256(stableJson(projectPiterLegacyLedgerRow(row))),
        set: {
          status: "FAILED",
          paymentStatus: "FAILED",
          failureCode: "PROVIDER_UNPAID_EXPIRED",
          failedAt: created.text,
          lastCheckedAt: created.text,
          updatedAt: created.text,
          paidAt: null,
          piterLegacyReconciliation: marker({
            operationId,
            outcome: "PROVIDER_UNPAID_EXPIRED",
            transactionId,
            provider: providerTransaction,
            subscription: null,
            reconciledAt: created.text,
            evidenceDigest,
          }),
        },
      });
      continue;
    }
    if (providerTransaction.kind === "REFUNDED") {
      const subscription = refundedSubscriptions.get(transactionId)?.subscription;
      if (!subscription) fail(`refund subscription is missing for ${hashId(transactionId)}`);
      if (localStatus === "REFUNDED") {
        assertExistingReconciliationMarker(row, "PROVIDER_REFUNDED", transactionId);
        unchanged.refunded += 1;
        continue;
      }
      if (!PAID_STATUSES.has(localStatus)) fail(`refund local status mismatch for ${hashId(transactionId)}`);
      changes.push({
        action: "MARK_REFUNDED",
        transactionId,
        transactionHash: hashId(transactionId),
        paymentRef: toStr(row.paymentRef),
        fromStatus: localStatus,
        sourceUpdatedAt: toStr(row.updatedAt),
        preimageDigest: sha256(stableJson(projectPiterLegacyLedgerRow(row))),
        set: {
          status: "REFUNDED",
          paymentStatus: "REFUNDED",
          refundedAt: providerTransaction.refundedAt,
          refundSumMinor: providerTransaction.refundSumMinor,
          refundedSubscriptionId: pickSubscriptionId(subscription),
          lastCheckedAt: created.text,
          updatedAt: created.text,
          piterLegacyReconciliation: marker({
            operationId,
            outcome: "PROVIDER_REFUNDED",
            transactionId,
            provider: providerTransaction,
            subscription,
            reconciledAt: created.text,
            evidenceDigest,
          }),
        },
      });
      continue;
    }
    if (providerTransaction.kind === "FAILED" && FAILED_STATUSES.has(localStatus)) {
      unchanged.failed += 1;
      continue;
    }
    fail(`ledger/provider terminal status mismatch for ${hashId(transactionId)}`);
  }
  const providerOnlyRefunds = [];
  const providerOnlyFreeIssues = [];
  for (const [transactionId, providerTransaction] of providerById) {
    if (ledgerById.has(transactionId)) continue;
    if (providerTransaction.kind === "FREE_ISSUE") {
      providerOnlyFreeIssues.push({ transactionId, transactionHash: hashId(transactionId), reason: "FULL_DISCOUNT_ZERO_AMOUNT" });
      continue;
    }
    if (providerTransaction.kind !== "REFUNDED" || !refundedSubscriptions.has(transactionId)) {
      fail(`provider transaction ${hashId(transactionId)} is missing from the ledger`);
    }
    providerOnlyRefunds.push({
      transactionId,
      transactionHash: hashId(transactionId),
      subscriptionId: pickSubscriptionId(refundedSubscriptions.get(transactionId).subscription),
      subscriptionHash: hashId(pickSubscriptionId(refundedSubscriptions.get(transactionId).subscription)),
      status: providerTransaction.status,
    });
  }
  changes.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  providerOnlyRefunds.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  providerOnlyFreeIssues.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  const expiresAt = new Date(Math.min(...evidenceTimes) + PITER_LEGACY_RECONCILIATION.maxEvidenceAgeMs).toISOString();
  if (Date.parse(expiresAt) <= created.timestamp) fail("evidence expires before packet creation");
  const unsigned = {
    formatVersion: 1,
    kind: PITER_LEGACY_RECONCILIATION.kind,
    createdAt: created.text,
    expiresAt,
    operationId,
    deployment,
    target: {
      collection: "lk_tournament_subscription_sales",
      inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
      counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
      productId: expectedProductId,
    },
    evidence: {
      ledgerCapturedAt: ledger.capturedAt,
      providerCapturedAt: provider.capturedAt,
      subscriptionCapturedAt: subscriptions.capturedAt,
      ledgerDigest,
      providerDigest,
      subscriptionDigest,
      evidenceDigest,
      ledgerRowCount: ledger.rows.length,
      providerRowCount: provider.rows.length,
      subscriptionClientCount: subscriptions.rows.length,
    },
    expected: {
      unchanged,
      changeCount: changes.length,
      failedCount: changes.filter((item) => item.action === "MARK_FAILED").length,
      refundedCount: changes.filter((item) => item.action === "MARK_REFUNDED").length,
      providerOnlyRefundCount: providerOnlyRefunds.length,
      providerOnlyFreeIssueCount: providerOnlyFreeIssues.length,
      paidCountAfter: unchanged.paid,
    },
    changes,
    providerOnlyRefunds,
    providerOnlyFreeIssues,
  };
  return { ...unsigned, planDigest: sha256(stableJson(unsigned)) };
}

export function validatePiterLegacyReconciliationPacket(packet, { now = new Date(), allowExpired = false } = {}) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
    || packet.formatVersion !== 1 || packet.kind !== PITER_LEGACY_RECONCILIATION.kind) {
    fail("packet identity mismatch");
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) fail("validation time is invalid");
  const created = parseIso(packet.createdAt, "packet.createdAt");
  const expires = parseIso(packet.expiresAt, "packet.expiresAt");
  if (created.timestamp > nowMs + 60_000 || expires.timestamp <= created.timestamp
    || expires.timestamp - created.timestamp > PITER_LEGACY_RECONCILIATION.maxEvidenceAgeMs
    || (!allowExpired && expires.timestamp <= nowMs)) fail("packet is expired or future-dated");
  const { planDigest, ...unsigned } = packet;
  if (!SHA256_PATTERN.test(String(planDigest || "")) || sha256(stableJson(unsigned)) !== planDigest) {
    fail("packet plan digest mismatch");
  }
  if (packet.target?.collection !== "lk_tournament_subscription_sales"
    || packet.target?.inventoryId !== PITER_ATOMIC_ACTIVATION.inventoryId
    || packet.target?.counterKey !== PITER_ATOMIC_ACTIVATION.counterKey
    || !toStr(packet.target?.productId)
    || packet.deployment?.deploymentId !== PITER_LEGACY_RECONCILIATION.deploymentId
    || !SHA256_PATTERN.test(String(packet.deployment?.candidateSha256 || ""))
    || !Array.isArray(packet.changes) || packet.expected?.changeCount !== packet.changes.length
    || !Array.isArray(packet.providerOnlyRefunds)) {
    fail("packet contract mismatch");
  }
  if (!/^[a-f0-9]{32}$/.test(String(packet.operationId || ""))) fail("packet operation ID mismatch");
  const evidenceTimes = ["ledgerCapturedAt", "providerCapturedAt", "subscriptionCapturedAt"]
    .map((key) => parseIso(packet.evidence?.[key], `packet.evidence.${key}`).timestamp);
  if (Math.max(...evidenceTimes) - Math.min(...evidenceTimes) > PITER_LEGACY_RECONCILIATION.maxEvidenceSkewMs
    || Math.min(...evidenceTimes) + PITER_LEGACY_RECONCILIATION.maxEvidenceAgeMs !== expires.timestamp
    || Math.max(...evidenceTimes) > created.timestamp + 60_000
    || created.timestamp - Math.min(...evidenceTimes) > PITER_LEGACY_RECONCILIATION.maxEvidenceAgeMs) {
    fail("packet evidence window mismatch");
  }
  for (const key of ["ledgerDigest", "providerDigest", "subscriptionDigest", "evidenceDigest"]) {
    if (!SHA256_PATTERN.test(String(packet.evidence?.[key] || ""))) fail(`packet ${key} is invalid`);
  }
  const failedCount = packet.changes.filter((item) => item?.action === "MARK_FAILED").length;
  const refundedCount = packet.changes.filter((item) => item?.action === "MARK_REFUNDED").length;
  if (packet.expected.failedCount !== failedCount || packet.expected.refundedCount !== refundedCount
    || packet.expected.providerOnlyRefundCount !== packet.providerOnlyRefunds.length
    || !Number.isInteger(packet.expected.paidCountAfter) || packet.expected.paidCountAfter < 0) {
    fail("packet expected counts mismatch");
  }
  const transactionIds = new Set();
  const paymentRefs = new Set();
  for (const change of packet.changes) {
    const expectedStatus = change?.action === "MARK_FAILED" ? "FAILED"
      : change?.action === "MARK_REFUNDED" ? "REFUNDED" : null;
    const expectedOutcome = change?.action === "MARK_FAILED" ? "PROVIDER_UNPAID_EXPIRED" : "PROVIDER_REFUNDED";
    if (!expectedStatus || !toStr(change.transactionId) || !toStr(change.paymentRef)
      || transactionIds.has(change.transactionId) || paymentRefs.has(change.paymentRef)
      || change.transactionHash !== hashId(change.transactionId)
      || !SHA256_PATTERN.test(String(change.preimageDigest || ""))
      || normalizeStatus(change.set?.status) !== expectedStatus
      || normalizeStatus(change.set?.paymentStatus) !== expectedStatus
      || change.set?.piterLegacyReconciliation?.kind !== PITER_LEGACY_RECONCILIATION.markerKind
      || change.set.piterLegacyReconciliation.operationId !== packet.operationId
      || change.set.piterLegacyReconciliation.outcome !== expectedOutcome
      || change.set.piterLegacyReconciliation.transactionHash !== change.transactionHash
      || change.set.piterLegacyReconciliation.evidenceDigest !== packet.evidence.evidenceDigest) {
      fail("packet mutation contract mismatch");
    }
    transactionIds.add(change.transactionId);
    paymentRefs.add(change.paymentRef);
  }
  const providerOnlyIds = new Set();
  for (const item of packet.providerOnlyRefunds) {
    if (!toStr(item?.transactionId) || providerOnlyIds.has(item.transactionId)
      || item.transactionHash !== hashId(item.transactionId)
      || !toStr(item.subscriptionId) || item.subscriptionHash !== hashId(item.subscriptionId)
      || !REFUNDED_STATUSES.has(normalizeStatus(item.status))) {
      fail("packet provider-only refund contract mismatch");
    }
    providerOnlyIds.add(item.transactionId);
  }
  // Optional for pre-existing V1 packets without free issues; never a mutation.
  const freeIssues = packet.providerOnlyFreeIssues ?? [];
  if (!Array.isArray(freeIssues) || (packet.expected.providerOnlyFreeIssueCount ?? 0) !== freeIssues.length) {
    fail("packet provider-only free issue counts mismatch");
  }
  for (const item of freeIssues) {
    if (!toStr(item?.transactionId) || providerOnlyIds.has(item.transactionId) || transactionIds.has(item.transactionId)
      || item.transactionHash !== hashId(item.transactionId) || item.reason !== "FULL_DISCOUNT_ZERO_AMOUNT") {
      fail("packet provider-only free issue contract mismatch");
    }
    providerOnlyIds.add(item.transactionId);
  }
  return packet;
}

export function assertPiterLegacyReconciliationPreconditions(packet, rows, { now = new Date() } = {}) {
  validatePiterLegacyReconciliationPacket(packet, { now });
  if (!Array.isArray(rows)) fail("current ledger rows are required");
  const scoped = rows.filter((row) => (
    toStr(row?.inventoryId) === packet.target.inventoryId && toStr(row?.counterKey) === packet.target.counterKey
  ));
  if (scoped.length !== rows.length || scoped.some((row) => (
    row?._id === PITER_ATOMIC_ACTIVATION.ledgerId
    || String(row?._id || "").startsWith(`piter-sale:${packet.target.inventoryId}:`)
  ))) fail("current ledger contains out-of-scope or atomic rows");
  const digest = digestPiterLegacyLedgerRows(scoped);
  if (digest !== packet.evidence.ledgerDigest || scoped.length !== packet.evidence.ledgerRowCount) {
    fail("current ledger preimage drifted from the reviewed packet");
  }
  const byTransactionId = new Map(scoped.map((row) => [pickTransactionId(row), row]));
  if ((packet.providerOnlyFreeIssues || []).some((item) => byTransactionId.has(item.transactionId))) {
    fail("provider-only free issue conflicts with the current ledger");
  }
  for (const change of packet.changes) {
    const row = byTransactionId.get(change.transactionId);
    if (!row || normalizeStatus(row.status) !== change.fromStatus
      || toStr(row.paymentRef) !== change.paymentRef
      || toStr(row.updatedAt) !== change.sourceUpdatedAt
      || sha256(stableJson(projectPiterLegacyLedgerRow(row))) !== change.preimageDigest) {
      fail(`current ledger row drifted for ${change.transactionHash}`);
    }
  }
  return { rows: scoped, digest };
}

export function buildPiterLegacyReconciliationMutations(packet) {
  validatePiterLegacyReconciliationPacket(packet, { allowExpired: true });
  return packet.changes.map((change) => ({
    action: change.action,
    transactionHash: change.transactionHash,
    filter: {
      inventoryId: packet.target.inventoryId,
      counterKey: packet.target.counterKey,
      transactionId: change.transactionId,
      paymentRef: change.paymentRef,
      status: change.fromStatus,
      ...(change.sourceUpdatedAt
        ? { updatedAt: change.sourceUpdatedAt }
        : { updatedAt: { $exists: false } }),
    },
    update: { $set: change.set },
  }));
}

export function assertPiterLegacyReconciliationPostcondition(packet, rows, {
  expectedRows = null,
  serialize = stableJson,
} = {}) {
  validatePiterLegacyReconciliationPacket(packet, { allowExpired: true });
  if (!Array.isArray(rows)) fail("post-write ledger rows are required");
  const scoped = rows.filter((row) => (
    toStr(row?.inventoryId) === packet.target.inventoryId && toStr(row?.counterKey) === packet.target.counterKey
  ));
  if (scoped.length !== rows.length || scoped.length !== packet.evidence.ledgerRowCount
    || scoped.some((row) => row?._id === PITER_ATOMIC_ACTIVATION.ledgerId
      || String(row?._id || "").startsWith(`piter-sale:${packet.target.inventoryId}:`))) {
    fail("post-write ledger scope mismatch");
  }
  const byTransactionId = new Map(scoped.map((row) => [pickTransactionId(row), row]));
  if (byTransactionId.size !== scoped.length) fail("post-write ledger contains duplicate transaction identities");
  for (const change of packet.changes) {
    const row = byTransactionId.get(change.transactionId);
    const expectedStatus = change.action === "MARK_FAILED" ? "FAILED" : "REFUNDED";
    if (!row || normalizeStatus(row.status) !== expectedStatus
      || row.piterLegacyReconciliation?.kind !== PITER_LEGACY_RECONCILIATION.markerKind
      || row.piterLegacyReconciliation?.operationId !== packet.operationId
      || row.piterLegacyReconciliation?.evidenceDigest !== packet.evidence.evidenceDigest
      || Object.entries(change.set).some(([key, expected]) => stableJson(row[key]) !== stableJson(expected))) {
      fail(`post-write ledger row mismatch for ${change.transactionHash}`);
    }
  }
  const paidCount = scoped.filter((row) => PAID_STATUSES.has(normalizeStatus(row?.status))).length;
  const pendingCount = scoped.filter((row) => normalizeStatus(row?.status) === "PAYMENT_PENDING").length;
  if (paidCount !== packet.expected.paidCountAfter || pendingCount !== 0) fail("post-write ledger counts mismatch");
  if (expectedRows) {
    if (!Array.isArray(expectedRows) || typeof serialize !== "function") fail("exact postimage inputs are invalid");
    const exactDigest = (items) => sha256(stableJson(items.map((item) => serialize(item)).sort()));
    if (exactDigest(scoped) !== exactDigest(expectedRows)) fail("exact post-write ledger image mismatch");
  }
  return { paidCount, pendingCount, changedCount: packet.changes.length };
}

export function redactPiterLegacyReconciliationPacket(packet) {
  validatePiterLegacyReconciliationPacket(packet, { allowExpired: true });
  return {
    formatVersion: packet.formatVersion,
    kind: packet.kind,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
    operationId: packet.operationId,
    planDigest: packet.planDigest,
    deployment: packet.deployment,
    target: {
      collection: packet.target.collection,
      inventoryId: packet.target.inventoryId,
      counterKey: packet.target.counterKey,
      productIdHash: hashId(packet.target.productId),
    },
    evidence: packet.evidence,
    expected: packet.expected,
    changes: packet.changes.map((change) => ({
      action: change.action,
      transactionHash: change.transactionHash,
      fromStatus: change.fromStatus,
      toStatus: change.action === "MARK_FAILED" ? "FAILED" : "REFUNDED",
    })),
    providerOnlyRefunds: packet.providerOnlyRefunds.map((item) => ({
      transactionHash: item.transactionHash,
      subscriptionHash: item.subscriptionHash,
      status: item.status,
    })),
    providerOnlyFreeIssues: (packet.providerOnlyFreeIssues || []).map((item) => ({
      transactionHash: item.transactionHash,
      reason: item.reason,
    })),
    mutationPerformed: false,
  };
}
