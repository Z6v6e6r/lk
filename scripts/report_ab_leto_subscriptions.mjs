#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const DEFAULT_INVENTORY_ID = "ab_leto_2026_50_v1";
const DEFAULT_LAUNCH_DATE = "2026-06-30";
const LIMITED_COUNTER_KEYS = ["friendship", "sport", "academy", "ra"];
const ALL_COUNTER_KEYS = [...LIMITED_COUNTER_KEYS, "energy5"];
const TECHNICAL_TOTAL_LIMITS_BY_TYPE = {
  academy: 125,
  friendship: 142,
  ra: 182,
  sport: 132,
};
const DISPLAY_TOTAL_LIMITS_BY_TYPE = {
  academy: 100,
  friendship: 100,
  ra: 100,
  sport: 126,
};
const argv = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const hasFlag = (name) => argv.includes(name);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const toTimestamp = (value) => {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseBoundary = (value, endOfDay = false) => {
  const text = toStr(value);
  if (!text) return null;
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const candidate = isDateOnly
    ? `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`
    : text;
  const timestamp = Date.parse(candidate);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid date: ${text}`);
  }
  return timestamp;
};

const readMongoUriFromFlow = () => {
  const flowPath = path.resolve(getArg("--flow", "node-red/modular/source.flow.json"));
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const clientNode = asArray(flow).find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  const uri = toStr(clientNode?.uri);
  if (!uri) throw new Error(`MongoDB URI not found in ${flowPath}`);
  return uri;
};

const rewriteToLocalhost = (uri) => {
  if (!hasFlag("--localhost")) return uri;
  return uri.replace(/@[^/?]+(?=\/)/, "@127.0.0.1:27017");
};

const resolvePurchaseTimestamp = (row) => (
  toTimestamp(row?.paidAt)
  ?? toTimestamp(row?.updatedAt)
  ?? toTimestamp(row?.createdAt)
);

const inRange = (timestamp, fromTs, toTs) => (
  timestamp !== null
  && (fromTs === null || timestamp >= fromTs)
  && (toTs === null || timestamp <= toTs)
);

const formatMoscow = (timestamp) => {
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
};

const dateKeyMoscow = (timestamp) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const csvCell = (value) => {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};

const buildBuyersCsv = (rows) => {
  const headers = [
    "phone",
    "purchaseDateUtc",
    "purchaseDateMoscow",
    "subscriptionType",
    "productName",
    "amountRub",
    "transactionId",
    "paymentRef",
    "status",
  ];
  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((key) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
};

if (hasFlag("--help")) {
  console.log([
    "Usage: npm run subscriptions:report -- [options]",
    `  --from YYYY-MM-DD        Moscow date or ISO timestamp; default: ${DEFAULT_LAUNCH_DATE}`,
    "  --to YYYY-MM-DD          Moscow date or ISO timestamp",
    `  --inventory-id ID        Default: ${DEFAULT_INVENTORY_ID}`,
    "  --buyers-out FILE.csv    Export paid buyers",
    "  --json-out FILE.json     Save the summary JSON",
    "  --localhost              Rewrite Mongo host to 127.0.0.1:27017 when running on DB server",
    "  --db NAME                Default: games",
  ].join("\n"));
  process.exit(0);
}

const inventoryId = getArg("--inventory-id", DEFAULT_INVENTORY_ID);
const dbName = getArg("--db", "games");
const fromTs = parseBoundary(getArg("--from", DEFAULT_LAUNCH_DATE), false);
const toTs = parseBoundary(getArg("--to"), true);
const buyersOut = getArg("--buyers-out");
const jsonOut = getArg("--json-out");
const client = new MongoClient(rewriteToLocalhost(readMongoUriFromFlow()), {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();
  const db = client.db(dbName);
  const eventQuery = {
    event: "subscription_page_opened",
    "payload.storefront": "ab_leto",
    timestamp: {
      ...(fromTs === null ? {} : { $gte: new Date(fromTs).toISOString() }),
      ...(toTs === null ? {} : { $lte: new Date(toTs).toISOString() }),
    },
  };
  const [saleRows, eventRows] = await Promise.all([
    db.collection("lk_tournament_subscription_sales")
      .find({ inventoryId, status: "PAID" }, { projection: { _id: 0 } })
      .toArray(),
    db.collection("events")
      .find(
        eventQuery,
        { projection: { _id: 0, timestamp: 1, sessionId: 1, user: 1, page: 1 } },
      )
      .maxTimeMS(15000)
      .toArray(),
  ]);

  const sales = saleRows
    .map((row) => ({ row, timestamp: resolvePurchaseTimestamp(row) }))
    .filter(({ timestamp }) => inRange(timestamp, fromTs, toTs))
    .sort((left, right) => left.timestamp - right.timestamp);
  const opens = eventRows
    .map((row) => ({ row, timestamp: toTimestamp(row.timestamp) }))
    .filter(({ timestamp }) => inRange(timestamp, fromTs, toTs));

  const buyers = sales.map(({ row, timestamp }) => ({
    phone: toStr(row.clientPhone),
    purchaseDateUtc: new Date(timestamp).toISOString(),
    purchaseDateMoscow: formatMoscow(timestamp),
    subscriptionType: toStr(row.counterKey),
    productName: toStr(row.productName),
    amountRub: Number.isFinite(Number(row.amountMinor)) ? Number(row.amountMinor) / 100 : null,
    transactionId: toStr(row.transactionId),
    paymentRef: toStr(row.paymentRef),
    status: toStr(row.status),
  }));

  const purchasesByType = Object.fromEntries(ALL_COUNTER_KEYS.map((key) => [key, 0]));
  for (const buyer of buyers) {
    if (buyer.subscriptionType in purchasesByType) purchasesByType[buyer.subscriptionType] += 1;
  }
  const technicalTotalLimitsByLimitedType = Object.fromEntries(
    LIMITED_COUNTER_KEYS.map((key) => [key, TECHNICAL_TOTAL_LIMITS_BY_TYPE[key]]),
  );
  const displayTotalLimitsByLimitedType = Object.fromEntries(
    LIMITED_COUNTER_KEYS.map((key) => [key, DISPLAY_TOTAL_LIMITS_BY_TYPE[key]]),
  );
  const remainingByLimitedType = Object.fromEntries(
    LIMITED_COUNTER_KEYS.map((key) => [
      key,
      Math.max((TECHNICAL_TOTAL_LIMITS_BY_TYPE[key] || 0) - purchasesByType[key], 0),
    ]),
  );
  const opensByDay = {};
  for (const { timestamp } of opens) {
    const key = dateKeyMoscow(timestamp);
    opensByDay[key] = (opensByDay[key] || 0) + 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    inventoryId,
    period: {
      from: fromTs === null ? null : new Date(fromTs).toISOString(),
      to: toTs === null ? null : new Date(toTs).toISOString(),
    },
    pageOpens: opens.length,
    uniqueSessions: new Set(opens.map(({ row }) => toStr(row.sessionId)).filter(Boolean)).size,
    opensByDay,
    paidPurchases: buyers.length,
    uniqueBuyerPhones: new Set(buyers.map((buyer) => buyer.phone).filter(Boolean)).size,
    purchasesByType,
    technicalTotalLimitsByLimitedType,
    displayTotalLimitsByLimitedType,
    remainingByLimitedType,
    energy5Unlimited: true,
  };

  if (buyersOut) {
    fs.writeFileSync(path.resolve(buyersOut), buildBuyersCsv(buyers), "utf8");
  }
  if (jsonOut) {
    fs.writeFileSync(path.resolve(jsonOut), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
}
