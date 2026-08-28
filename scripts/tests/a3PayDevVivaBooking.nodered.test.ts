/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  A3PAY_DEV_VIVA_BOOKING_IDS,
  buildA3PayDevVivaBookingCandidate,
} from "../patch_live_a3pay_dev_viva_booking.mjs";

const PREPARE_FILE = "scripts/nodered_a3pay_dev_viva_booking_nodes/fn_a3pay_dev_viva_booking_prepare.js";
const ROUTER_FILE = "scripts/nodered_a3pay_dev_viva_booking_nodes/fn_a3pay_dev_viva_booking_router.js";

function runFunction(
  file: string,
  msg: Record<string, any>,
  envValues: Record<string, string> = {},
) {
  const source = fs.readFileSync(file, "utf8");
  const env = { get: (name: string) => envValues[name] };
  return new Function("msg", "env", source)(msg, env) as Array<Record<string, any> | null>;
}

function requestMsg(action = "create") {
  return {
    req: {
      params: { action },
      query: { operationId: "a3dev-v1:test:operation-1" },
      headers: {
        authorization: "Bearer user-token",
        origin: "https://padlhub.ru",
        "x-padlhub-release-channel": "dev",
      },
    },
    payload: action === "create" ? {
      selection: {
        date: "2026-09-01",
        fromTime: "18:00",
        toTime: "19:00",
        studioId: "studio-1",
        roomId: "room-1",
        masterServiceId: "master-1",
        subServiceIds: ["sub-1"],
      },
    } : {},
  };
}

const enabledEnv = {
  A3PAY_DEV_VIVA_BOOKING_ENABLED: "true",
  A3PAY_DEV_VIVA_BOOKING_TARGET: "lk-reserve-89",
  A3PAY_DEV_VIVA_BOOKING_TENANT: "iSkq6G",
  A3PAY_DEV_VIVA_BOOKING_CLIENT_IDS: "client-1",
  A3PAY_DEV_VIVA_BOOKING_STUDIO_IDS: "studio-1",
  A3PAY_DEV_VIVA_BOOKING_MASTER_SERVICE_IDS: "master-1",
  HOSTNAME: "89-108-64-209.cloudvps.regruhosting.ru",
};

function routerContext(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    operationId: "a3dev-v1:test:operation-1",
    authHeader: "Bearer user-token",
    corsOrigin: "https://padlhub.ru",
    tenantKey: "iSkq6G",
    actorClientId: "client-1",
    operationKey: "a3pay-dev:client-1:a3dev-v1:test:operation-1",
    selection: {
      date: "2026-09-01",
      fromTime: "18:00",
      toTime: "19:00",
      studioId: "studio-1",
      roomId: "room-1",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1"],
    },
    selectionKey: JSON.stringify({
      date: "2026-09-01",
      fromTime: "18:00",
      toTime: "19:00",
      studioId: "studio-1",
      roomId: "room-1",
      masterServiceId: "master-1",
      subServiceIds: ["sub-1"],
    }),
    ...overrides,
  };
}

test("gateway is disabled unless all reserve-only runtime gates match", () => {
  const out = runFunction(PREPARE_FILE, requestMsg(), {});
  assert.equal(out[0], null);
  assert.equal(out[1]?.statusCode, 503);
  assert.equal(out[1]?.payload?.code, "A3PAY_DEV_VIVA_BOOKING_DISABLED");
  assert.equal(out[1]?.url, undefined);
});

test("gateway requires dev channel, allowed origin, auth and complete selection", () => {
  const message = requestMsg();
  message.req.headers["x-padlhub-release-channel"] = "production";
  const wrongChannel = runFunction(PREPARE_FILE, message, enabledEnv);
  assert.equal(wrongChannel[1]?.statusCode, 403);
  assert.equal(wrongChannel[1]?.payload?.code, "A3PAY_DEV_CHANNEL_REQUIRED");

  const allowed = runFunction(PREPARE_FILE, requestMsg(), enabledEnv);
  assert.equal(allowed[1], null);
  assert.equal(allowed[0]?.method, "GET");
  assert.equal(allowed[0]?.url, "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile");

  const deniedTargetMessage = requestMsg();
  deniedTargetMessage.payload.selection.studioId = "studio-other";
  const deniedTarget = runFunction(PREPARE_FILE, deniedTargetMessage, enabledEnv);
  assert.equal(deniedTarget[1]?.statusCode, 403);
  assert.equal(deniedTarget[1]?.payload?.code, "A3PAY_DEV_TARGET_DENIED");
});

