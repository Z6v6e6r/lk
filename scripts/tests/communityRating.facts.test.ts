import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommunityRatingFactId,
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_COLLECTIONS,
  COMMUNITY_RATING_STORAGE_INDEXES,
  extractCommunityRatingFacts,
} from "../../src/services/community-rating/index.ts";

const members = [
  { id: "p1", phone: "+7 900 000-00-01", name: "Анна", avatar: "anna.png", levelScore: 4.2 },
  { id: "p2", phone: "+7 900 000-00-02", name: "Борис", avatar: "boris.png", levelScore: 4.1 },
  { id: "p3", phone: "+7 900 000-00-03", name: "Виктор", avatar: "victor.png", levelScore: 3.9 },
  { id: "p4", phone: "+7 900 000-00-04", name: "Глеб", avatar: "gleb.png", levelScore: 3.8 },
];

test("rating fact id is deterministic and versioned", () => {
  assert.equal(
    buildCommunityRatingFactId({
      communityId: "community-1",
      eventType: "game",
      eventId: "game-1",
      playerKey: "id:p1",
    }),
    `community-1:game:game-1:id%3Ap1:${COMMUNITY_RATING_CALCULATION_VERSION}`,
  );
});

test("rating storage plan has unique facts and snapshots indexes", () => {
  assert.equal(COMMUNITY_RATING_COLLECTIONS.facts, "community_rating_facts");
  assert.equal(COMMUNITY_RATING_COLLECTIONS.aggregates, "community_rating_player_aggregates");
  assert.equal(COMMUNITY_RATING_COLLECTIONS.snapshots, "community_rating_snapshots");

  const uniqueIndexes = COMMUNITY_RATING_STORAGE_INDEXES
    .filter((index) => index.unique)
    .map((index) => index.name);

  assert.deepEqual(uniqueIndexes, [
    "uniq_rating_fact_event_player_version",
    "uniq_rating_aggregate_player_period_version",
    "uniq_rating_snapshot_tab_period_version",
  ]);
});

test("extracts game facts only from confirmed community game posts", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-game-1",
        kind: "GAME",
        relatedGameId: "game-1",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
      {
        id: "post-game-draft",
        kind: "GAME",
        relatedGameId: "game-draft",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    games: [
      {
        id: "game-1",
        booking: {
          timeToIso: "2026-05-29T12:00:00.000Z",
        },
        participants: members,
        metadata: {
          teamSlots: ["p1", "p2", "p3", "p4"],
          matchResult: {
            status: "CONFIRMED",
            sets: [
              { left: 6, right: 4 },
              { left: 3, right: 6 },
              { left: 10, right: 8 },
            ],
            ratingImpact: [
              { id: "p1", delta: 0.04 },
              { id: "p2", delta: 0.04 },
              { id: "p3", delta: -0.03 },
              { id: "p4", delta: -0.03 },
            ],
          },
        },
      },
      {
        id: "game-draft",
        booking: {
          timeToIso: "2026-05-29T12:00:00.000Z",
        },
        participants: members,
        metadata: {
          teamSlots: ["p1", "p2", "p3", "p4"],
          matchResult: {
            status: "DRAFT",
            sets: [{ left: 6, right: 4 }],
          },
        },
      },
    ],
  });

  assert.equal(facts.length, 4);
  assert.deepEqual(facts.map((fact) => fact.eventType), ["game", "game", "game", "game"]);
  assert.deepEqual(facts.map((fact) => fact.playerId), ["p1", "p2", "p3", "p4"]);

  const anna = facts.find((fact) => fact.playerId === "p1");
  assert.ok(anna);
  assert.equal(anna.occurredAt, "2026-05-29T12:00:00.000Z");
  assert.equal(anna.sourcePostId, "post-game-1");
  assert.deepEqual(anna.metrics, {
    gamesPlayed: 1,
    gamesWon: 1,
    gamesLost: 0,
    setsWon: 2,
    setsLost: 1,
    gamesWonCount: 19,
    gamesLostCount: 18,
    gamesDiff: 1,
    levelDelta: 0.04,
  });

  const victor = facts.find((fact) => fact.playerId === "p3");
  assert.ok(victor);
  assert.deepEqual(victor.metrics, {
    gamesPlayed: 1,
    gamesWon: 0,
    gamesLost: 1,
    setsWon: 1,
    setsLost: 2,
    gamesWonCount: 18,
    gamesLostCount: 19,
    gamesDiff: -1,
    levelDelta: -0.03,
  });
});

