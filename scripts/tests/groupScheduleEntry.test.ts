import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroupScheduleReturnUrl,
  DEFAULT_GROUP_SCHEDULE_PATH,
  normalizeGroupScheduleDate,
  readGroupScheduleEntryDataFromHref,
  syncGroupScheduleSelectionHref,
} from "../../src/utils/groupScheduleEntry.ts";
import { GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS } from "../../src/utils/groupScheduleModel.ts";
import { isTrialGroupTraining, TRIAL_GROUP_DIRECTION_ID } from "../../src/utils/trialGroupTraining.ts";

test("reads current and legacy group schedule query params", () => {
  const data = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?4lGIgL_date=2026-06-27&4lGIgL_exercise=exercise-1&4lGIgL_studio=studio-1",
  );

  assert.equal(DEFAULT_GROUP_SCHEDULE_PATH, "/group");
  assert.equal(data.date, "2026-06-27");
  assert.equal(data.exerciseId, "exercise-1");
  assert.equal(data.studioId, "studio-1");
  assert.equal(data.returnToFindGame, false);
});

test("prefers canonical group schedule params over legacy aliases", () => {
  const data = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?date=2026-07-01&groupExerciseId=exercise-2&studioId=studio-2&4lGIgL_date=2026-06-27",
  );

  assert.equal(data.date, "2026-07-01");
  assert.equal(data.exerciseId, "exercise-2");
  assert.equal(data.studioId, "studio-2");
  assert.equal(data.returnToFindGame, false);
});

test("detects find game return source on group detail links", () => {
  const data = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?date=2026-07-01&groupExerciseId=exercise-2&returnTo=finde_game",
  );

  assert.equal(data.returnToFindGame, true);
});

test("normalizes date-like values", () => {
  assert.equal(normalizeGroupScheduleDate("2026-06-27T10:00:00+03:00"), "2026-06-27");
  assert.equal(normalizeGroupScheduleDate("not-a-date"), null);
});

test("reads kids academy direction preset from group schedule links", () => {
  const data = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?direction=kids&cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk_new&authMode=viva",
  );

  assert.deepEqual(data.directionIds, GROUP_SCHEDULE_KIDS_ACADEMY_DIRECTION_IDS);
  assert.equal(data.directionLabel, "Детская академия падел");
});

test("reads explicit direction ids from group schedule links", () => {
  const data = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?directionId=2468&directionIds=2975%2C3163&4lGIgL_direction=2468",
  );

  assert.deepEqual(data.directionIds, [2468, 2975, 3163]);
  assert.equal(data.directionLabel, null);
});

test("trial preset direction matches the explicit link and is recognized by checkout", () => {
  const preset = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?direction=trial&date=2026-10-26",
  );
  const explicit = readGroupScheduleEntryDataFromHref(
    `https://padlhub.ru/group?directionId=${TRIAL_GROUP_DIRECTION_ID}&date=2026-10-26`,
  );

  assert.deepEqual(preset.directionIds, [4971]);
  assert.deepEqual(preset.directionIds, explicit.directionIds);
  assert.equal(preset.directionLabel, "Пробные групповые тренировки");
  assert.equal(preset.date, "2026-10-26");
  assert.equal(isTrialGroupTraining({ directionId: preset.directionIds[0] }), true);
});

test("frontend return-url helper preserves the trial filter, selected exercise and date", () => {
  // Dedicated server checkout return URLs have a separate, unchanged contract.
  const url = buildGroupScheduleReturnUrl("https://padlhub.ru/group?direction=trial", {
    exerciseId: "trial-exercise",
    date: "2026-10-26",
    paymentStatus: "failed",
  });
  const returned = readGroupScheduleEntryDataFromHref(url.href);

  assert.equal(url.searchParams.get("direction"), "trial");
  assert.equal(url.searchParams.get("groupPaymentFailed"), "true");
  assert.deepEqual(returned.directionIds, [TRIAL_GROUP_DIRECTION_ID]);
  assert.equal(returned.exerciseId, "trial-exercise");
  assert.equal(returned.date, "2026-10-26");
});

test("ignores unknown direction tokens and keeps links without direction filter unchanged", () => {
  const unknown = readGroupScheduleEntryDataFromHref(
    "https://padlhub.ru/group?direction=kids-club-2027&date=2026-09-21",
  );
  assert.deepEqual(unknown.directionIds, []);
  assert.equal(unknown.directionLabel, null);

  const empty = readGroupScheduleEntryDataFromHref("https://padlhub.ru/group?date=2026-09-21");
  assert.deepEqual(empty.directionIds, []);
  assert.equal(empty.directionLabel, null);
});

