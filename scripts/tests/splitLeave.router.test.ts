import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

type Msg = Record<string, any>;

function run(fileName: string, msg: Msg, options: {
  global?: Record<string, unknown>;
  flow?: Record<string, unknown>;
} = {}) {
  const source = fs.readFileSync(`scripts/nodered_games_nodes/${fileName}`, "utf8");
  const globalValues = { ...(options.global || {}) };
  const flowValues = { ...(options.flow || {}) };
  const context = (values: Record<string, unknown>) => ({
    get(key: string) { return values[key]; },
    set(key: string, value: unknown) { values[key] = value; },
  });
  const result = new Function("msg", "global", "flow", source)(
    msg,
    context(globalValues),
    context(flowValues),
  );
  return { result: result as any[], globalValues, flowValues };
}

function selfGame(overrides: Msg = {}) {
  return {
    id: "game-1",
    updatedAt: "2026-08-01T09:00:00.000Z",
    archived: false,
    organizer: { id: "client-3", phone: "79990000003", name: "Organizer" },
    participants: [
      { id: "client-1", phone: "79990000001", status: "CONFIRMED" },
      { id: "client-2", phone: "79990000002", status: "CONFIRMED" },
    ],
    waitlist: [],
    participantPhones: ["79990000001", "79990000002"],
    waitlistPhones: [],
    invitedPhones: [],
    allRelatedPhones: ["79990000001", "79990000002", "79990000003"],
    booking: { bookingId: "booking-1", exerciseId: "exercise-1" },
    metadata: {
      organizerId: "client-3",
      organizerPhoneNorm: "79990000003",
      splitPayment: {
        vivaExerciseId: "exercise-1",
        organizerBookingId: "booking-1",
        payments: [{
          clientId: "client-1",
          phoneNorm: "79990000001",
          bookingId: "booking-1",
          status: "PAID",
        }],
      },
    },
    ...overrides,
  };
}

function prepareSelf(body: Msg = { reason: "PLAYER_LEFT", operationId: "leave-op-0001" }) {
  return run("fn_split_leave_prepare.js", {
    req: { params: { gameId: "game-1" } },
    payload: body,
    _splitCleanupAuth: {
      verified: true,
      actorClientId: "client-1",
      actorPhoneNorm: "79990000001",
      authHeader: "Bearer user-token",
    },
  }).result[0];
}

function authorizeSelf(game = selfGame(), body: Msg = {}) {
  const prepared = prepareSelf(Object.keys(body).length > 0 ? body : undefined);
  prepared.payload = [game];
  const result = run("fn_split_leave_authorize.js", prepared).result;
  return result[0] || result[3] || result[4];
}

test("self leave derives actor and booking only from verified profile plus game", () => {
  const prepared = prepareSelf({
    reason: "PLAYER_LEFT",
    operationId: "leave-op-0001",
    clientId: "spoofed-client",
  });
  assert.equal(prepared._splitLeaveCtx.mode, "SELF");
  assert.equal(prepared._splitLeaveCtx.actorClientId, "client-1");
  assert.equal(prepared._splitLeaveCtx.operationId, "self-leave:game-1:client-1");

  prepared.payload = [selfGame()];
  const authorized = run("fn_split_leave_authorize.js", prepared).result[0];
  assert.deepEqual(authorized._splitLeaveCtx.initialBookingIds, ["booking-1"]);
  assert.equal(authorized._splitLeaveCtx.targetClientId, "client-1");
  assert.equal(authorized._splitLeaveCtx.upstreamAuthHeader, "Bearer user-token");
});

test("self leave ignores caller supplied operationId and keeps one deterministic key", () => {
  const first = prepareSelf({ operationId: "caller-operation-1" });
  const second = prepareSelf({ operationId: "different-operation-2" });
  assert.equal(first._splitLeaveCtx.operationId, "self-leave:game-1:client-1");
  assert.equal(second._splitLeaveCtx.operationId, first._splitLeaveCtx.operationId);
  assert.notEqual(first._splitLeaveCtx.claimToken, second._splitLeaveCtx.claimToken);
});

test("legacy target removal is a separate organizer-only branch bound to a linked booking", () => {
  const prepared = prepareSelf({
    reason: "ORGANIZER_REMOVED",
    operationId: "leave-op-0002",
    bookingIds: ["booking-2"],
    clientId: "spoofed-client",
  });
  const game = selfGame();
  game.organizer = { id: "client-1", phone: "79990000001", name: "Organizer" };
  game.metadata.organizerId = "client-1";
  game.metadata.organizerPhoneNorm = "79990000001";
  game.metadata.splitPayment.payments.push({
    clientId: "client-2",
    phoneNorm: "79990000002",
    bookingId: "booking-2",
    status: "PAID",
  });
  prepared.payload = [game];
  const authorized = run("fn_split_leave_authorize.js", prepared, {
    global: { vivacrm_access_token: "server-context-token" },
  }).result[0];
  assert.equal(authorized._splitLeaveCtx.mode, "ORGANIZER_TARGET");
  assert.equal(authorized._splitLeaveCtx.targetClientId, "client-2");
  assert.deepEqual(authorized._splitLeaveCtx.initialBookingIds, ["booking-2"]);
  assert.equal(authorized._splitLeaveCtx.upstreamAuthHeader, "Bearer server-context-token");
  assert.ok(authorized._splitLeaveCtx.membershipVersion);
  const organizerStarted = run("fn_split_leave_operation_start.js", structuredClone(authorized)).result[0];
  assert.equal(organizerStarted.payload[1].$setOnInsert.membershipVersion, authorized._splitLeaveCtx.membershipVersion);
  assert.deepEqual(organizerStarted.payload[1].$setOnInsert.bookingIds, ["booking-2"]);

  const participantPrepared = prepareSelf({
    reason: "ORGANIZER_REMOVED",
    operationId: "leave-op-0003",
    bookingIds: ["booking-2"],
  });
  participantPrepared._splitLeaveCtx.actorClientId = "client-2";
  participantPrepared._splitLeaveCtx.actorPhoneNorm = "79990000002";
  participantPrepared.payload = [game];
  const forbidden = run("fn_split_leave_authorize.js", participantPrepared, {
    global: { vivacrm_access_token: "server-context-token" },
  }).result;
  assert.equal(forbidden[0], null);
  assert.equal(forbidden[1].statusCode, 403);

});

