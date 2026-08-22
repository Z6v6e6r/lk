#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = "audit_regional_subscription_sales";
const PAID_TOKENS = new Set(["PAID", "SUCCESS", "SUCCESSFUL", "COMPLETE", "COMPLETED"]);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const listFrom = (value) => {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["content", "data", "items", "rows", "results", "documents"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
};

const hashId = (value) => crypto
  .createHash("sha256")
  .update(String(value || ""))
  .digest("hex")
  .slice(0, 12);

const pickTransactionId = (value) => (
  toStr(value?.id)
  || toStr(value?.uuid)
  || toStr(value?.transactionId)
  || toStr(value?.paymentId)
  || toStr(value?.externalId)
);

const pickLedgerTransactionId = (value) => (
  toStr(value?.transactionId)
  || toStr(value?.paymentId)
  || toStr(value?.externalId)
  || toStr(value?.id)
  || toStr(value?.uuid)
);

const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const isPaidStatus = (value) => normalizeStatus(value)
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .some((token) => PAID_TOKENS.has(token));

const toFiniteNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const productLineMatches = (line, productId) => {
  if (!line || typeof line !== "object") return false;
  return [
    line.id,
    line.uuid,
    line.productId,
    line.subscriptionId,
    line.product?.id,
    line.product?.uuid,
  ].some((value) => toStr(value) === productId);
};

const transactionContainsProduct = (transaction, productId) => {
  if (toStr(transaction?.productId) === productId) return true;
  return listFrom(transaction?.products).some((line) => productLineMatches(line, productId));
};

export const classifyProviderTransaction = (transaction, productId) => {
  if (!pickTransactionId(transaction)) return "missing_transaction_id";
  if (!isPaidStatus(transaction?.status || transaction?.state || transaction?.paymentStatus)) {
    return "status_not_paid";
  }

  const refundSum = toFiniteNumber(transaction?.refundSum);
  if ((refundSum !== null && refundSum > 0) || toStr(transaction?.refundedAt)) return "refunded";
  if (!transactionContainsProduct(transaction, productId)) return "product_mismatch";

  const toPay = toFiniteNumber(transaction?.toPay);
  if (toPay !== null && toPay <= 0) return "zero_to_pay";
  return "billable";
};

const emptyProviderSummary = () => ({
  rows: 0,
  billableRows: 0,
  uniquePaidTransactions: 0,
  duplicates: 0,
  missingTransactionId: 0,
  statusNotPaid: 0,
  refunded: 0,
  productMismatch: 0,
  zeroToPay: 0,
});

const summarizeProviderReason = (summary, reason) => {
  if (reason === "billable") summary.billableRows += 1;
  else if (reason === "missing_transaction_id") summary.missingTransactionId += 1;
  else if (reason === "status_not_paid") summary.statusNotPaid += 1;
  else if (reason === "refunded") summary.refunded += 1;
  else if (reason === "product_mismatch") summary.productMismatch += 1;
  else if (reason === "zero_to_pay") summary.zeroToPay += 1;
};

const indexProviderTransactions = (payload, productId) => {
  const rows = listFrom(payload);
  const summary = emptyProviderSummary();
  summary.rows = rows.length;
  const byId = new Map();

  for (const row of rows) {
    const reason = classifyProviderTransaction(row, productId);
    summarizeProviderReason(summary, reason);
    if (reason !== "billable") continue;
    const transactionId = pickTransactionId(row);
    if (byId.has(transactionId)) {
      summary.duplicates += 1;
      continue;
    }
    byId.set(transactionId, row);
  }

  summary.uniquePaidTransactions = byId.size;
  return { byId, summary };
};

const indexLedgerTransactions = (payload, inventoryId) => {
  const rows = listFrom(payload);
  const byId = new Map();
  const summary = {
    rows: rows.length,
    paidInventoryRows: 0,
    uniquePaidTransactions: 0,
    duplicates: 0,
    missingTransactionId: 0,
    ignoredRows: 0,
  };

  for (const row of rows) {
    if (normalizeStatus(row?.status) !== "PAID" || toStr(row?.inventoryId) !== inventoryId) {
      summary.ignoredRows += 1;
      continue;
    }
    summary.paidInventoryRows += 1;
    const transactionId = pickLedgerTransactionId(row);
    if (!transactionId) {
      summary.missingTransactionId += 1;
      continue;
    }
    if (byId.has(transactionId)) {
      summary.duplicates += 1;
      continue;
    }
    byId.set(transactionId, row);
  }

  summary.uniquePaidTransactions = byId.size;
  return { byId, summary };
};

const counterSnapshot = (soldCount, batchSize, totalLimit) => {
  const remainingCount = Math.max(0, totalLimit - soldCount);
  const totalBatches = Math.ceil(totalLimit / batchSize);
  const batchIndex = Math.min(totalBatches, Math.floor(soldCount / batchSize) + 1);
  const batchRemaining = remainingCount === 0
    ? 0
    : Math.min(remainingCount, batchSize - (soldCount % batchSize));
  return { soldCount, remainingCount, batchIndex, batchRemaining };
};

const positiveInteger = (value, name) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

export const buildRegionalSubscriptionSalesAudit = ({
  providerPayload,
  ledgerPayload,
  counterKey,
  productId,
  inventoryId,
  batchSize,
  totalLimit,
  createdAt = new Date().toISOString(),
}) => {
  const normalizedCounterKey = toStr(counterKey);
  const normalizedProductId = toStr(productId);
  const normalizedInventoryId = toStr(inventoryId);
  if (!normalizedCounterKey) throw new Error("counterKey is required");
  if (!normalizedProductId) throw new Error("productId is required");
  if (!normalizedInventoryId) throw new Error("inventoryId is required");
  const normalizedBatchSize = positiveInteger(batchSize, "batchSize");
  const normalizedTotalLimit = positiveInteger(totalLimit, "totalLimit");

  const provider = indexProviderTransactions(providerPayload, normalizedProductId);
  const ledger = indexLedgerTransactions(ledgerPayload, normalizedInventoryId);
  const missingInLedger = [...provider.byId.keys()]
    .filter((transactionId) => !ledger.byId.has(transactionId))
    .map(hashId)
    .sort();
  const extraInLedger = [...ledger.byId.keys()]
    .filter((transactionId) => !provider.byId.has(transactionId))
    .map(hashId)
    .sort();

  return {
    createdAt,
    mode: "READ_ONLY_DRY_RUN",
    source: SOURCE,
    counterKey: normalizedCounterKey,
    configuration: {
      productIdHash: hashId(normalizedProductId),
      inventoryId: normalizedInventoryId,
      batchSize: normalizedBatchSize,
      totalLimit: normalizedTotalLimit,
    },
    provider: provider.summary,
    ledger: ledger.summary,
    drift: {
      detected: missingInLedger.length > 0 || extraInLedger.length > 0,
      missingInLedgerCount: missingInLedger.length,
      missingInLedgerTransactionHashes: missingInLedger,
      extraInLedgerCount: extraInLedger.length,
      extraInLedgerTransactionHashes: extraInLedger,
    },
    counters: {
      providerTruth: counterSnapshot(provider.byId.size, normalizedBatchSize, normalizedTotalLimit),
      ledgerView: counterSnapshot(ledger.byId.size, normalizedBatchSize, normalizedTotalLimit),
    },
    mutation: {
      supported: false,
      applied: false,
      note: "This command never writes to Viva or MongoDB.",
    },
  };
};

const printHelp = () => {
  console.log(`
audit_regional_subscription_sales (read-only)

Compares explicit Viva transaction and local ledger JSON exports. It never
loads credentials, calls a network service, writes files, or applies changes.

Usage:
  npm run subscriptions:audit-regional-sales -- \\
    --provider-file /absolute/path/viva-transactions.json \\
    --ledger-file /absolute/path/lk-sales.json \\
    --counter-key piter_friendship \\
    --product-id <exact-viva-product-id> \\
    --inventory-id piter_friendship_12m_2026_v1 \\
    --batch-size 100 \\
    --total-limit 400
`);
};

const readOption = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};

