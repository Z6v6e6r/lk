import test from "node:test";
import assert from "node:assert/strict";
import { resolveTournamentSignupExerciseId } from "../../src/utils/tournamentExerciseId.ts";

test("prefers Viva sourceTournamentId over local document id", () => {
  const payload = {
    id: "6a1de01c8dadcc9bfc028396",
    sourceTournamentId: "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
  };

  assert.equal(
    resolveTournamentSignupExerciseId(payload),
    "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
  );
});

test("resolves Viva exercise id from nested source tournament snapshot", () => {
  const payload = {
    id: "6a1de01c8dadcc9bfc028396",
    sourceTournamentSnapshot: {
      sourceTournamentId: "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
    },
  };

  assert.equal(
    resolveTournamentSignupExerciseId(payload),
    "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
  );
});

test("prefers nested Viva exercise UUID over top-level mongo tournament id", () => {
  const payload = {
    id: "6a1eb0b68dadcc9bfc02839a",
    publicTournament: {
      exercise: {
        id: "92051094-9db6-4cfd-a400-b9ad360d0a4b",
      },
    },
  };

  assert.equal(
    resolveTournamentSignupExerciseId(payload),
    "92051094-9db6-4cfd-a400-b9ad360d0a4b",
  );
});

test("prefers Viva UUID from nested source tournament over local nested id", () => {
  const payload = {
    id: "6a1eb0b68dadcc9bfc02839a",
    sourceTournament: {
      id: "6a1eb0b68dadcc9bfc02839a",
      sourceTournamentId: "92051094-9db6-4cfd-a400-b9ad360d0a4b",
    },
  };

  assert.equal(
    resolveTournamentSignupExerciseId(payload),
    "92051094-9db6-4cfd-a400-b9ad360d0a4b",
  );
});

test("falls back to id when Viva exercise id is absent", () => {
  const payload = {
    id: "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
  };

  assert.equal(
    resolveTournamentSignupExerciseId(payload),
    "8fae2b19-baa4-4eb9-98b8-93c9f988f425",
  );
});
