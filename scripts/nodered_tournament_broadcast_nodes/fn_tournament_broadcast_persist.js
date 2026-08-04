const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const respond = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { ok: false, code, message };
  return [null, msg];
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
const nextState = isObj(context?.nextState) ? context.nextState : null;
if (!context || !nextState) {
  return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось сохранить состояние трансляции");
}

const activeTargets = Array.isArray(nextState.activeTargets)
  ? Array.from(new Set(nextState.activeTargets.filter((target) => (
    target === "right_arena" || target === "left_arena"
  ))))
  : [];
const requestedTarget = ["right_arena", "left_arena", "both"].includes(nextState.requestedTarget)
  ? nextState.requestedTarget
  : null;
const updatedAt = new Date().toISOString();
msg._tournamentBroadcast = {
  ...context,
  nextState: {
    ...nextState,
    activeTargets,
    requestedTarget,
  },
  updatedAt,
};
const filter = isObj(context.persistenceFilter)
  ? context.persistenceFilter
  : { tournamentId: context.tournamentId };
const update = {
  $set: {
    "params.broadcast": {
      active: nextState.active === true,
      status: String(nextState.status || (nextState.active === true ? "active" : "inactive")),
      stationId: context.stationId,
      requestedTarget,
      activeTargets,
      updatedAt,
      updatedBy: context.profileId,
    },
    updatedAt,
  },
};
msg.payload = [filter, update, { upsert: false, maxTimeMS: 5000 }];
delete msg.statusCode;
return [msg, null];
