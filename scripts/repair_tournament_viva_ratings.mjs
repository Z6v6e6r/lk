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
const roundRating = (value) => Number(Number(value).toFixed(5));
const sameRating = (left, right) => {
  const leftNum = toNum(left);
  const rightNum = toNum(right);
  if (leftNum === null || rightNum === null) return false;
  return Math.abs(leftNum - rightNum) < 0.00001;
};

const getLetterGrade = (value) => {
  if (value < 2) return "D";
  if (value < 3) return "D+";
  if (value < 3.5) return "C";
  if (value < 4) return "C+";
  if (value < 4.7) return "B";
  if (value < 5.5) return "B+";
  return "A";
};

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

const fetchJsonAny = async (url, options = {}) => {
  const response = await fetch(url, options);
  const raw = await response.text();
  let payload = raw;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = raw;
  }
  return { ok: response.ok, status: response.status, payload };
};

const fetchLiveRatings = async (lkBase, players, batchSize) => {
  const items = [];
  const errors = [];
  for (let offset = 0; offset < players.length; offset += batchSize) {
    const batch = players.slice(offset, offset + batchSize);
    const response = await fetchJsonAny(`${lkBase}/games/ratings/live`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ players: batch }),
    });
    if (!response.ok) {
      errors.push({ offset, status: response.status, payload: response.payload });
      continue;
    }
    const payload = response.payload;
    const rows = Array.isArray(payload)
      ? payload
      : (Array.isArray(payload?.items)
        ? payload.items
        : (Array.isArray(payload?.data) ? payload.data : []));
    items.push(...rows);
  }
  return { items, errors };
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

const buildEvents = (tournaments, dates, timeZone, options = {}) => {
  const dateSet = new Set(dates);
  const completeOnly = options.completeOnly === true;
  const events = [];
  const skippedTournaments = [];
  const tournamentSummaries = [];

  for (const tournament of tournaments) {
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
    if (dateSet.size > 0 && dateKey && !dateSet.has(dateKey)) continue;

    const standings = asArray(tournament.standings);
    const participants = asArray(tournament.participants);
    const completedMatches = toNum(tournament.summary?.completedMatches);
    const totalMatches = toNum(tournament.summary?.totalMatches);
    const complete = totalMatches !== null && totalMatches > 0 && completedMatches === totalMatches;
    const hasStandings = standings.length > 0;

    tournamentSummaries.push({
      tournamentId,
      date: dateSource,
      dateKey,
      participants: participants.length,
      standings: standings.length,
      complete,
      completedMatches,
      totalMatches,
      family: toStr(tournament.params?.tournamentFamily),
      subtype: toStr(tournament.params?.tournamentSubtype || tournament.params?.mexicanoMode),
    });

    if (!tournamentId || !hasStandings) {
      skippedTournaments.push({
        tournamentId,
        date: dateSource,
        reason: !tournamentId ? "NO_TOURNAMENT_ID" : "NO_STANDINGS",
      });
      continue;
    }
    if (completeOnly && !complete) {
      skippedTournaments.push({
        tournamentId,
        date: dateSource,
        reason: "TOURNAMENT_NOT_COMPLETE",
        completedMatches,
        totalMatches,
      });
      continue;
    }

    const participantById = new Map(participants.map((participant) => [
      toStr(participant?.id),
      participant,
    ]));

    for (const row of standings) {
      const clientId = toStr(row?.id);
      const ratingAfter = toNum(row?.ratingAfter);
      const ratingBefore = toNum(row?.ratingBefore);
      if (!clientId || ratingAfter === null) continue;
      const participant = participantById.get(clientId) || {};
      events.push({
        clientId,
        name: toStr(row?.name || participant.name) || "Игрок",
        tournamentId,
        tournamentDate: dateSource,
        tournamentDateKey: dateKey,
        tournamentComplete: complete,
        rank: toNum(row?.rank),
        matchesPlayed: toNum(row?.matchesPlayed),
        ratingBefore: ratingBefore === null ? null : roundRating(ratingBefore),
        ratingAfter: roundRating(ratingAfter),
        ratingDelta: roundRating(toNum(row?.ratingDelta ?? row?.deltaTotal) ?? 0),
      });
    }
  }

  return { events, skippedTournaments, tournamentSummaries };
};

