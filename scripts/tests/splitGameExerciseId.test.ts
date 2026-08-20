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
  return new Function("msg", "global", "env", source)(msg, globalContext, env);
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

  const policyRequest = prepared[0] as Record<string, any>;
  assert.equal(policyRequest._splitCtx.step, "pricing_policy");

  const routerSource = fs.readFileSync("scripts/nodered_games_nodes/fn_split_router.js", "utf8");
  const routed = new Function("msg", "env", "global", routerSource)(
    {
      ...policyRequest,
      statusCode: 200,
      payload: { enabled: false, selectedPromoId: null },
    },
    { get: () => null },
    { get: () => null, set: () => undefined },
  ) as unknown[];

  const error = routed[1] as Record<string, any>;
  assert.equal(error.statusCode, 503);
  assert.equal(error.payload.details.code, "VIVA_SERVICE_AUTH_NOT_CONFIGURED");
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
