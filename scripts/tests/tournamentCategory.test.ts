import test from "node:test";
import assert from "node:assert/strict";
import { isTournamentExerciseCategory } from "../../src/utils/tournamentCategory.ts";

test("recognizes legacy Viva tournament direction", () => {
  assert.equal(
    isTournamentExerciseCategory({ direction: { id: 2617, name: "Падел турнир" } }),
    true,
  );
});

test("recognizes Sirius Viva tournament direction in visibility lists", () => {
  assert.equal(
    isTournamentExerciseCategory({ direction: { id: 4769, name: "Падел завтрак" } }),
    true,
  );
});

test("recognizes Sirius direction when Viva sends it as exercise type", () => {
  assert.equal(
    isTournamentExerciseCategory({ type: { id: "4769", name: "Падел завтрак" } }),
    true,
  );
});

test("recognizes Time for Friends Viva tournament direction", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 5278, name: "Время на друзей" },
      type: { id: 839, name: "Падел Турнир" },
    }),
    true,
  );
});

test("does not broadly classify every Padel Tournament type", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 9999, name: "Групповая тренировка" },
      type: { id: 839, name: "Падел Турнир" },
    }),
    false,
  );
});

test("recognizes children's tournament direction with an unknown Viva id", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 9999, name: "Детский турнир" },
      type: { id: 839, name: "Падел Турнир" },
    }),
    true,
  );
});

test("recognizes children's tournament category in type with normalized whitespace and case", () => {
  assert.equal(
    isTournamentExerciseCategory({
      type: { id: "9999", name: "  ДЕТСКИЙ\u00a0  ТУРНИР  " },
    }),
    true,
  );
});

test("does not include children's trainings or partial tournament category names", () => {
  for (const name of ["Детская тренировка", "Детский турнир тренировка", "Подготовка: Детский турнир"]) {
    assert.equal(
      isTournamentExerciseCategory({ direction: { id: 9999, name } }),
      false,
      name,
    );
  }
});

test("recognizes special tournament type when a new Viva direction is used", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 5550, name: "Турнир Питер особый" },
      type: { id: "1013", name: "Мексикано" },
    }),
    true,
  );
});

test("keeps special-name fallback for custom tournament categories", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 9999, name: "Падел турнир (особый)" },
    }),
    true,
  );
});

test("does not classify regular trainings as tournaments", () => {
  assert.equal(
    isTournamentExerciseCategory({
      direction: { id: 3108, name: "Групповая тренировка" },
      type: { id: 3108, name: "Падел" },
    }),
    false,
  );
});
