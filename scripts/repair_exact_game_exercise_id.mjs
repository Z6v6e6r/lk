#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BSON, MongoClient } from "mongodb";

const DEFAULT_LK_BASE = "https://padlhub.su/lk";
const DEFAULT_TOKEN_ENV = "LK_REPAIR_BEARER_TOKEN";
const DEFAULT_MONGO_URI_ENV = "LK_GAMES_MONGODB_URI";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const isObj = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (values) => Array.from(new Set(values.map(toStr).filter(Boolean)));

const usage = `
repair_exact_game_exercise_id

Repairs exerciseId/vivaExerciseId for exactly one LK game. The default mode is
read-only dry-run. --apply is required for an exact Mongo dotted-field update.

Usage:
  node scripts/repair_exact_game_exercise_id.mjs \\
    --game-id <exact-game-id> \\
    --booking-id <exact-booking-uuid> \\
    --exercise-id <exact-exercise-uuid> [--apply]

Options:
  --game-id <id>          Required exact LK game id
  --booking-id <uuid>     Required exact booking id already present in the game
  --exercise-id <uuid>    Required expected Viva exercise id
  --base-url <url>        LK API base (default: ${DEFAULT_LK_BASE})
  --token-env <name>      Optional bearer token env name (default: ${DEFAULT_TOKEN_ENV})
  --mongo-uri-env <name>  Mongo URI env name (default: ${DEFAULT_MONGO_URI_ENV})
  --db <name>             Mongo database (default: games)
  --collection <name>     Mongo collection (default: lk_games)
  --backup-dir <path>     Backup directory (default: tmp/exact-game-repair-backups)
  --apply                 Backup and execute exact Mongo $set after repeated prechecks
  --help                  Show this help
`;

