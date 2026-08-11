import assert from "node:assert/strict";
import test from "node:test";
import { extractCommunityRatingFacts } from "../../src/services/community-rating/facts.ts";
import {
  buildRedactedBackfillReport,
  buildTimeForFriendsAtomicMembershipMutation,
  buildTimeForFriendsCommunityBackfillPlan,
  classifyExistingMembershipAfterPreviousLedger,
  collectPublicationTournamentIds,
  hashBackfillPlan,
  shouldTreatExistingMembershipAsApplied,
  validateBackfillScope,
} from "../lib/timeForFriendsCommunityBackfill.mjs";

const STATION_A = "station-a";
const STATION_B = "station-b";
const COMMUNITY_A = "community-a";
const COMMUNITY_A_ALT = "community-a-alt";
const PLAYER_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PLAYER_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const PLAYER_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

function scope(communities = [
  { communityId: COMMUNITY_A, stationId: STATION_A },
]) {
  return {
    version: "reviewed-scope-2026-08-11",
    directionId: 5278,
    communities,
  };
}

function publication(id, tournamentId, communityId = COMMUNITY_A, stationId = null) {
  return {
    id,
    kind: "TOURNAMENT",
    communityId,
    relatedTournamentId: tournamentId,
    archived: false,
    ...(stationId ? { details: { publicTournament: { studio: { id: stationId } } } } : {}),
  };
}

function completedTournament(id, stationId = STATION_A, playerId = PLAYER_1) {
  return {
    tournamentId: id,
    stationId,
    direction: { id: 5278 },
    params: { status: "completed", completedAt: "2026-07-01T20:00:00.000Z" },
    participants: [{ id: playerId, name: "Анна" }],
    standings: [{ id: playerId, name: "Анна", rank: 1 }],
  };
}

function build(overrides = {}) {
  return buildTimeForFriendsCommunityBackfillPlan({
    scope: scope(),
    communities: [{ id: COMMUNITY_A, members: [], bannedMembers: [], archived: false }],
    feedPosts: [publication("post-1", "tournament-1")],
    tournaments: [completedTournament("tournament-1")],
    participantRosters: {},
    ...overrides,
  });
}

test("plans an exact published finalized tournament membership and marks it rating eligible", () => {
  const result = build();

  assert.deepEqual(result.summary, {
    matchedTournaments: 1,
    operations: 1,
    alreadyMembers: 0,
    skippedRosterRows: 0,
    skipped: 0,
    skippedByReason: {},
    quarantined: 0,
    quarantinedByReason: {},
    providerStatusCounts: {},
    affectedCommunities: 1,
    ratingEligibleOperations: 1,
    membershipOnlyOperations: 0,
  });
  assert.equal(result.plan.operations[0].communityId, COMMUNITY_A);
  assert.equal(result.plan.operations[0].playerId, PLAYER_1);
  assert.deepEqual(result.plan.operations[0].ratingEligibleTournamentIds, ["tournament-1"]);
  assert.equal(result.plan.operations[0].directionEvidence, "RECORD_OR_PROVIDER");
});

test("rating-eligible planner output produces a real community tournament fact", () => {
  const result = build();
  const operation = result.plan.operations[0];
  const tournament = completedTournament("tournament-1");
  const post = publication("post-1", "tournament-1");
  const facts = extractCommunityRatingFacts({
    community: { id: COMMUNITY_A, members: [{ id: operation.playerId, name: "Анна" }] },
    feedPosts: [post],
    tournaments: [tournament],
    collectedAt: "2026-08-11T12:00:00.000Z",
  });

  assert.deepEqual(operation.ratingEligibleTournamentIds, ["tournament-1"]);
  assert.equal(facts.filter((fact) => fact.eventType === "tournament").length, 1);

  post.archived = true;
  const archivedPlan = build({ feedPosts: [post] });
  const archivedFacts = extractCommunityRatingFacts({
    community: { id: COMMUNITY_A, members: [{ id: operation.playerId, name: "Анна" }] },
    feedPosts: [post],
    tournaments: [tournament],
    collectedAt: "2026-08-11T12:00:00.000Z",
  });
  assert.equal(archivedPlan.summary.ratingEligibleOperations, 0);
  assert.equal(archivedFacts.length, 0);
});

