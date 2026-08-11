#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import {
  COMMUNITY_RATING_COLLECTIONS,
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_PERIODS,
  COMMUNITY_RATING_SOURCE_COLLECTIONS,
  COMMUNITY_RATING_TABS,
  COMMUNITY_RATING_VISIT_SCOPE_BY_COMMUNITY_ID,
  ensureCommunityRatingStorageIndexes,
  recalculateCommunityRating,
} from "../src/services/community-rating/index.ts";
import {
  PLAYER_RATING_COLLECTIONS,
  PLAYER_RATING_LEDGER_SCHEMA_VERSION,
  PLAYER_RATING_WORKER_VERSION,
  buildPlayerRatingKey,
  buildTournamentCompensationEvent,
  buildTournamentRatingEvent,
  buildTournamentRatingRevision,
  buildTournamentStartOverrideEvent,
  eventAppliesToCanonicalState,
  normalizeRatingPhone,
  ratingGradeFromNumeric,
  replayPlayerRatingEvents,
  toFiniteRating,
} from "../src/services/player-rating/ledger.ts";
import {
  buildTimeForFriendsAutoEnrollmentMutation,
  planTimeForFriendsAutoEnrollment,
} from "./lib/tournamentCommunityContext.mjs";
import {
  collectPublicationTournamentIds,
} from "./lib/timeForFriendsCommunityBackfill.mjs";

export const RATING_WORKER_JOB_KEY = "rating-worker-incremental";
export const RATING_WORKER_FULL_JOB_KEY = "rating-worker-full-safety";
const DEFAULT_OVERLAP_MS = 5 * 60 * 1000;
const DEFAULT_LEASE_MS = 14 * 60 * 1000;

const getArg = (name, fallback = null) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const hasFlag = (name) => process.argv.includes(name);
const asArray = (value) => Array.isArray(value) ? value : [];
const isRecord = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const toIso = (value, fallback = null) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
};
const unique = (values) => Array.from(new Set(values.filter(Boolean)));

export function isTournamentFinalized(tournament) {
  const params = isRecord(tournament?.params) ? tournament.params : {};
  const summary = isRecord(tournament?.summary) ? tournament.summary : {};
  const statuses = [
    tournament?.status,
    tournament?.state,
    params.status,
    params.state,
    summary.status,
    summary.state,
  ].map((value) => String(value || "").trim().toLowerCase());
  if (statuses.some((status) => ["completed", "finished", "closed", "done", "завершен", "завершён"].includes(status))) {
    return true;
  }
  return [params.finished, params.manualFinish, summary.finished, summary.manualFinish]
    .some((value) => value === true || value === 1 || String(value).toLowerCase() === "true");
}

function resolveTournamentFinishedAt(tournament) {
  const params = isRecord(tournament?.params) ? tournament.params : {};
  const summary = isRecord(tournament?.summary) ? tournament.summary : {};
  return toIso(
    params.finishedAt
      || params.completedAt
      || summary.finishedAt
      || summary.completedAt
      || tournament.updatedAt,
  );
}

function resolveTournamentId(tournament) {
  return toStr(tournament?.tournamentId || tournament?.id || tournament?.exerciseId || tournament?.sourceTournamentId);
}

function buildBootstrapEvent({ event, createdAt }) {
  const baselineRating = toFiniteRating(event?.change?.before);
  if (baselineRating == null) return null;
  const occurredAtTs = Date.parse(event.occurredAt);
  const occurredAt = new Date((Number.isFinite(occurredAtTs) ? occurredAtTs : Date.now()) - 1).toISOString();
  const eventId = `rating_evt:tournament_bootstrap:${event.source.sourceId}:${event.player.key}`;
  return {
    _id: eventId,
    id: eventId,
    idempotencyKey: eventId,
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    eventType: "RATING_BOOTSTRAPPED_FROM_TOURNAMENT",
    occurredAt,
    createdAt,
    player: event.player,
    actor: {
      type: "SYSTEM",
      id: "system:rating-worker",
      name: "Rating worker",
    },
    source: {
      domain: "TOURNAMENT_BOOTSTRAP",
      sourceId: event.source.sourceId,
      tournamentId: event.source.sourceId,
    },
    change: {
      before: null,
      delta: null,
      after: baselineRating,
      gradeBefore: null,
      gradeAfter: ratingGradeFromNumeric(baselineRating),
    },
    formula: null,
    projectionIntent: { viva: "NONE_BOOTSTRAP" },
  };
}

function eventMatchesIdentity(event, identity) {
  return Boolean(
    (identity.clientId && event?.player?.clientId === identity.clientId)
    || (identity.phoneNorm && normalizeRatingPhone(event?.player?.phoneNorm) === identity.phoneNorm)
    || event?.player?.key === identity.playerKey,
  );
}

function eventIsCompensated(event, events) {
  return events.some((candidate) => candidate?.source?.compensatesEventId === event.id);
}

function latestActiveTournamentEvent(events, tournamentId, identity) {
  return events
    .filter((event) => (
      event?.source?.domain === "TOURNAMENT"
      && event?.source?.sourceId === tournamentId
      && !event?.source?.compensatesEventId
      && eventAppliesToCanonicalState(event)
      && eventMatchesIdentity(event, identity)
      && !eventIsCompensated(event, events)
    ))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
}

async function buildIdentityPhoneMap(db) {
  const [states, visits, communities] = await Promise.all([
    db.collection(PLAYER_RATING_COLLECTIONS.state).find({}, {
      projection: { clientId: 1, phoneNorm: 1, identityAliases: 1 },
    }).toArray(),
    db.collection("lk_training_visits").find({ archived: { $ne: true } }, {
      projection: { clientId: 1, phoneNorm: 1, client: 1 },
    }).toArray(),
    db.collection("lk_communities").find({ archived: { $ne: true } }, {
      projection: { members: 1 },
    }).toArray(),
  ]);
  const phones = new Map();
  const conflicts = new Set();
  const add = (clientIdValue, phoneValue) => {
    const clientId = toStr(clientIdValue);
    const phoneNorm = normalizeRatingPhone(phoneValue);
    if (!clientId || !phoneNorm) return;
    const current = phones.get(clientId);
    if (current && current !== phoneNorm) conflicts.add(clientId);
    else phones.set(clientId, phoneNorm);
  };
  states.forEach((state) => add(state.clientId, state.phoneNorm));
  visits.forEach((visit) => {
    add(visit.clientId, visit.phoneNorm);
    add(visit?.client?.id || visit?.client?.clientId, visit?.client?.phoneNorm || visit?.client?.phone);
  });
  communities.forEach((community) => asArray(community.members).forEach((member) => {
    add(member?.clientId || member?.id || member?.userId || member?.playerId, member?.phoneNorm || member?.phone);
  }));
  conflicts.forEach((clientId) => phones.delete(clientId));
  return phones;
}

