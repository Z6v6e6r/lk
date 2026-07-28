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
  return [null, null, msg];
};
const readEnv = (key) => {
  try {
    return toStr(env.get(key));
  } catch {
    return null;
  }
};
const readCupStationSettings = () => {
  const raw = readEnv("CUP_STATION_SETTINGS_JSON");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const resolveBoxId = (stationId, tournamentId) => {
  const settings = readCupStationSettings();
  const station = settings[stationId];
  if (typeof station === "string") return toStr(station);
  if (isObj(station)) {
    return toStr(
      station.tournamentBroadcastBoxId
      || station.tournament_broadcast_box_id
      || station.boxId
      || station.box_id,
    );
  }

  const testTournamentId = readEnv("TOURNAMENT_BROADCAST_TEST_TOURNAMENT_ID");
  if (testTournamentId && tournamentId === testTournamentId) {
    return readEnv("TOURNAMENT_BROADCAST_TEST_BOX_ID");
  }
  return null;
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const tournament = rows.find((row) => isObj(row) && toStr(row.tournamentId) === context?.tournamentId) || null;
if (!context || !tournament) return respond(404, "TOURNAMENT_NOT_FOUND", "Турнир не найден");

const organizerId = toStr(tournament.organizer?.id || tournament.params?.organizerId);
if (!context.hasHostingAccess && (!organizerId || organizerId !== context.profileId)) {
  return respond(403, "TOURNAMENT_BROADCAST_FORBIDDEN", "Нет доступа к трансляции этого турнира");
}

const storedStationId = toStr(
  tournament.params?.stationId
  || tournament.params?.broadcast?.stationId
  || tournament.stationId
  || tournament.studioId
  || tournament.studio?.id,
);
if (storedStationId && context.requestedStationId && storedStationId !== context.requestedStationId) {
  return respond(409, "TOURNAMENT_STATION_MISMATCH", "Турнир привязан к другой станции");
}
const stationId = storedStationId || context.requestedStationId;
if (!stationId) return respond(409, "TOURNAMENT_STATION_MISSING", "Для турнира не указана станция");

const savedBroadcast = isObj(tournament.params?.broadcast) ? tournament.params.broadcast : {};
if (context.action === "status") {
  msg.statusCode = 200;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    ok: true,
    tournamentId: context.tournamentId,
    stationId,
    active: savedBroadcast.active === true,
    updatedAt: toStr(savedBroadcast.updatedAt),
  };
  return [null, msg, null];
}

const boxId = resolveBoxId(stationId, context.tournamentId);
const apiBaseUrl = readEnv("TOURNAMENT_BROADCAST_API_BASE_URL");
const integrationToken = readEnv("TOURNAMENT_BROADCAST_BEARER_TOKEN");
if (!boxId) return respond(409, "TOURNAMENT_BROADCAST_DEVICE_MISSING", "Для станции не настроена приставка");
if (!apiBaseUrl || !integrationToken) {
  return respond(503, "TOURNAMENT_BROADCAST_CONFIG_MISSING", "Интеграция трансляции не настроена на сервере");
}

msg._tournamentBroadcast = {
  ...context,
  stationId,
  boxId,
};
msg.method = "POST";
msg.url = apiBaseUrl.replace(/\/+$/, "")
  + "/integrations/v1/devices/"
  + encodeURIComponent(boxId)
  + "/tournament/"
  + context.action;
msg.headers = {
  Authorization: `Bearer ${integrationToken}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};
msg.payload = context.action === "start"
  ? { tournament_id: context.tournamentId }
  : undefined;
delete msg.statusCode;
return [msg, null, null];
