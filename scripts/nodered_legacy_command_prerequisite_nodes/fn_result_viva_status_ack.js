const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const acknowledged = raw?.acknowledged !== false;
const hasError = Boolean(msg.error || raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.n ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? 0);
const persisted = acknowledged && !hasError
  && (matchedCount > 0 || modifiedCount > 0);
const deferred = msg._resultVivaSyncDeferred || {};
msg._legacyResultSideEffectOutcome = {
  status: persisted && deferred.ok ? "DELIVERED" : "UNKNOWN",
  error: persisted && deferred.ok ? null : (deferred.error || "Provider outcome was not durably acknowledged"),
};
delete msg.error;
return msg;
