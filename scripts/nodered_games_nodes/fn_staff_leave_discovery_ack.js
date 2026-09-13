const ctx = msg._splitLeaveCtx;
if (!ctx || msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1) {
  msg.statusCode = 503;
  msg.payload = { ok: false, state: "RETRY_REQUIRED", operationId: ctx?.operationId || null,
    message: "Не удалось зафиксировать актуальную запись Viva. Повторите проверку." };
  return [null, msg];
}
// Independent readback through the existing operation find/route nodes.
msg.payload = { _id: ctx.operationKey };
return [msg, null];