test("provider inventory exposes unpublished Time-for-Friends exercises as quarantine", () => {
  const exerciseId = "99999999-9999-4999-8999-999999999999";
  const result = build({
    feedPosts: [],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{ spot: 1, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
    inventoryCoverage: { from: "2026-01-01", to: "2026-08-11" },
  });

  assert.equal(result.summary.matchedTournaments, 1);
  assert.equal(result.summary.operations, 0);
  assert.equal(result.quarantined[0].reason, "ELIGIBLE_PUBLICATION_NOT_FOUND");
  assert.deepEqual(result.plan.inventoryCoverage, { from: "2026-01-01", to: "2026-08-11" });

  const resolved = build({
    scope: {
      ...scope(),
      tournamentMappings: [{
        tournamentId: exerciseId,
        communityId: COMMUNITY_A,
        stationId: STATION_A,
      }],
    },
    feedPosts: [],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{ spot: 1, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
  });
  assert.equal(resolved.summary.quarantined, 0);
  assert.equal(resolved.summary.operations, 1);
  assert.equal(resolved.summary.membershipOnlyOperations, 1);
});

test("feed direction cannot substitute missing provider direction proof", () => {
  const exerciseId = "98999999-9999-4999-8999-999999999999";
  const post = publication("post-provider", exerciseId);
  post.direction = { id: 5278 };
  const result = build({
    feedPosts: [post],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{ spot: 1, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
  });
  assert.equal(result.summary.operations, 0);
  assert.equal(result.quarantined[0].reason, "PROVIDER_DIRECTION_ID_NOT_PROVEN");
});

test("quarantines a tournament whose Time-for-Friends direction is not proven", () => {
  const tournament = completedTournament("tournament-1");
  delete tournament.direction;
  const result = build({ tournaments: [tournament] });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.quarantined[0].reason, "DIRECTION_ID_NOT_PROVEN");
});

test("uses archived historical publications and inventories unpublished local TFF tournaments", () => {
  const archived = publication("post-1", "tournament-1");
  archived.archived = true;
  const mapped = build({ feedPosts: [archived] });
  assert.equal(mapped.summary.operations, 1);
  assert.equal(mapped.summary.ratingEligibleOperations, 0);
  assert.equal(mapped.summary.membershipOnlyOperations, 1);

  const unpublished = build({ feedPosts: [] });
  assert.equal(unpublished.summary.matchedTournaments, 1);
  assert.equal(unpublished.summary.operations, 0);
  assert.equal(unpublished.quarantined[0].reason, "ELIGIBLE_PUBLICATION_NOT_FOUND");
});

test("publication resolver returns only the highest-priority canonical tournament id", () => {
  const directExerciseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const post = {
    relatedTournamentId: directExerciseId,
    tournamentId: "lower-priority-root-id",
    details: {
      relatedTournamentId: "lower-priority-details-id",
      publicTournament: {
        exerciseId: "different-nested-exercise-id",
        sourceTournamentId: "different-nested-source-id",
        id: "different-nested-id",
      },
      sourceTournamentSnapshot: {
        exerciseId: "different-source-snapshot-id",
      },
    },
  };

  assert.deepEqual(collectPublicationTournamentIds(post), [directExerciseId]);
});

test("deduplicates the same player across historical tournaments", () => {
  const result = build({
    feedPosts: [
      publication("post-1", "tournament-1"),
      publication("post-2", "tournament-2"),
    ],
    tournaments: [
      completedTournament("tournament-1"),
      completedTournament("tournament-2"),
    ],
  });

  assert.equal(result.summary.operations, 1);
  assert.deepEqual(result.plan.operations[0].tournamentIds, ["tournament-1", "tournament-2"]);
  assert.deepEqual(result.plan.operations[0].publicationIds, ["post-1", "post-2"]);
});

test("resolves a finalized standing through the participant exact client id", () => {
  const tournament = completedTournament("tournament-1");
  tournament.participants = [{ id: "slot-1", clientId: PLAYER_1, name: "Анна" }];
  tournament.standings = [{ id: "slot-1", name: "Анна", rank: 1 }];

  const result = build({ tournaments: [tournament] });

  assert.equal(result.summary.operations, 1);
  assert.equal(result.plan.operations[0].playerId, PLAYER_1);
});

test("fails closed when one tournament is published in two approved level groups", () => {
  const result = build({
    scope: scope([
      { communityId: COMMUNITY_A, stationId: STATION_A },
      { communityId: COMMUNITY_A_ALT, stationId: STATION_A },
    ]),
    communities: [
      { id: COMMUNITY_A, members: [], archived: false },
      { id: COMMUNITY_A_ALT, members: [], archived: false },
    ],
    feedPosts: [
      publication("post-1", "tournament-1", COMMUNITY_A),
      publication("post-2", "tournament-1", COMMUNITY_A_ALT),
    ],
  });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.quarantined[0].reason, "ELIGIBLE_PUBLICATION_AMBIGUOUS");
  assert.deepEqual(result.quarantined[0].communityIds, [COMMUNITY_A, COMMUNITY_A_ALT]);
});

test("uses a proven historical Viva roster only for membership, not rating eligibility", () => {
  const exerciseId = "11111111-1111-4111-8111-111111111111";
  const result = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{
          id: "booking-1",
          spot: 1,
          isCancelled: false,
          client: { id: PLAYER_1, firstName: "Иван", lastName: "Иванов" },
        }],
      },
    },
  });

  assert.equal(result.summary.operations, 1);
  assert.equal(result.summary.membershipOnlyOperations, 1);
  assert.equal(result.summary.ratingEligibleOperations, 0);
  assert.deepEqual(result.plan.operations[0].membershipOnlyTournamentIds, [exerciseId]);
  assert.equal(result.plan.operations[0].directionEvidence, "RECORD_OR_PROVIDER");
});