async function ensureWorkerIndexes(db) {
  await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .createIndex({ idempotencyKey: 1 }, { name: "rating_event_idempotency_uq", unique: true });
  await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .createIndex({ "player.key": 1, occurredAt: 1 }, { name: "rating_event_player_replay" });
  await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .createIndex({ "source.domain": 1, "source.sourceId": 1, "player.key": 1 }, { name: "rating_event_source_player" });
  await db.collection(PLAYER_RATING_COLLECTIONS.state)
    .createIndex({ updatedAt: -1 }, { name: "player_rating_state_updated" });
  await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox)
    .createIndex({ status: 1, nextAttemptAt: 1 }, { name: "rating_projection_pending" });
  await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry)
    .createIndex({ jobKey: 1 }, { name: "rating_job_registry_key_uq", unique: true });
  await db.collection(PLAYER_RATING_COLLECTIONS.jobRuns)
    .createIndex({ runId: 1 }, { name: "rating_job_runs_id_uq", unique: true });
}

async function loadStateForIdentity(db, identity) {
  const clauses = [
    { playerKey: identity.playerKey },
    ...(identity.clientId ? [{ clientId: identity.clientId }, { "identityAliases.clientIds": identity.clientId }] : []),
    ...(identity.phoneNorm ? [{ phoneNorm: identity.phoneNorm }, { "identityAliases.phoneNorms": identity.phoneNorm }] : []),
  ];
  return db.collection(PLAYER_RATING_COLLECTIONS.state).findOne({ $or: clauses });
}

async function loadEventsForIdentity(db, identity) {
  const clauses = [
    { "player.key": identity.playerKey },
    ...(identity.clientId ? [{ "player.clientId": identity.clientId }] : []),
    ...(identity.phoneNorm ? [{ "player.phoneNorm": identity.phoneNorm }] : []),
  ];
  return db.collection(PLAYER_RATING_COLLECTIONS.events).find({ $or: clauses }).toArray();
}

async function resolveCanonicalRatingBefore(db, identity, occurredAt, pendingEvents = []) {
  const occurredAtTs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredAtTs)) return null;
  const persistedEvents = await loadEventsForIdentity(db, identity);
  const replay = replayPlayerRatingEvents([
    ...persistedEvents,
    ...pendingEvents.filter((event) => eventMatchesIdentity(event, identity)),
  ].filter((event) => {
    const eventAtTs = Date.parse(event?.occurredAt || event?.createdAt || "");
    return Number.isFinite(eventAtTs) && eventAtTs < occurredAtTs;
  }));
  return replay?.ratingNumeric ?? null;
}

export function resolveTournamentRevisionCanonicalBefore(
  activeEvent,
  resolvedCanonicalBefore,
  tournamentEvents = [],
) {
  let rootEvent = activeEvent || null;
  const visited = new Set();
  while (rootEvent?.source?.supersedesEventId) {
    const currentId = toStr(rootEvent.id || rootEvent._id);
    if (currentId) visited.add(currentId);
    const predecessorId = toStr(rootEvent.source.supersedesEventId);
    if (!predecessorId || visited.has(predecessorId)) break;
    const predecessor = asArray(tournamentEvents).find((candidate) => (
      toStr(candidate?.id || candidate?._id) === predecessorId
    ));
    if (!predecessor) break;
    rootEvent = predecessor;
  }
  return toFiniteRating(rootEvent?.change?.before) ?? toFiniteRating(resolvedCanonicalBefore);
}

export function selectCompatibilityProjectionTarget(candidates, identity) {
  const uniqueCandidates = new Map();
  asArray(candidates).forEach((candidate) => {
    if (!candidate?._id) return;
    const key = typeof candidate._id?.toHexString === "function"
      ? candidate._id.toHexString()
      : String(candidate._id);
    uniqueCandidates.set(key, candidate);
  });
  if (uniqueCandidates.size > 1) {
    const error = new Error(`Compatibility identity conflict for ${identity.playerKey}`);
    error.code = "PLAYER_RATING_COMPATIBILITY_IDENTITY_CONFLICT";
    throw error;
  }
  const existing = [...uniqueCandidates.values()][0] || null;
  if (existing) return { filter: { _id: existing._id }, existing };
  if (identity.clientId) return { filter: { clientId: identity.clientId }, existing: null };
  if (identity.phoneNorm) return { filter: { phoneNorm: identity.phoneNorm }, existing: null };
  return { filter: { playerKey: identity.playerKey }, existing: null };
}

export function compatibilityProjectionNeedsReconciliation(canonical, compatibility) {
  if (!compatibility) return true;
  return (canonical.playerKey || null) !== (compatibility.playerKey || null)
    || (canonical.clientId || null) !== (compatibility.clientId || null)
    || (canonical.phoneNorm || null) !== (compatibility.phoneNorm || null)
    || Number(canonical.ratingNumeric) !== Number(compatibility.ratingNumeric)
    || (canonical.rating || null) !== (compatibility.rating || null)
    || (canonical.lastEventId || null) !== (compatibility.lastEventId || null);
}

async function resolveCompatibilityProjectionTarget(db, identity) {
  const clauses = [
    ...(identity.clientId ? [{ clientId: identity.clientId }] : []),
    ...(identity.phoneNorm ? [{ phoneNorm: identity.phoneNorm }] : []),
    ...(identity.playerKey ? [{ playerKey: identity.playerKey }] : []),
  ];
  const query = clauses.length === 1 ? clauses[0] : { $or: clauses };
  const candidates = await db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState)
    .find(query)
    .limit(4)
    .toArray();
  return selectCompatibilityProjectionTarget(candidates, identity);
}

async function projectIdentityState(db, identity, nowIso, dryRun) {
  const current = await loadStateForIdentity(db, identity);
  const mergedIdentity = {
    playerKey: identity.clientId ? `client:${identity.clientId}` : (current?.playerKey || identity.playerKey),
    clientId: identity.clientId || current?.clientId || null,
    phoneNorm: identity.phoneNorm || current?.phoneNorm || null,
    name: identity.name || current?.name || "Игрок",
  };
  const events = await loadEventsForIdentity(db, mergedIdentity);
  const replay = replayPlayerRatingEvents(events);
  if (!replay) return { changed: false, reason: "NO_BASELINE", identity: mergedIdentity };

  const next = {
    schemaVersion: PLAYER_RATING_LEDGER_SCHEMA_VERSION,
    ownership: "CUP_CANONICAL",
    playerKey: mergedIdentity.playerKey,
    clientId: mergedIdentity.clientId,
    phoneNorm: mergedIdentity.phoneNorm,
    name: mergedIdentity.name,
    ratingNumeric: replay.ratingNumeric,
    rating: replay.rating,
    baseline: {
      eventId: replay.baselineEventId,
      at: replay.baselineAt,
      ratingNumeric: events.find((event) => event.id === replay.baselineEventId)?.change?.after ?? null,
    },
    identityAliases: {
      clientIds: unique([
        mergedIdentity.clientId,
        ...asArray(current?.identityAliases?.clientIds),
      ]),
      phoneNorms: unique([
        mergedIdentity.phoneNorm,
        ...asArray(current?.identityAliases?.phoneNorms),
      ]),
    },
    lastEventId: replay.lastEventId,
    lastEventType: replay.lastEventType,
    lastEventAt: replay.lastEventAt,
    projectedBy: PLAYER_RATING_WORKER_VERSION,
    projectedAt: nowIso,
    updatedAt: nowIso,
  };
  const changed = !current
    || current.ratingNumeric !== next.ratingNumeric
    || current.lastEventId !== next.lastEventId
    || current.playerKey !== next.playerKey;
  if (!dryRun) {
    const stateFilter = current?._id ? { _id: current._id } : { playerKey: mergedIdentity.playerKey };
    await db.collection(PLAYER_RATING_COLLECTIONS.state).updateOne(
      stateFilter,
      { $set: next, $setOnInsert: { createdAt: nowIso } },
      { upsert: true },
    );
    const { filter: compatibilityFilter } = await resolveCompatibilityProjectionTarget(db, mergedIdentity);
    await db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState).updateOne(
      compatibilityFilter,
      {
        $set: {
          ...next,
          compatibilityProjection: true,
          canonicalCollection: PLAYER_RATING_COLLECTIONS.state,
          compatibilityUpdatedAt: nowIso,
        },
        $setOnInsert: { createdAt: nowIso },
      },
      { upsert: true },
    );
  }
  return { changed, identity: mergedIdentity, state: next, events: events.length };
}

