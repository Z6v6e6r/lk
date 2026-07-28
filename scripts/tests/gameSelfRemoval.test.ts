import test from "node:test";
import assert from "node:assert/strict";

import {
  appendGameSelfRemovalAuditLog,
  buildGameSelfRemovalAuditEntry,
} from "../../src/utils/gameSelfRemoval.ts";

test("buildGameSelfRemovalAuditEntry dedupes booking ids and extracts trace steps", () => {
  const entry = buildGameSelfRemovalAuditEntry({
    at: "2026-06-18T09:00:00.000Z",
    gameId: "pay_test",
    source: "game_join",
    actor: "self",
    playerId: "player-1",
    playerPhone: "79990000000",
    playerName: "Игрок",
    status: "cancelled_in_viva",
    verification: "verified_absent",
    bookingIds: ["b1", "b1", "b2"],
    trace: [
      { step: "cancel_action_selected" },
      { step: "cancel_booking_success" },
      { nope: true },
    ],
  });

  assert.deepEqual(entry.bookingIds, ["b1", "b2"]);
  assert.deepEqual(entry.traceSteps, ["cancel_action_selected", "cancel_booking_success"]);
});

test("appendGameSelfRemovalAuditLog keeps only the latest entries within limit", () => {
  const first = buildGameSelfRemovalAuditEntry({
    at: "2026-06-18T09:00:00.000Z",
    gameId: "pay_test",
    source: "game_join",
    actor: "self",
    playerId: "player-1",
    playerPhone: "79990000000",
    playerName: "Игрок",
    status: "cancelled_in_viva",
    verification: "verified_absent",
    bookingIds: ["b1"],
    trace: [],
  });
  const second = buildGameSelfRemovalAuditEntry({
    at: "2026-06-18T09:05:00.000Z",
    gameId: "pay_test",
    source: "game_details",
    actor: "self",
    playerId: "player-1",
    playerPhone: "79990000000",
    playerName: "Игрок",
    status: "already_absent_in_viva",
    verification: "skipped_no_exercise_id",
    bookingIds: ["b2"],
    trace: [],
  });

  const log = appendGameSelfRemovalAuditLog([first], second, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.id, second.id);
});
