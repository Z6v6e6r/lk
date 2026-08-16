const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const envValue = (key) => {
  try {
    return toStr(env.get(key));
  } catch {
    return null;
  }
};
const enabled = ["1", "true", "yes", "on"].includes(
  String(envValue("PADLHUB_LEGACY_ROSTER_BRIDGE_ENABLED") || "").toLowerCase(),
);
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { code, error };
  return [null, msg];
};

if (!enabled) {
  return respond(503, "LEGACY_GAME_BRIDGE_DISABLED", "Каноническая запись в игру отключена");
}
const baseUrl = envValue("PADLHUB_PLATFORM_INTERNAL_API_BASE_URL")?.replace(/\/+$/, "");
const tenantKey = envValue("PADLHUB_PLATFORM_TENANT_KEY");
const integrationToken = envValue("PADLHUB_LEGACY_ROSTER_TOKEN");
if (
  !baseUrl
  || !/^https?:\/\/[^\s]+$/i.test(baseUrl)
  || !tenantKey
  || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)
  || !integrationToken
  || integrationToken.length < 32
) {
  return respond(503, "LEGACY_GAME_BRIDGE_CONFIG_INVALID", "Каноническая запись временно недоступна");
}

const gameId = toStr(msg.req?.params?.gameId);
if (!gameId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(gameId)) {
  return respond(400, "LEGACY_GAME_ID_INVALID", "Некорректный идентификатор игры");
}
const authorization = toStr(msg.req?.headers?.authorization);
if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
  return respond(401, "LEGACY_AUTH_REQUIRED", "Требуется авторизация");
}
const idempotencyKey = toStr(msg.req?.headers?.["idempotency-key"]);
if (
  !idempotencyKey
  || idempotencyKey.length < 16
  || idempotencyKey.length > 128
  || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
) {
  return respond(400, "IDEMPOTENCY_KEY_INVALID", "Некорректный Idempotency-Key");
}
const body = isObj(msg.payload) ? msg.payload : null;
const allowedKeys = new Set(["command", "invitationId"]);
if (!body || Object.keys(body).some((key) => !allowedKeys.has(key))) {
  return respond(400, "LEGACY_GAME_COMMAND_INVALID", "Некорректная команда записи");
}
const command = toStr(body.command)?.toUpperCase();
if (!command || !["JOIN_GAME", "JOIN_WAITLIST"].includes(command)) {
  return respond(400, "LEGACY_GAME_COMMAND_INVALID", "Некорректная команда записи");
}
const invitationId = toStr(body.invitationId);
if (invitationId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(invitationId)) {
  return respond(400, "LEGACY_INVITATION_ID_INVALID", "Некорректное персональное приглашение");
}

msg._legacyRosterBridge = { gameId, idempotencyKey, command, retryCount: 0 };
msg.method = "POST";
msg.url = `${baseUrl}/${encodeURIComponent(tenantKey)}/legacy-games/${encodeURIComponent(gameId)}/roster-commands`;
msg.headers = {
  Authorization: authorization,
  "Content-Type": "application/json",
  "Idempotency-Key": idempotencyKey,
  "X-Phub-Legacy-Roster-Token": integrationToken,
  "X-Correlation-ID": toStr(msg.req?.headers?.["x-correlation-id"]) || idempotencyKey,
};
msg.payload = { command, ...(invitationId ? { invitationId } : {}) };
return [msg, null];
