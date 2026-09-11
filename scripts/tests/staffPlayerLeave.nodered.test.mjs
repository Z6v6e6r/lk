import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const run = (fileName, msg, options = {}) => {
  const source = fs.readFileSync(`scripts/nodered_games_nodes/${fileName}`, "utf8");
  const context = (values = {}) => ({
    get(key) { return values[key]; },
    set(key, value) { values[key] = value; },
  });
  return new Function("msg", "global", "flow", "env", source)(
    msg,
    context(options.global),
    context(options.flow),
    context(options.env),
  );
};

const stableVersion = (parts) => {
  const values = Array.from(new Set(parts.filter(Boolean).map(String))).sort();
  const hashPart = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const seed = values.join("|");
  return `${hashPart(seed)}${hashPart([...seed].reverse().join(""))}`;
};

const membershipVersion = stableVersion(["membership-2", "booking-2", "payment-2"]);
const game = (overrides = {}) => ({
  id: "game-1",
  updatedAt: "2026-08-12T08:00:00.000Z",
  archived: false,
  organizer: { id: "client-1", phone: "79990000001" },
  participants: [{ id: "client-2", phone: "79990000002", bookingId: "booking-2", membershipId: "membership-2", paymentRef: "payment-2", status: "CONFIRMED" }],
  waitlist: [],
  metadata: {
    organizerId: "client-1",
    organizerPhoneNorm: "79990000001",
    splitPayment: {
      vivaExerciseId: "exercise-1",
      payments: [{
        clientId: "client-2",
        phoneNorm: "79990000002",
        bookingId: "booking-2",
        membershipId: "membership-2",
        paymentRef: "payment-2",
        clientSubscriptionId: "subscription-2",
        subscriptionVisitCount: 1,
        status: "PAID",
      }],
    },
  },
  ...overrides,
});
const command = (overrides = {}) => ({
  req: {
    params: { gameId: "game-1" },
    headers: { authorization: "Bearer service-secret", "idempotency-key": "remove-command-0001" },
  },
  payload: {
    target: { clientId: "client-2", bookingId: "booking-2" },
    expectedMembershipVersion: membershipVersion,
    visitAction: "RETURN_VISIT",
    staffActor: { id: "staff-1" },
    reason: "CUP_STAFF_REMOVAL",
  },
  ...overrides,
});

test("staff leave fails closed when service token env is absent or wrong", () => {
  let result = run("fn_staff_player_leave_prepare.js", command(), { env: {} });
  assert.equal(result[1].statusCode, 503);
  result = run("fn_staff_player_leave_prepare.js", command(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "other-secret" } });
  assert.equal(result[1].statusCode, 401);
  assert.equal(result[1]._staffLeaveCtx, undefined);
});

test("staff status auth distinguishes missing configuration from wrong bearer", () => {
  const msg = {
    req: {
      params: { gameId: "game-1", operationId: "staff-leave:game-1:client-2:version-1" },
      headers: { authorization: "Bearer service-secret" },
    },
  };
  assert.equal(run("fn_staff_player_leave_status_prepare.js", structuredClone(msg), { env: {} })[1].statusCode, 503);
  assert.equal(run("fn_staff_player_leave_status_prepare.js", structuredClone(msg), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "wrong-secret" } })[1].statusCode, 401);
  const allowed = run("fn_staff_player_leave_status_prepare.js", structuredClone(msg), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } });
  assert.deepEqual(allowed[0].payload, {
    _id: "game-1:staff-leave:game-1:client-2:version-1",
    gameId: "game-1",
    operationId: "staff-leave:game-1:client-2:version-1",
  });
});

test("staff leave prepares exact command without retaining authorization header", () => {
  const result = run("fn_staff_player_leave_prepare.js", command(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } });
  assert.equal(result[1], null);
  assert.deepEqual(result[0].payload, { id: "game-1", archived: { $ne: true } });
  assert.equal(result[0]._staffLeaveCtx.requestedRefundMethod, "SERVICE");
  assert.match(result[0]._staffLeaveCtx.idempotencyDigest, /^[a-z0-9]+$/);
  assert.equal(result[0].headers, undefined);
  assert.doesNotMatch(JSON.stringify(result[0]._staffLeaveCtx), /service-secret|remove-command-0001/);
});

