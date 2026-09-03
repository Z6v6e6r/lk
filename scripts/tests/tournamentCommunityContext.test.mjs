import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  buildTimeForFriendsAutoEnrollmentMutation,
  planTimeForFriendsAutoEnrollment,
  resolveTournamentCommunityContext,
} from "../lib/tournamentCommunityContext.mjs";
import {
  processTimeForFriendsAutoEnrollments,
  resolveIncrementalCommunityIds,
} from "../rating_worker.mjs";

const PLAYER_ID = "11111111-1111-4111-8111-111111111111";
const COMMUNITY_A = "community-tff-a";
const COMMUNITY_B = "community-tff-b";
const STATION_ID = "station-a";

function post(communityId, role = null) {
  return {
    id: `post-${communityId}`,
    communityId,
    kind: "TOURNAMENT",
    archived: false,
    relatedTournamentId: "tournament-1",
    member: { id: "organizer-1" },
    details: {
      publicationRole: role,
      publicTournament: {
        exerciseId: "tournament-1",
        direction: { id: 5278 },
        studio: { id: STATION_ID },
      },
    },
  };
}

function tournament(overrides = {}) {
  return {
    tournamentId: "tournament-1",
    createdAt: "2026-08-11T11:00:00.000Z",
    organizer: { id: "organizer-1" },
    params: { directionId: 5278, stationId: STATION_ID, maxParticipants: 8, organizerId: "organizer-1" },
    participants: [{ clientId: PLAYER_ID, name: "Игрок", spot: 1, isCancelled: false }],
    ...overrides,
  };
}

function community(id) {
  return {
    id,
    archived: false,
    members: [],
    bannedMembers: [],
    ratingProgram: {
      programKey: "TIME_FOR_FRIENDS",
      stationId: STATION_ID,
      autoEnrollmentEnabled: true,
      validatedPublications: [{
        publicationId: `post-${id}`,
        tournamentId: "tournament-1",
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
}

test("single active tournament publication becomes the rating community", () => {
  const result = resolveTournamentCommunityContext({ tournament: tournament(), feedPosts: [post(COMMUNITY_A)] });
  assert.equal(result.ratingCommunityId, COMMUNITY_A);
  assert.equal(result.ratingCommunityStatus, "RESOLVED");
  assert.deepEqual(result.publishedCommunities.map((row) => row.communityId), [COMMUNITY_A]);
});

test("multiple publications fail closed unless one is explicitly RATING_PRIMARY", () => {
  const ambiguous = resolveTournamentCommunityContext({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A), post(COMMUNITY_B)],
  });
  assert.equal(ambiguous.ratingCommunityId, null);
  assert.equal(ambiguous.ratingCommunityStatus, "AMBIGUOUS");

  const resolved = resolveTournamentCommunityContext({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A, "RATING_PRIMARY"), post(COMMUNITY_B)],
  });
  assert.equal(resolved.ratingCommunityId, COMMUNITY_A);
});

test("TFF planner creates an exact-id enrollment for the published community", () => {
  const result = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.equal(result.quarantined.length, 0);
  assert.equal(result.operations.length, 1);
  assert.equal(result.operations[0].communityId, COMMUNITY_A);
  assert.equal(result.operations[0].playerId, PLAYER_ID);
  assert.equal(result.operations[0].joinSourceType, "TIME_FOR_FRIENDS_TOURNAMENT_AUTO_ENROLLMENT");
});

