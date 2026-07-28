import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommunityRatingAggregates,
  buildCommunityRatingSnapshot,
  buildCommunityRatingSnapshots,
  getCommunityRatingPeriodStartTs,
  COMMUNITY_RATING_CALCULATION_VERSION,
  type CommunityRatingFact,
} from "../../src/services/community-rating/index.ts";

const NOW_TS = Date.parse("2026-05-29T12:00:00.000Z");
const UPDATED_AT = "2026-05-29T12:00:00.000Z";

function gameFact(
  player: {
    playerKey: string;
    playerId: string;
    playerName: string;
    currentLevel?: number;
  },
  metrics: {
    gamesWon: 0 | 1;
    gamesLost: 0 | 1;
    setsWon: number;
    gamesWonCount: number;
    gamesDiff: number;
    levelDelta: number;
  },
  options: {
    eventId: string;
    occurredAt: string;
  },
): CommunityRatingFact {
  const occurredAtTs = Date.parse(options.occurredAt);
  return {
    id: `${options.eventId}:${player.playerKey}`,
    communityId: "community-1",
    sourcePostId: `post-${options.eventId}`,
    eventType: "game",
    eventId: options.eventId,
    playerKey: player.playerKey,
    playerId: player.playerId,
    playerPhone: null,
    playerName: player.playerName,
    playerAvatarUrl: null,
    currentLevel: player.currentLevel ?? 4,
    ratingDelta: metrics.levelDelta,
    ratingEventIds: [],
    lastRatingDelta: metrics.levelDelta === 0 ? null : metrics.levelDelta,
    lastRatingChangedAt: metrics.levelDelta === 0 ? null : options.occurredAt,
    lastRatingChangedAtTs: metrics.levelDelta === 0 ? null : occurredAtTs,
    lastRatingEventId: metrics.levelDelta === 0 ? null : `rating-${options.eventId}`,
    occurredAt: options.occurredAt,
    occurredAtTs,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    collectedAt: UPDATED_AT,
    metrics: {
      gamesPlayed: 1,
      gamesWon: metrics.gamesWon,
      gamesLost: metrics.gamesLost,
      setsWon: metrics.setsWon,
      setsLost: Math.max(0, 3 - metrics.setsWon),
      gamesWonCount: metrics.gamesWonCount,
      gamesLostCount: metrics.gamesWonCount - metrics.gamesDiff,
      gamesDiff: metrics.gamesDiff,
      levelDelta: metrics.levelDelta,
    },
  };
}

function tournamentFact(
  player: {
    playerKey: string;
    playerId: string;
    playerName: string;
    currentLevel?: number;
  },
  metrics: {
    place: number;
    tournamentRawScore: number;
    tournamentMatchesWon: number;
    tournamentPointsScored: number;
    tournamentPointsDiff: number;
  },
  options: {
    eventId: string;
    occurredAt: string;
  },
): CommunityRatingFact {
  const occurredAtTs = Date.parse(options.occurredAt);
  return {
    id: `${options.eventId}:${player.playerKey}`,
    communityId: "community-1",
    sourcePostId: `post-${options.eventId}`,
    eventType: "tournament",
    eventId: options.eventId,
    playerKey: player.playerKey,
    playerId: player.playerId,
    playerPhone: null,
    playerName: player.playerName,
    playerAvatarUrl: null,
    currentLevel: player.currentLevel ?? 4,
    ratingDelta: 0,
    ratingEventIds: [],
    lastRatingDelta: null,
    lastRatingChangedAt: null,
    lastRatingChangedAtTs: null,
    lastRatingEventId: null,
    occurredAt: options.occurredAt,
    occurredAtTs,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    collectedAt: UPDATED_AT,
    metrics: {
      tournamentsPlayed: 1,
      participantsCount: 16,
      place: metrics.place,
      placeScore: 100,
      placeBonus: metrics.place === 1 ? 30 : 0,
      tournamentMatchesWon: metrics.tournamentMatchesWon,
      tournamentPointsScored: metrics.tournamentPointsScored,
      tournamentPointsAgainst: metrics.tournamentPointsScored - metrics.tournamentPointsDiff,
      tournamentPointsDiff: metrics.tournamentPointsDiff,
      tournamentRawScore: metrics.tournamentRawScore,
    },
  };
}

