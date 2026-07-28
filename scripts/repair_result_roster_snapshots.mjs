#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import {
  inspectResultRosterDrift,
  reconcileResultRosterSnapshot,
} from "./lib/resultRosterRepair.mjs";

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const getArg = (name, fallback = null) => {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : fallback;
};
const splitCsv = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
const toStr = (value) => value === null || value === undefined ? null : String(value).trim() || null;

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`
repair_result_roster_snapshots

Dry-run scanner and guarded v3 roster/session repair.

Usage:
  node scripts/repair_result_roster_snapshots.mjs --game-id <id>
  node scripts/repair_result_roster_snapshots.mjs --date-from YYYY-MM-DD --date-to YYYY-MM-DD

Options:
  --mongo-uri <uri>       Mongo URI (or MONGO_URI / MONGODB_URI)
  --db <name>             Database name (default: games)
  --game-id <id,...>      Exact game IDs
  --date-from <date>      Inclusive booking date
  --date-to <date>        Inclusive booking date
  --limit <n>             Maximum games (default: 500)
  --out <file>            JSON report path
  --apply                 Apply guarded CAS updates
  --confirm <phrase>      Required with --apply: APPLY_RESULT_ROSTER_V3
`);
  process.exit(0);
}

const mongoUri = toStr(getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI));
const dbName = toStr(getArg("--db", process.env.MONGO_DB || "games")) || "games";
const gameIds = splitCsv(getArg("--game-id") || getArg("--game-ids"));
const dateFrom = toStr(getArg("--date-from"));
const dateTo = toStr(getArg("--date-to"));
const apply = hasFlag("--apply");
const confirmation = toStr(getArg("--confirm"));
const limit = Math.max(1, Math.min(5000, Number(getArg("--limit", "500")) || 500));
const outFile = path.resolve(getArg("--out", `tmp/result-roster-repair-${Date.now()}.json`));

if (!mongoUri) throw new Error("Missing --mongo-uri or MONGO_URI / MONGODB_URI");
if (gameIds.length === 0 && (!dateFrom || !dateTo)) {
  throw new Error("Specify exact --game-id values or both --date-from and --date-to");
}
if (apply && confirmation !== "APPLY_RESULT_ROSTER_V3") {
  throw new Error("--apply requires --confirm APPLY_RESULT_ROSTER_V3");
}

const query = { archived: { $ne: true } };
if (gameIds.length > 0) query.id = { $in: gameIds };
else {
  query.$or = [
    { "booking.date": { $gte: dateFrom, $lte: dateTo } },
    { date: { $gte: dateFrom, $lte: dateTo } },
  ];
}

const client = new MongoClient(mongoUri, {
  maxPoolSize: 4,
  serverSelectionTimeoutMS: 15_000,
  connectTimeoutMS: 15_000,
});
const report = {
  createdAt: new Date().toISOString(),
  dryRun: !apply,
  options: { dbName, gameIds, dateFrom, dateTo, limit },
  scanned: 0,
  candidates: [],
  repairedGames: 0,
  repairedSessions: 0,
  conflicts: [],
};

try {
  await client.connect();
  const db = client.db(dbName);
  const games = db.collection("lk_games");
  const sessions = db.collection("lk_game_result_sessions");
  const backups = db.collection("lk_result_roster_repair_backups");
  const rows = await games.find(query, {
    projection: {
      id: 1,
      booking: 1,
      date: 1,
      organizer: 1,
      createdBy: 1,
      participants: 1,
      waitlist: 1,
      teamSlots: 1,
      metadata: 1,
      resultRosterSnapshot: 1,
      updatedAt: 1,
    },
  }).limit(limit).toArray();
  report.scanned = rows.length;

  for (const game of rows) {
    const gameId = toStr(game.id);
    if (!gameId) continue;
    const drift = inspectResultRosterDrift(game, game.resultRosterSnapshot);
    const reconciled = reconcileResultRosterSnapshot({
      game,
      seedSnapshot: game.resultRosterSnapshot,
      source: "repair_result_roster_snapshots",
    });
    if (!drift.needsRepair && reconciled.conflicts.length === 0) continue;
    const item = { gameId, drift, stats: reconciled.stats, applied: false, sessionUpdates: 0 };
    report.candidates.push(item);
    if (reconciled.conflicts.length > 0) {
      report.conflicts.push({ gameId, conflicts: reconciled.conflicts });
      continue;
    }
    if (!apply) continue;

    const backupId = `result-roster-repair:${gameId}:${Date.now()}`;
    await backups.insertOne({
      _id: backupId,
      type: "game",
      gameId,
      createdAt: new Date().toISOString(),
      document: game,
    });
    const gameFilter = { _id: game._id };
    if (game.updatedAt !== undefined) gameFilter.updatedAt = game.updatedAt;
    const gameWrite = await games.updateOne(gameFilter, {
      $set: {
        resultRosterSnapshot: reconciled.snapshot,
        updatedAt: new Date().toISOString(),
        "metadata.resultRosterRepair": {
          source: "repair_result_roster_snapshots",
          backupId,
          at: new Date().toISOString(),
        },
      },
    });
    if (Number(gameWrite.matchedCount || 0) !== 1) {
      item.conflict = "GAME_CHANGED_AFTER_SCAN";
      continue;
    }
    item.applied = true;
    report.repairedGames += 1;

    const activeSessions = await sessions.find({
      gameId,
      deleted: { $ne: true },
      status: { $in: ["ACTIVE", null] },
    }).toArray();
    for (const session of activeSessions) {
      const sessionReconciled = reconcileResultRosterSnapshot({
        game: { ...game, resultRosterSnapshot: reconciled.snapshot },
        seedSnapshot: session.resultRosterSnapshot || session.rosterSnapshot,
        source: "repair_result_roster_session",
      });
      if (sessionReconciled.conflicts.length > 0) {
        report.conflicts.push({
          gameId,
          sessionId: toStr(session.id || session._id),
          conflicts: sessionReconciled.conflicts,
        });
        continue;
      }
      const sessionBackupId = `${backupId}:session:${toStr(session.id || session._id)}`;
      await backups.insertOne({
        _id: sessionBackupId,
        type: "session",
        gameId,
        sessionId: toStr(session.id || session._id),
        createdAt: new Date().toISOString(),
        document: session,
      });
      const currentRevision = Number.isInteger(Number(session.revision)) ? Number(session.revision) : 1;
      const sessionWrite = await sessions.updateOne(
        { _id: session._id, revision: currentRevision },
        {
          $set: {
            resultRosterSnapshot: sessionReconciled.snapshot,
            revision: currentRevision + 1,
            updatedAt: new Date().toISOString(),
            rosterRepair: { source: "repair_result_roster_snapshots", backupId: sessionBackupId },
          },
        },
      );
      if (Number(sessionWrite.matchedCount || 0) === 1) {
        item.sessionUpdates += 1;
        report.repairedSessions += 1;
      }
    }
  }
} finally {
  await client.close();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, outFile }, null, 2));
