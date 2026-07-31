#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  PLAYER_RATING_COLLECTIONS,
  PLAYER_RATING_LEDGER_SCHEMA_VERSION,
  buildGameResultBaselineEvent,
  ratingGradeFromNumeric,
  replayPlayerRatingEvents,
} from "../src/services/player-rating/ledger.ts";
import {
  GameResultRatingError,
  buildGameResultIdentity,
  buildGameResultRatingPlan,
  buildGameResultRevertPlan,
} from "./lib/gameResultRating.mjs";

export const GAME_RESULT_RATING_WORKER_VERSION = "game-result-rating-worker-v1.0.0";
export const GAME_RESULT_COLLECTIONS = {
  results: "lk_game_results",
  lifecycleEvents: "lk_game_rating_events",
  games: "lk_games",
};
export const GAME_RESULT_RATING_INDEXES = Object.freeze([
  {
    collection: GAME_RESULT_COLLECTIONS.results,
    key: {
      resultModelVersion: 1,
      "ratingWork.executionMode": 1,
      "ratingWork.status": 1,
      "ratingWork.nextAttemptAtTs": 1,
      "ratingWork.leaseUntilTs": 1,
      "ratingWork.queuedAtTs": 1,
    },
    options: { name: "game_result_rating_work_due" },
  },
  {
    collection: PLAYER_RATING_COLLECTIONS.events,
    key: { "source.domain": 1, "source.resultId": 1, occurredAt: 1 },
    options: { name: "rating_event_game_result_partition" },
  },
]);
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_ATTEMPTS = 8;

const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);

