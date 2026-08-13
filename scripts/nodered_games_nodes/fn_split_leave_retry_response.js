const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object"
  ? msg._splitLeaveCtx
  : {};
const vivaConfirmed = Boolean(
  ctx.vivaVerifiedAt
  || ["VIVA_CONFIRMED", "LK_APPLIED", "DONE"].includes(String(ctx.operationState || "").toUpperCase())
  || ctx.step === "local_apply",
);
msg.statusCode = vivaConfirmed || ctx.backgroundRetry === true ? 202 : 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};
msg.payload = {
  ok: vivaConfirmed || ctx.backgroundRetry === true,
  state: vivaConfirmed || ctx.backgroundRetry === true ? "RETRY_REQUIRED" : "PERSISTENCE_UNAVAILABLE",
  ...(ctx.mode === "STAFF_TARGET" ? {
    status: vivaConfirmed || ctx.backgroundRetry === true ? "RETRY_REQUIRED" : "PERSISTENCE_UNAVAILABLE",
    visitAction: ctx.requestedRefundMethod === "SERVICE" ? "RETURN_VISIT" : "NO_RETURN",
    playerId: ctx.targetClientId || null,
  } : {}),
  operationId: ctx.operationId || null,
  gameId: ctx.gameId || null,
  message: vivaConfirmed || ctx.backgroundRetry === true
    ? "Viva подтверждена; требуется повторить локальную синхронизацию"
    : "Не удалось безопасно начать удаление; Viva не изменялась",
};
delete msg._splitLeaveCtx;
delete msg.error;
if (ctx.backgroundRetry === true) return [null, msg];
return [msg, msg];