test("self mode rejects organizer identity", () => {
  const prepared = prepareSelf();
  const game = selfGame();
  game.organizer = { id: "client-1", phone: "79990000001" };
  game.metadata.organizerId = "client-1";
  game.metadata.organizerPhoneNorm = "79990000001";
  prepared.payload = [game];
  const result = run("fn_split_leave_authorize.js", prepared).result;
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 409);
});

test("organizer retry uses the same canonical payment and participant generation", () => {
  const prepared = prepareSelf({ reason: "ORGANIZER_REMOVED", bookingIds: ["booking-2"] });
  const game = selfGame();
  game.organizer = { id: "client-1", phone: "79990000001" };
  game.metadata.organizerId = "client-1";
  game.metadata.organizerPhoneNorm = "79990000001";
  game.participants[1].membershipId = "member-client-2";
  game.metadata.splitPayment.payments.push({
    clientId: "client-2",
    phoneNorm: "79990000002",
    bookingId: "booking-2",
    status: "LEFT",
  });
  prepared.payload = [game];
  const authorized = run("fn_split_leave_authorize.js", prepared, {
    global: { vivacrm_access_token: "service-token" },
  }).result[0];
  const started = run("fn_split_leave_operation_start.js", structuredClone(authorized)).result[0];
  assert.ok(started);
  assert.equal(started.payload[1].$setOnInsert.membershipVersion, authorized._splitLeaveCtx.membershipVersion);
  const hydrated = run("fn_split_leave_retry_hydrate.js", {
    _splitLeaveCtx: {
      operationKey: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      operationState: "VIVA_CONFIRMED",
      gameId: "game-1",
      targetClientId: "client-2",
      targetPhoneNorm: "79990000002",
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
      step: "local_apply",
    },
    payload: [game],
  }).result;
  assert.ok(hydrated[0]);
  assert.equal(hydrated[3], null);
  assert.equal(hydrated[0]._splitLeaveCtx.supersededByRejoin, undefined);

  const gameUpdate = run("fn_split_leave_game_update.js", hydrated[0]).result[0];
  const nextGameState = gameUpdate.payload[1].$set;
  assert.equal(nextGameState.participants.some((item: Msg) => item.id === "client-2"), false);
  assert.equal(nextGameState.participants.some((item: Msg) => item.id === "client-1"), true);
  const targetPayment = nextGameState.metadata.splitPayment.payments
    .find((item: Msg) => item.clientId === "client-2");
  assert.equal(targetPayment.status, "LEFT");
  assert.equal(targetPayment.leaveOperationId, authorized._splitLeaveCtx.operationId);

  const freshGame = { ...game, ...nextGameState };
  gameUpdate.payload = { acknowledged: true, matchedCount: 1 };
  const gameAck = run("fn_split_leave_game_ack.js", gameUpdate).result[0];
  gameAck.payload = [freshGame];
  const fenced = run("fn_split_leave_generation_fence.js", gameAck).result[0];
  assert.equal(fenced._splitLeaveCtx.supersededByRejoin, undefined);
  assert.equal(fenced._splitLeaveCtx.chatCleanupSkipped, true);

  const doneUpdate = run("fn_split_leave_operation_done.js", fenced).result[0];
  assert.equal(doneUpdate.payload[1].$set.outcome, "REMOVED");
  doneUpdate.payload = { acknowledged: true, matchedCount: 1 };
  const doneAck = run("fn_split_leave_operation_done_ack.js", doneUpdate).result[0];
  const finalized = run("fn_split_leave_finalize.js", doneAck).result[0];
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.payload.state, "DONE");
});

test("self leave fails before STARTED when one phone is linked to distinct strong client ids", () => {
  const game = selfGame();
  game.participants.push({ id: "client-foreign", phone: "79990000001", status: "CONFIRMED" });
  game.metadata.splitPayment.payments.push({
    clientId: "client-foreign",
    phoneNorm: "79990000001",
    bookingId: "booking-foreign",
    status: "PAID",
  });
  const prepared = prepareSelf();
  prepared.payload = [game];
  const result = run("fn_split_leave_authorize.js", prepared).result;
  assert.equal(result[0], null);
  assert.equal(result[3], undefined);
  assert.equal(result[4], undefined);
  assert.equal(result[1].statusCode, 409);
  assert.match(result[1].payload.message, /несколькими профилями/);
});

test("organizer target fails before STARTED when target phone links distinct client ids", () => {
  const game = selfGame();
  game.organizer = { id: "client-1", phone: "79990000001" };
  game.metadata.organizerId = "client-1";
  game.metadata.organizerPhoneNorm = "79990000001";
  game.metadata.splitPayment.payments.push(
    { clientId: "client-2", phoneNorm: "79990000002", bookingId: "booking-2", status: "PAID" },
    { clientId: "client-foreign", phoneNorm: "79990000002", bookingId: "booking-foreign", status: "PAID" },
  );
  game.participants.push({ id: "client-foreign", phone: "79990000002", status: "CONFIRMED" });
  const prepared = prepareSelf({ reason: "ORGANIZER_REMOVED", bookingIds: ["booking-2"] });
  prepared.payload = [game];
  const result = run("fn_split_leave_authorize.js", prepared, {
    global: { vivacrm_access_token: "service-token" },
  }).result;
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 409);
  assert.match(result[1].payload.message, /несколькими профилями/);
});

