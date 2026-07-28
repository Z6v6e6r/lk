#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import {
  buildGameRepairFilter,
  buildRatingEventRevertOperation,
  buildResultSessionResetOperation,
} from "./lib/resultRepairPartialSubmit.mjs";

const SCRIPT_NAME = "repair_result_launch_period";
const REPAIR_REASON = "RESULT_LAUNCH_PERIOD_RESET";
const DEFAULT_DATE_FROM = "2026-06-01";
const DEFAULT_DATE_TO = "2026-06-04";
const DEFAULT_TIME_ZONE = "Europe/Moscow";

const argv = process.argv.slice(2);

const getArg = (name, fallback = undefined) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? true : value;
};

const hasFlag = (name) => argv.includes(name);
const splitCsv = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap((item) => splitCsv(item));
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const asArray = (value) => (Array.isArray(value) ? value : []);
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

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

const parseIsoTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const mapNumToGrade = (value) => {
  const rating = Number(value);
  if (!Number.isFinite(rating)) return null;
  if (rating < 2) return "D";
  if (rating < 3) return "D+";
  if (rating < 3.5) return "C";
  if (rating < 4) return "C+";
  if (rating < 4.7) return "B";
  if (rating < 5.5) return "B+";
  return "A";
};

const getDateKey = (game) => {
  const rawDate = toStr(game?.booking?.date || game?.date);
  if (rawDate && /^\d{4}-\d{2}-\d{2}/.test(rawDate)) return rawDate.slice(0, 10);
  return null;
};

const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const NOW_TS = NOW.getTime();

const isCancelledGame = (game) => String(game?.status || "").trim().toUpperCase().includes("CANCEL");

