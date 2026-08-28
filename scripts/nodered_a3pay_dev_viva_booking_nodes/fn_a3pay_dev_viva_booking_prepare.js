const VIVA_API_BASE = "https://api.vivacrm.ru";
const TENANT_KEY = "iSkq6G";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const header = (name) => {
  const headers = msg.req && msg.req.headers && typeof msg.req.headers === "object"
    ? msg.req.headers
    : {};
  return toStr(headers[String(name).toLowerCase()] || headers[name]);
};
const allowedOrigin = (origin) => {
  if (origin === "https://padlhub.ru") return origin;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin || "")) return origin;
  return null;
};
const responseHeaders = (origin) => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": origin || "https://padlhub.ru",
  Vary: "Origin",
});
const finish = (statusCode, error, code) => {
  msg.statusCode = statusCode;
  msg.headers = responseHeaders(allowedOrigin(header("origin")));
  msg.payload = { ok: false, error, code };
  return [null, msg];
};
const envValue = (name) => toStr(env.get(name));
const envIds = (name) => new Set(
  String(envValue(name) || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
);

if (
  envValue("A3PAY_DEV_VIVA_BOOKING_ENABLED") !== "true"
  || envValue("A3PAY_DEV_VIVA_BOOKING_TARGET") !== "lk-reserve-89"
  || envValue("A3PAY_DEV_VIVA_BOOKING_TENANT") !== TENANT_KEY
  || envValue("HOSTNAME") !== "89-108-64-209.cloudvps.regruhosting.ru"
) {
  return finish(503, "Тестовый шлюз бронирования Viva выключен", "A3PAY_DEV_VIVA_BOOKING_DISABLED");
}
if (header("x-padlhub-release-channel") !== "dev") {
  return finish(403, "Маркер тестового контура не подтверждён", "A3PAY_DEV_CHANNEL_REQUIRED");
}

const origin = allowedOrigin(header("origin"));
if (!origin) {
  return finish(403, "Источник запроса не разрешён", "A3PAY_DEV_ORIGIN_DENIED");
}

const authHeader = header("authorization");
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return finish(401, "Требуется авторизация Viva", "A3PAY_DEV_AUTH_REQUIRED");
}

const action = toStr(msg.req?.params?.action)?.toLowerCase();
const operationId = toStr(msg.req?.query?.operationId);
if (!['create', 'cancel', 'status'].includes(action)) {
  return finish(404, "Неизвестное действие тестовой брони", "A3PAY_DEV_ACTION_UNSUPPORTED");
}
if (!operationId || !/^[A-Za-z0-9._:-]{8,200}$/.test(operationId)) {
  return finish(400, "Требуется корректный operationId", "A3PAY_DEV_OPERATION_ID_REQUIRED");
}

const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : {};
const selection = body.selection && typeof body.selection === "object" && !Array.isArray(body.selection)
  ? body.selection
  : {};
const normalizedSelection = action === "create" ? {
  date: toStr(selection.date),
  fromTime: toStr(selection.fromTime),
  toTime: toStr(selection.toTime),
  studioId: toStr(selection.studioId),
  roomId: toStr(selection.roomId),
  masterServiceId: toStr(selection.masterServiceId),
  subServiceIds: Array.isArray(selection.subServiceIds)
    ? [...new Set(selection.subServiceIds.map(toStr).filter(Boolean))].sort()
    : [],
} : null;

if (action === "create") {
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(normalizedSelection.date || "");
  const validFrom = /^\d{2}:\d{2}$/.test(normalizedSelection.fromTime || "");
  const validTo = /^\d{2}:\d{2}$/.test(normalizedSelection.toTime || "");
  const idsPresent = normalizedSelection.studioId
    && normalizedSelection.roomId
    && normalizedSelection.masterServiceId
    && normalizedSelection.subServiceIds.length > 0
    && normalizedSelection.subServiceIds.length <= 8;
  if (!validDate || !validFrom || !validTo || !idsPresent) {
    return finish(400, "Параметры слота Viva неполны", "A3PAY_DEV_SELECTION_INVALID");
  }
  const allowedStudioIds = envIds("A3PAY_DEV_VIVA_BOOKING_STUDIO_IDS");
  const allowedMasterServiceIds = envIds("A3PAY_DEV_VIVA_BOOKING_MASTER_SERVICE_IDS");
  if (allowedStudioIds.size === 0 || allowedMasterServiceIds.size === 0) {
    return finish(503, "Allowlist тестовых площадок не настроен", "A3PAY_DEV_TARGET_ALLOWLIST_MISSING");
  }
  if (!allowedStudioIds.has(normalizedSelection.studioId.toLowerCase())
    || !allowedMasterServiceIds.has(normalizedSelection.masterServiceId.toLowerCase())) {
    return finish(403, "Выбранная площадка не разрешена для тестового шлюза", "A3PAY_DEV_TARGET_DENIED");
  }
}

msg._a3payDevViva = {
  action,
  operationId,
  authHeader,
  corsOrigin: origin,
  tenantKey: TENANT_KEY,
  selection: normalizedSelection,
  selectionKey: normalizedSelection ? JSON.stringify(normalizedSelection) : null,
  step: "profile",
  startedAt: new Date().toISOString(),
};
msg.method = "GET";
msg.url = `${VIVA_API_BASE}/end-user/api/v1/${TENANT_KEY}/profile`;
msg.headers = { Authorization: authHeader, Accept: "application/json" };
msg.payload = undefined;
return [msg, null];
