import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

test("game create promotes splitPayment vivaExerciseId into booking and metadata", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_create.js", {
    req: { path: "/lk/games", query: {} },
    payload: {
      paymentRef: "split-ref-1",
      organizer: {
        id: "organizer-1",
        name: "Organizer",
        phone: "79850000000",
      },
      booking: {
        studioId: "studio-1",
        studioName: "Studio",
        roomId: "room-1",
        roomName: "Court",
        date: "2026-06-04",
        timeFrom: "12:00",
        timeTo: "14:00",
        bookingIds: ["booking-1"],
      },
      payment: {
        amount: 0,
        paid: true,
        bookingIds: ["booking-1"],
      },
      settings: { payMode: "split" },
      metadata: {
        splitPayment: {
          vivaExerciseId: "exercise-1",
          organizerBookingId: "booking-1",
        },
      },
    },
  }) as unknown[];

  const response = out[1] as Record<string, any>;
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.booking.vivaExerciseId, "exercise-1");
  assert.equal(response.payload.booking.exerciseId, "exercise-1");
  assert.equal(response.payload.metadata.vivaExerciseId, "exercise-1");
  assert.equal(response.payload.metadata.exerciseId, "exercise-1");
  assert.equal(response.payload.dedupeKey, "viva:exercise-1");
});

test("split join accepts exerciseId stored in top-level metadata", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_join_prepare.js", {
    payload: [{
      id: "game-1",
      settings: { payMode: "split" },
      booking: {
        studioId: "studio-1",
        date: "2026-06-04",
        timeFrom: "12:00",
        timeTo: "14:00",
      },
      metadata: {
        vivaExerciseId: "exercise-from-metadata",
      },
    }],
    _splitJoinBody: {
      clientPhone: "79104303190",
      studioId: "studio-1",
      paymentMode: "subscription",
    },
  }) as unknown[];

  const prepared = out[0] as Record<string, any>;
  assert.ok(prepared);
  assert.equal(prepared._splitCtx.exerciseId, "exercise-from-metadata");
  assert.equal(prepared._splitCtx.clientPhone, "79104303190");
});
