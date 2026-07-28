import test from "node:test";
import assert from "node:assert/strict";
import type { RatingBreakdownMetricsPayload } from "../../src/types/levelsInfoOverlay.ts";
import {
  buildActivityFactorRows,
  buildGamesFactorRows,
  buildOverallFactorRows,
  buildTournamentFactorRows,
  calculateActivityScoreFromFactors,
  calculateGamesRawScoreFromFactors,
  calculateOverallScoreFromFactors,
  calculateTournamentRawScoreFromFactors,
  getExpectedGamesReliabilityFactor,
  getExpectedTournamentReliabilityFactor,
  getGamesReliabilityHint,
  getTournamentReliabilityHint,
} from "../../src/components/levels-info/ratingBreakdownUtils.ts";

const baseMetrics: RatingBreakdownMetricsPayload = {
  currentLevel: 2.999,
  levelDelta: -0.327,
  lastRatingDelta: -0.02,
  lastRatingChangedAt: "2026-05-25T07:00:00.000Z",
  gamesPlayed: 13,
  gamesWon: 5,
  gamesLost: 8,
  setsWon: 14,
  gamesWonCount: 140,
  gamesDiff: -31,
  gamesRawScore: 98.3,
  gamesReliabilityFactor: 1,
  gamesScore: 98.3,
  gamesNormalized: 28.869,
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
  activityScore: 52,
  overallScore: 21.078,
  lastActivityAt: "2026-05-25T07:00:00.000Z",
};

test("buildGamesFactorRows returns weighted contributions matching the approved formula", () => {
  const rows = buildGamesFactorRows(baseMetrics);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));

  assert.equal(rows.length, 5);
  assert.equal(byId.gamesWon?.contribution, 50);
  assert.equal(byId.setsWon?.contribution, 42);
  assert.equal(byId.gamesWonCount?.contribution, 70);
  assert.equal(byId.gamesDiff?.contribution, -31);
  assert.equal(byId.levelDelta?.contribution, -32.7);
});

test("calculateGamesRawScoreFromFactors reproduces the rating raw score from the UI scenario", () => {
  assert.equal(calculateGamesRawScoreFromFactors(baseMetrics), 98.3);
});

test("games reliability thresholds stay aligned with rating contract", () => {
  assert.equal(getExpectedGamesReliabilityFactor(0), 0);
  assert.equal(getExpectedGamesReliabilityFactor(1), 0.6);
  assert.equal(getExpectedGamesReliabilityFactor(3), 0.8);
  assert.equal(getExpectedGamesReliabilityFactor(6), 1);
});

test("games reliability helper returns the expected user-facing hint", () => {
  assert.equal(getGamesReliabilityHint(0), "Без сыгранных игр коэффициент = 0");
  assert.equal(getGamesReliabilityHint(2), "При 1–2 сыгранных играх коэффициент = 0,6");
  assert.equal(getGamesReliabilityHint(4), "При 3–5 сыгранных играх коэффициент = 0,8");
  assert.equal(getGamesReliabilityHint(8), "При 6 и более сыгранных играх коэффициент = 1");
});

test("overall breakdown rows and calculator keep the approved weights", () => {
  const rows = buildOverallFactorRows(baseMetrics);
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.multiplier, 0.2);
  assert.equal(rows[1]?.multiplier, 0.6);
  assert.equal(rows[2]?.multiplier, 0.2);
  assert.equal(calculateOverallScoreFromFactors(baseMetrics), 16.174);
});

test("tournament breakdown reproduces raw score and reliability contract", () => {
  const metrics: RatingBreakdownMetricsPayload = {
    ...baseMetrics,
    tournamentsPlayed: 2,
    tournamentMatchesWon: 3,
    tournamentPointsScored: 42,
    tournamentPointsDiff: 8,
    bestPlace: 2,
    averagePlace: 3.5,
    tournamentRawScore: 128,
    tournamentReliabilityFactor: 1,
    tournamentScore: 128,
    tournamentNormalized: 64,
  };
  const rows = buildTournamentFactorRows(metrics);

  assert.deepEqual(rows.map((row) => row.contribution), [75, 24, 21, 8]);
  assert.equal(calculateTournamentRawScoreFromFactors(metrics), 128);
  assert.equal(getExpectedTournamentReliabilityFactor(0), 0);
  assert.equal(getExpectedTournamentReliabilityFactor(1), 0.8);
  assert.equal(getExpectedTournamentReliabilityFactor(2), 1);
  assert.equal(getTournamentReliabilityHint(1), "При 1 завершенном турнире коэффициент = 0,8");
});

test("activity breakdown applies games, tournaments, visits, and the cap", () => {
  const metrics: RatingBreakdownMetricsPayload = {
    ...baseMetrics,
    gamesPlayed: 2,
    tournamentsPlayed: 1,
    visitsAttended: 3,
    activityScore: 26,
  };
  const rows = buildActivityFactorRows(metrics);

  assert.deepEqual(rows.map((row) => row.contribution), [8, 12, 6]);
  assert.equal(calculateActivityScoreFromFactors(metrics), 26);
  assert.equal(calculateActivityScoreFromFactors({ ...metrics, gamesPlayed: 40 }), 100);
});