test("profile must match the exact test-client allowlist", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "profile", actorClientId: undefined, operationKey: undefined }),
    statusCode: 200,
    payload: { id: "client-other" },
  }, enabledEnv);
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 403);
  assert.equal(out[3]?.payload?.code, "A3PAY_DEV_CLIENT_DENIED");
});

test("unused PREPARED operation has a bounded TTL that is removed before provider work", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "profile", actorClientId: undefined, operationKey: undefined }),
    statusCode: 200,
    payload: { id: "client-1" },
  }, enabledEnv);
  assert.equal(out[2]?.payload?.[1]?.$setOnInsert?.state, "PREPARED");
  assert.ok(out[2]?.payload?.[1]?.$setOnInsert?.expiresAt instanceof Date);
});

test("provider mutation is claimed durably before the single Viva POST", () => {
  const claim = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "operation_find" }),
    payload: [{
      _id: "a3pay-dev:client-1:a3dev-v1:test:operation-1",
      actorClientId: "client-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      state: "PREPARED",
    }],
  });
  assert.equal(claim[2]?.payload?.[0]?.state, "PREPARED");
  assert.equal(claim[2]?.payload?.[1]?.$set?.state, "SNAPSHOT_PENDING");
  assert.deepEqual(claim[2]?.payload?.[1]?.$unset, { expiresAt: "" });
  assert.equal(claim[0], null);

  const snapshotRequest = runFunction(ROUTER_FILE, {
    _a3payDevViva: claim[2]?._a3payDevViva,
    payload: { modifiedCount: 1 },
  });
  assert.equal(snapshotRequest[0]?.method, "GET");
  assert.match(snapshotRequest[0]?.url, /\/bookings\?size=1000$/);

  const snapshotWrite = runFunction(ROUTER_FILE, {
    _a3payDevViva: snapshotRequest[0]?._a3payDevViva,
    statusCode: 200,
    payload: [],
  });
  assert.deepEqual(snapshotWrite[2]?.payload?.[1]?.$set?.preexistingBookingIds, []);

  const provider = runFunction(ROUTER_FILE, {
    _a3payDevViva: snapshotWrite[2]?._a3payDevViva,
    payload: { modifiedCount: 1 },
  });
  assert.equal(provider[0]?.method, "POST");
  assert.match(provider[0]?.url, /\/products\/master-services\/master-1\/pay$/);
  assert.equal(provider[0]?.payload?.paymentMethod, "WIDGET");
  assert.equal(provider[0]?.payload?.comment, "A3PAY_DEV:a3dev-v1:test:operation-1");
  assert.equal(provider[0]?.payload?.paymentUrl, undefined);
});

test("status never turns SNAPSHOT_PENDING into a provider request", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ action: "status", step: "operation_find" }),
    payload: [{
      actorClientId: "client-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      state: "SNAPSHOT_PENDING",
    }],
  });
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 202);
  assert.equal(out[3]?.payload?.state, "PREPARED");
});

test("missing status operation returns an explicit 404 without provider work", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ action: "status", step: "operation_find" }),
    payload: [],
  });
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 404);
  assert.equal(out[3]?.payload?.code, "A3PAY_DEV_OPERATION_NOT_FOUND");
});

test("status returns a confirmed booking without another provider write", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ action: "status", step: "operation_find" }),
    payload: [{
      actorClientId: "client-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      state: "VIVA_BOOKING_CREATED",
      bookingId: "booking-1",
    }],
  });
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 200);
  assert.equal(out[3]?.payload?.state, "VIVA_BOOKING_CREATED");
});

test("fresh CANCEL_PENDING status remains read-only and asks the UI to poll", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ action: "status", step: "operation_find" }),
    payload: [{
      actorClientId: "client-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      state: "CANCEL_PENDING",
      bookingId: "booking-1",
      cancelAttemptedAt: new Date().toISOString(),
    }],
  });
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 202);
  assert.equal(out[3]?.payload?.state, "CANCEL_PENDING");
});

