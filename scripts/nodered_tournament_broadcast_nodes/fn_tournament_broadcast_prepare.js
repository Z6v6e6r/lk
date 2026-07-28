const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
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

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return respond(401, "AUTH_TOKEN_REQUIRED", "Необходимо войти в личный кабинет");
}

const body = isObj(msg.payload) ? msg.payload : {};
const action = toStr(msg.req?.params?.action)?.toLowerCase()
  || (String(msg.req?.path || msg.req?.url || "").includes("/status") ? "status" : null);
if (!action || !["start", "stop", "status"].includes(action)) {
  return respond(400, "BROADCAST_ACTION_INVALID", "Неизвестная команда трансляции");
}

const tournamentId = toStr(body.tournamentId || msg.req?.query?.tournamentId);
if (!tournamentId || tournamentId.length > 160 || !/^[a-z0-9][a-z0-9._:-]*$/i.test(tournamentId)) {
  return respond(400, "TOURNAMENT_ID_INVALID", "Некорректный ID турнира");
}

const requestedStationId = toStr(body.stationId || msg.req?.query?.stationId);
if (requestedStationId && (requestedStationId.length > 160 || !/^[a-z0-9][a-z0-9._:-]*$/i.test(requestedStationId))) {
  return respond(400, "STATION_ID_INVALID", "Некорректный ID станции");
}

msg._tournamentBroadcast = {
  action,
  tournamentId,
  requestedStationId,
  authHeader,
};
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;

return [msg, null];
