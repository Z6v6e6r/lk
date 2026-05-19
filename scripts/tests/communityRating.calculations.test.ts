import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRatingBadges,
  calculateActivityScore,
  calculateGamesRawScore,
  calculateGamesScore,
  calculateOverallScore,
  calculatePlaceScore,
  calculateTournamentRawScore,
  calculateTournamentScore,
  getGamesReliabilityFactor,
  getPlaceBonus,
  getTournamentReliabilityFactor,
  normalizeScore,
  sortRatingItems,
  type CommunityRatingItem,
} from "../../src/services/community-rating/calculations.ts";

function createItem(overrides: Partial<CommunityRatingItem>): CommunityRatingItem {
  return {
    communityId: "community-1",
    playerId: "player-1",
    playerName: "Игрок",
    avatarUrl: null,
    currentLevel: 4.5,
    levelDelta: 0,
    gamesPlayed: 0,
    gamesWon: 0,
    gamesLost: 0,
    winRate: 0,
    setsWon: 0,
    gamesWonCount: 0,
    gamesDiff: 0,
    gamesRawScore: 0,
    gamesReliabilityFactor: 0,
    gamesScore: 0,
    gamesNormalized: 0,
    tournamentsPlayed: 0,
    tournamentMatchesWon: 0,
    tournamentPointsScored: 0,
    tournamentPointsDiff: 0,
    bestPlace: null,
    averagePlace: null,
    tournamentRawScore: 0,
    tournamentReliabilityFactor: 0,
    tournamentScore: 0,
    tournamentNormalized: 0,
    activityScore: 0,
    overallScore: 0,
    totalEventsPlayed: 0,
    lastActivityAt: null,
    badges: [],
    ...overrides,
  };
}

test("games reliability factor thresholds", () => {
  assert.equal(getGamesReliabilityFactor(0), 0);
  assert.equal(getGamesReliabilityFactor(1), 0.6);
  assert.equal(getGamesReliabilityFactor(4), 0.8);
  assert.equal(getGamesReliabilityFactor(6), 1);
});

test("games raw score example from specification", () => {
  const gamesRaw = calculateGamesRawScore({
    gamesWon: 4,
    setsWon: 12,
    gamesWonCount: 58,
    gamesDiff: 8,
    levelDelta: 0.06,
  });
  assert.equal(gamesRaw, 119);
});

test("one-game score is penalized by reliability vs same raw score with 6 games", () => {
  const lowSample = calculateGamesScore({
    gamesPlayed: 1,
    gamesWon: 4,
    setsWon: 12,
    gamesWonCount: 58,
    gamesDiff: 8,
    levelDelta: 0.06,
  });
  const reliableSample = calculateGamesScore({
    gamesPlayed: 6,
    gamesWon: 4,
    setsWon: 12,
    gamesWonCount: 58,
    gamesDiff: 8,
    levelDelta: 0.06,
  });
  assert.equal(lowSample.gamesRawScore, reliableSample.gamesRawScore);
  assert.equal(lowSample.gamesReliabilityFactor, 0.6);
  assert.equal(reliableSample.gamesReliabilityFactor, 1);
  assert.ok(lowSample.gamesScore < reliableSample.gamesScore);
});

test("games score applies reliability factor", () => {
  const score = calculateGamesScore({
    gamesPlayed: 1,
    gamesWon: 1,
    setsWon: 2,
    gamesWonCount: 12,
    gamesDiff: 3,
    levelDelta: 0.02,
  });
  assert.equal(score.gamesReliabilityFactor, 0.6);
  assert.equal(score.gamesScore, Math.round(score.gamesRawScore * 0.6 * 1000) / 1000);
});

test("place score examples from specification", () => {
  assert.equal(calculatePlaceScore(1, 16), 100);
  assert.equal(calculatePlaceScore(2, 16), 93.75);
  assert.equal(calculatePlaceScore(16, 16), 6.25);
});

test("place bonus table", () => {
  assert.equal(getPlaceBonus(1), 30);
  assert.equal(getPlaceBonus(2), 20);
  assert.equal(getPlaceBonus(3), 10);
  assert.equal(getPlaceBonus(4), 0);
});

test("tournament raw score example from specification", () => {
  const tournamentRaw = calculateTournamentRawScore({
    participantsCount: 16,
    place: 2,
    tournamentMatchesWon: 6,
    tournamentPointsScored: 94,
    tournamentPointsDiff: 18,
  });
  assert.equal(tournamentRaw, 226.75);
});

