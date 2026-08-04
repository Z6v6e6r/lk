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
const SKOLKOVO_STATION_ID = "0d5504f6-ea6f-44bb-a9e4-947faf0273ab";
const SKOLKOVO_TARGETS = {
  right_arena: { key: "right_arena", label: "Правый манеж" },
  left_arena: { key: "left_arena", label: "Левый манеж" },
};
const readBoxId = (value) => {
  if (typeof value === "string") return toStr(value);
  if (!isObj(value)) return null;
  return toStr(value.boxId || value.box_id || value.deviceId || value.device_id);
};
const resolveLegacyBoxId = (stationId, tournamentId) => {
  const station = readCupStationSettings()[stationId];
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
const resolveSkolkovoTargets = () => {
  const station = readCupStationSettings()[SKOLKOVO_STATION_ID];
  const targetMap = isObj(station?.tournamentBroadcastTargets)
    ? station.tournamentBroadcastTargets
    : (isObj(station?.tournament_broadcast_targets) ? station.tournament_broadcast_targets : {});
  return Object.values(SKOLKOVO_TARGETS).map((target) => ({
    ...target,
    boxId: readBoxId(targetMap[target.key]),
  }));
};
const normalizeActiveTargets = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(toStr).filter((target) => (
    target === "right_arena" || target === "left_arena"
  ))));
};
const targetForKeys = (keys) => {
  const normalized = normalizeActiveTargets(keys);
  if (normalized.includes("right_arena") && normalized.includes("left_arena")) return "both";
  return normalized.length === 1 ? normalized[0] : null;
};
const keysForTarget = (target) => {
  if (target === "both") return ["right_arena", "left_arena"];
  if (target === "right_arena" || target === "left_arena") return [target];
  return [];
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

const isSkolkovo = stationId === SKOLKOVO_STATION_ID;
const savedActiveTargets = normalizeActiveTargets(savedBroadcast.activeTargets);
const savedRequestedTarget = toStr(savedBroadcast.requestedTarget);
const rawSavedStatus = toStr(savedBroadcast.status);
const savedStatus = ["active", "inactive", "partial", "starting", "stopping"].includes(rawSavedStatus)
  ? rawSavedStatus
  : (savedBroadcast.active === true ? "active" : "inactive");
const savedOperationId = toStr(savedBroadcast.operationId);
const savedOperationLeaseUntil = toStr(savedBroadcast.operationLeaseUntil);
const savedOperationLeaseTs = Date.parse(savedOperationLeaseUntil || "");
const isTransitionState = savedStatus === "starting" || savedStatus === "stopping";
const operationInProgress = isTransitionState
  && Number.isFinite(savedOperationLeaseTs)
  && savedOperationLeaseTs > Date.now();
const recoveryRequired = isTransitionState && !operationInProgress && savedBroadcast.active === true;
const safeRequestedTarget = ["right_arena", "left_arena", "both"].includes(savedRequestedTarget)
  ? savedRequestedTarget
  : targetForKeys(savedActiveTargets);

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
    status: savedStatus,
    requestedTarget: isSkolkovo ? safeRequestedTarget : null,
    activeTargets: isSkolkovo ? savedActiveTargets : [],
    selectionRequired: isSkolkovo,
    partial: savedStatus === "partial",
    operationInProgress: isSkolkovo && operationInProgress,
    operationLeaseUntil: isSkolkovo && isTransitionState ? savedOperationLeaseUntil : null,
    recoveryRequired: isSkolkovo && recoveryRequired,
    updatedAt: toStr(savedBroadcast.updatedAt),
  };
  return [null, msg, null];
}

if (context.action === "start" && isSkolkovo && savedBroadcast.active === true) {
  if (operationInProgress) {
    return respond(
      409,
      "BROADCAST_OPERATION_IN_PROGRESS",
      "Предыдущая команда трансляции ещё выполняется",
      { "Retry-After": "5" },
    );
  }
  return respond(
    409,
    "BROADCAST_ALREADY_ACTIVE",
    "Сначала остановите текущую трансляцию, затем выберите манеж для нового запуска",
  );
}
if (context.action === "stop" && isSkolkovo && operationInProgress) {
  return respond(
    409,
    "BROADCAST_OPERATION_IN_PROGRESS",
    "Запуск трансляции ещё выполняется. Повторите остановку через несколько секунд",
    { "Retry-After": "5" },
  );
}
if (context.requestedTarget && !isSkolkovo) {
  return respond(400, "BROADCAST_TARGET_NOT_ALLOWED", "Для этой станции выбор приставки недоступен");
}
if (context.action === "start" && isSkolkovo && currentStationId !== SKOLKOVO_STATION_ID) {
  return respond(409, "TOURNAMENT_STATION_MISSING", "Турнир должен быть привязан к станции Сколково");
}
if (context.action === "start" && isSkolkovo && !context.requestedTarget) {
  return respond(400, "BROADCAST_TARGET_REQUIRED", "Выберите манеж для запуска трансляции");
}