function identityQuery(identity) {
  const clauses = [
    ...(identity.playerKey ? [{ playerKey: identity.playerKey }, { "identityAliases.playerKeys": identity.playerKey }] : []),
    ...(identity.clientId ? [{ clientId: identity.clientId }, { "identityAliases.clientIds": identity.clientId }] : []),
    ...(identity.phoneNorm ? [{ phoneNorm: identity.phoneNorm }, { "identityAliases.phoneNorms": identity.phoneNorm }] : []),
  ];
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function eventIdentityQuery(identity) {
  const clauses = [
    ...(identity.playerKey ? [{ "player.key": identity.playerKey }] : []),
    ...(identity.clientId ? [{ "player.clientId": identity.clientId }] : []),
    ...(identity.phoneNorm ? [{ "player.phoneNorm": identity.phoneNorm }] : []),
  ];
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

export function collectResultPlayers(result) {
  const pairings = asArray(result?.ratingFacts?.effectiveSetPairings);
  const identities = new Map();
  pairings.forEach((pairing) => {
    [...asArray(pairing?.teamA), ...asArray(pairing?.teamB)].forEach((member) => {
      const identity = buildGameResultIdentity(member);
      if (identity) identities.set(identity.playerKey, identity);
    });
  });
  return Array.from(identities.values());
}

export function buildGameResultJobClaimQuery(nowTs = Date.now()) {
  return {
    resultModelVersion: 2,
    ratingEnabled: { $ne: false },
    "ratingWork.executionMode": "ACTIVE",
    "ratingWork.desiredState": { $in: ["APPLIED", "REVERTED"] },
    "ratingWork.status": { $in: ["QUEUED", "RETRYABLE", "RUNNING", "PREPARED"] },
    $and: [
      {
        $or: [
          { "ratingWork.nextAttemptAtTs": { $exists: false } },
          { "ratingWork.nextAttemptAtTs": null },
          { "ratingWork.nextAttemptAtTs": { $lte: nowTs } },
        ],
      },
      {
        $or: [
          { "ratingWork.leaseUntilTs": { $exists: false } },
          { "ratingWork.leaseUntilTs": null },
          { "ratingWork.leaseUntilTs": { $lte: nowTs } },
        ],
      },
    ],
  };
}

export async function claimNextGameResultJob(db, { owner, nowIso, leaseMs = DEFAULT_LEASE_MS }) {
  const nowTs = Date.parse(nowIso);
  const leaseUntilTs = nowTs + leaseMs;
  return db.collection(GAME_RESULT_COLLECTIONS.results).findOneAndUpdate(
    buildGameResultJobClaimQuery(nowTs),
    {
      $set: {
        "ratingWork.status": "RUNNING",
        "ratingWork.leaseOwner": owner,
        "ratingWork.leaseUntil": new Date(leaseUntilTs).toISOString(),
        "ratingWork.leaseUntilTs": leaseUntilTs,
        "ratingWork.lastStartedAt": nowIso,
        "ratingWork.lastError": null,
        updatedAt: nowIso,
      },
      $inc: { "ratingWork.attempts": 1 },
    },
    { sort: { "ratingWork.queuedAtTs": 1, submittedAtTs: 1 }, returnDocument: "after" },
  );
}

export async function ensureGameResultRatingIndexes(db) {
  for (const index of GAME_RESULT_RATING_INDEXES) {
    await db.collection(index.collection).createIndex(index.key, index.options);
  }
}

async function loadRatingRows(db, identities) {
  if (identities.length === 0) return [];
  return db.collection(PLAYER_RATING_COLLECTIONS.state).find({
    $or: identities.flatMap((identity) => asArray(identityQuery(identity).$or || [identityQuery(identity)])),
  }).toArray();
}

async function loadResultEventPartition(db, resultId) {
  const normalizedResultId = toStr(resultId);
  if (!normalizedResultId) return { applyEvents: [], compensationEvents: [] };
  const events = await db.collection(PLAYER_RATING_COLLECTIONS.events).find({
    "source.domain": "GAME_RESULT",
    "source.resultId": normalizedResultId,
  }).toArray();
  const compensationEvents = events.filter((event) => (
    Boolean(event?.source?.compensatesEventId)
    || String(event?.source?.mode || "").toLowerCase() === "revert"
    || String(event?.eventType || "").includes("REVERTED")
  ));
  const applyEvents = events.filter((event) => (
    !compensationEvents.includes(event)
    && [
      "GAME_RESULT_SUBMITTED_APPLIED",
      "GAME_RESULT_CORRECTION_APPLIED",
      "GAME_RESULT_CONFIRMED",
      "GAME_RESULT_TIMEOUT_CONFIRMED",
    ].includes(String(event?.eventType || ""))
  ));
  return { applyEvents, compensationEvents };
}

async function loadPreviousResultEvents(db, result) {
  return loadResultEventPartition(db, result?.supersedesResultId);
}

async function loadPredecessorResult(db, result) {
  const predecessorId = toStr(result?.supersedesResultId);
  if (!predecessorId) return null;
  return db.collection(GAME_RESULT_COLLECTIONS.results).findOne({ id: predecessorId });
}

async function loadIdentityEvents(db, identity) {
  return db.collection(PLAYER_RATING_COLLECTIONS.events)
    .find(eventIdentityQuery(identity))
    .toArray();
}

function buildProjectionOutboxDocument({ state, event, nowIso }) {
  if (!state.clientId || !event) return null;
  const outboxId = `rating_projection:${event.id}`;
  return {
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
      levelLetter: state.rating,
      levelNumeric: state.ratingNumeric.toFixed(5),
      source: "game_result_rating_worker",
      gameId: event.source?.gameId || event.source?.sourceId || null,
      previousRating: event.change?.before ?? null,
      nextRating: state.ratingNumeric,
      confirmedAt: event.occurredAt,
      changedById: event.actor?.id || "system:game-result-rating-worker",
      changedByName: event.actor?.name || "Game result rating worker",
      changedByPhone: event.actor?.phoneNorm || null,
      eventId: event.id,
    },
    status: "PENDING",
    attempts: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    nextAttemptAt: nowIso,
  };
}

async function ensureIdentityBaseline(db, { identity, ratingRow, result, plan, nowIso }) {
  const events = await loadIdentityEvents(db, identity);
  if (replayPlayerRatingEvents(events)) return events;
  if (events.length > 0) {
    throw new GameResultRatingError(
      "RATING_LEDGER_BASELINE_MISSING",
      `Existing rating ledger events have no replay baseline for ${identity.playerKey}`,
      { playerKey: identity.playerKey, eventCount: events.length },
    );
  }
  const ratingNumeric = ratingRow?.ratingNumeric ?? ratingRow?.rating;
  const firstOccurredAt = [...asArray(plan.compensationEvents), ...asArray(plan.applyEvents)]
    .map((event) => Date.parse(event.occurredAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)[0] || Date.parse(nowIso);
  const baseline = buildGameResultBaselineEvent({
    resultId: result.id,
    occurredAt: new Date(firstOccurredAt - 1).toISOString(),
    player: { ...identity, id: identity.clientId },
    ratingNumeric,
    createdAt: nowIso,
  });
  if (!baseline) {
    throw new GameResultRatingError(
      "RATING_BASELINE_MISSING",
      `Cannot establish canonical rating baseline for ${identity.playerKey}`,
      identity,
      true,
    );
  }
  await db.collection(PLAYER_RATING_COLLECTIONS.events).updateOne(
    { _id: baseline.id },
    { $setOnInsert: baseline },
    { upsert: true },
  );
  return [...events, baseline];
}

async function projectIdentity(db, { identity, current, result, nowIso }) {
  const events = await loadIdentityEvents(db, identity);
  const replay = replayPlayerRatingEvents(events);
  if (!replay) {
    throw new GameResultRatingError("RATING_REPLAY_FAILED", `No replay baseline for ${identity.playerKey}`, identity, true);
  }
  const lastEvent = events.find((event) => event.id === replay.lastEventId) || null;
  const state = {
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    ownership: "CUP_CANONICAL",
    playerKey: identity.clientId ? `client:${identity.clientId}` : identity.playerKey,
    clientId: identity.clientId || current?.clientId || null,
    phoneNorm: identity.phoneNorm || current?.phoneNorm || null,
    name: identity.name || current?.name || "Игрок",
    ratingNumeric: replay.ratingNumeric,
    rating: replay.rating,
    baseline: {
      eventId: replay.baselineEventId,
      at: replay.baselineAt,
      ratingNumeric: events.find((event) => event.id === replay.baselineEventId)?.change?.after ?? null,
    },
    identityAliases: {
      playerKeys: unique([identity.playerKey, current?.playerKey, ...asArray(current?.identityAliases?.playerKeys)]),
      clientIds: unique([identity.clientId, current?.clientId, ...asArray(current?.identityAliases?.clientIds)]),
      phoneNorms: unique([identity.phoneNorm, current?.phoneNorm, ...asArray(current?.identityAliases?.phoneNorms)]),
    },
    lastEventId: replay.lastEventId,
    lastEventType: replay.lastEventType,
    lastEventAt: replay.lastEventAt,
    lastGameId: result.gameId,
    lastResultId: result.id,
    lastResultRevision: result.scoreRevision || 1,
    projectedBy: GAME_RESULT_RATING_WORKER_VERSION,
    projectedAt: nowIso,
    updatedAt: nowIso,
  };
  const filter = current?._id ? { _id: current._id } : { playerKey: state.playerKey };
  await db.collection(PLAYER_RATING_COLLECTIONS.state).updateOne(
    filter,
    { $set: state, $setOnInsert: { createdAt: nowIso } },
    { upsert: true },
  );
  await db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState).updateOne(
    identityQuery(identity),
    {
      $set: {
        ...state,
        compatibilityProjection: true,
        canonicalCollection: PLAYER_RATING_COLLECTIONS.state,
        compatibilityUpdatedAt: nowIso,
      },
      $setOnInsert: { createdAt: nowIso },
    },
    { upsert: true },
  );
  const outbox = buildProjectionOutboxDocument({ state, event: lastEvent, nowIso });
  if (outbox) {
    await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).updateOne(
      { _id: outbox.id },
      { $setOnInsert: outbox },
      { upsert: true },
    );
  }
  return { state, lastEvent };
}

