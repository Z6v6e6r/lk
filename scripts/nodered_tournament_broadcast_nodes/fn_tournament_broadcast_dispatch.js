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
  delete msg.error;
  return [null, null, msg];
};
const buildRequests = (baseMsg, context) => {
  const targets = Array.isArray(context.commandTargets) ? context.commandTargets : [];
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
const addCandidate = (candidates, value) => {
  if (Array.isArray(value)) {
    value.forEach((item) => addCandidate(candidates, item));
    return;
  }
  if (!isObj(value) || candidates.includes(value)) return;
  candidates.push(value);
  addCandidate(candidates, value.result);
  addCandidate(candidates, value.payload);
};
const count = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const identityFilter = (context) => {
  const filter = { tournamentId: context.tournamentId };
  if (context.tournamentMongoId !== null && context.tournamentMongoId !== undefined) {
    filter._id = context.tournamentMongoId;
  }
  const stationFilterField = toStr(context.stationFilterField);
  if (["params.stationId", "stationId", "studioId", "studio.id"].includes(stationFilterField)) {
    filter[stationFilterField] = context.stationId;
  }
  return filter;
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
if (!context) {
  return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось подготовить команду трансляции");
}

if (context.claimStage === "pending") {
  const candidates = [];
  addCandidate(candidates, msg.payload);
  addCandidate(candidates, msg.result);
  const acknowledgementValues = candidates
    .filter((value) => Object.prototype.hasOwnProperty.call(value, "acknowledged"))
    .map((value) => value.acknowledged);
  const acknowledged = acknowledgementValues.includes(true)
    && acknowledgementValues.every((value) => value === true);
  const hasRawError = candidates.some((value) => (
    Boolean(value.error)
    || Boolean(value.errmsg)
    || Boolean(value.codeName)
    || (Array.isArray(value.writeErrors) && value.writeErrors.length > 0)
  ));
  const matchedCount = Math.max(0, ...candidates.map((value) => count(
    value.matchedCount ?? value.n,
  )));
  const modifiedCount = Math.max(0, ...candidates.map((value) => count(
    value.modifiedCount ?? value.nModified,
  )));

  if (!acknowledged || hasRawError || msg.error) {
    return respond(
      503,
      "TOURNAMENT_BROADCAST_CLAIM_FAILED",
      "Не удалось зарезервировать запуск трансляции",
    );
  }
  if (modifiedCount === 1) {
    const claimedContext = {
      ...context,
      claimStage: "claimed",
      persistenceFilter: {
        ...identityFilter(context),
        "params.broadcast.active": true,
        "params.broadcast.status": "starting",
        "params.broadcast.operationId": context.operationId,
      },
    };
    msg._tournamentBroadcast = claimedContext;
    delete msg.statusCode;
    delete msg.error;
    return [null, buildRequests(msg, claimedContext), null];
  }
  if (matchedCount < 1) {
    return respond(
      409,
      "BROADCAST_ALREADY_ACTIVE",
      "Трансляция уже запущена или выполняется другая команда",
    );
  }
  return respond(
    503,
    "TOURNAMENT_BROADCAST_CLAIM_FAILED",
    "Сервер не подтвердил резервирование трансляции",
  );
}

if (context.action !== "start" || context.selectionRequired !== true) {
  return [null, msg, null];
}

const commandTargets = Array.isArray(context.commandTargets) ? context.commandTargets : [];
const activeTargets = Array.from(new Set(commandTargets
  .map((target) => toStr(target?.key))
  .filter((target) => target === "right_arena" || target === "left_arena")));
if (activeTargets.length === 0 || activeTargets.length !== commandTargets.length) {
  return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось определить приставки для запуска");
}

const updatedAt = new Date().toISOString();
const operationLeaseUntil = new Date(Date.now() + 60 * 1000).toISOString();
const operationId = [
  String(msg._msgid || context.tournamentId || "broadcast"),
  Date.now().toString(36),
  Math.random().toString(36).slice(2, 10),
].join(":");
const claimedContext = {
  ...context,
  claimStage: "pending",
  operationId,
  operationLeaseUntil,
};
msg._tournamentBroadcast = claimedContext;
msg.payload = [
  {
    ...identityFilter(context),
    "params.broadcast.active": { $ne: true },
    "params.broadcast.status": { $nin: ["starting", "stopping"] },
  },
  {
    $set: {
      "params.broadcast": {
        active: true,
        status: "starting",
        stationId: context.stationId,
        requestedTarget: context.requestedTarget,
        activeTargets,
        operationId,
        operationLeaseUntil,
        updatedAt,
        updatedBy: context.profileId,
      },
      updatedAt,
    },
  },
  { upsert: false, maxTimeMS: 5000 },
];
delete msg.statusCode;
delete msg.error;
return [msg, null, null];
