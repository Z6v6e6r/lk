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
  COMMUNITY_RATING_ACTIVITY_WEIGHTS,
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_GAMES_RAW_WEIGHTS,
  COMMUNITY_RATING_GAMES_RELIABILITY_FACTORS,
  COMMUNITY_RATING_OVERALL_WEIGHTS,
  COMMUNITY_RATING_PERIODS,
  COMMUNITY_RATING_PLACE_BONUS_BY_PLACE,
  COMMUNITY_RATING_TABS,
  COMMUNITY_RATING_TOURNAMENT_RAW_WEIGHTS,
  COMMUNITY_RATING_TOURNAMENT_RELIABILITY_FACTORS,
  getGamesReliabilityFactor,
  getPlaceBonus,
  getTournamentReliabilityFactor,
  normalizeCommunityRatingPeriod,
  normalizeCommunityRatingTab,
  normalizeScore,
  sortRatingItems,
  toCommunityRatingTransportTab,
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
    lastRatingDelta: null,
    lastRatingChangedAt: null,
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
    visitsAttended: 0,
    activityScore: 0,
    overallScore: 0,
    totalEventsPlayed: 0,
    lastActivityAt: null,
    badges: [],
    ...overrides,
  };
}

test("rating contract exposes approved version, tabs, and periods", () => {
  assert.equal(COMMUNITY_RATING_CALCULATION_VERSION, "community-rating-v1.3.0");
  assert.deepEqual([...COMMUNITY_RATING_TABS], ["overall", "dynamics", "games", "tournaments"]);
  assert.deepEqual([...COMMUNITY_RATING_PERIODS], ["all", "30d"]);
});

test("rating contract locks approved formula weights", () => {
  assert.deepEqual(COMMUNITY_RATING_GAMES_RAW_WEIGHTS, {
    matchWin: 10,
    setWin: 3,
    gameWin: 0.5,
    gameDiff: 1,
    levelDelta: 100,
  });
  assert.deepEqual(COMMUNITY_RATING_TOURNAMENT_RAW_WEIGHTS, {
    matchWin: 8,
    pointScored: 0.5,
    pointDiff: 1,
  });
  assert.deepEqual(COMMUNITY_RATING_PLACE_BONUS_BY_PLACE, {
    1: 30,
    2: 20,
    3: 10,
  });
  assert.deepEqual(COMMUNITY_RATING_OVERALL_WEIGHTS, {
    games: 0.2,
    tournaments: 0.6,
    activity: 0.2,
  });
  assert.equal(Object.values(COMMUNITY_RATING_OVERALL_WEIGHTS).reduce((sum, value) => sum + value, 0), 1);
  assert.deepEqual(COMMUNITY_RATING_ACTIVITY_WEIGHTS, {
    game: 4,
    tournament: 12,
    visit: 2,
    max: 100,
  });
});

test("rating contract locks approved reliability thresholds", () => {
  assert.deepEqual([...COMMUNITY_RATING_GAMES_RELIABILITY_FACTORS], [
    { minGames: 0, maxGames: 0, factor: 0 },
    { minGames: 1, maxGames: 2, factor: 0.6 },
    { minGames: 3, maxGames: 5, factor: 0.8 },
    { minGames: 6, maxGames: null, factor: 1 },
  ]);
  assert.deepEqual([...COMMUNITY_RATING_TOURNAMENT_RELIABILITY_FACTORS], [
    { minTournaments: 0, maxTournaments: 0, factor: 0 },
    { minTournaments: 1, maxTournaments: 1, factor: 0.8 },
    { minTournaments: 2, maxTournaments: null, factor: 1 },
  ]);
});

test("rating tab normalizer keeps dynamics canonical and level as legacy alias", () => {
  assert.equal(normalizeCommunityRatingTab("dynamics"), "dynamics");
  assert.equal(normalizeCommunityRatingTab("dynamic"), "dynamics");
  assert.equal(normalizeCommunityRatingTab("level"), "dynamics");
  assert.equal(normalizeCommunityRatingTab("games"), "games");
  assert.equal(normalizeCommunityRatingTab("unknown"), "overall");
});

test("rating transport keeps backend compatibility for dynamics tab", () => {
  assert.equal(toCommunityRatingTransportTab("dynamics"), "level");
  assert.equal(toCommunityRatingTransportTab("overall"), "overall");
  assert.equal(toCommunityRatingTransportTab("games"), "games");
  assert.equal(toCommunityRatingTransportTab("tournaments"), "tournaments");
});

test("rating period normalizer accepts product aliases", () => {
  assert.equal(normalizeCommunityRatingPeriod("week"), "30d");
  assert.equal(normalizeCommunityRatingPeriod("month"), "30d");
  assert.equal(normalizeCommunityRatingPeriod("quarter"), "30d");
  assert.equal(normalizeCommunityRatingPeriod("year"), "all");
  assert.equal(normalizeCommunityRatingPeriod("unknown"), "30d");
});

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
  assert.equal(calculateOverallScore(70, 60, 56), 61.2);
  assert.equal(calculateOverallScore(100, 0, 0), 20);
  assert.equal(calculateOverallScore(0, 100, 0), 60);
  assert.equal(calculateOverallScore(0, 0, 100), 20);
});

test("activity score formula and max cap", () => {
  assert.equal(calculateActivityScore(8, 2), 56);
  assert.equal(calculateActivityScore(8, 2, 3), 62);
  assert.equal(calculateActivityScore(40, 10), 100);
});

test("normalization handles empty max score", () => {
  assert.equal(normalizeScore(10, 0), 0);
});

test("player without games, tournaments, and visits gets zero activity", () => {
  assert.equal(calculateActivityScore(0, 0, 0), 0);
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

test("sort by dynamics prioritizes rating delta and keeps level as legacy alias", () => {
  const rows = [
    createItem({
      playerId: "high-level",
      playerName: "Высокий уровень",
      currentLevel: 5,
      levelDelta: 0.01,
      totalEventsPlayed: 10,
    }),
    createItem({
      playerId: "fast-growth",
      playerName: "Быстрый рост",
      currentLevel: 4,
      levelDelta: 0.08,
      totalEventsPlayed: 2,
    }),
  ];

  assert.deepEqual(sortRatingItems(rows, "dynamics").map((item) => item.playerId), ["fast-growth", "high-level"]);
  assert.deepEqual(sortRatingItems(rows, "level").map((item) => item.playerId), ["fast-growth", "high-level"]);
});
