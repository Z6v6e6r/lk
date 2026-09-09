const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
let operation = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
const respond = (statusCode, state, message) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  const staffFields = ctx?.mode === "STAFF_TARGET"
    ? {
      status: state,
      visitAction: ctx.requestedRefundMethod === "SERVICE" ? "RETURN_VISIT" : "NO_RETURN",
      playerId: ctx.targetClientId || null,
    }
    : {};
  msg.payload = { ok: statusCode < 300, state, ...staffFields, operationId: ctx?.operationId || null, gameId: ctx?.gameId || null, ...(message ? { message } : {}) };
  delete msg._splitLeaveCtx;
  return [null, null, msg];
};
if (ctx?.step === "find_absent_self_leave") {
  const receipts = rows.filter((row) => row?.mode === "SELF"
    && row.gameId === ctx.gameId && row.exerciseId === ctx.exerciseId
    && row.actorClientId === ctx.actorClientId && row.targetClientId === ctx.targetClientId
    && ["DONE", "RETURN_PENDING"].includes(row.state) && row.outcome === "REMOVED"
    && Number.isFinite(Date.parse(row.lkAppliedAt)) && Number.isFinite(Date.parse(row.createdAt))
    && ["active_absent_history_cancelled", "no_active_booking_for_exercise"].includes(row.vivaVerification)
    && row.operationId && row._id === `${ctx.gameId}:${row.operationId}`);
  receipts.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (msg.error || !receipts.length) return respond(403, "CONFLICT", "Подтверждённый выход из игры не найден");
  operation = receipts[0];
  ctx.operationId = operation.operationId;
  ctx.localAlreadyApplied = true;
}
// This branch only consumes durable, server-owned cancellation evidence.
if (ctx?.step === "find_local_reconciliation_proof") {
  const sameId = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  const eligible = rows.filter((row) => row && row.mode === "SELF"
    && row.gameId === ctx.gameId && sameId(row.exerciseId, ctx.exerciseId)
    && sameId(row.actorClientId, ctx.actorClientId) && sameId(row.targetClientId, ctx.targetClientId)
    && ["DONE", "RETURN_PENDING"].includes(row.state) && row.outcome === "REMOVED"
    && row.vivaVerification === "active_absent_history_cancelled"
    && Number.isFinite(Date.parse(row.lkAppliedAt)) && Number.isFinite(Date.parse(row.createdAt))
    && row.operationId && row._id === `${ctx.gameId}:${row.operationId}`
    && Array.isArray(row.bookingIds) && row.bookingIds.length > 0
    && row.bookingIds.every((id) => typeof id === "string" && id.trim()));
  eligible.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!msg.error && Array.isArray(msg.payload) && rows.length === 0) {
    // A first leave of an imported Viva participant still uses normal discovery.
    ctx.membershipVersion = null;
    ctx.operationId = `self-leave:${ctx.gameId}:${ctx.actorClientId || ctx.actorPhoneNorm}`;
    ctx.step = "start_verify_active";
    msg.payload = undefined;
    return [msg, null, null, null];
  }
  if (msg.error || !eligible.length
    || (eligible[1] && eligible[1].createdAt === eligible[0].createdAt)) {
    return respond(202, "RETRY_REQUIRED", "Не удалось подтвердить предыдущий выход. Обновите игру и повторите проверку.");
  }
  const prior = eligible[0];
  ctx.localReconciliation = {
    snapshotUpdatedAt: ctx.game.updatedAt,
    priorOperationId: prior.operationId,
    priorBookingIds: [...prior.bookingIds],
  };
  ctx.membershipVersion = null;
  ctx.localAlreadyApplied = false;
  ctx.initialBookingIds = [];
  ctx.bookingQueue = [];
  ctx.clientSubscriptionId = null;
  ctx.subscriptionVisitCount = null;
  ctx.preOperationDiscovery = true;
  ctx.step = "start_verify_active";
  msg.payload = undefined;
  return [msg, null, null, null];
}
if (!ctx || !operation) return respond(503, "CONFLICT", "Операция удаления не найдена после записи");
if (ctx.mode === "STAFF_TARGET" && (
  String(operation.mode || "").toUpperCase() !== "STAFF_TARGET"
  || String(operation.targetClientId || "").trim().toLowerCase() !== String(ctx.targetClientId || "").trim().toLowerCase()
  || String(operation.membershipVersion || "") !== String(ctx.membershipVersion || "")
  || String(operation.requestedRefundMethod || "") !== String(ctx.requestedRefundMethod || "")
)) {
  return respond(409, "CONFLICT", "Existing operation has different removal parameters");
}
ctx.localReconciliation = operation.localReconciliation || ctx.localReconciliation || null;
ctx.operationState = String(operation.state || "STARTED").toUpperCase();
ctx.operationKey = String(operation._id || ctx.operationKey);
ctx.requestedRefundMethod = operation.requestedRefundMethod || ctx.requestedRefundMethod || null;
ctx.membershipVersion = operation.membershipVersion || ctx.membershipVersion || null;
ctx.vivaTargetMode = operation.vivaTargetMode || ctx.vivaTargetMode || "BOOKINGS";
ctx.initialBookingIds = Array.isArray(operation.bookingIds) ? operation.bookingIds.filter(Boolean) : [];
ctx.bookingQueue = ctx.initialBookingIds.map((bookingId) => ({ bookingId, clientId: ctx.targetClientId }));
ctx.vivaVerifiedAt = operation.vivaVerifiedAt || ctx.vivaVerifiedAt || null;
ctx.vivaVerification = operation.vivaVerification || ctx.vivaVerification || null;
ctx.successMessage = operation.successMessage || ctx.successMessage || null;
ctx.clientSubscriptionId = operation.clientSubscriptionId || ctx.clientSubscriptionId || null;
ctx.subscriptionVisitCount = Number.isSafeInteger(operation.subscriptionVisitCount)
  ? operation.subscriptionVisitCount
  : (ctx.subscriptionVisitCount || null);
