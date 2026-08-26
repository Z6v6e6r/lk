const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const raw = Array.isArray(msg.payload) ? (msg.payload.find(isObj) || {}) : (isObj(msg.payload) ? msg.payload : {});
const matchedCount = Number(raw.matchedCount ?? raw.result?.matchedCount ?? raw.n ?? 0);
const acknowledged = raw.acknowledged === true;
const hasError = Boolean(msg.error || raw.error || raw.errmsg || raw.codeName || raw.writeErrors);
const deferred = isObj(msg._splitCleanupRevisionDeferred) ? msg._splitCleanupRevisionDeferred : null;

if (acknowledged && !hasError && matchedCount === 1 && deferred?.summaryMsg) {
  if (msg._splitCleanupWriteAck && typeof msg._splitCleanupWriteAck === "object") {
    return [null, null, msg];
  }
  return [null, deferred.summaryMsg, null];
}

const tenantKey = String(deferred?.tenantKey || "").trim();
const gameId = String(deferred?.gameId || "").trim();
const sourceRevision = deferred?.sourceRevision;
const operationKey = String(deferred?.operationKey || "").trim();
if (!tenantKey || !gameId || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1 || !operationKey) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: {
      ok: false,
      state: "MANUAL_REVIEW_REQUIRED",
      code: "LEGACY_GAME_CLEANUP_RECOVERY_CONTEXT_INVALID",
      gameId: gameId || null,
      cancelledInLk: false,
    },
  });
  return [null, errorMsg, null];
}

const intentId = `cleanup-revision:${tenantKey}:${gameId}:${sourceRevision}:${operationKey}`;
const nowIso = new Date().toISOString();
const recoveryMsg = Object.assign({}, msg, {
  _splitCleanupRecoveryDeferred: { summaryMsg: deferred.summaryMsg, intentId, gameId },
  _legacyCleanupRecovery: {
    intentId,
    tenantKey,
    legacyGameId: gameId,
    sourceRevision,
    operationKey,
    reason: hasError ? "MONGO_WRITE_ERROR" : "REVISION_CONFLICT",
    requestedAt: nowIso,
  },
});
delete recoveryMsg.error;
return [recoveryMsg, null, null];