export function parseArgs(argv) {
  const options = {
    apply: false,
    help: false,
    gameId: null,
    bookingId: null,
    exerciseId: null,
    baseUrl: DEFAULT_LK_BASE,
    tokenEnv: DEFAULT_TOKEN_ENV,
    mongoUriEnv: DEFAULT_MONGO_URI_ENV,
    db: "games",
    collection: "lk_games",
    backupDir: "tmp/exact-game-repair-backups",
  };
  const valueFlags = new Map([
    ["--game-id", "gameId"],
    ["--booking-id", "bookingId"],
    ["--exercise-id", "exerciseId"],
    ["--base-url", "baseUrl"],
    ["--token-env", "tokenEnv"],
    ["--mongo-uri-env", "mongoUriEnv"],
    ["--db", "db"],
    ["--collection", "collection"],
    ["--backup-dir", "backupDir"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const key = valueFlags.get(arg);
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }

  options.gameId = toStr(options.gameId);
  options.bookingId = toStr(options.bookingId);
  options.exerciseId = toStr(options.exerciseId);
  options.baseUrl = (toStr(options.baseUrl) || DEFAULT_LK_BASE).replace(/\/+$/, "");
  options.tokenEnv = toStr(options.tokenEnv) || DEFAULT_TOKEN_ENV;
  options.mongoUriEnv = toStr(options.mongoUriEnv) || DEFAULT_MONGO_URI_ENV;
  options.db = toStr(options.db) || "games";
  options.collection = toStr(options.collection) || "lk_games";
  options.backupDir = toStr(options.backupDir) || "tmp/exact-game-repair-backups";
  if (options.help) return options;

  for (const [flag, key] of valueFlags) {
    if (["gameId", "bookingId", "exerciseId"].includes(key) && !options[key]) {
      throw new Error(`${flag} is required`);
    }
  }
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(options.bookingId)) throw new Error("--booking-id must be a UUID");
  if (!uuidPattern.test(options.exerciseId)) throw new Error("--exercise-id must be a UUID");
  if (!/^[A-Za-z0-9:_-]{3,180}$/.test(options.gameId)) {
    throw new Error("--game-id contains unsupported characters");
  }
  return options;
}

const extractGame = (payload, expectedGameId) => {
  const candidates = [
    payload,
    payload?.game,
    payload?.record,
    payload?.item,
    payload?.data,
    payload?.data?.game,
  ];
  return candidates.find((candidate) => isObj(candidate) && toStr(candidate.id) === expectedGameId) || null;
};

export const extractBookingIds = (game) => {
  const booking = isObj(game?.booking) ? game.booking : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
  return uniq([
    booking.bookingId,
    ...asArray(booking.bookingIds),
    metadata.bookingId,
    ...asArray(metadata.bookingIds),
    split.bookingId,
    split.organizerBookingId,
    ...asArray(split.bookingIds),
  ]);
};

export const extractExerciseIds = (game) => {
  const booking = isObj(game?.booking) ? game.booking : {};
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const split = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
  const dedupeExerciseId = toStr(game?.dedupeKey)?.match(/^viva:([0-9a-f-]{16,})$/i)?.[1] || null;
  return uniq([
    booking.exerciseId,
    booking.vivaExerciseId,
    booking.exercise_id,
    booking.viva_exercise_id,
    metadata.exerciseId,
    metadata.vivaExerciseId,
    metadata.exercise_id,
    metadata.viva_exercise_id,
    split.exerciseId,
    split.vivaExerciseId,
    split.exercise_id,
    split.viva_exercise_id,
    dedupeExerciseId,
  ]);
};

export function precheckGame(game, expected) {
  if (!isObj(game) || toStr(game.id) !== expected.gameId) {
    throw new Error(`Exact game precheck failed for ${expected.gameId}`);
  }
  const booking = isObj(game.booking) ? game.booking : null;
  const metadata = isObj(game.metadata) ? game.metadata : null;
  if (!booking || !metadata) throw new Error("Game must contain booking and metadata objects");
  const bookingIds = extractBookingIds(game);
  if (bookingIds.length !== 1 || bookingIds[0] !== expected.bookingId) {
    throw new Error(
      `Booking mismatch: expected only ${expected.bookingId}, found ${bookingIds.join(",") || "none"}`,
    );
  }
  const exerciseIds = extractExerciseIds(game);
  const conflictingExerciseIds = exerciseIds.filter((id) => id !== expected.exerciseId);
  if (conflictingExerciseIds.length > 0) {
    throw new Error(`Exercise mismatch: record already contains ${conflictingExerciseIds.join(",")}`);
  }

  return {
    bookingIds,
    exerciseIds,
    alreadyRepaired: exerciseIds.length === 1 && exerciseIds[0] === expected.exerciseId,
  };
}

export function buildMongoUpdate(exerciseId) {
  return {
    $set: {
      "booking.exerciseId": exerciseId,
      "booking.vivaExerciseId": exerciseId,
      "metadata.exerciseId": exerciseId,
      "metadata.vivaExerciseId": exerciseId,
    },
  };
}

const withoutExerciseIds = (value) => {
  const clone = structuredClone(value);
  if (isObj(clone.booking)) {
    delete clone.booking.exerciseId;
    delete clone.booking.vivaExerciseId;
  }
  if (isObj(clone.metadata)) {
    delete clone.metadata.exerciseId;
    delete clone.metadata.vivaExerciseId;
  }
  return clone;
};

const getPath = (record, dottedPath) => dottedPath
  .split(".")
  .reduce((value, key) => (isObj(value) ? value[key] : undefined), record);

export function buildExactMongoFilter(game) {
  const filter = { _id: game._id, id: game.id };
  [
    "booking.exerciseId",
    "booking.vivaExerciseId",
    "metadata.exerciseId",
    "metadata.vivaExerciseId",
    "booking.bookingIds",
    "metadata.bookingIds",
  ].forEach((field) => {
    const value = getPath(game, field);
    filter[field] = value === undefined ? { $exists: false } : value;
  });
  if (Object.hasOwn(game, "updatedAt")) filter.updatedAt = game.updatedAt;
  return filter;
}

const writeBackupFile = (game, options, fsImpl = fs) => {
  const backupDir = path.resolve(options.backupDir);
  fsImpl.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const slug = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${options.gameId}.${slug}.before.ejson`);
  fsImpl.writeFileSync(
    backupPath,
    `${BSON.EJSON.stringify(game, { relaxed: false, indent: 2 })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  return backupPath;
};

const readJsonResponse = async (response, url) => {
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  if (!response.ok) {
    const summary = typeof payload === "string" ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300);
    throw new Error(`HTTP ${response.status} ${url}: ${summary}`);
  }
  return payload;
};

export async function runRepair(options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const env = dependencies.env || process.env;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const expected = {
    gameId: options.gameId,
    bookingId: options.bookingId,
    exerciseId: options.exerciseId,
  };
  const gameUrl = `${options.baseUrl}/games/${encodeURIComponent(options.gameId)}`;
  const token = toStr(env[options.tokenEnv]);
  const headers = {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const loadExact = async () => {
    const payload = await readJsonResponse(await fetchImpl(gameUrl, { method: "GET", headers }), gameUrl);
    const game = extractGame(payload, options.gameId);
    if (!game) throw new Error(`GET did not return exact game ${options.gameId}`);
    return game;
  };

  const firstGame = await loadExact();
  const firstCheck = precheckGame(firstGame, expected);
  const report = {
    mode: options.apply ? "apply" : "dry-run",
    gameId: options.gameId,
    bookingId: options.bookingId,
    exerciseId: options.exerciseId,
    precheck: firstCheck,
    patchFields: [
      "booking.exerciseId",
      "booking.vivaExerciseId",
      "metadata.exerciseId",
      "metadata.vivaExerciseId",
    ],
    applied: false,
    strategy: "mongo_exact_dotted_set",
    backupPath: null,
    postcheck: null,
  };
  if (!options.apply || firstCheck.alreadyRepaired) return report;

  const mongoUri = toStr(env[options.mongoUriEnv]);
  if (!mongoUri) throw new Error(`--apply requires Mongo URI in env ${options.mongoUriEnv}`);
  const mongoClientFactory = dependencies.mongoClientFactory
    || ((uri) => new MongoClient(uri, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 }));
  const backupWriter = dependencies.backupWriter || writeBackupFile;
  const client = mongoClientFactory(mongoUri);
  try {
    await client.connect();
    const collection = client.db(options.db).collection(options.collection);
    const mongoGame = await collection.findOne({ id: options.gameId });
    if (!mongoGame) throw new Error(`Mongo exact game not found: ${options.gameId}`);
    const mongoCheck = precheckGame(mongoGame, expected);
    if (mongoCheck.alreadyRepaired) {
      report.precheck = mongoCheck;
      return report;
    }
    report.backupPath = backupWriter(mongoGame, options, dependencies.fsImpl || fs);

    // Re-read immediately before mutation and compare the complete raw document.
    const applyGame = await collection.findOne({ _id: mongoGame._id, id: options.gameId });
    if (!applyGame) throw new Error("Game disappeared between Mongo prechecks");
    precheckGame(applyGame, expected);
    if (!isDeepStrictEqual(mongoGame, applyGame)) {
      throw new Error("Game changed between Mongo prechecks; refusing update");
    }

    const result = await collection.updateOne(
      buildExactMongoFilter(applyGame),
      buildMongoUpdate(options.exerciseId),
    );
    if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
      throw new Error(`Exact Mongo update failed: matched=${result.matchedCount} modified=${result.modifiedCount}`);
    }
    report.applied = true;

    const postMongoGame = await collection.findOne({ _id: mongoGame._id, id: options.gameId });
    if (!postMongoGame) throw new Error("Mongo postcheck could not reload exact game");
    const mongoPostCheck = precheckGame(postMongoGame, expected);
    if (!mongoPostCheck.alreadyRepaired) throw new Error("Mongo postcheck: exerciseId was not persisted");
    if (!isDeepStrictEqual(withoutExerciseIds(applyGame), withoutExerciseIds(postMongoGame))) {
      throw new Error("Mongo postcheck: fields outside the four exercise IDs changed");
    }

    const livePostGame = await loadExact();
    const livePostCheck = precheckGame(livePostGame, expected);
    if (!livePostCheck.alreadyRepaired) throw new Error("Live API postcheck: exerciseId was not visible");
    report.postcheck = { mongo: mongoPostCheck, live: livePostCheck };
    return report;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage);
      return;
    }
    const report = await runRepair(options);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
