const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";

const clearRefreshLock = () => {
  const owner = String(global.get(KEY_REFRESH_OWNER) || "");
  if (!msg._vivaTokenRefreshOwner || owner !== msg._vivaTokenRefreshOwner) return;
  global.set(KEY_REFRESH_OWNER, null);
  global.set(KEY_REFRESH_LOCK_UNTIL, 0);
};

if (
  Number(msg.statusCode) < 200
  || Number(msg.statusCode) >= 300
  || !msg.payload?.access_token
) {
  clearRefreshLock();
  msg.statusCode = 503;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "2",
  };
  msg.payload = {
    error: "Сервисная авторизация Viva временно недоступна",
    code: "VIVA_SERVICE_AUTH_UNAVAILABLE",
  };
  return [null, msg, msg];
}

const token = String(msg.payload.access_token);
const expiresIn = Number(msg.payload.expires_in || 300);
const players = Array.isArray(msg._liveRatingsCtx?.players) ? msg._liveRatingsCtx.players : [];

global.set(KEY_TOKEN, token);
global.set(
  KEY_EXPIRES_AT,
  Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
);
clearRefreshLock();

msg.vivaToken = token;
msg.payload = players;
msg._vivaTokenSource = "refresh";
return [msg, null, null];
