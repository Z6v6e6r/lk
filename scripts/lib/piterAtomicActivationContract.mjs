import crypto from "node:crypto";

export const PITER_ATOMIC_ACTIVATION = Object.freeze({
  kind: "PADLHUB_PITER_ATOMIC_SALES_ACTIVATION_V1",
  counterKey: "piter_friendship",
  inventoryId: "piter_friendship_12m_2026_v1",
  ledgerId: "inventory:piter_friendship_12m_2026_v1",
  deploymentId: "piter-atomic-sales-20260903",
  productBindingKey: "summer_subscription_piter_friendship_product_id",
  totalLimit: 400,
  batchSize: 100,
  activationNotBeforeDate: "2026-10-01",
  providerCostMinor: 5_680_000,
  validityDays: 365,
  visits: 365,
  maxEvidenceAgeMs: 5 * 60 * 1000,
  maxEvidenceSkewMs: 60 * 1000,
});

const PAID_STATUSES = new Set(["PAID", "SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "APPROVED"]);
const FAILED_STATUSES = new Set(["FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const fail = (message) => {
  throw new Error(`Piter atomic activation contract failed: ${message}`);
};

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const toInteger = (value) => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return null;
};

const normalizeStatus = (value) => String(value || "").trim().toUpperCase();
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : null;
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
};

export const stableJson = (value) => JSON.stringify(canonicalize(value));
export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hashId = (value) => sha256(String(value || "")).slice(0, 12);

const parseIso = (value, label) => {
  const text = toStr(value);
  const timestamp = text ? Date.parse(text) : Number.NaN;
  if (!text || !Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail(`${label} must be an exact ISO timestamp`);
  }
  return { text, timestamp };
};

const assertFreshEvidence = (capturedAt, nowMs, label, maxAgeMs) => {
  const parsed = parseIso(capturedAt, `${label}.capturedAt`);
  if (parsed.timestamp > nowMs + 60_000) fail(`${label} is dated in the future`);
  if (nowMs - parsed.timestamp > maxAgeMs) fail(`${label} is stale`);
  return parsed.text;
};

const exactEvidence = (payload, rowsKey, label, expectedSource, expectedQuery, nowMs, maxAgeMs) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail(`${label} envelope is required`);
  if (payload.formatVersion !== 1 || payload.complete !== true) fail(`${label} must be a complete v1 snapshot`);
  if (payload.source !== expectedSource) fail(`${label}.source mismatch`);
  const capturedAt = assertFreshEvidence(payload.capturedAt, nowMs, label, maxAgeMs);
  if (!payload.query || typeof payload.query !== "object" || Array.isArray(payload.query)) {
    fail(`${label}.query is required`);
  }
  for (const [key, expected] of Object.entries(expectedQuery)) {
    if (payload.query[key] !== expected) fail(`${label}.query.${key} mismatch`);
  }
  if (stableJson(payload.query) !== stableJson(expectedQuery)) fail(`${label}.query scope is not exact`);
  if (!Array.isArray(payload[rowsKey])) fail(`${label}.${rowsKey} must be an array`);
  if (!payload.pagination || typeof payload.pagination !== "object" || Array.isArray(payload.pagination)
    || payload.pagination.complete !== true
    || !Number.isInteger(payload.pagination.pages) || payload.pagination.pages < 1
    || payload.pagination.rowCount !== payload[rowsKey].length) {
    fail(`${label}.pagination must prove a complete exact row count`);
  }
  return { capturedAt, rows: payload[rowsKey] };
};

const pickTransactionId = (value) => (
  toStr(value?.transactionId)
  || toStr(value?.paymentId)
  || toStr(value?.externalId)
  || toStr(value?.id)
  || toStr(value?.uuid)
);

const productLineMatches = (line, productId) => Boolean(line && typeof line === "object" && [
  line.id,
  line.uuid,
  line.productId,
  line.subscriptionId,
  line.product?.id,
  line.product?.uuid,
].some((value) => toStr(value) === productId));

const matchingProductLines = (transaction, productId) => (
  Array.isArray(transaction?.products)
    ? transaction.products.filter((line) => productLineMatches(line, productId))
    : []
);

