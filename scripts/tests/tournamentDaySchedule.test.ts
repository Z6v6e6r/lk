import test from "node:test";
import assert from "node:assert/strict";
import { loadTournamentDaySchedule, mergeTournamentDaySchedule } from "../../src/utils/tournamentDaySchedule.ts";
import type { Exercise, ApiResult } from "../../src/utils/apiClient.ts";

const date = "2026-11-10", now = Date.parse("2026-11-10T21:00:00+03:00");
const exercise = (id: string, time = "20:00", extra: Partial<Exercise> = {}) => ({
  id, timeFrom: `${date}T${time}:00+03:00`, timeTo: `${date}T22:00:00+03:00`,
  direction: { id: 2617, name: "Турнир" }, trainers: [], ...extra,
} as Exercise);
const ok = (data: Exercise[]): ApiResult<Exercise[]> => ({ data, error: null, status: 200 });
const fail = (): ApiResult<Exercise[]> => ({ data: null, error: { status: 503, message: "Unavailable" }, status: 503 });
const load = (extra: Partial<Parameters<typeof loadTournamentDaySchedule>[0]> = {}) => loadTournamentDaySchedule({
  dateKey: date, previous: [], loadExercises: async () => ok([]), loadSource: async () => ok([exercise("started")]),
  loadBookings: async () => [], ...extra,
});

test("cold browser recovers started tournaments from the day-range source after Viva returns empty", async () => {
  let done!: (value: ApiResult<Exercise[]>) => void;
  const deferred = new Promise<ApiResult<Exercise[]>>(resolve => { done = resolve; });
  let settled = false;
  const loading = load({ loadSource: () => deferred }).then(result => { settled = true; return result; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, "empty direct feed must not finish before the source snapshot");
  done(ok([exercise("started")]));
  assert.deepEqual((await loading).items.map(item => item.id), ["started"]);
});

test("Viva rejection does not block the independent day snapshot", async () => {
  assert.equal((await load({ loadExercises: async () => fail() })).items.length, 1);
  assert.equal((await load({ loadExercises: async () => { throw new Error("network"); } })).items.length, 1);
});

test("read refresh retains omitted started tournaments but prunes disappeared future and other-day items", () => {
  const started = exercise("started"), future = exercise("future", "23:00"), yesterday = exercise("yesterday", "20:00", { timeFrom: "2026-11-09T20:00:00+03:00" });
  const result = mergeTournamentDaySchedule([], [started, future, yesterday], date, now);
  assert.deepEqual(result.map(item => item.id), ["started"]);
});

test("fresh cancellation, archival and rescheduling override retained started entries", () => {
  for (const signal of [{ cancelled: true }, { status: "CANCELED" }, { archived: true }, { timeFrom: "2026-11-11T20:00:00+03:00" }]) {
    const result = mergeTournamentDaySchedule([exercise("started", "20:00", signal)], [exercise("started")], date, now);
    assert.deepEqual(result, []);
  }
});

test("fresh trainer and score-independent metadata win; same-day duplicates are merged", async () => {
  const result = await load({ previous: [exercise("started")], loadExercises: async () => ok([exercise("started", "20:30", { trainers: [{ id: "new-trainer", firstName: "Test", lastName: "Trainer" }] })]) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].trainers[0].id, "new-trainer");
});

test("all source failures are an error, never a successful empty schedule", async () => {
  await assert.rejects(load({ loadExercises: async () => fail(), loadSource: async () => fail() }), /Unavailable/);
});


test("a source cancellation tombstone cannot be revived by stale active Viva or booking metadata", async () => {
  for (const cancellation of [{ cancelled: true, status: "CANCELLED" }, { cancelled: true, status: "AVAILABLE" }, { archived: true }]) {
    const result = await load({ previous: [exercise("started")],
      loadSource: async () => ok([exercise("started", "20:00", cancellation)]),
      loadExercises: async () => ok([exercise("started", "20:00", { status: "AVAILABLE", cancelled: false })]),
      loadBookings: async () => [exercise("started")],
    });
    assert.deepEqual(result.items, []);
  }
});

test("a nonempty snapshot publishes immediately and hanging optional reads have a deadline", async () => {
  const published: Exercise[][] = [];
  const loading = load({ timeoutMs: 15, onAvailable: items => published.push(items),
    loadExercises: () => new Promise(() => {}), loadBookings: () => new Promise(() => {}),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(published[0]?.[0].id, "started");
  const result = await loading;
  assert.equal(result.items[0].id, "started");
  assert.equal(result.partial, true);
});


test("loader retains an explicit off-day move as a tombstone before day filtering", async () => {
  const result = await load({ previous: [exercise("started")], loadSource: async () => ok([
    exercise("started", "20:00", { timeFrom: "2026-11-11T20:00:00+03:00" }),
  ]) });
  assert.deepEqual(result.items, []);
});


test("an unavailable snapshot plus an empty incomplete Viva feed is an error, not no tournaments", async () => {
  await assert.rejects(load({ loadSource: async () => fail() }), /Unavailable/);
});