function playerMatchesImpact(player, impact) {
  if (!player || !impact) return false;
  const playerId = toStr(player.id || player.clientId || player.uuid);
  const impactId = toStr(impact.id || impact.clientId);
  if (playerId && impactId && playerId === impactId) return true;
  const playerPhone = String(player.phoneNorm || player.phone || "").replace(/\D/g, "");
  const impactPhone = String(impact.phoneNorm || impact.phone || "").replace(/\D/g, "");
  return Boolean(playerPhone && impactPhone && playerPhone === impactPhone);
}

export function applyRatingImpactToGameRoster(players, ratingImpact) {
  return asArray(players).map((player) => {
    const impact = asArray(ratingImpact).find((item) => playerMatchesImpact(player, item));
    if (!impact) return player;
    return {
      ...player,
      ratingNumeric: impact.after,
      rating: impact.gradeAfter || ratingGradeFromNumeric(impact.after),
    };
  });
}

async function persistPreparedPlan(db, { result, owner, plan, nowIso }) {
  const preparedSet = {
    "ratingWork.status": "PREPARED",
    "ratingWork.preparedPlan": plan,
    "ratingWork.preparedAt": nowIso,
    updatedAt: nowIso,
  };
  if (String(plan?.desiredState || "APPLIED").toUpperCase() !== "REVERTED") {
    preparedSet.ratingFormula = plan.formula;
    preparedSet.ratingImpact = plan.ratingImpact;
    preparedSet.intermediateResults = plan.intermediateResults;
    preparedSet["resultPayload.intermediateResults"] = plan.intermediateResults;
  }
  const response = await db.collection(GAME_RESULT_COLLECTIONS.results).updateOne(
    {
      _id: result._id,
      "ratingWork.generation": result.ratingWork.generation,
      "ratingWork.leaseOwner": owner,
      "ratingWork.status": "RUNNING",
    },
    {
      $set: preparedSet,
    },
  );
  if (Number(response?.matchedCount || 0) !== 1) {
    throw new GameResultRatingError("JOB_LEASE_LOST", "Rating job lease was lost before plan persistence", null, true);
  }
}

