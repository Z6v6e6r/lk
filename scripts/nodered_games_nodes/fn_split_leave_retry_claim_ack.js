const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error || matched < 1) return [null, msg];
msg.payload = { id: ctx.gameId, archived: { $ne: true } };
return [msg, null];
