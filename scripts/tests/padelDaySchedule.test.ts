import assert from "node:assert/strict";
import test from "node:test";
import {
  getVisiblePadelDaySlots,
  normalizePadelDaySlots,
  PADEL_DAY_DIRECTION_ID,
  PADEL_DAY_TYPE_ID,
} from "../../src/utils/padelDayScheduleModel.ts";

function exercise(overrides: Record<string, unknown> = {}) {
  return {
    id: "exercise-1",
    direction: { id: PADEL_DAY_DIRECTION_ID, name: "День падела" },
    type: { id: PADEL_DAY_TYPE_ID, name: "Акционная" },
    timeFrom: "2026-07-29T08:00:00+03:00",
    timeTo: "2026-07-29T09:00:00+03:00",
    clientsCount: 1,
    maxClientsCount: 4,
    studio: { id: "studio-1", name: "Станция 1" },
    room: { id: "room-1", name: "Корт 1" },
    ...overrides,
  };
}

test("normalizes only direction 5245 and type 1279 for target date", () => {
  const slots = normalizePadelDaySlots({ content: [
    exercise(),
    exercise({ id: "wrong-direction", direction: { id: 999 } }),
    exercise({ id: "wrong-type", type: { id: 999 } }),
    exercise({ id: "wrong-date", timeFrom: "2026-07-28T07:00:00+03:00" }),
  ] }, "2026-07-29");
  assert.deepEqual(slots.map((slot) => slot.id), ["exercise-1"]);
  assert.equal(slots[0].spotsLeft, 3);
  assert.equal(slots[0].timeLabel, "08:00–08:45");
});

test("shows only starts from 08:00 through 20:00 and labels every slot as 45 minutes", () => {
  const slots = normalizePadelDaySlots([
    exercise({ id: "before", timeFrom: "2026-07-29T07:00:00+03:00" }),
    exercise({ id: "first", timeFrom: "2026-07-29T08:00:00+03:00" }),
    exercise({ id: "last", timeFrom: "2026-07-29T20:00:00+03:00" }),
    exercise({ id: "after-last", timeFrom: "2026-07-29T21:00:00+03:00" }),
    exercise({ id: "after", timeFrom: "2026-07-29T22:00:00+03:00" }),
  ], "2026-07-29");
  assert.deepEqual(slots.map((slot) => slot.id), ["first", "last"]);
  assert.equal(slots[1].timeLabel, "20:00–20:45");
});

test("hides full slots except the slot already booked by current client", () => {
  const full = exercise({ clientsCount: 4, maxClientsCount: 4 });
  const withoutBooking = normalizePadelDaySlots([full], "2026-07-29");
  assert.equal(getVisiblePadelDaySlots(withoutBooking, { studioId: null, timeKeys: [] }).length, 0);

  const withBooking = normalizePadelDaySlots([full], "2026-07-29", [{
    id: "booking-1",
    spot: 1,
    paymentType: "ONE_TIME",
    isCancelled: false,
    visitConfirmed: false,
    exercise: full as never,
    cost: 10000,
    cancellationDeadline: "2026-07-29T06:00:00+03:00",
  }]);
  assert.equal(withBooking[0].isMine, true);
  assert.equal(getVisiblePadelDaySlots(withBooking, { studioId: null, timeKeys: [] }).length, 1);
});

test("station and multi-time filters combine without exposing unavailable slots", () => {
  const slots = normalizePadelDaySlots([
    exercise(),
    exercise({ id: "exercise-2", timeFrom: "2026-07-29T09:00:00+03:00", timeTo: "2026-07-29T10:00:00+03:00" }),
    exercise({ id: "exercise-3", studio: { id: "studio-2", name: "Станция 2" } }),
  ], "2026-07-29");
  const filtered = getVisiblePadelDaySlots(slots, { studioId: "studio-1", timeKeys: ["09:00", "10:00"] });
  assert.deepEqual(filtered.map((slot) => slot.id), ["exercise-2"]);
});
