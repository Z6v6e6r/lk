import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function preparedLeaveMsg(overrides: Record<string, unknown> = {}) {
  return {
    req: {
      params: { gameId: "game-1" },
      headers: { authorization: "Bearer user-token" },
    },
    payload: {
      bookingIds: ["booking-1"],
      bookingItems: [{ bookingId: "booking-1", clientId: "player-1" }],
      exerciseId: "exercise-1",
      playerId: "player-1",
    },
    _splitCleanupAuth: {
      verified: true,
      authHeader: "Bearer user-token",
      actorClientId: "organizer-1",
      actorPhoneNorm: "79990000001",
    },
    ...overrides,
  };
}

function linkedGame(overrides: Record<string, unknown> = {}) {
  return {
    id: "game-1",
    organizer: {
      id: "organizer-1",
      phone: "79990000001",
    },
    booking: {
      exerciseId: "exercise-1",
    },
    metadata: {
      splitPayment: {
        vivaExerciseId: "exercise-1",
        payments: [
          {
            clientId: "player-1",
            bookingId: "booking-1",
          },
        ],
      },
    },
    ...overrides,
  };
}

test("split leave prepare requires verified Viva profile auth", () => {
  const msg = preparedLeaveMsg({ _splitCleanupAuth: undefined });
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_prepare.js",
    msg,
  ) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.equal(response.statusCode, 401);
});

test("split leave prepare builds an exact game query before requesting Admin token", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_prepare.js",
    preparedLeaveMsg(),
  ) as unknown[];

  const queryMsg = asRecord(out[0]);
  assert.deepEqual(queryMsg.payload, {
    id: "game-1",
    archived: { $ne: true },
  });
  const ctx = asRecord(queryMsg._splitLeaveCtx);
  assert.equal(ctx.step, "authorize_leave");
  assert.equal(ctx.actorClientId, "organizer-1");
  assert.equal(queryMsg.url, undefined);
});

test("split leave authorizer accepts only linked bookings of an organizer-owned game", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_prepare.js",
    preparedLeaveMsg(),
  ) as unknown[];
  const queryMsg = asRecord(prepareOut[0]);
  queryMsg.payload = [linkedGame()];

  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_authorize.js",
    queryMsg,
  ) as unknown[];

  const tokenMsg = asRecord(out[0]);
  assert.equal(tokenMsg.method, "POST");
  assert.equal(
    tokenMsg.url,
    "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token",
  );
  const ctx = asRecord(tokenMsg._splitLeaveCtx);
  assert.equal(ctx.step, "token_request");
  assert.deepEqual(ctx.bookingQueue, [
    { bookingId: "booking-1", clientId: "player-1" },
  ]);
  assert.equal(ctx.exerciseId, "exercise-1");
});

test("split leave authorizer rejects a non-organizer", () => {
  const msg = preparedLeaveMsg();
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_prepare.js",
    msg,
  ) as unknown[];
  const queryMsg = asRecord(prepareOut[0]);
  const ctx = asRecord(queryMsg._splitLeaveCtx);
  ctx.actorClientId = "another-client";
  ctx.actorPhoneNorm = "78880000000";
  queryMsg.payload = [linkedGame()];

  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_authorize.js",
    queryMsg,
  ) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.equal(response.statusCode, 403);
  assert.equal(
    asRecord(response.payload).code,
    "SPLIT_LEAVE_ORGANIZER_REQUIRED",
  );
});

test("split leave authorizer rejects a booking not linked to the game", () => {
  const prepareOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_prepare.js",
    preparedLeaveMsg(),
  ) as unknown[];
  const queryMsg = asRecord(prepareOut[0]);
  queryMsg.payload = [linkedGame({
    metadata: {
      splitPayment: {
        vivaExerciseId: "exercise-1",
        payments: [],
      },
    },
  })];

  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_leave_authorize.js",
    queryMsg,
  ) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.equal(response.statusCode, 403);
  assert.equal(
    asRecord(response.payload).code,
    "SPLIT_LEAVE_BOOKING_NOT_LINKED",
  );
});