test("ambiguous provider response is persisted and never blindly retried", () => {
  const update = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      step: "provider_create",
      claimToken: "claim-1",
    }),
    statusCode: 503,
    payload: { error: "timeout" },
  });
  assert.equal(update[2]?.payload?.[1]?.$set?.state, "PROVIDER_UNVERIFIED");
  assert.equal(update[0], null);

  const replay = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "operation_find" }),
    payload: [{
      actorClientId: "client-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      state: "PROVIDER_UNVERIFIED",
    }],
  });
  assert.equal(replay[0], null);
  assert.equal(replay[3]?.statusCode, 202);
  assert.equal(replay[3]?.payload?.state, "PROVIDER_UNVERIFIED");
});

test("reusing an operationId for another slot fails before provider claim", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "operation_find" }),
    payload: [{
      actorClientId: "client-1",
      selection: { ...routerContext().selection, roomId: "room-other" },
      selectionKey: "different-selection",
      state: "PREPARED",
    }],
  });
  assert.equal(out[0], null);
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 409);
  assert.equal(out[3]?.payload?.code, "A3PAY_DEV_OPERATION_SELECTION_MISMATCH");
});

test("ambiguous create recovers exactly one new booking from durable pre-write snapshot", () => {
  const attemptedAt = new Date().toISOString();
  const recovery = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      step: "provider_recovery_readback",
      preexistingBookingIds: ["booking-before"],
      providerAttemptedAt: attemptedAt,
    }),
    statusCode: 200,
    payload: [
      {
        id: "booking-before",
        studio: { id: "studio-1" },
        room: { id: "room-1" },
        timeFrom: "2026-09-01T18:00:00+03:00",
        createdAt: attemptedAt,
      },
      {
        id: "booking-new",
        exercise: { id: "exercise-new" },
        studio: { id: "studio-1" },
        room: { id: "room-1" },
        timeFrom: "2026-09-01T18:00:00+03:00",
        createdAt: attemptedAt,
        comment: "A3PAY_DEV:a3dev-v1:test:operation-1",
      },
    ],
  });
  assert.equal(recovery[0], null);
  assert.equal(recovery[2]?.payload?.[1]?.$set?.state, "PROVIDER_RESULT_RECEIVED");
  assert.equal(recovery[2]?.payload?.[1]?.$set?.bookingId, "booking-new");
  assert.equal(recovery[2]?.payload?.[1]?.$set?.recoveredByReadback, true);
});

test("recovery refuses an exact concurrent booking without the operation marker", () => {
  const attemptedAt = new Date().toISOString();
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      step: "provider_recovery_readback",
      preexistingBookingIds: [],
      providerAttemptedAt: attemptedAt,
    }),
    statusCode: 200,
    payload: [{
      id: "booking-concurrent",
      studio: { id: "studio-1" },
      room: { id: "room-1" },
      timeFrom: "2026-09-01T18:00:00+03:00",
      createdAt: attemptedAt,
      comment: "ordinary booking",
    }],
  });
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 202);
  assert.equal(out[3]?.payload?.state, "PROVIDER_UNVERIFIED");
});

test("provider identifiers are persisted before booking read-back and confirmation", () => {
  const persist = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({ step: "provider_create", claimToken: "claim-1" }),
    statusCode: 200,
    payload: {
      transactionId: "transaction-1",
      bookingIds: ["booking-1"],
      exerciseId: "exercise-1",
      paymentUrl: "https://provider.example/secret-link",
    },
  });
  assert.equal(persist[2]?.payload?.[1]?.$set?.state, "PROVIDER_RESULT_RECEIVED");
  assert.equal(persist[2]?.payload?.[1]?.$set?.bookingId, "booking-1");
  assert.equal(JSON.stringify(persist[2]?.payload).includes("secret-link"), false);

  const readback = runFunction(ROUTER_FILE, {
    _a3payDevViva: persist[2]?._a3payDevViva,
    payload: { modifiedCount: 1 },
  });
  assert.equal(readback[0]?.method, "GET");
  assert.match(readback[0]?.url, /\/bookings\?size=1000$/);

  const confirm = runFunction(ROUTER_FILE, {
    _a3payDevViva: readback[0]?._a3payDevViva,
    statusCode: 200,
    payload: [{
      id: "booking-1",
      studio: { id: "studio-1" },
      room: { id: "room-1" },
      timeFrom: "2026-09-01T18:00:00+03:00",
    }],
  });
  assert.equal(confirm[2]?.payload?.[1]?.$set?.state, "VIVA_BOOKING_CREATED");
});