async function reconcileCompatibilityProjection(db, nowIso, dryRun) {
  const states = await db.collection(PLAYER_RATING_COLLECTIONS.state).find({}).toArray();
  let changed = 0;
  for (const state of states) {
    const { filter, existing } = await resolveCompatibilityProjectionTarget(db, state);
    if (!compatibilityProjectionNeedsReconciliation(state, existing)) continue;
    changed += 1;
    if (dryRun) continue;
    await db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState).updateOne(
      filter,
      {
        $set: {
          schemaVersion: state.schemaVersion,
          ownership: state.ownership,
          playerKey: state.playerKey,
          clientId: state.clientId || null,
          phoneNorm: state.phoneNorm || null,
          name: state.name,
          ratingNumeric: state.ratingNumeric,
          rating: state.rating,
          baseline: state.baseline,
          identityAliases: state.identityAliases,
          lastEventId: state.lastEventId,
          lastEventType: state.lastEventType,
          lastEventAt: state.lastEventAt,
          projectedBy: PLAYER_RATING_WORKER_VERSION,
          projectedAt: nowIso,
          updatedAt: nowIso,
          compatibilityProjection: true,
          canonicalCollection: PLAYER_RATING_COLLECTIONS.state,
          compatibilityUpdatedAt: nowIso,
        },
        $setOnInsert: { createdAt: state.createdAt || nowIso },
      },
      { upsert: true },
    );
  }
  return { scanned: states.length, changed };
}

async function enqueueProjection(db, projection, nowIso, dryRun) {
  if (!projection?.state?.clientId) return false;
  const lastEvent = await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .findOne({ _id: projection.state.lastEventId });
  if (!["TOURNAMENT", "TOURNAMENT_START"].includes(lastEvent?.source?.domain)) return false;
  const isStartOverride = lastEvent.source.domain === "TOURNAMENT_START";
  const outboxId = `rating_projection:${lastEvent.id}`;
  if (!dryRun) {
    await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).updateOne(
      { _id: outboxId },
      {
        $setOnInsert: {
          _id: outboxId,
          id: outboxId,
          ratingEventId: lastEvent.id,
          playerKey: projection.state.playerKey,
          clientId: projection.state.clientId,
          phoneNorm: projection.state.phoneNorm,
          payload: {
            clientId: projection.state.clientId,
            phone: projection.state.phoneNorm,
            playerName: projection.state.name,
            levelLetter: projection.state.rating,
            levelNumeric: projection.state.ratingNumeric.toFixed(5),
            source: isStartOverride ? "tournament_start" : "tournament_rating_worker",
            gameId: lastEvent.source.sourceId,
            tournamentId: lastEvent.source.sourceId,
            previousRating: lastEvent.change.before,
            nextRating: projection.state.ratingNumeric,
            confirmedAt: lastEvent.occurredAt,
            changedById: lastEvent.actor?.id || "system:rating-worker",
            changedByName: lastEvent.actor?.name || "Rating worker",
            changedByPhone: lastEvent.actor?.phoneNorm || null,
            eventId: lastEvent.id,
          },
          status: "PENDING",
          attempts: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
          nextAttemptAt: nowIso,
        },
      },
      { upsert: true },
    );
  }
  return true;
}