test("uses member-key pairings with per-set substitutions and waitlist fallback", () => {
  const facts = extractCommunityRatingFacts({
    community: {
      id: "community-1",
      members: [
        ...members,
        { id: "p5", phone: "+7 900 000-00-05", name: "Денис", levelScore: 4 },
      ],
    },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-game-rotation",
        kind: "GAME",
        relatedGameId: "game-rotation",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    games: [
      {
        id: "game-rotation",
        booking: {
          timeToIso: "2026-05-29T12:00:00.000Z",
        },
        participants: members,
        waitlist: [{ id: "p5", phone: "+7 900 000-00-05", name: "Денис", levelScore: 4 }],
        metadata: {
          teamSlots: ["p1", "p4", "p2", "p3"],
          matchResult: {
            status: "CONFIRMED",
            resultRosterSnapshot: {
              members: [
                { memberKey: "p1", id: "p1", phone: "+7 900 000-00-01", name: "Анна" },
                { memberKey: "p2", id: "p2", phone: "+7 900 000-00-02", name: "Борис" },
                { memberKey: "p3", id: "p3", phone: "+7 900 000-00-03", name: "Виктор" },
                { memberKey: "p4", id: "p4", phone: "+7 900 000-00-04", name: "Глеб" },
                { memberKey: "p5", id: "p5", phone: "+7 900 000-00-05", name: "Денис" },
              ],
            },
            sets: [
              { left: 6, right: 4 },
              { left: 7, right: 5 },
              { left: 1, right: 6 },
            ],
            setPairings: [
              { setIndex: 0, slots: ["p1", "p2", "p3", "p4"] },
              { setIndex: 1, slots: ["p5", "p2", "p3", "p4"] },
            ],
            ratingImpact: [
              { id: "p1", delta: 0.02 },
              { id: "p5", delta: -0.01 },
            ],
          },
        },
      },
    ],
  });

  assert.deepEqual(facts.map((fact) => fact.playerId), ["p1", "p2", "p3", "p4", "p5"]);

  const anna = facts.find((fact) => fact.playerId === "p1");
  assert.ok(anna);
  assert.deepEqual(anna.metrics, {
    gamesPlayed: 1,
    gamesWon: 1,
    gamesLost: 0,
    setsWon: 1,
    setsLost: 0,
    gamesWonCount: 6,
    gamesLostCount: 4,
    gamesDiff: 2,
    levelDelta: 0.02,
  });

  const denis = facts.find((fact) => fact.playerId === "p5");
  assert.ok(denis);
  assert.deepEqual(denis.metrics, {
    gamesPlayed: 1,
    gamesWon: 0,
    gamesLost: 1,
    setsWon: 1,
    setsLost: 1,
    gamesWonCount: 8,
    gamesLostCount: 11,
    gamesDiff: -3,
    levelDelta: -0.01,
  });
});

test("creates game facts only for members of the requested community", () => {
  const sharedFeedPost = {
    id: "post-shared-game",
    kind: "GAME",
    relatedGameId: "shared-game",
    createdAt: "2026-05-29T09:00:00.000Z",
  };
  const sharedGame = {
    id: "shared-game",
    booking: {
      timeToIso: "2026-05-29T12:00:00.000Z",
    },
    participants: members,
    metadata: {
      teamSlots: ["p1", "p2", "p3", "p4"],
      matchResult: {
        status: "CONFIRMED",
        sets: [{ left: 6, right: 4 }],
      },
    },
  };

  const firstCommunityFacts = extractCommunityRatingFacts({
    community: { id: "community-left", members: members.slice(0, 2) },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [sharedFeedPost],
    games: [sharedGame],
  });
  const secondCommunityFacts = extractCommunityRatingFacts({
    community: { id: "community-right", members: members.slice(2, 4) },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [sharedFeedPost],
    games: [sharedGame],
  });

  assert.deepEqual(firstCommunityFacts.map((fact) => fact.playerId), ["p1", "p2"]);
  assert.deepEqual(firstCommunityFacts.map((fact) => fact.communityId), ["community-left", "community-left"]);
  assert.deepEqual(secondCommunityFacts.map((fact) => fact.playerId), ["p3", "p4"]);
  assert.deepEqual(secondCommunityFacts.map((fact) => fact.communityId), ["community-right", "community-right"]);
});

