const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const acknowledged = Boolean(msg.payload?.acknowledged === true || msg.payload?.matchedCount >= 0 || msg.payload?.upsertedCount >= 0);
if (!ctx || msg.error || !acknowledged) {
  msg.statusCode = 503;
  msg.payload = { ok: false, state: "CONFLICT", message: "Не удалось зафиксировать операцию удаления" };
  return [null, msg];
}
msg.payload = { _id: ctx.operationKey };
return [msg, null];