export async function processTournamentLedger(db, { sinceIso, notBeforeIso, nowIso, dryRun }) {
  const since = new Date(Math.max(Date.parse(sinceIso || notBeforeIso), Date.parse(notBeforeIso))).toISOString();
  const tournaments = await db.collection("tournaments").find({
    $or: [
      { updatedAt: { $gte: since } },
      { "params.finishedAt": { $gte: since } },
      { "summary.finishedAt": { $gte: since } },
    ],
  }).toArray();
  tournaments.sort((left, right) => (
    Date.parse(resolveTournamentFinishedAt(left) || left?.updatedAt || "")
    - Date.parse(resolveTournamentFinishedAt(right) || right?.updatedAt || "")
  ));
  const phoneByClientId = await buildIdentityPhoneMap(db);
  const allTournamentEvents = await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .find({ "source.domain": "TOURNAMENT" }).toArray();
  const existingStartEventIds = new Set((await db.collection(PLAYER_RATING_COLLECTIONS.events)
    .find({ "source.domain": "TOURNAMENT_START" }, { projection: { _id: 1 } }).toArray())
    .map((event) => String(event._id)));
  const newEvents = [];
  const identities = new Map();
  let finalized = 0;
  let reopened = 0;
  let startOverrides = 0;
  let skippedBeforeCutover = 0;

  for (const tournament of tournaments) {
    const tournamentId = resolveTournamentId(tournament);
    const finishedAt = resolveTournamentFinishedAt(tournament);
    const changedAt = toIso(tournament.updatedAt, nowIso);
    if (!tournamentId) continue;
    const final = isTournamentFinalized(tournament) && finishedAt;
    for (const startChange of asArray(tournament.startRatingChanges)) {
      const occurredAt = toIso(startChange?.occurredAt);
      if (!occurredAt || Date.parse(occurredAt) < Date.parse(notBeforeIso)) {
        skippedBeforeCutover += 1;
        continue;
      }
      const player = isRecord(startChange?.player) ? startChange.player : {};
      const clientId = toStr(player.clientId);
      const phoneNorm = clientId
        ? phoneByClientId.get(clientId) || normalizeRatingPhone(player.phone)
        : normalizeRatingPhone(player.phone);
      const playerKey = buildPlayerRatingKey({ clientId, phoneNorm, fallback: player.participantId });
      if (!playerKey) continue;
      const identity = { playerKey, clientId, phoneNorm, name: toStr(player.name) || "Игрок" };
      const canonicalBefore = await resolveCanonicalRatingBefore(db, identity, occurredAt, newEvents);
      const event = buildTournamentStartOverrideEvent({
        tournamentId,
        startChange,
        phoneNorm,
        canonicalBefore,
        createdAt: nowIso,
      });
      if (!event) continue;
      if (existingStartEventIds.has(event.id)) {
        identities.set(playerKey, identity);
        continue;
      }
      const currentState = await loadStateForIdentity(db, identity);
      if (!currentState) {
        const bootstrap = buildBootstrapEvent({ event, createdAt: nowIso });
        if (bootstrap) newEvents.push(bootstrap);
      }
      newEvents.push(event);
      existingStartEventIds.add(event.id);
      identities.set(playerKey, identity);
      startOverrides += 1;
    }
    for (const standing of asArray(tournament.standings)) {
      const clientId = toStr(standing?.id || standing?.clientId);
      const phoneNorm = clientId ? phoneByClientId.get(clientId) || null : normalizeRatingPhone(standing?.phoneNorm || standing?.phone);
      const playerKey = buildPlayerRatingKey({ clientId, phoneNorm });
      if (!playerKey) continue;
      const identity = { playerKey, clientId, phoneNorm, name: toStr(standing?.name) || "Игрок" };
      const active = latestActiveTournamentEvent(allTournamentEvents, tournamentId, identity);
      if (!final) {
        if (active) {
          const compensation = buildTournamentCompensationEvent({
            event: active,
            occurredAt: changedAt,
            reason: "REOPENED",
          });
          if (compensation) {
            newEvents.push(compensation);
            allTournamentEvents.push(compensation);
            identities.set(playerKey, identity);
            reopened += 1;
          }
        }
        continue;
      }
      if (Date.parse(finishedAt) < Date.parse(notBeforeIso)) {
        skippedBeforeCutover += 1;
        continue;
      }
      const sourceRevision = buildTournamentRatingRevision({ tournamentId, finishedAt, standing });
      if (active?.source?.sourceRevision === sourceRevision) continue;
      const resolvedCanonicalBefore = await resolveCanonicalRatingBefore(
        db,
        identity,
        finishedAt,
        newEvents,
      );
      const canonicalBefore = resolveTournamentRevisionCanonicalBefore(
        active,
        resolvedCanonicalBefore,
        allTournamentEvents,
      );
      const event = buildTournamentRatingEvent({
        tournamentId,
        // A technical document update is not a rating revision. The event id
        // must remain stable until finalized standings or finishedAt change.
        finishedAt,
        standing,
        phoneNorm,
        canonicalBefore,
        occurredAt: active ? changedAt : finishedAt,
        createdAt: nowIso,
        previousEventId: active?.id || null,
      });
      if (!event) continue;
      const duplicate = allTournamentEvents.some((candidate) => candidate.id === event.id);
      if (duplicate) continue;
      if (active) {
        const compensation = buildTournamentCompensationEvent({
          event: active,
          occurredAt: new Date(Math.max(Date.parse(changedAt) - 1, Date.parse(notBeforeIso))).toISOString(),
          reason: "CORRECTED",
        });
        if (compensation) {
          newEvents.push(compensation);
          allTournamentEvents.push(compensation);
        }
      }
      const currentState = await loadStateForIdentity(db, identity);
      if (!currentState) {
        const bootstrap = buildBootstrapEvent({ event, createdAt: nowIso });
        if (bootstrap) newEvents.push(bootstrap);
      }
      newEvents.push(event);
      allTournamentEvents.push(event);
      identities.set(playerKey, identity);
      finalized += 1;
    }
  }

  if (!dryRun && newEvents.length > 0) {
    await db.collection(PLAYER_RATING_COLLECTIONS.events).bulkWrite(
      newEvents.map((event) => ({
        updateOne: {
          filter: { _id: event.id },
          update: { $setOnInsert: event },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  }
  const projections = [];
  for (const identity of identities.values()) {
    const projected = await projectIdentityState(db, identity, nowIso, dryRun);
    projections.push(projected);
    await enqueueProjection(db, projected, nowIso, dryRun);
  }
  return {
    scanned: tournaments.length,
    eventsPlanned: newEvents.length,
    finalized,
    reopened,
    startOverrides,
    skippedBeforeCutover,
    playersProjected: projections.length,
    statesChanged: projections.filter((item) => item.changed).length,
  };
}

export async function processTimeForFriendsAutoEnrollments(db, {
  sinceIso,
  nowIso,
  dryRun,
  enabled = false,
  cutoverIso = null,
}) {
  const normalizedCutoverIso = toIso(cutoverIso);
  if (!enabled || !normalizedCutoverIso) {
    return {
      enabled: false,
      cutoverIso: normalizedCutoverIso,
      scanned: 0,
      planned: 0,
      applied: 0,
      alreadyMembers: 0,
      quarantined: 0,
      skipped: 0,
      affectedCommunityIds: [],
    };
  }
  const effectiveSinceIso = new Date(Math.max(
    Date.parse(toIso(sinceIso, normalizedCutoverIso)),
    Date.parse(normalizedCutoverIso),
  )).toISOString();
  const changedFilter = changedSinceFilter(effectiveSinceIso);
  const changedFeed = await db.collection("lk_community_feed").find(
    changedFilter,
    { projection: { relatedTournamentId: 1, tournamentId: 1, details: 1 } },
  ).toArray();
  const changedTournamentIds = unique(changedFeed.flatMap(collectPublicationTournamentIds));
  const tournamentFilter = {
    $or: [
      ...changedFilter.$or,
      ...(changedTournamentIds.length > 0 ? [
        { tournamentId: { $in: changedTournamentIds } },
        { exerciseId: { $in: changedTournamentIds } },
        { id: { $in: changedTournamentIds } },
      ] : []),
    ],
  };
  const discoveredTournaments = await db.collection("tournaments").find(tournamentFilter).toArray();
  const tournaments = discoveredTournaments.filter((tournament) => {
    const sourceAt = toIso(
      tournament?.timeFrom
      || tournament?.startsAt
      || tournament?.params?.timeFrom
      || tournament?.params?.startsAt
      || tournament?.createdAt,
    );
    return Boolean(sourceAt && Date.parse(sourceAt) >= Date.parse(normalizedCutoverIso));
  });
  const skippedBeforeCutover = discoveredTournaments.length - tournaments.length;
  const tournamentIds = unique(tournaments.map(resolveTournamentId));
  if (tournamentIds.length === 0) {
    return {
      scanned: 0,
      planned: 0,
      applied: 0,
      alreadyMembers: 0,
      quarantined: 0,
      skipped: 0,
      skippedBeforeCutover,
      affectedCommunityIds: [],
    };
  }

  const feedPosts = await db.collection("lk_community_feed").find({
    archived: { $ne: true },
    kind: "TOURNAMENT",
    $or: [
      { relatedTournamentId: { $in: tournamentIds } },
      { tournamentId: { $in: tournamentIds } },
      { "details.relatedTournamentId": { $in: tournamentIds } },
      { "details.publicTournament.exerciseId": { $in: tournamentIds } },
      { "details.publicTournament.tournamentId": { $in: tournamentIds } },
    ],
  }).toArray();
  const communityIds = unique(feedPosts.map((post) => toStr(post.communityId)));
  const communities = communityIds.length > 0
    ? await db.collection("lk_communities").find({
      id: { $in: communityIds },
      archived: { $ne: true },
    }).toArray()
    : [];
  const feedByTournamentId = new Map();
  feedPosts.forEach((post) => {
    collectPublicationTournamentIds(post).forEach((tournamentId) => {
      const rows = feedByTournamentId.get(tournamentId) || [];
      rows.push(post);
      feedByTournamentId.set(tournamentId, rows);
    });
  });

  const plans = tournaments.map((tournament) => planTimeForFriendsAutoEnrollment({
    tournament,
    feedPosts: feedByTournamentId.get(resolveTournamentId(tournament)) || [],
    communities,
  }));
  const operations = plans.flatMap((plan) => plan.operations);
  const skipped = plans.flatMap((plan) => plan.skipped);
  const quarantined = plans.flatMap((plan) => plan.quarantined);
  const affectedCommunityIds = new Set();
  let applied = 0;
  let alreadyMembers = skipped.filter((row) => row.reason === "ALREADY_MEMBER").length;

  if (!dryRun) {
    for (const operation of operations) {
      const auditId = `auto:${operation.operationId}`;
      const auditCollection = db.collection("lk_tournament_community_enrollments");
      const previousAudit = await auditCollection.findOne({ _id: auditId });
      const previousApplied = ["APPLIED", "APPLIED_IDEMPOTENT", "RECOVERED_APPLIED"].includes(previousAudit?.status);
      if (!previousApplied) {
        await auditCollection.updateOne(
          { _id: auditId },
          {
            $set: { status: "PREPARED", updatedAt: nowIso },
            $setOnInsert: {
              _id: auditId,
              operationId: operation.operationId,
              source: "TIME_FOR_FRIENDS_TOURNAMENT_AUTO_ENROLLMENT",
              tournamentId: operation.tournamentId,
              communityId: operation.communityId,
              playerId: operation.playerId,
              createdAt: nowIso,
            },
          },
          { upsert: true },
        );
      }
      const mutation = buildTimeForFriendsAutoEnrollmentMutation(operation, nowIso);
      const result = await db.collection("lk_communities").updateOne(mutation.filter, mutation.update);
      let status = result?.matchedCount > 0 ? "APPLIED" : null;
      if (!status) {
        const current = await db.collection("lk_communities").findOne({ id: operation.communityId });
        if (!current || current.archived === true) status = "COMMUNITY_NOT_ACTIVE";
        else if (asArray(current.bannedMembers).some((row) => (
          toStr(row?.id || row?.clientId || row?.playerId || row?.userId) === operation.playerId
          || Boolean(operation.phoneNorm && normalizeRatingPhone(row?.phoneNorm || row?.phone) === operation.phoneNorm)
        ))) status = "PLAYER_BANNED";
        else {
          const member = asArray(current.members).find((row) => (
            toStr(row?.id || row?.clientId || row?.playerId || row?.userId) === operation.playerId
            || Boolean(operation.phoneNorm && normalizeRatingPhone(row?.phoneNorm || row?.phone) === operation.phoneNorm)
          ));
          if (member) {
            const ownedByOperation = member?.joinSource?.type === operation.joinSourceType
              && asArray(member?.joinSource?.tournamentIds).includes(operation.tournamentId);
            status = previousApplied
              ? "APPLIED_IDEMPOTENT"
              : (previousAudit?.status === "PREPARED" && ownedByOperation ? "RECOVERED_APPLIED" : "ALREADY_MEMBER");
          } else status = "READBACK_FAILED";
        }
      }
      if (status === "APPLIED") {
        applied += 1;
        affectedCommunityIds.add(operation.communityId);
      } else if (["ALREADY_MEMBER", "APPLIED_IDEMPOTENT"].includes(status)) {
        alreadyMembers += 1;
      } else if (status === "RECOVERED_APPLIED") {
        applied += 1;
        affectedCommunityIds.add(operation.communityId);
      }
      await auditCollection.updateOne(
        { _id: auditId },
        {
          $set: {
            status,
            updatedAt: nowIso,
          },
        },
        { upsert: false },
      );
      if (!["APPLIED", "ALREADY_MEMBER", "APPLIED_IDEMPOTENT", "RECOVERED_APPLIED"].includes(status)) {
        throw new Error(`TFF auto-enrollment ${operation.operationId} failed safe: ${status}`);
      }
    }
  } else {
    operations.forEach((operation) => affectedCommunityIds.add(operation.communityId));
  }

  return {
    enabled: true,
    cutoverIso: normalizedCutoverIso,
    scanned: tournaments.length,
    planned: operations.length,
    applied,
    alreadyMembers,
    quarantined: quarantined.length,
    skipped: skipped.length,
    skippedBeforeCutover,
    quarantinedByReason: Object.fromEntries(Object.entries(quarantined.reduce((counts, row) => {
      counts[row.reason] = (counts[row.reason] || 0) + 1;
      return counts;
    }, {})).sort(([left], [right]) => left.localeCompare(right))),
    affectedCommunityIds: [...affectedCommunityIds].sort(),
  };
}

async function projectChangedLedgerPlayers(db, sinceIso, nowIso, dryRun) {
  const events = await db.collection(PLAYER_RATING_COLLECTIONS.events).find({
    "source.applyToState": { $ne: false },
    $or: [{ createdAt: { $gte: sinceIso } }, { occurredAt: { $gte: sinceIso } }],
  }).toArray();
  const identities = new Map();
  events.forEach((event) => {
    const clientId = toStr(event?.player?.clientId);
    const phoneNorm = normalizeRatingPhone(event?.player?.phoneNorm);
    const playerKey = toStr(event?.player?.key) || buildPlayerRatingKey({ clientId, phoneNorm });
    if (!playerKey) return;
    identities.set(playerKey, {
      playerKey,
      clientId,
      phoneNorm,
      name: toStr(event?.player?.name) || "Игрок",
    });
  });
  let changed = 0;
  for (const identity of identities.values()) {
    const result = await projectIdentityState(db, identity, nowIso, dryRun);
    if (result.changed) changed += 1;
  }
  return { events: events.length, players: identities.size, changed };
}

function buildCollections(db) {
  return {
    source: {
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.communities]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.communities),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.feed]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.feed),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.games]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.games),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.visits]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.visits),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents),
      [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState]: db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState),
    },
    storage: {
      [COMMUNITY_RATING_COLLECTIONS.facts]: db.collection(COMMUNITY_RATING_COLLECTIONS.facts),
      [COMMUNITY_RATING_COLLECTIONS.aggregates]: db.collection(COMMUNITY_RATING_COLLECTIONS.aggregates),
      [COMMUNITY_RATING_COLLECTIONS.snapshots]: db.collection(COMMUNITY_RATING_COLLECTIONS.snapshots),
    },
  };
}