const providerClientId = (transaction) => (
  toStr(transaction?.clientId)
  || toStr(transaction?.client?.id)
  || toStr(transaction?.client?.uuid)
  || toStr(transaction?.client?.clientId)
);

const providerClientPhone = (transaction) => normalizePhone(
  transaction?.clientPhone
  || transaction?.client?.phone
  || transaction?.client?.mobile
  || transaction?.client?.phoneNumber,
);

const transactionStatusClass = (transaction) => {
  const status = normalizeStatus(transaction?.status || transaction?.state || transaction?.paymentStatus);
  if (PAID_STATUSES.has(status)) return "PAID";
  if (FAILED_STATUSES.has(status)) return "FAILED";
  return "UNRESOLVED";
};

const assertNoRefund = (transaction) => {
  const refundSum = typeof transaction?.refundSum === "number" ? transaction.refundSum : null;
  if ((refundSum !== null && refundSum > 0) || toStr(transaction?.refundedAt)) {
    fail(`provider transaction ${hashId(pickTransactionId(transaction))} is refunded`);
  }
};

const toMoscowDate = (timestamp) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(timestamp));

const addLocalDateDays = (localDate, days) => {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
};

const normalizeProduct = (product, expectedProductId, capturedAt) => {
  if (!product || typeof product !== "object") fail("provider product is missing");
  const productId = toStr(product.id) || toStr(product.uuid);
  if (productId !== expectedProductId) fail("provider product ID mismatch");
  const productType = normalizeStatus(product.productType || product.type);
  const costMinor = toInteger(product.cost ?? product.costMinor);
  const activationDays = toInteger(product.activationDays);
  const validityDays = toInteger(product.validityDays);
  const visits = toInteger(product.visits);
  const purchaseDate = toMoscowDate(Date.parse(capturedAt));
  const projectedAutoActivationDate = Number.isInteger(activationDays) && activationDays >= 0
    ? addLocalDateDays(purchaseDate, activationDays)
    : null;
  if (productType !== "SUBSCRIPTION") fail("provider product type must be SUBSCRIPTION");
  if (costMinor !== PITER_ATOMIC_ACTIVATION.providerCostMinor) fail("provider product cost mismatch");
  if (!Number.isInteger(activationDays) || activationDays < 0) fail("provider activationDays must be a non-negative integer");
  if (validityDays !== PITER_ATOMIC_ACTIVATION.validityDays) fail("provider validityDays mismatch");
  if (visits !== PITER_ATOMIC_ACTIVATION.visits) fail("provider visits mismatch");
  if (purchaseDate > PITER_ATOMIC_ACTIVATION.activationNotBeforeDate) fail("provider activation window has closed");
  if (!projectedAutoActivationDate || projectedAutoActivationDate < PITER_ATOMIC_ACTIVATION.activationNotBeforeDate) {
    fail("provider product can activate before the required date");
  }
  return {
    id: productId,
    idHash: hashId(productId),
    productType,
    costMinor,
    activationDays,
    validityDays,
    visits,
    purchaseDate,
    projectedAutoActivationDate,
    activationNotBeforeDate: PITER_ATOMIC_ACTIVATION.activationNotBeforeDate,
  };
};

const validateCandidateReport = (report) => {
  if (!report || typeof report !== "object" || Array.isArray(report)) fail("candidate report is required");
  if (report.ok !== true || report.deploymentId !== PITER_ATOMIC_ACTIVATION.deploymentId) {
    fail("candidate report identity mismatch");
  }
  if (report.ledgerActivationRequired !== true || report.deploymentPerformed !== false || report.activationPerformed !== false) {
    fail("candidate report activation boundary mismatch");
  }
  for (const key of ["sourceSha256", "candidateSha256"]) {
    if (!SHA256_PATTERN.test(String(report[key] || ""))) fail(`candidate report ${key} is invalid`);
  }
  if (!Number.isInteger(report.sourceNodeCount) || report.sourceNodeCount < 1
    || !Number.isInteger(report.candidateNodeCount) || report.candidateNodeCount <= report.sourceNodeCount) {
    fail("candidate report node counts are invalid");
  }
  return {
    deploymentId: report.deploymentId,
    sourceSha256: report.sourceSha256,
    candidateSha256: report.candidateSha256,
    sourceNodeCount: toInteger(report.sourceNodeCount),
    candidateNodeCount: toInteger(report.candidateNodeCount),
  };
};