test("game update never removes a distinct strong client id that shares the target phone", () => {
  const authorized = authorizeSelf();
  authorized._splitLeaveCtx.step = "local_apply";
  authorized._splitLeaveCtx.game.participants.push({
    id: "client-foreign",
    phone: "79990000001",
    status: "CONFIRMED",
  });
  authorized._splitLeaveCtx.game.metadata.splitPayment.payments.push({
    clientId: "client-foreign",
    phoneNorm: "79990000001",
    bookingId: "booking-foreign",
    status: "PAID",
  });
  const update = run("fn_split_leave_game_update.js", authorized).result[0].payload[1].$set;
  assert.deepEqual(update.participants.map((item: Msg) => item.id).sort(), ["client-2", "client-foreign"]);
  const foreignPayment = update.metadata.splitPayment.payments.find((item: Msg) => item.clientId === "client-foreign");
  assert.equal(foreignPayment.status, "PAID");
  assert.equal(foreignPayment.leaveOperationId, undefined);
});

test("verified Viva cancellation reaches local apply only after active and history read-back", () => {
  let msg = authorizeSelf();
  let out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  assert.match(msg.url, /end-user\/api\/v1\/iSkq6G\/bookings\/booking-1\/cancel$/);

  msg.statusCode = 200;
  msg.payload = { cancellationOptions: { subscription: { available: true } } };
  out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  assert.equal(msg.method, "DELETE");
  assert.deepEqual(msg.payload, {});

  msg.statusCode = 200;
  msg.payload = {};
  out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  assert.match(msg.url, /end-user\/api\/v2\/iSkq6G\/bookings\?size=1000$/);

  msg.statusCode = 200;
  msg.payload = { content: [] };
  out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  assert.match(msg.url, /bookings\/history\?includeCanceled=true/);

  msg.statusCode = 200;
  msg.payload = { content: [{ id: "booking-1", isCancelled: true }] };
  out = run("fn_split_leave_router.js", msg).result;
  assert.equal(out[3]._splitLeaveCtx.step, "local_apply");
  assert.equal(out[1], null);
});

test("requested refund method is selected only when the exact Viva option is available", () => {
  for (const requestedRefundMethod of ["CURRENCY", "DEPOSIT", "SERVICE"]) {
    let msg = authorizeSelf(selfGame(), { refundMethod: requestedRefundMethod });
    msg = run("fn_split_leave_router.js", msg).result[0];
    msg.statusCode = 200;
    msg.payload = {
      cancellationOptions: {
        money: { available: true },
        deposit: { available: true },
        subscription: { available: true },
      },
    };
    const cancel = run("fn_split_leave_router.js", msg).result[0];
    if (requestedRefundMethod === "SERVICE") {
      assert.deepEqual(cancel.payload, {});
      assert.equal(cancel._splitLeaveCtx.refundMessage, "Вернули занятие на абонемент.");
    } else {
      assert.deepEqual(cancel.payload, { refundMethod: requestedRefundMethod });
      assert.equal(cancel._splitLeaveCtx.refundMessage, undefined);
    }
  }

  let unavailable = authorizeSelf(selfGame(), { refundMethod: "DEPOSIT" });
  unavailable = run("fn_split_leave_router.js", unavailable).result[0];
  unavailable.statusCode = 200;
  unavailable.payload = { cancellationOptions: { money: { available: true } } };
  const rejected = run("fn_split_leave_router.js", unavailable).result;
  assert.equal(rejected[0], null);
  assert.equal(rejected[1].statusCode, 409);
});

test("active Viva row blocks every local mutation", () => {
  let msg = authorizeSelf();
  let out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  msg.statusCode = 404;
  msg.payload = {};
  out = run("fn_split_leave_router.js", msg).result;
  msg = out[0];
  assert.match(msg.url, /bookings\?size=1000$/);
  msg.statusCode = 200;
  msg.payload = { content: [{ id: "booking-1", isCancelled: false }] };
  out = run("fn_split_leave_router.js", msg).result;
  assert.equal(out[3], null);
  assert.equal(out[1].statusCode, 422);
  assert.equal(out[1].payload.state, "VIVA_UNVERIFIED");
});

test("self leave discovers a missing game bookingId from the exact active Viva exercise", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  delete game.booking.bookingId;
  const authorized = authorizeSelf(game);
  assert.deepEqual(authorized._splitLeaveCtx.initialBookingIds, []);
  assert.equal(authorized._splitLeaveCtx.needsBookingDiscovery, true);

  let out = run("fn_split_leave_router.js", authorized).result;
  let msg = out[0];
  assert.match(msg.url, /bookings\?size=1000$/);

  msg.statusCode = 200;
  msg.payload = {
    content: [{
      id: "discovered-booking-1",
      exercise: { id: "exercise-1" },
      isCancelled: false,
    }],
  };
  out = run("fn_split_leave_router.js", msg).result;
  assert.equal(out[0], null, "cancellation must not start before durable STARTED");
  msg = out[4];
  assert.ok(msg);
  const operationId = msg._splitLeaveCtx.operationId;
  const started = run("fn_split_leave_operation_start.js", msg).result[0];
  assert.deepEqual(started.payload[1].$setOnInsert.bookingIds, ["discovered-booking-1"]);
  assert.equal(started.payload[1].$setOnInsert.membershipVersion, msg._splitLeaveCtx.membershipVersion);
  started.payload = [{
    _id: `game-1:${operationId}`,
    state: "STARTED",
    claimToken: started._splitLeaveCtx.claimToken,
    bookingIds: ["discovered-booking-1"],
    membershipVersion: started._splitLeaveCtx.membershipVersion,
    vivaTargetMode: "BOOKINGS",
  }];
  msg = run("fn_split_leave_operation_route.js", started).result[0];
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [{ id: "discovered-booking-1", exercise: { id: "exercise-1" }, isCancelled: false }] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  assert.match(msg.url, /bookings\/discovered-booking-1\/cancel$/);
  assert.deepEqual(msg._splitLeaveCtx.initialBookingIds, ["discovered-booking-1"]);

  msg.statusCode = 200;
  msg.payload = { cancellationOptions: { subscription: { available: true } } };
  msg = run("fn_split_leave_router.js", msg).result[0];
  assert.equal(msg.method, "DELETE");
  assert.deepEqual(msg.payload, {});
  msg.statusCode = 200;
  msg.payload = {};
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [{ id: "discovered-booking-1", isCancelled: true }] };
  const verified = run("fn_split_leave_router.js", msg).result[3];
  verified._splitLeaveCtx.operationKey = "game-1:self-leave:game-1:client-1";
  verified._splitLeaveCtx.operationState = "STARTED";
  const persisted = run("fn_split_leave_operation_viva_confirmed.js", verified).result[0];
  assert.deepEqual(persisted.payload[1].$set.bookingIds, ["discovered-booking-1"]);
  assert.equal(persisted.payload[1].$set.refundMessage, "Вернули занятие на абонемент.");
});

