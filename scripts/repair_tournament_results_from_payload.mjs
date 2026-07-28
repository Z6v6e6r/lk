#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

const hasFlag = (name) => argv.includes(name);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const readMongoUriFromFlow = () => {
  const flowPath = path.resolve("node-red/modular/source.flow.json");
  if (!fs.existsSync(flowPath)) return null;
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const node = asArray(flow).find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  return toStr(node?.uri);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));

const summarizeTournament = (tournament) => {
  const rounds = Array.isArray(tournament?.rounds) ? tournament.rounds : [];
  const summary = tournament?.summary && typeof tournament.summary === "object"
    ? tournament.summary
    : {};
  const params = tournament?.params && typeof tournament.params === "object"
    ? tournament.params
    : {};

  return {
    tournamentId: toStr(tournament?.tournamentId || tournament?.id),
    tournamentType: toStr(tournament?.tournamentType),
    roundsCount: rounds.length,
    roundIds: rounds.map((round) => String(round?.id || "")).filter(Boolean),
    params: {
      status: params.status ?? null,
      finished: params.finished ?? null,
      manualFinish: params.manualFinish ?? null,
      finishedAt: params.finishedAt ?? null,
      completedAt: params.completedAt ?? null,
    },
    summary: {
      status: summary.status ?? null,
      finished: summary.finished ?? null,
      manualFinish: summary.manualFinish ?? null,
      totalRounds: summary.totalRounds ?? null,
      completedRounds: summary.completedRounds ?? null,
      totalMatches: summary.totalMatches ?? null,
      completedMatches: summary.completedMatches ?? null,
      finishedAt: summary.finishedAt ?? null,
      completedAt: summary.completedAt ?? null,
    },
  };
};

const fetchTournament = async ({ mongoUri, dbName, collectionName, tournamentId }) => {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
    return await client.db(dbName).collection(collectionName).findOne({ tournamentId });
  } finally {
    await client.close();
  }
};

const applyTournamentUpdate = async ({ mongoUri, dbName, collectionName, tournamentId, mongoSet }) => {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
    return await client.db(dbName).collection(collectionName).updateOne(
      { tournamentId },
      { $set: mongoSet },
    );
  } finally {
    await client.close();
  }
};

const runRecalculate = (tournament, inputPayload) => {
  const source = fs.readFileSync(path.resolve("scripts/nodered_games_nodes/fn_tournament_recalculate.js"), "utf8");
  const fn = new Function("msg", source);
  return fn({
    payload: tournament,
    req: {
      body: {
        results: asArray(inputPayload.results),
        ...(inputPayload.params && typeof inputPayload.params === "object"
          ? { params: inputPayload.params }
          : {}),
      },
    },
  });
};

const showHelp = hasFlag("--help") || hasFlag("-h");
const apply = hasFlag("--apply");
const tournamentId = toStr(getArg("--tournament-id"));
const resultsFile = toStr(getArg("--results-file"));
const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI)) || readMongoUriFromFlow();
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const collectionName = toStr(getArg("--collection", "tournaments")) || "tournaments";
const defaultOut = apply
  ? `tmp/tournament-${tournamentId || "repair"}-apply.json`
  : `tmp/tournament-${tournamentId || "repair"}-dryrun.json`;
const outFile = toStr(getArg("--out", defaultOut)) || defaultOut;

if (showHelp) {
  console.log(`
repair_tournament_results_from_payload

Applies a JSON payload with explicit round/match pairings and scores to an
existing tournament document using the same Node-RED recalculation function
that powers /lk/tournaments/americano/results.

Usage:
  node scripts/repair_tournament_results_from_payload.mjs --tournament-id <uuid> --results-file tmp/results.json
  node scripts/repair_tournament_results_from_payload.mjs --tournament-id <uuid> --results-file tmp/results.json --apply

Options:
  --tournament-id <uuid>       Tournament identifier in Mongo
  --results-file <path>        JSON file with { results, params? } or a raw results array
  --mongo-uri <uri>            Mongo URI; defaults to env or node-red/modular/source.flow.json
  --db <name>                  DB name (default: games)
  --collection <name>          Collection name (default: tournaments)
  --out <path>                 Report path under tmp/
`);
  process.exit(0);
}

if (!tournamentId || !resultsFile) {
  console.error("Pass both --tournament-id and --results-file.");
  process.exit(1);
}

if (!mongoUri) {
  console.error("Missing Mongo URI. Pass --mongo-uri, set MONGO_URI/MONGODB_URI, or keep node-red/modular/source.flow.json available.");
  process.exit(1);
}

const startedAt = new Date().toISOString();
const inputRaw = readJson(resultsFile);
const inputPayload = Array.isArray(inputRaw)
  ? { results: inputRaw }
  : inputRaw;

if (!Array.isArray(inputPayload.results) || inputPayload.results.length === 0) {
  console.error("Results payload must contain a non-empty results array.");
  process.exit(1);
}

const beforeTournament = await fetchTournament({
  mongoUri,
  dbName,
  collectionName,
  tournamentId,
});

if (!beforeTournament) {
  console.error(`Tournament not found: ${tournamentId}`);
  process.exit(1);
}

const beforeSummary = summarizeTournament(beforeTournament);
const recalcInputTournament = JSON.parse(JSON.stringify(beforeTournament));
const recalcResult = runRecalculate(recalcInputTournament, inputPayload);
if (!recalcResult?.mongoUpdate?.$set) {
  console.error("Recalculation did not return a Mongo $set payload.");
  process.exit(1);
}

const afterDryRunTournament = {
  ...recalcInputTournament,
  ...recalcResult.mongoUpdate.$set,
};

const report = {
  ok: true,
  apply,
  startedAt,
  finishedAt: null,
  tournamentId,
  resultsFile,
  source: {
    resultsCount: inputPayload.results.length,
    paramsKeys: inputPayload.params && typeof inputPayload.params === "object"
      ? Object.keys(inputPayload.params)
      : [],
  },
  before: beforeSummary,
  dryRunAfter: summarizeTournament(afterDryRunTournament),
  dryRunPayload: recalcResult.payload,
  applyResult: null,
  postcheck: null,
};

if (apply) {
  const applyResult = await applyTournamentUpdate({
    mongoUri,
    dbName,
    collectionName,
    tournamentId,
    mongoSet: recalcResult.mongoUpdate.$set,
  });
  report.applyResult = {
    matchedCount: applyResult.matchedCount,
    modifiedCount: applyResult.modifiedCount,
  };
  const postcheckTournament = await fetchTournament({
    mongoUri,
    dbName,
    collectionName,
    tournamentId,
  });
  report.postcheck = summarizeTournament(postcheckTournament);
}

report.finishedAt = new Date().toISOString();

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  apply,
  outFile,
  before: report.before.summary,
  dryRunAfter: report.dryRunAfter.summary,
  applyResult: report.applyResult,
  postcheck: report.postcheck?.summary ?? null,
}, null, 2));
