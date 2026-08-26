const asArray = (value) => Array.isArray(value) ? value : [];
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const isReplay = !isObj(msg._resultConfirmOutbox) && isObj(msg._resultConfirmReplayOutbox);
const source = isObj(msg._resultConfirmOutbox)
  ? msg._resultConfirmOutbox
  : (isObj(msg._resultConfirmReplayOutbox) ? msg._resultConfirmReplayOutbox : null);
let bundle = null;
try {
  bundle = source?.version === 2 ? JSON.parse(String(source.payloadJson || "")) : null;
} catch {
  bundle = null;
}
const storedResponse = isObj(source?.response) ? source.response : (isObj(bundle?.response) ? bundle.response : null);
const responseMessage = (statusCode, payload) => Object.assign({}, msg, {
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  payload,
});
if (!source || !isObj(bundle) || !storedResponse || !Array.isArray(source.sinks)) {
  const errorMsg = responseMessage(503, {
    error: "Durable result side-effect outbox is invalid",
    code: "RESULT_SIDE_EFFECT_OUTBOX_INVALID",
    recoveryRequired: true,
  });
  return [null, null, null, errorMsg, errorMsg];
}
if (source.status === "DELIVERED") {
  const deliveredMsg = Object.assign({}, msg, {
    statusCode: Number(storedResponse.statusCode || 200),
    headers: storedResponse.headers || { "Content-Type": "application/json; charset=utf-8" },
    payload: storedResponse.payload,
  });
  return [null, null, null, isReplay ? deliveredMsg : null, null];
}
if (source.status === "RECOVERY_REQUIRED" || source.sinks.some((sink) => sink?.status === "UNKNOWN")) {
  const errorMsg = responseMessage(202, {
    error: "One or more result side effects require reconciliation",
    code: "RESULT_SIDE_EFFECT_RECOVERY_REQUIRED",
    recoveryRequired: true,
    bundleId: source.bundleId || null,
  });
  return [null, null, null, isReplay ? errorMsg : null, errorMsg];
}

const contextFor = (sink) => ({
  tenantKey: source.tenantKey,
  resultId: source.resultId,
  resultRevision: source.resultRevision,
  bundleId: source.bundleId,
  sinkKey: sink.key,
  kind: sink.kind,
  retryPolicy: sink.retryPolicy,
});
const dispatchable = (sink) => sink && ["PENDING", "RETRYABLE", "PROCESSING"].includes(sink.status);
const ratingMessages = [];
const eventMessages = [];
const vivaMessages = [];
const ratings = asArray(bundle.ratingsPayload);
const syncTasks = asArray(bundle.syncBatch?.tasks);

for (const sink of source.sinks) {
  if (!dispatchable(sink)) continue;
  if (sink.kind === "RATING") {
    const item = ratings[sink.payloadIndex];
    if (!item) continue;
    const state = item?.stateOperation?.update?.$set || item?.update?.$set || {};
    const task = syncTasks.find((candidate) => (
      (state.clientId && candidate?.player?.id === state.clientId)
      || (state.phoneNorm && candidate?.player?.phoneNorm === state.phoneNorm)
    )) || syncTasks[sink.payloadIndex] || null;
    ratingMessages.push(Object.assign({}, msg, {
      payload: Object.assign({}, item, task ? {
        projectionTask: Object.assign({}, task, { _legacyResultSideEffect: contextFor(source.sinks.find((candidate) => candidate.providerOutboxId === task.outboxId)) }),
      } : {}),
      _legacyResultSideEffect: contextFor(sink),
      _resultVivaSyncBatch: bundle.syncBatch || null,
    }));
  } else if (sink.kind === "EVENT") {
    eventMessages.push(Object.assign({}, msg, {
      payload: bundle.eventPayload,
      _legacyResultSideEffect: contextFor(sink),
    }));
  } else if (sink.kind === "PROVIDER") {
    const task = syncTasks[sink.payloadIndex];
    if (!task) continue;
    vivaMessages.push(Object.assign({}, msg, {
      payload: task,
      _legacyResultSideEffect: contextFor(sink),
      _resultVivaSyncBatch: Object.assign({}, bundle.syncBatch, { response: storedResponse }),
    }));
  }
}

const pendingMsg = responseMessage(202, {
  status: "SIDE_EFFECTS_PROCESSING",
  recoveryRequired: false,
  bundleId: source.bundleId,
});
return [ratingMessages, eventMessages, vivaMessages, isReplay ? pendingMsg : null, null];