test("self leave without any exact active Viva booking is local-only and never promises a refund", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  game.metadata.splitPayment.payments[0].paymentRef = "membership-1";
  delete game.booking.bookingId;
  let msg = authorizeSelf(game);
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = {
    content: [{ id: "other-booking", exercise: { id: "other-exercise" }, isCancelled: false }],
  };
  msg = run("fn_split_leave_router.js", msg).result[0];
  assert.match(msg.url, /bookings\/history/);
  msg.statusCode = 200;
  msg.payload = { content: [] };
  const verified = run("fn_split_leave_router.js", msg).result[4];
  assert.equal(verified._splitLeaveCtx.localOnlyNoBooking, true);
  assert.equal(verified._splitLeaveCtx.successMessage, "Вы вышли из игры");
  assert.equal(verified._splitLeaveCtx.refundMessage, undefined);

  const started = run("fn_split_leave_operation_start.js", verified).result[0];
  assert.equal(started.payload[1].$setOnInsert.vivaTargetMode, "NONE");
  assert.equal(started.payload[1].$setOnInsert.successMessage, "Вы вышли из игры");
});

test("local-only discovery fails if an active exact booking appears in history race window", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  game.metadata.splitPayment.payments[0].paymentRef = "membership-1";
  delete game.booking.bookingId;
  let msg = authorizeSelf(game);
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = {
    content: [{ id: "racing-booking", exercise: { id: "exercise-1" }, isCancelled: false }],
  };
  const out = run("fn_split_leave_router.js", msg).result;
  assert.equal(out[3], null);
  assert.equal(out[1].statusCode, 422);
  assert.equal(out[1].payload.state, "VIVA_UNVERIFIED");
});

test("exact active Viva exercise row without a booking id fails closed", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  game.metadata.splitPayment.payments[0].paymentRef = "membership-1";
  delete game.booking.bookingId;
  let msg = authorizeSelf(game);
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [{ exercise: { id: "exercise-1" }, isCancelled: false }] };
  const out = run("fn_split_leave_router.js", msg).result;
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 422);
  assert.equal(out[1].payload.state, "VIVA_UNVERIFIED");
});

test("already-applied operation reads durable DONE directly and remains idempotent", () => {
  const game = selfGame();
  const operationId = authorizeSelf(game)._splitLeaveCtx.operationId;
  game.metadata.leaveOperations = [{ operationId, state: "DONE" }];
  const authorized = authorizeSelf(game);
  assert.equal(authorized._splitLeaveCtx.localAlreadyApplied, true);
  assert.deepEqual(authorized.payload, { _id: `game-1:${operationId}` });
  authorized.payload = [{ _id: `game-1:${operationId}`, state: "DONE", successMessage: "Вы вышли из игры" }];
  const routed = run("fn_split_leave_operation_route.js", authorized).result;
  assert.deepEqual(routed.slice(0, 2), [null, null]);
  assert.equal(routed[2].statusCode, 200);
  assert.equal(routed[2].payload.state, "DONE");
});

test("local apply removes active roster while historical chat projection remains non-authoritative", () => {
  const authorized = authorizeSelf();
  authorized._splitLeaveCtx.operationKey = `game-1:${authorized._splitLeaveCtx.operationId}`;
  authorized._splitLeaveCtx.step = "local_apply";
  authorized._splitLeaveCtx.vivaVerifiedAt = "2026-08-01T09:01:00.000Z";
  const gameUpdate = run("fn_split_leave_game_update.js", authorized).result[0];
  const gameSet = gameUpdate.payload[1].$set;
  assert.deepEqual(gameSet.participants.map((item: Msg) => item.id), ["client-2"]);
  assert.equal(gameSet.organizer.id, "client-3");
  assert.deepEqual(gameSet.allRelatedPhones, ["79990000003", "79990000002"]);
  assert.equal(gameSet.metadata.splitPayment.payments[0].status, "LEFT");
  assert.equal(gameSet.metadata.leaveOperations[0].operationId, authorized._splitLeaveCtx.operationId);
  assert.equal(gameSet.metadata.selfRemovalAuditLog[0].status, "cancelled_in_viva");
  assert.equal(gameSet.metadata.selfRemovalAuditLog[0].verification, "active_absent_history_cancelled");
  assert.equal(gameUpdate.payload[1].$unset.resultRosterSnapshot, "");

  gameUpdate.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const gameAck = run("fn_split_leave_game_ack.js", gameUpdate).result[0];
  assert.deepEqual(gameAck.payload, { id: "game-1", archived: { $ne: true } });
  gameAck.payload = [{ ...authorized._splitLeaveCtx.game, ...gameSet, id: "game-1" }];
  const fenced = run("fn_split_leave_generation_fence.js", gameAck).result[0];
  assert.equal(fenced._splitLeaveCtx.chatCleanupSkipped, true);
  const doneUpdate = run("fn_split_leave_operation_done.js", fenced).result[0];
  assert.equal(doneUpdate.payload[0]._id, `game-1:${authorized._splitLeaveCtx.operationId}`);
  doneUpdate.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const doneAck = run("fn_split_leave_operation_done_ack.js", doneUpdate).result[0];
  const finalized = run("fn_split_leave_finalize.js", doneAck, {
    global: { lkTournamentParticipantEpochV1: { "exercise-1": 4, other: 9 } },
  });
  assert.equal(finalized.result[0].statusCode, 200);
  assert.equal(finalized.result[0].payload.state, "DONE");
  assert.deepEqual(finalized.globalValues.lkTournamentParticipantEpochV1, {
    "exercise-1": 5,
    other: 9,
  });
});

