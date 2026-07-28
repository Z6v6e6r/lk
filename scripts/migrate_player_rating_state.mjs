import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  PLAYER_RATING_COLLECTIONS,
  PLAYER_RATING_LEDGER_SCHEMA_VERSION,
  buildPlayerRatingKey,
  normalizeRatingPhone,
  toFiniteRating,
} from "../src/services/player-rating/ledger.ts";

const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);
const asArray = (value) => Array.isArray(value) ? value : [];
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

function collectIdentityPairsFromMember(value, pairs, source) {
  if (!isRecord(value)) return;
  const clientId = toStr(value.clientId || value.id || value.userId || value.playerId || value.uuid);
  const phoneNorm = normalizeRatingPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  if (clientId && phoneNorm) pairs.push({ clientId, phoneNorm, source });
}

export function buildIdentityCrosswalk(source = {}) {
  const pairs = [];
  asArray(source.visits).forEach((row) => {
    collectIdentityPairsFromMember(row, pairs, "visit");
    collectIdentityPairsFromMember(row?.client, pairs, "visit");
  });
  asArray(source.communities).forEach((row) => {
    asArray(row?.members).forEach((member) => collectIdentityPairsFromMember(member, pairs, "community"));
  });
  asArray(source.games).forEach((row) => {
    collectIdentityPairsFromMember(row?.organizer, pairs, "game");
    asArray(row?.participants).forEach((member) => collectIdentityPairsFromMember(member, pairs, "game"));
    asArray(row?.waitlist).forEach((member) => collectIdentityPairsFromMember(member, pairs, "game"));
    asArray(row?.playerPool).forEach((member) => collectIdentityPairsFromMember(member, pairs, "game"));
  });
  asArray(source.results).forEach((row) => {
    asArray(row?.ratingImpact).forEach((member) => collectIdentityPairsFromMember(member, pairs, "result"));
    asArray(row?.rosterSnapshot?.members).forEach((member) => collectIdentityPairsFromMember(member, pairs, "result_roster"));
  });

  const clientIdsByPhone = new Map();
  const phonesByClientId = new Map();
  const resultClientIdsByPhone = new Map();
  pairs.forEach(({ clientId, phoneNorm }) => {
    if (!clientIdsByPhone.has(phoneNorm)) clientIdsByPhone.set(phoneNorm, new Set());
    clientIdsByPhone.get(phoneNorm).add(clientId);
    if (!phonesByClientId.has(clientId)) phonesByClientId.set(clientId, new Set());
    phonesByClientId.get(clientId).add(phoneNorm);
  });
  pairs.filter((pair) => pair.source === "result").forEach(({ clientId, phoneNorm }) => {
    if (!resultClientIdsByPhone.has(phoneNorm)) resultClientIdsByPhone.set(phoneNorm, new Set());
    resultClientIdsByPhone.get(phoneNorm).add(clientId);
  });

  const byPhone = new Map();
  const byClientId = new Map();
  const conflicts = [];
  clientIdsByPhone.forEach((clientIds, phoneNorm) => {
    const resultClientIds = resultClientIdsByPhone.get(phoneNorm) ?? new Set();
    if (clientIds.size === 1) byPhone.set(phoneNorm, [...clientIds][0]);
    else if (resultClientIds.size === 1) byPhone.set(phoneNorm, [...resultClientIds][0]);
    else conflicts.push({ kind: "PHONE_TO_MULTIPLE_CLIENTS", phoneNorm, count: clientIds.size });
  });
  phonesByClientId.forEach((phones, clientId) => {
    if (phones.size === 1) byClientId.set(clientId, [...phones][0]);
    else conflicts.push({ kind: "CLIENT_TO_MULTIPLE_PHONES", clientId, count: phones.size });
  });
  return { byPhone, byClientId, conflicts, pairs: pairs.length };
}

export function buildCanonicalStateMigrationPlan(rows, crosswalk, cutoverAt) {
  const sourcePhones = new Set(asArray(rows)
    .map((row) => normalizeRatingPhone(row?.phoneNorm || row?.phone))
    .filter(Boolean));
  const sourceClientIds = new Set(asArray(rows)
    .map((row) => toStr(row?.clientId || row?.vivaClientId || row?.id))
    .filter(Boolean));
  sourcePhones.forEach((phoneNorm) => {
    const mappedClientId = crosswalk.byPhone.get(phoneNorm);
    if (mappedClientId) sourceClientIds.add(mappedClientId);
  });
  const seenKeys = new Set();
  const states = [];
  const skipped = [];
  const conflicts = crosswalk.conflicts.filter((conflict) => (
    (conflict.phoneNorm && sourcePhones.has(conflict.phoneNorm))
    || (conflict.clientId && sourceClientIds.has(conflict.clientId))
  ));
  for (const row of asArray(rows)) {
    const phoneNorm = normalizeRatingPhone(row?.phoneNorm || row?.phone);
    const explicitClientId = toStr(row?.clientId || row?.vivaClientId || row?.id);
    const clientId = explicitClientId || (phoneNorm ? crosswalk.byPhone.get(phoneNorm) || null : null);
    const playerKey = buildPlayerRatingKey({ clientId, phoneNorm, fallback: row?._id });
    const ratingNumeric = toFiniteRating(row?.ratingNumeric);
    if (!playerKey || ratingNumeric == null) {
      skipped.push({ reason: !playerKey ? "MISSING_IDENTITY" : "MISSING_RATING" });
      continue;
    }
    if (seenKeys.has(playerKey)) {
      conflicts.push({ kind: "DUPLICATE_CANONICAL_KEY", playerKey });
      continue;
    }
    seenKeys.add(playerKey);
    const baselineEventId = toStr(row?.lastEventId);
    const baselineAt = toStr(row?.lastEventAt) || cutoverAt;
    states.push({
      ...row,
      _id: playerKey,
      schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
      ownership: "CUP_CANONICAL",
      playerKey,
      clientId,
      phoneNorm,
      ratingNumeric,
      identityAliases: {
        clientIds: clientId ? [clientId] : [],
        phoneNorms: phoneNorm ? [phoneNorm] : [],
      },
      baseline: {
        eventId: baselineEventId,
        at: baselineAt,
        ratingNumeric,
      },
      lastEventId: baselineEventId,
      lastEventAt: baselineAt,
      migratedFrom: PLAYER_RATING_COLLECTIONS.compatibilityState,
      migratedAt: cutoverAt,
      updatedAt: toStr(row?.updatedAt) || cutoverAt,
    });
  }
  return { states, skipped, conflicts };
}

