const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error || matched < 1) {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Viva подтверждена; требуется повторить синхронизацию игры",
  };
  return [null, msg];
}
ctx.gameApplyAcknowledged = true;
msg._splitLeaveCtx = ctx;
msg.payload = { id: ctx.gameId, archived: { $ne: true } };
return [msg, null];