test("local apply invalidates a historical JOINED decision for the leaving phone", () => {
  const game = selfGame({
    metadata: {
      ...selfGame().metadata,
      joinResponses: {
        "79990000001": { status: "JOINED", playerId: "client-1" },
      },
    },
  });
  const authorized = authorizeSelf(game);
  authorized._splitLeaveCtx.step = "local_apply";
  const update = run("fn_split_leave_game_update.js", authorized).result[0].payload[1].$set;
  assert.equal(update.metadata.joinResponses["79990000001"].status, "DECLINED");
  assert.equal(
    update.metadata.joinResponses["79990000001"].operationId,
    authorized._splitLeaveCtx.operationId,
  );
  assert.match(update.metadata.joinResponses["79990000001"].leftAt, /^\d{4}-/);
});

test("local-only leave records no Viva booking target instead of a cancellation claim", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  game.metadata.splitPayment.payments[0].paymentRef = "membership-1";
  delete game.booking.bookingId;
  const authorized = authorizeSelf(game);
  authorized._splitLeaveCtx.step = "local_apply";
  authorized._splitLeaveCtx.localOnlyNoBooking = true;
  authorized._splitLeaveCtx.vivaVerification = "no_active_booking_for_exercise";
  const update = run("fn_split_leave_game_update.js", authorized).result[0].payload[1].$set;
  assert.equal(update.metadata.selfRemovalAuditLog[0].status, "no_viva_booking_target");
  assert.equal(update.metadata.selfRemovalAuditLog[0].verification, "no_active_booking_for_exercise");
});

test("Viva-confirmed Mongo CAS miss returns retry-required instead of false success", () => {
  const authorized = authorizeSelf();
  authorized._splitLeaveCtx.step = "local_apply";
  authorized.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  const result = run("fn_split_leave_operation_done.js", authorized).result[1];
  assert.equal(result.statusCode, 202);
  assert.equal(result.payload.state, "RETRY_REQUIRED");
});

test("durable STARTED record is written before Viva and only its owner proceeds", () => {
  const authorized = authorizeSelf();
  const start = run("fn_split_leave_operation_start.js", authorized).result[0];
  const [filter, update, options] = start.payload;
  assert.equal(filter._id, `game-1:${authorized._splitLeaveCtx.operationId}`);
  assert.equal(update.$setOnInsert.state, "STARTED");
  assert.equal(update.$setOnInsert.claimToken, start._splitLeaveCtx.claimToken);
  assert.match(update.$setOnInsert.claimLeaseUntil, /^2026-|^2027-/);
  assert.deepEqual(options, { upsert: true });

  start.payload = { acknowledged: true, upsertedCount: 1, matchedCount: 0 };
  const find = run("fn_split_leave_operation_find.js", start).result[0];
  assert.deepEqual(find.payload, { _id: filter._id });

  find.payload = [{
    _id: filter._id,
    state: "STARTED",
    claimToken: find._splitLeaveCtx.claimToken,
    claimLeaseUntil: update.$setOnInsert.claimLeaseUntil,
  }];
  const owned = run("fn_split_leave_operation_route.js", find).result;
  assert.equal(owned[0]._splitLeaveCtx.step, "start_verify_active");
  assert.equal(owned[2], null);
  const preflight = run("fn_split_leave_router.js", owned[0]).result[0];
  assert.equal(preflight.method, "GET");
  assert.match(preflight.url, /end-user\/api\/v2\/iSkq6G\/bookings\?size=1000$/);

  const concurrent = authorizeSelf();
  concurrent._splitLeaveCtx.operationKey = filter._id;
  concurrent.payload = [{
    _id: filter._id,
    state: "STARTED",
    claimToken: "other-owner",
    claimLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
  }];
  const blocked = run("fn_split_leave_operation_route.js", concurrent).result;
  assert.equal(blocked[0], null);
  assert.equal(blocked[2].statusCode, 202);
  assert.equal(blocked[2].payload.state, "IN_PROGRESS");
});

test("expired STARTED lease is taken over with an exact token-and-lease CAS", () => {
  const msg = authorizeSelf();
  msg._splitLeaveCtx.operationKey = "game-1:self-leave:game-1:client-1";
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  msg.payload = [{
    _id: msg._splitLeaveCtx.operationKey,
    state: "STARTED",
    claimToken: "stale-owner",
    claimLeaseUntil: expiredAt,
  }];
  const routed = run("fn_split_leave_operation_route.js", msg).result[3];
  const claim = run("fn_split_leave_operation_claim.js", routed).result[0];
  assert.deepEqual(claim.payload[0], {
    _id: msg._splitLeaveCtx.operationKey,
    state: "STARTED",
    claimToken: "stale-owner",
    claimLeaseUntil: { $lte: claim.payload[1].$set.lastAttemptAt },
  });
  claim.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const acknowledged = run("fn_split_leave_operation_claim_ack.js", claim).result[0];
  assert.equal(acknowledged._splitLeaveCtx.step, "start_verify_active");
});

