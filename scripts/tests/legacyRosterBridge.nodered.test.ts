import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function run(
  file: string,
  msg: Record<string, any>,
  envValues: Record<string, string> = {},
) {
  const source = fs.readFileSync(file, "utf8");
  const env = { get: (key: string) => envValues[key] ?? null };
  return new Function("msg", "env", source)(msg, env);
}

const enabledEnv = {
  PADLHUB_LEGACY_ROSTER_BRIDGE_ENABLED: "true",
  PADLHUB_PLATFORM_INTERNAL_API_BASE_URL: "http://127.0.0.1:3000/internal/api/v1",
  PADLHUB_PLATFORM_TENANT_KEY: "local-padel",
  PADLHUB_LEGACY_ROSTER_TOKEN: "server-only-token-at-least-32-chars",
};

test("legacy roster bridge is default-off and rejects client-owned facts", () => {
  const disabled = run("scripts/nodered_games_nodes/fn_legacy_roster_bridge_prepare.js", {
    req: { params: { gameId: "pay_game" }, headers: {} },
    payload: { command: "JOIN_GAME" },
  }) as any[];
  assert.equal(disabled[1].statusCode, 503);
  assert.equal(disabled[1].payload.code, "LEGACY_GAME_BRIDGE_DISABLED");

  const tampered = run(
    "scripts/nodered_games_nodes/fn_legacy_roster_bridge_prepare.js",
    {
      req: {
        params: { gameId: "pay_game" },
        headers: {
          authorization: "Bearer signed-token",
          "idempotency-key": "legacy-roster:1234567890",
        },
      },
      payload: { command: "JOIN_GAME", level: "A", playerId: "victim" },
    },
    enabledEnv,
  ) as any[];
  assert.equal(tampered[1].statusCode, 400);
  assert.equal(tampered[1].payload.code, "LEGACY_GAME_COMMAND_INVALID");
});

test("legacy roster bridge forwards only signed identity and server credential", () => {
  const result = run(
    "scripts/nodered_games_nodes/fn_legacy_roster_bridge_prepare.js",
    {
      req: {
        params: { gameId: "pay_game" },
        headers: {
          authorization: "Bearer signed-token",
          "idempotency-key": "legacy-roster:1234567890",
        },
      },
      payload: { command: "JOIN_WAITLIST" },
    },
    enabledEnv,
  ) as any[];
  assert.equal(result[1], null);
  assert.equal(
    result[0].url,
    "http://127.0.0.1:3000/internal/api/v1/local-padel/legacy-games/pay_game/roster-commands",
  );
  assert.equal(result[0].headers.Authorization, "Bearer signed-token");
  assert.equal(
    result[0].headers["X-Phub-Legacy-Roster-Token"],
    "server-only-token-at-least-32-chars",
  );
  assert.deepEqual(result[0].payload, { command: "JOIN_WAITLIST" });
});

test("payment confirmation accepts locators only and never accepts a browser paid flag", () => {
  const valid = run(
    "scripts/nodered_games_nodes/fn_legacy_payment_confirm_query.js",
    {
      req: {
        params: { gameId: "pay_game" },
        headers: {
          authorization: "Bearer signed-token",
          "idempotency-key": "legacy-payment:1234567890",
        },
      },
      payload: {
        reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
        operationType: "TRANSACTION",
        operationId: "tx-1",
        bookingId: "booking-1",
        clientId: "client-1",
      },
    },
    enabledEnv,
  ) as any[];
  assert.equal(valid[1], null);
  assert.deepEqual(valid[0].payload, { id: "pay_game", archived: { $ne: true } });
  assert.equal(valid[0]._legacyPaymentConfirmTrusted, true);

  const forged = run(
    "scripts/nodered_games_nodes/fn_legacy_payment_confirm_query.js",
    {
      req: {
        params: { gameId: "pay_game" },
        headers: {
          authorization: "Bearer signed-token",
          "idempotency-key": "legacy-payment:1234567890",
        },
      },
      payload: {
        reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
        operationType: "TRANSACTION",
        operationId: "tx-1",
        bookingId: "booking-1",
        clientId: "client-1",
        paid: true,
      },
    },
    enabledEnv,
  ) as any[];
  assert.equal(forged[1].statusCode, 400);
});

function projectionContext(relation: "PARTICIPANT" | "WAITLISTED" | "SEAT_RESERVED") {
  const bridge = {
    gameId: "pay_game",
    idempotencyKey: "legacy-roster:1234567890",
    command: relation === "WAITLISTED" ? "JOIN_WAITLIST" : "JOIN_GAME",
    retryCount: 0,
  };
  const projection = {
    commandId: "d39e4287-e65c-4e75-88e4-4447e4c91ddb",
    replayed: false,
    legacyGameId: "pay_game",
    canonicalGameId: "6418f90b-0fa6-4c04-a3da-57707e2f0ae2",
    aggregateRevision: 5,
    relation,
    player: {
      userId: "49d4e88c-7d52-4c1c-8f80-2fc99b42f9ca",
      displayName: "Анна Игрокова",
      phoneE164: "+79000000001",
      levelLabel: "C+",
      levelValue: 3.63,
    },
  };
  return { bridge, projection };
}

