import assert from "node:assert/strict";
import test from "node:test";

import {
  GAME_BOOKING_MIN_LEAD_MINUTES,
  checkGameBookingLeadTime,
  hasRevalidatedGameSlot,
  parseMoscowGameStart,
} from "../../src/components/games/bookingLeadTime.ts";

test("parses game start in Moscow independently of the runtime timezone", () => {
  assert.equal(
    parseMoscowGameStart("2026-08-16", "20:20"),
    Date.parse("2026-08-16T20:20:00+03:00"),
  );
  assert.equal(parseMoscowGameStart("2026-08-16", "24:00"), null);
  assert.equal(parseMoscowGameStart("16.08.2026", "20:20"), null);
});

test("allows a slot exactly 30 minutes ahead", () => {
  const nowTs = Date.parse("2026-08-16T18:20:00+03:00");
  const result = checkGameBookingLeadTime("2026-08-16", "18:50", nowTs);

  assert.equal(GAME_BOOKING_MIN_LEAD_MINUTES, 30);
  assert.equal(result.ok, true);
  assert.equal(result.startTs, result.earliestStartTs);
});

test("rejects a stale slot after checkout takes longer than the lead-time boundary", () => {
  const nowTs = Date.parse("2026-08-16T18:22:45+03:00");
  const result = checkGameBookingLeadTime("2026-08-16", "18:50", nowTs);

  assert.equal(result.ok, false);
  assert.equal(result.startTs, Date.parse("2026-08-16T18:50:00+03:00"));
});

test("fails closed for malformed date or time", () => {
  const nowTs = Date.parse("2026-08-16T18:00:00+03:00");

  assert.equal(checkGameBookingLeadTime("bad", "20:20", nowTs).ok, false);
  assert.equal(checkGameBookingLeadTime("2026-08-16", "bad", nowTs).ok, false);
});

test("requires the same room, time, and enough refreshed duration", () => {
  const slots = [
    { roomId: "court-6", time: "20:20", durationMinutes: 120 },
    { roomId: "court-7", time: "20:20", durationMinutes: 60 },
  ];

  assert.equal(hasRevalidatedGameSlot(slots, {
    roomId: "court-6",
    time: "20:20",
    durationMinutes: 120,
  }), true);
  assert.equal(hasRevalidatedGameSlot(slots, {
    roomId: "court-7",
    time: "20:20",
    durationMinutes: 120,
  }), false);
  assert.equal(hasRevalidatedGameSlot(slots, {
    roomId: "court-6",
    time: "20:50",
    durationMinutes: 120,
  }), false);
});
