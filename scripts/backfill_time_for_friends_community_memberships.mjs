#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildRedactedBackfillReport,
  buildTimeForFriendsAtomicMembershipMutation,
  buildTimeForFriendsCommunityBackfillPlan,
  classifyExistingMembershipAfterPreviousLedger,
  collectPublicationTournamentIds,
  hashBackfillPlan,
  validateBackfillScope,
} from "./lib/timeForFriendsCommunityBackfill.mjs";
import { createVivaFetch } from "./lib/vivaUserAgent.mjs";

const vivaFetch = createVivaFetch();

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const recordMatchesOperation = (record, operation) => {
  if (!isObject(record)) return false;
  const idMatch = [record.id, record.clientId, record.playerId, record.userId]
    .map(toStringOrNull).includes(operation.playerId);
  const phoneMatch = operation.phoneNorm && [record.phoneNorm, record.phone, record.phoneNumber, record.mobile]
    .map(normalizePhone).includes(operation.phoneNorm);
  return Boolean(idMatch || phoneMatch);
};
const hasPhoneOnlyIdentity = (record) => isObject(record)
  && ![record.id, record.clientId, record.playerId, record.userId].map(toStringOrNull).some(Boolean)
  && Boolean(normalizePhone(record.phoneNorm ?? record.phone ?? record.phoneNumber ?? record.mobile));
const classifyApplyError = (error) => {
  const code = String(error?.code || error?.codeName || "").toUpperCase();
  const message = String(error?.message || "").toUpperCase();
  if (code === "11000" || code.includes("DUPLICATE")) return "DUPLICATE_KEY";
  if (code.includes("TIMEOUT") || message.includes("TIMEOUT") || message.includes("TIMED OUT")) {
    return "MONGO_TIMEOUT";
  }
  if (message.includes("NETWORK") || message.includes("CONNECTION")) return "MONGO_CONNECTION_ERROR";
  return "MONGO_WRITE_ERROR";
};