async function activeCommunityIds(db) {
  const rows = await db.collection("lk_communities").find({ archived: { $ne: true } }, { projection: { id: 1 } }).toArray();
  return unique(rows.map((row) => toStr(row.id || row.communityId)));
}

function changedSinceFilter(sinceIso) {
  return {
    $or: [
      { updatedAt: { $gte: sinceIso } },
      { createdAt: { $gte: sinceIso } },
      { occurredAt: { $gte: sinceIso } },
      { syncedAt: { $gte: sinceIso } },
      { collectedAt: { $gte: sinceIso } },
    ],
  };
}

export async function resolveIncrementalCommunityIds(db, sinceIso, firstRun) {
  if (firstRun) return activeCommunityIds(db);
  const changedFilter = changedSinceFilter(sinceIso);
  const [communities, feed, games, tournaments, visits, states, events] = await Promise.all([
    db.collection("lk_communities").find(changedFilter, { projection: { id: 1, communityId: 1 } }).toArray(),
    db.collection("lk_community_feed").find(changedFilter, { projection: { communityId: 1, relatedGameId: 1, relatedTournamentId: 1, tournamentId: 1, details: 1 } }).toArray(),
    db.collection("lk_games").find(changedFilter, { projection: { id: 1, gameId: 1 } }).toArray(),
    db.collection("tournaments").find(changedFilter, { projection: { tournamentId: 1, exerciseId: 1, id: 1 } }).toArray(),
    db.collection("lk_training_visits").find(changedFilter, { projection: { communityId: 1, relatedCommunityId: 1, studioId: 1 } }).toArray(),
    db.collection(PLAYER_RATING_COLLECTIONS.state).find(changedFilter, { projection: { clientId: 1, phoneNorm: 1 } }).toArray(),
    db.collection(PLAYER_RATING_COLLECTIONS.events).find(changedFilter, { projection: { player: 1, source: 1 } }).toArray(),
  ]);
  const ids = new Set();
  communities.forEach((row) => ids.add(toStr(row.id || row.communityId)));
  feed.forEach((row) => ids.add(toStr(row.communityId)));
  const gameIds = unique(games.map((row) => toStr(row.id || row.gameId)));
  const tournamentIds = unique(tournaments.map((row) => toStr(row.tournamentId || row.exerciseId || row.id)));
  events.forEach((event) => {
    if (event?.source?.domain === "GAME_RESULT") gameIds.push(toStr(event?.source?.sourceId));
    if (["TOURNAMENT", "TOURNAMENT_START"].includes(event?.source?.domain)) {
      tournamentIds.push(toStr(event?.source?.sourceId));
    }
  });
  if (gameIds.length > 0 || tournamentIds.length > 0) {
    const linked = await db.collection("lk_community_feed").find({
      archived: { $ne: true },
      $or: [
        ...(gameIds.length ? [{ relatedGameId: { $in: unique(gameIds) } }, { gameId: { $in: unique(gameIds) } }] : []),
        ...(tournamentIds.length ? [
          { relatedTournamentId: { $in: unique(tournamentIds) } },
          { tournamentId: { $in: unique(tournamentIds) } },
          { "details.relatedTournamentId": { $in: unique(tournamentIds) } },
          { "details.publicTournament.exerciseId": { $in: unique(tournamentIds) } },
          { "details.publicTournament.tournamentId": { $in: unique(tournamentIds) } },
        ] : []),
      ],
    }, { projection: { communityId: 1 } }).toArray();
    linked.forEach((row) => ids.add(toStr(row.communityId)));
  }
  const communityByStudio = new Map();
  Object.entries(COMMUNITY_RATING_VISIT_SCOPE_BY_COMMUNITY_ID).forEach(([communityId, studioIds]) => {
    studioIds.forEach((studioId) => communityByStudio.set(studioId, communityId));
  });
  visits.forEach((visit) => {
    ids.add(toStr(visit.communityId));
    ids.add(toStr(visit.relatedCommunityId));
    ids.add(communityByStudio.get(toStr(visit.studioId)) || null);
  });
  const identities = [...states, ...events.map((event) => event.player || {})];
  const clientIds = unique(identities.map((item) => toStr(item.clientId)));
  const phones = unique(identities.map((item) => normalizeRatingPhone(item.phoneNorm)));
  if (clientIds.length > 0 || phones.length > 0) {
    const memberCommunities = await db.collection("lk_communities").find({
      archived: { $ne: true },
      $or: [
        ...(clientIds.length ? [
          { "members.id": { $in: clientIds } },
          { "members.clientId": { $in: clientIds } },
          { "members.playerId": { $in: clientIds } },
        ] : []),
        ...(phones.length ? [
          { "members.phoneNorm": { $in: phones } },
          { "members.phone": { $in: phones } },
        ] : []),
      ],
    }, { projection: { id: 1 } }).toArray();
    memberCommunities.forEach((row) => ids.add(toStr(row.id)));
  }
  return [...ids].filter(Boolean);
}

