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

const summarizeTournament = (tournament) => {
  const rounds = asArray(tournament?.rounds);
  const params = tournament?.params && typeof tournament.params === "object"
    ? tournament.params
    : {};
  const summary = tournament?.summary && typeof tournament.summary === "object"
    ? tournament.summary
    : {};

  return {
    tournamentId: toStr(tournament?.tournamentId || tournament?.id),
    createdAt: toStr(tournament?.createdAt),
    updatedAt: toStr(tournament?.updatedAt),
    tournamentType: toStr(tournament?.tournamentType),
    targetScore: tournament?.targetScore ?? params.targetScore ?? null,
    courts: asArray(tournament?.courts).length,
    participants: asArray(tournament?.participants).length,
    roundsCount: rounds.length,
    matchesCount: rounds.reduce((sum, round) => sum + asArray(round?.matches).length, 0),
    params: {
      status: params.status ?? null,
      state: params.state ?? null,
      tournamentStatus: params.tournamentStatus ?? null,
      finished: params.finished ?? null,
      isFinished: params.isFinished ?? null,
      tournamentFinished: params.tournamentFinished ?? null,
      manualFinish: params.manualFinish ?? null,
      finishedAt: params.finishedAt ?? null,
      completedAt: params.completedAt ?? null,
      manualFinishedAt: params.manualFinishedAt ?? null,
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

const applyTournamentUpdate = async ({ mongoUri, dbName, collectionName, tournamentId, mongoUpdate }) => {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
    return await client.db(dbName).collection(collectionName).updateOne(
      { tournamentId },
      mongoUpdate,
    );
  } finally {
    await client.close();
  }
};

const runRecalculate = (tournament) => {
  const source = fs.readFileSync(
    path.resolve("scripts/nodered_games_nodes/fn_tournament_recalculate.js"),
    "utf8",
  );
  const fn = new Function("msg", source);
  const currentParams = tournament?.params && typeof tournament.params === "object"
    ? tournament.params
    : {};
  return fn({
    payload: JSON.parse(JSON.stringify(tournament)),
    req: {
      body: {
        results: [],
        params: {
          ...currentParams,
          status: "in_progress",
          state: "in_progress",
          tournamentStatus: "in_progress",
          finished: false,
          isFinished: false,
          tournamentFinished: false,
          manualFinish: false,
          finishedAt: null,
          completedAt: null,
          manualFinishedAt: null,
          resumeRequested: true,
        },
      },
    },
  });
};

const showHelp = hasFlag("--help") || hasFlag("-h");
const apply = hasFlag("--apply");
const tournamentId = toStr(getArg("--tournament-id"));
const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI))
  || readMongoUriFromFlow();
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const collectionName = toStr(getArg("--collection", "tournaments")) || "tournaments";
const defaultOut = apply
  ? `tmp/tournament-${tournamentId || "resume"}-resume-apply.json`
  : `tmp/tournament-${tournamentId || "resume"}-resume-dryrun.json`;
const outFile = toStr(getArg("--out", defaultOut)) || defaultOut;

if (showHelp) {
  console.log(`
resume_tournament_manual_finish

Clears manual tournament finish markers by running the same Node-RED
recalculation function used by the LK tournament resume action.

Usage:
  node scripts/resume_tournament_manual_finish.mjs --tournament-id <uuid>
  node scripts/resume_tournament_manual_finish.mjs --tournament-id <uuid> --apply

Options:
  --tournament-id <uuid>       Tournament identifier in Mongo
  --mongo-uri <uri>            Mongo URI; defaults to env or node-red/modular/source.flow.json
  --db <name>                  DB name (default: games)
  --collection <name>          Collection name (default: tournaments)
  --out <path>                 Report path under tmp/
`);
  process.exit(0);
}

if (!tournamentId) {
  console.error("Pass --tournament-id.");
  process.exit(1);
}

if (!mongoUri) {
  console.error("Missing Mongo URI. Pass --mongo-uri, set MONGO_URI/MONGODB_URI, or keep node-red/modular/source.flow.json available.");
  process.exit(1);
}

const startedAt = new Date().toISOString();
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

const before = summarizeTournament(beforeTournament);
const recalcResult = runRecalculate(beforeTournament);
if (!recalcResult?.mongoUpdate?.$set) {
  console.error("Recalculation did not return a Mongo update payload.");
  process.exit(1);
}

const dryRunAfter = summarizeTournament({
  ...beforeTournament,
  ...recalcResult.mongoUpdate.$set,
});

const report = {
  ok: true,
  apply,
  startedAt,
  finishedAt: null,
  tournamentId,
  before,
  dryRunAfter,
  applyResult: null,
  postcheck: null,
};

if (apply) {
  const applyResult = await applyTournamentUpdate({
    mongoUri,
    dbName,
    collectionName,
    tournamentId,
    mongoUpdate: recalcResult.mongoUpdate,
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
  before: {
    params: report.before.params,
    summary: report.before.summary,
  },
  dryRunAfter: {
    params: report.dryRunAfter.params,
    summary: report.dryRunAfter.summary,
  },
  applyResult: report.applyResult,
  postcheck: report.postcheck
    ? {
        params: report.postcheck.params,
        summary: report.postcheck.summary,
      }
    : null,
}, null, 2));
