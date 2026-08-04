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
const unique = (values) => Array.from(new Set(values.filter(Boolean)));
const targetForKeys = (keys) => {
  const normalized = unique(keys);
  if (normalized.includes("right_arena") && normalized.includes("left_arena")) return "both";
  if (normalized.length === 1 && ["right_arena", "left_arena"].includes(normalized[0])) return normalized[0];
  return null;
};
const labelList = (keys, targets) => keys.map((key) => {
  const target = targets.find((item) => item.key === key);
  return target?.label || key;
}).join(", ");
const buildRequests = (baseMsg, context, targets, phase, commandAction) => {
  const operationId = `${String(baseMsg._msgid || context.tournamentId || "broadcast")}:${phase}:${Date.now()}`;
  return targets.map((target, index) => {
    const requestContext = {
      ...context,
      phase,
      commandAction,
      commandTargets: targets,
      targetKey: target.key,
      targetLabel: target.label || null,
      boxId: target.boxId,
    };
    return {
      ...baseMsg,
      _tournamentBroadcast: requestContext,
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
        + commandAction,
      headers: {
        Authorization: `Bearer ${context.integrationToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      payload: commandAction === "start"
        ? { tournament_id: context.tournamentId }
        : undefined,
    };
  });
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
const results = Array.isArray(msg.payload) ? msg.payload.filter(isObj) : [];
if (!context || !Array.isArray(context.commandTargets) || context.commandTargets.length === 0) {
  return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось обработать ответы приставок");
}

const expectedKeys = context.commandTargets.map((target) => toStr(target?.key)).filter(Boolean);
const resultByKey = new Map(results.map((result) => [toStr(result.target), result]));
const successfulKeys = expectedKeys.filter((key) => resultByKey.get(key)?.ok === true);
const failedKeys = expectedKeys.filter((key) => resultByKey.get(key)?.ok !== true);
const selectedTargets = context.commandTargets.filter((target) => expectedKeys.includes(target.key));

if (context.phase === "compensation") {
  if (failedKeys.length === 0) {
    msg._tournamentBroadcast = {
      ...context,
      nextState: {
        active: false,
        status: "inactive",
        requestedTarget: null,
        activeTargets: [],
        partial: false,
        message: null,
      },
      finalResponse: {
        statusCode: 502,
        code: "TOURNAMENT_BROADCAST_UPSTREAM_FAILED",
        message: "Не удалось запустить трансляцию на всех приставках. Приставки остановлены",
      },
    };
    return [msg, null, null];
  }

  msg._tournamentBroadcast = {
    ...context,
    nextState: {
      active: true,
      status: "partial",
      requestedTarget: context.requestedTarget || targetForKeys(failedKeys),
      activeTargets: failedKeys,
      partial: true,
      message: `Трансляция осталась активна частично: ${labelList(failedKeys, selectedTargets)}. Повторите остановку`,
    },
  };
  return [msg, null, null];
}

if (context.action === "start") {
  if (failedKeys.length === 0) {
    msg._tournamentBroadcast = {
      ...context,
      nextState: {
        active: true,
        status: "active",
        requestedTarget: context.requestedTarget || targetForKeys(successfulKeys),
        activeTargets: successfulKeys,
        partial: false,
        message: null,
      },
    };
    return [msg, null, null];
  }
  if (context.selectionRequired !== true && successfulKeys.length === 0) {
    return respond(
      502,
      "TOURNAMENT_BROADCAST_UPSTREAM_FAILED",
      "Приставки не подтвердили запуск трансляции",
    );
  }
  const compensationTargets = context.commandTargets;
  const compensationContext = {
    ...context,
    phase: "compensation",
    commandAction: "stop",
    commandTargets: compensationTargets,
    initialFailedTargets: failedKeys,
  };
  return [null, buildRequests(msg, compensationContext, compensationTargets, "compensation", "stop"), null];
}

if (failedKeys.length === expectedKeys.length && context.selectionRequired !== true) {
  return respond(
    502,
    "TOURNAMENT_BROADCAST_UPSTREAM_FAILED",
    "Приставки не подтвердили остановку трансляции",
  );
}

msg._tournamentBroadcast = {
  ...context,
  nextState: failedKeys.length > 0
    ? {
      active: true,
      status: "partial",
      requestedTarget: context.requestedTarget || targetForKeys(failedKeys),
      activeTargets: failedKeys,
      partial: true,
      message: `Не удалось остановить трансляцию на: ${labelList(failedKeys, selectedTargets)}. Повторите остановку`,
    }
    : {
      active: false,
      status: "inactive",
      requestedTarget: null,
      activeTargets: [],
      partial: false,
      message: null,
    },
  ...(failedKeys.length === expectedKeys.length
    ? {
      finalResponse: {
        statusCode: 502,
        code: "TOURNAMENT_BROADCAST_UPSTREAM_FAILED",
        message: "Приставки не подтвердили остановку трансляции",
      },
    }
    : {}),
};
return [msg, null, null];
