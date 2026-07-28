#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MongoClient } from "mongodb";

const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const DEFAULT_INVENTORY_ID = "ab_leto_2026_50_v1";
const DEFAULT_FROM_DATE = "2026-06-22";
const DEFAULT_COUNTER_KEYS = ["friendship", "sport", "academy", "ra"];
const SOURCE = "reconcile_ab_leto_viva_sales";

export const AB_LETO_PLAN_CONFIGS = {
  friendship: {
    counterKey: "friendship",
    inventoryId: DEFAULT_INVENTORY_ID,
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
    productCostMinor: 980000,
  },
  sport: {
    counterKey: "sport",
    inventoryId: DEFAULT_INVENTORY_ID,
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
    productCostMinor: 1980000,
  },
  academy: {
    counterKey: "academy",
    inventoryId: DEFAULT_INVENTORY_ID,
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
    productCostMinor: 2380000,
  },
  ra: {
    counterKey: "ra",
    inventoryId: DEFAULT_INVENTORY_ID,
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
    productCostMinor: 2380000,
  },
};

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

const hasFlag = (name) => argv.includes(name);

export const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const splitCsv = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitCsv(item));
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const asArray = (value) => (Array.isArray(value) ? value : []);

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toMoneyMinor = (value, fallback = 0) => {
  const parsed = toNum(value);
  if (parsed === null || parsed < 0) return fallback;
  return Math.max(0, Math.round(parsed));
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const pickObjectId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

export const pickTransactionId = (transaction) => (
  toStr(transaction?.id)
  || toStr(transaction?.uuid)
  || toStr(transaction?.transactionId)
  || toStr(transaction?.paymentId)
  || toStr(transaction?.externalId)
);

const pickPaymentDate = (transaction) => (
  toStr(transaction?.paymentDate)
  || toStr(transaction?.paidAt)
  || toStr(transaction?.createdAt)
  || toStr(transaction?.createDate)
  || toStr(transaction?.date)
  || toStr(transaction?.updatedAt)
);

const pickCreateDate = (transaction) => (
  toStr(transaction?.createDate)
  || toStr(transaction?.createdAt)
  || pickPaymentDate(transaction)
);

const toIsoOrNull = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const hashId = (value) => crypto
  .createHash("sha256")
  .update(String(value || ""))
  .digest("hex")
  .slice(0, 12);

export const parseMoscowBoundary = (value, endOfDay = false) => {
  const text = toStr(value);
  if (!text) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`
    : text;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid date: ${text}`);
  }
  return {
    input: text,
    requestValue: candidate,
    timestamp,
    iso: new Date(timestamp).toISOString(),
  };
};

const moscowDateKey = (timestamp = Date.now()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const map = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${map.year}-${map.month}-${map.day}`;
};

const readJsonFile = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const readFlow = (flowPath) => {
  const resolved = path.resolve(flowPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Flow file not found: ${resolved}`);
  }
  return readJsonFile(resolved);
};

const readMongoUriFromFlow = (flowPath) => {
  const flow = readFlow(flowPath);
  const node = asArray(flow).find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  return toStr(node?.uri);
};

const readVivaTokenBodyFromFlow = (flowPath) => {
  const flow = readFlow(flowPath);
  const source = asArray(flow)
    .map((node) => (typeof node?.func === "string" ? node.func : ""))
    .join("\n");
  return toStr(source.match(/grant_type=password&client_id=React-auth-dev&username=it@citysport\.pro&password=[^"\\\n]+/)?.[0]);
};

const rewriteToLocalhost = (uri, enabled) => {
  if (!enabled) return uri;
  return uri.replace(/@[^/?]+(?=\/)/, "@127.0.0.1:27017");
};

const listFrom = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.content)) return payload.content;
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.items)) return payload.items;
  }
  return [];
};