test("quarantines external roster when active slot or provider direction is not proven", () => {
  const exerciseId = "22222222-2222-4222-8222-222222222222";
  const missingDirection = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{ spot: 1, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
  });
  assert.equal(missingDirection.quarantined[0].reason, "PROVIDER_DIRECTION_ID_NOT_PROVEN");

  const waitlist = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [{ spot: null, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
  });
  assert.equal(waitlist.quarantined[0].reason, "ACTIVE_SPOT_NOT_PROVEN");
});

test("skips provider exercises that are not Time for Friends", () => {
  const exerciseId = "44444444-4444-4444-8444-444444444444";
  const result = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 839,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [],
      },
    },
  });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.summary.quarantined, 0);
  assert.equal(result.summary.skippedByReason.NOT_TIME_FOR_FRIENDS, 1);
  assert.equal(result.skipped[0].providerStatus, "PROVEN_ACTIVE");
});

test("skips a local tournament with one explicit non-Time-for-Friends direction", () => {
  const tournament = {
    ...completedTournament("tournament-1"),
    direction: { id: 5280 },
  };
  const result = build({ tournaments: [tournament] });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.summary.quarantined, 0);
  assert.equal(result.summary.skippedByReason.NOT_TIME_FOR_FRIENDS, 1);
  assert.equal(result.skipped[0].directionId, "5280");
  assert.equal(result.skipped[0].recordSource, "LOCAL_TOURNAMENT");

  const conflict = build({
    tournaments: [{
      ...tournament,
      params: {
        ...tournament.params,
        directionId: 5278,
      },
    }],
  });
  assert.equal(conflict.summary.skipped, 0);
  assert.equal(conflict.summary.quarantinedByReason.DIRECTION_ID_CONFLICT, 1);
});

