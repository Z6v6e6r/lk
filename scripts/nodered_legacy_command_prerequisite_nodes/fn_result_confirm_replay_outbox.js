const asArray = (value) => Array.isArray(value) ? value : [];
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const outbox = isObj(msg._resultConfirmReplayOutbox) ? msg._resultConfirmReplayOutbox : null;
let bundle = null;
try {
  bundle = outbox?.version === 1 && outbox?.status === "PENDING_REPLAYABLE"
    ? JSON.parse(String(outbox.payloadJson || ""))
    : null;
} catch {
  bundle = null;
}
if (!isObj(bundle) || !isObj(bundle.response)) {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 503,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: { error: "Durable result side-effect outbox is invalid", code: "RESULT_SIDE_EFFECT_OUTBOX_INVALID", recoveryRequired: true },
  });
  return [null, errorMsg, errorMsg, null, null];
}

const syncBatch = isObj(bundle.syncBatch) ? bundle.syncBatch : null;
const syncTasks = asArray(syncBatch?.tasks);
const ratingMutations = asArray(bundle.ratingsPayload).map((item, index) => {
  const state = item?.stateOperation?.update?.$set || item?.update?.$set || {};
  const task = syncTasks.find((candidate) => (
    (state.clientId && candidate?.player?.id === state.clientId)
    || (state.phoneNorm && candidate?.player?.phoneNorm === state.phoneNorm)
  )) || syncTasks[index] || null;
  return Object.assign({}, item, { projectionTask: task });
});
const ratingsMsg = Object.assign({}, msg, {
  payload: ratingMutations,
  ...(syncBatch ? { _resultVivaSyncBatch: Object.assign({}, syncBatch, { response: bundle.response }) } : {}),
});
const responseMsg = Object.assign({}, msg, {
  statusCode: Number(bundle.response.statusCode || 200),
  headers: bundle.response.headers || { "Content-Type": "application/json; charset=utf-8" },
  payload: bundle.response.payload,
});
const eventMsg = bundle.eventPayload ? Object.assign({}, msg, { payload: bundle.eventPayload }) : null;
const syncBatchMsg = syncBatch && ratingMutations.length === 0 ? Object.assign({}, msg, {
  _resultVivaSyncBatch: Object.assign({}, syncBatch, { response: bundle.response }),
  payload: syncTasks,
}) : null;
return [ratingsMsg, responseMsg, responseMsg, eventMsg, syncBatchMsg];