const buildUrl = (pathName, params) => {
  const url = new URL(`${ADMIN_API}${pathName}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, String(item)));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = { raw: raw.slice(0, 300) };
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object"
      ? JSON.stringify({
        status: payload.status,
        error: payload.error,
        message: payload.message,
        path: payload.path,
      })
      : String(payload || "");
    throw new Error(`HTTP ${response.status} ${url}: ${message}`);
  }
  return payload;
};

const fetchVivaToken = async (tokenRequestBody) => {
  const payload = await fetchJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenRequestBody,
  });
  const token = toStr(payload?.access_token);
  if (!token) throw new Error("Viva access token is missing");
  return token;
};

const fetchStudios = async (headers) => {
  const payload = await fetchJson(buildUrl("/studios", { size: 200 }), { headers });
  return listFrom(payload)
    .map((studio) => ({
      id: pickObjectId(studio),
      name: toStr(studio?.name || studio?.title),
    }))
    .filter((studio) => Boolean(studio.id));
};

const fetchTransactionsPage = async ({ headers, studioId, productId, from, to, page, size }) => {
  const url = buildUrl("/transactions", {
    studioId,
    status: "PAID",
    dateFrom: from.requestValue,
    dateTo: to.requestValue,
    size,
    page,
    productIds: [productId],
  });
  return fetchJson(url, { headers });
};

const fetchTransactions = async ({ headers, studioId, productId, from, to, size = 1000 }) => {
  const rows = [];
  for (let page = 0; page < 100; page += 1) {
    const payload = await fetchTransactionsPage({ headers, studioId, productId, from, to, page, size });
    const pageRows = listFrom(payload);
    rows.push(...pageRows);
    const totalPages = Number(payload?.totalPages);
    if (Number.isFinite(totalPages) && totalPages > 0) {
      if (page + 1 >= totalPages) break;
      continue;
    }
    if (pageRows.length < size) break;
  }
  return rows;
};

const productLineMatches = (product, productId) => {
  if (!product || typeof product !== "object") return false;
  const ids = [
    product.id,
    product.uuid,
    product.productId,
    product.subscriptionId,
    product.product?.id,
    product.product?.uuid,
  ].map((value) => toStr(value));
  return ids.includes(productId);
};

const transactionContainsProduct = (transaction, productId) => (
  asArray(transaction?.products).some((product) => productLineMatches(product, productId))
);

const normalizeStatus = (value) => String(value || "").trim().toUpperCase();

const hasStatusToken = (status, token) => status
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .some((part) => part === token || part.startsWith(token));

export const classifyVivaTransaction = (transaction, config, options = {}) => {
  const transactionId = pickTransactionId(transaction);
  if (!transactionId) return "missing_transaction_id";

  const status = normalizeStatus(transaction?.status || transaction?.state || transaction?.paymentStatus);
  if (!(hasStatusToken(status, "PAID") || hasStatusToken(status, "SUCCESS") || hasStatusToken(status, "COMPLETE"))) {
    return "status_not_paid";
  }

  const refundSum = toMoneyMinor(transaction?.refundSum, 0);
  if (refundSum > 0 || toStr(transaction?.refundedAt)) return "refunded";

  if (!transactionContainsProduct(transaction, config.productId)) return "product_mismatch";

  const toPayMinor = toMoneyMinor(transaction?.toPay, 0);
  if (!options.includeZeroToPay && toPayMinor <= 0) return "zero_to_pay";

  return "billable";
};

export const isBillableVivaTransaction = (transaction, config, options = {}) => (
  classifyVivaTransaction(transaction, config, options) === "billable"
);

const pickClientPhone = (transaction) => normalizePhone(
  transaction?.client?.phone
  || transaction?.client?.mobile
  || transaction?.client?.phoneNumber
  || transaction?.clientPhone
);

const pickClientId = (transaction) => (
  pickObjectId(transaction?.client)
  || toStr(transaction?.clientId)
  || toStr(transaction?.client?.clientId)
);

export const buildSaleRecordFromVivaTransaction = ({
  transaction,
  config,
  existingRecord = null,
  inventoryId = DEFAULT_INVENTORY_ID,
  nowIso = new Date().toISOString(),
  studio = null,
}) => {
  const transactionId = pickTransactionId(transaction);
  if (!transactionId) throw new Error("Cannot build sale record without transaction id");

  const paidAt = toIsoOrNull(pickPaymentDate(transaction)) || nowIso;
  const vivaCreateDate = toIsoOrNull(pickCreateDate(transaction));
  const amountMinor = toMoneyMinor(transaction?.sum, config.productCostMinor);
  const toPayMinor = toMoneyMinor(transaction?.toPay, amountMinor);
  const existingPaymentRef = toStr(existingRecord?.paymentRef);

  return {
    counterKey: config.counterKey,
    inventoryId,
    unlimited: false,
    saleType: config.saleType,
    planKey: config.planKey,
    campaignKey: config.campaignKey,
    paymentRef: existingPaymentRef || `ab_leto_reconcile_${config.counterKey}_${transactionId}`,
    transactionId,
    clientPhone: pickClientPhone(transaction),
    clientId: pickClientId(transaction),
    productId: config.productId,
    productName: config.productName,
    productType: "SUBSCRIPTION",
    amountMinor,
    toPayMinor,
    status: "PAID",
    paymentUrl: null,
    expiresAt: null,
    successUrl: null,
    failUrl: null,
    paidAt,
    lastCheckedAt: nowIso,
    updatedAt: nowIso,
    reconcileSource: SOURCE,
    reconciledAt: nowIso,
    vivaPaymentDate: paidAt,
    vivaCreateDate,
    paymentStudioId: toStr(transaction?.paymentStudio?.id) || toStr(studio?.id),
    paymentStudioName: toStr(transaction?.paymentStudio?.name) || toStr(studio?.name),
  };
};

const isCanonicalExistingRecord = (existingRecord, saleRecord) => (
  existingRecord
  && toStr(existingRecord.inventoryId) === saleRecord.inventoryId
  && toStr(existingRecord.counterKey) === saleRecord.counterKey
  && toStr(existingRecord.productId) === saleRecord.productId
  && toStr(existingRecord.campaignKey) === saleRecord.campaignKey
  && normalizeStatus(existingRecord.status) === "PAID"
);

export const isConflictingExistingRecord = (existingRecord, saleRecord) => {
  if (!existingRecord) return false;
  const existingInventoryId = toStr(existingRecord.inventoryId);
  const existingCounterKey = toStr(existingRecord.counterKey);
  const existingCampaignKey = toStr(existingRecord.campaignKey);

  return (
    (existingInventoryId && existingInventoryId !== saleRecord.inventoryId)
    || (existingCounterKey && existingCounterKey !== saleRecord.counterKey)
    || (existingCampaignKey && existingCampaignKey !== saleRecord.campaignKey)
  );
};

const summarizeExistingShape = (existingRecord, saleRecord) => {
  if (!existingRecord) return null;
  return {
    status: toStr(existingRecord.status),
    inventoryId: toStr(existingRecord.inventoryId),
    counterKey: toStr(existingRecord.counterKey),
    productId: toStr(existingRecord.productId),
    campaignKey: toStr(existingRecord.campaignKey),
    canonical: isCanonicalExistingRecord(existingRecord, saleRecord),
  };
};

const increment = (target, key, amount = 1) => {
  target[key] = (target[key] || 0) + amount;
};

const emptyCounterSummary = () => ({
  vivaRows: 0,
  uniqueTransactions: 0,
  billable: 0,
  zeroToPay: 0,
  refunded: 0,
  productMismatch: 0,
  missingTransactionId: 0,
  statusNotPaid: 0,
  toInsert: 0,
  toUpdate: 0,
  alreadyCanonical: 0,
  conflictingExisting: 0,
  appliedMatched: 0,
  appliedModified: 0,
  appliedUpserted: 0,
});

const summarizeReason = (summary, reason) => {
  if (reason === "billable") increment(summary, "billable");
  else if (reason === "zero_to_pay") increment(summary, "zeroToPay");
  else if (reason === "refunded") increment(summary, "refunded");
  else if (reason === "product_mismatch") increment(summary, "productMismatch");
  else if (reason === "missing_transaction_id") increment(summary, "missingTransactionId");
  else if (reason === "status_not_paid") increment(summary, "statusNotPaid");
};

const readLocalCounts = async (collection, inventoryId) => {
  const rows = await collection.aggregate([
    { $match: { inventoryId, status: "PAID" } },
    { $group: { _id: "$counterKey", count: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]).toArray();
  return Object.fromEntries(rows.map((row) => [toStr(row._id) || "unknown", row.count]));
};

const writeReport = (outFile, report) => {
  if (!outFile) return;
  const target = path.resolve(outFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const buildPlan = ({ transactionsByCounter, existingByTransactionId, inventoryId, nowIso }) => {
  const changes = [];
  const summaryByCounter = {};

  for (const [counterKey, items] of Object.entries(transactionsByCounter)) {
    const config = AB_LETO_PLAN_CONFIGS[counterKey];
    summaryByCounter[counterKey] ||= emptyCounterSummary();
    const summary = summaryByCounter[counterKey];
    summary.uniqueTransactions = items.length;

    for (const item of items) {
      if (item.reason !== "billable") continue;

      const transactionId = pickTransactionId(item.transaction);
      const existingRecord = existingByTransactionId.get(transactionId) || null;
      const saleRecord = buildSaleRecordFromVivaTransaction({
        transaction: item.transaction,
        config,
        existingRecord,
        inventoryId,
        nowIso,
        studio: item.studio,
      });
      const alreadyCanonical = isCanonicalExistingRecord(existingRecord, saleRecord);
      const conflictingExisting = isConflictingExistingRecord(existingRecord, saleRecord);
      const action = alreadyCanonical
        ? "already_canonical"
        : conflictingExisting
          ? "skip_conflicting_existing"
          : existingRecord
            ? "update"
            : "insert";
      if (action === "insert") summary.toInsert += 1;
      if (action === "update") summary.toUpdate += 1;
      if (action === "already_canonical") summary.alreadyCanonical += 1;
      if (action === "skip_conflicting_existing") summary.conflictingExisting += 1;
      changes.push({
        action,
        counterKey,
        transactionId,
        transactionIdHash: hashId(transactionId),
        saleRecord,
        existingShape: summarizeExistingShape(existingRecord, saleRecord),
        safeSummary: {
          action,
          counterKey,
          transactionIdHash: hashId(transactionId),
          paymentDate: saleRecord.paidAt,
          studioName: saleRecord.paymentStudioName,
          amountMinor: saleRecord.amountMinor,
          toPayMinor: saleRecord.toPayMinor,
          existing: summarizeExistingShape(existingRecord, saleRecord),
        },
      });
    }
  }

  return { changes, summaryByCounter };
};

const applyPlan = async ({ collection, changes, summaryByCounter }) => {
  const applied = [];
  for (const change of changes) {
    if (change.action === "already_canonical" || change.action === "skip_conflicting_existing") continue;
    const createdAt = change.saleRecord.vivaCreateDate || change.saleRecord.paidAt || change.saleRecord.updatedAt;
    const result = await collection.updateOne(
      { transactionId: change.transactionId },
      {
        $set: change.saleRecord,
        $setOnInsert: {
          createdAt,
        },
      },
      { upsert: true },
    );
    const counterSummary = summaryByCounter[change.counterKey] || emptyCounterSummary();
    counterSummary.appliedMatched += result.matchedCount;
    counterSummary.appliedModified += result.modifiedCount;
    counterSummary.appliedUpserted += result.upsertedId ? 1 : 0;
    summaryByCounter[change.counterKey] = counterSummary;
    applied.push({
      action: change.action,
      counterKey: change.counterKey,
      transactionIdHash: change.transactionIdHash,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ? String(result.upsertedId) : null,
    });
  }
  return applied;
};

const printHelp = () => {
  console.log(`
reconcile_ab_leto_viva_sales

Восстанавливает локальные lk_tournament_subscription_sales по Viva transactions
для летней витрины ab_leto. По умолчанию dry-run.

Usage:
  npm run subscriptions:reconcile-viva -- [options]

Options:
  --from YYYY-MM-DD          Moscow date/ISO start (default: ${DEFAULT_FROM_DATE})
  --to YYYY-MM-DD            Moscow date/ISO end (default: current Moscow date)
  --counter-keys a,b         Counters to reconcile (default: friendship,sport)
  --inventory-id ID          Inventory id (default: ${DEFAULT_INVENTORY_ID})
  --flow FILE                Node-RED source flow (default: node-red/modular/source.flow.json)
  --mongo-uri URI            Mongo URI (or MONGO_URI/MONGODB_URI/source flow)
  --db NAME                  DB name (default: games)
  --out FILE                 Write JSON report
  --include-zero-to-pay      Include Viva rows with toPay=0 (default: excluded)
  --localhost                Rewrite Mongo host to 127.0.0.1:27017
  --apply                    Apply upserts (default: dry-run)
`);
};

const collectTransactions = async ({ headers, studios, counterKeys, from, to, includeZeroToPay }) => {
  const transactionsByCounter = {};
  const fetchSummaryByCounter = {};

  for (const counterKey of counterKeys) {
    const config = AB_LETO_PLAN_CONFIGS[counterKey];
    const byTransactionId = new Map();
    const summary = emptyCounterSummary();

    for (const studio of studios) {
      const rows = await fetchTransactions({
        headers,
        studioId: studio.id,
        productId: config.productId,
        from,
        to,
      });
      summary.vivaRows += rows.length;

      for (const transaction of rows) {
        const transactionId = pickTransactionId(transaction);
        const reason = classifyVivaTransaction(transaction, config, { includeZeroToPay });
        summarizeReason(summary, reason);
        if (!transactionId) continue;
        if (!byTransactionId.has(transactionId)) {
          byTransactionId.set(transactionId, {
            counterKey,
            studio,
            transaction,
            reason,
          });
        }
      }
    }

    transactionsByCounter[counterKey] = Array.from(byTransactionId.values());
    fetchSummaryByCounter[counterKey] = summary;
  }

  return { transactionsByCounter, fetchSummaryByCounter };
};

const mergeSummaries = (left, right) => {
  const result = {};
  for (const key of unique([...Object.keys(left), ...Object.keys(right)])) {
    const merged = emptyCounterSummary();
    const leftSummary = left[key] || {};
    const rightSummary = right[key] || {};
    for (const field of Object.keys(merged)) {
      merged[field] = Number(leftSummary[field] || 0) + Number(rightSummary[field] || 0);
    }
    result[key] = merged;
  }
  return result;
};

const main = async () => {
  if (hasFlag("--help") || hasFlag("-h")) {
    printHelp();
    return;
  }

  const apply = hasFlag("--apply");
  const includeZeroToPay = hasFlag("--include-zero-to-pay");
  const flowPath = toStr(getArg("--flow", "node-red/modular/source.flow.json"));
  const inventoryId = toStr(getArg("--inventory-id", DEFAULT_INVENTORY_ID));
  const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
  const outFile = toStr(getArg("--out"));
  const counterKeys = unique(splitCsv(getArg("--counter-keys", DEFAULT_COUNTER_KEYS.join(","))))
    .map((item) => item.toLowerCase())
    .filter((item) => Boolean(AB_LETO_PLAN_CONFIGS[item]));

  if (counterKeys.length === 0) {
    throw new Error("No supported --counter-keys selected");
  }

  const from = parseMoscowBoundary(getArg("--from", DEFAULT_FROM_DATE), false);
  const to = parseMoscowBoundary(getArg("--to", moscowDateKey()), true);
  if (from.timestamp > to.timestamp) {
    throw new Error("--from must be before --to");
  }

  const tokenBody = toStr(process.env.VIVA_TOKEN_REQUEST_BODY) || readVivaTokenBodyFromFlow(flowPath);
  if (!tokenBody) {
    throw new Error("Missing Viva token body: set VIVA_TOKEN_REQUEST_BODY or pass a flow containing token request");
  }

  const mongoUri = rewriteToLocalhost(
    toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI || readMongoUriFromFlow(flowPath))),
    hasFlag("--localhost"),
  );
  if (!mongoUri) {
    throw new Error("Missing Mongo URI: set --mongo-uri/MONGO_URI/MONGODB_URI or provide source flow");
  }

  const nowIso = new Date().toISOString();
  const report = {
    createdAt: nowIso,
    mode: apply ? "apply" : "dry-run",
    source: SOURCE,
    inventoryId,
    dbName,
    filters: {
      from: from.iso,
      to: to.iso,
      counterKeys,
      includeZeroToPay,
    },
    viva: {
      studioCount: 0,
    },
    localCountsBefore: null,
    localCountsAfter: null,
    summaryByCounter: {},
    plannedChanges: [],
    applied: [],
  };

  const token = await fetchVivaToken(tokenBody);
  const headers = { Authorization: `Bearer ${token}` };
  const studios = await fetchStudios(headers);
  report.viva.studioCount = studios.length;

  const { transactionsByCounter, fetchSummaryByCounter } = await collectTransactions({
    headers,
    studios,
    counterKeys,
    from,
    to,
    includeZeroToPay,
  });

  const transactionIds = unique(Object.values(transactionsByCounter)
    .flat()
    .filter((item) => item.reason === "billable")
    .map((item) => pickTransactionId(item.transaction)));

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const collection = client.db(dbName).collection("lk_tournament_subscription_sales");
    report.localCountsBefore = await readLocalCounts(collection, inventoryId);
    const existingRows = transactionIds.length > 0
      ? await collection.find(
        { transactionId: { $in: transactionIds } },
        {
          projection: {
            _id: 0,
            inventoryId: 1,
            counterKey: 1,
            productId: 1,
            campaignKey: 1,
            paymentRef: 1,
            transactionId: 1,
            status: 1,
          },
        },
      ).toArray()
      : [];
    const existingByTransactionId = new Map(
      existingRows
        .map((row) => [toStr(row.transactionId), row])
        .filter(([key]) => Boolean(key)),
    );

    const plan = buildPlan({
      transactionsByCounter,
      existingByTransactionId,
      inventoryId,
      nowIso,
    });
    report.summaryByCounter = mergeSummaries(fetchSummaryByCounter, plan.summaryByCounter);
    report.plannedChanges = plan.changes.map((change) => change.safeSummary);

    if (apply) {
      report.applied = await applyPlan({
        collection,
        changes: plan.changes,
        summaryByCounter: report.summaryByCounter,
      });
      report.localCountsAfter = await readLocalCounts(collection, inventoryId);
    }

    writeReport(outFile, report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    writeReport(outFile, report);
    console.error(JSON.stringify(report, null, 2));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