test("cancellation probes allowed mode, claims, deletes once and verifies absence", () => {
  const context = routerContext({
    action: "cancel",
    step: "operation_find",
    selection: null,
    selectionKey: null,
  });
  const probe = runFunction(ROUTER_FILE, {
    _a3payDevViva: context,
    payload: [{
      actorClientId: "client-1",
      state: "VIVA_BOOKING_CREATED",
      bookingId: "booking-1",
      exerciseId: "exercise-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
    }],
  });
  assert.equal(probe[0]?.method, "GET");
  assert.match(probe[0]?.url, /\/bookings\/booking-1\/cancel$/);

  const claim = runFunction(ROUTER_FILE, {
    _a3payDevViva: probe[0]?._a3payDevViva,
    statusCode: 200,
    payload: { cancellationOptions: { cancellationOnly: { available: true } } },
  });
  assert.equal(claim[2]?.payload?.[1]?.$set?.state, "CANCEL_PENDING");

  const deletion = runFunction(ROUTER_FILE, {
    _a3payDevViva: claim[2]?._a3payDevViva,
    payload: { modifiedCount: 1 },
  });
  assert.equal(deletion[0]?.method, "DELETE");
  assert.match(deletion[0]?.url, /\/bookings\/booking-1$/);

  const verify = runFunction(ROUTER_FILE, {
    _a3payDevViva: deletion[0]?._a3payDevViva,
    statusCode: 204,
    payload: null,
  });
  assert.equal(verify[0]?.method, "GET");

  const history = runFunction(ROUTER_FILE, {
    _a3payDevViva: verify[0]?._a3payDevViva,
    statusCode: 200,
    payload: [],
  });
  assert.equal(history[0]?.method, "GET");
  assert.match(history[0]?.url, /\/bookings\/history\?includeCanceled=true&size=1000$/);

  const persisted = runFunction(ROUTER_FILE, {
    _a3payDevViva: history[0]?._a3payDevViva,
    statusCode: 200,
    payload: [{ id: "booking-1", status: "CANCELLED" }],
  });
  assert.equal(persisted[2]?.payload?.[1]?.$set?.state, "CANCELLED");
  assert.ok(persisted[2]?.payload?.[1]?.$set?.expiresAt instanceof Date);
});

test("absence from active and history never confirms cancellation", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      action: "cancel",
      step: "cancel_history_readback",
      bookingId: "booking-1",
    }),
    statusCode: 200,
    payload: [],
  });
  assert.equal(out[2], null);
  assert.equal(out[3]?.statusCode, 202);
  assert.equal(out[3]?.payload?.state, "IN_PROGRESS");
});

test("unsupported cancellation mode fails closed before DELETE", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      action: "cancel",
      step: "cancel_probe",
      bookingId: "booking-1",
    }),
    statusCode: 200,
    payload: { cancellationOptions: { money: { available: true } } },
  });
  assert.equal(out[0], null);
  assert.equal(out[3]?.statusCode, 409);
  assert.equal(out[3]?.payload?.code, "A3PAY_DEV_CANCEL_MODE_UNSUPPORTED");
});

test("stale pending cancellation performs read-back without another DELETE", () => {
  const out = runFunction(ROUTER_FILE, {
    _a3payDevViva: routerContext({
      action: "cancel",
      step: "operation_find",
      selection: null,
      selectionKey: null,
    }),
    payload: [{
      actorClientId: "client-1",
      state: "CANCEL_PENDING",
      bookingId: "booking-1",
      selection: routerContext().selection,
      selectionKey: routerContext().selectionKey,
      cancelAttemptedAt: "2026-08-28T00:00:00.000Z",
    }],
  });
  assert.equal(out[0]?.method, "GET");
  assert.match(out[0]?.url, /\/bookings\?size=1000$/);
});

test("candidate adds only the isolated routes and self-contained nodes", () => {
  const base = [{
    id: "4b91e2a2413688db",
    type: "tab",
    label: "LK Games",
    disabled: false,
    wires: [],
  }];
  const result = buildA3PayDevVivaBookingCandidate(base, { enforceLiveContract: false });
  assert.deepEqual(result.candidate.slice(0, base.length), base);
  assert.deepEqual(new Set(result.addedNodeIds), new Set(Object.values(A3PAY_DEV_VIVA_BOOKING_IDS)));
  const routes = result.candidate.filter((node: any) => node.type === "http in");
  assert.deepEqual(routes.map((node: any) => `${node.method}:${node.url}`).sort(), [
    "options:/lk/games/a3pay/dev/viva-booking/:action",
    "post:/lk/games/a3pay/dev/viva-booking/:action",
  ]);
});