export function derivePiterLegacyBaseline({ ledgerRows, providerTransactions, productId }) {
  if (!Array.isArray(ledgerRows) || !Array.isArray(providerTransactions)) fail("baseline inputs must be arrays");
  const providerById = new Map();
  for (const transaction of providerTransactions) {
    const transactionId = pickTransactionId(transaction);
    if (!transactionId) fail("provider transaction is missing an ID");
    if (providerById.has(transactionId)) fail(`duplicate provider transaction ${hashId(transactionId)}`);
    const productLines = Array.isArray(transaction?.products) ? transaction.products : [];
    if (productLines.length !== 1 || !productLineMatches(productLines[0], productId)
      || (toStr(transaction?.productId) && toStr(transaction.productId) !== productId)) {
      fail(`provider transaction ${hashId(transactionId)} product mismatch`);
    }
    const statusClass = transactionStatusClass(transaction);
    if (statusClass === "UNRESOLVED") fail(`provider transaction ${hashId(transactionId)} is nonterminal`);
    if (statusClass === "PAID") {
      assertNoRefund(transaction);
      if (toInteger(transaction?.toPay) !== 0) {
        fail(`paid provider transaction ${hashId(transactionId)} has a nonzero balance`);
      }
    }
    providerById.set(transactionId, { transaction, statusClass });
  }

  const ledgerByTransactionId = new Map();
  const paymentRefs = new Set();
  const paidEntries = [];
  for (const row of ledgerRows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("ledger row must be an object");
    if (row._id === PITER_ATOMIC_ACTIVATION.ledgerId) fail("atomic sentinel already exists in baseline snapshot");
    if (toStr(row.inventoryId) !== PITER_ATOMIC_ACTIVATION.inventoryId
      || toStr(row.counterKey) !== PITER_ATOMIC_ACTIVATION.counterKey) {
      fail("ledger snapshot contains an out-of-scope row");
    }
    const transactionId = pickTransactionId(row);
    const paymentRef = toStr(row.paymentRef);
    if (!transactionId || !paymentRef) fail("legacy ledger row requires transactionId and paymentRef");
    if (ledgerByTransactionId.has(transactionId)) fail(`duplicate ledger transaction ${hashId(transactionId)}`);
    if (paymentRefs.has(paymentRef)) fail(`duplicate ledger paymentRef ${hashId(paymentRef)}`);
    ledgerByTransactionId.set(transactionId, row);
    paymentRefs.add(paymentRef);
    const provider = providerById.get(transactionId);
    if (!provider) fail(`ledger transaction ${hashId(transactionId)} is missing provider evidence`);
    const localStatus = normalizeStatus(row.status);
    const localStatusClass = PAID_STATUSES.has(localStatus)
      ? "PAID"
      : FAILED_STATUSES.has(localStatus) ? "FAILED" : "UNRESOLVED";
    if (localStatusClass === "UNRESOLVED") fail(`ledger transaction ${hashId(transactionId)} is nonterminal`);
    if (localStatusClass !== provider.statusClass) fail(`ledger/provider status mismatch for ${hashId(transactionId)}`);
    if (toStr(row.productId) !== productId) fail(`ledger product mismatch for ${hashId(transactionId)}`);
    if (localStatusClass === "PAID") {
      const amountMinor = toInteger(row.amountMinor);
      const providerProductCostMinor = toInteger(row.providerProductCostMinor);
      const discountMinor = toInteger(row.discountMinor);
      if (!Number.isInteger(amountMinor) || amountMinor <= 0) fail(`paid amount is invalid for ${hashId(transactionId)}`);
      if (providerProductCostMinor !== PITER_ATOMIC_ACTIVATION.providerCostMinor
        || !Number.isInteger(discountMinor) || discountMinor < 0
        || amountMinor + discountMinor !== providerProductCostMinor) {
        fail(`paid price composition is invalid for ${hashId(transactionId)}`);
      }
      const clientId = toStr(row.clientId);
      const clientPhone = normalizePhone(row.clientPhone);
      const providerId = providerClientId(provider.transaction);
      const providerPhone = providerClientPhone(provider.transaction);
      const productLines = matchingProductLines(provider.transaction, productId);
      if ((!clientId && !clientPhone)
        || (clientId && providerId !== clientId)
        || (clientPhone && providerPhone !== clientPhone)
        || toInteger(provider.transaction?.sum) !== amountMinor
        || productLines.length !== 1
        || toInteger(productLines[0]?.discount) !== discountMinor) {
        fail(`paid provider facts mismatch for ${hashId(transactionId)}`);
      }
      paidEntries.push({
        paymentRef,
        transactionId,
        productId,
        amountMinor,
        providerProductCostMinor,
        discountMinor,
        clientId,
        clientPhone,
      });
    }
  }

  for (const [transactionId, provider] of providerById) {
    if (provider.statusClass === "PAID") {
      const row = ledgerByTransactionId.get(transactionId);
      if (!row || !PAID_STATUSES.has(normalizeStatus(row.status))) {
        fail(`paid provider transaction ${hashId(transactionId)} is missing from the ledger`);
      }
    }
  }

  paidEntries.sort((left, right) => left.paymentRef.localeCompare(right.paymentRef));
  if (paidEntries.length > PITER_ATOMIC_ACTIVATION.totalLimit) fail("paid baseline exceeds inventory capacity");
  const digestSource = {
    formatVersion: 1,
    counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
    inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
    totalLimit: PITER_ATOMIC_ACTIVATION.totalLimit,
    entries: paidEntries,
  };
  return {
    digest: sha256(stableJson(digestSource)),
    paidCount: paidEntries.length,
    reservedCount: 0,
    takenCount: paidEntries.length,
    legacyPaymentRefs: paidEntries.map((entry) => entry.paymentRef),
    entries: paidEntries,
  };
}