test("provider-verified roster links a custom tournament through its Viva source id", () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    details: {
      tournamentId: "custom-local-id",
      publicTournament: { exerciseId },
    },
  };
  const approvedCommunity = {
    ...community(COMMUNITY_A),
    ratingProgram: {
      ...community(COMMUNITY_A).ratingProgram,
      validatedPublications: [{
        publicationId: publication.id,
        tournamentId: exerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const result = planTimeForFriendsAutoEnrollment({
    tournament: {
      id: "custom-local-id",
      tournamentId: "custom-local-id",
      sourceTournamentId: exerciseId,
      source: "CUSTOM",
      participants: [],
    },
    feedPosts: [publication],
    communities: [approvedCommunity],
    providerEnrollment: {
      exerciseId,
      directionId: "5278",
      stationId: STATION_ID,
      maxParticipants: 8,
      participants: [{ clientId: PLAYER_ID, name: "Игрок", spot: 4, isCancelled: false }],
    },
  });
  assert.equal(result.context.tournamentId, exerciseId);
  assert.equal(result.quarantined.length, 0);
  assert.deepEqual(result.operations.map((row) => row.playerId), [PLAYER_ID]);
});

test("provider roster cannot bypass server-owned publication approval", () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    details: {
      tournamentId: "custom-local-id",
      publicTournament: { exerciseId },
    },
  };
  const result = planTimeForFriendsAutoEnrollment({
    tournament: { id: "custom-local-id", sourceTournamentId: exerciseId, source: "CUSTOM" },
    feedPosts: [publication],
    communities: [{
      ...community(COMMUNITY_A),
      ratingProgram: { ...community(COMMUNITY_A).ratingProgram, validatedPublications: [] },
    }],
    providerEnrollment: {
      exerciseId,
      directionId: "5278",
      stationId: STATION_ID,
      maxParticipants: 8,
      participants: [{ clientId: PLAYER_ID, name: "Игрок", spot: 4, isCancelled: false }],
    },
  });
  assert.equal(result.operations.length, 0);
  assert.equal(result.quarantined[0].reason, "STATION_ID_NOT_PROVEN");
});

test("provider metadata cannot override conflicting persisted direction or station", () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    details: { publicTournament: { exerciseId } },
  };
  const approvedCommunity = {
    ...community(COMMUNITY_A),
    ratingProgram: {
      ...community(COMMUNITY_A).ratingProgram,
      validatedPublications: [{
        publicationId: publication.id,
        tournamentId: exerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const providerEnrollment = {
    exerciseId,
    directionId: "5278",
    stationId: STATION_ID,
    maxParticipants: 8,
    participants: [{ clientId: PLAYER_ID, name: "Игрок", spot: 4, isCancelled: false }],
  };
  const directionConflict = planTimeForFriendsAutoEnrollment({
    tournament: {
      source: "CUSTOM",
      sourceTournamentId: exerciseId,
      params: { directionId: 5280, stationId: STATION_ID },
    },
    feedPosts: [publication],
    communities: [approvedCommunity],
    providerEnrollment,
  });
  assert.equal(directionConflict.operations.length, 0);
  assert.equal(directionConflict.quarantined[0].reason, "DIRECTION_ID_CONFLICT");

  const stationConflict = planTimeForFriendsAutoEnrollment({
    tournament: {
      source: "CUSTOM",
      sourceTournamentId: exerciseId,
      params: { directionId: 5278, stationId: "station-b" },
    },
    feedPosts: [publication],
    communities: [approvedCommunity],
    providerEnrollment,
  });
  assert.equal(stationConflict.operations.length, 0);
  assert.equal(stationConflict.quarantined[0].reason, "STATION_ID_CONFLICT");
});

test("feed identity cannot substitute missing server-owned publication approval", () => {
  const forged = { ...post(COMMUNITY_A), member: { id: "organizer-1" } };
  const result = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [forged],
    communities: [{
      ...community(COMMUNITY_A),
      ratingProgram: {
        ...community(COMMUNITY_A).ratingProgram,
        validatedPublications: [],
      },
    }],
  });
  assert.equal(result.operations.length, 0);
  assert.equal(result.quarantined[0].reason, "PUBLICATION_SERVER_APPROVAL_NOT_PROVEN");
});

test("TFF planner rejects direction conflicts and ambiguous publications", () => {
  const directionConflict = planTimeForFriendsAutoEnrollment({
    tournament: tournament({ params: { directionId: 5280, stationId: STATION_ID } }),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.equal(directionConflict.operations.length, 0);
  assert.equal(directionConflict.quarantined[0].reason, "DIRECTION_ID_CONFLICT");

  const ambiguous = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A), post(COMMUNITY_B)],
    communities: [community(COMMUNITY_A), community(COMMUNITY_B)],
  });
  assert.equal(ambiguous.operations.length, 0);
  assert.equal(ambiguous.quarantined[0].reason, "ELIGIBLE_PUBLICATION_AMBIGUOUS");
});

test("atomic auto-enrollment keeps exact id guards and records auto source", () => {
  const result = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  const mutation = buildTimeForFriendsAutoEnrollmentMutation(result.operations[0], "2026-08-11T12:00:00.000Z");
  assert.equal(mutation.filter.id, COMMUNITY_A);
  assert.deepEqual(mutation.filter.archived, { $ne: true });
  const member = mutation.update[0].$set.members.$concatArrays[1].$literal[0];
  assert.equal(member.id, PLAYER_ID);
  assert.equal(member.joinSource.type, "TIME_FOR_FRIENDS_TOURNAMENT_AUTO_ENROLLMENT");
});