test("canonical projection uses a guarded CAS and rebuilds the result roster snapshot", () => {
  const { bridge, projection } = projectionContext("PARTICIPANT");
  const result = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: bridge,
    _legacyRosterProjection: projection,
    payload: [{
      id: "pay_game",
      updatedAt: "2026-08-16T18:00:00.000Z",
      revision: 7,
      participants: [{ id: "other", phone: "79000000002", name: "Другой" }],
      waitlist: [],
      metadata: {},
      organizer: { id: "organizer", name: "Организатор", phone: "79000000003" },
      resultRosterSnapshot: { organizerInMatch: false, initialTeamSlots: [null, null, null, null] },
    }],
  }) as any[];
  assert.equal(result[1], null);
  assert.equal(result[2], null);
  const [query, update, options] = result[0].payload;
  assert.deepEqual(query, {
    id: "pay_game",
    archived: { $ne: true },
    updatedAt: "2026-08-16T18:00:00.000Z",
    revision: 7,
  });
  assert.deepEqual(options, { upsert: false });
  assert.equal(update.$inc.revision, 1);
  assert.equal(update.$set.participants.length, 2);
  assert.equal(update.$set.waitlist.length, 0);
  assert.equal(update.$set.resultRosterSnapshot.canonical, true);
  assert.equal(update.$set.resultRosterSnapshot.activeRoster.length, 2);
  assert.deepEqual(
    update.$set.metadata.canonicalRosterProjection.commandIds,
    [projection.commandId],
  );
});

test("verified payment projection marks server-matched payment paid", () => {
  const { projection } = projectionContext("PARTICIPANT");
  const reservationId = "238df6f5-fec4-44dd-ad8c-39e98ade8366";
  const result = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: {
      gameId: "pay_game",
      idempotencyKey: "legacy-payment:1234567890",
      command: "CONFIRM_PAYMENT",
      reservationId,
      retryCount: 0,
    },
    _legacyRosterProjection: { ...projection, reservationId },
    _legacyPaymentEvidence: {
      operationType: "TRANSACTION",
      operationId: "tx-1",
      bookingId: "booking-1",
      clientPhoneE164: "+79000000001",
      verifiedAt: "2026-08-16T18:05:00.000Z",
      amountMinor: 250000,
    },
    payload: [{
      id: "pay_game",
      participants: [],
      waitlist: [],
      metadata: {
        splitPayment: {
          payments: [{ bookingId: "booking-1", phone: "79000000001", status: "PAYMENT_PENDING" }],
        },
      },
      organizer: { id: "organizer", name: "Организатор", phone: "79000000003" },
    }],
  }) as any[];

  const payment = result[0].payload[1].$set.metadata.splitPayment.payments[0];
  assert.equal(payment.status, "PAID");
  assert.equal(payment.transactionId, "tx-1");
  assert.equal(payment.verifiedBy, "VIVA_PROVIDER_LOOKUP");
});

test("verified subscription projection persists the exact instance and visit count on one player", () => {
  const { projection } = projectionContext("PARTICIPANT");
  const reservationId = "238df6f5-fec4-44dd-ad8c-39e98ade8366";
  const result = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: {
      gameId: "pay_game",
      idempotencyKey: "legacy-payment:subscription-binding",
      command: "CONFIRM_PAYMENT",
      reservationId,
      retryCount: 0,
    },
    _legacyRosterProjection: { ...projection, reservationId },
    _legacyPaymentEvidence: {
      operationType: "SUBSCRIPTION_BOOKING",
      operationId: "booking-annual",
      bookingId: "booking-annual",
      clientPhoneE164: "+79000000001",
      clientSubscriptionId: "client-subscription-annual",
      subscriptionVisitCount: 1,
      verifiedAt: "2026-08-20T18:30:00.000Z",
    },
    payload: [{
      id: "pay_game",
      participants: [],
      waitlist: [],
      metadata: {
        splitPayment: {
          payments: [
            { bookingId: "booking-other", phone: "79000000002", status: "PAID" },
            { bookingId: "booking-annual", phone: "79000000001", status: "PAYMENT_PENDING" },
          ],
        },
      },
      organizer: { id: "organizer", name: "Организатор", phone: "79000000003" },
    }],
  }) as any[];

  const payments = result[0].payload[1].$set.metadata.splitPayment.payments;
  assert.equal(payments[0].clientSubscriptionId, undefined);
  assert.equal(payments[1].clientSubscriptionId, "client-subscription-annual");
  assert.equal(payments[1].subscriptionVisitCount, 1);
  assert.equal(payments[1].status, "PAID");
});

