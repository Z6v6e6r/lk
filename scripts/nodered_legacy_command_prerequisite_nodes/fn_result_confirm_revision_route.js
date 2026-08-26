const asArray = (value) => Array.isArray(value) ? value : [];
const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? raw?.payload?.matchedCount ?? 0);
const modifiedCount = Number(raw?.modifiedCount ?? raw?.result?.modifiedCount ?? raw?.payload?.modifiedCount ?? 0);
const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? raw?.payload?.upsertedCount ?? 0);
const acknowledged = raw?.acknowledged !== false;
const casOk = acknowledged && (matchedCount > 0 || modifiedCount > 0 || upsertedCount > 0);
const bundle = msg._resultConfirmBundle && typeof msg._resultConfirmBundle === "object"
  ? msg._resultConfirmBundle
  : null;
const makeMsg = (payload, extra = {}) => Object.assign({}, msg, extra, { payload });

if (!casOk) {
  const responseMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: "Result state changed concurrently. Refresh state and retry.",
      code: "RESULT_CAS_CONFLICT",
      resultId: bundle?.syncBatch?.resultId || null,
      gameId: bundle?.syncBatch?.gameId || null,
    },
  });
  return [null, null, responseMsg, responseMsg, null, null];
}
if (!bundle?.gamePayload) {
  const responseMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "Legacy game projection plan is missing", code: "LEGACY_GAME_PROJECTION_REQUIRED", retryable: true },
  });
  return [null, null, responseMsg, responseMsg, null, null];
}

const syncBatch = bundle.syncBatch && typeof bundle.syncBatch === "object"
  ? Object.assign({}, bundle.syncBatch, { response: bundle.response || null })
  : null;
const syncTasks = asArray(syncBatch?.tasks);
const ratingMutations = asArray(bundle.ratingsPayload).map((item, index) => {
  const state = item?.stateOperation?.update?.$set || item?.update?.$set || {};
  const task = syncTasks.find((candidate) => (
    (state.clientId && candidate?.player?.id === state.clientId)
    || (state.phoneNorm && candidate?.player?.phoneNorm === state.phoneNorm)
  )) || syncTasks[index] || null;
  return Object.assign({}, item, { projectionTask: task });
});
const ratingsMsg = makeMsg(ratingMutations, syncBatch ? { _resultVivaSyncBatch: syncBatch } : {});
const responseMsg = bundle.response ? Object.assign({}, msg, {
  statusCode: Number(bundle.response.statusCode || 200),
  headers: bundle.response.headers || { "Content-Type": "application/json; charset=utf-8" },
  payload: bundle.response.payload,
}) : null;
const eventMsg = bundle.eventPayload ? makeMsg(bundle.eventPayload) : null;
const syncBatchMsg = syncBatch && ratingMutations.length === 0 ? Object.assign({}, msg, {
  _resultVivaSyncBatch: syncBatch,
  payload: syncTasks,
}) : null;
const gameMsg = makeMsg(bundle.gamePayload, {
  _resultConfirmRevisionDeferred: {
    outbox: msg._resultConfirmOutbox,
    responseMsg,
    hasSyncBatch: Boolean(syncBatch),
  },
});
return [null, gameMsg, null, null, null, null];
