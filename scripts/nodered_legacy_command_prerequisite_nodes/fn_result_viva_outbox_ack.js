const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const acknowledged = raw?.acknowledged !== false;
const hasError = Boolean(msg.error || raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.n ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? (raw?.upsertedId ? 1 : 0));
const persisted = acknowledged && !hasError
  && (matchedCount > 0 || modifiedCount > 0 || upsertedCount > 0);
if (persisted) {
  const task = msg._resultVivaSyncOriginalTask;
  msg._resultVivaOutboxIdentityRead = {
    outboxId: task?.outboxId,
    tenantKey: task?.tenantKey,
    resultId: task?.resultId,
    resultRevision: task?.resultRevision,
  };
  return [msg, null];
}
msg._legacyResultSideEffectOutcome = {
  status: "UNKNOWN",
  error: "Provider outbox was not durably acknowledged before the provider boundary",
};
delete msg.error;
return [null, msg];