test("visit action maps strictly to SERVICE or NONE", () => {
  const noReturn = command();
  noReturn.payload.visitAction = "NO_RETURN";
  const result = run("fn_staff_player_leave_prepare.js", noReturn, { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } });
  assert.equal(result[0]._staffLeaveCtx.requestedRefundMethod, "NONE");
  const invalid = command();
  invalid.payload.visitAction = "MONEY";
  assert.equal(run("fn_staff_player_leave_prepare.js", invalid, { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[1].statusCode, 400);
});

const localMembershipVersion = stableVersion(["local:membership-9"]);
const localGame = (overrides = {}) => ({
  id: "game-1",
  updatedAt: "2026-08-12T08:00:00.000Z",
  archived: false,
  organizer: { id: "client-1", phone: "79990000001" },
  participants: [
    { id: "client-1", name: "Organizer", source: "ORGANIZER", status: "CONFIRMED" },
    { id: "client-2", name: "Local Player", source: "INVITE_LINK", status: "CONFIRMED", membershipId: "local:membership-9" },
  ],
  waitlist: [],
  metadata: {
    organizerId: "client-1",
    organizerPhoneNorm: "79990000001",
    teamSlots: [
      { id: "client-1", name: "Organizer" },
      { id: "client-2", name: "Local Player" },
      null,
      null,
    ],
  },
  ...overrides,
});
const localCommand = (overrides = {}) => ({
  req: {
    params: { gameId: "game-1" },
    headers: { authorization: "Bearer service-secret", "idempotency-key": "remove-command-local-1" },
  },
  payload: {
    target: { clientId: "client-2", bookingId: null },
    expectedMembershipVersion: localMembershipVersion,
    visitAction: "NO_RETURN",
    staffActor: { id: "staff-1" },
    reason: "CUP_STAFF_REMOVAL",
  },
  ...overrides,
});

test("staff leave accepts a booking-less target only without visit return", () => {
  const prepared = run("fn_staff_player_leave_prepare.js", localCommand(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } });
  assert.equal(prepared[1], null);
  assert.equal(prepared[0]._staffLeaveCtx.targetBookingId, null);
  assert.equal(prepared[0]._staffLeaveCtx.requestedRefundMethod, "NONE");

  const returnVisit = localCommand();
  returnVisit.payload.visitAction = "RETURN_VISIT";
  const rejected = run("fn_staff_player_leave_prepare.js", returnVisit, { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } });
  assert.equal(rejected[1].statusCode, 409);
  assert.equal(rejected[1].payload.code, "VISIT_RETURN_UNAVAILABLE");
  assert.equal(rejected[1]._staffLeaveCtx, undefined);
});

