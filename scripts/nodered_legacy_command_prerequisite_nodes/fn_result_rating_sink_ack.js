const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const acknowledged = raw?.acknowledged !== false;
const hasError = Boolean(msg.error || raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const matched = Number(raw?.matchedCount ?? raw?.modifiedCount ?? raw?.upsertedCount ?? raw?.result?.n ?? 0);
msg._legacyResultSideEffectOutcome = {
  status: acknowledged && !hasError && matched > 0 ? "DELIVERED" : "RETRYABLE",
  error: hasError ? "Rating projection write failed" : (matched > 0 ? null : "Rating projection fence did not match"),
};
delete msg.error;
return msg;