test("skips future exercises and proven empty active rosters", () => {
  const futureExerciseId = "55555555-5555-4555-8555-555555555555";
  const emptyExerciseId = "66666666-6666-4666-8666-666666666666";
  const participantRosters = {
    [futureExerciseId]: {
      sourceStatus: "PROVEN_ACTIVE",
      metadataStatus: "OK",
      directionId: 5278,
      stationId: STATION_A,
      capacity: 8,
      exerciseEnded: false,
      participants: [{ spot: 1, isCancelled: false, client: { id: "future-player" } }],
    },
    [emptyExerciseId]: {
      sourceStatus: "PROVEN_ACTIVE",
      metadataStatus: "OK",
      directionId: 5278,
      stationId: STATION_A,
      capacity: 8,
      exerciseEnded: true,
      participants: [],
    },
  };
  const result = build({
    feedPosts: [
      publication("post-future", futureExerciseId, COMMUNITY_A, STATION_A),
      publication("post-empty", emptyExerciseId, COMMUNITY_A, STATION_A),
    ],
    tournaments: [],
    participantRosters,
  });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.summary.quarantined, 0);
  assert.equal(result.summary.skippedByReason.EXERCISE_NOT_ENDED, 1);
  assert.equal(result.summary.skippedByReason.NO_ACTIVE_PARTICIPANTS, 1);
  assert.deepEqual(result.summary.providerStatusCounts, { PROVEN_ACTIVE: 2 });
});

test("keeps provider failures quarantined with source status and error detail", () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const result = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "HTTP_503",
        metadataStatus: "OK",
        error: "PARTICIPANTS_HTTP_ERROR",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [],
      },
    },
  });

  assert.equal(result.summary.operations, 0);
  assert.equal(result.summary.quarantinedByReason.PARTICIPATION_SOURCE_NOT_PROVEN, 1);
  assert.deepEqual(result.summary.providerStatusCounts, { HTTP_503: 1 });
  assert.equal(result.quarantined[0].providerStatus, "HTTP_503");
  assert.equal(result.quarantined[0].providerError, "PARTICIPANTS_HTTP_ERROR");

  const unsafeDiagnostic = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "HTTP_503 token=secret",
        metadataStatus: "OK",
        error: "request failed with bearer secret",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [],
      },
    },
  });
  const report = buildRedactedBackfillReport(unsafeDiagnostic);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  assert.equal(unsafeDiagnostic.quarantined[0].providerStatus, "REDACTED_DIAGNOSTIC");
  assert.equal(unsafeDiagnostic.quarantined[0].providerError, "REDACTED_DIAGNOSTIC");
});

test("requires proven capacity and excludes waitlist rows without dropping safe active players", () => {
  const exerciseId = "33333333-3333-4333-8333-333333333333";
  const withoutCapacity = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        exerciseEnded: true,
        participants: [{ spot: 1, isCancelled: false, client: { id: PLAYER_1 } }],
      },
    },
  });
  assert.equal(withoutCapacity.quarantined[0].reason, "CAPACITY_NOT_PROVEN");
  assert.equal(withoutCapacity.summary.operations, 0);

  const mixedRoster = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [
          { spot: 1, isCancelled: false, client: { id: PLAYER_1 } },
          { spot: 2, isCancelled: false, client: { id: PLAYER_2 } },
          { spot: 9, isCancelled: false, client: { id: PLAYER_3 } },
        ],
      },
    },
  });
  assert.equal(mixedRoster.summary.operations, 2);
  assert.equal(mixedRoster.summary.quarantined, 0);
  assert.equal(mixedRoster.summary.skippedRosterRows, 1);
  assert.equal(mixedRoster.skipped.length, 1);
  assert.equal(mixedRoster.skipped[0].reason, "WAITLIST_OUTSIDE_CAPACITY");
  assert.equal(mixedRoster.skipped[0].spot, 9);
});

