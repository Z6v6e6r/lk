import assert from "node:assert/strict";
import { test } from "node:test";
import { filterVisibleTournamentExercises } from "../../src/components/tournaments/tournamentVisibility.ts";
import type { Exercise } from "../../src/utils/apiClient.ts";

function makeTournament(id: string, trainerId: string | null): Exercise {
  return {
    id,
    timeFrom: "2026-06-06T10:00:00+03:00",
    timeTo: "2026-06-06T12:00:00+03:00",
    direction: { id: 2617, name: "Падел турнир (особый)" },
    type: { id: 2617, name: "Турнир" },
    trainers: trainerId
      ? [{ id: trainerId, firstName: "Тренер", lastName: "Тест" }]
      : [],
  } as Exercise;
}

test("returns all tournaments when profile is unavailable", () => {
  const items = [makeTournament("a", "trainer-1"), makeTournament("b", "trainer-2")];

  const visible = filterVisibleTournamentExercises(items, null, false, false);

  assert.deepEqual(visible.map((item) => item.id), ["a", "b"]);
});

test("keeps all tournaments for host profiles", () => {
  const items = [makeTournament("a", "trainer-1"), makeTournament("b", "trainer-2")];

  const visible = filterVisibleTournamentExercises(items, "trainer-1", true, true);

  assert.deepEqual(visible.map((item) => item.id), ["a", "b"]);
});

test("filters to the assigned trainer when host access is missing", () => {
  const items = [makeTournament("a", "trainer-1"), makeTournament("b", "trainer-2")];

  const visible = filterVisibleTournamentExercises(items, "trainer-2", false, true);

  assert.deepEqual(visible.map((item) => item.id), ["b"]);
});