test("excludes non-final and provisional game result statuses from facts", () => {
  const statuses = ["PENDING_REVIEW", "DISPUTED", "CORRECTION_PENDING", "NO_RESULT_EXPIRED"];
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: statuses.map((status) => ({
      id: `post-${status}`,
      kind: "GAME",
      relatedGameId: `game-${status}`,
      createdAt: "2026-05-29T09:00:00.000Z",
    })),
    games: statuses.map((status) => ({
      id: `game-${status}`,
      participants: members,
      metadata: {
        teamSlots: ["p1", "p2", "p3", "p4"],
        matchResult: {
          status,
          confirmedAt: "2026-05-29T10:00:00.000Z",
          sets: [{ left: 6, right: 4 }],
        },
      },
      updatedAt: "2026-05-29T12:00:00.000Z",
    })),
  });

  assert.deepEqual(facts, []);
});

test("extracts tournament facts from finalized standings published in community", () => {
  const participants = Array.from({ length: 16 }, (_, index) => ({
    id: `participant-${index + 1}`,
    name: `Участник ${index + 1}`,
  }));

  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-1",
        kind: "TOURNAMENT",
        relatedTournamentId: "tournament-1",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-1",
        participants,
        summary: {
          finishedAt: "2026-05-29T11:30:00.000Z",
          participantsCount: 16,
        },
        standings: [
          {
            playerId: "p1",
            name: "Анна",
            place: 2,
            wins: 6,
            pointsFor: 94,
            pointsAgainst: 76,
            pointDiff: 18,
          },
          {
            playerId: "p2",
            name: "Борис",
            place: 1,
            wins: 7,
            pointsFor: 100,
            pointsAgainst: 70,
            pointDiff: 30,
          },
        ],
      },
    ],
  });

  assert.equal(facts.length, 2);

  const anna = facts.find((fact) => fact.playerId === "p1");
  assert.ok(anna);
  assert.equal(anna.eventType, "tournament");
  assert.equal(anna.occurredAt, "2026-05-29T11:30:00.000Z");
  assert.deepEqual(anna.metrics, {
    tournamentsPlayed: 1,
    participantsCount: 16,
    place: 2,
    placeScore: 93.75,
    placeBonus: 20,
    tournamentMatchesWon: 6,
    tournamentPointsScored: 94,
    tournamentPointsAgainst: 76,
    tournamentPointsDiff: 18,
    tournamentRawScore: 226.75,
  });
});

test("ignores tournament standings until the tournament is finalized", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-draft",
        kind: "TOURNAMENT",
        relatedTournamentId: "tournament-draft",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-draft",
        summary: {
          participantsCount: 16,
        },
        standings: [
          {
            playerId: "p1",
            name: "Анна",
            place: 1,
            wins: 5,
            pointsFor: 80,
            pointsAgainst: 60,
          },
        ],
      },
    ],
  });

  assert.deepEqual(facts, []);
});

test("matches tournament standings to community members by phone when ids differ", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-phone",
        kind: "TOURNAMENT",
        relatedTournamentId: "tournament-phone",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-phone",
        params: {
          status: "completed",
          completedAt: "2026-05-29T11:30:00.000Z",
        },
        standings: [
          {
            playerId: "external-player",
            phone: "+7 900 000-00-02",
            name: "Борис",
            place: 1,
            wins: 7,
            pointsFor: 100,
            pointsAgainst: 70,
            pointDiff: 30,
          },
        ],
      },
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.playerId, "p2");
  assert.equal(facts[0]?.playerPhone, "79000000002");
});

test("extracts tournament facts from stable nested tournament details fallback", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-nested",
        kind: "TOURNAMENT",
        details: {
          tournamentId: "69ebc77e919db56dbec04d71",
          publicTournament: {
            exerciseId: "tournament-nested",
          },
        },
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-nested",
        summary: {
          finishedAt: "2026-05-29T11:30:00.000Z",
          participantsCount: 16,
        },
        standings: [
          {
            playerId: "p1",
            name: "Анна",
            place: 1,
            wins: 7,
            pointsFor: 100,
            pointsAgainst: 70,
            pointDiff: 30,
          },
        ],
      },
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.eventType, "tournament");
  assert.equal(facts[0]?.eventId, "tournament-nested");
});

test("ignores legacy tournament details that only contain mongo object id links", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-legacy-objectid",
        kind: "TOURNAMENT",
        details: {
          tournamentId: "69ebc77e919db56dbec04d71",
        },
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-stable",
        summary: {
          finishedAt: "2026-05-29T11:30:00.000Z",
          participantsCount: 16,
        },
        standings: [
          {
            playerId: "p1",
            name: "Анна",
            place: 1,
            wins: 7,
            pointsFor: 100,
            pointsAgainst: 70,
            pointDiff: 30,
          },
        ],
      },
    ],
  });

  assert.deepEqual(facts, []);
});