test("VIVA_CONFIRMED is persisted before local mutation and a foreign live lease cannot overlap", () => {
  const msg = authorizeSelf();
  msg._splitLeaveCtx.operationKey = "game-1:self-leave:game-1:client-1";
  msg._splitLeaveCtx.operationState = "STARTED";
  msg._splitLeaveCtx.vivaVerifiedAt = "2026-08-01T09:05:00.000Z";
  const persist = run("fn_split_leave_operation_viva_confirmed.js", msg).result[0];
  assert.deepEqual(persist.payload[0], {
    _id: msg._splitLeaveCtx.operationKey,
    state: "STARTED",
    claimToken: msg._splitLeaveCtx.claimToken,
  });
  assert.equal(persist.payload[1].$set.state, "VIVA_CONFIRMED");
  assert.equal(persist.payload[1].$set.vivaConfirmedAt, "2026-08-01T09:05:00.000Z");
  assert.equal(persist.payload[1].$set.localApplyClaimToken, msg._splitLeaveCtx.claimToken);
  assert.equal(persist.payload[1].$inc.localApplyAttempts, 1);

  const concurrent = authorizeSelf();
  concurrent._splitLeaveCtx.operationKey = msg._splitLeaveCtx.operationKey;
  concurrent.payload = [{
    _id: msg._splitLeaveCtx.operationKey,
    state: "VIVA_CONFIRMED",
    localApplyClaimToken: msg._splitLeaveCtx.claimToken,
    localApplyLeaseUntil: persist.payload[1].$set.localApplyLeaseUntil,
  }];
  const blocked = run("fn_split_leave_operation_route.js", concurrent).result;
  assert.equal(blocked[0], null);
  assert.equal(blocked[2].statusCode, 202);
  assert.equal(blocked[2].payload.state, "IN_PROGRESS");
});

test("stale Viva owner cannot confirm after claim takeover", () => {
  const staleOwner = authorizeSelf();
  staleOwner._splitLeaveCtx.operationKey = "game-1:self-leave:game-1:client-1";
  staleOwner._splitLeaveCtx.operationState = "STARTED";
  staleOwner._splitLeaveCtx.vivaVerifiedAt = "2026-08-01T09:05:00.000Z";
  const persist = run("fn_split_leave_operation_viva_confirmed.js", staleOwner).result[0];
  assert.equal(persist.payload[0].claimToken, staleOwner._splitLeaveCtx.claimToken);

  persist.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  const ack = run("fn_split_leave_operation_viva_ack.js", persist).result;
  assert.equal(ack[0], null);
  assert.equal(ack[1].statusCode, 202);
  assert.equal(ack[1].payload.state, "RETRY_REQUIRED");
});

test("background retry atomically claims and increments an eligible local apply", () => {
  const expectedVersion = authorizeSelf()._splitLeaveCtx.membershipVersion;
  const selected = run("fn_split_leave_retry_select.js", {
    payload: [{
      _id: "operation-1",
      operationId: "self-leave:game-1:client-1",
      gameId: "game-1",
      exerciseId: "exercise-1",
      mode: "SELF",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      bookingIds: ["booking-1"],
      membershipVersion: expectedVersion,
      state: "VIVA_CONFIRMED",
    }],
  }, { global: { vivacrm_access_token: "service-token" } }).result[0];
  assert.equal(selected.payload[0].state, "VIVA_CONFIRMED");
  assert.equal(selected.payload[0].localApplyAttempts.$lt, 20);
  assert.equal(selected.payload[1].$inc.localApplyAttempts, 1);
  assert.match(selected.payload[1].$set.localApplyClaimToken, /^retry-/);

  const lostRace = structuredClone(selected);
  lostRace.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  assert.equal(run("fn_split_leave_retry_claim_ack.js", lostRace).result[0], null);

  selected.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  const claimed = run("fn_split_leave_retry_claim_ack.js", selected).result[0];
  assert.deepEqual(claimed.payload, { id: "game-1", archived: { $ne: true } });
  claimed.payload = [selfGame()];
  const hydrated = run("fn_split_leave_retry_hydrate.js", claimed).result[0];
  assert.equal(hydrated._splitLeaveCtx.step, "local_apply");
  assert.equal(hydrated._splitLeaveCtx.backgroundRetry, true);
});

test("legacy local-only self membership without an immutable key fails closed", () => {
  const game = selfGame();
  delete game.metadata.splitPayment.payments[0].bookingId;
  delete game.booking.bookingId;
  let msg = authorizeSelf(game);
  assert.equal(msg._splitLeaveCtx.membershipVersion, null);
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [] };
  const result = run("fn_split_leave_router.js", msg).result;
  assert.equal(result[4], null);
  assert.equal(result[1].statusCode, 409);
  assert.match(result[1].payload.message, /поколение записи/);
});

test("STARTED recovery is discoverable only when a service token exists", () => {
  const withoutToken = run("fn_split_leave_retry_query.js", {}, { global: {} }).result;
  assert.equal(withoutToken.payload.$or.length, 2);
  assert.equal(withoutToken.payload.$or[0].state, "VIVA_CONFIRMED");
  assert.equal(withoutToken.payload.$or[1].vivaTargetMode, "NONE");
  const withToken = run("fn_split_leave_retry_query.js", {}, {
    global: { vivacrm_access_token: "service-token" },
  }).result;
  assert.deepEqual(withToken.payload.$or.map((item: Msg) => item.state), ["VIVA_CONFIRMED", "STARTED", "STARTED"]);
  assert.deepEqual(withToken.payload.$or[2].vivaTargetMode, { $ne: "NONE" });
});

