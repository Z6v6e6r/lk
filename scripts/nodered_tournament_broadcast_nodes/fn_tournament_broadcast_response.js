const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const candidates = [];
const addCandidate = (value) => {
  if (Array.isArray(value)) {
    value.forEach(addCandidate);
    return;
  }
  if (!isObj(value) || candidates.includes(value)) return;
  candidates.push(value);
  addCandidate(value.result);
  addCandidate(value.payload);
};
addCandidate(msg.payload);
addCandidate(msg.result);

const acknowledgementValues = candidates
  .filter((value) => Object.prototype.hasOwnProperty.call(value, "acknowledged"))
  .map((value) => value.acknowledged);
const acknowledged = acknowledgementValues.includes(true)
  && acknowledgementValues.every((value) => value === true);
const count = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const hasPersistenceEvidence = candidates.some((value) => (
  count(value.matchedCount) > 0
  || count(value.modifiedCount) > 0
  || count(value.n) > 0
  || count(value.nModified) > 0
));
const hasRawError = candidates.some((value) => (
  Boolean(value.error)
  || Boolean(value.errmsg)
  || Boolean(value.codeName)
  || (Array.isArray(value.writeErrors) && value.writeErrors.length > 0)
));
const persisted = acknowledged && hasPersistenceEvidence && !hasRawError && !msg.error;

msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

if (!persisted) {
  msg.statusCode = 503;
  msg.payload = {
    ok: false,
    code: "TOURNAMENT_BROADCAST_PERSISTENCE_FAILED",
    message: "Не удалось сохранить состояние трансляции",
  };
  delete msg.error;
  return msg;
}

const context = msg._tournamentBroadcast || {};
const nextState = context.nextState || {};
const finalResponse = context.finalResponse && typeof context.finalResponse === "object"
  ? context.finalResponse
  : null;
if (finalResponse) {
  msg.statusCode = Number(finalResponse.statusCode) || 502;
  msg.payload = {
    ok: false,
    code: String(finalResponse.code || "TOURNAMENT_BROADCAST_UPSTREAM_FAILED"),
    message: String(finalResponse.message || "Приставки не подтвердили команду трансляции"),
  };
  return msg;
}
msg.statusCode = 200;
msg.payload = {
  ok: true,
  tournamentId: context.tournamentId || null,
  stationId: context.stationId || null,
  active: nextState.active === true,
  status: nextState.status || (nextState.active === true ? "active" : "inactive"),
  requestedTarget: nextState.requestedTarget || null,
  activeTargets: Array.isArray(nextState.activeTargets) ? nextState.activeTargets : [],
  selectionRequired: context.selectionRequired === true,
  partial: nextState.partial === true,
  operationInProgress: false,
  operationLeaseUntil: null,
  recoveryRequired: false,
  message: nextState.message || null,
  updatedAt: context.updatedAt || null,
};
return msg;
