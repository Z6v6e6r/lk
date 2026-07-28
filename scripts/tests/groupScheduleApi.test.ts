import assert from "node:assert/strict";
import test from "node:test";
import {
  GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID,
  getGroupTrainingTypeId,
  isGamePlusTrainerSummary,
  isGamePlusTrainerTraining,
  isGroupTrainingAllowed,
  normalizeGroupTraining,
  normalizeGroupTrainingList,
} from "../../src/utils/groupScheduleModel.ts";

const allowedStudioId = "0d5504f6-ea6f-44bb-a9e4-947faf0273ab";

function makeExercise(overrides: Record<string, unknown> = {}) {
  return {
    id: "exercise-1",
    direction: {
      id: 3935,
      name: "Групповая тренировка уровень D+",
      description: "Описание из Viva",
      whatToTake: "Форму",
    },
    type: {
      id: 605,
      name: "Падел групповая тренировка",
      color: "geekblue",
      format: "GROUP",
    },
    timeFrom: "2026-06-27T10:00:00+03:00",
    timeTo: "2026-06-27T11:00:00+03:00",
    clientsCount: 3,
    maxClientsCount: 4,
    girlsOnly: false,
    studio: {
      id: allowedStudioId,
      name: "Сколково",
      country: "Россия",
      city: "Москва",
      address: "г Москва, Сколковское шоссе, д 33",
    },
    room: {
      id: "court-1",
      name: "Корт №6 панорамик",
    },
    trainers: [
      {
        id: "trainer-1",
        firstName: "Олег",
        lastName: "Рембо",
        photo: "https://example.test/photo.jpg",
      },
    ],
    cancellationDeadline: "2026-06-26T10:00:00+03:00",
    inBooking: false,
    inWaitlist: false,
    inReserve: false,
    ...overrides,
  };
}

test("recognizes group training type ids from Viva exercise payloads", () => {
  assert.equal(getGroupTrainingTypeId(makeExercise()), 605);
  assert.equal(isGroupTrainingAllowed(makeExercise()), true);
});

test("recognizes game plus trainer exercises from Viva type and normalized summaries", () => {
  const exercise = makeExercise({
    direction: {
      id: 5810,
      name: "Игра+Тренер. Уровень D",
      description: "Описание из Viva",
    },
    type: {
      id: GROUP_SCHEDULE_GAME_PLUS_TRAINER_TYPE_ID,
      name: "Игра+Тренер",
      color: "purple",
      format: "GROUP",
    },
    clientsCount: 2,
    maxClientsCount: 3,
  });

  const training = normalizeGroupTraining(exercise);

  assert.equal(isGamePlusTrainerTraining(exercise), true);
  assert.ok(training);
  assert.equal(isGamePlusTrainerSummary(training), true);
  assert.equal(training.levelLabel, "D");
  assert.equal(training.maxClientsCount, 3);
});

test("recognizes game plus trainer exercises by name when type id is absent", () => {
  assert.equal(isGamePlusTrainerTraining({
    typeName: "Игра + тренер",
    directionName: "Уровень C",
  }), true);
});

test("filters out tournaments and academy exercises from group schedule", () => {
  const payload = [
    makeExercise({ id: "group-1" }),
    makeExercise({
      id: "tournament-1",
      type: { id: 839, name: "Падел Турнир", color: "red", format: "GROUP" },
    }),
    makeExercise({
      id: "academy-1",
      type: { id: 491, name: "Футбольная Академия", color: "green", format: "GROUP" },
    }),
  ];

  const list = normalizeGroupTrainingList(payload);

  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, "group-1");
});

test("normalizes visible card fields directly from Viva parameters", () => {
  const training = normalizeGroupTraining(makeExercise());

  assert.ok(training);
  assert.equal(training.title, "Групповая тренировка уровень D+");
  assert.equal(training.typeName, "Падел групповая тренировка");
  assert.equal(training.date, "2026-06-27");
  assert.equal(training.timeLabel, "10:00-11:00");
  assert.equal(training.clientsCount, 3);
  assert.equal(training.maxClientsCount, 4);
  assert.equal(training.spotsLeft, 1);
  assert.equal(training.status, "AVAILABLE");
  assert.equal(training.studioName, "Сколково");
  assert.equal(training.roomName, "Корт №6");
  assert.equal(training.trainerName, "Олег Рембо");
  assert.equal(training.levelLabel, "D+");
});

test("marks full and cancelled trainings without custom metadata", () => {
  assert.equal(normalizeGroupTraining(makeExercise({ clientsCount: 4, maxClientsCount: 4 }))?.status, "FULL");
  assert.equal(normalizeGroupTraining(makeExercise({ isCancelled: true }))?.status, "CANCELLED");
});
