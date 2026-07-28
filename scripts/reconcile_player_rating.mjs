#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";
import { COMMUNITY_RATING_CALCULATION_VERSION } from "../src/services/community-rating/contract.ts";
import {
  PLAYER_RATING_COLLECTIONS,
  buildTournamentRatingEvent,
  normalizeRatingPhone,
  replayPlayerRatingEvents,
} from "../src/services/player-rating/ledger.ts";

const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);
const toStr = (value) => value === null || value === undefined ? null : String(value).trim() || null;
const asArray = (value) => Array.isArray(value) ? value : [];
const maskKey = (value) => value ? `${String(value).slice(0, 6)}...${String(value).slice(-4)}` : null;

function isFinalized(tournament) {
  const status = String(
    tournament?.summary?.status
      || tournament?.params?.status
      || tournament?.status
      || "",
  ).toLowerCase();
  return tournament?.summary?.finished === true
    || tournament?.params?.finished === true
    || tournament?.params?.manualFinish === true
    || ["completed", "finished", "closed", "done"].includes(status);
}

function finishedAt(tournament) {
  const value = tournament?.params?.finishedAt
    || tournament?.params?.completedAt
    || tournament?.summary?.finishedAt
    || tournament?.summary?.completedAt
    || tournament?.updatedAt;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function planToken(eventIds) {
  return `BACKFILL_${crypto.createHash("sha256").update([...eventIds].sort().join("\n")).digest("hex").slice(0, 16).toUpperCase()}`;
}

async function loadEventsForState(db, state) {
  const clientIds = [state.clientId, ...asArray(state?.identityAliases?.clientIds)].filter(Boolean);
  const phones = [state.phoneNorm, ...asArray(state?.identityAliases?.phoneNorms)]
    .map(normalizeRatingPhone)
    .filter(Boolean);
  return db.collection(PLAYER_RATING_COLLECTIONS.events).find({
    $or: [
      { "player.key": state.playerKey },
      ...(clientIds.length ? [{ "player.clientId": { $in: clientIds } }] : []),
      ...(phones.length ? [{ "player.phoneNorm": { $in: phones } }] : []),
    ],
  }).toArray();
}

async function run() {
  const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
  const dbName = getArg("--db", process.env.MONGO_DB || "games");
  const outPath = getArg("--out");
  const apply = hasFlag("--apply-backfill");
  const confirmToken = getArg("--confirm-token");
  if (!mongoUri) throw new Error("Provide --mongo-uri or MONGO_URI/MONGODB_URI");
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const db = client.db(dbName);
    const registry = await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry)
      .findOne({ jobKey: "rating-ledger-projector" });
    const cutoverAt = toStr(registry?.ledgerNotBefore);
    if (!cutoverAt) throw new Error("Missing rating-ledger-projector.ledgerNotBefore");
    const [states, tournaments, existingTournamentEvents] = await Promise.all([
      db.collection(PLAYER_RATING_COLLECTIONS.state).find({}).toArray(),
      db.collection("tournaments").find({}).toArray(),
      db.collection(PLAYER_RATING_COLLECTIONS.events)
        .find({ "source.domain": "TOURNAMENT" }, { projection: { _id: 1 } }).toArray(),
    ]);
    const existingIds = new Set(existingTournamentEvents.map((event) => String(event._id)));
    const missingHistoricalEventsById = new Map();
    let finalizedTournaments = 0;
    let invalidStandings = 0;
    for (const tournament of tournaments) {
      if (!isFinalized(tournament)) continue;
      const tournamentFinishedAt = finishedAt(tournament);
      const tournamentId = toStr(tournament.tournamentId || tournament.id || tournament.exerciseId);
      if (!tournamentFinishedAt || !tournamentId || Date.parse(tournamentFinishedAt) >= Date.parse(cutoverAt)) continue;
      finalizedTournaments += 1;
      for (const standing of asArray(tournament.standings)) {
        const event = buildTournamentRatingEvent({
          tournamentId,
          finishedAt: tournamentFinishedAt,
          standing,
          phoneNorm: normalizeRatingPhone(standing?.phoneNorm || standing?.phone),
          createdAt: new Date().toISOString(),
        });
        if (!event) {
          invalidStandings += 1;
          continue;
        }
        if (existingIds.has(event.id) || missingHistoricalEventsById.has(event.id)) continue;
        missingHistoricalEventsById.set(event.id, {
          ...event,
          eventType: "TOURNAMENT_RATING_HISTORICAL_BACKFILLED",
          source: { ...event.source, historicalBackfill: true, applyToState: false },
          projectionIntent: { viva: "NONE_HISTORICAL_BACKFILL" },
        });
      }
    }
    const missingHistoricalEvents = [...missingHistoricalEventsById.values()];

    const stateDrift = [];
    for (const state of states) {
      const replay = replayPlayerRatingEvents(await loadEventsForState(db, state));
      if (!replay) {
        stateDrift.push({ kind: "NO_REPLAY_BASELINE", playerKey: maskKey(state.playerKey) });
        continue;
      }
      if (Math.abs(Number(state.ratingNumeric) - replay.ratingNumeric) > 0.00001 || state.lastEventId !== replay.lastEventId) {
        stateDrift.push({
          kind: "STATE_REPLAY_MISMATCH",
          playerKey: maskKey(state.playerKey),
          stored: state.ratingNumeric,
          replayed: replay.ratingNumeric,
          storedLastEvent: maskKey(state.lastEventId),
          replayLastEvent: maskKey(replay.lastEventId),
        });
      }
    }

    const token = planToken(missingHistoricalEvents.map((event) => event.id));
    const report = {
      mode: apply ? "APPLY_BACKFILL" : "DRY_RUN",
      createdAt: new Date().toISOString(),
      cutoverAt,
      canonicalStates: states.length,
      finalizedHistoricalTournaments: finalizedTournaments,
      missingHistoricalEvents: missingHistoricalEvents.length,
      invalidStandings,
      stateDriftCount: stateDrift.length,
      stateDrift: stateDrift.slice(0, 100),
      legacySnapshots: await db.collection("community_rating_snapshots").countDocuments({
        calculationVersion: { $ne: COMMUNITY_RATING_CALCULATION_VERSION },
      }),
      confirmationToken: token,
      sampleBackfill: missingHistoricalEvents.slice(0, 10).map((event) => ({
        eventId: maskKey(event.id),
        tournamentId: maskKey(event.source.sourceId),
        playerKey: maskKey(event.player.key),
        occurredAt: event.occurredAt,
        delta: event.change.delta,
      })),
    };
    if (apply) {
      if (confirmToken !== token) {
        throw new Error(`Backfill confirmation token mismatch; expected ${token}`);
      }
      const operations = missingHistoricalEvents.map((event) => ({
        updateOne: {
          filter: { _id: event.id },
          update: { $setOnInsert: event },
          upsert: true,
        },
      }));
      const result = operations.length > 0
        ? await db.collection(PLAYER_RATING_COLLECTIONS.events).bulkWrite(operations, { ordered: true })
        : null;
      report.applyResult = {
        requested: operations.length,
        upserted: Number(result?.upsertedCount || 0),
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

run().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