function visitFact(
  player: {
    playerKey: string;
    playerId: string;
    playerName: string;
    currentLevel?: number;
  },
  options: {
    eventId: string;
    occurredAt: string;
  },
): CommunityRatingFact {
  const occurredAtTs = Date.parse(options.occurredAt);
  return {
    id: `${options.eventId}:${player.playerKey}`,
    communityId: "community-1",
    sourcePostId: null,
    eventType: "visit",
    eventId: options.eventId,
    playerKey: player.playerKey,
    playerId: player.playerId,
    playerPhone: null,
    playerName: player.playerName,
    playerAvatarUrl: null,
    currentLevel: player.currentLevel ?? 4,
    ratingDelta: 0,
    ratingEventIds: [],
    lastRatingDelta: null,
    lastRatingChangedAt: null,
    lastRatingChangedAtTs: null,
    lastRatingEventId: null,
    occurredAt: options.occurredAt,
    occurredAtTs,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    collectedAt: UPDATED_AT,
    metrics: {
      visitsAttended: 1,
    },
  };
}

test("period start timestamps are deterministic", () => {
  assert.equal(getCommunityRatingPeriodStartTs("7d", NOW_TS), Date.parse("2026-04-29T12:00:00.000Z"));
  assert.equal(getCommunityRatingPeriodStartTs("30d", NOW_TS), Date.parse("2026-04-29T12:00:00.000Z"));
  assert.equal(getCommunityRatingPeriodStartTs("90d", NOW_TS), Date.parse("2026-04-29T12:00:00.000Z"));
  assert.equal(getCommunityRatingPeriodStartTs("all", NOW_TS), null);
});