let commandTargets;
let requestedTarget = null;
if (isSkolkovo) {
  const configuredTargets = resolveSkolkovoTargets();
  const targetKeys = context.action === "start"
    ? keysForTarget(context.requestedTarget)
    : (savedActiveTargets.length > 0 ? savedActiveTargets : keysForTarget(safeRequestedTarget));
  const effectiveTargetKeys = targetKeys.length > 0
    ? targetKeys
    : ["right_arena", "left_arena"];
  commandTargets = configuredTargets.filter((target) => effectiveTargetKeys.includes(target.key));
  requestedTarget = context.action === "start"
    ? context.requestedTarget
    : (safeRequestedTarget || targetForKeys(effectiveTargetKeys));

  if (commandTargets.length !== effectiveTargetKeys.length || commandTargets.some((target) => !target.boxId)) {
    return respond(409, "TOURNAMENT_BROADCAST_DEVICE_MISSING", "Для Сколково настроены не все выбранные приставки");
  }
  if (new Set(commandTargets.map((target) => target.boxId)).size !== commandTargets.length) {
    return respond(409, "TOURNAMENT_BROADCAST_CONFIG_INVALID", "Для манежей должны быть настроены разные приставки");
  }
} else {
  const boxId = resolveLegacyBoxId(stationId, context.tournamentId);
  if (!boxId) return respond(409, "TOURNAMENT_BROADCAST_DEVICE_MISSING", "Для станции не настроена приставка");
  commandTargets = [{ key: "default", label: null, boxId }];
}

const apiBaseUrl = readEnv("TOURNAMENT_BROADCAST_API_BASE_URL");
const integrationToken = readEnv("TOURNAMENT_BROADCAST_BEARER_TOKEN");
if (!apiBaseUrl || !integrationToken) {
  return respond(503, "TOURNAMENT_BROADCAST_CONFIG_MISSING", "Интеграция трансляции не настроена на сервере");
}

const commandContext = {
  ...context,
  stationId,
  requestedTarget,
  selectionRequired: isSkolkovo,
  savedActiveTargets,
  phase: "command",
  commandAction: context.action,
  commandTargets,
  apiBaseUrl,
  integrationToken,
  tournamentMongoId: tournament._id ?? null,
  stationFilterField: toStr(tournament.params?.stationId) === stationId
    ? "params.stationId"
    : toStr(tournament.stationId) === stationId
      ? "stationId"
      : toStr(tournament.studioId) === stationId
        ? "studioId"
        : toStr(tournament.studio?.id) === stationId
          ? "studio.id"
          : null,
};
if (isSkolkovo && context.action === "stop") {
  const persistenceFilter = { tournamentId: context.tournamentId };
  if (tournament._id !== null && tournament._id !== undefined) persistenceFilter._id = tournament._id;
  if (commandContext.stationFilterField) persistenceFilter[commandContext.stationFilterField] = stationId;
  persistenceFilter["params.broadcast.active"] = true;
  if (isTransitionState && savedOperationId) {
    persistenceFilter["params.broadcast.status"] = savedStatus;
    persistenceFilter["params.broadcast.operationId"] = savedOperationId;
  } else {
    if (toStr(savedBroadcast.status)) persistenceFilter["params.broadcast.status"] = savedStatus;
    const savedUpdatedAt = toStr(savedBroadcast.updatedAt);
    if (savedUpdatedAt) persistenceFilter["params.broadcast.updatedAt"] = savedUpdatedAt;
  }
  commandContext.persistenceFilter = persistenceFilter;
}
delete msg.statusCode;
if (isSkolkovo && context.action === "start") {
  msg._tournamentBroadcast = commandContext;
  msg.payload = undefined;
  return [msg, null, null];
}
return [buildRequests(msg, commandContext, commandTargets), null, null];