function getArg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  console.error(`
Time for Friends community membership backfill

Default mode is read-only dry-run. The scope manifest must contain reviewed exact
communityId -> stationId pairs; names and station-only fallback are not used.

Usage:
  npm run tff:memberships:backfill -- \\
    --mongo-uri "$MONGODB_URI" \\
    --scope tmp/time-for-friends-community-scope.json \\
    --fetch-participants \\
    --inventory-from 2025-08-11 \\
    --inventory-to 2026-08-11 \\
    --out tmp/time-for-friends-memberships-dryrun.json

Apply after reviewing the fresh dry-run report:
  npm run tff:memberships:backfill -- \\
    --mongo-uri "$MONGODB_URI" \\
    --scope tmp/time-for-friends-community-scope.json \\
    --fetch-participants \\
    --inventory-from 2025-08-11 \\
    --inventory-to 2026-08-11 \\
    --out tmp/time-for-friends-memberships-apply.json \\
    --apply --confirm-report-sha <dry-run-planSha256>

Options:
  --db <name>                  Mongo database, default: games
  --scope <file>               Required reviewed exact community/station manifest
  --out <file>                 Required private JSON report path
  --participants-file <file>   Optional reviewed Viva roster export keyed by exerciseId
  --fetch-participants         Read missing rosters from the bounded LK participants endpoint
  --inventory-from <date>      Optional inclusive Viva inventory start, YYYY-MM-DD
  --inventory-to <date>        Optional inclusive Viva inventory end, YYYY-MM-DD
  --participants-base-url <u>  Default: https://padlhub.su
  --viva-base-url <url>        Default: https://api.vivacrm.ru
  --tenant-key <key>           Default: iSkq6G
  --viva-token-env <name>      Optional Viva Bearer env, default: VIVA_TOKEN
  --participant-delay-ms <n>   Delay between reads, default: 1100
  --max-participant-fetches <n> Hard cap, default: 200
  --apply                      Enable guarded membership writes
  --confirm-report-sha <sha>   Required with --apply; must match the fresh plan
  --allow-quarantine           Apply safe rows even when unrelated rows are quarantined
  --help                       Show this help
`);
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function participantList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];
  for (const key of ["participants", "bookings", "content", "data", "items", "records"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function exerciseList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return [];
  for (const key of ["exercises", "content", "data", "items", "records"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

async function fetchVivaInventory(options) {
  const fromTs = Date.parse(`${options.from}T00:00:00.000Z`);
  const toTs = Date.parse(`${options.to}T00:00:00.000Z`);
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || fromTs > toTs) {
    throw new Error("Viva inventory requires a valid inclusive YYYY-MM-DD range");
  }
  const days = Math.floor((toTs - fromTs) / 86_400_000) + 1;
  if (days > 366) throw new Error(`Viva inventory date cap exceeded: ${days} > 366`);
  const exerciseIds = new Set();
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(fromTs + offset * 86_400_000).toISOString().slice(0, 10);
    const url = new URL(`/end-user/api/v1/${encodeURIComponent(options.tenantKey)}/exercises`, options.vivaBaseUrl);
    url.searchParams.set("date", date);
    url.searchParams.set("includePast", "true");
    url.searchParams.set("past", "true");
    const response = await vivaFetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(options.vivaToken ? { Authorization: `Bearer ${options.vivaToken}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Viva inventory failed for ${date}: HTTP_${response.status}`);
    const payload = await response.json();
    exerciseList(payload).forEach((exercise) => {
      if (String(exercise?.direction?.id ?? exercise?.directionId) !== "5278") return;
      const exerciseId = toStringOrNull(exercise?.id ?? exercise?.exerciseId);
      if (exerciseId) exerciseIds.add(exerciseId);
    });
  }
  return Array.from(exerciseIds).sort();
}

function resolvePublicationEnded(post, nowTs) {
  const candidates = [
    post?.endsAt,
    post?.timeTo,
    post?.details?.endsAt,
    post?.details?.timeTo,
    post?.details?.publicTournament?.endsAt,
    post?.details?.publicTournament?.timeTo,
    post?.details?.sourceTournamentSnapshot?.endsAt,
    post?.details?.sourceTournamentSnapshot?.timeTo,
  ];
  return candidates.some((value) => {
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) && parsed < nowTs;
  });
}

function resolveExerciseCapacity(exercise, posts) {
  const candidates = [
    exercise?.maxPlayers,
    exercise?.maxClientsCount,
    exercise?.capacity,
    exercise?.maximumParticipants,
    ...posts.flatMap((post) => [
      post?.details?.maxPlayers,
      post?.details?.details?.maxPlayers,
      post?.details?.publicTournament?.maxPlayers,
      post?.details?.publicTournament?.maxClientsCount,
      post?.details?.sourceTournamentSnapshot?.maxPlayers,
      post?.details?.sourceTournamentSnapshot?.maxClientsCount,
    ]),
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function fetchParticipantRosters(feedPosts, options, inventoryExerciseIds = []) {
  const postsByExerciseId = new Map();
  feedPosts.forEach((post) => {
    collectPublicationTournamentIds(post).forEach((exerciseId) => {
      const bucket = postsByExerciseId.get(exerciseId) || [];
      bucket.push(post);
      postsByExerciseId.set(exerciseId, bucket);
    });
  });
  inventoryExerciseIds.forEach((exerciseId) => {
    if (!postsByExerciseId.has(exerciseId)) postsByExerciseId.set(exerciseId, []);
  });
  if (postsByExerciseId.size > options.maxFetches) {
    throw new Error(`Participant read cap exceeded: ${postsByExerciseId.size} > ${options.maxFetches}`);
  }

  const rosters = {};
  let index = 0;
  for (const [exerciseId, posts] of postsByExerciseId.entries()) {
    if (index > 0 && options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    index += 1;
    let exercise = null;
    let metadataStatus = "MISSING";
    const exerciseUrl = new URL(
      `/end-user/api/v1/${encodeURIComponent(options.tenantKey)}/exercises/${encodeURIComponent(exerciseId)}`,
      options.vivaBaseUrl,
    );
    try {
      const exerciseResponse = await vivaFetch(exerciseUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(options.vivaToken ? { Authorization: `Bearer ${options.vivaToken}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      metadataStatus = exerciseResponse.ok ? "OK" : `HTTP_${exerciseResponse.status}`;
      if (exerciseResponse.ok) exercise = await exerciseResponse.json();
    } catch {
      exercise = null;
      metadataStatus = "FETCH_ERROR";
    }
    const url = new URL("/lk/tournaments/participants", options.baseUrl);
    url.searchParams.set("exerciseId", exerciseId);
    url.searchParams.set("size", "200");
    let response;
    try {
      response = await vivaFetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      rosters[exerciseId] = {
        sourceStatus: "FETCH_ERROR",
        metadataStatus,
        error: "PARTICIPANTS_FETCH_ERROR",
        directionId: toStringOrNull(exercise?.direction?.id ?? exercise?.directionId),
        stationId: toStringOrNull(
          exercise?.studio?.id ?? exercise?.station?.id ?? exercise?.studioId ?? exercise?.stationId,
        ),
        capacity: resolveExerciseCapacity(exercise, posts),
        exerciseEnded: resolvePublicationEnded(exercise || posts[0], Date.now()),
        participants: [],
      };
      continue;
    }
    if (!response.ok) {
      rosters[exerciseId] = {
        sourceStatus: `HTTP_${response.status}`,
        metadataStatus,
        error: "PARTICIPANTS_HTTP_ERROR",
        directionId: toStringOrNull(exercise?.direction?.id ?? exercise?.directionId),
        stationId: toStringOrNull(
          exercise?.studio?.id ?? exercise?.station?.id ?? exercise?.studioId ?? exercise?.stationId,
        ),
        capacity: resolveExerciseCapacity(exercise, posts),
        exerciseEnded: resolvePublicationEnded(exercise || posts[0], Date.now()),
        participants: [],
      };
      continue;
    }
    const payload = await response.json();
    rosters[exerciseId] = {
      sourceStatus: "PROVEN_ACTIVE",
      metadataStatus,
      directionId: toStringOrNull(exercise?.direction?.id ?? exercise?.directionId),
      stationId: toStringOrNull(
        exercise?.studio?.id ?? exercise?.station?.id ?? exercise?.studioId ?? exercise?.stationId,
      ),
      capacity: resolveExerciseCapacity(exercise, posts),
      exerciseEnded: resolvePublicationEnded(exercise || posts[0], Date.now()),
      participants: participantList(payload),
    };
  }
  return rosters;
}

async function classifyNoop(db, operation) {
  const community = await db.collection("lk_communities").findOne(
    { id: operation.communityId },
    { projection: { members: 1, bannedMembers: 1, archived: 1 } },
  );
  if (!community || community.archived === true) return "COMMUNITY_NOT_ACTIVE";
  if (!operation.phoneNorm
    && [...asArray(community.members), ...asArray(community.bannedMembers)].some(hasPhoneOnlyIdentity)) {
    return "COMMUNITY_LEGACY_IDENTITY_UNRESOLVED";
  }
  if (asArray(community.bannedMembers).some((member) => recordMatchesOperation(member, operation))) {
    return "PLAYER_BANNED";
  }
  if (asArray(community.members).some((member) => recordMatchesOperation(member, operation))) {
    return "ALREADY_MEMBER";
  }
  return "CONCURRENT_PRECONDITION_FAILED";
}

async function inspectAppliedMembership(db, operation) {
  const community = await db.collection("lk_communities").findOne(
    { id: operation.communityId, archived: { $ne: true } },
    { projection: { members: 1, memberCount: 1 } },
  );
  if (!community) return { identityCount: 0, memberCountConsistent: false, backfillProvenance: false };
  const members = asArray(community.members);
  const exactMatches = members.filter((member) => recordMatchesOperation(member, operation));
  return {
    identityCount: exactMatches.length,
    memberCountConsistent: Number(community.memberCount) === members.length,
    backfillProvenance: exactMatches.length === 1
      && exactMatches[0]?.joinSource?.type === "TIME_FOR_FRIENDS_TOURNAMENT_BACKFILL",
  };
}

async function applyBackfillPlan(db, plan, nowIso) {
  const ledger = db.collection("lk_tournament_community_enrollments");
  const executions = db.collection("lk_tournament_community_backfill_executions");
  await ledger.createIndex(
    { communityId: 1, playerId: 1 },
    { name: "community_player_unique", unique: true },
  );
  await ledger.createIndex({ status: 1, updatedAt: 1 }, { name: "status_updated_lookup" });
  const executionId = `${plan.version}:${hashBackfillPlan(plan)}`;
  await executions.updateOne(
    { _id: executionId },
    {
      $setOnInsert: { _id: executionId, planSha256: hashBackfillPlan(plan), createdAt: nowIso },
      $set: { status: "RUNNING", startedAt: nowIso, updatedAt: nowIso },
    },
    { upsert: true },
  );

  const results = [];
  for (const operation of plan.operations) {
    try {
      const previousLedger = await ledger.findOne(
        { _id: operation.operationId },
        { projection: { status: 1, appliedAt: 1 } },
      );
      await ledger.updateOne(
        { _id: operation.operationId },
        {
          $setOnInsert: {
            _id: operation.operationId,
            version: plan.version,
            directionId: plan.directionId,
            communityId: operation.communityId,
            stationId: operation.stationId,
            playerId: operation.playerId,
            createdAt: nowIso,
            status: "PLANNED",
          },
          $set: {
            tournamentIds: operation.tournamentIds,
            publicationIds: operation.publicationIds,
            updatedAt: nowIso,
          },
        },
        { upsert: true },
      );

      const mutation = buildTimeForFriendsAtomicMembershipMutation(operation, nowIso);
      const updateResult = await db.collection("lk_communities").updateOne(
        mutation.filter,
        mutation.update,
      );

      let status;
      if (updateResult.modifiedCount === 1) {
        const inspection = await inspectAppliedMembership(db, operation);
        status = inspection.identityCount === 1
          && inspection.memberCountConsistent
          && inspection.backfillProvenance
          ? "APPLIED"
          : "READBACK_FAILED";
      } else {
        status = await classifyNoop(db, operation);
        if (status === "ALREADY_MEMBER" && previousLedger) {
          const inspection = await inspectAppliedMembership(db, operation);
          status = classifyExistingMembershipAfterPreviousLedger(previousLedger.status, inspection);
        }
      }
      await ledger.updateOne(
        { _id: operation.operationId },
        {
          $set: {
            status,
            updatedAt: nowIso,
            appliedAt: ["APPLIED", "APPLIED_IDEMPOTENT", "RECOVERED_APPLIED"].includes(status)
              ? (previousLedger?.appliedAt || nowIso)
              : null,
          },
        },
      );
      results.push({ operationId: operation.operationId, status });
    } catch (error) {
      const errorCategory = classifyApplyError(error);
      results.push({ operationId: operation.operationId, status: "FAILED_RETRYABLE", errorCategory });
      try {
        await ledger.updateOne(
          { _id: operation.operationId },
          { $set: { status: "FAILED_RETRYABLE", errorCategory, updatedAt: nowIso } },
          { upsert: false },
        );
      } catch {
        // The local partial report remains authoritative when the database is unavailable.
      }
    }
  }

  const summary = {
    attempted: results.length,
    applied: results.filter((row) => ["APPLIED", "APPLIED_IDEMPOTENT", "RECOVERED_APPLIED"].includes(row.status)).length,
    alreadyMembers: results.filter((row) => ["ALREADY_MEMBER", "CONCURRENT_ALREADY_MEMBER"].includes(row.status)).length,
    failed: results.filter((row) => ![
      "APPLIED", "APPLIED_IDEMPOTENT", "RECOVERED_APPLIED", "ALREADY_MEMBER", "CONCURRENT_ALREADY_MEMBER",
    ].includes(row.status)).length,
    results,
  };
  try {
    await executions.updateOne(
      { _id: executionId },
      { $set: { status: summary.failed > 0 ? "PARTIAL_FAILED" : "COMPLETED", summary, updatedAt: nowIso } },
    );
  } catch {
    summary.executionLedgerStatus = "UPDATE_FAILED";
    summary.failed += 1;
  }
  return summary;
}

async function loadSource(db, scope) {
  const communityIds = scope.communities.map((row) => row.communityId);
  const communities = await db.collection("lk_communities")
    .find({ id: { $in: communityIds } })
    .project({ id: 1, communityId: 1, name: 1, archived: 1, members: 1, pendingMembers: 1, bannedMembers: 1 })
    .toArray();
  const feedPosts = await db.collection("lk_community_feed")
    .find({
      communityId: { $in: communityIds },
      kind: "TOURNAMENT",
    })
    .project({
      id: 1, communityId: 1, kind: 1, archived: 1, relatedTournamentId: 1, tournamentId: 1,
      details: 1,
    })
    .toArray();
  const linkedTournamentIds = Array.from(new Set(feedPosts.flatMap(collectPublicationTournamentIds)));
  const directionVariants = [5278, "5278"];
  const tournamentFilter = {
    $or: [
      { tournamentId: { $in: linkedTournamentIds } },
      { id: { $in: linkedTournamentIds } },
      { exerciseId: { $in: linkedTournamentIds } },
      { "direction.id": { $in: directionVariants } },
      { "params.direction.id": { $in: directionVariants } },
      { "params.directionId": { $in: directionVariants } },
      { "details.direction.id": { $in: directionVariants } },
      { "details.publicTournament.direction.id": { $in: directionVariants } },
      { "details.sourceTournamentSnapshot.direction.id": { $in: directionVariants } },
      { "publicTournament.direction.id": { $in: directionVariants } },
      { "sourceTournamentSnapshot.direction.id": { $in: directionVariants } },
    ],
  };
  const tournaments = await db.collection("tournaments")
    .find(tournamentFilter)
    .project({
      tournamentId: 1, id: 1, exerciseId: 1, sourceTournamentId: 1,
      direction: 1, stationId: 1, studioId: 1, status: 1, state: 1, tournamentStatus: 1,
      params: 1, summary: 1, details: 1, publicTournament: 1, sourceTournamentSnapshot: 1,
      participants: 1, standings: 1, finishedAt: 1, completedAt: 1,
    })
    .toArray();
  return { communities, feedPosts, tournaments };
}

if (hasFlag("--help")) {
  usage();
  process.exit(0);
}

const apply = hasFlag("--apply");
const allowQuarantine = hasFlag("--allow-quarantine");
const mongoUri = getArg("--mongo-uri", process.env.MONGO_URI || process.env.MONGODB_URI);
const dbName = getArg("--db", process.env.MONGO_DB || "games");
const scopePath = getArg("--scope");
const outPath = getArg("--out");
const confirmReportSha = getArg("--confirm-report-sha");
const participantsFile = getArg("--participants-file");
const fetchParticipants = hasFlag("--fetch-participants");
const inventoryFrom = getArg("--inventory-from");
const inventoryTo = getArg("--inventory-to");
const participantBaseUrl = getArg("--participants-base-url", "https://padlhub.su");
const participantDelayMs = Math.max(0, Number(getArg("--participant-delay-ms", "1100")) || 0);
const maxParticipantFetches = Math.max(1, Number(getArg("--max-participant-fetches", "200")) || 200);
const vivaBaseUrl = getArg("--viva-base-url", "https://api.vivacrm.ru");
const tenantKey = getArg("--tenant-key", "iSkq6G");
const vivaTokenEnv = getArg("--viva-token-env", "VIVA_TOKEN");
const vivaToken = process.env[vivaTokenEnv] || process.env.VIVA_AUTH_TOKEN || null;

if (!mongoUri || !scopePath || !outPath) {
  usage();
  process.exit(1);
}
if (apply && !confirmReportSha) {
  throw new Error("--apply requires --confirm-report-sha from a reviewed fresh dry-run report");
}
if (apply && (!inventoryFrom || !inventoryTo)) {
  throw new Error("--apply requires the reviewed --inventory-from/--inventory-to coverage boundary");
}
if (Boolean(inventoryFrom) !== Boolean(inventoryTo)) {
  throw new Error("--inventory-from and --inventory-to must be provided together");
}
if ((inventoryFrom || inventoryTo) && !fetchParticipants) {
  throw new Error("Viva inventory requires --fetch-participants");
}
const scope = validateBackfillScope(readJson(path.resolve(scopePath), "Scope manifest"));
const absoluteOutPath = path.resolve(outPath);
fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });

const { MongoClient } = await import("mongodb");
const client = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
});

try {
  await client.connect();
  const db = client.db(dbName);
  const source = await loadSource(db, scope);
  const inventoryExerciseIds = inventoryFrom && inventoryTo
    ? await fetchVivaInventory({
      from: inventoryFrom,
      to: inventoryTo,
      vivaBaseUrl,
      tenantKey,
      vivaToken,
    })
    : [];
  const participantRosters = participantsFile
    ? readJson(path.resolve(participantsFile), "Participant roster export")
    : fetchParticipants
      ? await fetchParticipantRosters(source.feedPosts, {
        baseUrl: participantBaseUrl,
        delayMs: participantDelayMs,
        maxFetches: maxParticipantFetches,
        vivaBaseUrl,
        tenantKey,
        vivaToken,
      }, inventoryExerciseIds)
      : {};
  const result = buildTimeForFriendsCommunityBackfillPlan({
    scope,
    ...source,
    participantRosters,
    inventoryCoverage: inventoryFrom && inventoryTo ? { from: inventoryFrom, to: inventoryTo } : null,
  });

  if (apply && confirmReportSha !== result.planSha256) {
    throw new Error(`Fresh plan SHA mismatch: expected ${confirmReportSha}, got ${result.planSha256}`);
  }
  if (apply && result.quarantined.length > 0 && !allowQuarantine) {
    throw new Error(`Apply blocked: ${result.quarantined.length} quarantined rows; review or pass --allow-quarantine explicitly`);
  }

  const appliedAt = new Date().toISOString();
  const applyResult = apply ? await applyBackfillPlan(db, result.plan, appliedAt) : null;
  const report = buildRedactedBackfillReport(result, {
    mode: apply ? "apply" : "dry-run",
    generatedAt: appliedAt,
    apply: applyResult,
  });
  fs.writeFileSync(absoluteOutPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(absoluteOutPath, 0o600);
  console.log(JSON.stringify({
    ok: report.ok && (!applyResult || applyResult.failed === 0),
    mode: report.mode,
    report: absoluteOutPath,
    planSha256: report.planSha256,
    summary: report.summary,
    apply: applyResult,
    nextRatingDryRunCommands: report.affectedCommunityIds.map((communityId) => (
      `npm run rating:recalculate -- --community-id ${communityId} --mongo-uri "$MONGODB_URI" --dry-run`
    )),
  }, null, 2));
  if (applyResult?.failed > 0) process.exitCode = 2;
} finally {
  await client.close();
}
