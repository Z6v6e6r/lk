const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error || matched < 1) {
  msg.statusCode = 202;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = {
    ok: true,
    state: "IN_PROGRESS",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Операцию уже забрал другой исполнитель",
  };
  delete msg._splitLeaveCtx;
  return [null, msg];
}
ctx.operationState = "STARTED";
ctx.preCancelVerification = true;
ctx.step = "start_verify_active";
msg._splitLeaveCtx = ctx;
msg.payload = undefined;
return [msg, null];
