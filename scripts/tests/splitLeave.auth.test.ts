import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const apiSource = ts.createSourceFile("apiClient.ts", fs.readFileSync("src/utils/apiClient.ts", "utf8"), ts.ScriptTarget.Latest, true);

async function organizerWireBody(payload: Record<string, unknown>) {
  const fn = apiSource.statements.find((item) => ts.isFunctionDeclaration(item)
    && item.name?.text === "apiCancelPadelSplitParticipantBookings");
  assert.ok(fn);
  const code = ts.transpileModule(fn.getText(apiSource).replace(/^export /, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const calls: Array<{ path: string; options: { method: string; auth: boolean; retries: number; body: string } }> = [];
  const invoke = new Function("getServ2Origin", "request", `${code}; return apiCancelPadelSplitParticipantBookings;`)(
    () => "https://fixture.invalid",
    async (path: string, options: typeof calls[number]["options"]) => {
      calls.push({ path, options });
      return { data: { ok: true, state: "DONE" }, error: null, status: 200 };
    },
  );
  await invoke(" game-1 ", payload);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/lk/games/game-1/split/leave");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.auth, true);
  assert.equal(calls[0].options.retries, 0);
  return JSON.parse(calls[0].options.body) as Record<string, unknown>;
}

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  const globalContext = {
    get(key: string) {
      return key === "vivacrm_access_token" ? "server-token" : null;
    },
  };
  return new Function("msg", "global", source)(msg, globalContext);
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

test("split leave authorizer accepts only linked bookings with a server token", () => {
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

  const authorizedMsg = asRecord(out[0]);
  assert.equal(authorizedMsg.method, undefined);
  assert.equal(authorizedMsg.url, undefined);
  const ctx = asRecord(authorizedMsg._splitLeaveCtx);
  assert.equal(ctx.step, "start_cancel");
  assert.equal(ctx.upstreamAuthHeader, "Bearer server-token");
  assert.deepEqual(ctx.bookingQueue, [
    { bookingId: "booking-1", clientId: "player-1" },
  ]);
  assert.equal(ctx.exerciseId, "exercise-1");
});

test("split leave authorizer rejects an actor not linked to the game", () => {
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
  assert.equal(asRecord(response.payload).state, "CONFLICT");
  assert.equal(asRecord(response.payload).message, "Профиль не связан с этой игрой");
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
  assert.equal(asRecord(response.payload).state, "CONFLICT");
  assert.equal(asRecord(response.payload).message, "Запись игрока не связана с этой игрой");
});

for (const exerciseId of [undefined, null, "exercise-1", "stale-client-exercise"]) {
  test(`organizer wire omits ${String(exerciseId)} exerciseId and server derives the stored exercise`, async () => {
    const body = await organizerWireBody({
      exerciseId,
      bookingIds: [" booking-1 ", "booking-1"],
      bookingItems: [{ bookingId: "booking-1", clientId: "player-1" }],
      playerId: "player-1",
      reason: "REMOVED_BY_ORGANIZER",
    });
    assert.equal(Object.hasOwn(body, "exerciseId"), false);
    assert.equal(Object.hasOwn(body, "gameId"), false);
    assert.deepEqual(body.bookingIds, ["booking-1"]);
    const query = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_prepare.js", preparedLeaveMsg({ payload: body }))[0];
    assert.ok(query, "the actual client payload must pass prepare");
    assert.deepEqual(query.payload, { id: "game-1", archived: { $ne: true } });
    query.payload = [linkedGame()];
    const authorized = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_authorize.js", query)[0];
    assert.ok(authorized);
    assert.equal(authorized._splitLeaveCtx.exerciseId, "exercise-1");
    assert.equal(authorized._splitLeaveCtx.mode, "ORGANIZER_TARGET");
    assert.equal(authorized._splitLeaveCtx.targetClientId, "player-1");
    assert.deepEqual(authorized._splitLeaveCtx.bookingQueue, [{ bookingId: "booking-1", clientId: "player-1" }]);
    authorized._splitLeaveCtx.step = "start_verify_active";
    const active = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", authorized)[0];
    assert.equal(active.method, "GET");
    assert.match(active.url, /\/exercises\/exercise-1\/bookings\?showCancelled=false/);
    active.statusCode = 200;
    active.payload = [];
    const history = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_router.js", active)[0];
    assert.equal(history.method, "GET");
    assert.match(history.url, /\/exercises\/exercise-1\/bookings\?showCancelled=true/);
  });
}

test("omitting client exerciseId cannot bypass missing exercise or organizer/booking binding", async () => {
  const body = await organizerWireBody({ bookingIds: ["booking-1"], exerciseId: "cannot-repair-missing-binding" });
  const cases = [
    { game: linkedGame({ booking: {}, metadata: { splitPayment: { payments: [{ clientId: "player-1", bookingId: "booking-1" }] } } }), status: 409 },
    { game: linkedGame(), body: { ...body, bookingIds: ["foreign-booking"] }, status: 403 },
    { game: linkedGame({ organizer: { id: "another-organizer" }, participants: [{ id: "organizer-1" }] }), status: 403 },
  ];
  for (const scenario of cases) {
    const prepared = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_prepare.js", preparedLeaveMsg({ payload: scenario.body ?? body }))[0];
    prepared.payload = [scenario.game];
    const rejected = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_authorize.js", prepared);
    assert.equal(rejected[0], null, "no provider operation may be produced");
    assert.equal(rejected[1].statusCode, scenario.status);
  }
});

test("server still rejects caller-supplied exerciseId/gameId even when null", () => {
  for (const key of ["exerciseId", "gameId"]) {
    const rejected = runNodeRedFunction("scripts/nodered_games_nodes/fn_split_leave_prepare.js", preparedLeaveMsg({ payload: { bookingIds: ["booking-1"], [key]: null } }));
    assert.equal(rejected[0], null);
    assert.equal(rejected[1].statusCode, 400);
  }
});
