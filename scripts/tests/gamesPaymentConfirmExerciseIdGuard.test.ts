import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runCreate(msg: Record<string, unknown>) {
  const source = fs.readFileSync("scripts/nodered_games_nodes/fn_create.js", "utf8");
  return new Function("msg", source)(msg) as unknown[];
}

const verifiedPayment = {
  verified: true,
  source: "viva_transaction_readback",
  paymentRef: "payment-ref-1",
  transactionId: "transaction-1",
  bookingId: "booking-1",
  exerciseId: "exercise-1",
};

const confirmPayload = (exerciseId?: string) => ({
  id: "game-1",
  revision: 3,
  updatedAt: "2026-08-26T12:00:00.000Z",
  paymentRef: "payment-ref-1",
  status: "PAID",
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
    date: "2026-08-01",
    timeFrom: "14:00",
    timeTo: "16:00",
    bookingIds: ["booking-1"],
    ...(exerciseId ? { exerciseId } : {}),
  },
  payment: {
    paymentRef: "payment-ref-1",
    bookingIds: ["booking-1"],
    paid: true,
  },
});

test("paid confirm with bookingIds cannot upsert without a Viva exerciseId", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload(),
    _gamePaymentVerified: verifiedPayment,
  });

  assert.equal(out[0], null, "Mongo upsert output must stay closed");
  assert.equal(out[3], null, "station autojoin must not run for a rejected confirm");
  assert.equal((out[1] as any).statusCode, 409);
  assert.equal((out[1] as any).payload.code, "GAME_EXERCISE_ID_MISSING");
  assert.deepEqual((out[1] as any).payload.bookingIds, ["booking-1"]);
  assert.equal((out[1] as any).payload.lookupRequired, true);
});

test("paid confirm persists an explicit Viva exerciseId", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload("exercise-1"),
    _gamePaymentVerified: verifiedPayment,
  });

  assert.ok(out[0]);
  assert.equal(out[1], null, "confirm response waits for Mongo acknowledgement");
  assert.equal((out[0] as any)._recordForResponse.booking.exerciseId, "exercise-1");
  assert.equal((out[0] as any)._recordForResponse.metadata.exerciseId, "exercise-1");
  assert.equal((out[0] as any)._recordForResponse.dedupeKey, "viva:exercise-1");
});

test("an internal Viva lookup result can enrich confirm before upsert", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload(),
    _gameConfirmExerciseLookup: {
      exerciseId: "exercise-from-viva-lookup",
      bookingIds: ["booking-1"],
      active: true,
      notCancelled: true,
    },
    _gamePaymentVerified: verifiedPayment,
  });

  assert.ok(out[0]);
  assert.equal(out[1], null, "confirm response waits for Mongo acknowledgement");
  assert.equal(
    (out[0] as any)._recordForResponse.booking.exerciseId,
    "exercise-from-viva-lookup",
  );
});

test("an internal Viva lookup cannot enrich a different booking set", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload(),
    _gameConfirmExerciseLookup: {
      exerciseId: "exercise-from-other-booking",
      bookingIds: ["booking-2"],
      active: true,
      notCancelled: true,
    },
    _gamePaymentVerified: verifiedPayment,
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).statusCode, 409);
  assert.equal((out[1] as any).payload.code, "GAME_EXERCISE_ID_MISSING");
});

test("a cancelled Viva lookup result cannot enrich confirm", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload(),
    _gameConfirmExerciseLookup: {
      exerciseId: "cancelled-exercise",
      bookingIds: ["booking-1"],
      active: false,
      isCancelled: true,
    },
    _gamePaymentVerified: verifiedPayment,
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).statusCode, 409);
  assert.equal((out[1] as any).payload.code, "GAME_EXERCISE_ID_MISSING");
});

test("non-boolean Viva activity flags fail closed", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload(),
    _gameConfirmExerciseLookup: {
      exerciseId: "unverified-exercise",
      bookingIds: ["booking-1"],
      active: "true",
      notCancelled: "true",
    },
    _gamePaymentVerified: verifiedPayment,
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).statusCode, 409);
  assert.equal((out[1] as any).payload.code, "GAME_EXERCISE_ID_MISSING");
});

