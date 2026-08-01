const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const operation = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
const respond = (statusCode, state, message) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { ok: statusCode < 300, state, operationId: ctx?.operationId || null, gameId: ctx?.gameId || null, ...(message ? { message } : {}) };
  delete msg._splitLeaveCtx;
  return [null, null, msg];
};
if (!ctx || !operation) return respond(503, "CONFLICT", "Операция удаления не найдена после записи");
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
msg._splitLeaveCtx = ctx;
if (ctx.operationState === "DONE") {
  return respond(200, "DONE", operation.refundMessage || operation.successMessage || "Вы вышли из игры");
}
if (ctx.operationState === "STARTED") {
  if (String(operation.claimToken || "") !== String(ctx.claimToken || "")) {
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
