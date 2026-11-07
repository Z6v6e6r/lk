import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fprStandings } from "../../src/components/tournaments/fpr6x25.ts";
import { calculateFprTournamentRatings } from "../../src/services/player-rating/fprTournamentRating.ts";

const ordinary = new Function("msg", fs.readFileSync(new URL("../nodered_games_nodes/fn_tournament_recalculate.js", import.meta.url), "utf8"));
import { ratingFixture } from "./helpers/fprRatingFixture.ts";


for (const n of [4, 5, 8, 9, 12, 15, 16]) {
  for (const rounds of [6, 7, 8]) {
    test(`ordinary handler parity: ${n} players, ${rounds} rounds, confidence and byes`, () => {
      const state = ratingFixture(n, rounds);
      const before = structuredClone(state);
      const participants = state.players.map((p, i) => ({ id: p.id, name: p.name, rating: p.level,
        verif: (i % 3) / 2, regularity: 0.7 + i / 100, engagement: 0.6, pressure: 1.1, tournamentMultiplier: 0.9 }));
      const params = { K: 0.27, D: 2.8, B: 0.31, Influence: 0.4, weights: { verif: 0.4, regularity: 0.35, engagement: 0.25 },
        byePointsMode: "zero_points", totalRounds: rounds, finished: true, finishedAt: state.finishedAt };
      const result = calculateFprTournamentRatings(state, { params, participants });
      const legacy = ordinary({ payload: { tournamentId: "synthetic-source", tournamentType: "americano", participants,
        params, rounds: state.attempts.filter(a => a.status === "closed").map(a => ({ id: a.id,
          matches: a.matches.map(m => ({ ...m, court: state.courts[m.courtIndex] })), byes: a.byes })) }, req: { body: {} } });
      assert.equal(legacy.statusCode, undefined);
      for (const row of result.standings) {
        const expected = legacy.payload.standings.find((p: { id: string }) => p.id === row.id);
        assert.ok(expected);
        for (const key of ["ratingBefore", "ratingAfter", "ratingDelta", "deltaTotal"] as const) assert.equal(row[key], expected[key], `${row.id}.${key}`);
        const original = fprStandings(state).find(p => p.id === row.id)!;
        assert.equal(row.rank, original.rank);
        assert.equal(row.wins, original.wins);
        assert.equal(row.pointsFor, original.pointsFor);
      }
      assert.equal(result.matches, Math.floor(n / 4) * rounds);
      assert.deepEqual(state, before);
    });
  }
}

test("bounds preserve the ordinary clamped rating and raw-sum delta semantics", () => {
  const state = ratingFixture(4, 6, [1, 7, 1, 7]);
  const result = calculateFprTournamentRatings(state);
  assert.ok(result.standings.every(p => p.ratingAfter >= 1 && p.ratingAfter <= 7));
  assert.ok(result.standings.every(p => p.ratedMatches === 6));
});
test("unrated frozen zero requires an explicit policy, rather than a first-match jump", () => {
  const state = ratingFixture(4, 6, [0, 3, 3, 3]);
  assert.throws(() => calculateFprTournamentRatings(state), /UNRATED_START/);
  const result = calculateFprTournamentRatings(state, { unratedStartLevel: 1 });
  assert.equal(result.standings.find(p => p.id === "p0")!.ratingBefore, 1);
  assert.equal(result.standings.filter(p => p.unratedStartApplied).length, 1);
});
test("test and unfinished protocols cannot award levels", () => {
  const state = ratingFixture();
  state.testMode = true;
  assert.throws(() => calculateFprTournamentRatings(state), /NOT_FINAL/);
  const unfinished = ratingFixture();
  unfinished.status = "in_progress"; unfinished.finishedAt = null;
  assert.throws(() => calculateFprTournamentRatings(unfinished), /NOT_FINAL/);
});
test("invalid formula fails before awarding a result", () => {
  assert.throws(() => calculateFprTournamentRatings(ratingFixture(), { params: { D: 0 } }), /INVALID_FORMULA/);
});

test("cumulative overflow is quarantined even when individual match deltas are finite", () => {
  const state = ratingFixture(4, 6);
  assert.throws(() => calculateFprTournamentRatings(state, { params: { K: 1e308, D: 1e308 },
    participants: state.players.map(p => ({ id: p.id, pressure: 2 })) }), /FPR_LEVEL_INVALID_FORMULA/);
});