test("draft writes remain backward-compatible while exerciseId is unresolved", () => {
  const out = runCreate({
    req: { path: "/lk/games/draft", query: {} },
    payload: {
      ...confirmPayload(),
      status: "PAYMENT_PENDING",
      payment: {
        paymentRef: "payment-ref-1",
        bookingIds: ["booking-1"],
        paid: false,
      },
    },
  });

  assert.ok(out[0]);
  assert.equal((out[1] as any).statusCode, 200);
  assert.equal((out[1] as any).payload.booking.exerciseId, null);
});

test("draft mode force-clears client paid markers", () => {
  const out = runCreate({
    req: { path: "/lk/games/drafts", query: {} },
    payload: {
      ...confirmPayload("exercise-1"),
      status: "PAID",
      payment: { ...confirmPayload("exercise-1").payment, paid: true },
    },
  });
  assert.ok(out[0]);
  assert.equal((out[1] as any).payload.status, "PAYMENT_PENDING");
  assert.equal((out[1] as any).payload.payment.paid, false);
});

for (const source of ["games_widget", "games_widget_zero_pay"]) {
  test(`paid ${source} legacy create cannot bypass the exerciseId guard`, () => {
    const payload = confirmPayload();
    const out = runCreate({
      req: { path: "/lk/games", query: {} },
      payload: {
        ...payload,
        metadata: {
          source,
          paymentRef: payload.paymentRef,
          bookingIds: ["booking-1"],
        },
      },
    });

    assert.equal(out[0], null);
    assert.equal(out[3], null);
    assert.equal((out[1] as any).statusCode, 409);
    assert.equal((out[1] as any).payload.code, "GAME_PAYMENT_EVIDENCE_REQUIRED");
  });
}

test("positive paid split create is blocked even when source metadata is omitted", () => {
  const payload = confirmPayload();
  const out = runCreate({
    req: { path: "/lk/games", query: {} },
    payload: {
      ...payload,
      metadata: {
        source: "games_split_widget",
        paymentRef: payload.paymentRef,
        bookingIds: ["booking-1"],
      },
      settings: { payMode: "split" },
    },
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).payload.code, "GAME_PAYMENT_EVIDENCE_REQUIRED");
});

test("client action cannot escape route-authoritative draft mode", () => {
  const payload = confirmPayload("exercise-1");
  const out = runCreate({
    req: { path: "/lk/games/drafts", query: {} },
    payload: {
      ...payload,
      action: "create",
      status: "PAID",
      payment: { ...payload.payment, amount: 375, paid: true },
      metadata: {},
    },
  });
  assert.ok(out[0]);
  assert.equal((out[1] as any).payload.status, "PAYMENT_PENDING");
  assert.equal((out[1] as any).payload.payment.paid, false);
});

test("paid split create cannot bypass evidence by declaring zero amount", () => {
  const payload = confirmPayload("exercise-1");
  const out = runCreate({
    req: { path: "/lk/games", query: {} },
    payload: {
      ...payload,
      payment: { ...payload.payment, amount: 0, paid: true },
      metadata: {
        paymentRef: payload.paymentRef,
        splitPayment: { enabled: true },
      },
      settings: { payMode: "split" },
    },
  });
  assert.equal(out[0], null);
  assert.equal((out[1] as any).payload.code, "GAME_PAYMENT_EVIDENCE_REQUIRED");
});

test("public confirm cannot mark a game paid without server-owned Viva evidence", () => {
  const out = runCreate({
    req: { path: "/lk/games/payment/confirm", query: {} },
    payload: confirmPayload("exercise-1"),
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).statusCode, 409);
  assert.equal((out[1] as any).payload.code, "GAME_PAYMENT_EVIDENCE_REQUIRED");
});

test("positive paid split create cannot bypass the verified confirm route", () => {
  const payload = confirmPayload("exercise-1");
  const out = runCreate({
    req: { path: "/lk/games", query: {} },
    payload: {
      ...payload,
      payment: { ...payload.payment, amount: 375 },
      metadata: { source: "games_split_widget", paymentRef: payload.paymentRef },
      settings: { payMode: "split" },
    },
  });

  assert.equal(out[0], null);
  assert.equal((out[1] as any).payload.code, "GAME_PAYMENT_EVIDENCE_REQUIRED");
});