async function assertJobLease(db, { result, owner, desiredState }) {
  const current = await db.collection(GAME_RESULT_COLLECTIONS.results).findOne(
    {
      _id: result._id,
      "ratingWork.generation": result.ratingWork.generation,
      "ratingWork.leaseOwner": owner,
      "ratingWork.desiredState": desiredState,
      "ratingWork.status": { $in: ["RUNNING", "PREPARED"] },
    },
    { projection: { _id: 1 } },
  );
  if (!current) {
    throw new GameResultRatingError("JOB_LEASE_LOST", "Rating job lease was lost before event persistence", null, true);
  }
}

export function shouldRetryGameResultJobFailure(
  error,
  attempts,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
) {
  if (Number(attempts || 0) >= Number(maxAttempts || DEFAULT_MAX_ATTEMPTS)) return false;
  if (error instanceof GameResultRatingError) return error.retryable === true;
  return true;
}

async function markJobFailure(db, { result, owner, error, nowIso, maxAttempts }) {
  const attempts = Number(result?.ratingWork?.attempts || 1);
  const retryable = shouldRetryGameResultJobFailure(error, attempts, maxAttempts);
  const nextAttemptAtTs = retryable
    ? Date.parse(nowIso) + Math.min(15 * 60 * 1000, 15_000 * (2 ** Math.max(0, attempts - 1)))
    : null;
  await db.collection(GAME_RESULT_COLLECTIONS.results).updateOne(
    { _id: result._id, "ratingWork.leaseOwner": owner },
    {
      $set: {
        "ratingWork.status": retryable ? "RETRYABLE" : "BLOCKED",
        "ratingWork.nextAttemptAt": nextAttemptAtTs ? new Date(nextAttemptAtTs).toISOString() : null,
        "ratingWork.nextAttemptAtTs": nextAttemptAtTs,
        "ratingWork.leaseOwner": null,
        "ratingWork.leaseUntil": null,
        "ratingWork.leaseUntilTs": null,
        "ratingWork.lastError": String(error?.message || error).slice(0, 500),
        "ratingWork.lastErrorCode": toStr(error?.code) || "UNEXPECTED_WORKER_ERROR",
        "ratingWork.lastFailedAt": nowIso,
        updatedAt: nowIso,
      },
    },
  );
  return { status: retryable ? "RETRYABLE" : "BLOCKED", nextAttemptAtTs };
}

