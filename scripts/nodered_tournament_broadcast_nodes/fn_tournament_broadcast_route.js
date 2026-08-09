const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, message, extraHeaders = {}) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extraHeaders,
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
const toBroadcastTarget = (value) => {
  const normalized = toStr(value)?.toLowerCase();
  if (normalized === "left_arena" || normalized === "right_arena" || normalized === "both") {
    return normalized;
  }
  return null;
};
const toTargetKeys = (target) => {
  if (target === "both") return ["left_arena", "right_arena"];
  if (target === "left_arena" || target === "right_arena") return [target];
  return [];
};
const normalizeTargetKeys = (value, allowedKeys) => {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(Array.isArray(allowedKeys) ? allowedKeys : []);
  const normalized = value.map(toBroadcastTarget).filter(Boolean);
  return normalized.filter((target) => allowed.size === 0 || allowed.has(target));
};
const readBoxId = (value) => {
  if (typeof value === "string") return toStr(value);
  if (!isObj(value)) return null;
  return toStr(value.boxId || value.box_id || value.deviceId || value.device_id || value.tournamentBroadcastBoxId || value.tournament_broadcast_box_id);
};
const resolveStationTargets = (stationId) => {
  const station = readCupStationSettings()[stationId];
  const rawTargets = isObj(station?.tournamentBroadcastTargets)
    ? station.tournamentBroadcastTargets
    : (isObj(station?.tournament_broadcast_targets) ? station.tournament_broadcast_targets : null);
  if (!isObj(rawTargets)) return [];

  return ["left_arena", "right_arena"].map((targetKey) => {
    const rawTarget = rawTargets[targetKey];
    const target = isObj(rawTarget) ? rawTarget : null;
    return {
      key: targetKey,
      label:
        toStr(target?.label)
        || (targetKey === "left_arena" ? "Левый корт" : "Правый корт"),
      boxId: readBoxId(rawTarget),
    };
  }).filter((entry) => Boolean(entry.boxId));
};
const resolveLegacyBoxId = (stationId, tournamentId) => {
  const settings = readCupStationSettings();
  const station = settings[stationId];
  if (typeof station === "string") return toStr(station);
  if (isObj(station)) {
    const configured = toStr(
      station.tournamentBroadcastBoxId
      || station.tournament_broadcast_box_id
      || station.boxId
      || station.box_id,
    );
    if (configured) return configured;
  }

  const testTournamentId = readEnv("TOURNAMENT_BROADCAST_TEST_TOURNAMENT_ID");
  if (testTournamentId && tournamentId === testTournamentId) {
    return readEnv("TOURNAMENT_BROADCAST_TEST_BOX_ID");
  }
  return null;
};
const buildRequests = (baseMsg, context, targets) => {
  const operationId = `${String(baseMsg._msgid || context.tournamentId || "broadcast")}:command:${Date.now()}`;
  return targets.map((target, index) => ({
    ...baseMsg,
    _tournamentBroadcast: {
      ...context,
      targetKey: target.key,
      targetLabel: target.label || null,
      boxId: target.boxId,
    },
    parts: {
      id: operationId,
      type: "array",
      index,
      count: targets.length,
    },
    method: "POST",
    requestTimeout: 20000,
    url: context.apiBaseUrl.replace(/\/+$/, "")
      + "/integrations/v1/devices/"
      + encodeURIComponent(target.boxId)
      + "/tournament/"
      + context.commandAction,
    headers: {
      Authorization: `Bearer ${context.integrationToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    payload: context.commandAction === "start"
      ? { tournament_id: context.tournamentId }
      : undefined,
  }));
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const tournament = rows.find((row) => isObj(row) && toStr(row.tournamentId) === context?.tournamentId) || null;
if (!context || !tournament) return respond(404, "TOURNAMENT_NOT_FOUND", "Турнир не найден");

const organizerId = toStr(tournament.organizer?.id || tournament.params?.organizerId);
if (!context.hasHostingAccess && (!organizerId || organizerId !== context.profileId)) {
  return respond(403, "TOURNAMENT_BROADCAST_FORBIDDEN", "Нет доступа к трансляции этого турнира");
}

const savedBroadcast = isObj(tournament.params?.broadcast) ? tournament.params.broadcast : {};
const savedBroadcastStationId = toStr(savedBroadcast.stationId);
const tournamentStationId = toStr(
  tournament.params?.stationId
  || tournament.stationId
  || tournament.studioId
  || tournament.studio?.id,
);
const isSyntheticStationId = (value) => /^local-studio:/i.test(toStr(value) || "");
const requestedStationId = toStr(context.requestedStationId);
const currentStationId = isSyntheticStationId(tournamentStationId) ? null : tournamentStationId;
const requestedCurrentStationId = isSyntheticStationId(requestedStationId) ? null : requestedStationId;
const useSavedBroadcastStation = context.action !== "start" && Boolean(savedBroadcastStationId);
const storedStationId = useSavedBroadcastStation
  ? savedBroadcastStationId
  : currentStationId || requestedCurrentStationId || savedBroadcastStationId || tournamentStationId || requestedStationId;
if (
  !useSavedBroadcastStation
  && currentStationId
  && requestedCurrentStationId
  && currentStationId !== requestedCurrentStationId
) {
  return respond(409, "TOURNAMENT_STATION_MISMATCH", "Турнир привязан к другой станции");
}
const stationId = storedStationId;
if (!stationId) return respond(409, "TOURNAMENT_STATION_MISSING", "Для турнира не указана станция");

const stationTargets = resolveStationTargets(stationId);
const isTargetStation = stationTargets.length > 0;
const availableTargetKeys = stationTargets.map((target) => target.key);
let requestedTarget = toBroadcastTarget(context.requestedTarget);
const savedActiveTargets = normalizeTargetKeys(savedBroadcast.activeTargets, availableTargetKeys);
const savedRequestedTarget = toBroadcastTarget(savedBroadcast.requestedTarget);
const status = toStr(savedBroadcast.status);
const knownStatus = ["active", "inactive", "partial", "starting", "stopping"].includes(status)
  ? status
  : (savedBroadcast.active === true ? "active" : "inactive");
const requestedTargetForResponse = (() => {
  if (!isTargetStation) return null;
  if (savedRequestedTarget) return savedRequestedTarget;
  if (availableTargetKeys.length === 2) return "both";
  return availableTargetKeys[0] || null;
})();

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
    status: knownStatus,
    requestedTarget: requestedTargetForResponse,
    targetOptions: isTargetStation
      ? stationTargets.map((item) => ({ key: item.key, label: item.label }))
      : [],
    selectionRequired: isTargetStation && availableTargetKeys.length > 1,
    activeTargets: savedActiveTargets,
    updatedAt: toStr(savedBroadcast.updatedAt),
  };
  return [null, msg, null];
}

const apiBaseUrl = readEnv("TOURNAMENT_BROADCAST_API_BASE_URL");
const integrationToken = readEnv("TOURNAMENT_BROADCAST_BEARER_TOKEN");
if (!apiBaseUrl || !integrationToken) {
  return respond(503, "TOURNAMENT_BROADCAST_CONFIG_MISSING", "Интеграция трансляции не настроена на сервере");
}

let commandTargets;
if (isTargetStation) {
if (context.action === "start") {
  if (isTargetStation && availableTargetKeys.length > 1 && !requestedTarget) {
    requestedTarget = savedRequestedTarget || "both";
  }
}
if (requestedTarget && ["left_arena", "right_arena", "both"].indexOf(requestedTarget) === -1) {
  return respond(400, "BROADCAST_TARGET_NOT_ALLOWED", "Для этой станции выбран неподдерживаемый экран трансляции");
}

  const rawKeys = context.action === "start"
    ? toTargetKeys(requestedTarget)
    : (savedActiveTargets.length > 0 ? savedActiveTargets : availableTargetKeys);
  const commandTargetKeys = rawKeys.length > 0 ? rawKeys : ["both"];
  const normalizedKeys = normalizeTargetKeys(commandTargetKeys, availableTargetKeys);
  commandTargets = stationTargets.filter((target) => normalizedKeys.includes(target.key));
  if (normalizedKeys.length === 0 || commandTargets.length !== normalizedKeys.length) {
    return respond(409, "TOURNAMENT_BROADCAST_DEVICE_MISSING", "Для станции не настроены выбранные приставки");
  }
} else {
  const boxId = resolveLegacyBoxId(stationId, context.tournamentId);
  if (!boxId) return respond(409, "TOURNAMENT_BROADCAST_DEVICE_MISSING", "Для станции не настроена приставка");
  commandTargets = [{ key: "default", label: null, boxId }];
}

const commandContext = {
  ...context,
  stationId,
  requestedTarget,
  selectionRequired: isTargetStation,
  status: knownStatus,
  activeTargets: commandTargets.map((target) => target.key),
  commandAction: context.action,
  apiBaseUrl,
  integrationToken,
  commandTargets,
};
delete msg.statusCode;
return [buildRequests(msg, commandContext, commandTargets), null, null];