test("staff leave removes a local membership without any live Viva booking", () => {
  const prepared = run("fn_staff_player_leave_prepare.js", localCommand(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[0];
  prepared.payload = [localGame()];
  const result = run("fn_staff_player_leave_authorize.js", prepared, { global: {} });
  assert.equal(result[1], null);
  const ctx = result[0]._splitLeaveCtx;
  assert.equal(ctx.vivaTargetMode, "NONE");
  assert.deepEqual(ctx.initialBookingIds, []);
  assert.equal(ctx.upstreamAuthHeader, null);
  assert.equal(ctx.membershipVersion, localMembershipVersion);

  const started = run("fn_split_leave_operation_start.js", structuredClone(result[0]))[0];
  assert.equal(started.payload[1].$setOnInsert.vivaTargetMode, "NONE");
  const inserted = started.payload[1].$setOnInsert;
  const operation = { ...inserted, _id: `${inserted.gameId}:${inserted.operationId}` };
  const routed = run("fn_split_leave_operation_route.js", { ...structuredClone(result[0]), payload: [operation] });
  assert.equal(routed[0], null);
  assert.equal(routed[1]._splitLeaveCtx.step, "local_apply");
});

test("staff leave fails closed when a booking-less request targets an active Viva booking", () => {
  const prepared = run("fn_staff_player_leave_prepare.js", localCommand(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[0];
  prepared.payload = [game()];
  const result = run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } });
  assert.equal(result[1].payload.code, "BOOKING_TARGET_REQUIRED");
});

test("local roster mutation clears the removed player team slot", () => {
  const prepared = run("fn_staff_player_leave_prepare.js", localCommand(), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[0];
  prepared.payload = [localGame()];
  const authorized = run("fn_staff_player_leave_authorize.js", prepared, { global: {} })[0];
  const update = run("fn_split_leave_game_update.js", authorized)[0].payload[1].$set;
  assert.deepEqual(update.participants.map((item) => item.id), ["client-1"]);
  assert.deepEqual(update.metadata.teamSlots, [{ id: "client-1", name: "Organizer" }, null, null, null]);
  assert.equal(update.metadata.selfRemovalAuditLog.at(-1).status, "no_viva_booking_target");
});

const preparedForAuthorize = (inputGame = game(), commandOverrides = {}) => {
  const prepared = run("fn_staff_player_leave_prepare.js", command(commandOverrides), { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[0];
  prepared.payload = [inputGame];
  return prepared;
};

test("staff leave binds exact active target and full booking queue", () => {
  const inputGame = game();
  inputGame.metadata.splitPayment.payments[0].bookingIds = ["booking-2", "booking-3"];
  inputGame.participants[0].bookingId = "booking-3";
  const expected = stableVersion(["membership-2", "booking-2", "booking-3", "payment-2"]);
  const prepared = preparedForAuthorize(inputGame);
  prepared._staffLeaveCtx.expectedMembershipVersion = expected;
  const result = run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } });
  assert.equal(result[1], null);
  const ctx = result[0]._splitLeaveCtx;
  assert.equal(ctx.mode, "STAFF_TARGET");
  assert.equal(ctx.operationId, `staff-leave:game-1:client-2:${expected}`);
  assert.deepEqual(ctx.initialBookingIds.sort(), ["booking-2", "booking-3"]);
  assert.equal(ctx.upstreamAuthHeader, "Bearer admin-token");
  assert.equal(ctx.source, "CUP");
});

test("staff leave rejects stale generation, organizer and mismatched booking", () => {
  let prepared = preparedForAuthorize();
  prepared._staffLeaveCtx.expectedMembershipVersion = "stale-version";
  assert.equal(run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[1].payload.code, "STALE_MEMBERSHIP_VERSION");

  const organizerCommand = command();
  organizerCommand.payload.target = { clientId: "client-1", bookingId: "booking-1" };
  organizerCommand.payload.expectedMembershipVersion = "some-version";
  prepared = run("fn_staff_player_leave_prepare.js", organizerCommand, { env: { CUP_LK_PLAYER_LEAVE_TOKEN: "service-secret" } })[0];
  prepared.payload = [game()];
  assert.equal(run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[1].payload.code, "ORGANIZER_TARGET_FORBIDDEN");

  prepared = preparedForAuthorize();
  prepared._staffLeaveCtx.targetBookingId = "booking-other";
  assert.equal(run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[1].payload.code, "BOOKING_TARGET_MISMATCH");
});

test("staff leave rejects ambiguous phone linked to another strong client id", () => {
  const inputGame = game();
  inputGame.waitlist.push({ id: "client-9", phone: "79990000002", status: "WAITLIST" });
  const prepared = preparedForAuthorize(inputGame);
  assert.equal(run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[1].payload.code, "AMBIGUOUS_TARGET_IDENTITY");
});

test("STAFF_TARGET cancellation always uses Admin API and preserves refund choice", () => {
  const prepared = preparedForAuthorize();
  const authorized = run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[0];
  const routed = run("fn_split_leave_router.js", authorized);
  assert.equal(routed[0].method, "GET");
  assert.match(routed[0].url, /^https:\/\/api\.vivacrm\.ru\/api\/v1\/clients\/client-2\/bookings\/booking-2\/cancel$/);
  assert.doesNotMatch(routed[0].url, /end-user/);
  routed[0].statusCode = 200;
  routed[0].payload = { cancellationOptions: { subscription: { available: true } } };
  const snapshot = run("fn_split_leave_router.js", routed[0], {
    global: { vivacrm_access_token: "admin-token" },
  })[0];
  assert.equal(snapshot.method, "GET");
  assert.match(snapshot.url, /clients\/client-2\/subscriptions\?size=200$/);
  snapshot.statusCode = 200;
  snapshot.payload = {
    content: [{
      subscriptionId: "subscription-2",
      visitsLeft: 10,
      bookings: [{ id: "booking-2", isCancelled: false }],
    }],
  };
  const cancel = run("fn_split_leave_router.js", snapshot)[0];
  assert.equal(cancel.method, "PUT");
  assert.deepEqual(cancel.payload, { refundMethod: "SERVICE", cancelExercise: false });
});

test("durable operation persists staff audit, survives a new key, and conflicts on changed action", () => {
  const prepared = preparedForAuthorize();
  const authorized = run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[0];
  const started = run("fn_split_leave_operation_start.js", structuredClone(authorized))[0];
  const inserted = started.payload[1].$setOnInsert;
  assert.equal(inserted.source, "CUP");
  assert.equal(inserted.staffActorId, "staff-1");
  assert.equal(inserted.idempotencyDigest, authorized._splitLeaveCtx.idempotencyDigest);

  const operation = { ...inserted, _id: `${inserted.gameId}:${inserted.operationId}` };
  const same = structuredClone(authorized);
  same.payload = [operation];
  const sameResult = run("fn_split_leave_operation_route.js", same);
  assert.ok(sameResult[0], "same command remains idempotent");

  const leased = structuredClone(authorized);
  leased._splitLeaveCtx.claimToken = "new-claim";
  leased.payload = [{ ...operation, claimToken: "active-claim", claimLeaseUntil: "2999-01-01T00:00:00.000Z" }];
  const inProgress = run("fn_split_leave_operation_route.js", leased)[2];
  assert.equal(inProgress.payload.status, "IN_PROGRESS");
  assert.equal(inProgress.payload.playerId, "client-2");

  const changedKey = structuredClone(authorized);
  changedKey._splitLeaveCtx.idempotencyDigest = "different";
  changedKey.payload = [operation];
  assert.ok(run("fn_split_leave_operation_route.js", changedKey)[0], "new transport key resolves the same logical operation");

  const changedAction = structuredClone(authorized);
  changedAction._splitLeaveCtx.requestedRefundMethod = "NONE";
  changedAction.payload = [operation];
  assert.equal(run("fn_split_leave_operation_route.js", changedAction)[2].statusCode, 409);
});

test("all staff POST terminal and retry emitters retain exact player identity", () => {
  const ctx = {
    mode: "STAFF_TARGET",
    operationId: "staff-leave:game-1:client-2:v1",
    gameId: "game-1",
    targetClientId: "client-2",
    requestedRefundMethod: "SERVICE",
  };
  const startConflict = run("fn_split_leave_operation_start.js", { _splitLeaveCtx: { ...ctx, initialBookingIds: [] } })[1];
  assert.equal(startConflict.payload.playerId, "client-2");

  const retry = run("fn_split_leave_retry_response.js", {
    _splitLeaveCtx: { ...ctx, vivaVerifiedAt: "2026-08-12T09:00:00.000Z" },
  })[0];
  assert.equal(retry.payload.status, "RETRY_REQUIRED");
  assert.equal(retry.payload.playerId, "client-2");

  const finalized = run("fn_split_leave_finalize.js", {
    _splitLeaveCtx: ctx,
    payload: { matchedCount: 1 },
  }, { global: {} })[0];
  assert.equal(finalized.payload.status, "DONE");
  assert.equal(finalized.payload.playerId, "client-2");

  const routerError = run("fn_split_leave_router.js", {
    _splitLeaveCtx: { ...ctx, step: "cancel_probe", currentBookingId: "booking-2", currentClientId: "client-2", bookingResults: [], trace: [], operationState: "STARTED", operationKey: "key", claimToken: "claim" },
    statusCode: 200,
    payload: { cancellationOptions: {} },
  })[1];
  assert.equal(routerError.payload.status, "CONFLICT");
  assert.equal(routerError.payload.playerId, "client-2");
});

test("background retry preserves CUP staff audit identity", () => {
  const operation = {
    _id: "game-1:staff-leave:game-1:client-2:v1",
    operationId: "staff-leave:game-1:client-2:v1",
    state: "VIVA_CONFIRMED",
    gameId: "game-1",
    mode: "STAFF_TARGET",
    staffActorId: "staff-1",
    source: "CUP",
    idempotencyDigest: "audit-digest",
    targetClientId: "client-2",
    membershipVersion: "v1",
    bookingIds: ["booking-2"],
  };
  const selected = run("fn_split_leave_retry_select.js", { payload: [operation] })[0];
  assert.equal(selected._splitLeaveCtx.staffActorId, "staff-1");
  assert.equal(selected._splitLeaveCtx.source, "CUP");
  assert.equal(selected._splitLeaveCtx.idempotencyDigest, "audit-digest");
});

test("local roster mutation records CUP staff audit without changing pre-confirmation ordering", () => {
  const prepared = preparedForAuthorize();
  const authorized = run("fn_staff_player_leave_authorize.js", prepared, { global: { vivacrm_access_token: "admin-token" } })[0];
  authorized._splitLeaveCtx.gameApplyAcknowledged = false;
  authorized._splitLeaveCtx.vivaVerifiedAt = "2026-08-12T09:00:00.000Z";
  authorized._splitLeaveCtx.vivaVerification = "active_absent_history_cancelled";
  const update = run("fn_split_leave_game_update.js", authorized)[0].payload[1].$set;
  assert.equal(update.participants.length, 0);
  const event = update.metadata.leaveEvents.at(-1);
  const audit = update.metadata.selfRemovalAuditLog.at(-1);
  assert.equal(event.actor, "staff");
  assert.equal(event.staffActorId, "staff-1");
  assert.equal(audit.source, "cup_staff");
  assert.equal(audit.staffActorId, "staff-1");
});

test("staff status exposes only the bounded public state model", () => {
  const states = [
    [{ state: "STARTED", recoveryAttempts: 1 }, "IN_PROGRESS"],
    [{ state: "VIVA_CONFIRMED", localApplyAttempts: 2 }, "FINALIZING"],
    [{ state: "DONE", outcome: "REMOVED" }, "DONE"],
    [{ state: "STARTED", recoveryAttempts: 20 }, "ATTENTION_REQUIRED"],
    [{ state: "VIVA_CONFIRMED", localApplyAttempts: 20 }, "ATTENTION_REQUIRED"],
    [{ state: "UNEXPECTED", recoveryAttempts: 1 }, "IN_PROGRESS"],
  ];
  for (const [fields, expected] of states) {
    const operation = {
      _id: "game-1:staff-leave:game-1:client-2:v1",
      operationId: "staff-leave:game-1:client-2:v1",
      gameId: "game-1",
      mode: "STAFF_TARGET",
      requestedRefundMethod: "NONE",
      ...fields,
    };
    const result = run("fn_staff_player_leave_status.js", {
      payload: [operation],
      _staffLeaveStatusCtx: { gameId: "game-1", operationId: operation.operationId },
    })[0];
    assert.equal(result.payload.status, expected);
    assert.equal(result.payload.state, expected);
    assert.equal(result.payload.playerId, null);
    assert.ok(["CANCELLING", "FINALIZING", "DONE", "ATTENTION_REQUIRED"].includes(result.payload.stage));
    assert.equal(JSON.stringify(result.payload).includes("claimToken"), false);
  }
});

test("staff status returns exact safe player identity", () => {
  const operation = {
    operationId: "staff-leave:game-1:client-2:v1",
    gameId: "game-1",
    targetClientId: "client-2",
    mode: "STAFF_TARGET",
    state: "DONE",
    requestedRefundMethod: "NONE",
  };
  const result = run("fn_staff_player_leave_status.js", {
    payload: [operation],
    _staffLeaveStatusCtx: { gameId: "game-1", operationId: operation.operationId },
  })[0];
  assert.equal(result.payload.playerId, "client-2");
});

test("guarded patcher declares exactly the two internal staff routes", () => {
  const source = fs.readFileSync("scripts/patch_live_games_staff_player_leave.mjs", "utf8");
  assert.match(source, /\/lk\/internal\/staff\/games\/:gameId\/player-leaves/);
  assert.match(source, /candidateRouteCount/);
  assert.match(source, /fn_staff_player_leave_prepare\.js/);
  assert.doesNotMatch(source, /service-secret|admin-token/);
});
