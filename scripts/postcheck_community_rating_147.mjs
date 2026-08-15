#!/usr/bin/env node
import fs from "node:fs";
import { MongoClient } from "mongodb";
import {
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_OVERALL_WEIGHTS,
  COMMUNITY_RATING_PERIODS,
  COMMUNITY_RATING_TABS,
} from "../src/services/community-rating/contract.ts";
import { buildCommunityRatingPostcheckReport } from "./lib/communityRatingPostcheck.mjs";

const flowPath = process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readMongoUriFromFlow() {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const mongoNode = flow.find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  if (mongoNode?.uri) return mongoNode.uri;

  const candidates = [];
  const visit = (value) => {
    if (typeof value === "string" && /mongodb(?:\+srv)?:\/\//i.test(value)) {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(flow);
  return candidates.find((item) => item.includes("/games")) || candidates[0] || "";
}

const mongoUri = process.env.MONGODB_URI || readMongoUriFromFlow();
if (!mongoUri) throw new Error("Mongo URI not found in active Node-RED flow");

const dbNameIndex = process.argv.indexOf("--db");
const dbName = dbNameIndex >= 0 ? process.argv[dbNameIndex + 1] : "games";
const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();
  const db = client.db(dbName);
  const activeCommunityRows = await db.collection("lk_communities").find({
    archived: { $ne: true },
  }, { projection: { id: 1, communityId: 1 } }).toArray();
  const snapshots = await db.collection("community_rating_snapshots")
    .find({ calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION })
    .project({ communityId: 1, tab: 1, period: 1, items: 1 })
    .toArray();
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows,
    snapshotRows: snapshots,
    periods: COMMUNITY_RATING_PERIODS,
    tabs: COMMUNITY_RATING_TABS,
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await client.close();
}