export async function processClaimedGameResultJob(db, { result, owner, nowIso, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  try {
    const identities = collectResultPlayers(result);
    if (identities.length !== 4) {
      throw new GameResultRatingError(
        "INVALID_RATING_PARTICIPANTS",
        "Result rating facts must resolve exactly four players",
        { count: identities.length },
      );
    }
    const ratingRows = await loadRatingRows(db, identities);
    const desiredState = String(result?.ratingWork?.desiredState || "APPLIED").toUpperCase();
    const predecessor = desiredState === "APPLIED" ? await loadPredecessorResult(db, result) : null;
    if (
      predecessor
      && String(predecessor?.ratingWork?.desiredState || "").toUpperCase() === "REVERTED"
      && String(predecessor?.ratingWork?.status || "").toUpperCase() !== "REVERTED"
    ) {
      throw new GameResultRatingError(
        "PREDECESSOR_REVERT_PENDING",
        "Corrected result is waiting for predecessor rating compensation",
        { supersedesResultId: result.supersedesResultId },
        true,
      );
    }
    const previous = desiredState === "APPLIED"
      ? await loadPreviousResultEvents(db, result)
      : await loadResultEventPartition(db, result.id);
    let plan = result?.ratingWork?.preparedPlan || null;
    if (
      plan
      && (
        (desiredState === "REVERTED" && String(plan?.desiredState || "").toUpperCase() !== "REVERTED")
        || (desiredState === "APPLIED" && String(plan?.desiredState || "APPLIED").toUpperCase() === "REVERTED")
      )
    ) {
      throw new GameResultRatingError(
        "PREPARED_PLAN_STATE_MISMATCH",
        "Prepared rating plan does not match the requested result state",
      );
    }
    if (!plan) {
      plan = desiredState === "REVERTED"
        ? buildGameResultRevertPlan({
            result,
            ratingRows,
            appliedEvents: previous.applyEvents,
            existingCompensationEvents: previous.compensationEvents,
            nowIso,
          })
        : buildGameResultRatingPlan({
            result,
            ratingRows,
            previousEvents: previous.applyEvents,
            previousCompensationEvents: previous.compensationEvents,
            predecessorReverted: String(predecessor?.ratingWork?.status || "").toUpperCase() === "REVERTED",
            nowIso,
          });
      await persistPreparedPlan(db, { result, owner, plan, nowIso });
    }

    await assertJobLease(db, { result, owner, desiredState });

    const rowByKey = new Map(ratingRows.map((row) => [buildGameResultIdentity(row)?.playerKey, row]));
    if (asArray(plan.eventIds).length > 0) {
      for (const identity of identities) {
        await ensureIdentityBaseline(db, {
          identity,
          ratingRow: rowByKey.get(identity.playerKey),
          result,
          plan,
          nowIso,
        });
      }
    }
    const eventOperations = [...asArray(plan.compensationEvents), ...asArray(plan.applyEvents)].map((event) => ({
      updateOne: {
        filter: { _id: event.id },
        update: { $setOnInsert: event },
        upsert: true,
      },
    }));
    if (eventOperations.length > 0) {
      await db.collection(PLAYER_RATING_COLLECTIONS.events).bulkWrite(eventOperations, { ordered: true });
    }

    const projections = [];
    if (asArray(plan.eventIds).length > 0) {
      for (const identity of identities) {
        projections.push(await projectIdentity(db, {
          identity,
          current: rowByKey.get(identity.playerKey) || null,
          result,
          nowIso,
        }));
      }
    }

    const completedWorkStatus = desiredState === "REVERTED" ? "REVERTED" : "APPLIED";
    const completedRatingEventStatus = desiredState === "REVERTED"
      ? "REVERTED"
      : ["CONFIRMED", "AUTO_CONFIRMED"].includes(String(result.status || result.lifecycleState || "").toUpperCase())
        ? "FINAL"
        : "PROVISIONAL_APPLIED";
    const lifecycleSet = {
      status: completedRatingEventStatus,
      updatedAt: nowIso,
    };
    if (desiredState === "REVERTED") {
      lifecycleSet.revertedAt = nowIso;
      lifecycleSet.revertedAtTs = Date.parse(nowIso);
    } else {
      lifecycleSet.formula = plan.formula;
      lifecycleSet.ratingImpact = plan.ratingImpact;
      lifecycleSet.appliedAt = nowIso;
      lifecycleSet.appliedAtTs = Date.parse(nowIso);
    }
    await db.collection(GAME_RESULT_COLLECTIONS.lifecycleEvents).updateOne(
      { _id: result?.ratingEvent?.id || `rate_${result.id}` },
      { $set: lifecycleSet },
      { upsert: true },
    );
    const game = await db.collection(GAME_RESULT_COLLECTIONS.games).findOne({ id: result.gameId });
    if (game) {
      await db.collection(GAME_RESULT_COLLECTIONS.games).updateOne(
        { _id: game._id },
        {
          $set: {
            participants: applyRatingImpactToGameRoster(game.participants, plan.ratingImpact),
            waitlist: applyRatingImpactToGameRoster(game.waitlist, plan.ratingImpact),
            organizer: game.organizer
              ? (applyRatingImpactToGameRoster([game.organizer], plan.ratingImpact)[0] || game.organizer)
              : game.organizer,
            resultId: result.id,
            resultRatingStatus: completedWorkStatus,
            updatedAt: nowIso,
          },
        },
      );
    }
    if (result.supersedesResultId) {
      await db.collection(GAME_RESULT_COLLECTIONS.results).updateOne(
        { id: result.supersedesResultId },
        {
          $set: {
            effectiveState: "SUPERSEDED",
            supersededByResultId: result.id,
            supersededAt: nowIso,
            updatedAt: nowIso,
          },
        },
      );
    }
    const appliedEventIds = asArray(plan.applyEvents).map((event) => event.id);
    const completedAtFields = desiredState === "REVERTED"
      ? {
          "ratingWork.revertedGeneration": result.ratingWork.generation,
          "ratingWork.revertedEventIds": asArray(plan.eventIds),
          "ratingWork.revertedAt": nowIso,
          "ratingWork.revertedAtTs": Date.parse(nowIso),
          "ratingEvent.revertedAt": nowIso,
          "ratingEvent.revertedAtTs": Date.parse(nowIso),
        }
      : {
          "ratingWork.appliedGeneration": result.ratingWork.generation,
          "ratingWork.appliedEventIds": appliedEventIds,
          "ratingWork.appliedAt": nowIso,
          "ratingWork.appliedAtTs": Date.parse(nowIso),
          "ratingEvent.formula": plan.formula,
          "ratingEvent.ratingImpact": plan.ratingImpact,
          "ratingEvent.appliedAt": nowIso,
          "ratingEvent.appliedAtTs": Date.parse(nowIso),
          ratingFormula: plan.formula,
          ratingImpact: plan.ratingImpact,
          intermediateResults: plan.intermediateResults,
          "resultPayload.intermediateResults": plan.intermediateResults,
        };
    const resultUpdate = await db.collection(GAME_RESULT_COLLECTIONS.results).updateOne(
      {
        _id: result._id,
        "ratingWork.generation": result.ratingWork.generation,
        "ratingWork.leaseOwner": owner,
        "ratingWork.status": { $in: ["RUNNING", "PREPARED"] },
      },
      {
        $set: {
          "ratingWork.status": completedWorkStatus,
          "ratingWork.completedEventIds": asArray(plan.eventIds),
          "ratingWork.leaseOwner": null,
          "ratingWork.leaseUntil": null,
          "ratingWork.leaseUntilTs": null,
          "ratingWork.nextAttemptAt": null,
          "ratingWork.nextAttemptAtTs": null,
          "ratingWork.lastError": null,
          "ratingEvent.status": completedRatingEventStatus,
          ...completedAtFields,
          updatedAt: nowIso,
        },
      },
    );
    if (Number(resultUpdate?.matchedCount || 0) !== 1) {
      throw new GameResultRatingError("JOB_LEASE_LOST", "Rating job lease was lost before completion", null, true);
    }
    return {
      ok: true,
      resultId: result.id,
      scoreRevision: result.scoreRevision || 1,
      status: completedWorkStatus,
      eventIds: plan.eventIds,
      players: projections.length,
    };
  } catch (error) {
    const failure = await markJobFailure(db, { result, owner, error, nowIso, maxAttempts });
    return {
      ok: false,
      resultId: result.id,
      scoreRevision: result.scoreRevision || 1,
      error: String(error?.message || error),
      code: toStr(error?.code) || "UNEXPECTED_WORKER_ERROR",
      ...failure,
    };
  }
}

async function previewGameResultJob(db, result, nowIso) {
  try {
    const identities = collectResultPlayers(result);
    const ratingRows = await loadRatingRows(db, identities);
    const desiredState = String(result?.ratingWork?.desiredState || "APPLIED").toUpperCase();
    const predecessor = desiredState === "APPLIED" ? await loadPredecessorResult(db, result) : null;
    if (
      predecessor
      && String(predecessor?.ratingWork?.desiredState || "").toUpperCase() === "REVERTED"
      && String(predecessor?.ratingWork?.status || "").toUpperCase() !== "REVERTED"
    ) {
      throw new GameResultRatingError(
        "PREDECESSOR_REVERT_PENDING",
        "Corrected result is waiting for predecessor rating compensation",
        { supersedesResultId: result.supersedesResultId },
        true,
      );
    }
    const previous = desiredState === "APPLIED"
      ? await loadPreviousResultEvents(db, result)
      : await loadResultEventPartition(db, result.id);
    const plan = result?.ratingWork?.preparedPlan
      || (desiredState === "REVERTED"
        ? buildGameResultRevertPlan({
            result,
            ratingRows,
            appliedEvents: previous.applyEvents,
            existingCompensationEvents: previous.compensationEvents,
            nowIso,
          })
        : buildGameResultRatingPlan({
            result,
            ratingRows,
            previousEvents: previous.applyEvents,
            previousCompensationEvents: previous.compensationEvents,
            predecessorReverted: String(predecessor?.ratingWork?.status || "").toUpperCase() === "REVERTED",
            nowIso,
          }));
    return {
      ok: true,
      dryRun: true,
      resultId: result.id,
      scoreRevision: result.scoreRevision || 1,
      status: result?.ratingWork?.status,
      eventIds: plan.eventIds,
    };
  } catch (error) {
    return {
      ok: false,
      dryRun: true,
      resultId: result.id,
      code: toStr(error?.code) || "UNEXPECTED_WORKER_ERROR",
      error: String(error?.message || error),
    };
  }
}

export async function runGameResultRatingWorker(db, {
  dryRun = true,
  limit = DEFAULT_LIMIT,
  owner = `game-result-worker:${crypto.randomUUID()}`,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now = () => new Date(),
} = {}) {
  const startedAt = now().toISOString();
  const results = [];
  if (dryRun) {
    const candidates = await db.collection(GAME_RESULT_COLLECTIONS.results)
      .find(buildGameResultJobClaimQuery(Date.parse(startedAt)))
      .sort({ "ratingWork.queuedAtTs": 1, submittedAtTs: 1 })
      .limit(limit)
      .toArray();
    for (const result of candidates) results.push(await previewGameResultJob(db, result, startedAt));
  } else {
    await ensureGameResultRatingIndexes(db);
    for (let index = 0; index < limit; index += 1) {
      const claimed = await claimNextGameResultJob(db, {
        owner,
        nowIso: now().toISOString(),
        leaseMs,
      });
      if (!claimed) break;
      results.push(await processClaimedGameResultJob(db, {
        result: claimed,
        owner,
        nowIso: now().toISOString(),
        maxAttempts,
      }));
    }
  }
  const finishedAt = now().toISOString();
  return {
    ok: results.every((item) => item.ok),
    dryRun,
    version: GAME_RESULT_RATING_WORKER_VERSION,
    owner: dryRun ? null : owner,
    startedAt,
    finishedAt,
    scanned: results.length,
    applied: results.filter((item) => item.status === "APPLIED").length,
    reverted: results.filter((item) => item.status === "REVERTED").length,
    retryable: results.filter((item) => item.status === "RETRYABLE").length,
    blocked: results.filter((item) => item.status === "BLOCKED").length,
    results,
  };
}

async function main() {
  const mongoUri = getArg("--mongo-uri", process.env.MONGODB_URI);
  const dbName = getArg("--db", process.env.MONGODB_DB || "games");
  const outPath = getArg("--out");
  const limit = Math.max(1, Math.floor(Number(getArg("--limit", DEFAULT_LIMIT)) || DEFAULT_LIMIT));
  const dryRun = !hasFlag("--apply");
  if (!mongoUri) throw new Error("MONGODB_URI or --mongo-uri is required");
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  try {
    await client.connect();
    const report = await runGameResultRatingWorker(client.db(dbName), { dryRun, limit });
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (outPath) {
      const target = path.resolve(outPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serialized, { mode: 0o600 });
    }
    process.stdout.write(serialized);
    if (!report.ok && !dryRun) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