async function recalculateCommunities(db, communityIds, nowIso, dryRun) {
  const collections = buildCollections(db);
  if (!dryRun) await ensureCommunityRatingStorageIndexes(collections.storage);
  const results = [];
  const concurrency = 6;
  for (let index = 0; index < communityIds.length; index += concurrency) {
    const batchIds = communityIds.slice(index, index + concurrency);
    const batchResults = await Promise.all(batchIds.map(async (communityId) => {
      const result = await recalculateCommunityRating({
        collections,
        communityId,
        periods: ["all", "30d"],
        tabs: ["overall", "dynamics", "games", "tournaments"],
        updatedAt: nowIso,
        dryRun,
        ensureIndexes: false,
      });
      return { communityId, facts: result?.facts.length || 0, snapshots: result?.batch.summary.snapshotUpserts || 0 };
    }));
    results.push(...batchResults);
    console.error(`[rating-worker] community batch ${Math.min(index + concurrency, communityIds.length)}/${communityIds.length}`);
  }
  return {
    communities: results.length,
    facts: results.reduce((sum, item) => sum + item.facts, 0),
    snapshots: results.reduce((sum, item) => sum + item.snapshots, 0),
  };
}

async function processProjectionOutbox(db, projectionUrl, nowIso, dryRun) {
  const rows = await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).find({
    status: { $in: ["PENDING", "FAILED_RETRYABLE"] },
    nextAttemptAt: { $lte: nowIso },
    attempts: { $lt: 30 },
  }).sort({ createdAt: 1 }).limit(100).toArray();
  const result = { scanned: rows.length, synced: 0, failed: 0 };
  if (dryRun) return result;
  for (const row of rows) {
    const attemptAt = new Date().toISOString();
    try {
      const response = await fetch(projectionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(row.payload),
      });
      const raw = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
      await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).updateOne(
        { _id: row._id },
        { $set: { status: "SYNCED", syncedAt: attemptAt, updatedAt: attemptAt, lastHttpStatus: response.status }, $inc: { attempts: 1 } },
      );
      result.synced += 1;
    } catch (error) {
      const nextAttemptAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).updateOne(
        { _id: row._id },
        { $set: { status: "FAILED_RETRYABLE", lastError: String(error?.message || error).slice(0, 500), lastAttemptAt: attemptAt, nextAttemptAt, updatedAt: attemptAt }, $inc: { attempts: 1 } },
      );
      result.failed += 1;
    }
  }
  return result;
}

async function acquireLease(db, jobKey, owner, nowIso) {
  const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_MS).toISOString();
  const result = await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).findOneAndUpdate(
    {
      jobKey,
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: { $lte: nowIso } },
        { leaseOwner: owner },
      ],
    },
    {
      $setOnInsert: { createdAt: nowIso, enabled: true },
      $set: { leaseOwner: owner, leaseUntil, updatedAt: nowIso },
    },
    { upsert: true, returnDocument: "after" },
  );
  return result;
}

