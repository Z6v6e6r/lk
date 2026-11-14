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
  try {
    if (typeof node !== "undefined" && node && typeof node.warn === "function") {
      const status = msg.statusCode;
      const httpStatus = typeof status === "number" ? status
        : typeof status === "string" && /^[1-5][0-9]{2}$/.test(status) ? Number(status) : NaN;
      const transportClass = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
        ? "none" : ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNABORTED"].includes(status) ? "timeout"
          : ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(status) ? "connect"
            : ["CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(status) ? "tls"
              : ["HPE_INVALID_CONSTANT", "HPE_INVALID_HEADER_TOKEN", "ERR_JSON_PARSE"].includes(status) ? "parse" : "unknown";
      node.warn(JSON.stringify({
        code: "LK_LIVE_RATINGS_503",
        route_key: "games_ratings_live",
        stage: "token_http",
        reason_code: "VIVA_SERVICE_AUTH_UNAVAILABLE",
        downstream_status: 503,
        token_http_status: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
          ? httpStatus : "unknown",
        transport_class: transportClass,
      }));
    }
  } catch (_diagnosticError) {
    // No payload/header/error fallback, even when the logger is unavailable.
  }
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