test("builds period aggregates from rating facts", () => {
  const player = {
    playerKey: "id:p1",
    playerId: "p1",
    playerName: "Анна",
    currentLevel: 4.2,
  };
  const facts = [
    gameFact(
      player,
      {
        gamesWon: 1,
        gamesLost: 0,
        setsWon: 2,
        gamesWonCount: 12,
        gamesDiff: 4,
        levelDelta: 0.05,
      },
      { eventId: "recent-game", occurredAt: "2026-05-25T12:00:00.000Z" },
    ),
    gameFact(
      player,
      {
        gamesWon: 0,
        gamesLost: 1,
        setsWon: 1,
        gamesWonCount: 8,
        gamesDiff: -6,
        levelDelta: -0.03,
      },
      { eventId: "old-game", occurredAt: "2026-04-01T12:00:00.000Z" },
    ),
  ];

  const lastMonth = buildCommunityRatingAggregates({
    communityId: "community-1",
    facts,
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });
  const allTime = buildCommunityRatingAggregates({
    communityId: "community-1",
    facts,
    period: "all",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(lastMonth.length, 1);
  assert.equal(lastMonth[0]?.gamesPlayed, 1);
  assert.equal(lastMonth[0]?.gamesWon, 1);
  assert.equal(lastMonth[0]?.levelDelta, 0.05);
  assert.equal(lastMonth[0]?.lastRatingDelta, 0.05);
  assert.equal(lastMonth[0]?.lastRatingChangedAt, "2026-05-25T12:00:00.000Z");
  assert.equal(lastMonth[0]?.gamesRawScore, 31);
  assert.equal(lastMonth[0]?.gamesScore, 18.6);
  assert.equal(lastMonth[0]?.gamesNormalized, 100);
  assert.equal(lastMonth[0]?.overallScore, 20.8);

  assert.equal(allTime.length, 1);
  assert.equal(allTime[0]?.gamesPlayed, 2);
  assert.equal(allTime[0]?.gamesWon, 1);
  assert.equal(allTime[0]?.gamesLost, 1);
  assert.equal(allTime[0]?.gamesDiff, -2);
  assert.equal(allTime[0]?.levelDelta, 0.02);
  assert.equal(allTime[0]?.lastRatingDelta, 0.05);
  assert.equal(allTime[0]?.lastRatingChangedAt, "2026-05-25T12:00:00.000Z");
  assert.equal(allTime[0]?.activityScore, 8);
});

test("visit facts contribute only to activity and total events", () => {
  const facts = [
    visitFact(
      { playerKey: "id:p1", playerId: "p1", playerName: "Анна", currentLevel: 4.2 },
      { eventId: "visit-1", occurredAt: "2026-05-25T12:00:00.000Z" },
    ),
    visitFact(
      { playerKey: "id:p1", playerId: "p1", playerName: "Анна", currentLevel: 4.2 },
      { eventId: "visit-2", occurredAt: "2026-05-26T12:00:00.000Z" },
    ),
  ];

  const rows = buildCommunityRatingAggregates({
    communityId: "community-1",
    facts,
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.gamesPlayed, 0);
  assert.equal(rows[0]?.tournamentsPlayed, 0);
  assert.equal(rows[0]?.visitsAttended, 2);
  assert.equal(rows[0]?.activityScore, 4);
  assert.equal(rows[0]?.overallScore, 0.8);
  assert.equal(rows[0]?.lastRatingDelta, null);
  assert.equal(rows[0]?.lastRatingChangedAt, null);
  assert.equal(rows[0]?.totalEventsPlayed, 2);
  assert.equal(rows[0]?.lastActivityAt, "2026-05-26T12:00:00.000Z");
});

test("latest rating change follows the newest rating event, not the cumulative period delta", () => {
  const player = { playerKey: "id:p1", playerId: "p1", playerName: "Анна", currentLevel: 4.2 };
  const facts = [
    gameFact(
      player,
      { gamesWon: 1, gamesLost: 0, setsWon: 2, gamesWonCount: 12, gamesDiff: 4, levelDelta: 0.2 },
      { eventId: "game-positive", occurredAt: "2026-05-20T12:00:00.000Z" },
    ),
    gameFact(
      player,
      { gamesWon: 0, gamesLost: 1, setsWon: 1, gamesWonCount: 8, gamesDiff: -2, levelDelta: -0.05 },
      { eventId: "game-negative", occurredAt: "2026-05-24T12:00:00.000Z" },
    ),
    visitFact(player, { eventId: "visit-after-rating", occurredAt: "2026-05-26T12:00:00.000Z" }),
  ];

  const rows = buildCommunityRatingAggregates({
    communityId: "community-1",
    facts,
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(rows[0]?.levelDelta, 0.15);
  assert.equal(rows[0]?.lastRatingDelta, -0.05);
  assert.equal(rows[0]?.lastRatingChangedAt, "2026-05-24T12:00:00.000Z");
  assert.equal(rows[0]?.lastActivityAt, "2026-05-26T12:00:00.000Z");
});

test("latest rating change uses the last ledger correction instead of the net source delta", () => {
  const player = {
    playerKey: "id:p1",
    playerId: "p1",
    playerName: "Анна",
  };
  const correctedFact = gameFact(
    player,
    {
      gamesWon: 1,
      gamesLost: 0,
      setsWon: 2,
      gamesWonCount: 12,
      gamesDiff: 4,
      levelDelta: 0.15,
    },
    { eventId: "corrected-game", occurredAt: "2026-07-01T12:00:00.000Z" },
  );
  correctedFact.ratingEventIds = ["rating-original", "rating-correction"];
  correctedFact.lastRatingDelta = -0.05;
  correctedFact.lastRatingChangedAt = "2026-07-02T13:00:00.000Z";
  correctedFact.lastRatingChangedAtTs = Date.parse(correctedFact.lastRatingChangedAt);
  correctedFact.lastRatingEventId = "rating-correction";

  const rows = buildCommunityRatingAggregates({
    communityId: "community-1",
    facts: [correctedFact],
    period: "30d",
    nowTs: Date.parse("2026-07-03T12:00:00.000Z"),
    updatedAt: "2026-07-03T12:00:00.000Z",
  });

  assert.equal(rows[0]?.levelDelta, 0.15);
  assert.equal(rows[0]?.lastRatingDelta, -0.05);
  assert.equal(rows[0]?.lastRatingChangedAt, "2026-07-02T13:00:00.000Z");
});

test("builds snapshots with tab-specific ranks", () => {
  const anna = { playerKey: "id:p1", playerId: "p1", playerName: "Анна", currentLevel: 4.2 };
  const boris = { playerKey: "id:p2", playerId: "p2", playerName: "Борис", currentLevel: 4.1 };
  const victor = { playerKey: "id:p3", playerId: "p3", playerName: "Виктор", currentLevel: 3.9 };
  const facts = [
    gameFact(
      anna,
      {
        gamesWon: 1,
        gamesLost: 0,
        setsWon: 2,
        gamesWonCount: 12,
        gamesDiff: 4,
        levelDelta: 0.01,
      },
      { eventId: "game-anna", occurredAt: "2026-05-25T12:00:00.000Z" },
    ),
    tournamentFact(
      boris,
      {
        place: 1,
        tournamentRawScore: 220,
        tournamentMatchesWon: 7,
        tournamentPointsScored: 100,
        tournamentPointsDiff: 30,
      },
      { eventId: "tournament-boris", occurredAt: "2026-05-26T12:00:00.000Z" },
    ),
    gameFact(
      victor,
      {
        gamesWon: 0,
        gamesLost: 1,
        setsWon: 0,
        gamesWonCount: 1,
        gamesDiff: -12,
        levelDelta: 0.2,
      },
      { eventId: "game-victor", occurredAt: "2026-05-27T12:00:00.000Z" },
    ),
  ];

  const games = buildCommunityRatingSnapshot({
    communityId: "community-1",
    facts,
    tab: "games",
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });
  const tournaments = buildCommunityRatingSnapshot({
    communityId: "community-1",
    facts,
    tab: "tournaments",
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });
  const dynamics = buildCommunityRatingSnapshot({
    communityId: "community-1",
    facts,
    tab: "dynamics",
    period: "30d",
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(games.rows[0]?.playerId, "p1");
  assert.equal(games.rows[0]?.rank, 1);
  assert.equal(tournaments.rows[0]?.playerId, "p2");
  assert.equal(tournaments.rows[0]?.rank, 1);
  assert.equal(dynamics.rows[0]?.playerId, "p3");
  assert.equal(dynamics.rows[0]?.rank, 1);
  assert.equal(dynamics.id, `community-1:30d:dynamics:${COMMUNITY_RATING_CALCULATION_VERSION}`);
});

test("builds full snapshot matrix for requested tabs and periods", () => {
  const facts = [
    gameFact(
      { playerKey: "id:p1", playerId: "p1", playerName: "Анна" },
      {
        gamesWon: 1,
        gamesLost: 0,
        setsWon: 2,
        gamesWonCount: 12,
        gamesDiff: 4,
        levelDelta: 0.01,
      },
      { eventId: "game-1", occurredAt: "2026-05-25T12:00:00.000Z" },
    ),
  ];

  const snapshots = buildCommunityRatingSnapshots({
    communityId: "community-1",
    facts,
    tabs: ["overall", "games"],
    periods: ["30d", "all"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.deepEqual(
    snapshots.map((snapshot) => `${snapshot.period}:${snapshot.tab}`),
    ["30d:overall", "30d:games", "all:overall", "all:games"],
  );
  assert.equal(snapshots.every((snapshot) => snapshot.rows.length === 1), true);
});