const buildPlan = (events, liveItems) => {
  const liveByClientId = new Map(
    liveItems
      .map((item) => [toStr(item?.clientId), item])
      .filter(([clientId]) => Boolean(clientId)),
  );

  const eventsByClientId = new Map();
  for (const event of events) {
    if (!eventsByClientId.has(event.clientId)) eventsByClientId.set(event.clientId, []);
    eventsByClientId.get(event.clientId).push(event);
  }

  return Array.from(eventsByClientId.entries())
    .map(([clientId, playerEvents]) => {
      const sortedEvents = playerEvents.sort((left, right) => (
        Date.parse(left.tournamentDate || "") - Date.parse(right.tournamentDate || "")
      ));
      const latestEvent = sortedEvents[sortedEvents.length - 1];
      const current = liveByClientId.get(clientId) || null;
      const currentRating = toNum(current?.ratingNumeric);
      const targetRating = latestEvent.ratingAfter;
      const alreadyCorrect = currentRating !== null && sameRating(currentRating, targetRating);
      const source = toStr(current?.source);
      const liveFetchOk = Boolean(current) && source !== "NO_CLIENT_ID" && !String(source || "").startsWith("FALLBACK_HTTP");
      return {
        clientId,
        name: latestEvent.name,
        currentRating: currentRating === null ? null : roundRating(currentRating),
        currentGrade: toStr(current?.rating),
        currentSource: source,
        targetRating,
        targetGrade: getLetterGrade(targetRating),
        previousTournamentRating: latestEvent.ratingBefore,
        latestTournamentId: latestEvent.tournamentId,
        latestTournamentDate: latestEvent.tournamentDate,
        latestTournamentComplete: latestEvent.tournamentComplete,
        events: sortedEvents,
        eventCount: sortedEvents.length,
        duplicate: sortedEvents.length > 1,
        alreadyCorrect,
        liveFetchOk,
        needsUpdate: liveFetchOk && !alreadyCorrect,
        skippedReason: liveFetchOk
          ? (alreadyCorrect ? "ALREADY_CORRECT" : null)
          : "LIVE_RATING_NOT_VERIFIED",
      };
    })
    .sort((left, right) => {
      if (left.latestTournamentDate !== right.latestTournamentDate) {
        return String(left.latestTournamentDate || "").localeCompare(String(right.latestTournamentDate || ""));
      }
      return String(left.name || "").localeCompare(String(right.name || ""), "ru");
    });
};

const applyPlan = async (lkBase, plan, applyBatchDelayMs) => {
  const results = [];
  for (const item of plan) {
    if (!item.needsUpdate) {
      results.push({
        clientId: item.clientId,
        name: item.name,
        status: "skipped",
        reason: item.skippedReason,
      });
      continue;
    }

    const eventId = [
      "tournament_rating_repair",
      item.latestTournamentId,
      item.clientId,
      item.targetRating.toFixed(5),
    ].join(":");

    const payload = {
      clientId: item.clientId,
      phone: null,
      playerName: item.name,
      levelLetter: item.targetGrade,
      levelNumeric: item.targetRating.toFixed(5),
      source: "tournament_result_repair",
      gameId: item.latestTournamentId,
      previousRating: item.currentRating ?? item.previousTournamentRating,
      nextRating: item.targetRating,
      confirmedAt: item.latestTournamentDate,
      changedById: "codex-repair",
      changedByName: "Codex tournament rating repair",
      changedByPhone: null,
      eventId,
    };

    const response = await fetchJsonAny(`${lkBase}/onboarding/level`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    results.push({
      clientId: item.clientId,
      name: item.name,
      status: response.ok && response.payload?.ok !== false ? "updated" : "failed",
      httpStatus: response.status,
      targetRating: item.targetRating,
      targetGrade: item.targetGrade,
      auditEventId: response.payload?.auditEventId || eventId,
      response: response.ok ? response.payload : undefined,
      error: response.ok ? undefined : response.payload,
    });

    if (applyBatchDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, applyBatchDelayMs));
    }
  }
  return results;
};

const showHelp = hasFlag("--help") || hasFlag("-h");
const apply = hasFlag("--apply");
const postcheckOnly = hasFlag("--postcheck-only");
const completeOnly = hasFlag("--complete-only");
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
const lkBase = (toStr(getArg("--lk-base", "https://padlhub.su/lk")) || "https://padlhub.su/lk").replace(/\/+$/, "");
const liveBatchSize = Math.max(1, Math.min(40, Math.floor(toNum(getArg("--live-batch-size", 20)) || 20)));
const applyDelayMs = Math.max(0, Math.min(5000, Math.floor(toNum(getArg("--apply-delay-ms", 150)) || 0)));
const defaultOut = apply
  ? "tmp/tournament-viva-rating-repair-2026-05-30_2026-06-01-apply.json"
  : (postcheckOnly
    ? "tmp/tournament-viva-rating-repair-2026-05-30_2026-06-01-postcheck.json"
    : "tmp/tournament-viva-rating-repair-2026-05-30_2026-06-01-dryrun.json");