const resolveMongoUriFromFlow = () => {
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

const buildRatingRevertOps = (ratingImpact, nowIso, gameId, resultId) => asArray(ratingImpact)
  .map((entry) => {
    const phoneNorm = normalizePhone(entry?.phoneNorm || entry?.phone || entry?.phoneNumber);
    if (!phoneNorm) return null;
    const before = Number(entry?.before);
    if (!Number.isFinite(before)) return null;
    const gradeBefore = entry?.gradeBefore || mapNumToGrade(before);
    const delta = Number(entry?.delta || 0);
    return {
      updateOne: {
        filter: { phoneNorm },
        update: {
          $set: {
            phoneNorm,
            name: toStr(entry?.name) || "Игрок",
            ratingNumeric: before,
            rating: gradeBefore,
            updatedAt: nowIso,
            lastGameId: gameId,
            lastResultId: resultId,
            lastDelta: -delta,
            team: toStr(entry?.team) || null,
          },
          $setOnInsert: { createdAt: nowIso },
        },
        upsert: true,
      },
    };
  })
  .filter(Boolean);

const applyRatingRevertToPlayers = (players, ratingImpact) => asArray(players).map((player) => {
  if (!player || typeof player !== "object") return player;
  const phoneNorm = normalizePhone(player.phoneNorm || player.phone || player.phoneNumber);
  if (!phoneNorm) return player;
  const impact = asArray(ratingImpact).find((entry) => normalizePhone(entry?.phoneNorm) === phoneNorm);
  if (!impact) return player;
  const before = Number(impact.before);
  if (!Number.isFinite(before)) return player;
  return {
    ...player,
    phoneNorm,
    ratingNumeric: before,
    rating: impact.gradeBefore || mapNumToGrade(before),
  };
});

const normalizeResultDoc = (doc) => {
  if (!isRecord(doc)) return null;
  return {
    id: toStr(doc.id || doc._id),
    gameId: toStr(doc.gameId),
    status: toStr(doc.status || doc.lifecycleState),
    submittedAtTs: Number(doc.submittedAtTs || doc.createdTs || 0),
    submittedAt: toStr(doc.submittedAt),
    createdTs: Number(doc.createdTs || 0),
    updatedAt: toStr(doc.updatedAt),
    ratingImpact: asArray(doc.ratingImpact),
    deleted: doc.deleted === true,
  };
};

const buildGameRepairCandidate = (game, resultDocs, ratingEventDocs = [], resultSessionDocs = []) => {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const matchResult = metadata && isRecord(metadata.matchResult) ? metadata.matchResult : null;
  const topLevelMatchResult = isRecord(game.matchResult) ? game.matchResult : null;
  const activeResultDocs = asArray(resultDocs).map(normalizeResultDoc).filter(Boolean);
  const latestResultDoc = activeResultDocs
    .slice()
    .sort((a, b) => Number(b.submittedAtTs || b.createdTs || 0) - Number(a.submittedAtTs || a.createdTs || 0))[0] || null;
  const latestRatingEvent = asArray(ratingEventDocs)
    .filter((event) => toStr(event?.status)?.toUpperCase() !== "REVERTED")
    .slice()
    .sort((left, right) => (
      Number(right?.pendingAtTs || right?.updatedAtTs || parseIsoTs(right?.updatedAt) || 0)
      - Number(left?.pendingAtTs || left?.updatedAtTs || parseIsoTs(left?.updatedAt) || 0)
    ))[0] || null;
  const sourceMatchResult = latestResultDoc || normalizeResultDoc({
    id: topLevelMatchResult?.id || matchResult?.id || latestRatingEvent?.resultId || null,
    gameId: game.id,
    status: topLevelMatchResult?.status
      || matchResult?.status
      || game.resultStatus
      || game.resultLifecycleState
      || latestRatingEvent?.status
      || null,
    submittedAtTs: parseIsoTs(topLevelMatchResult?.submittedAt || matchResult?.submittedAt)
      || parseIsoTs(game.lastResultAt)
      || Number(latestRatingEvent?.pendingAtTs || latestRatingEvent?.updatedAtTs || 0)
      || parseIsoTs(latestRatingEvent?.updatedAt)
      || parseIsoTs(game.updatedAt)
      || 0,
    ratingImpact: topLevelMatchResult?.ratingImpact || matchResult?.ratingImpact || [],
  });

  if (!sourceMatchResult) return null;

  const hasRepairableState = Boolean(
    activeResultDocs.length > 0
    || matchResult
    || topLevelMatchResult
    || game.resultStatus
    || game.resultLifecycleState
    || game.resultId
    || game.lastResultAt
    || latestRatingEvent
  );
  if (!hasRepairableState) return null;

  return {
    gameId: toStr(game.id),
    game,
    dateKey: getDateKey(game),
    resultDocs: activeResultDocs,
    ratingEventDocs: asArray(ratingEventDocs),
    resultSessionDocs: asArray(resultSessionDocs),
    latestResultDoc: sourceMatchResult,
    latestTimestamp: Number(sourceMatchResult.submittedAtTs || sourceMatchResult.createdTs || 0)
      || Number(parseIsoTs(game.lastResultAt) || 0)
      || Number(parseIsoTs(game.updatedAt) || 0),
  };
};

function activeResultIds(resultDocs) {
  return unique(
    asArray(resultDocs)
      .map((doc) => toStr(doc?.id || doc?._id))
      .filter(Boolean),
  );
}

function buildGameUpdateDoc(game, latestResultDoc, resultIds) {
  const ratingImpact = asArray(latestResultDoc.ratingImpact);
  const nextParticipants = Array.isArray(game.participants)
    ? (ratingImpact.length > 0 ? applyRatingRevertToPlayers(game.participants, ratingImpact) : game.participants)
    : undefined;
  const nextWaitlist = Array.isArray(game.waitlist)
    ? (ratingImpact.length > 0 ? applyRatingRevertToPlayers(game.waitlist, ratingImpact) : game.waitlist)
    : undefined;
  const resultRepair = {
    at: NOW_ISO,
    reason: REPAIR_REASON,
    source: SCRIPT_NAME,
    resultIds,
    latestResultId: toStr(latestResultDoc.id || latestResultDoc._id),
    latestStatus: toStr(latestResultDoc.status),
  };

  const update = {
    $set: {
      updatedAt: NOW_ISO,
      "metadata.resultRepair": resultRepair,
    },
    $unset: {
      "metadata.matchResult": "",
      matchResult: "",
      resultStatus: "",
      resultLifecycleState: "",
      resultDisputeState: "",
      resultId: "",
      lastResultAt: "",
    },
  };

  if (Array.isArray(nextParticipants)) update.$set.participants = nextParticipants;
  if (Array.isArray(nextWaitlist)) update.$set.waitlist = nextWaitlist;

  return { update, resultRepair };
}

const writeJsonReport = (filePath, report) => {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, "utf8");
};

