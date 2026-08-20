const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error || matched < 1) {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Viva подтверждена; требуется повторить локальную синхронизацию",
  };
  return [null, msg, null];
}
ctx.step = "local_apply";
if (ctx.localAlreadyApplied === true && ctx.subscriptionReturnState === "RETURN_VERIFIED") {
  msg._splitLeaveCtx = ctx;
  msg.payload = undefined;
  return [null, null, msg];
}
if (ctx.localMutationDisabled === true && ctx.rejoinDetected === true) {
  ctx.supersededByRejoin = true;
  ctx.localAlreadyApplied = true;
  ctx.chatCleanupSkipped = true;
  ctx.localApplyAt = new Date().toISOString();
  ctx.successMessage = "Новая запись в игре сохранена";
  msg._splitLeaveCtx = ctx;
  msg.payload = undefined;
  return [null, null, msg];
}
msg._splitLeaveCtx = ctx;
msg.payload = undefined;
return [msg, null, null];