async function loadSources(db) {
  const [ratings, visits, communities, games, results] = await Promise.all([
    db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState).find({}).toArray(),
    db.collection("lk_training_visits").find({}, {
      projection: { clientId: 1, phoneNorm: 1, client: 1 },
    }).toArray(),
    db.collection("lk_communities").find({}, { projection: { members: 1 } }).toArray(),
    db.collection("lk_games").find({}, {
      projection: { organizer: 1, participants: 1, waitlist: 1, playerPool: 1 },
    }).toArray(),
    db.collection("lk_game_results").find({}, {
      projection: { ratingImpact: 1, rosterSnapshot: 1 },
    }).toArray(),
  ]);
  return { ratings, visits, communities, games, results };
}

async function ensureIndexes(db) {
  const state = db.collection(PLAYER_RATING_COLLECTIONS.state);
  await state.createIndex({ playerKey: 1 }, { name: "player_rating_state_key_uq", unique: true });
  await state.createIndex(
    { clientId: 1 },
    {
      name: "player_rating_state_client_uq",
      unique: true,
      partialFilterExpression: { clientId: { $type: "string" } },
    },
  );
  await state.createIndex(
    { phoneNorm: 1 },
    {
      name: "player_rating_state_phone_uq",
      unique: true,
      partialFilterExpression: { phoneNorm: { $type: "string" } },
    },
  );
  await state.createIndex({ updatedAt: -1 }, { name: "player_rating_state_updated" });
  await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry)
    .createIndex({ jobKey: 1 }, { name: "rating_job_registry_key_uq", unique: true });
  await db.collection(PLAYER_RATING_COLLECTIONS.jobRuns)
    .createIndex({ jobKey: 1, startedAt: -1 }, { name: "rating_job_runs_time" });
}

function maskConflict(conflict) {
  return {
    kind: conflict.kind,
    count: conflict.count || 1,
    playerKey: conflict.playerKey ? "masked" : undefined,
    phoneNorm: conflict.phoneNorm ? "masked" : undefined,
    clientId: conflict.clientId ? "masked" : undefined,
  };
}

async function runCli() {
  const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
  const dbName = getArg("--db", process.env.MONGO_DB || "games");
  const apply = hasFlag("--apply");
  const outPath = getArg("--out");
  if (!mongoUri) throw new Error("Provide --mongo-uri or MONGO_URI/MONGODB_URI");
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const cutoverAt = new Date().toISOString();
    const source = await loadSources(db);
    const crosswalk = buildIdentityCrosswalk(source);
    const plan = buildCanonicalStateMigrationPlan(source.ratings, crosswalk, cutoverAt);
    const report = {
      mode: apply ? "APPLY" : "DRY_RUN",
      createdAt: cutoverAt,
      sourceStates: source.ratings.length,
      plannedStates: plan.states.length,
      linkedClientIds: plan.states.filter((state) => state.clientId).length,
      unresolvedClientIds: plan.states.filter((state) => !state.clientId).length,
      skipped: plan.skipped.length,
      conflicts: plan.conflicts.map(maskConflict),
      identityEvidencePairs: crosswalk.pairs,
    };
    if (apply) {
      if (plan.conflicts.length > 0) {
        throw new Error(`Refusing apply: ${plan.conflicts.length} identity conflicts`);
      }
      await ensureIndexes(db);
      const operations = plan.states.map((state) => ({
        replaceOne: {
          filter: { _id: state._id },
          replacement: state,
          upsert: true,
        },
      }));
      const result = operations.length > 0
        ? await db.collection(PLAYER_RATING_COLLECTIONS.state).bulkWrite(operations, { ordered: true })
        : null;
      const compatibility = plan.states.map((state) => ({
        updateOne: {
          filter: state.phoneNorm ? { phoneNorm: state.phoneNorm } : { playerKey: state.playerKey },
          update: {
            $set: {
              canonicalStateId: state._id,
              canonicalCollection: PLAYER_RATING_COLLECTIONS.state,
              compatibilityProjection: true,
              compatibilityUpdatedAt: cutoverAt,
            },
          },
          upsert: false,
        },
      }));
      if (compatibility.length > 0) {
        await db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState)
          .bulkWrite(compatibility, { ordered: false });
      }
      await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).updateOne(
        { jobKey: "rating-ledger-projector" },
        {
          $setOnInsert: { createdAt: cutoverAt },
          $set: {
            jobKey: "rating-ledger-projector",
            enabled: true,
            schedule: "*/15 * * * *",
            ledgerNotBefore: cutoverAt,
            updatedAt: cutoverAt,
          },
        },
        { upsert: true },
      );
      report.applyResult = {
        upserted: Number(result?.upsertedCount || 0),
        modified: Number(result?.modifiedCount || 0),
        matched: Number(result?.matchedCount || 0),
      };
    }
    console.log(JSON.stringify(report, null, 2));
    if (outPath) {
      const target = path.resolve(outPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } finally {
    await client.close();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