export function buildPiterAtomicActivationPacket({
  ledgerEvidence,
  providerEvidence,
  productEvidence,
  bindingEvidence,
  candidateReport,
  productId,
  createdAt = new Date().toISOString(),
  maxEvidenceAgeMs = PITER_ATOMIC_ACTIVATION.maxEvidenceAgeMs,
}) {
  const created = parseIso(createdAt, "createdAt");
  const expectedProductId = toStr(productId);
  if (!expectedProductId) fail("productId is required");
  if (!Number.isInteger(maxEvidenceAgeMs) || maxEvidenceAgeMs < 60_000 || maxEvidenceAgeMs > 60 * 60 * 1000) {
    fail("maxEvidenceAgeMs must be between 1 and 60 minutes");
  }
  const ledger = exactEvidence(ledgerEvidence, "rows", "ledger evidence", "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES", {
    inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
    counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
  }, created.timestamp, maxEvidenceAgeMs);
  const provider = exactEvidence(providerEvidence, "transactions", "provider evidence", "VIVA_TRANSACTIONS", {
    productId: expectedProductId,
  }, created.timestamp, maxEvidenceAgeMs);
  const products = exactEvidence(productEvidence, "products", "product evidence", "VIVA_PRODUCTS", {
    productId: expectedProductId,
  }, created.timestamp, maxEvidenceAgeMs);
  const bindings = exactEvidence(bindingEvidence, "values", "binding evidence", "NODE_RED_GLOBAL_CONTEXT", {
    key: PITER_ATOMIC_ACTIVATION.productBindingKey,
  }, created.timestamp, maxEvidenceAgeMs);
  if (bindings.rows.length !== 1
    || bindings.rows[0]?.key !== PITER_ATOMIC_ACTIVATION.productBindingKey
    || toStr(bindings.rows[0]?.value) !== expectedProductId) {
    fail("Node-RED product binding mismatch");
  }
  const productMatches = products.rows.filter((item) => (toStr(item?.id) || toStr(item?.uuid)) === expectedProductId);
  if (productMatches.length !== 1 || products.rows.length !== 1) fail("product evidence must contain exactly the selected product");
  const product = normalizeProduct(productMatches[0], expectedProductId, products.capturedAt);
  const evidenceTimes = [ledger.capturedAt, provider.capturedAt, products.capturedAt, bindings.capturedAt].map(Date.parse);
  if (Math.max(...evidenceTimes) - Math.min(...evidenceTimes) > PITER_ATOMIC_ACTIVATION.maxEvidenceSkewMs) {
    fail("evidence snapshots exceed the allowed capture-time skew");
  }
  const candidate = validateCandidateReport(candidateReport);
  const baseline = derivePiterLegacyBaseline({
    ledgerRows: ledger.rows,
    providerTransactions: provider.rows,
    productId: expectedProductId,
  });
  const expiresAt = new Date(Math.min(
    Date.parse(ledger.capturedAt),
    Date.parse(provider.capturedAt),
    Date.parse(products.capturedAt),
    Date.parse(bindings.capturedAt),
  ) + maxEvidenceAgeMs).toISOString();
  if (Date.parse(expiresAt) <= created.timestamp) fail("evidence expires before packet creation");
  const packet = {
    formatVersion: 1,
    kind: PITER_ATOMIC_ACTIVATION.kind,
    createdAt: created.text,
    expiresAt,
    deployment: candidate,
    target: {
      collection: "lk_tournament_subscription_sales",
      ledgerId: PITER_ATOMIC_ACTIVATION.ledgerId,
      counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
      inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
      totalLimit: PITER_ATOMIC_ACTIVATION.totalLimit,
      batchSize: PITER_ATOMIC_ACTIVATION.batchSize,
    },
    evidence: {
      ledgerCapturedAt: ledger.capturedAt,
      providerCapturedAt: provider.capturedAt,
      productCapturedAt: products.capturedAt,
      bindingCapturedAt: bindings.capturedAt,
      ledgerSnapshotDigest: sha256(stableJson(ledger.rows)),
      providerSnapshotDigest: sha256(stableJson(provider.rows)),
      productSnapshotDigest: sha256(stableJson(products.rows)),
      bindingSnapshotDigest: sha256(stableJson(bindings.rows)),
    },
    product,
    binding: {
      key: PITER_ATOMIC_ACTIVATION.productBindingKey,
      productId: expectedProductId,
    },
    baseline,
  };
  return { ...packet, contractDigest: sha256(stableJson(packet)) };
}

