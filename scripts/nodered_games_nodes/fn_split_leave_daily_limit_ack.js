const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);

if (!ctx || msg.error || matched < 1) {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Viva подтверждена; освобождаем дневной лимит записи",
  };
  return [null, null, msg];
}

ctx.dailyLimitReleaseOutcome = "RELEASED";
ctx.dailyLimitReleasedAt = new Date().toISOString();
msg._splitLeaveCtx = ctx;
msg.payload = undefined;
delete msg.statusCode;
if (ctx.supersededByRejoin === true || ctx.localAlreadyApplied === true) return [null, msg, null];
return [msg, null, null];