test("excludes cancelled roster rows without dropping a proven active player", () => {
  const exerciseId = "88888888-8888-4888-8888-888888888888";
  const result = build({
    feedPosts: [publication("post-viva", exerciseId, COMMUNITY_A, STATION_A)],
    tournaments: [],
    participantRosters: {
      [exerciseId]: {
        sourceStatus: "PROVEN_ACTIVE",
        metadataStatus: "OK",
        directionId: 5278,
        stationId: STATION_A,
        capacity: 8,
        exerciseEnded: true,
        participants: [
          { spot: 1, isCancelled: false, client: { id: PLAYER_1 } },
          { spot: 2, isCancelled: true, client: { id: PLAYER_2 } },
          { spot: 3, isCancelled: false, status: "cancelled", client: { id: PLAYER_3 } },
        ],
      },
    },
  });

  assert.equal(result.summary.operations, 1);
  assert.equal(result.plan.operations[0].playerId, PLAYER_1);
  assert.equal(result.summary.skippedByReason.CANCELLED_ROSTER_ROW, 2);
  assert.equal(result.summary.quarantined, 0);
});

test("quarantines station mismatch, banned players, and missing exact player IDs", () => {
  const stationMismatch = build({ tournaments: [completedTournament("tournament-1", STATION_B)] });
  assert.equal(stationMismatch.quarantined[0].reason, "ELIGIBLE_PUBLICATION_NOT_FOUND");

  const banned = build({
    communities: [{ id: COMMUNITY_A, members: [], bannedMembers: [{ id: PLAYER_1 }] }],
  });
  assert.equal(banned.quarantined[0].reason, "PLAYER_BANNED");

  const missingId = build({
    tournaments: [completedTournament("tournament-1", STATION_A, "manual-participant-1")],
  });
  assert.equal(missingId.quarantined[0].reason, "PLAYER_CLIENT_ID_MISSING");
});

test("skips exact existing members without producing a write operation", () => {
  const result = build({
    communities: [{ id: COMMUNITY_A, members: [{ id: PLAYER_1 }], bannedMembers: [] }],
  });
  assert.equal(result.summary.operations, 0);
  assert.equal(result.summary.alreadyMembers, 1);
  assert.equal(result.skipped[0].reason, "ALREADY_MEMBER");
});

test("matches community bans by normalized phone and blocks unresolved phone-only identity", () => {
  const tournament = completedTournament("tournament-1");
  tournament.participants[0].phone = "+7 (999) 111-22-33";
  const phoneBan = build({
    tournaments: [tournament],
    communities: [{
      id: COMMUNITY_A,
      members: [],
      bannedMembers: [{ phoneNorm: "79991112233" }],
      archived: false,
    }],
  });
  assert.equal(phoneBan.summary.operations, 0);
  assert.equal(phoneBan.quarantined[0].reason, "PLAYER_BANNED");

  delete tournament.participants[0].phone;
  const unresolved = build({
    tournaments: [tournament],
    communities: [{
      id: COMMUNITY_A,
      members: [{ phone: "+7 999 111-22-33" }],
      bannedMembers: [],
      archived: false,
    }],
  });
  assert.equal(unresolved.summary.operations, 0);
  assert.equal(unresolved.quarantined[0].reason, "COMMUNITY_LEGACY_IDENTITY_UNRESOLVED");
});

