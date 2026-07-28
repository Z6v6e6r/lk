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
const upstreamStatus = Number(msg.statusCode) || 0;
if (!context) return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось сохранить состояние трансляции");
const upstreamMessage = isObj(msg.payload)
  ? String(msg.payload.message || msg.payload.error || msg.payload.detail || "").trim()
  : "";
const alreadyStopped = context.action === "stop"
  && upstreamStatus === 409
  && /no active tournament session/i.test(upstreamMessage);
const alreadyStarted = context.action === "start"
  && upstreamStatus === 409
  && /same state/i.test(upstreamMessage);
if ((upstreamStatus < 200 || upstreamStatus >= 300) && !alreadyStopped && !alreadyStarted) {
  return respond(
    upstreamStatus >= 400 && upstreamStatus < 500 ? 502 : 503,
    "TOURNAMENT_BROADCAST_UPSTREAM_FAILED",
    upstreamMessage || "Приставка не подтвердила команду трансляции",
  );
}

const updatedAt = new Date().toISOString();
msg._tournamentBroadcast.updatedAt = updatedAt;
const filter = { tournamentId: context.tournamentId };
const update = {
  $set: {
    "params.broadcast": {
      active: context.action === "start",
      stationId: context.stationId,
      updatedAt,
      updatedBy: context.profileId,
    },
    updatedAt,
  },
};
msg.payload = [filter, update, { upsert: false, maxTimeMS: 5000 }];
delete msg.statusCode;
return [msg, null];
