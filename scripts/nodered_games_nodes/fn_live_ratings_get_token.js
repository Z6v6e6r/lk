const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const CLIENT_ID_DEFAULT = "React-auth-dev";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const TOKEN_REFRESH_LOCK_MS = 10 * 1000;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const readEnv = (key) => {
  try {
    return typeof env !== "undefined" && env && typeof env.get === "function"
      ? toStr(env.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const failClosed = (code, message, retryAfterSeconds = null) => {
  msg.statusCode = 503;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}),
  };
  msg.payload = { error: message, code };
  return [null, null, msg];
};

const players = Array.isArray(msg._liveRatingsCtx?.players) ? msg._liveRatingsCtx.players : [];
const now = Date.now();
const cachedToken = toStr(global.get(KEY_TOKEN));
const cachedExpiresAt = Number(global.get(KEY_EXPIRES_AT) || 0);

if (
  cachedToken
  && Number.isFinite(cachedExpiresAt)
  && cachedExpiresAt > now + TOKEN_CACHE_GRACE_MS
) {
  msg.vivaToken = cachedToken;
  msg.payload = players;
  msg._vivaTokenSource = "cache";
  return [msg, null, null];
}

const refreshLockUntil = Number(global.get(KEY_REFRESH_LOCK_UNTIL) || 0);
if (Number.isFinite(refreshLockUntil) && refreshLockUntil > now) {
  return failClosed(
    "VIVA_SERVICE_TOKEN_REFRESH_IN_PROGRESS",
    "Авторизация Viva временно обновляется",
    1,
  );
}

const username = readEnv("VIVA_SERVICE_USERNAME");
const password = readEnv("VIVA_SERVICE_PASSWORD");
const clientId = readEnv("VIVA_SERVICE_CLIENT_ID") || CLIENT_ID_DEFAULT;
const tokenUrl = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;
if (!username || !password) {
  return failClosed(
    "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
    "Сервисная авторизация Viva не настроена",
  );
}

const refreshOwner = `live-ratings:${now}:${Math.random().toString(36).slice(2, 10)}`;
global.set(KEY_REFRESH_OWNER, refreshOwner);
global.set(KEY_REFRESH_LOCK_UNTIL, now + TOKEN_REFRESH_LOCK_MS);

msg._vivaTokenRefreshOwner = refreshOwner;
msg.method = "POST";
msg.url = tokenUrl;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload = [
  ["grant_type", "password"],
  ["client_id", clientId],
  ["username", username],
  ["password", password],
]
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  .join("&");
return [null, msg, null];