const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI)) || resolveMongoUriFromFlow();
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const gamesCollectionName = toStr(getArg("--games-collection", process.env.MONGO_GAMES_COLLECTION || "lk_games")) || "lk_games";
const resultsCollectionName = toStr(getArg("--results-collection", process.env.MONGO_RESULTS_COLLECTION || "lk_game_results")) || "lk_game_results";
const ratingsCollectionName = toStr(getArg("--ratings-collection", process.env.MONGO_RATINGS_COLLECTION || "player_ratings")) || "player_ratings";
const ratingEventsCollectionName = toStr(getArg("--rating-events-collection", process.env.MONGO_RATING_EVENTS_COLLECTION || "lk_game_rating_events")) || "lk_game_rating_events";
const resultSessionsCollectionName = toStr(getArg("--result-sessions-collection", process.env.MONGO_RESULT_SESSIONS_COLLECTION || "lk_game_result_sessions")) || "lk_game_result_sessions";
const dateFrom = toStr(getArg("--date-from", DEFAULT_DATE_FROM)) || DEFAULT_DATE_FROM;
const dateTo = toStr(getArg("--date-to", DEFAULT_DATE_TO)) || DEFAULT_DATE_TO;
const limit = Math.max(1, Math.min(5000, Math.floor(toNum(getArg("--limit", 1000)) || 1000)));
const outFile = toStr(getArg("--out", `tmp/${SCRIPT_NAME}-${Date.now()}.json`)) || `tmp/${SCRIPT_NAME}-${Date.now()}.json`;
const apply = hasFlag("--apply");
const dryRun = !apply;
const verbose = hasFlag("--verbose");
const includeCancelled = hasFlag("--include-cancelled");
const gameIdsFilter = unique([
  ...splitCsv(getArg("--game-id")),
  ...splitCsv(getArg("--game-ids")),
]);

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
repair_result_launch_period

Снимает старые result-документы launch-period и возвращает игры в состояние "Ввод результата".
По умолчанию работает в dry-run и пишет JSON-отчет.

Usage:
  node scripts/repair_result_launch_period.mjs [options]
  npm run repair:result-launch-period -- [options]

Main options:
  --mongo-uri <uri>           Mongo URI (или MONGO_URI / MONGODB_URI)
  --db <name>                 DB name (default: games)
  --games-collection <name>   Games collection (default: lk_games)
  --results-collection <name> Results collection (default: lk_game_results)
  --ratings-collection <name> Ratings collection (default: player_ratings)
  --rating-events-collection <name> Rating events collection (default: lk_game_rating_events)
  --result-sessions-collection <name> Result sessions collection (default: lk_game_result_sessions)
  --date-from <YYYY-MM-DD>    Start date (default: 2026-06-01)
  --date-to <YYYY-MM-DD>      End date (default: 2026-06-04)
  --game-id <id>              One game id (CSV allowed)
  --game-ids <id1,id2,...>    Multiple game ids
  --limit <n>                 Max games to scan (default: 1000)
  --include-cancelled         Also repair cancelled games
  --out <path>                JSON report path
  --apply                     Apply repairs (default dry-run)
  --verbose                   Log per-game actions