async function releaseLease(db, jobKey, owner, fields) {
  await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).updateOne(
    { jobKey, leaseOwner: owner },
    { $set: fields, $unset: { leaseOwner: "", leaseUntil: "" } },
  );
}

async function runWorker() {
  const mode = getArg("--mode", "incremental");
  const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
  const dbName = getArg("--db", process.env.MONGO_DB || "games");
  const dryRun = hasFlag("--dry-run");
  const outPath = getArg("--out");
  const projectionUrl = getArg("--projection-url", process.env.RATING_PROJECTION_URL || "http://127.0.0.1:1880/lk/onboarding/level");
  const tffAutoEnrollmentEnabled = String(process.env.TFF_AUTO_ENROLLMENT_ENABLED || "").trim().toLowerCase() === "true";
  const tffAutoEnrollmentCutoverIso = toIso(process.env.TFF_AUTO_ENROLLMENT_CUTOVER_ISO);
  if (!mongoUri) throw new Error("Provide --mongo-uri or MONGO_URI/MONGODB_URI");
  if (!["incremental", "full", "postcheck"].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
  const startedAt = new Date().toISOString();
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const jobKey = mode === "full" ? RATING_WORKER_FULL_JOB_KEY : RATING_WORKER_JOB_KEY;
  const runId = `${jobKey}:${startedAt}:${crypto.randomUUID()}`;
  try {
    await client.connect();
    const db = client.db(dbName);
    if (mode === "postcheck") {
      const report = await buildPostcheck(db, startedAt);
      console.log(JSON.stringify(report, null, 2));
      if (outPath) fs.writeFileSync(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return;
    }
    if (!dryRun) await ensureWorkerIndexes(db);
    const registry = await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).findOne({ jobKey });
    const ledgerRegistry = await db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).findOne({ jobKey: "rating-ledger-projector" });
    const notBeforeIso = toIso(ledgerRegistry?.ledgerNotBefore);
    if (!notBeforeIso) throw new Error("rating-ledger-projector.ledgerNotBefore is not configured; run canonical state migration first");
    if (!dryRun) {
      const lease = await acquireLease(db, jobKey, owner, startedAt);
      if (!lease || lease.leaseOwner !== owner) throw new Error(`Job ${jobKey} is already running`);
    }
    const watermarkBefore = mode === "full" ? notBeforeIso : toIso(registry?.watermark, notBeforeIso);
    const overlapStart = new Date(Math.max(
      Date.parse(notBeforeIso),
      Date.parse(watermarkBefore) - DEFAULT_OVERLAP_MS,
    )).toISOString();
    if (!dryRun) {
      await db.collection(PLAYER_RATING_COLLECTIONS.jobRuns).insertOne({
        runId,
        jobKey,
        version: PLAYER_RATING_WORKER_VERSION,
        mode,
        status: "RUNNING",
        watermarkBefore,
        startedAt,
        startedAtTs: Date.parse(startedAt),
      });
    }
    const ledger = await processTournamentLedger(db, {
      sinceIso: mode === "full" ? notBeforeIso : overlapStart,
      notBeforeIso,
      nowIso: startedAt,
      dryRun,
    });
    const timeForFriendsEnrollment = await processTimeForFriendsAutoEnrollments(db, {
      sinceIso: mode === "full" ? notBeforeIso : overlapStart,
      nowIso: startedAt,
      dryRun,
      enabled: tffAutoEnrollmentEnabled,
      cutoverIso: tffAutoEnrollmentCutoverIso,
    });
    const eventProjection = await projectChangedLedgerPlayers(db, overlapStart, startedAt, dryRun);
    const compatibilityReconciliation = mode === "full"
      ? await reconcileCompatibilityProjection(db, startedAt, dryRun)
      : { scanned: 0, changed: 0, skipped: true };
    const communityIds = mode === "full"
      ? await activeCommunityIds(db)
      : await resolveIncrementalCommunityIds(db, overlapStart, !registry?.watermark);
    timeForFriendsEnrollment.affectedCommunityIds.forEach((communityId) => communityIds.push(communityId));
    const uniqueCommunityIds = unique(communityIds);
    const community = await recalculateCommunities(db, uniqueCommunityIds, startedAt, dryRun);
    const vivaProjection = await processProjectionOutbox(db, projectionUrl, startedAt, dryRun);
    const finishedAt = new Date().toISOString();
    const summary = {
      ok: true,
      dryRun,
      mode,
      version: PLAYER_RATING_WORKER_VERSION,
      runId,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      watermarkBefore,
      watermarkAfter: startedAt,
      ledger,
      timeForFriendsEnrollment,
      eventProjection,
      compatibilityReconciliation,
      community,
      vivaProjection,
    };
    if (!dryRun) {
      await db.collection(PLAYER_RATING_COLLECTIONS.jobRuns).updateOne(
        { runId },
        { $set: { status: "SUCCEEDED", finishedAt, durationMs: summary.durationMs, counts: { ledger, timeForFriendsEnrollment, eventProjection, compatibilityReconciliation, community, vivaProjection } } },
      );
      await releaseLease(db, jobKey, owner, {
        jobKey,
        version: PLAYER_RATING_WORKER_VERSION,
        schedule: mode === "full" ? "17 3 * * *" : "*/15 * * * *",
        lastRunId: runId,
        lastStatus: "SUCCEEDED",
        lastStartedAt: startedAt,
        lastFinishedAt: finishedAt,
        watermark: startedAt,
        lastError: null,
        updatedAt: finishedAt,
      });
    }
    console.log(JSON.stringify(summary, null, 2));
    if (outPath) {
      const target = path.resolve(outPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    const finishedAt = new Date().toISOString();
    try {
      const db = client.db(dbName);
      if (!dryRun) {
        await db.collection(PLAYER_RATING_COLLECTIONS.jobRuns).updateOne(
          { runId },
          { $set: { status: "FAILED", finishedAt, error: String(error?.message || error).slice(0, 1000) } },
        );
        await releaseLease(db, jobKey, owner, {
          lastStatus: "FAILED",
          lastFinishedAt: finishedAt,
          lastError: String(error?.message || error).slice(0, 1000),
          updatedAt: finishedAt,
        });
      }
    } catch {
      // Preserve the original worker error.
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function buildPostcheck(db, nowIso) {
  const [stateRows, events, compatibilityRows, snapshotRows, activeCommunityRows, jobs, pendingProjection] = await Promise.all([
    db.collection(PLAYER_RATING_COLLECTIONS.state).find({}, {
      projection: { playerKey: 1, clientId: 1, phoneNorm: 1, ratingNumeric: 1, rating: 1, lastEventId: 1 },
    }).toArray(),
    db.collection(PLAYER_RATING_COLLECTIONS.events).countDocuments({}),
    db.collection(PLAYER_RATING_COLLECTIONS.compatibilityState).find({}, {
      projection: { playerKey: 1, clientId: 1, phoneNorm: 1, ratingNumeric: 1, rating: 1, lastEventId: 1 },
    }).toArray(),
    db.collection(COMMUNITY_RATING_COLLECTIONS.snapshots).find({
      calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    }, { projection: { communityId: 1, period: 1, tab: 1, updatedAt: 1 } }).toArray(),
    db.collection(COMMUNITY_RATING_SOURCE_COLLECTIONS.communities).find({ archived: { $ne: true } }, {
      projection: { id: 1, communityId: 1 },
    }).toArray(),
    db.collection(PLAYER_RATING_COLLECTIONS.jobRegistry).find({}, {
      projection: {
        _id: 0,
        jobKey: 1,
        version: 1,
        lastStatus: 1,
        lastStartedAt: 1,
        lastFinishedAt: 1,
        watermark: 1,
        lastError: 1,
      },
    }).toArray(),
    db.collection(PLAYER_RATING_COLLECTIONS.projectionOutbox).countDocuments({ status: { $ne: "SYNCED" } }),
  ]);
  const mismatchRows = await db.collection(PLAYER_RATING_COLLECTIONS.state).aggregate([
    { $lookup: { from: PLAYER_RATING_COLLECTIONS.events, localField: "lastEventId", foreignField: "_id", as: "lastEvent" } },
    { $match: { "lastEvent.0": { $exists: false } } },
    { $count: "count" },
  ]).toArray();
  const duplicateClients = await db.collection(PLAYER_RATING_COLLECTIONS.state).aggregate([
    { $match: { clientId: { $type: "string" } } },
    { $group: { _id: "$clientId", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "count" },
  ]).toArray();
  const compatibilityIndexes = {
    playerKey: new Map(),
    clientId: new Map(),
    phoneNorm: new Map(),
  };
  const addCompatibilityIndex = (index, value, row) => {
    if (!value) return;
    const matches = index.get(value) || [];
    matches.push(row);
    index.set(value, matches);
  };
  compatibilityRows.forEach((row) => {
    addCompatibilityIndex(compatibilityIndexes.playerKey, row.playerKey, row);
    addCompatibilityIndex(compatibilityIndexes.clientId, row.clientId, row);
    addCompatibilityIndex(compatibilityIndexes.phoneNorm, row.phoneNorm, row);
  });
  const usedCompatibilityIds = new Set();
  const compatibilityDrift = {
    missing: 0,
    extra: 0,
    identityConflicts: 0,
    playerKey: 0,
    clientId: 0,
    phoneNorm: 0,
    ratingNumeric: 0,
    rating: 0,
    lastEventId: 0,
  };
  stateRows.forEach((state) => {
    const candidates = new Map();
    [
      ...asArray(compatibilityIndexes.playerKey.get(state.playerKey)),
      ...asArray(compatibilityIndexes.clientId.get(state.clientId)),
      ...asArray(compatibilityIndexes.phoneNorm.get(state.phoneNorm)),
    ].forEach((row) => candidates.set(toStr(row._id), row));
    if (candidates.size === 0) {
      compatibilityDrift.missing += 1;
      return;
    }
    if (candidates.size > 1) {
      compatibilityDrift.identityConflicts += 1;
      return;
    }
    const compatibilityState = [...candidates.values()][0];
    usedCompatibilityIds.add(toStr(compatibilityState._id));
    if ((state.playerKey || null) !== (compatibilityState.playerKey || null)) compatibilityDrift.playerKey += 1;
    if ((state.clientId || null) !== (compatibilityState.clientId || null)) compatibilityDrift.clientId += 1;
    if ((state.phoneNorm || null) !== (compatibilityState.phoneNorm || null)) compatibilityDrift.phoneNorm += 1;
    if (Number(state.ratingNumeric) !== Number(compatibilityState.ratingNumeric)) compatibilityDrift.ratingNumeric += 1;
    if ((state.rating || null) !== (compatibilityState.rating || null)) compatibilityDrift.rating += 1;
    if ((state.lastEventId || null) !== (compatibilityState.lastEventId || null)) compatibilityDrift.lastEventId += 1;
  });
  compatibilityDrift.extra = compatibilityRows
    .filter((row) => !usedCompatibilityIds.has(toStr(row._id)))
    .length;
  const compatibilityDriftTotal = Object.values(compatibilityDrift).reduce((sum, count) => sum + count, 0);
  const activeCommunityIds = unique(activeCommunityRows.map((row) => toStr(row.id || row.communityId)));
  const snapshotKeys = new Set(snapshotRows.map((row) => `${row.communityId}:${row.period}:${row.tab}`));
  const expectedSnapshots = activeCommunityIds.length * COMMUNITY_RATING_PERIODS.length * COMMUNITY_RATING_TABS.length;
  const snapshotTimes = snapshotRows.map((row) => Date.parse(row.updatedAt)).filter(Number.isFinite);
  const oldestSnapshotUpdatedAt = snapshotTimes.length > 0 ? new Date(Math.min(...snapshotTimes)).toISOString() : null;
  const newestSnapshotUpdatedAt = snapshotTimes.length > 0 ? new Date(Math.max(...snapshotTimes)).toISOString() : null;
  const incrementalJob = jobs.find((job) => job.jobKey === RATING_WORKER_JOB_KEY);
  const fullJob = jobs.find((job) => job.jobKey === RATING_WORKER_FULL_JOB_KEY);
  const incrementalFresh = incrementalJob?.lastStatus === "SUCCEEDED"
    && Date.parse(nowIso) - Date.parse(incrementalJob.lastFinishedAt) <= 30 * 60 * 1000;
  const fullHealthy = fullJob?.lastStatus === "SUCCEEDED" && Boolean(fullJob.lastStartedAt);
  const snapshotsComplete = snapshotRows.length === expectedSnapshots && snapshotKeys.size === expectedSnapshots;
  const snapshotsCoverLastFull = fullHealthy
    && oldestSnapshotUpdatedAt != null
    && Date.parse(oldestSnapshotUpdatedAt) >= Date.parse(fullJob.lastStartedAt);
  const stateWithoutLastEvent = mismatchRows[0]?.count || 0;
  const duplicateClientIds = duplicateClients[0]?.count || 0;
  return {
    ok: stateWithoutLastEvent === 0
      && duplicateClientIds === 0
      && compatibilityDriftTotal === 0
      && pendingProjection === 0
      && incrementalFresh
      && fullHealthy
      && snapshotsComplete
      && snapshotsCoverLastFull,
    checkedAt: nowIso,
    version: PLAYER_RATING_WORKER_VERSION,
    counts: {
      states: stateRows.length,
      events,
      compatibility: compatibilityRows.length,
      snapshots: snapshotRows.length,
      activeCommunities: activeCommunityIds.length,
      expectedSnapshots,
      pendingProjection,
    },
    drift: {
      stateWithoutLastEvent,
      duplicateClientIds,
      compatibility: compatibilityDrift,
      compatibilityTotal: compatibilityDriftTotal,
    },
    health: {
      incrementalFresh,
      fullHealthy,
      snapshotsComplete,
      snapshotsCoverLastFull,
      oldestSnapshotUpdatedAt,
      newestSnapshotUpdatedAt,
    },
    jobs,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runWorker().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