test("canonical confirmation rejects subscription evidence without an exact instance binding", () => {
  const result = run(
    "scripts/nodered_games_nodes/fn_legacy_payment_confirm_to_canonical.js",
    {
      _legacyPaymentConfirm: {
        gameId: "pay_game",
        reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
        operationType: "SUBSCRIPTION_BOOKING",
        operationId: "booking-1",
        bookingId: "booking-1",
        clientId: "client-1",
        expectedExerciseId: "exercise-1",
        authorization: "Bearer signed-token",
        idempotencyKey: "legacy-payment:missing-binding",
      },
      _verifiedPaymentEvidence: {
        operationType: "SUBSCRIPTION_BOOKING",
        operationId: "booking-1",
        bookingId: "booking-1",
        exerciseId: "exercise-1",
        clientPhoneE164: "+79000000001",
        verifiedAt: "2026-08-20T18:30:00.000Z",
      },
    },
    enabledEnv,
  ) as any[];

  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 409);
  assert.equal(result[1].payload.code, "LEGACY_SUBSCRIPTION_BINDING_MISSING");
});

test("seat reservation is projected with a recoverable reservation id", () => {
  const { bridge, projection } = projectionContext("SEAT_RESERVED");
  const reservationId = "238df6f5-fec4-44dd-ad8c-39e98ade8366";
  const result = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: bridge,
    _legacyRosterProjection: { ...projection, reservationId },
    payload: [{
      id: "pay_game",
      participants: [],
      waitlist: [],
      metadata: {},
    }],
  }) as any[];

  const update = result[0].payload[1].$set;
  assert.equal(update.waitlist[0].status, "PENDING");
  assert.equal(
    update.metadata.canonicalRosterProjection.reservations[projection.player.userId],
    reservationId,
  );
});

test("verified payment projection does not overwrite another player's pending payment", () => {
  const { projection } = projectionContext("PARTICIPANT");
  const result = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: {
      gameId: "pay_game",
      idempotencyKey: "legacy-payment:1234567891",
      command: "CONFIRM_PAYMENT",
      reservationId: "238df6f5-fec4-44dd-ad8c-39e98ade8366",
      retryCount: 0,
    },
    _legacyRosterProjection: projection,
    _legacyPaymentEvidence: {
      operationType: "TRANSACTION",
      operationId: "tx-2",
      bookingId: "booking-2",
      clientPhoneE164: "+79000000001",
      verifiedAt: "2026-08-16T18:05:00.000Z",
    },
    payload: [{
      id: "pay_game",
      participants: [],
      waitlist: [],
      metadata: {
        splitPayment: {
          payments: [{ bookingId: "booking-2", phone: "79000000099", status: "PAYMENT_PENDING" }],
        },
      },
    }],
  }) as any[];

  const payments = result[0].payload[1].$set.metadata.splitPayment.payments;
  assert.equal(payments[0].status, "PAYMENT_PENDING");
  assert.equal(payments[1].status, "PAID");
  assert.equal(payments[1].phoneNorm, "79000000001");
});

test("canonical projection is idempotent and generic browser PATCH closes with the same flag", () => {
  const { bridge, projection } = projectionContext("WAITLISTED");
  const duplicate = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_build.js", {
    _legacyRosterBridge: bridge,
    _legacyRosterProjection: projection,
    payload: [{
      id: "pay_game",
      participants: [],
      waitlist: [],
      metadata: { canonicalRosterProjection: { commandIds: [projection.commandId] } },
    }],
  }) as any[];
  assert.equal(duplicate[0], null);
  assert.equal(duplicate[1].payload.replayed, true);

  const blocked = run(
    "scripts/nodered_games_nodes/fn_patch.js",
    {
      req: { params: { gameId: "pay_game" } },
      payload: { participants: [] },
    },
    { PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED: "true" },
  ) as any[];
  assert.equal(blocked[1].statusCode, 403);
  assert.equal(blocked[1].payload.code, "GAME_ROSTER_COMMAND_REQUIRED");
});

test("projection acknowledgement retries a CAS conflict before returning a stable error", () => {
  const base = {
    _legacyRosterBridge: {
      gameId: "pay_game",
      idempotencyKey: "legacy-roster:1234567890",
      command: "JOIN_GAME",
      retryCount: 0,
    },
    _legacyRosterProjectionWrite: { response: { statusCode: 200, payload: {} } },
    payload: { acknowledged: true, matchedCount: 0 },
  };
  const retry = run("scripts/nodered_games_nodes/fn_legacy_roster_projection_ack.js", base) as any[];
  assert.equal(retry[1]._legacyRosterBridge.retryCount, 1);
  assert.deepEqual(retry[1].payload, { id: "pay_game", archived: { $ne: true } });
});
