#!/usr/bin/env node
import fs from "node:fs";
import { MongoClient } from "mongodb";
import {
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_OVERALL_WEIGHTS,
  COMMUNITY_RATING_PERIODS,
  COMMUNITY_RATING_TABS,
} from "../src/services/community-rating/contract.ts";

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
  const activeCommunities = await db.collection("lk_communities").countDocuments({
    archived: { $ne: true },
  });
  const snapshots = await db.collection("community_rating_snapshots")
    .find({ calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION })
    .project({ communityId: 1, tab: 1, period: 1, items: 1 })
    .toArray();

  const expectedSnapshots = activeCommunities
    * COMMUNITY_RATING_TABS.length
    * COMMUNITY_RATING_PERIODS.length;
  const matrix = Object.fromEntries(COMMUNITY_RATING_PERIODS.flatMap((period) => (
    COMMUNITY_RATING_TABS.map((tab) => [`${period}:${tab}`, 0])
  )));
  let items = 0;
  let itemsMissingLastChangeFields = 0;
  let overallFormulaMismatches = 0;
  let overallRowsWithLastRatingChange = 0;
  const uniqueKeys = new Set();

  snapshots.forEach((snapshot) => {
    const key = `${snapshot.communityId}:${snapshot.period}:${snapshot.tab}`;
    uniqueKeys.add(key);
    const matrixKey = `${snapshot.period}:${snapshot.tab}`;
    if (Object.hasOwn(matrix, matrixKey)) matrix[matrixKey] += 1;
    const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
    items += snapshotItems.length;
    snapshotItems.forEach((item) => {
      if (
        !isRecord(item)
        || !Object.hasOwn(item, "lastRatingDelta")
        || !Object.hasOwn(item, "lastRatingChangedAt")
      ) itemsMissingLastChangeFields += 1;
      if (snapshot.tab === "overall" && isRecord(item)) {
        const games = Number(item.gamesNormalized);
        const tournaments = Number(item.tournamentNormalized);
        const activity = Number(item.activityScore);
        const overall = Number(item.overallScore);
        const expected = Math.round((
          games * COMMUNITY_RATING_OVERALL_WEIGHTS.games
          + tournaments * COMMUNITY_RATING_OVERALL_WEIGHTS.tournaments
          + activity * COMMUNITY_RATING_OVERALL_WEIGHTS.activity
        ) * 1000) / 1000;
        if (
          !Number.isFinite(games)
          || !Number.isFinite(tournaments)
          || !Number.isFinite(activity)
          || !Number.isFinite(overall)
          || Math.abs(overall - expected) > 0.001
        ) overallFormulaMismatches += 1;
        if (Number.isFinite(Number(item.lastRatingDelta)) && Number(item.lastRatingDelta) !== 0) {
          overallRowsWithLastRatingChange += 1;
        }
      }
    });
  });

  const matrixComplete = Object.values(matrix).every((count) => count === activeCommunities);
  const ok = (
    snapshots.length === expectedSnapshots
    && uniqueKeys.size === expectedSnapshots
    && matrixComplete
    && itemsMissingLastChangeFields === 0
    && overallFormulaMismatches === 0
    && overallRowsWithLastRatingChange > 0
  );
  const report = {
    ok,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    activeCommunities,
    expectedSnapshots,
    snapshots: snapshots.length,
    uniqueSnapshotKeys: uniqueKeys.size,
    matrix,
    items,
    itemsMissingLastChangeFields,
    overallFormulaMismatches,
    overallRowsWithLastRatingChange,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  await client.close();
}
