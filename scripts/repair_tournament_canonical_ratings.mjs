#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_PACKAGE = "/opt/padlhub-rating-worker/current/package.json";
const localPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
const require = createRequire(fs.existsSync(RUNTIME_PACKAGE) ? RUNTIME_PACKAGE : localPackage);
const { MongoClient } = require("mongodb");

const COLLECTIONS = {
  events: "rating_events",
  state: "player_rating_state",
  compatibility: "player_ratings",
  outbox: "rating_projection_outbox",
  jobs: "rating_job_registry",
};
const REPAIR_VERSION = "tournament-canonical-reconciliation-v1.0.8";
const REQUIRED_WORKER_VERSION = "rating-worker-v1.0.8";
const EPSILON = 0.00001;
const BASELINE_TYPES = new Set([
  "RATING_INITIAL_IMPORTED",
  "RATING_BOOTSTRAPPED_FROM_VIVA",
  "RATING_BOOTSTRAPPED_FROM_TOURNAMENT",
  "RATING_TOURNAMENT_CANONICAL_RECONCILED",
]);

const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);
const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => value === null || value === undefined ? null : String(value).trim() || null;
const toFinite = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const roundRating = (value) => Math.round(Math.min(7, Math.max(1, value)) * 100000) / 100000;
const roundDelta = (value) => Math.round(value * 100000) / 100000;
const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const ratingGrade = (value) => {
  const rating = toFinite(value) ?? 1;
  if (rating >= 6) return "A";
  if (rating >= 5) return "B+";
  if (rating >= 4.2) return "B";
  if (rating >= 3.5) return "C+";
  if (rating >= 3) return "C";
  if (rating >= 2.5) return "D+";
  return "D";
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const unique = (values) => [...new Set(values.filter(Boolean))];

function eventTime(event) {
  const parsed = Date.parse(event?.occurredAt || event?.createdAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function eventId(event) {
  return toStr(event?.id || event?._id) || "";
}

function appliesToState(event) {
  return event?.source?.applyToState !== false;
}

function isCanonicalTargetEvent(event) {
  return event?.source?.domain === "TOURNAMENT"
    || event?.source?.repairVersion === REPAIR_VERSION
    || event?.eventType === "RATING_TOURNAMENT_CANONICAL_RECONCILED";
}

export function replayTournamentCanonicalTargets(events) {
  const ordered = events.filter(appliesToState).sort((left, right) => {
    const timeDiff = eventTime(left) - eventTime(right);
    return timeDiff || eventId(left).localeCompare(eventId(right));
  });
  const baseline = ordered.filter((event) => (
    BASELINE_TYPES.has(event?.eventType) && toFinite(event?.change?.after) != null
  )).at(-1);
  if (!baseline) return null;

  const baselineAt = eventTime(baseline);
  let ratingNumeric = toFinite(baseline.change.after);
  let lastEvent = baseline;
  let tournamentTargets = 0;
  let deltaEvents = 0;
  for (const event of ordered) {
    if (eventId(event) === eventId(baseline) || BASELINE_TYPES.has(event?.eventType)) continue;
    if (eventTime(event) < baselineAt) continue;
    if (isCanonicalTargetEvent(event)) {
      const after = toFinite(event?.change?.after);
      if (after == null) continue;
      ratingNumeric = after;
      tournamentTargets += event?.source?.domain === "TOURNAMENT" ? 1 : 0;
      lastEvent = event;
      continue;
    }
    const delta = toFinite(event?.change?.delta);
    if (delta == null) continue;
    ratingNumeric += delta;
    deltaEvents += 1;
    lastEvent = event;
  }
  const rounded = roundRating(ratingNumeric);
  return {
    ratingNumeric: rounded,
    rating: ratingGrade(rounded),
    baselineEventId: eventId(baseline),
    lastSourceEventId: eventId(lastEvent),
    lastSourceEventAt: lastEvent?.occurredAt || lastEvent?.createdAt || null,
    tournamentTargets,
    deltaEvents,
  };
}

export function replayLedgerDeltas(events) {
  const ordered = events.filter(appliesToState).sort((left, right) => {
    const timeDiff = eventTime(left) - eventTime(right);
    return timeDiff || eventId(left).localeCompare(eventId(right));
  });
  const baseline = ordered.filter((event) => (
    BASELINE_TYPES.has(event?.eventType) && toFinite(event?.change?.after) != null
  )).at(-1);
  if (!baseline) return null;
  const baselineAt = eventTime(baseline);
  let ratingNumeric = toFinite(baseline.change.after);
  for (const event of ordered) {
    if (eventId(event) === eventId(baseline) || BASELINE_TYPES.has(event?.eventType)) continue;
    if (eventTime(event) < baselineAt) continue;
    const delta = toFinite(event?.change?.delta);
    if (delta != null) ratingNumeric += delta;
  }
  return roundRating(ratingNumeric);
}

function identityForState(state) {
  return {
    playerKeys: unique([toStr(state?.playerKey)]),
    clientIds: unique([
      toStr(state?.clientId),
      ...asArray(state?.identityAliases?.clientIds).map(toStr),
    ]),
    phoneNorms: unique([
      normalizePhone(state?.phoneNorm),
      ...asArray(state?.identityAliases?.phoneNorms).map(normalizePhone),
    ]),
  };
}

function eventMatchesIdentity(event, identity) {
  const key = toStr(event?.player?.key);
  const clientId = toStr(event?.player?.clientId);
  const phoneNorm = normalizePhone(event?.player?.phoneNorm);
  return (key && identity.playerKeys.includes(key))
    || (clientId && identity.clientIds.includes(clientId))
    || (phoneNorm && identity.phoneNorms.includes(phoneNorm));
}

function eventFrontierHash(events) {
  const rows = events.filter(appliesToState).map((event) => [
    eventId(event),
    event?.occurredAt || event?.createdAt || null,
    event?.eventType || null,
    event?.source?.domain || null,
    event?.change?.delta ?? null,
    event?.change?.after ?? null,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return sha256(JSON.stringify(rows));
}

function buildPlanRow(state, events) {
  const replay = replayTournamentCanonicalTargets(events);
  const ledgerReplayRating = replayLedgerDeltas(events);
  const current = toFinite(state?.ratingNumeric);
  if (!replay || current == null || Math.abs(current - replay.ratingNumeric) <= EPSILON) return null;
  const frontierHash = eventFrontierHash(events);
  const playerKey = toStr(state.playerKey);
  const eventHash = sha256(JSON.stringify([
    REPAIR_VERSION,
    playerKey,
    current,
    replay.ratingNumeric,
    toStr(state.lastEventId),
    frontierHash,
  ])).slice(0, 24);
  return {
    stateId: state._id,
    playerKey,
    clientId: toStr(state.clientId),
    phoneNorm: normalizePhone(state.phoneNorm),
    name: toStr(state.name) || "Игрок",
    currentRating: current,
    desiredRating: replay.ratingNumeric,
    currentGrade: toStr(state.rating) || ratingGrade(current),
    desiredGrade: replay.rating,
    delta: roundDelta(replay.ratingNumeric - current),
    ledgerReplayRating,
    ledgerReplayMatchesStored: ledgerReplayRating != null
      && Math.abs(ledgerReplayRating - current) <= EPSILON,
    vivaProjectionReady: Boolean(toStr(state.clientId)),
    expectedLastEventId: toStr(state.lastEventId),
    sourceFrontierHash: frontierHash,
    sourceEventCount: events.filter(appliesToState).length,
    tournamentTargets: replay.tournamentTargets,
    latestSourceEventId: replay.lastSourceEventId,
    latestSourceEventAt: replay.lastSourceEventAt,
    repairEventId: `rating_evt:tournament_reconciliation:${eventHash}:${playerKey}`,
  };
}

export function buildConfirmationToken(plan) {
  const payload = plan.map((row) => [
    row.repairEventId,
    row.currentRating,
    row.desiredRating,
    row.expectedLastEventId,
    row.sourceFrontierHash,
  ]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return `REPAIR_${sha256(JSON.stringify(payload)).slice(0, 20).toUpperCase()}`;
}

export function buildRepairEvent(row, nowIso) {
  return {
    _id: row.repairEventId,
    id: row.repairEventId,
    idempotencyKey: row.repairEventId,
    schemaVersion: 1,
    eventType: "RATING_TOURNAMENT_CANONICAL_RECONCILED",
    occurredAt: nowIso,
    createdAt: nowIso,
    player: {
      key: row.playerKey,
      clientId: row.clientId,
      phoneNorm: row.phoneNorm,
      name: row.name,
    },
    actor: {
      type: "SYSTEM",
      id: "system:rating-repair-v1.0.8",
      name: "Rating repair v1.0.8",
    },
    source: {
      domain: "RATING_REPAIR",
      sourceId: REPAIR_VERSION,
      repairVersion: REPAIR_VERSION,
      reason: "TOURNAMENT_RATING_AFTER_IS_CANONICAL_TARGET",
      sourceFrontierHash: row.sourceFrontierHash,
      sourceEventCount: row.sourceEventCount,
      tournamentTargets: row.tournamentTargets,
      latestSourceEventId: row.latestSourceEventId,
      applyToState: true,
      ratingApplication: "CANONICAL_RECONCILIATION_DELTA",
    },
    change: {
      before: row.currentRating,
      delta: row.delta,
      after: row.desiredRating,
      gradeBefore: row.currentGrade,
      gradeAfter: row.desiredGrade,
    },
    formula: {
      version: REPAIR_VERSION,
      applicationVersion: "canonical-target-after-reconciliation-v1",
    },
    projectionIntent: { viva: "REQUIRED" },
  };
}

function readMongoUriFromFlow(flowPath) {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const mongoNode = flow.find((item) => item?.type === "mongodb4-client"
    && typeof item.uri === "string" && item.uri.includes("/games"));
  if (!mongoNode?.uri) throw new Error("Mongo URI not found in active Node-RED flow");
  return mongoNode.uri;
}

async function loadEventsForState(db, state, options = {}) {
  const identity = identityForState(state);
  const clauses = [
    ...(identity.playerKeys.length ? [{ "player.key": { $in: identity.playerKeys } }] : []),
    ...(identity.clientIds.length ? [{ "player.clientId": { $in: identity.clientIds } }] : []),
    ...(identity.phoneNorms.length ? [{ "player.phoneNorm": { $in: identity.phoneNorms } }] : []),
  ];
  return db.collection(COLLECTIONS.events).find(
    clauses.length === 1 ? clauses[0] : { $or: clauses },
    options,
  ).toArray();
}

async function buildPlan(db, states) {
  const allEvents = await db.collection(COLLECTIONS.events).find({}).toArray();
  return states.map((state) => {
    const identity = identityForState(state);
    const events = allEvents.filter((event) => eventMatchesIdentity(event, identity));
    return buildPlanRow(state, events);
  }).filter(Boolean).sort((left, right) => left.playerKey.localeCompare(right.playerKey));
}

async function resolveCompatibilityTarget(db, state, session) {
  const identity = identityForState(state);
  const clauses = [
    ...(identity.playerKeys.length ? [{ playerKey: { $in: identity.playerKeys } }] : []),
    ...(identity.clientIds.length ? [{ clientId: { $in: identity.clientIds } }] : []),
    ...(identity.phoneNorms.length ? [{ phoneNorm: { $in: identity.phoneNorms } }] : []),
  ];
  const rows = await db.collection(COLLECTIONS.compatibility)
    .find(clauses.length === 1 ? clauses[0] : { $or: clauses }, { session })
    .limit(3)
    .toArray();
  if (rows.length !== 1) {
    throw new Error(`Expected one compatibility row for ${state.playerKey}; got ${rows.length}`);
  }
  return rows[0];
}

async function applyPlanRow(client, db, plannedRow) {
  const session = client.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const state = await db.collection(COLLECTIONS.state).findOne(
        { _id: plannedRow.stateId },
        { session },
      );
      if (!state) throw new Error(`State disappeared for ${plannedRow.playerKey}`);
      if (toFinite(state.ratingNumeric) !== plannedRow.currentRating
        || toStr(state.lastEventId) !== plannedRow.expectedLastEventId) {
        throw new Error(`State CAS changed for ${plannedRow.playerKey}`);
      }
      const events = await loadEventsForState(db, state, { session });
      const currentPlan = buildPlanRow(state, events);
      if (!currentPlan
        || currentPlan.repairEventId !== plannedRow.repairEventId
        || currentPlan.sourceFrontierHash !== plannedRow.sourceFrontierHash) {
        throw new Error(`Event frontier changed for ${plannedRow.playerKey}`);
      }
      const compatibility = await resolveCompatibilityTarget(db, state, session);
      const nowIso = new Date().toISOString();
      const event = buildRepairEvent(currentPlan, nowIso);
      await db.collection(COLLECTIONS.events).insertOne(event, { session });

      const stateSet = {
        ratingNumeric: currentPlan.desiredRating,
        rating: currentPlan.desiredGrade,
        lastEventId: event.id,
        lastEventType: event.eventType,
        lastEventAt: event.occurredAt,
        lastSource: "tournament_canonical_reconciliation",
        lastDelta: currentPlan.delta,
        lastChangedBy: event.actor,
        projectedBy: REPAIR_VERSION,
        projectedAt: nowIso,
        updatedAt: nowIso,
      };
      const stateUpdate = await db.collection(COLLECTIONS.state).updateOne(
        {
          _id: state._id,
          ratingNumeric: currentPlan.currentRating,
          lastEventId: currentPlan.expectedLastEventId,
        },
        { $set: stateSet },
        { session },
      );
      if (stateUpdate.matchedCount !== 1) throw new Error(`State CAS update failed for ${state.playerKey}`);

      const compatibilitySet = {
        schemaVersion: state.schemaVersion,
        ownership: state.ownership,
        playerKey: state.playerKey,
        clientId: state.clientId || null,
        phoneNorm: state.phoneNorm || null,
        name: state.name,
        baseline: state.baseline,
        identityAliases: state.identityAliases,
        ...stateSet,
        compatibilityProjection: true,
        canonicalCollection: COLLECTIONS.state,
        compatibilityUpdatedAt: nowIso,
      };
      const compatibilityUpdate = await db.collection(COLLECTIONS.compatibility).updateOne(
        { _id: compatibility._id },
        { $set: compatibilitySet },
        { session },
      );
      if (compatibilityUpdate.matchedCount !== 1) {
        throw new Error(`Compatibility update failed for ${state.playerKey}`);
      }

      const outboxId = `rating_projection:${event.id}`;
      await db.collection(COLLECTIONS.outbox).insertOne({
        _id: outboxId,
        id: outboxId,
        ratingEventId: event.id,
        playerKey: state.playerKey,
        clientId: state.clientId,
        phoneNorm: state.phoneNorm,
        payload: {
          clientId: state.clientId,
          phone: state.phoneNorm,
          playerName: state.name,
          levelLetter: currentPlan.desiredGrade,
          levelNumeric: currentPlan.desiredRating.toFixed(5),
          source: "tournament_rating_repair",
          tournamentId: null,
          previousRating: currentPlan.currentRating,
          nextRating: currentPlan.desiredRating,
          confirmedAt: event.occurredAt,
          changedById: event.actor.id,
          changedByName: event.actor.name,
          eventId: event.id,
        },
        status: "PENDING",
        attempts: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
        nextAttemptAt: nowIso,
      }, { session });
      result = {
        playerKey: state.playerKey,
        clientId: state.clientId,
        phoneNorm: state.phoneNorm,
        before: currentPlan.currentRating,
        after: currentPlan.desiredRating,
        delta: currentPlan.delta,
        eventId: event.id,
        outboxId,
        transaction: "COMMITTED",
      };
    }, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function publicPlanRow(row, full) {
  return {
    playerKey: full ? row.playerKey : `${row.playerKey.slice(0, 12)}...`,
    clientId: full ? row.clientId : (row.clientId ? `${row.clientId.slice(0, 8)}...` : null),
    phoneNorm: full ? row.phoneNorm : (row.phoneNorm ? `${row.phoneNorm.slice(0, 4)}***${row.phoneNorm.slice(-2)}` : null),
    name: full ? row.name : undefined,
    currentRating: row.currentRating,
    desiredRating: row.desiredRating,
    delta: row.delta,
    currentGrade: row.currentGrade,
    desiredGrade: row.desiredGrade,
    ledgerReplayRating: row.ledgerReplayRating,
    ledgerReplayMatchesStored: row.ledgerReplayMatchesStored,
    vivaProjectionReady: row.vivaProjectionReady,
    tournamentTargets: row.tournamentTargets,
    sourceEventCount: row.sourceEventCount,
    expectedLastEventId: full ? row.expectedLastEventId : undefined,
    latestSourceEventId: full ? row.latestSourceEventId : undefined,
    repairEventId: full ? row.repairEventId : undefined,
  };
}

async function run() {
  const apply = hasFlag("--apply");
  const all = hasFlag("--all");
  const phoneNorm = normalizePhone(getArg("--phone"));
  const confirmToken = getArg("--confirm-token");
  const outPath = getArg("--out");
  const dbName = getArg("--db", process.env.MONGO_DB || "games");
  const flowPath = getArg("--flow-path", process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json");
  const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI)
    || readMongoUriFromFlow(flowPath);
  if (all === Boolean(phoneNorm)) throw new Error("Choose exactly one scope: --phone PHONE or --all");

  const client = new MongoClient(mongoUri, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    retryWrites: true,
  });
  let report;
  try {
    await client.connect();
    const db = client.db(dbName);
    const workerJob = await db.collection(COLLECTIONS.jobs).findOne({ jobKey: "rating-worker-incremental" });
    const workerVersion = toStr(workerJob?.version);
    const stateQuery = all ? {} : {
      $or: [
        { phoneNorm },
        { "identityAliases.phoneNorms": phoneNorm },
      ],
    };
    const states = await db.collection(COLLECTIONS.state).find(stateQuery).toArray();
    if (!all && states.length !== 1) throw new Error(`Expected one state for phone; got ${states.length}`);
    const plan = await buildPlan(db, states);
    const token = buildConfirmationToken(plan);
    const blockedLedgerReplay = plan.filter((row) => !row.ledgerReplayMatchesStored).length;
    const blockedVivaProjection = plan.filter((row) => !row.vivaProjectionReady).length;
    report = {
      ok: true,
      mode: apply ? "APPLY" : "DRY_RUN",
      scope: all ? "ALL" : "PHONE",
      phoneNorm: all ? null : phoneNorm,
      createdAt: new Date().toISOString(),
      repairVersion: REPAIR_VERSION,
      requiredWorkerVersion: REQUIRED_WORKER_VERSION,
      activeWorkerVersion: workerVersion,
      scannedStates: states.length,
      plannedPlayers: plan.length,
      totalDelta: roundDelta(plan.reduce((sum, row) => sum + row.delta, 0)),
      maxAbsDelta: plan.length ? Math.max(...plan.map((row) => Math.abs(row.delta))) : 0,
      deltaOverOne: plan.filter((row) => Math.abs(row.delta) > 1).length,
      gradeChanges: plan.filter((row) => row.currentGrade !== row.desiredGrade).length,
      blockedLedgerReplay,
      blockedVivaProjection,
      minDesiredRating: plan.length ? Math.min(...plan.map((row) => row.desiredRating)) : null,
      maxDesiredRating: plan.length ? Math.max(...plan.map((row) => row.desiredRating)) : null,
      confirmationToken: token,
      plan: plan.slice(0, all ? 25 : 1).map((row) => publicPlanRow(row, !all)),
      planTruncated: all && plan.length > 25,
    };
    if (apply) {
      if (workerVersion !== REQUIRED_WORKER_VERSION) {
        throw new Error(`Active worker mismatch: expected ${REQUIRED_WORKER_VERSION}, got ${workerVersion}`);
      }
      if (confirmToken !== token) throw new Error(`Confirmation token mismatch; expected ${token}`);
      if (blockedLedgerReplay > 0 || blockedVivaProjection > 0) {
        throw new Error(`Plan has blockers: ledgerReplay=${blockedLedgerReplay}, vivaProjection=${blockedVivaProjection}`);
      }
      report.applied = [];
      for (const row of plan) {
        try {
          report.applied.push(await applyPlanRow(client, db, row));
        } catch (error) {
          report.ok = false;
          report.failure = {
            playerKey: row.playerKey,
            message: error?.message || String(error),
          };
          break;
        }
      }
      report.appliedPlayers = report.applied.length;
      report.finishedAt = new Date().toISOString();
    }
  } finally {
    await client.close();
  }
  const output = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(output);
  if (outPath) {
    const target = path.resolve(outPath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, output, { mode: 0o600 });
  }
  if (report?.ok === false) process.exitCode = 2;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
