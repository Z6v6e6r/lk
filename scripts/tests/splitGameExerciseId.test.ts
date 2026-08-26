import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  const values: Record<string, unknown> = {};
  const globalContext = {
    get(key: string) { return values[key]; },
    set(key: string, value: unknown) { values[key] = value; },
  };
  const env = {
    get(key: string) {
      if (key === "VIVA_SERVICE_USERNAME") return "service@example.test";
      if (key === "VIVA_SERVICE_PASSWORD") return "test-password";
      return undefined;
    },
  };
  class FixedDate extends Date {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...(args.length ? args : ["2026-06-01T00:00:00.000Z"]));
    }

    static now() {
      return Date.parse("2026-06-01T00:00:00.000Z");
    }
  }
  return new Function("msg", "Date", "global", "env", source)(msg, FixedDate, globalContext, env);
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
      subscriptionId: "product-template-only",
      clientSubscriptionId: "client-subscription-1",
    },
  }) as unknown[];

  const prepared = out[0] as Record<string, any>;
  assert.ok(prepared);
  assert.equal(prepared._splitCtx.exerciseId, "exercise-from-metadata");
  assert.equal(prepared._splitCtx.clientPhone, "79104303190");
  assert.equal(prepared._splitCtx.clientSubscriptionId, "client-subscription-1");
});

test("legacy subscription confirmation derives visit count from the stored game duration", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_join_prepare.js", {
    payload: [{
      id: "game-confirm-1",
      booking: {
        timeFrom: "12:00",
        timeTo: "13:30",
      },
      metadata: {
        vivaExerciseId: "exercise-confirm-1",
      },
    }],
    _legacyPaymentConfirmTrusted: true,
    _legacyPaymentConfirm: {
      gameId: "game-confirm-1",
      reservationId: "reservation-1",
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "operation-1",
      bookingId: "booking-1",
      clientId: "client-1",
    },
  }) as unknown[];

  const prepared = out[0] as Record<string, any>;
  assert.ok(prepared);
  assert.equal(prepared._splitCtx.expectedExerciseId, "exercise-confirm-1");
  assert.equal(prepared._splitCtx.expectedSubscriptionVisitCount, 2);
  assert.equal(prepared._legacyPaymentConfirm.expectedSubscriptionVisitCount, 2);
});

test("split join rejects ambiguous subscription payment without an explicit client subscription id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_join_prepare.js", {
    payload: [{
      id: "game-1",
      settings: { payMode: "split" },
      booking: {
        studioId: "studio-1",
        date: "2026-06-04",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: { vivaExerciseId: "exercise-1" },
    }],
    _splitJoinBody: {
      clientPhone: "79990000002",
      studioId: "studio-1",
      paymentMode: "subscription",
      subscriptionId: "product-template-only",
    },
  }) as unknown[];

  const error = out[1] as Record<string, any>;
  assert.equal(error.statusCode, 400);
  assert.equal(error.payload.error, "clientSubscriptionId is required for subscription payment");
  assert.equal(error.payload.details.code, "SUBSCRIPTION_SELECTION_REQUIRED");
});

test("split create rejects ambiguous subscription payment without an explicit client subscription id", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_create_prepare.js", {
    payload: {
      date: "2026-06-04",
      fromTime: "12:00",
      toTime: "13:00",
      roomId: "room-1",
      studioId: "studio-1",
      clientPhone: "79990000002",
      paymentMode: "subscription",
      subscriptionId: "product-template-only",
    },
  }) as unknown[];

  const error = out[1] as Record<string, any>;
  assert.equal(error.statusCode, 400);
  assert.equal(error.payload.error, "clientSubscriptionId is required for subscription payment");
  assert.equal(error.payload.details.code, "SUBSCRIPTION_SELECTION_REQUIRED");
});

test("split create carries authenticated exact-pricing identifiers into server context", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_create_prepare.js", {
    req: { headers: { authorization: "Bearer user-token" } },
    payload: {
      date: "2026-08-22",
      fromTime: "12:00",
      toTime: "13:30",
      roomId: "room-1",
      studioId: "studio-1",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1", "sub-1", "sub-2"],
      clientPhone: "79990000002",
      paymentMode: "one_time",
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?._splitCtx?.userAuthHeader, "Bearer user-token");
  assert.equal(out[0]?._splitCtx?.masterServiceId, "master-1");
  assert.deepEqual(out[0]?._splitCtx?.subServiceIds, ["sub-1", "sub-2"]);
});

test("split join uses stored exact-pricing identifiers instead of browser replacements", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_join_prepare.js", {
    req: { headers: { authorization: "Bearer user-token" } },
    payload: [{
      id: "game-price-contract-1",
      booking: {
        studioId: "stored-studio",
        roomId: "stored-room",
        masterServiceId: "stored-master",
        subServiceIds: ["stored-sub"],
        date: "2026-08-22",
        timeFrom: "12:00",
        timeTo: "13:00",
      },
      metadata: { vivaExerciseId: "exercise-1", splitPayment: {} },
    }],
    _splitJoinBody: {
      clientPhone: "79990000002",
      paymentMode: "one_time",
      studioId: "browser-studio",
      roomId: "browser-room",
      masterServiceId: "browser-master",
      subServiceIds: ["browser-sub"],
    },
  }) as Array<Record<string, any> | null>;

  assert.equal(out[0]?._splitCtx?.studioId, "stored-studio");
  assert.equal(out[0]?._splitCtx?.roomId, "stored-room");
  assert.equal(out[0]?._splitCtx?.masterServiceId, "stored-master");
  assert.deepEqual(out[0]?._splitCtx?.subServiceIds, ["stored-sub"]);
  assert.equal(out[0]?._splitCtx?.userAuthHeader, "Bearer user-token");
});

test("split join fails closed when Viva token request configuration is missing", () => {
  const prepareSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_join_prepare.js", "utf8");
  const prepared = new Function("msg", "env", "global", prepareSource)(
    {
      payload: [{
        id: "game-token-config",
        settings: { payMode: "split" },
        booking: {
          studioId: "studio-1",
          roomId: "room-1",
          date: "2026-06-04",
          timeFrom: "12:00",
          timeTo: "13:00",
        },
        metadata: { vivaExerciseId: "exercise-1" },
      }],
      _splitJoinBody: {
        clientPhone: "79990000003",
        studioId: "studio-1",
        paymentMode: "one_time",
      },
    },
    { get: () => null },
    { get: () => null },
  ) as unknown[];

  const error = prepared[1] as Record<string, any>;
  assert.equal(error.statusCode, 503);
  assert.equal(error.payload.details.code, "VIVA_SERVICE_AUTH_NOT_CONFIGURED");
  assert.equal(error.url, undefined);
});

test("split sources load Viva service credentials from env and contain no inline credentials", () => {
  for (const file of [
    "scripts/nodered_games_nodes/fn_split_cleanup_router.js",
    "scripts/nodered_games_nodes/fn_split_create_prepare.js",
    "scripts/nodered_games_nodes/fn_split_join_prepare.js",
  ]) {
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /grant_type=password|username=|password=/);
    assert.match(source, /VIVA_SERVICE_USERNAME/);
    assert.match(source, /VIVA_SERVICE_PASSWORD/);
  }
});
