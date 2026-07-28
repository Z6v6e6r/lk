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

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const splitCsv = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitCsv(item));
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const isoDateKey = (value, timeZone = "Europe/Moscow") => {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const map = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return map.year && map.month && map.day ? `${map.year}-${map.month}-${map.day}` : null;
};

const parseMoscowDateRange = (dates) => {
  const normalized = unique(dates).sort();
  if (normalized.length === 0) return null;
  const first = normalized[0];
  const last = normalized[normalized.length - 1];
  const start = new Date(`${first}T00:00:00.000+03:00`);
  const end = new Date(`${last}T00:00:00.000+03:00`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
};

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

const toLower = (value) => String(value ?? "").trim().toLowerCase();
const isTruthy = (value) => (
  value === true
  || value === 1
  || value === "1"
  || String(value ?? "").trim().toLowerCase() === "true"
);

const isTournamentMarkedFinished = (paramsValue, summaryValue) => {
  const paramsRecord = paramsValue && typeof paramsValue === "object" ? paramsValue : {};
  const summaryRecord = summaryValue && typeof summaryValue === "object" ? summaryValue : {};
  const statuses = [
    paramsRecord.status,
    paramsRecord.state,
    paramsRecord.tournamentStatus,
    summaryRecord.status,
    summaryRecord.state,
    summaryRecord.tournamentStatus,
  ]
    .map((value) => toLower(value))
    .filter(Boolean);
  if (statuses.some((status) => (
    status === "completed"
    || status === "finished"
    || status === "closed"
    || status === "done"
    || status === "завершен"
    || status === "завершён"
  ))) {
    return true;
  }

  const finishMarkers = [
    paramsRecord.finishedAt,
    paramsRecord.completedAt,
    summaryRecord.finishedAt,
    summaryRecord.completedAt,
  ];
  if (finishMarkers.some((value) => value != null && String(value).trim() !== "")) {
    return true;
  }

  const flags = [
    paramsRecord.finished,
    paramsRecord.isFinished,
    paramsRecord.tournamentFinished,
    paramsRecord.manualFinish,
    summaryRecord.finished,
    summaryRecord.isFinished,
    summaryRecord.tournamentFinished,
    summaryRecord.manualFinish,
  ];
  return flags.some((value) => isTruthy(value));
};

const fetchTournaments = async ({ mongoUri, dbName, collectionName, dates, tournamentIds }) => {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const db = client.db(dbName);
    const projection = {
      _id: 0,
      tournamentId: 1,
      id: 1,
      createdAt: 1,
      updatedAt: 1,
      date: 1,
      startAt: 1,
      startsAt: 1,
      scheduledAt: 1,
      params: 1,
      summary: 1,
      participants: 1,
      standings: 1,
      rounds: 1,
    };
    const query = { archived: { $ne: true } };
    if (tournamentIds.length > 0) {
      query.tournamentId = { $in: tournamentIds };
    } else {
      const range = parseMoscowDateRange(dates);
      query.$or = [
        { createdAt: { $gte: range.startIso, $lt: range.endIso } },
        { date: { $gte: range.startIso, $lt: range.endIso } },
        { startAt: { $gte: range.startIso, $lt: range.endIso } },
        { startsAt: { $gte: range.startIso, $lt: range.endIso } },
        { scheduledAt: { $gte: range.startIso, $lt: range.endIso } },
      ];
    }
    return await db.collection(collectionName)
      .find(query, { projection })
      .sort({ createdAt: 1, date: 1, tournamentId: 1 })
      .toArray();
  } finally {
    await client.close();
  }
};

const isCompletedMatch = (match) => (
  match
  && typeof match === "object"
  && match.score1 !== null
  && match.score1 !== undefined
  && match.score2 !== null
  && match.score2 !== undefined
);

const summarizeRounds = (roundsValue) => {
  const rounds = asArray(roundsValue);
  let totalRounds = rounds.length;
  let completedRounds = 0;
  let totalMatches = 0;
  let completedMatches = 0;
  let partialRounds = 0;

  rounds.forEach((round) => {
    const matches = asArray(round?.matches);
    if (matches.length === 0) return;
    const roundCompletedMatches = matches.reduce((sum, match) => sum + (isCompletedMatch(match) ? 1 : 0), 0);
    totalMatches += matches.length;
    completedMatches += roundCompletedMatches;
    if (roundCompletedMatches === matches.length) completedRounds += 1;
    if (roundCompletedMatches > 0 && roundCompletedMatches < matches.length) partialRounds += 1;
  });

  if (totalMatches === 0) totalRounds = 0;
  return {
    totalRounds,
    completedRounds,
    totalMatches,
    completedMatches,
    partialRounds,
  };
};

