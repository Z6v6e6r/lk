import assert from "node:assert/strict";
import test from "node:test";
import {
  EXERCISE_CATEGORY_COURT_RENTAL,
  EXERCISE_CATEGORY_GROUP_TRAINING,
  EXERCISE_CATEGORY_OPEN_GAME,
  EXERCISE_CATEGORY_TOURNAMENT,
  isExerciseConvertibleToGameFromBooking,
  resolveCabinetBookingCategory,
  resolveExerciseCategoryFromValue,
} from "../../src/utils/exerciseCategory.ts";

test("classifies open games by stable Viva ids", () => {
  assert.equal(
    resolveExerciseCategoryFromValue({
      direction: { id: 4588, name: "Открытая игра" },
      type: { id: 1613, name: "Открытая игра" },
    }),
    EXERCISE_CATEGORY_OPEN_GAME,
  );
});

test("classifies game plus trainer as group training even when marker contains game", () => {
  assert.equal(
    resolveExerciseCategoryFromValue({
      direction: { id: 3935, name: "Игра+Тренер. Уровень D" },
      type: { id: 847, name: "Игра+Тренер" },
    }),
    EXERCISE_CATEGORY_GROUP_TRAINING,
  );
  assert.equal(
    resolveCabinetBookingCategory({
      exercise: {
        direction: { id: 3935, name: "Игра+Тренер. Уровень D" },
        type: { id: 847, name: "Игра+Тренер" },
      },
    }),
    "trainings",
  );
});

test("classifies tournaments by stable Viva ids", () => {
  assert.equal(
    resolveExerciseCategoryFromValue({
      direction: { id: 2617, name: "Падел турнир от ПадлхАБ" },
      type: { id: 839, name: "Падел Турнир" },
    }),
    EXERCISE_CATEGORY_TOURNAMENT,
  );
});

test("classifies court rental by an explicit rental marker", () => {
  const rental = {
    exercise: {
      direction: { id: 9001, name: "Аренда корта" },
      type: { id: 9002, name: "Падел — аренда" },
    },
  };

  assert.equal(resolveExerciseCategoryFromValue(rental), EXERCISE_CATEGORY_COURT_RENTAL);
  assert.equal(resolveCabinetBookingCategory(rental), "other");
  assert.equal(isExerciseConvertibleToGameFromBooking(rental), true);
});

test("only open games and court rentals can be converted from a booking", () => {
  assert.equal(
    isExerciseConvertibleToGameFromBooking({
      typeId: 1613,
      typeName: "Открытая игра",
      directionId: 4588,
      directionName: "Открытая игра",
    }),
    true,
  );
  assert.equal(
    isExerciseConvertibleToGameFromBooking({
      typeId: 847,
      typeName: "Игра+Тренер",
      directionId: 3935,
      directionName: "Игра+Тренер. Уровень D",
    }),
    false,
  );
  assert.equal(isExerciseConvertibleToGameFromBooking({ typeName: "Неизвестная услуга" }), false);
});

test("classifies flat booking-convert payloads by type and direction ids", () => {
  assert.equal(
    resolveExerciseCategoryFromValue({
      typeId: 1613,
      typeName: "Открытая игра",
      directionId: 4588,
      directionName: "Открытая игра",
    }),
    EXERCISE_CATEGORY_OPEN_GAME,
  );
  assert.equal(
    resolveExerciseCategoryFromValue({
      typeId: 847,
      typeName: "Игра+Тренер",
      directionId: 3935,
      directionName: "Игра+Тренер. Уровень D",
    }),
    EXERCISE_CATEGORY_GROUP_TRAINING,
  );
});