test("only a previously applied ledger row makes an existing member idempotently applied", () => {
  assert.equal(shouldTreatExistingMembershipAsApplied("APPLIED"), true);
  assert.equal(shouldTreatExistingMembershipAsApplied("APPLIED_IDEMPOTENT"), true);
  assert.equal(shouldTreatExistingMembershipAsApplied("ALREADY_MEMBER"), false);
  assert.equal(shouldTreatExistingMembershipAsApplied("PLANNED"), false);
  assert.equal(shouldTreatExistingMembershipAsApplied(null), false);

  const verifiedBackfill = {
    identityCount: 1,
    memberCountConsistent: true,
    backfillProvenance: true,
  };
  assert.equal(
    classifyExistingMembershipAfterPreviousLedger("READBACK_FAILED", verifiedBackfill),
    "RECOVERED_APPLIED",
  );
  assert.equal(
    classifyExistingMembershipAfterPreviousLedger("READBACK_FAILED", {
      ...verifiedBackfill,
      memberCountConsistent: false,
    }),
    "READBACK_FAILED",
  );
  assert.equal(
    classifyExistingMembershipAfterPreviousLedger("PLANNED", {
      ...verifiedBackfill,
      backfillProvenance: false,
    }),
    "CONCURRENT_ALREADY_MEMBER",
  );
});

test("plan hash is deterministic and report redacts player ids", () => {
  const first = build();
  const second = build();
  assert.equal(first.planSha256, second.planSha256);
  assert.equal(hashBackfillPlan(first.plan), first.planSha256);

  const report = buildRedactedBackfillReport(first, { generatedAt: "2026-08-11T00:00:00.000Z" });
  assert.match(report.operations[0].playerRef, /^player:[0-9a-f]{16}$/);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(PLAYER_1));
});

test("atomic mutation guards exact membership and ban identities and normalizes memberCount", () => {
  const operation = build().plan.operations[0];
  const mutation = buildTimeForFriendsAtomicMembershipMutation(
    operation,
    "2026-08-11T12:00:00.000Z",
  );

  assert.equal(mutation.filter.id, COMMUNITY_A);
  assert.deepEqual(mutation.filter.members.$not.$elemMatch.$or, [
    { id: PLAYER_1 },
    { clientId: PLAYER_1 },
    { playerId: PLAYER_1 },
    { userId: PLAYER_1 },
  ]);
  assert.deepEqual(
    mutation.filter.bannedMembers.$not.$elemMatch.$or,
    mutation.filter.members.$not.$elemMatch.$or,
  );
  assert.deepEqual(mutation.update[0].$set.memberCount, {
    $add: [{ $size: { $cond: [{ $isArray: "$members" }, "$members", []] } }, 1],
  });
  assert.equal(
    mutation.update[0].$set.members.$concatArrays[1][0].joinSource.tournamentIds[0],
    "tournament-1",
  );

  const withPhone = buildTimeForFriendsAtomicMembershipMutation(
    { ...operation, phoneNorm: "+7 (999) 111-22-33" },
    "2026-08-11T12:00:00.000Z",
  );
  assert.deepEqual(withPhone.filter.members.$not.$elemMatch.$or.slice(-4), [
    { phoneNorm: "79991112233" },
    { phone: "79991112233" },
    { phoneNumber: "79991112233" },
    { mobile: "79991112233" },
  ]);
});

test("scope requires exact unique community and station ids", () => {
  assert.throws(() => validateBackfillScope({ directionId: 5278, communities: [] }), /at least one/);
  assert.throws(() => validateBackfillScope({
    directionId: 5278,
    communities: [
      { communityId: COMMUNITY_A, stationId: STATION_A },
      { communityId: COMMUNITY_A, stationId: STATION_B },
    ],
  }), /duplicate communityId/);
  assert.throws(() => validateBackfillScope({
    directionId: 839,
    communities: [{ communityId: COMMUNITY_A, stationId: STATION_A }],
  }), /5278/);
  assert.throws(() => validateBackfillScope({
    ...scope(),
    tournamentMappings: [{
      tournamentId: "tournament-1",
      communityId: COMMUNITY_A,
      stationId: STATION_B,
    }],
  }), /approved exact community\/station pair/);
  assert.throws(() => validateBackfillScope({
    ...scope(),
    tournamentMappings: [
      { tournamentId: "tournament-1", communityId: COMMUNITY_A, stationId: STATION_A },
      { tournamentId: "tournament-1", communityId: COMMUNITY_A, stationId: STATION_A },
    ],
  }), /duplicate tournamentMappings/);
});
