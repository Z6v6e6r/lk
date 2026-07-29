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

test("split cleanup auth rejects requests without a Bearer token", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_cleanup_auth_prepare.js",
    {
      req: { headers: {} },
      payload: { gameId: "game-1" },
    },
  ) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.equal(response.statusCode, 401);
  assert.equal(
    asRecord(response.payload).code,
    "SPLIT_CLEANUP_AUTH_TOKEN_REQUIRED",
  );
});

test("split cleanup auth validates the Bearer token against the Viva profile", () => {
  const requestOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_cleanup_auth_prepare.js",
    {
      req: { headers: { authorization: "Bearer user-token" } },
      payload: {
        gameId: "game-1",
        intent: "cancel_game",
        actorBookingId: "booking-1",
      },
    },
  ) as unknown[];

  const profileRequest = asRecord(requestOut[0]);
  assert.equal(profileRequest.method, "GET");
  assert.equal(
    profileRequest.url,
    "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile",
  );
  assert.equal(
    asRecord(profileRequest.headers).Authorization,
    "Bearer user-token",
  );

  profileRequest.statusCode = 200;
  profileRequest.payload = {
    id: "organizer-1",
    phone: "+7 (999) 000-00-01",
  };
  const resolveOut = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_cleanup_auth_resolve.js",
    profileRequest,
  ) as unknown[];

  const resolved = asRecord(resolveOut[0]);
  assert.deepEqual(resolved.payload, {
    gameId: "game-1",
    intent: "cancel_game",
    actorBookingId: "booking-1",
  });
  const auth = asRecord(resolved._splitCleanupAuth);
  assert.equal(auth.verified, true);
  assert.equal(auth.actorClientId, "organizer-1");
  assert.equal(auth.actorPhoneNorm, "79990000001");
  assert.equal(auth.authHeader, "Bearer user-token");
});

test("split cleanup auth does not continue after Viva rejects the token", () => {
  const out = runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_split_cleanup_auth_resolve.js",
    {
      statusCode: 401,
      payload: { error: "unauthorized" },
      _splitCleanupAuth: {
        authHeader: "Bearer expired-token",
        requestPayload: { gameId: "game-1" },
      },
    },
  ) as unknown[];

  assert.equal(out[0], null);
  const response = asRecord(out[1]);
  assert.equal(response.statusCode, 401);
  assert.equal(
    asRecord(response.payload).code,
    "SPLIT_CLEANUP_AUTH_TOKEN_INVALID",
  );
});
