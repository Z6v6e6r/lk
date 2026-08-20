const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const operation = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
const expectedState = ctx?.subscriptionReturnState === "RETURN_PENDING" ? "RETURN_PENDING" : "DONE";
if (!ctx || !operation || String(operation.state || "").toUpperCase() !== expectedState) {
  return [null, msg];
}
msg.payload = { acknowledged: true, matchedCount: 1, readback: true };
return [msg, null];