const outFile = toStr(getArg("--out", defaultOut)) || defaultOut;

if (showHelp) {
  console.log(`
repair_tournament_viva_ratings

Finds tournament standings for dates and updates Viva LK rating fields through
the existing LK /onboarding/level endpoint. Default mode is dry-run.

Usage:
  node scripts/repair_tournament_viva_ratings.mjs --dates 2026-05-30,2026-05-31,2026-06-01
  node scripts/repair_tournament_viva_ratings.mjs --dates 2026-05-30,2026-05-31,2026-06-01 --apply

Options:
  --dates <csv>              Moscow dates to scan
  --tournament-ids <csv>     Explicit tournament IDs
  --mongo-uri <uri>          Mongo URI; defaults to env or Node-RED flow
  --db <name>                DB name (default: games)
  --collection <name>        Collection (default: tournaments)
  --lk-base <url>            LK API base (default: https://padlhub.su/lk)
  --out <path>               Report path under tmp/
  --postcheck-only           Only build report and postcheck current Viva values
  --complete-only            Skip tournaments whose summary is not complete by matches
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
const { events, skippedTournaments, tournamentSummaries } = buildEvents(tournaments, dates, timeZone, { completeOnly });

const liveRequestPlayers = Array.from(new Map(events.map((event) => [
  event.clientId,
  {
    clientId: event.clientId,
    name: event.name,
    rating: null,
    ratingNumeric: event.ratingBefore,
  },
])).values());
const liveBefore = await fetchLiveRatings(lkBase, liveRequestPlayers, liveBatchSize);
const plan = buildPlan(events, liveBefore.items);
const duplicatePlayers = plan.filter((item) => item.duplicate);

let applyResults = [];
let liveAfter = null;
if (apply && !postcheckOnly) {
  applyResults = await applyPlan(lkBase, plan, applyDelayMs);
  liveAfter = await fetchLiveRatings(lkBase, liveRequestPlayers, liveBatchSize);
}

const postcheckPlan = liveAfter
  ? buildPlan(events, liveAfter.items)
  : (postcheckOnly ? plan : null);
const postcheck = postcheckPlan
  ? postcheckPlan.map((item) => ({
    clientId: item.clientId,
    name: item.name,
    currentRating: item.currentRating,
    currentGrade: item.currentGrade,
    currentSource: item.currentSource,
    targetRating: item.targetRating,
    targetGrade: item.targetGrade,
    ok: item.alreadyCorrect,
    latestTournamentId: item.latestTournamentId,
  }))
  : null;

const report = {
  ok: true,
  apply,
  postcheckOnly,
  completeOnly,
  startedAt,
  finishedAt: new Date().toISOString(),
  db: dbName,
  collection: collectionName,
  dates,
  timeZone,
  tournaments: tournamentSummaries,
  skippedTournaments,
  source: {
    tournamentDocuments: tournaments.length,
    completeTournaments: tournamentSummaries.filter((item) => item.complete).length,
    skippedIncomplete: skippedTournaments.filter((item) => item.reason === "TOURNAMENT_NOT_COMPLETE").length,
    ratingEvents: events.length,
    uniquePlayers: plan.length,
    duplicatePlayers: duplicatePlayers.length,
    liveRatingErrors: liveBefore.errors,
  },
  summary: {
    needsUpdate: plan.filter((item) => item.needsUpdate).length,
    alreadyCorrect: plan.filter((item) => item.alreadyCorrect).length,
    liveRatingNotVerified: plan.filter((item) => item.skippedReason === "LIVE_RATING_NOT_VERIFIED").length,
    updated: applyResults.filter((item) => item.status === "updated").length,
    failed: applyResults.filter((item) => item.status === "failed").length,
    postcheckOk: postcheck ? postcheck.filter((item) => item.ok).length : null,
    postcheckFailed: postcheck ? postcheck.filter((item) => !item.ok).length : null,
  },
  duplicatePlayers,
  plan,
  applyResults,
  postcheck,
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
