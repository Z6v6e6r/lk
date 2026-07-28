import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const helperMatch = apiClientSource.match(
  /export function resolveExerciseCancellationState\(exercise: Exercise \| null \| undefined\): boolean \| null \{[\s\S]*?\n\}/,
);
assert.ok(helperMatch);

const resolveExerciseCancellationState = new Function(
  `${helperMatch[0].replace(
    "export function resolveExerciseCancellationState(exercise: Exercise | null | undefined): boolean | null",
    "function resolveExerciseCancellationState(exercise)",
  )}; return resolveExerciseCancellationState;`,
)() as (exercise: Record<string, unknown> | null | undefined) => boolean | null;

const baseExercise = {
  id: "exercise-1",
  direction: {
    id: 4588,
    name: "Открытая игра",
  },
  type: {
    id: 1613,
    name: "Открытая игра",
    color: "magenta",
    format: "GROUP",
  },
  timeFrom: "2026-06-03T17:30:00+03:00",
  timeTo: "2026-06-03T19:00:00+03:00",
  clientsCount: 2,
  maxClientsCount: 4,
  girlsOnly: false,
  studio: {
    id: "station-1",
    name: "Терехово",
    city: "Москва",
    country: "Россия",
    address: "Адрес",
  },
  room: {
    id: "room-1",
    name: "Открытый корт №5",
  },
  trainers: [],
  cancellationDeadline: "2026-06-02T17:30:00+03:00",
};

test("live Viva exercise is not treated as cancelled", () => {
  assert.equal(resolveExerciseCancellationState(baseExercise), false);
});

test("explicit Viva exercise cancellation flags are treated as cancelled", () => {
  assert.equal(resolveExerciseCancellationState({ ...baseExercise, isCancelled: true }), true);
  assert.equal(resolveExerciseCancellationState({ ...baseExercise, status: "CANCELLED" }), true);
});

test("missing exercise payload has unknown cancellation state", () => {
  assert.equal(resolveExerciseCancellationState(null), null);
});
