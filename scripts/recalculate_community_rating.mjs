import { MongoClient } from "mongodb";
import {
  COMMUNITY_RATING_COLLECTIONS,
  COMMUNITY_RATING_SOURCE_COLLECTIONS,
  ensureCommunityRatingStorageIndexes,
  recalculateCommunityRating,
} from "../src/services/community-rating/index.ts";

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function getCsvArg(name) {
  const raw = getArg(name);
  if (!raw) return null;
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function printUsage() {
  console.error(`
Usage:
  node --experimental-strip-types scripts/recalculate_community_rating.mjs --community-id <id> --mongo-uri <uri>
  node --experimental-strip-types scripts/recalculate_community_rating.mjs --all --mongo-uri <uri>

Options:
  --db <name>          Mongo database name, default: games
  --periods <csv>      Rating periods, default: all,30d
  --tabs <csv>         Rating tabs, default: overall,dynamics,games,tournaments
  --dry-run            Build the batch and print summary without writes
  --skip-indexes       Do not create/update rating indexes before writes
`);
}

function buildCollections(db) {
  return {
    source: {
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.communities]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.communities),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.feed]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.feed),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.games]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.games),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.visits]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.visits),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState),
    },
    storage: {
      [COMMUNITY_RATING_COLLECTIONS.facts]: db.collection(COMMUNITY_RATING_COLLECTIONS.facts),
      [COMMUNITY_RATING_COLLECTIONS.aggregates]: db.collection(COMMUNITY_RATING_COLLECTIONS.aggregates),
      [COMMUNITY_RATING_COLLECTIONS.snapshots]: db.collection(COMMUNITY_RATING_COLLECTIONS.snapshots),
    },
  };
}

async function resolveCommunityIds(db, explicitCommunityId, allCommunities) {
  if (explicitCommunityId) return [explicitCommunityId];
  if (!allCommunities) return [];

  const rows = await db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.communities)
    .find({ archived: { $ne: true } })
    .toArray();
  return Array.from(new Set(rows
    .map((row) => String(row.id || row.communityId || "").trim())
    .filter(Boolean)));
}

function compactResult(result) {
  if (!result) return null;
  return {
    communityId: result.communityId,
    applied: result.applied,
    source: {
      feedPosts: result.summary.feedPosts,
      games: result.summary.games,
      tournaments: result.summary.tournaments,
      visits: result.summary.visits,
      ratingEvents: result.summary.ratingEvents,
      ratingStates: result.summary.ratingStates,
    },
    facts: result.summary.facts,
    calculationVersion: result.summary.calculationVersion,
    writes: result.batch.summary,
  };
}

const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
const dbName = getArg("--db", process.env.MONGO_DB || "games");
const communityId = getArg("--community-id", getArg("--community"));
const allCommunities = hasFlag("--all");
const dryRun = hasFlag("--dry-run");
const skipIndexes = hasFlag("--skip-indexes");
const periods = getCsvArg("--periods");
const tabs = getCsvArg("--tabs");

if (!mongoUri || (!communityId && !allCommunities)) {
  printUsage();
  process.exit(1);
}

const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();
  const db = client.db(dbName);
  const collections = buildCollections(db);
  const communityIds = await resolveCommunityIds(db, communityId, allCommunities);

  if (communityIds.length === 0) {
    console.log(JSON.stringify({ ok: true, dryRun, results: [] }, null, 2));
    process.exit(0);
  }

  if (!dryRun && !skipIndexes) {
    await ensureCommunityRatingStorageIndexes(collections.storage);
  }

  const results = [];
  for (const id of communityIds) {
    const result = await recalculateCommunityRating({
      collections,
      communityId: id,
      periods,
      tabs,
      dryRun,
      ensureIndexes: false,
    });
    results.push(compactResult(result) || {
      communityId: id,
      applied: false,
      error: "Community not found",
    });
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun,
    db: dbName,
    communities: results.length,
    results,
  }, null, 2));
} finally {
  await client.close();
}
