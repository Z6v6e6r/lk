const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error) return [null, null, msg];
if (matched >= 1) {
  msg.payload = { acknowledged: true, matchedCount: 1 };
  return [msg, null, null];
}
msg.payload = { _id: ctx.operationKey };
return [null, msg, null];