test("STARTED retry rebuilds the exact booking queue before any Viva attempt", () => {
  const authorized = authorizeSelf();
  const selected = run("fn_split_leave_retry_select.js", {
    payload: [{
      _id: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      state: "STARTED",
      claimToken: "expired-owner",
      gameId: "game-1",
      exerciseId: "exercise-1",
      mode: "SELF",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      bookingIds: ["booking-1"],
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
      vivaTargetMode: "BOOKINGS",
    }],
  }, { global: { vivacrm_access_token: "service-token" } }).result[0];
  assert.equal(selected.payload[0].state, "STARTED");
  assert.equal(selected.payload[1].$inc.recoveryAttempts, 1);
  selected.payload = { acknowledged: true, matchedCount: 1 };
  const claimed = run("fn_split_leave_retry_claim_ack.js", selected).result[0];
  claimed.payload = [selfGame()];
  const hydrated = run("fn_split_leave_retry_hydrate.js", claimed, {
    global: { vivacrm_access_token: "service-token" },
  }).result[1];
  assert.equal(hydrated._splitLeaveCtx.step, "start_verify_active");
  assert.deepEqual(hydrated._splitLeaveCtx.bookingQueue, [{ bookingId: "booking-1", clientId: "client-1" }]);
  assert.equal(hydrated._splitLeaveCtx.upstreamAuthHeader, "Bearer service-token");
});

test("late retry preserves a newer rejoin generation without game or chat mutation", () => {
  const authorized = authorizeSelf();
  const rejoined = selfGame();
  rejoined.metadata.splitPayment.payments = [
    { ...rejoined.metadata.splitPayment.payments[0], status: "LEFT", leaveOperationId: authorized._splitLeaveCtx.operationId },
    {
      clientId: "client-1",
      phoneNorm: "79990000001",
      bookingId: "booking-2",
      status: "PAID",
    },
  ];
  const msg = {
    _splitLeaveCtx: {
      backgroundRetry: true,
      operationKey: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      operationState: "VIVA_CONFIRMED",
      claimToken: "retry-1",
      gameId: "game-1",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
      step: "local_apply",
    },
    payload: [rejoined],
  };
  const hydrated = run("fn_split_leave_retry_hydrate.js", msg).result;
  assert.equal(hydrated[0], null);
  assert.equal(hydrated[1], null);
  assert.equal(hydrated[3]._splitLeaveCtx.supersededByRejoin, true);
  const done = run("fn_split_leave_operation_done.js", hydrated[3]).result[0];
  assert.equal(done.payload[1].$set.outcome, "REJOIN_PRESERVED");
  assert.equal(done.payload[1].$push.transitions.$each[0].state, "SUPERSEDED");
});

test("STARTED retry cancels the persisted old Viva booking before preserving a newer rejoin", () => {
  const authorized = authorizeSelf();
  const rejoined = selfGame();
  rejoined.metadata.splitPayment.payments = [
    { ...rejoined.metadata.splitPayment.payments[0], status: "LEFT" },
    { clientId: "client-1", phoneNorm: "79990000001", bookingId: "booking-2", status: "PAID" },
  ];
  let msg: Msg = {
    _splitLeaveCtx: {
      backgroundRetry: true,
      operationKey: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      operationState: "STARTED",
      claimToken: "retry-started",
      gameId: "game-1",
      exerciseId: "exercise-1",
      mode: "SELF",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
      vivaTargetMode: "BOOKINGS",
      initialBookingIds: ["booking-1"],
      bookingQueue: [{ bookingId: "booking-1", clientId: "client-1" }],
    },
    payload: [rejoined],
  };
  msg = run("fn_split_leave_retry_hydrate.js", msg, {
    global: { vivacrm_access_token: "service-token" },
  }).result[1];
  assert.equal(msg._splitLeaveCtx.localMutationDisabled, true);
  assert.equal(msg._splitLeaveCtx.step, "start_verify_active");
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [
    { id: "booking-1", clientId: "client-1", isCancelled: false },
    { id: "booking-2", clientId: "client-1", isCancelled: false },
  ] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  assert.match(msg.url, /clients\/client-1\/bookings\/booking-1\/cancel$/);
  msg.statusCode = 200;
  msg.payload = { cancellationOptions: { subscription: { available: true } } };
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = {};
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [{ id: "booking-2", clientId: "client-1", isCancelled: false }] };
  msg = run("fn_split_leave_router.js", msg).result[0];
  msg.statusCode = 200;
  msg.payload = { content: [{ id: "booking-1", clientId: "client-1", isCancelled: true }] };
  const verified = run("fn_split_leave_router.js", msg).result[3];
  const persist = run("fn_split_leave_operation_viva_confirmed.js", verified).result[0];
  assert.equal(persist.payload[1].$set.state, "VIVA_CONFIRMED");
  persist.payload = { acknowledged: true, matchedCount: 1 };
  const ack = run("fn_split_leave_operation_viva_ack.js", persist).result;
  assert.equal(ack[0], null);
  assert.equal(ack[2]._splitLeaveCtx.supersededByRejoin, true);
  assert.equal(ack[2]._splitLeaveCtx.chatCleanupSkipped, true);
  const done = run("fn_split_leave_operation_done.js", ack[2]).result[0];
  assert.equal(done.payload[1].$set.outcome, "REJOIN_PRESERVED");
});

test("prior leave marker plus a newer generation never re-enters chat cleanup", () => {
  const authorized = authorizeSelf();
  const rejoined = selfGame();
  rejoined.metadata.leaveOperations = [{ operationId: authorized._splitLeaveCtx.operationId, state: "DONE" }];
  rejoined.metadata.splitPayment.payments = [
    { ...rejoined.metadata.splitPayment.payments[0], status: "LEFT" },
    { clientId: "client-1", phoneNorm: "79990000001", bookingId: "booking-2", status: "PAID" },
  ];
  const result = run("fn_split_leave_retry_hydrate.js", {
    _splitLeaveCtx: {
      operationKey: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      operationState: "VIVA_CONFIRMED",
      gameId: "game-1",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
    },
    payload: [rejoined],
  }).result;
  assert.equal(result[0], null);
  assert.equal(result[3]._splitLeaveCtx.supersededByRejoin, true);
  assert.equal(result[3]._splitLeaveCtx.chatCleanupSkipped, true);
});