test("banned and unresolved phone-only identities never produce writes", () => {
  const banned = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A)],
    communities: [{ ...community(COMMUNITY_A), bannedMembers: [{ id: PLAYER_ID }] }],
  });
  assert.equal(banned.operations.length, 0);
  assert.equal(banned.quarantined[0].reason, "PLAYER_BANNED");

  const unresolved = planTimeForFriendsAutoEnrollment({
    tournament: tournament(),
    feedPosts: [post(COMMUNITY_A)],
    communities: [{ ...community(COMMUNITY_A), members: [{ phone: "+7 999 000-00-00" }] }],
  });
  assert.equal(unresolved.operations.length, 0);
  assert.equal(unresolved.quarantined[0].reason, "COMMUNITY_LEGACY_IDENTITY_UNRESOLVED");
});

test("cancelled and proven waitlist participants are not auto-enrolled", () => {
  const waitlistId = "22222222-2222-4222-8222-222222222222";
  const cancelledId = "33333333-3333-4333-8333-333333333333";
  const result = planTimeForFriendsAutoEnrollment({
    tournament: tournament({
      params: { directionId: 5278, stationId: STATION_ID, maxParticipants: 1 },
      participants: [
        { clientId: PLAYER_ID, name: "Активный", spot: 1, isCancelled: false },
        { clientId: waitlistId, name: "Лист ожидания", spot: 2, isCancelled: false },
        { clientId: cancelledId, name: "Отменён", spot: 1, isCancelled: true },
      ],
    }),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.deepEqual(result.operations.map((row) => row.playerId), [PLAYER_ID]);
});

test("missing active proof and provisional standings never auto-enroll", () => {
  const provisionalId = "44444444-4444-4444-8444-444444444444";
  const missingSpot = planTimeForFriendsAutoEnrollment({
    tournament: tournament({
      participants: [{ clientId: PLAYER_ID, isCancelled: false }],
    }),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.equal(missingSpot.operations.length, 0);
  assert.equal(missingSpot.quarantined[0].reason, "ACTIVE_SPOT_NOT_PROVEN");

  const provisional = planTimeForFriendsAutoEnrollment({
    tournament: tournament({
      participants: [],
      standings: [{ clientId: provisionalId, rank: 1 }],
    }),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.equal(provisional.operations.length, 0);
});

test("cancelled or waitlisted roster identities cannot re-enter through stale standings", () => {
  const cancelledId = "55555555-5555-4555-8555-555555555555";
  const waitlistId = "66666666-6666-4666-8666-666666666666";
  const result = planTimeForFriendsAutoEnrollment({
    tournament: tournament({
      params: {
        directionId: 5278,
        stationId: STATION_ID,
        maxParticipants: 1,
        status: "completed",
      },
      participants: [
        { clientId: cancelledId, spot: 1, isCancelled: true },
        { clientId: waitlistId, spot: 2, isCancelled: false },
      ],
      standings: [
        { clientId: cancelledId, rank: 1 },
        { clientId: waitlistId, rank: 2 },
      ],
    }),
    feedPosts: [post(COMMUNITY_A)],
    communities: [community(COMMUNITY_A)],
  });
  assert.equal(result.operations.length, 0);
  assert.deepEqual(result.skipped.map((row) => row.reason).sort(), [
    "CANCELLED_ROSTER_ROW",
    "WAITLIST_OUTSIDE_CAPACITY",
  ]);
});

function workerDbFixture({ matchedCount = 1, currentCommunity = null, previousAudit = null } = {}) {
  const writes = { communities: [], ledger: [] };
  const tournamentRow = tournament({ updatedAt: "2026-08-11T11:00:00.000Z" });
  const feedRow = post(COMMUNITY_A);
  const communityRow = community(COMMUNITY_A);
  const findRows = {
    tournaments: [tournamentRow],
    lk_community_feed: [feedRow],
    lk_communities: [communityRow],
  };
  return {
    writes,
    db: {
      collection(name) {
        return {
          find() {
            return { toArray: async () => structuredClone(findRows[name] || []) };
          },
          async findOne() {
            if (name === "lk_tournament_community_enrollments") return structuredClone(previousAudit);
            if (name === "lk_communities" && currentCommunity) return structuredClone(currentCommunity);
            return structuredClone(findRows[name]?.[0] || null);
          },
          async updateOne(filter, update, options) {
            if (name === "lk_communities") {
              writes.communities.push({ filter, update, options });
              return { acknowledged: true, matchedCount, modifiedCount: matchedCount };
            }
            if (name === "lk_tournament_community_enrollments") {
              writes.ledger.push({ filter, update, options });
              return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
            }
            throw new Error(`Unexpected update collection ${name}`);
          },
        };
      },
    },
  };
}

test("rating worker dry-run plans TFF enrollment without database writes", async () => {
  const fixture = workerDbFixture();
  const result = await processTimeForFriendsAutoEnrollments(fixture.db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: true,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(result.planned, 1);
  assert.deepEqual(result.affectedCommunityIds, [COMMUNITY_A]);
  assert.equal(fixture.writes.communities.length, 0);
  assert.equal(fixture.writes.ledger.length, 0);
});

test("rating worker discovers a custom tournament by sourceTournamentId and loads provider roster", async () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    updatedAt: "2026-08-11T11:30:00.000Z",
    details: { publicTournament: { exerciseId } },
  };
  const customTournament = {
    id: "custom-local-id",
    tournamentId: "custom-local-id",
    sourceTournamentId: exerciseId,
    source: "CUSTOM",
    createdAt: "2026-08-11T11:00:00.000Z",
    participants: [],
  };
  const approvedCommunity = {
    ...community(COMMUNITY_A),
    ratingProgram: {
      ...community(COMMUNITY_A).ratingProgram,
      validatedPublications: [{
        publicationId: publication.id,
        tournamentId: exerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const queries = [];
  const blockedExerciseId = "66666666-6666-4666-8666-666666666666";
  const blockedPublication = {
    id: `post-${COMMUNITY_B}`,
    communityId: COMMUNITY_B,
    kind: "TOURNAMENT",
    archived: false,
    updatedAt: "2026-08-11T11:20:00.000Z",
    details: { publicTournament: { exerciseId: blockedExerciseId } },
  };
  const blockedCommunity = {
    ...community(COMMUNITY_B),
    ratingProgram: {
      ...community(COMMUNITY_B).ratingProgram,
      validatedPublications: [{
        publicationId: blockedPublication.id,
        tournamentId: blockedExerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const rows = {
    tournaments: [{
      id: "aaa-custom-local-id",
      tournamentId: "aaa-custom-local-id",
      sourceTournamentId: blockedExerciseId,
      source: "CUSTOM",
      createdAt: "2026-08-11T10:30:00.000Z",
      params: { directionId: 839, stationId: STATION_ID, maxParticipants: 8 },
      participants: [],
    }, customTournament],
    lk_community_feed: [blockedPublication, publication],
    lk_communities: [blockedCommunity, approvedCommunity],
  };
  const db = {
    collection(name) {
      return {
        find(query) {
          queries.push({ name, query });
          return { toArray: async () => structuredClone(rows[name] || []) };
        },
      };
    },
  };
  const loadedTournamentIds = [];
  const result = await processTimeForFriendsAutoEnrollments(db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: true,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
    providerRosterEnabled: true,
    providerRosterMaxFetches: 1,
    providerRosterLoader: async ({ tournamentId }) => {
      loadedTournamentIds.push(tournamentId);
      return {
        exerciseId: tournamentId,
        directionId: "5278",
        stationId: STATION_ID,
        maxParticipants: 8,
        participants: [{ clientId: PLAYER_ID, name: "Игрок", spot: 4, isCancelled: false }],
      };
    },
  });
  assert.equal(result.planned, 1);
  assert.deepEqual(result.providerRoster, {
    enabled: true,
    attempted: 1,
    loaded: 1,
    failed: 0,
    failuresByReason: {},
  });
  assert.deepEqual(loadedTournamentIds, [exerciseId]);
  const tournamentQuery = queries.find((row) => row.name === "tournaments")?.query;
  assert.ok(tournamentQuery.$or.some((row) => row.sourceTournamentId));
});

test("provider roster read failures stay visible on the tournament quarantine", async () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    updatedAt: "2026-08-11T11:30:00.000Z",
    details: { publicTournament: { exerciseId } },
  };
  const approvedCommunity = {
    ...community(COMMUNITY_A),
    ratingProgram: {
      ...community(COMMUNITY_A).ratingProgram,
      validatedPublications: [{
        publicationId: publication.id,
        tournamentId: exerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const rows = {
    tournaments: [{
      id: "custom-local-id",
      tournamentId: "custom-local-id",
      sourceTournamentId: exerciseId,
      source: "CUSTOM",
      createdAt: "2026-08-11T11:00:00.000Z",
      status: "completed",
      params: { directionId: 5278, stationId: STATION_ID, maxParticipants: 8 },
      participants: [],
      standings: [{ clientId: PLAYER_ID, rank: 1 }],
    }],
    lk_community_feed: [publication],
    lk_communities: [approvedCommunity],
  };
  const db = {
    collection(name) {
      return {
        find() {
          return { toArray: async () => structuredClone(rows[name] || []) };
        },
      };
    },
  };
  const result = await processTimeForFriendsAutoEnrollments(db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: true,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
    providerRosterEnabled: true,
    providerRosterLoader: async () => {
      const error = new Error("provider unavailable");
      error.code = "PROVIDER_PARTICIPANTS_READ_FAILED";
      throw error;
    },
  });
  assert.equal(result.planned, 0);
  assert.deepEqual(result.providerRoster, {
    enabled: true,
    attempted: 1,
    loaded: 0,
    failed: 1,
    failuresByReason: { PROVIDER_PARTICIPANTS_READ_FAILED: 1 },
  });
  assert.equal(result.quarantinedByReason.PROVIDER_PARTICIPANTS_READ_FAILED, 1);
});

test("provider roster fetch cap blocks local standings fallback", async () => {
  const exerciseId = "77777777-7777-4777-8777-777777777777";
  const publication = {
    id: `post-${COMMUNITY_A}`,
    communityId: COMMUNITY_A,
    kind: "TOURNAMENT",
    archived: false,
    updatedAt: "2026-08-11T11:30:00.000Z",
    details: { publicTournament: { exerciseId } },
  };
  const approvedCommunity = {
    ...community(COMMUNITY_A),
    ratingProgram: {
      ...community(COMMUNITY_A).ratingProgram,
      validatedPublications: [{
        publicationId: publication.id,
        tournamentId: exerciseId,
        stationId: STATION_ID,
        status: "VALIDATED",
      }],
    },
  };
  const rows = {
    tournaments: [{
      id: "custom-local-id",
      tournamentId: "custom-local-id",
      sourceTournamentId: exerciseId,
      source: "CUSTOM",
      createdAt: "2026-08-11T11:00:00.000Z",
      status: "completed",
      params: { directionId: 5278, stationId: STATION_ID, maxParticipants: 8 },
      participants: [],
      standings: [{ clientId: PLAYER_ID, rank: 1 }],
    }],
    lk_community_feed: [publication],
    lk_communities: [approvedCommunity],
  };
  let providerCalls = 0;
  const db = {
    collection(name) {
      return {
        find() {
          return { toArray: async () => structuredClone(rows[name] || []) };
        },
      };
    },
  };
  const result = await processTimeForFriendsAutoEnrollments(db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: true,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
    providerRosterEnabled: true,
    providerRosterMaxFetches: 0,
    providerRosterLoader: async () => {
      providerCalls += 1;
      return null;
    },
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.planned, 0);
  assert.equal(result.quarantinedByReason.PROVIDER_ROSTER_FETCH_CAP_EXCEEDED, 1);
});

test("rating worker apply writes one guarded membership and one audit row", async () => {
  const fixture = workerDbFixture();
  const result = await processTimeForFriendsAutoEnrollments(fixture.db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: false,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(result.applied, 1);
  assert.equal(fixture.writes.communities.length, 1);
  assert.equal(fixture.writes.ledger.length, 2);
  assert.equal(fixture.writes.ledger[0].update.$setOnInsert.source, "TIME_FOR_FRIENDS_TOURNAMENT_AUTO_ENROLLMENT");
  assert.equal(fixture.writes.ledger[1].update.$set.status, "APPLIED");
});

test("runtime enrollment is default-off without an explicit cutover", async () => {
  const fixture = workerDbFixture();
  const result = await processTimeForFriendsAutoEnrollments(fixture.db, {
    sinceIso: "2020-01-01T00:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: false,
  });
  assert.equal(result.enabled, false);
  assert.equal(result.scanned, 0);
  assert.equal(fixture.writes.communities.length, 0);
  assert.equal(fixture.writes.ledger.length, 0);
});

test("a newly changed publication cannot turn an old tournament into runtime backfill", async () => {
  const fixture = workerDbFixture();
  const originalCollection = fixture.db.collection.bind(fixture.db);
  fixture.db.collection = (name) => {
    const collection = originalCollection(name);
    if (name !== "tournaments") return collection;
    return {
      ...collection,
      find() {
        return {
          toArray: async () => [tournament({ createdAt: "2026-08-10T23:59:59.000Z" })],
        };
      },
    };
  };
  const result = await processTimeForFriendsAutoEnrollments(fixture.db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: false,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(result.planned, 0);
  assert.equal(result.skippedBeforeCutover, 1);
  assert.equal(fixture.writes.communities.length, 0);
});

test("no-match is read back as an exact existing member instead of assumed success", async () => {
  const fixture = workerDbFixture({
    matchedCount: 0,
    currentCommunity: { ...community(COMMUNITY_A), members: [{ id: PLAYER_ID }] },
  });
  const result = await processTimeForFriendsAutoEnrollments(fixture.db, {
    sinceIso: "2026-08-11T10:00:00.000Z",
    nowIso: "2026-08-11T12:00:00.000Z",
    dryRun: false,
    enabled: true,
    cutoverIso: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(result.applied, 0);
  assert.equal(result.alreadyMembers, 1);
  assert.equal(fixture.writes.ledger.at(-1).update.$set.status, "ALREADY_MEMBER");
});

test("no-match ban is audited and fails the worker without advancing as success", async () => {
  const fixture = workerDbFixture({
    matchedCount: 0,
    currentCommunity: { ...community(COMMUNITY_A), bannedMembers: [{ id: PLAYER_ID }] },
  });
  await assert.rejects(
    processTimeForFriendsAutoEnrollments(fixture.db, {
      sinceIso: "2026-08-11T10:00:00.000Z",
      nowIso: "2026-08-11T12:00:00.000Z",
      dryRun: false,
      enabled: true,
      cutoverIso: "2026-08-11T00:00:00.000Z",
    }),
    /failed safe: PLAYER_BANNED/,
  );
  assert.equal(fixture.writes.ledger.at(-1).update.$set.status, "PLAYER_BANNED");
});

test("rating worker runs TFF enrollment before community recalculation", () => {
  const source = fs.readFileSync("scripts/rating_worker.mjs", "utf8");
  const enrollmentIndex = source.indexOf("const timeForFriendsEnrollment = await processTimeForFriendsAutoEnrollments");
  const recalculationIndex = source.indexOf("const community = await recalculateCommunities");

  assert.notEqual(enrollmentIndex, -1);
  assert.notEqual(recalculationIndex, -1);
  assert.ok(enrollmentIndex < recalculationIndex);
  assert.match(source.slice(enrollmentIndex, recalculationIndex), /affectedCommunityIds\.forEach/);
});

test("tournament mechanics visibly renders publication communities and ambiguity", () => {
  const source = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  assert.match(source, /aria-label="Сообщества публикации"/);
  assert.match(source, /publication\.communityName \|\| publication\.communityId/);
  assert.match(source, /Нужно выбрать рейтинговое сообщество/);
});

test("incremental rating resolution follows nested legacy tournament publications", async () => {
  const calls = [];
  const rows = {
    lk_communities: [],
    lk_community_feed: [],
    lk_games: [],
    tournaments: [{ exerciseId: "tournament-legacy" }],
    lk_training_visits: [],
    player_rating_state: [],
    player_rating_events: [],
  };
  const db = {
    collection(name) {
      return {
        find(query, options) {
          calls.push({ name, query, options });
          if (name === "lk_community_feed" && query.archived) {
            return { toArray: async () => [{ communityId: COMMUNITY_A }] };
          }
          return { toArray: async () => structuredClone(rows[name] || []) };
        },
      };
    },
  };
  const result = await resolveIncrementalCommunityIds(db, "2026-08-11T10:00:00.000Z", false);
  assert.deepEqual(result, [COMMUNITY_A]);
  const linkedQuery = calls.find((row) => row.name === "lk_community_feed" && row.query.archived)?.query;
  assert.deepEqual(linkedQuery.$or.slice(-3), [
    { "details.relatedTournamentId": { $in: ["tournament-legacy"] } },
    { "details.publicTournament.exerciseId": { $in: ["tournament-legacy"] } },
    { "details.publicTournament.tournamentId": { $in: ["tournament-legacy"] } },
  ]);
});