export function validatePiterAtomicActivationPacket(packet, { now = new Date(), allowExpired = false } = {}) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) fail("packet object is required");
  if (packet.formatVersion !== 1 || packet.kind !== PITER_ATOMIC_ACTIVATION.kind) fail("packet identity mismatch");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (!Number.isFinite(nowMs)) fail("validation time is invalid");
  const created = parseIso(packet.createdAt, "packet.createdAt");
  const expires = parseIso(packet.expiresAt, "packet.expiresAt");
  if (!allowExpired && expires.timestamp <= nowMs) fail("packet evidence has expired");
  const { contractDigest, ...unsigned } = packet;
  if (!SHA256_PATTERN.test(String(contractDigest || "")) || sha256(stableJson(unsigned)) !== contractDigest) {
    fail("packet contract digest mismatch");
  }
  if (packet.deployment?.deploymentId !== PITER_ATOMIC_ACTIVATION.deploymentId
    || !SHA256_PATTERN.test(String(packet.deployment?.sourceSha256 || ""))
    || !SHA256_PATTERN.test(String(packet.deployment?.candidateSha256 || ""))
    || !Number.isInteger(packet.deployment?.sourceNodeCount) || packet.deployment.sourceNodeCount < 1
    || !Number.isInteger(packet.deployment?.candidateNodeCount)
    || packet.deployment.candidateNodeCount <= packet.deployment.sourceNodeCount) {
    fail("packet deployment contract mismatch");
  }
  const expectedTarget = {
    collection: "lk_tournament_subscription_sales",
    ledgerId: PITER_ATOMIC_ACTIVATION.ledgerId,
    counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
    inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
    totalLimit: PITER_ATOMIC_ACTIVATION.totalLimit,
    batchSize: PITER_ATOMIC_ACTIVATION.batchSize,
  };
  if (stableJson(packet.target) !== stableJson(expectedTarget)) fail("packet target mismatch");
  if (!packet.evidence || typeof packet.evidence !== "object" || Array.isArray(packet.evidence)) {
    fail("packet evidence receipts are required");
  }
  const evidenceTimes = ["ledgerCapturedAt", "providerCapturedAt", "productCapturedAt", "bindingCapturedAt"]
    .map((key) => parseIso(packet.evidence[key], `packet.evidence.${key}`).timestamp);
  if (Math.max(...evidenceTimes) - Math.min(...evidenceTimes) > PITER_ATOMIC_ACTIVATION.maxEvidenceSkewMs
    || Math.min(...evidenceTimes) + PITER_ATOMIC_ACTIVATION.maxEvidenceAgeMs !== expires.timestamp
    || Math.max(...evidenceTimes) > created.timestamp + 60_000
    || created.timestamp - Math.min(...evidenceTimes) > PITER_ATOMIC_ACTIVATION.maxEvidenceAgeMs) {
    fail("packet evidence receipt window mismatch");
  }
  for (const key of ["ledgerSnapshotDigest", "providerSnapshotDigest", "productSnapshotDigest", "bindingSnapshotDigest"]) {
    if (!SHA256_PATTERN.test(String(packet.evidence[key] || ""))) fail(`packet evidence ${key} is invalid`);
  }
  const normalizedProduct = normalizeProduct(packet.product, packet.product?.id, packet.evidence.productCapturedAt);
  if (stableJson(normalizedProduct) !== stableJson(packet.product)) fail("packet product contract mismatch");
  if (stableJson(packet.binding) !== stableJson({
    key: PITER_ATOMIC_ACTIVATION.productBindingKey,
    productId: packet.product.id,
  })) fail("packet Node-RED product binding mismatch");
  const entries = packet.baseline?.entries;
  if (!Array.isArray(entries)) fail("packet baseline entries are required");
  const recomputed = derivePiterLegacyBaseline({
    ledgerRows: entries.map((entry) => ({
      ...entry,
      counterKey: PITER_ATOMIC_ACTIVATION.counterKey,
      inventoryId: PITER_ATOMIC_ACTIVATION.inventoryId,
      status: "PAID",
    })),
    providerTransactions: entries.map((entry) => ({
      id: entry.transactionId,
      status: "PAID",
      toPay: 0,
      sum: entry.amountMinor,
      clientId: entry.clientId,
      clientPhone: entry.clientPhone,
      products: [{ id: entry.productId, discount: entry.discountMinor }],
    })),
    productId: packet.product?.id,
  });
  if (stableJson(recomputed) !== stableJson(packet.baseline)) fail("packet baseline mismatch");
  return packet;
}

