const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const persisted = msg._legacyCleanupRecoveryResult?.persisted === true
  && !msg._legacyCommandOperationError;
const deferred = isObj(msg._splitCleanupRecoveryDeferred) ? msg._splitCleanupRecoveryDeferred : {};
const original = isObj(deferred.summaryMsg?.payload) ? deferred.summaryMsg.payload : {};
const responseMsg = Object.assign({}, deferred.summaryMsg || msg, {
  statusCode: persisted ? 202 : 503,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  payload: {
    ...original,
    ok: false,
    state: persisted ? "RETRY_REQUIRED" : "MANUAL_REVIEW_REQUIRED",
    code: persisted ? "LEGACY_GAME_CLEANUP_RECONCILIATION_PENDING" : "LEGACY_GAME_CLEANUP_RECONCILIATION_NOT_DURABLE",
    gameId: deferred.gameId || original.gameId || null,
    cancelledInLk: false,
    recoveryIntentId: persisted ? (deferred.intentId || null) : null,
    manualReviewRequired: true,
  },
});
delete responseMsg.error;
return responseMsg;