ctx.subscriptionReturnChecks = Array.isArray(operation.subscriptionReturnChecks)
  ? operation.subscriptionReturnChecks
  : [];
ctx.subscriptionReturnState = operation.subscriptionReturnState || null;
ctx.subscriptionReturnReason = operation.subscriptionReturnReason || null;
msg._splitLeaveCtx = ctx;
if (ctx.operationState === "DONE") {
  return respond(200, "DONE", operation.refundMessage || operation.successMessage || "Вы вышли из игры");
}
if (ctx.operationState === "RETURN_PENDING") {
  const serviceToken = String(global.get("vivacrm_access_token") || "").trim();
  if (!serviceToken) {
    return respond(202, "RETURN_PENDING", "Вы вышли из игры. Возврат посещения проверяется");
  }
  ctx.localAlreadyApplied = true;
  ctx.upstreamAuthHeader = `Bearer ${serviceToken}`;
  ctx.step = "start_verify_subscription_return";
  return [msg, null, null, null];
}
if (ctx.operationState === "STARTED") {
  if (String(operation.claimToken || "") !== String(ctx.claimToken || "")) {
    const currentActorId = String(ctx.actorClientId || "").trim().toLowerCase();
    const operationActorId = String(operation.actorClientId || "").trim().toLowerCase();
    const currentActorPhone = String(ctx.actorPhoneNorm || "").trim();
    const operationActorPhone = String(operation.actorPhoneNorm || "").trim();
    const sameActorIdentity = currentActorId && operationActorId
      ? currentActorId === operationActorId
      : Boolean(currentActorPhone && operationActorPhone && currentActorPhone === operationActorPhone);
    const sameSelfActor = ctx.mode === "SELF"
      && String(operation.mode || "").toUpperCase() === "SELF"
      && sameActorIdentity;
    if (sameSelfActor) {
      ctx.foregroundReclaim = true;
      ctx.previousClaimToken = String(operation.claimToken || "");
      ctx.previousClaimLeaseUntil = operation.claimLeaseUntil || null;
      return [null, null, null, msg];
    }
    const leaseUntilMs = Date.parse(String(operation.claimLeaseUntil || ""));
    if (Number.isFinite(leaseUntilMs) && leaseUntilMs > Date.now()) {
      return respond(202, "IN_PROGRESS", "Удаление уже выполняется");
    }
    ctx.previousClaimToken = String(operation.claimToken || "");
    ctx.previousClaimLeaseUntil = operation.claimLeaseUntil || null;
    return [null, null, null, msg];
  }
  if (ctx.localAlreadyApplied === true) return [null, msg, null, null];
  if (ctx.vivaTargetMode === "NONE") {
    if (ctx.localReconciliation) {
      ctx.step = "start_verify_active";
      return [msg, null, null, null];
    }
    ctx.step = "local_apply";
    return [null, msg, null, null];
  }
  ctx.preCancelVerification = true;
  ctx.step = "start_verify_active";
  return [msg, null, null, null];
}
if (["VIVA_CONFIRMED", "LK_APPLIED"].includes(ctx.operationState)) {
  const leaseUntilMs = Date.parse(String(operation.localApplyLeaseUntil || ""));
  const sameClaim = String(operation.localApplyClaimToken || "") === String(ctx.claimToken || "");
  if (!sameClaim && Number.isFinite(leaseUntilMs) && leaseUntilMs > Date.now()) {
    return respond(202, "IN_PROGRESS", "Локальная синхронизация уже выполняется");
  }
  if (!sameClaim) return respond(202, "RETRY_REQUIRED", "Локальная синхронизация ожидает фонового повтора");
  ctx.step = "local_apply";
  return [null, msg, null, null];
}
return respond(409, "CONFLICT", "Неизвестное состояние операции удаления");