export const parseCliArgs = (args) => {
  if (args.includes("--apply")) {
    throw new Error("--apply is unsupported: this audit is permanently read-only");
  }
  const known = new Set([
    "--provider-file",
    "--ledger-file",
    "--counter-key",
    "--product-id",
    "--inventory-id",
    "--batch-size",
    "--total-limit",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith("--")) continue;
    if (!known.has(item)) throw new Error(`Unsupported option: ${item}`);
    index += 1;
  }
  return {
    providerFile: readOption(args, "--provider-file"),
    ledgerFile: readOption(args, "--ledger-file"),
    counterKey: readOption(args, "--counter-key"),
    productId: readOption(args, "--product-id"),
    inventoryId: readOption(args, "--inventory-id"),
    batchSize: readOption(args, "--batch-size"),
    totalLimit: readOption(args, "--total-limit"),
  };
};

const readJson = (filePath, name) => {
  const normalized = toStr(filePath);
  if (!normalized) throw new Error(`${name} is required`);
  return JSON.parse(fs.readFileSync(normalized, "utf8"));
};

export const main = (args = process.argv.slice(2)) => {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const options = parseCliArgs(args);
  const report = buildRegionalSubscriptionSalesAudit({
    providerPayload: readJson(options.providerFile, "--provider-file"),
    ledgerPayload: readJson(options.ledgerFile, "--ledger-file"),
    counterKey: options.counterKey,
    productId: options.productId,
    inventoryId: options.inventoryId,
    batchSize: options.batchSize,
    totalLimit: options.totalLimit,
  });
  console.log(JSON.stringify(report, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
