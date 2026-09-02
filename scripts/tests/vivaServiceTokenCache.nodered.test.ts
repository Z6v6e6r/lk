import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type Values = Record<string, unknown>;

const source = (name: string) => fs.readFileSync(
  `scripts/nodered_games_nodes/${name}`,
  "utf8",
);

const runtime = (values: Values = {}, envValues: Record<string, string> = {}) => {
  const store = { ...values };
  return {
    store,
    globalContext: {
      get(key: string) { return store[key]; },
      set(key: string, value: unknown) { store[key] = value; },
    },
    env: {
      get(key: string) { return envValues[key]; },
    },
  };
};

const run = (
  name: string,
  msg: Record<string, any>,
  context = runtime(),
) => new Function("msg", "global", "env", source(name))(
  msg,
  context.globalContext,
  context.env,
) as Array<Record<string, any> | null>;

const serviceEnv = {
  VIVA_SERVICE_USERNAME: "service+test@example.test",
  VIVA_SERVICE_PASSWORD: "p@ssword & test",
};

test("live ratings uses a fresh shared token without a password grant", () => {
  const context = runtime({
    vivacrm_access_token: "cached-token",
    vivacrm_token_expires_at: Date.now() + 300_000,
  });
  const output = run("fn_live_ratings_get_token.js", {
    _liveRatingsCtx: { players: [{ id: "player-1" }] },
  }, context);
  assert.equal(output[0]?.vivaToken, "cached-token");
  assert.deepEqual(output[0]?.payload, [{ id: "player-1" }]);
  assert.equal(output[1], null);
  assert.equal(output[2], null);
});

test("live ratings elects one refresh leader and encodes environment credentials", () => {
  const context = runtime({}, serviceEnv);
  const output = run("fn_live_ratings_get_token.js", {
    _liveRatingsCtx: { players: [] },
  }, context);
  const request = output[1];
  assert.equal(request?.method, "POST");
  assert.equal(output[2], null);
  assert.match(String(request?.payload), /username=service%2Btest%40example\.test/);
  assert.match(String(request?.payload), /password=p%40ssword%20%26%20test/);
  assert.ok(context.store.vivacrm_token_refresh_owner);
  assert.ok(Number(context.store.vivacrm_token_refresh_lock_until) > Date.now());
});

test("live ratings fails closed while another refresh is running or config is absent", () => {
  const locked = runtime({ vivacrm_token_refresh_lock_until: Date.now() + 10_000 });
  const lockedOutput = run("fn_live_ratings_get_token.js", { _liveRatingsCtx: {} }, locked);
  assert.equal(lockedOutput[2]?.statusCode, 503);
  assert.equal(lockedOutput[2]?.payload?.code, "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS");

  const missing = run("fn_live_ratings_get_token.js", { _liveRatingsCtx: {} });
  assert.equal(missing[2]?.statusCode, 503);
  assert.equal(missing[2]?.payload?.code, "VIVA_SERVICE_AUTH_NOT_CONFIGURED");
});