test("treats root tournament completed status as finalized even without nested params", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      {
        id: "post-tournament-root-status",
        kind: "TOURNAMENT",
        relatedTournamentId: "tournament-root-status",
        createdAt: "2026-05-29T09:00:00.000Z",
      },
    ],
    tournaments: [
      {
        tournamentId: "tournament-root-status",
        status: "completed",
        updatedAt: "2026-05-29T11:30:00.000Z",
        standings: [
          {
            playerId: "p1",
            name: "Анна",
            place: 1,
            wins: 6,
            pointsFor: 88,
            pointsAgainst: 61,
          },
        ],
      },
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.eventType, "tournament");
  assert.equal(facts[0]?.playerId, "p1");
});

test("extracts visit facts from confirmed training bookings", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    visits: [
      {
        id: "booking-visit-1",
        exerciseId: "training-1",
        visitConfirmed: true,
        timeToIso: "2026-05-29T12:00:00.000Z",
        client: {
          id: "p1",
          phone: "+7 900 000-00-01",
          name: "Анна",
          levelScore: 4.2,
        },
      },
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.eventType, "visit");
  assert.equal(facts[0]?.eventId, "booking-visit-1");
  assert.equal(facts[0]?.playerId, "p1");
  assert.equal(facts[0]?.occurredAt, "2026-05-29T12:00:00.000Z");
  assert.deepEqual(facts[0]?.metrics, {
    visitsAttended: 1,
  });
});

test("counts confirmed visit participants from exercise containers", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    visits: [
      {
        id: "training-container-1",
        exerciseId: "training-1",
        timeToIso: "2026-05-29T12:00:00.000Z",
        bookings: [
          {
            id: "booking-visit-1",
            visitConfirmed: true,
            clientId: "p1",
            phone: "+7 900 000-00-01",
            name: "Анна",
          },
          {
            id: "booking-visit-2",
            visitConfirmed: false,
            clientId: "p2",
            phone: "+7 900 000-00-02",
            name: "Борис",
          },
        ],
      },
    ],
  });

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.eventType, "visit");
  assert.equal(facts[0]?.playerId, "p1");
});

test("ignores unconfirmed, cancelled, waitlist, and future visit bookings", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    visits: [
      {
        id: "visit-registered",
        status: "REGISTERED",
        timeToIso: "2026-05-29T12:00:00.000Z",
        client: { id: "p1", name: "Анна" },
      },
      {
        id: "visit-false",
        visitConfirmed: false,
        timeToIso: "2026-05-29T12:00:00.000Z",
        client: { id: "p1", name: "Анна" },
      },
      {
        id: "visit-cancelled",
        visitConfirmed: true,
        status: "CANCELLED",
        timeToIso: "2026-05-29T12:00:00.000Z",
        client: { id: "p1", name: "Анна" },
      },
      {
        id: "visit-waitlist",
        visitConfirmed: true,
        state: "WAITLIST",
        timeToIso: "2026-05-29T12:00:00.000Z",
        client: { id: "p1", name: "Анна" },
      },
      {
        id: "visit-future",
        visitConfirmed: true,
        timeToIso: "2026-05-29T14:00:00.000Z",
        client: { id: "p1", name: "Анна" },
      },
    ],
  });

  assert.deepEqual(facts, []);
});

test("ignores archived posts, missing linked records, and unknown tournament players", () => {
  const facts = extractCommunityRatingFacts({
    community: { id: "community-1", members },
    collectedAt: "2026-05-29T13:00:00.000Z",
    feedPosts: [
      { id: "archived", archived: true, kind: "GAME", relatedGameId: "game-1" },
      { id: "missing", kind: "GAME", relatedGameId: "missing-game" },
      { id: "unknown-player", kind: "TOURNAMENT", relatedTournamentId: "tournament-unknown" },
    ],
    games: [],
    tournaments: [
      {
        tournamentId: "tournament-unknown",
        updatedAt: "2026-05-29T11:30:00.000Z",
        standings: [
          {
            playerId: "external-player",
            name: "Не участник",
            place: 1,
            wins: 4,
            pointsFor: 50,
            pointDiff: 10,
          },
        ],
      },
    ],
  });

  assert.deepEqual(facts, []);
});