test("fresh post-CAS generation fence preserves a rejoin and never emits chat mutation", () => {
  const authorized = authorizeSelf();
  authorized._splitLeaveCtx.gameApplyAcknowledged = true;
  authorized._splitLeaveCtx.operationKey = `game-1:${authorized._splitLeaveCtx.operationId}`;
  const rejoined = selfGame();
  rejoined.metadata.splitPayment.payments = [
    { ...rejoined.metadata.splitPayment.payments[0], status: "LEFT" },
    { clientId: "client-1", phoneNorm: "79990000001", bookingId: "booking-2", status: "PAID" },
  ];
  authorized.payload = [rejoined];
  const fenced = run("fn_split_leave_generation_fence.js", authorized).result;
  assert.equal(fenced[1], null);
  assert.equal(fenced[0]._splitLeaveCtx.supersededByRejoin, true);
  assert.equal(fenced[0]._splitLeaveCtx.chatCleanupSkipped, true);
  assert.equal(fenced[0].payload, undefined);
});

test("STARTED booking recovery does not consume a lease after its service token disappears", () => {
  const operation = {
    _id: "op-1",
    operationId: "self-leave:game-1:client-1:version",
    state: "STARTED",
    gameId: "game-1",
    vivaTargetMode: "BOOKINGS",
  };
  const blocked = run("fn_split_leave_retry_select.js", { payload: [operation] }, { global: {} }).result;
  assert.equal(blocked[0], null);
  assert.equal(blocked[1].payload.reason, "service_token_missing_before_claim");
  assert.equal(blocked[1]._splitLeaveCtx, undefined);

  const none = run("fn_split_leave_retry_select.js", {
    payload: [{ ...operation, vivaTargetMode: "NONE" }],
  }, { global: {} }).result[0];
  assert.equal(none.payload[0].state, "STARTED");
  assert.equal(none.payload[1].$inc.recoveryAttempts, 1);
});

test("STARTED NONE recovery needs no token but still persists VIVA_CONFIRMED before game CAS", () => {
  const authorized = authorizeSelf();
  const msg: Msg = {
    _splitLeaveCtx: {
      operationKey: `game-1:${authorized._splitLeaveCtx.operationId}`,
      operationId: authorized._splitLeaveCtx.operationId,
      operationState: "STARTED",
      claimToken: "retry-none",
      gameId: "game-1",
      exerciseId: "exercise-1",
      mode: "SELF",
      targetClientId: "client-1",
      targetPhoneNorm: "79990000001",
      membershipVersion: authorized._splitLeaveCtx.membershipVersion,
      vivaTargetMode: "NONE",
      initialBookingIds: [],
    },
    payload: [selfGame()],
  };
  const hydrated = run("fn_split_leave_retry_hydrate.js", msg, { global: {} }).result;
  assert.equal(hydrated[0], null);
  assert.equal(hydrated[1]._splitLeaveCtx.step, "local_apply");
  const routed = run("fn_split_leave_router.js", hydrated[1]).result;
  assert.equal(routed[3]._splitLeaveCtx.step, "local_apply");
  const persist = run("fn_split_leave_operation_viva_confirmed.js", routed[3]).result[0];
  assert.equal(persist.payload[1].$set.state, "VIVA_CONFIRMED");
});

test("durable operation records never persist bearer or auth headers", () => {
  const authorized = authorizeSelf();
  const started = run("fn_split_leave_operation_start.js", authorized).result[0];
  const serialized = JSON.stringify(started.payload);
  assert.doesNotMatch(serialized, /Bearer|authHeader|upstreamAuthHeader|user-token/i);
});

test("concurrent DONE matchedCount zero succeeds only after durable DONE read-back", () => {
  const msg = authorizeSelf();
  msg._splitLeaveCtx.operationKey = "game-1:self-leave:game-1:client-1";
  msg.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  const ack = run("fn_split_leave_operation_done_ack.js", msg).result;
  assert.deepEqual(ack[1].payload, { _id: msg._splitLeaveCtx.operationKey });

  ack[1].payload = [{ _id: msg._splitLeaveCtx.operationKey, state: "DONE" }];
  const readback = run("fn_split_leave_operation_done_readback.js", ack[1]).result[0];
  const finalized = run("fn_split_leave_finalize.js", readback, {
    global: { lkTournamentParticipantEpochV1: {} },
  }).result[0];
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.payload.state, "DONE");
});

test("persistence catch does not claim Viva was changed before confirmation", () => {
  const preViva = run("fn_split_leave_retry_response.js", {
    _splitLeaveCtx: {
      operationId: "self-leave:game-1:client-1",
      gameId: "game-1",
      operationState: "STARTED",
      step: "start_verify_active",
    },
    error: { message: "Mongo unavailable" },
  }).result[0];
  assert.equal(preViva.statusCode, 503);
  assert.equal(preViva.payload.ok, false);
  assert.equal(preViva.payload.state, "PERSISTENCE_UNAVAILABLE");
  assert.match(preViva.payload.message, /Viva не изменялась/);

  const postViva = run("fn_split_leave_retry_response.js", {
    _splitLeaveCtx: {
      operationId: "self-leave:game-1:client-1",
      gameId: "game-1",
      operationState: "VIVA_CONFIRMED",
    },
    error: { message: "Mongo unavailable" },
  }).result[0];
  assert.equal(postViva.statusCode, 202);
  assert.equal(postViva.payload.ok, true);
  assert.equal(postViva.payload.state, "RETRY_REQUIRED");
});