test("tournament reliability factor thresholds", () => {
  assert.equal(getTournamentReliabilityFactor(0), 0);
  assert.equal(getTournamentReliabilityFactor(1), 0.8);
  assert.equal(getTournamentReliabilityFactor(2), 1);
});

test("tournament score applies reliability factor", () => {
  const score = calculateTournamentScore(226.75, 1);
  assert.equal(score.tournamentReliabilityFactor, 0.8);
  assert.equal(score.tournamentScore, 181.4);
});

test("overall score example from specification", () => {
  assert.equal(calculateOverallScore(70, 60, 56), 65.1);
});

test("activity score formula and max cap", () => {
  assert.equal(calculateActivityScore(8, 2), 56);
  assert.equal(calculateActivityScore(40, 10), 100);
});

test("normalization handles empty max score", () => {
  assert.equal(normalizeScore(10, 0), 0);
});

test("player without games and tournaments gets zero activity", () => {
  assert.equal(calculateActivityScore(0, 0), 0);
  assert.equal(getGamesReliabilityFactor(0), 0);
  assert.equal(getTournamentReliabilityFactor(0), 0);
});

test("games raw score keeps negative inputs in formula", () => {
  const value = calculateGamesRawScore({
    gamesWon: 0,
    setsWon: 1,
    gamesWonCount: 4,
    gamesDiff: -5,
    levelDelta: -0.1,
  });
  assert.equal(value, -10);
});

test("badges include all expected edge-case flags", () => {
  const badges = buildRatingBadges({
    gamesPlayed: 2,
    tournamentsPlayed: 1,
    totalEventsPlayed: 6,
    lastActivityAt: "2026-05-10T10:00:00.000Z",
    levelDelta: 0.04,
    bestPlace: 1,
  }, { nowTs: Date.parse("2026-05-18T10:00:00.000Z") });

  assert.deepEqual(
    badges,
    ["low_games_data", "low_tournament_data", "reliable", "active", "growing", "tournament_winner"],
  );
});

test("no-activity badge is set for zero events", () => {
  const badges = buildRatingBadges({
    gamesPlayed: 0,
    tournamentsPlayed: 0,
    totalEventsPlayed: 0,
    lastActivityAt: null,
    levelDelta: 0,
    bestPlace: null,
  });
  assert.deepEqual(badges, ["no_activity"]);
});

test("sort by tournaments keeps lower place first on equal tournament score", () => {
  const items = sortRatingItems(
    [
      createItem({
        playerId: "p1",
        playerName: "B",
        tournamentScore: 100,
        bestPlace: 3,
        tournamentMatchesWon: 5,
      }),
      createItem({
        playerId: "p2",
        playerName: "A",
        tournamentScore: 100,
        bestPlace: 2,
        tournamentMatchesWon: 5,
      }),
    ],
    "tournaments",
  );
  assert.deepEqual(items.map((item) => item.playerId), ["p2", "p1"]);
});

test("sort by overall uses lastActivityAt when scores are equal", () => {
  const items = sortRatingItems(
    [
      createItem({
        playerId: "p1",
        playerName: "Late",
        overallScore: 50,
        gamesScore: 10,
        tournamentScore: 10,
        activityScore: 10,
        lastActivityAt: "2026-05-17T09:00:00.000Z",
      }),
      createItem({
        playerId: "p2",
        playerName: "Early",
        overallScore: 50,
        gamesScore: 10,
        tournamentScore: 10,
        activityScore: 10,
        lastActivityAt: "2026-05-01T09:00:00.000Z",
      }),
    ],
    "overall",
  );
  assert.deepEqual(items.map((item) => item.playerId), ["p1", "p2"]);
});

test("sort by games uses full tie-break chain", () => {
  const items = sortRatingItems(
    [
      createItem({
        playerId: "p1",
        playerName: "Игрок A",
        gamesScore: 10,
        winRate: 0.4,
        gamesDiff: 2,
        levelDelta: 0.03,
        gamesPlayed: 8,
      }),
      createItem({
        playerId: "p2",
        playerName: "Игрок B",
        gamesScore: 10,
        winRate: 0.6,
        gamesDiff: 1,
        levelDelta: 0.01,
        gamesPlayed: 4,
      }),
    ],
    "games",
  );
  assert.deepEqual(items.map((item) => item.playerId), ["p2", "p1"]);
});