test("keeps direction filter in payment return urls", () => {
  const url = buildGroupScheduleReturnUrl(
    "https://padlhub.ru/group?direction=kids&date=2026-09-21",
    {
      exerciseId: "exercise-4",
      date: "2026-09-21",
      paymentStatus: "success",
    },
  );

  assert.equal(url.searchParams.get("direction"), "kids");
  assert.equal(url.searchParams.get("groupPaymentSuccess"), "true");
});

test("builds payment return URLs without stale payment flags", () => {
  const url = buildGroupScheduleReturnUrl(
    "https://padlhub.ru/group?groupPaymentFailed=true&4lGIgL_date=2026-06-27",
    {
      exerciseId: "exercise-3",
      date: "2026-06-28",
      paymentStatus: "success",
    },
  );

  assert.equal(url.searchParams.get("groupExerciseId"), "exercise-3");
  assert.equal(url.pathname, DEFAULT_GROUP_SCHEDULE_PATH);
  assert.equal(url.searchParams.get("date"), "2026-06-28");
  assert.equal(url.searchParams.get("4lGIgL_date"), null);
  assert.equal(url.searchParams.get("groupPaymentSuccess"), "true");
  assert.equal(url.searchParams.get("groupPaymentFailed"), null);
});

test("selected training survives refresh and payment return with the same id", () => {
  const entry = "https://padlhub.ru/group?exerciseId=from-link&authMode=viva";
  const selected = syncGroupScheduleSelectionHref(entry, { exerciseId: "exercise-7", date: "2026-11-21T10:00:00+03:00" });
  assert.ok(selected);
  const afterRefresh = readGroupScheduleEntryDataFromHref(selected);
  assert.equal(afterRefresh.exerciseId, "exercise-7");
  assert.equal(afterRefresh.date, "2026-11-21");
  assert.equal(new URL(selected).searchParams.get("authMode"), "viva");

  const success = buildGroupScheduleReturnUrl(selected, { exerciseId: "exercise-7", date: "2026-11-21", paymentStatus: "success" });
  const afterPayment = readGroupScheduleEntryDataFromHref(success.toString());
  assert.equal(afterPayment.exerciseId, "exercise-7");
  assert.equal(afterPayment.date, "2026-11-21");
});

test("reopening the paid training keeps its payment return flag", () => {
  const returned = "https://padlhub.ru/group?groupExerciseId=exercise-7&date=2026-11-21&groupPaymentSuccess=true";
  assert.equal(syncGroupScheduleSelectionHref(returned, { exerciseId: "exercise-7" }), null);
  assert.equal(syncGroupScheduleSelectionHref(returned, { exerciseId: "exercise-7", date: "2026-11-21" }), null);
  const moved = syncGroupScheduleSelectionHref(returned, { exerciseId: "exercise-7", date: "2026-11-22" });
  assert.equal(new URL(String(moved)).searchParams.get("groupPaymentSuccess"), "true");
});

test("choosing another training drops the previous payment flag", () => {
  const returned = "https://padlhub.ru/group?groupExerciseId=exercise-7&date=2026-11-21&groupPaymentFailed=true";
  const next = new URL(String(syncGroupScheduleSelectionHref(returned, { exerciseId: "exercise-8", date: "2026-11-21" })));
  assert.equal(next.searchParams.get("groupExerciseId"), "exercise-8");
  assert.equal(next.searchParams.has("groupPaymentFailed"), false);
});

test("closing the training clears every exercise alias so refresh shows the list", () => {
  const opened = "https://padlhub.ru/group?id=a&exerciseId=b&groupExerciseId=c&4lGIgL_exercise=d&date=2026-11-21&groupPaymentSuccess=true&studioId=s";
  const closed = String(syncGroupScheduleSelectionHref(opened, { exerciseId: null }));
  const data = readGroupScheduleEntryDataFromHref(closed);
  assert.equal(data.exerciseId, null);
  assert.equal(data.date, "2026-11-21");
  assert.equal(data.studioId, "s");
  assert.equal(new URL(closed).searchParams.has("groupPaymentSuccess"), false);
  assert.equal(syncGroupScheduleSelectionHref(closed, { exerciseId: null }), null);
});
