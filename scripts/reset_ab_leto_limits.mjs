#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const DEFAULT_INVENTORY_ID = "ab_leto_2026_50_v1";
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

const COUNTERS = [
  {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
    totalLimit: 142,
    priceMinor: 980000,
    unlimited: false,
  },
  {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
    totalLimit: 132,
    priceMinor: 1980000,
    unlimited: false,
  },
  {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
    totalLimit: 0,
    priceMinor: 2380000,
    unlimited: true,
  },
  {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
    totalLimit: 182,
    priceMinor: 2380000,
    unlimited: false,
  },
  {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
    productName: "Энергия-5",
    totalLimit: 0,
    priceMinor: 1980000,
    unlimited: true,
  },
];

const readMongoUriFromFlow = () => {
  const candidates = [
    getArg("--flow"),
    "/root/.node-red/flows.json",
    "node-red/modular/source.flow.json",
  ].filter(Boolean);
  const flowPath = candidates.find((candidate) => fs.existsSync(path.resolve(candidate)));
  if (!flowPath) throw new Error("Node-RED flow file not found; pass --flow /path/to/flows.json");
  const flow = JSON.parse(fs.readFileSync(path.resolve(flowPath), "utf8"));
  const node = asArray(flow).find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  const uri = toStr(node?.uri);
  if (!uri) throw new Error(`MongoDB URI not found in ${flowPath}`);
  return uri;
};

const rewriteToLocalhost = (uri) => {
  if (!hasFlag("--localhost")) return uri;
  return uri.replace(/@[^/?]+(?=\/)/, "@127.0.0.1:27017");
};

if (hasFlag("--help")) {
  console.log([
    "Usage: node scripts/reset_ab_leto_limits.mjs --apply [options]",
    `  --inventory-id ID   Default: ${DEFAULT_INVENTORY_ID}`,
    "  --flow FILE        Node-RED flows.json; defaults to /root/.node-red/flows.json or local source.flow.json",
    "  --localhost        Rewrite Mongo host to 127.0.0.1:27017 when running on DB server",
    "  --db NAME          Default: games",
    "  --apply            Required to write counters and indexes",
  ].join("\n"));
  process.exit(0);
}

const apply = hasFlag("--apply");
const inventoryId = getArg("--inventory-id", DEFAULT_INVENTORY_ID);
const dbName = getArg("--db", "games");
if (!apply) {
  console.log(JSON.stringify({ dryRun: true, inventoryId, counters: COUNTERS }, null, 2));
  process.exit(0);
}

const nowIso = new Date().toISOString();
const client = new MongoClient(rewriteToLocalhost(readMongoUriFromFlow()), {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 20000,
});

try {
  await client.connect();
  const db = client.db(dbName);
  await Promise.all([
    db.collection("lk_tournament_subscription_sales").createIndex(
      { inventoryId: 1, status: 1, counterKey: 1, paidAt: 1 },
      { name: "ab_leto_inventory_status_counter_paidAt" },
    ),
    db.collection("lk_tournament_subscription_counters").createIndex(
      { inventoryId: 1, counterKey: 1 },
      {
        name: "ab_leto_inventory_counter_unique",
        unique: true,
        partialFilterExpression: { inventoryId: { $type: "string" } },
      },
    ),
    db.collection("events").createIndex(
      { event: 1, "payload.storefront": 1, timestamp: 1 },
      { name: "ab_leto_page_open_events" },
    ),
  ]);

  const results = [];
  for (const counter of COUNTERS) {
    const paidCount = 0;
    const reservedCount = 0;
    const takenCount = 0;
    const remainingCount = counter.unlimited ? 0 : counter.totalLimit;
    const state = {
      ...counter,
      inventoryId,
      paidCount,
      reservedCount,
      takenCount,
      remainingCount,
      canPurchase: true,
      priceMinor: counter.priceMinor,
      price: counter.priceMinor / 100,
      updatedAt: nowIso,
      sourceUpdatedAt: null,
    };
    const result = await db.collection("lk_tournament_subscription_counters").updateOne(
      { inventoryId, counterKey: counter.counterKey },
      { $set: state, $setOnInsert: { createdAt: nowIso } },
      { upsert: true },
    );
    results.push({
      counterKey: counter.counterKey,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      upsertedId: result.upsertedId ? String(result.upsertedId) : null,
    });
  }

  const salesSummary = await db.collection("lk_tournament_subscription_sales").aggregate([
    { $match: { inventoryId } },
    { $group: { _id: { counterKey: "$counterKey", status: "$status" }, count: { $sum: 1 } } },
    { $sort: { "_id.counterKey": 1, "_id.status": 1 } },
  ]).toArray();

  console.log(JSON.stringify({ ok: true, inventoryId, countersReset: results, salesSummary }, null, 2));
} finally {
  await client.close();
}