test("hydrates current level and game/tournament dynamics from the unified ledger", () => {
  const facts = extractCommunityRatingFacts({
    community: {
      id: "community-ledger",
      members: [{ id: "p1", name: "Анна", levelScore: 2.8 }],
    },
    feedPosts: [
      { id: "post-game", kind: "GAME", relatedGameId: "game-1", createdAt: "2026-07-10T10:00:00.000Z" },
      { id: "post-tournament", kind: "TOURNAMENT", relatedTournamentId: "tournament-1", createdAt: "2026-07-10T11:00:00.000Z" },
    ],
    games: [{
      id: "game-1",
      participants: [{ id: "p1", name: "Анна" }, { id: "p2", name: "Борис" }],
      metadata: {
        teamSlots: ["p1", "p2"],
        matchResult: {
          status: "CONFIRMED",
          sets: [{ left: 6, right: 4 }],
          ratingImpact: [{ id: "p1", delta: 9 }],
        },
      },
    }],
    tournaments: [{
      tournamentId: "tournament-1",
      summary: { status: "completed", finished: true, finishedAt: "2026-07-10T11:00:00.000Z" },
      standings: [{ id: "p1", name: "Анна", rank: 1, wins: 3, pointsFor: 24, pointsAgainst: 12 }],
    }],
    visits: [],
    ratingStates: [{ clientId: "p1", ratingNumeric: 3.4 }],
    ratingEvents: [
      {
        id: "rating-game",
        occurredAt: "2026-07-10T10:30:00.000Z",
        source: { domain: "GAME_RESULT", sourceId: "game-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: 0.1 },
      },
      {
        id: "rating-tournament",
        occurredAt: "2026-07-10T11:30:00.000Z",
        source: { domain: "TOURNAMENT", sourceId: "tournament-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: 0.2 },
      },
    ],
    collectedAt: "2026-07-10T12:00:00.000Z",
  });

  const game = facts.find((fact) => fact.eventType === "game");
  const tournament = facts.find((fact) => fact.eventType === "tournament");
  assert.equal(game?.currentLevel, 3.4);
  assert.equal(game?.ratingDelta, 0.1);
  assert.deepEqual(game?.ratingEventIds, ["rating-game"]);
  assert.equal(game?.lastRatingDelta, 0.1);
  assert.equal(game?.lastRatingChangedAt, "2026-07-10T10:30:00.000Z");
  assert.equal(tournament?.currentLevel, 3.4);
  assert.equal(tournament?.ratingDelta, 0.2);
  assert.deepEqual(tournament?.ratingEventIds, ["rating-tournament"]);
  assert.equal(tournament?.lastRatingDelta, 0.2);
  assert.equal(tournament?.lastRatingChangedAt, "2026-07-10T11:30:00.000Z");
});

test("keeps the latest ledger event separate from the net source rating delta", () => {
  const facts = extractCommunityRatingFacts({
    community: {
      id: "community-ledger-correction",
      members: [{ id: "p1", name: "Анна", levelScore: 3.1 }],
    },
    feedPosts: [
      { id: "post-game", kind: "GAME", relatedGameId: "game-1", createdAt: "2026-07-01T12:00:00.000Z" },
    ],
    games: [{
      id: "game-1",
      participants: [{ id: "p1", name: "Анна" }, { id: "p2", name: "Борис" }],
      metadata: {
        teamSlots: ["p1", "p2"],
        matchResult: {
          status: "CONFIRMED",
          sets: [{ left: 6, right: 4 }],
          ratingImpact: [{ id: "p1", delta: 0.15 }],
        },
      },
    }],
    tournaments: [],
    visits: [],
    ratingStates: [{ clientId: "p1", ratingNumeric: 3.25 }],
    ratingEvents: [
      {
        id: "rating-game-original",
        occurredAt: "2026-07-01T13:00:00.000Z",
        source: { domain: "GAME_RESULT", sourceId: "game-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: 0.2 },
      },
      {
        id: "rating-game-correction",
        occurredAt: "2026-07-02T13:00:00.000Z",
        source: { domain: "GAME_RESULT", sourceId: "game-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: -0.05 },
      },
    ],
    collectedAt: "2026-07-03T12:00:00.000Z",
  });

  const game = facts.find((fact) => fact.eventType === "game");
  assert.equal(game?.ratingDelta, 0.15);
  assert.deepEqual(game?.ratingEventIds, ["rating-game-original", "rating-game-correction"]);
  assert.equal(game?.lastRatingDelta, -0.05);
  assert.equal(game?.lastRatingChangedAt, "2026-07-02T13:00:00.000Z");
  assert.equal(game?.lastRatingEventId, "rating-game-correction");
});