const buildPlan = (tournaments, dates, timeZone, options = {}) => {
  const dateSet = new Set(dates);
  const forceIncomplete = options.forceIncomplete === true;
  return tournaments
    .map((tournament) => {
      const tournamentId = toStr(tournament.tournamentId || tournament.id);
      const dateSource = (
        toStr(tournament.createdAt)
        || toStr(tournament.date)
        || toStr(tournament.startAt)
        || toStr(tournament.startsAt)
        || toStr(tournament.scheduledAt)
        || null
      );
      const dateKey = isoDateKey(dateSource, timeZone);
      if (dateSet.size > 0 && dateKey && !dateSet.has(dateKey)) return null;

      const participants = asArray(tournament.participants);
      const standings = asArray(tournament.standings);
      const params = tournament.params && typeof tournament.params === "object" ? tournament.params : {};
      const summary = tournament.summary && typeof tournament.summary === "object" ? tournament.summary : {};
      const roundsSummary = summarizeRounds(tournament.rounds);
      const completedMatches = toNum(summary.completedMatches) ?? roundsSummary.completedMatches;
      const totalMatches = toNum(summary.totalMatches) ?? roundsSummary.totalMatches;
      const completedRounds = toNum(summary.completedRounds) ?? roundsSummary.completedRounds;
      const totalRounds = toNum(summary.totalRounds) ?? roundsSummary.totalRounds;
      const partialRounds = roundsSummary.partialRounds;
      const allMatchesCompleted = (
        totalMatches !== null
        && totalMatches > 0
        && completedMatches === totalMatches
      );
      const hasAnyCompletedMatch = completedMatches !== null && completedMatches > 0;
      const allRoundsCompleted = (
        totalRounds === null
        || completedRounds === null
        || completedRounds === totalRounds
      );
      const alreadyFinished = isTournamentMarkedFinished(params, summary);
      const hasStandings = standings.length > 0;
      const finishedAt = String(
        params.finishedAt
        || params.completedAt
        || summary.finishedAt
        || summary.completedAt
        || tournament.updatedAt
        || dateSource
        || new Date().toISOString()
      );

      let skippedReason = null;
      if (!tournamentId) skippedReason = "NO_TOURNAMENT_ID";
      else if (!hasStandings) skippedReason = "NO_STANDINGS";
      else if (!allMatchesCompleted && partialRounds > 0 && !forceIncomplete) skippedReason = "PARTIAL_ROUND";
      else if (!allMatchesCompleted && !forceIncomplete) skippedReason = "MATCHES_NOT_COMPLETED";
      else if (!allMatchesCompleted && forceIncomplete && !hasAnyCompletedMatch) skippedReason = "NO_COMPLETED_MATCHES";
      else if (alreadyFinished) skippedReason = "ALREADY_FINISHED";

      const needsFinalize = Boolean(
        tournamentId
        && hasStandings
        && !alreadyFinished
        && (
          allMatchesCompleted
          || (forceIncomplete && hasAnyCompletedMatch)
        ),
      );

      return {
        tournamentId,
        date: dateSource,
        dateKey,
        participants: participants.length,
        standings: standings.length,
        completedMatches,
        totalMatches,
        completedRounds,
        totalRounds,
        partialRounds,
        allMatchesCompleted,
        allRoundsCompleted,
        hasAnyCompletedMatch,
        family: toStr(params.tournamentFamily),
        subtype: toStr(params.tournamentSubtype || params.mexicanoMode),
        paramsStatus: toStr(params.status || params.state || params.tournamentStatus),
        paramsFinished: params.finished ?? null,
        paramsManualFinish: params.manualFinish ?? null,
        paramsCompletedAt: toStr(params.completedAt),
        summaryStatus: toStr(summary.status || summary.state || summary.tournamentStatus),
        summaryFinished: summary.finished ?? null,
        summaryManualFinish: summary.manualFinish ?? null,
        summaryCompletedAt: toStr(summary.completedAt),
        alreadyFinished,
        needsFinalize,
        finalizeMode: needsFinalize
          ? (allMatchesCompleted ? "complete_by_matches" : "force_incomplete")
          : null,
        skippedReason,
        targetStatus: "completed",
        targetFinishedAt: finishedAt,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      String(left.date || "").localeCompare(String(right.date || ""))
      || String(left.tournamentId || "").localeCompare(String(right.tournamentId || ""))
    ));
};

const applyPlan = async ({ mongoUri, dbName, collectionName, plan }) => {
  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  try {
    await client.connect();
    const collection = client.db(dbName).collection(collectionName);
    const results = [];

    for (const item of plan) {
      if (!item.needsFinalize) {
        results.push({
          tournamentId: item.tournamentId,
          status: "skipped",
          reason: item.skippedReason,
        });
        continue;
      }

      const finishedAt = item.targetFinishedAt;
      const update = {
        $set: {
          "params.status": "completed",
          "params.finished": true,
          "params.manualFinish": true,
          "params.finishedAt": finishedAt,
          "params.completedAt": finishedAt,
          "summary.status": "completed",
          "summary.finished": true,
          "summary.manualFinish": true,
          "summary.finishedAt": finishedAt,
          "summary.completedAt": finishedAt,
          updatedAt: new Date().toISOString(),
        },
      };

      const response = await collection.updateOne({ tournamentId: item.tournamentId }, update);
      const ok = response.matchedCount === 1;
      results.push({
        tournamentId: item.tournamentId,
        status: ok ? "updated" : "failed",
        matchedCount: response.matchedCount,
        modifiedCount: response.modifiedCount,
        finishedAt,
      });
    }

    return results;
  } finally {
    await client.close();
  }
};

const showHelp = hasFlag("--help") || hasFlag("-h");
const apply = hasFlag("--apply");
const postcheckOnly = hasFlag("--postcheck-only");
const forceIncomplete = hasFlag("--force-incomplete");
const timeZone = toStr(getArg("--time-zone", "Europe/Moscow")) || "Europe/Moscow";
const dates = unique([
  ...splitCsv(getArg("--date")),
  ...splitCsv(getArg("--dates")),
]);
const tournamentIds = unique([
  ...splitCsv(getArg("--tournament-id")),
  ...splitCsv(getArg("--tournament-ids")),
]);
const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI)) || readMongoUriFromFlow();
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const collectionName = toStr(getArg("--collection", "tournaments")) || "tournaments";
const defaultOut = apply
  ? "tmp/tournament-finalize-apply.json"
  : (postcheckOnly ? "tmp/tournament-finalize-postcheck.json" : "tmp/tournament-finalize-dryrun.json");
