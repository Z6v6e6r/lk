const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const operation = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
if (!ctx || !operation || String(operation.state || "").toUpperCase() !== "DONE") {
  return [null, msg];
}
msg.payload = { acknowledged: true, matchedCount: 1, readback: true };
return [msg, null];