`);
  process.exit(0);
}

if (!mongoUri) {
  console.error("Missing --mongo-uri (or MONGO_URI / MONGODB_URI env), and could not infer URI from Node-RED flow");
  process.exit(1);
}

const client = new MongoClient(mongoUri, {
  maxPoolSize: 8,
  minPoolSize: 0,
  serverSelectionTimeoutMS: 20000,
  connectTimeoutMS: 20000,
});

const getCollections = () => {
  const db = client.db(dbName);
  return {
    db,
    games: db.collection(gamesCollectionName),
    results: db.collection(resultsCollectionName),
    ratings: db.collection(ratingsCollectionName),
    ratingEvents: db.collection(ratingEventsCollectionName),
    resultSessions: db.collection(resultSessionsCollectionName),
  };
};

const buildGameQuery = () => {
  const query = {
    archived: { $ne: true },
    $or: [
      { "booking.date": { $gte: dateFrom, $lte: dateTo } },
      { date: { $gte: dateFrom, $lte: dateTo } },
    ],
  };
  if (gameIdsFilter.length > 0) {
    query.id = { $in: gameIdsFilter };
  }
  return query;
};

const main = async () => {
  await client.connect();
  const { games, results, ratings, ratingEvents, resultSessions } = getCollections();

  const gameRows = await games
    .find(buildGameQuery(), {
      projection: {
        _id: 0,
        id: 1,
        status: 1,
        updatedAt: 1,
        lastResultAt: 1,
        resultStatus: 1,
        resultLifecycleState: 1,
        resultDisputeState: 1,
        resultId: 1,
        participants: 1,
        waitlist: 1,
        metadata: 1,
        booking: 1,
        date: 1,
        matchResult: 1,
      },
    })
    .sort({ "booking.date": 1, date: 1, updatedAt: 1, id: 1 })
    .limit(limit)
    .toArray();

  const gameIds = unique(gameRows.map((game) => toStr(game.id)).filter(Boolean));
  const resultRows = gameIds.length > 0
    ? await results.find(
      { gameId: { $in: gameIds }, deleted: { $ne: true } },
      {
        projection: {
          _id: 0,
          id: 1,
          gameId: 1,
          status: 1,
          lifecycleState: 1,
          submittedAtTs: 1,
          submittedAt: 1,
          createdTs: 1,
          updatedAt: 1,
          ratingImpact: 1,
          ratingEvent: 1,
          deleted: 1,
        },
      },
    ).sort({ submittedAtTs: 1, createdTs: 1, updatedAt: 1 }).toArray()
    : [];

  const ratingEventRows = gameIds.length > 0
    ? await ratingEvents.find(
      { gameId: { $in: gameIds }, deleted: { $ne: true } },
      {
        projection: {
          _id: 1,
          id: 1,
          gameId: 1,
          resultId: 1,
          status: 1,
          pendingAtTs: 1,
          updatedAtTs: 1,
          updatedAt: 1,
          ratingImpact: 1,
          deleted: 1,
        },
      },
    ).sort({ pendingAtTs: 1, updatedAtTs: 1, updatedAt: 1 }).toArray()
    : [];

  const resultSessionRows = gameIds.length > 0
    ? await resultSessions.find(
      { gameId: { $in: gameIds }, deleted: { $ne: true } },
      {
        projection: {
          _id: 1,
          id: 1,
          gameId: 1,
          status: 1,
          revision: 1,
          deleted: 1,
          updatedAt: 1,
        },
      },
    ).sort({ updatedAt: 1, _id: 1 }).toArray()
    : [];

  const resultsByGameId = new Map();
  resultRows.forEach((doc) => {
    const gameId = toStr(doc.gameId);
    if (!gameId) return;
    const list = resultsByGameId.get(gameId) || [];
    list.push(doc);
    resultsByGameId.set(gameId, list);
  });

  const ratingEventsByGameId = new Map();
  ratingEventRows.forEach((doc) => {
    const gameId = toStr(doc.gameId);
    if (!gameId) return;
    const list = ratingEventsByGameId.get(gameId) || [];
    list.push(doc);
    ratingEventsByGameId.set(gameId, list);
  });

  const resultSessionsByGameId = new Map();
  resultSessionRows.forEach((doc) => {
    const gameId = toStr(doc.gameId);
    if (!gameId) return;
    const list = resultSessionsByGameId.get(gameId) || [];
    list.push(doc);
    resultSessionsByGameId.set(gameId, list);
  });

  const candidates = gameRows
    .map((game) => {
      const gameId = toStr(game.id);
      if (!gameId) return null;
      if (isCancelledGame(game) && !includeCancelled) {
        return {
          gameId,
          skipped: true,
          reason: "cancelled_game",
          dateKey: getDateKey(game),
        };
      }
      const resultDocs = resultsByGameId.get(gameId) || [];
      const ratingEventDocs = ratingEventsByGameId.get(gameId) || [];
      const resultSessionDocs = resultSessionsByGameId.get(gameId) || [];
      const repairCandidate = buildGameRepairCandidate(game, resultDocs, ratingEventDocs, resultSessionDocs);
      if (!repairCandidate) {
        return {
          gameId,
          skipped: true,
          reason: resultDocs.length > 0 ? "no_repairable_result_state" : "no_result_state",
          dateKey: getDateKey(game),
        };
      }
      return repairCandidate;
    })
    .filter(Boolean);

  const repairPlans = candidates
    .filter((item) => !item.skipped)
    .sort((left, right) => Number(right.latestTimestamp || 0) - Number(left.latestTimestamp || 0));

  const report = {
    createdAt: NOW_ISO,
    dryRun,
    apply,
    dbName,
    collections: {
      games: gamesCollectionName,
      results: resultsCollectionName,
      ratings: ratingsCollectionName,
      ratingEvents: ratingEventsCollectionName,
      resultSessions: resultSessionsCollectionName,
    },
    options: {
      dateFrom,
      dateTo,
      limit,
      includeCancelled,
      gameIds: gameIdsFilter,
      timeZone: DEFAULT_TIME_ZONE,
    },
    scannedGames: gameRows.length,
    scannedResultDocs: resultRows.length,
    scannedRatingEvents: ratingEventRows.length,
    scannedResultSessions: resultSessionRows.length,
    candidateGames: repairPlans.length,
    skipped: candidates.filter((item) => item.skipped).map((item) => ({
      gameId: item.gameId,
      reason: item.reason,
      dateKey: item.dateKey || null,
    })),
    repaired: [],
    failed: [],
  };

  for (const plan of repairPlans) {
    const gameId = plan.gameId;
    const latestResultId = toStr(plan.latestResultDoc.id || plan.latestResultDoc._id);
    const resultIds = activeResultIds(plan.resultDocs);
    const ratingImpact = asArray(plan.latestResultDoc.ratingImpact).filter((entry) => isRecord(entry));
    const latestStatus = toStr(plan.latestResultDoc.status);
    const ratingEventOps = asArray(plan.ratingEventDocs)
      .map((event) => buildRatingEventRevertOperation({
        event,
        gameId,
        activeResultIds: resultIds,
        nowIso: NOW_ISO,
        nowTs: NOW_TS,
        reason: REPAIR_REASON,
        source: SCRIPT_NAME,
      }))
      .filter(Boolean);
    const sessionOps = asArray(plan.resultSessionDocs)
      .map((session) => buildResultSessionResetOperation({
        session,
        gameId,
        resultIds,
        nowIso: NOW_ISO,
        nowTs: NOW_TS,
        reason: REPAIR_REASON,
        source: SCRIPT_NAME,
      }))
      .filter(Boolean);

    const itemReport = {
      gameId,
      dateKey: plan.dateKey,
      latestResultId,
      latestStatus,
      resultIds,
      ratingImpactRows: ratingImpact.length,
      revertedPlayers: ratingImpact.length,
      ratingUpdates: ratingImpact.length,
      resultDocsSoftDeleted: resultIds.length,
      ratingEventIds: asArray(plan.ratingEventDocs).map((event) => toStr(event?.id || event?._id)).filter(Boolean),
      ratingEventsRevertPlanned: ratingEventOps.length,
      ratingEventsMatched: 0,
      ratingEventsReverted: 0,
      resultSessionIds: asArray(plan.resultSessionDocs).map((session) => toStr(session?.id || session?._id)).filter(Boolean),
      resultSessionsResetPlanned: sessionOps.length,
      resultSessionsMatched: 0,
      resultSessionsReset: 0,
      gameUpdated: false,
      resultUpdated: false,
      warnings: [],
      reason: null,
    };

    try {
      if (verbose) {
        console.log(`[${gameId}] repairing latest result ${latestResultId || "n/a"} (${latestStatus || "unknown"})`);
      }

      if (!dryRun) {
        const { update: gameUpdate } = buildGameUpdateDoc(plan.game, plan.latestResultDoc, resultIds);
        const gameResult = await games.updateOne(
          buildGameRepairFilter({ game: plan.game, gameId }),
          gameUpdate,
        );
        if (Number(gameResult.matchedCount || 0) === 0) {
          const conflictError = new Error("Game result state changed after scan; repair was not applied");
          conflictError.code = "GAME_RESULT_STATE_CHANGED";
          throw conflictError;
        }
        itemReport.gameUpdated = gameResult.modifiedCount > 0 || gameResult.matchedCount > 0;

        if (ratingImpact.length > 0) {
          const ratingOps = buildRatingRevertOps(ratingImpact, NOW_ISO, gameId, latestResultId || gameId);
          if (ratingOps.length > 0) {
            await ratings.bulkWrite(ratingOps, { ordered: true });
          }
        }

        if (resultIds.length > 0) {
          const resultUpdate = await results.updateMany(
            { gameId, id: { $in: resultIds }, deleted: { $ne: true } },
            {
              $set: {
                deleted: true,
                status: "NO_RESULT",
                lifecycleState: "NO_RESULT",
                repairedAt: NOW_ISO,
                repairReason: REPAIR_REASON,
                repairSource: SCRIPT_NAME,
                "ratingEvent.status": "REVERTED",
                "ratingEvent.revertedAt": NOW_ISO,
                "ratingEvent.revertedAtTs": NOW_TS,
                updatedAt: NOW_ISO,
              },
            },
          );
          itemReport.resultUpdated = resultUpdate.modifiedCount > 0 || resultUpdate.matchedCount > 0;
        }

        if (ratingEventOps.length > 0) {
          const eventUpdate = await ratingEvents.bulkWrite(ratingEventOps, { ordered: true });
          itemReport.ratingEventsMatched = Number(eventUpdate.matchedCount || 0);
          itemReport.ratingEventsReverted = Number(eventUpdate.modifiedCount || 0);
          if (itemReport.ratingEventsMatched !== ratingEventOps.length) {
            itemReport.warnings.push("rating_event_changed_concurrently");
          }
        }

        if (sessionOps.length > 0) {
          const sessionUpdate = await resultSessions.bulkWrite(sessionOps, { ordered: true });
          itemReport.resultSessionsMatched = Number(sessionUpdate.matchedCount || 0);
          itemReport.resultSessionsReset = Number(sessionUpdate.modifiedCount || 0);
          if (itemReport.resultSessionsMatched !== sessionOps.length) {
            itemReport.warnings.push("result_session_changed_concurrently");
          }
        }
      } else {
        itemReport.gameUpdated = true;
        itemReport.resultUpdated = resultIds.length > 0;
      }

      report.repaired.push(itemReport);
    } catch (error) {
      report.failed.push({
        ...itemReport,
        gameId,
        code: toStr(error?.code),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  report.counts = {
    ratingEventsRevertPlanned: report.repaired.reduce((sum, item) => sum + item.ratingEventsRevertPlanned, 0),
    ratingEventsMatched: report.repaired.reduce((sum, item) => sum + item.ratingEventsMatched, 0),
    ratingEventsReverted: report.repaired.reduce((sum, item) => sum + item.ratingEventsReverted, 0),
    resultSessionsResetPlanned: report.repaired.reduce((sum, item) => sum + item.resultSessionsResetPlanned, 0),
    resultSessionsMatched: report.repaired.reduce((sum, item) => sum + item.resultSessionsMatched, 0),
    resultSessionsReset: report.repaired.reduce((sum, item) => sum + item.resultSessionsReset, 0),
  };

  writeJsonReport(outFile, report);
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    apply,
    report: path.resolve(outFile),
    scannedGames: report.scannedGames,
    repairedGames: report.repaired.length,
    ratingEventsRevertPlanned: report.counts.ratingEventsRevertPlanned,
    ratingEventsReverted: report.counts.ratingEventsReverted,
    resultSessionsResetPlanned: report.counts.resultSessionsResetPlanned,
    resultSessionsReset: report.counts.resultSessionsReset,
    failedGames: report.failed.length,
    skippedGames: report.skipped.length,
  }, null, 2));
};

try {
  await main();
} finally {
  await client.close().catch(() => {});
}
