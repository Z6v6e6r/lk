import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGroupScheduleReturnUrl,
  DEFAULT_GROUP_SCHEDULE_PATH,
  normalizeGroupScheduleDate,
  readGroupScheduleEntryDataFromHref,
} from "../../src/utils/groupScheduleEntry.ts";

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