test("live ratings token failure clears only its lock and hides the upstream body", () => {
  const context = runtime({
    vivacrm_token_refresh_owner: "owner-1",
    vivacrm_token_refresh_lock_until: Date.now() + 10_000,
  });
  const output = run("fn_live_ratings_store_token.js", {
    statusCode: 401,
    payload: { error: "invalid_grant", error_description: "secret upstream detail" },
    _vivaTokenRefreshOwner: "owner-1",
  }, context);
  assert.equal(output[1]?.statusCode, 503);
  assert.equal(output[1]?.payload?.code, "VIVA_SERVICE_AUTH_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(output[1]?.payload), /invalid_grant|secret upstream detail/);
  assert.equal(context.store.vivacrm_token_refresh_owner, null);
  assert.equal(context.store.vivacrm_token_refresh_lock_until, 0);
});

const validSplitJoinMsg = () => ({
  payload: [{
    id: "game-1",
    settings: { payMode: "split" },
    booking: {
      studioId: "studio-1",
      date: "2026-08-22",
      timeFrom: "12:00",
      timeTo: "13:00",
    },
    metadata: { vivaExerciseId: "exercise-1" },
  }],
  _splitJoinBody: {
    clientPhone: "79990000001",
    studioId: "studio-1",
    paymentMode: "subscription",
    clientSubscriptionId: "client-subscription-1",
  },
});

test("split join sends a cached token directly to the router output", () => {
  const context = runtime({
    vivacrm_access_token: "cached-token",
    vivacrm_token_expires_at: Date.now() + 300_000,
  });
  const output = run("fn_split_join_prepare.js", validSplitJoinMsg(), context);
  assert.equal(output.length, 4);
  assert.equal(output[0], null);
  assert.equal(output[2], null);
  assert.equal(output[3]?._splitCtx?.tokenSource, "cache");
  assert.equal(output[3]?.payload?.access_token, "cached-token");
});

test("split join refresh path uses env and missing env fails without a Viva request", () => {
  const refreshOutput = run(
    "fn_split_join_prepare.js",
    validSplitJoinMsg(),
    runtime({}, serviceEnv),
  );
  assert.equal(refreshOutput[0]?.method, "POST");
  assert.equal(refreshOutput[0]?._splitCtx?.tokenSource, "refresh");
  assert.equal(refreshOutput[0]?.followRedirects, false);
  assert.equal(refreshOutput[0]?.maxRedirects, 0);
  assert.equal(refreshOutput[0]?.requestTimeout, 10000);
  assert.equal(refreshOutput[2], null);
  assert.equal(refreshOutput[3], null);

  const missingOutput = run("fn_split_join_prepare.js", validSplitJoinMsg());
  assert.equal(missingOutput[1]?.statusCode, 503);
  assert.equal(missingOutput[1]?.payload?.details?.code, "VIVA_SERVICE_AUTH_NOT_CONFIGURED");
});

test("split router persists a refreshed token and does not extend a cached token", () => {
  const refreshContext = runtime({
    vivacrm_token_refresh_owner: "owner-1",
    vivacrm_token_refresh_lock_until: Date.now() + 10_000,
  });
  const refreshed = run("fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "fresh-token", expires_in: 120 },
    _splitCtx: {
      step: "token",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      clientId: "client-1",
      tokenSource: "refresh",
      tokenRefreshOwner: "owner-1",
    },
  }, refreshContext);
  assert.equal(refreshed[0]?.headers?.Authorization, "Bearer fresh-token");
  assert.equal(refreshContext.store.vivacrm_access_token, "fresh-token");
  assert.ok(Number(refreshContext.store.vivacrm_token_expires_at) > Date.now());
  assert.equal(refreshContext.store.vivacrm_token_refresh_owner, null);

  const existingExpiry = Date.now() + 180_000;
  const cacheContext = runtime({ vivacrm_token_expires_at: existingExpiry });
  run("fn_split_router.js", {
    statusCode: 200,
    payload: { access_token: "cached-token" },
    _splitCtx: {
      step: "token",
      action: "confirm_payment",
      operationType: "TRANSACTION",
      operationId: "transaction-1",
      clientId: "client-1",
      tokenSource: "cache",
    },
  }, cacheContext);
  assert.equal(cacheContext.store.vivacrm_token_expires_at, existingExpiry);
});

test("split router masks token failures and releases its refresh lock", () => {
  const context = runtime({
    vivacrm_token_refresh_owner: "owner-1",
    vivacrm_token_refresh_lock_until: Date.now() + 10_000,
  });
  const output = run("fn_split_router.js", {
    statusCode: 401,
    payload: { error: "invalid_grant", error_description: "do not expose" },
    _splitCtx: { step: "token", tokenRefreshOwner: "owner-1" },
  }, context);
  assert.equal(output[1]?.statusCode, 503);
  assert.equal(output[1]?.payload?.details?.code, "VIVA_SERVICE_AUTH_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(output[1]?.payload), /invalid_grant|do not expose/);
  assert.equal(context.store.vivacrm_token_refresh_owner, null);
});

test("split cleanup uses the shared cache and blocks mutation when auth is unconfigured", () => {
  const payload = {
    mode: "GAME_CLEANUP",
    gameId: "game-1",
    bookingIds: ["booking-1"],
    bookingTargets: [{ bookingId: "booking-1", clientId: "client-1" }],
    reason: "PAYMENT_TIMEOUT",
  };
  const cached = run("fn_split_cleanup_router.js", { payload }, runtime({
    vivacrm_access_token: "cached-token",
    vivacrm_token_expires_at: Date.now() + 300_000,
  }));
  assert.equal(cached[0]?.headers?.Authorization, "Bearer cached-token");

  const missing = run("fn_split_cleanup_router.js", { payload });
  assert.equal(missing[0], null);
  assert.equal(missing[1], null);
  assert.equal(missing[2]?.payload?.blockLocalMutation, true);
  assert.equal(missing[2]?.payload?.blockReason, "viva_admin_token_not_configured");
});

test("target sources contain no reviewed inline service credential fallback", () => {
  const names = [
    "fn_live_ratings_get_token.js",
    "fn_live_ratings_store_token.js",
    "fn_split_create_prepare.js",
    "fn_split_join_prepare.js",
    "fn_split_router.js",
    "fn_split_cleanup_router.js",
  ];
  for (const name of names) {
    const body = source(name);
    assert.doesNotMatch(
      body,
      /DEFAULT_TOKEN_REQUEST_BODY|KEY_TOKEN_REQUEST_BODY|default_inline|grant_type=password&client_id=/,
      name,
    );
  }
});