export function buildPiterAtomicSentinel(packet, createdAt = new Date().toISOString()) {
  validatePiterAtomicActivationPacket(packet, { now: new Date(createdAt) });
  return {
    _id: packet.target.ledgerId,
    documentType: "PITER_ATOMIC_INVENTORY_LEDGER",
    schemaVersion: 1,
    inventoryId: packet.target.inventoryId,
    counterKey: packet.target.counterKey,
    ready: false,
    revision: 0,
    paidCount: packet.baseline.paidCount,
    reservedCount: 0,
    takenCount: packet.baseline.paidCount,
    baselineDigest: packet.baseline.digest,
    baselineCapturedAt: packet.evidence.ledgerCapturedAt,
    legacyPaymentRefs: [...packet.baseline.legacyPaymentRefs],
    reservations: [],
    activationContractDigest: packet.contractDigest,
    createdAt,
    updatedAt: createdAt,
  };
}

export function redactPiterAtomicActivationPacket(packet) {
  validatePiterAtomicActivationPacket(packet, { now: new Date(packet.createdAt) });
  return {
    ok: true,
    kind: packet.kind,
    createdAt: packet.createdAt,
    expiresAt: packet.expiresAt,
    deploymentId: packet.deployment.deploymentId,
    sourceSha256: packet.deployment.sourceSha256,
    candidateSha256: packet.deployment.candidateSha256,
    counterKey: packet.target.counterKey,
    inventoryId: packet.target.inventoryId,
    productIdHash: packet.product.idHash,
    productCostMinor: packet.product.costMinor,
    paidCount: packet.baseline.paidCount,
    baselineDigest: packet.baseline.digest,
    legacyPaymentRefHashes: packet.baseline.legacyPaymentRefs.map(hashId),
    contractDigest: packet.contractDigest,
    mutationPerformed: false,
  };
}