const outFile = toStr(getArg("--out", defaultOut)) || defaultOut;

if (showHelp) {
  console.log(`
finalize_tournaments_from_results

Marks tournaments as completed in Mongo when all scheduled matches are already
completed and standings are present. Default mode is dry-run.

Usage:
  node scripts/finalize_tournaments_from_results.mjs --dates 2026-06-07,2026-06-08
  node scripts/finalize_tournaments_from_results.mjs --dates 2026-06-07,2026-06-08 --apply

Options:
  --dates <csv>              Moscow dates to scan
  --tournament-ids <csv>     Explicit tournament IDs
  --mongo-uri <uri>          Mongo URI; defaults to env or Node-RED flow
  --db <name>                DB name (default: games)
  --collection <name>        Collection (default: tournaments)
  --out <path>               Report path under tmp/
  --postcheck-only           Only build report and verify current completed flags
  --force-incomplete         Also complete unfinished tournaments with standings and at least one completed match
`);
  process.exit(0);
}

if (!mongoUri) {
  console.error("Missing Mongo URI. Pass --mongo-uri, set MONGO_URI/MONGODB_URI, or keep node-red/modular/source.flow.json available.");
  process.exit(1);
}

if (dates.length === 0 && tournamentIds.length === 0) {
  console.error("Pass --dates <YYYY-MM-DD,...> or --tournament-ids <id,...>.");
  process.exit(1);
}

const startedAt = new Date().toISOString();
const tournaments = await fetchTournaments({
  mongoUri,
  dbName,
  collectionName,
  dates,
  tournamentIds,
});
const plan = buildPlan(tournaments, dates, timeZone, { forceIncomplete });

let applyResults = [];
let postcheckPlan = null;

if (apply && !postcheckOnly) {
  applyResults = await applyPlan({
    mongoUri,
    dbName,
    collectionName,
    plan,
  });
  const postcheckTournaments = await fetchTournaments({
    mongoUri,
    dbName,
    collectionName,
    dates,
    tournamentIds,
  });
  postcheckPlan = buildPlan(postcheckTournaments, dates, timeZone, { forceIncomplete });
} else if (postcheckOnly) {
  postcheckPlan = plan;
}

const report = {
  ok: true,
  apply,
  postcheckOnly,
  forceIncomplete,
  startedAt,
  finishedAt: new Date().toISOString(),
  db: dbName,
  collection: collectionName,
  dates,
  timeZone,
  source: {
    tournamentDocuments: tournaments.length,
    withStandings: plan.filter((item) => item.standings > 0).length,
    completeByMatches: plan.filter((item) => item.allMatchesCompleted).length,
    forceIncompleteCandidates: plan.filter((item) => item.finalizeMode === "force_incomplete").length,
  },
  summary: {
    needsFinalize: plan.filter((item) => item.needsFinalize).length,
    alreadyFinished: plan.filter((item) => item.alreadyFinished).length,
    noStandings: plan.filter((item) => item.skippedReason === "NO_STANDINGS").length,
    matchesNotCompleted: plan.filter((item) => item.skippedReason === "MATCHES_NOT_COMPLETED").length,
    partialRounds: plan.filter((item) => item.skippedReason === "PARTIAL_ROUND").length,
    noCompletedMatches: plan.filter((item) => item.skippedReason === "NO_COMPLETED_MATCHES").length,
    unresolvedNotFinished: plan.filter((item) => !item.alreadyFinished && !item.needsFinalize).length,
    updated: applyResults.filter((item) => item.status === "updated").length,
    failed: applyResults.filter((item) => item.status === "failed").length,
    postcheckFinished: postcheckPlan ? postcheckPlan.filter((item) => item.alreadyFinished).length : null,
    postcheckNeedsFinalize: postcheckPlan ? postcheckPlan.filter((item) => item.needsFinalize).length : null,
  },
  plan,
  applyResults,
  postcheck: postcheckPlan,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  apply,
  outFile,
  summary: report.summary,
  source: report.source,
}, null, 2));
