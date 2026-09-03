const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const CLIENT_ID_DEFAULT = "React-auth-dev";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";
const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;
const TOKEN_REFRESH_LOCK_MS = 10 * 1000;
const RUN_LEASE_MS = 6 * 60 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 5 * 1000;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const readEnv = (key) => {
  try { return toStr(env.get(key)); } catch (_error) { return null; }
};
const releaseLease = (runId) => {
  const lease = global.get(LEASE_KEY);
  if (lease && typeof lease === "object" && lease.runId === runId) global.set(LEASE_KEY, null);
};
const diagnostic = (code, details = {}, persist = true) => {
  const safe = {
    ok: false,
    source: "viva_game_projection_sync",
    code,
    at: new Date().toISOString(),
    ...details,
  };
  if (persist) global.set("lk_viva_game_projection_sync_last_report", safe);
  msg.payload = safe;
  delete msg.headers;
  delete msg.url;
  delete msg.vivaToken;
  return [null, null, msg];
};

const mode = String(readEnv("VIVA_GAME_PROJECTION_SYNC_MODE") || "OFF").toUpperCase();
if (!["OFF", "SHADOW", "ENFORCE"].includes(mode)) {
  return diagnostic("CONFIG_MODE_INVALID");
}
if (mode === "OFF") {
  return diagnostic("FEATURE_OFF", { ok: true, mode });
}

const now = Date.now();
const lease = global.get(LEASE_KEY);
const leaseUntil = Number(lease && typeof lease === "object" ? lease.until : lease || 0);
if (Number.isFinite(leaseUntil) && leaseUntil > now) {
  return diagnostic("LEASE_ACTIVE", {
    ok: true,
    mode,
    leaseUntil: new Date(leaseUntil).toISOString(),
  }, false);
}
const runId = `viva-projection:${now}:${Math.random().toString(36).slice(2, 10)}`;
msg._vivaProjectionSync = {
  source: "scheduler",
  runId,
  mode,
  startedAt: new Date(now).toISOString(),
};
global.set(LEASE_KEY, { runId, until: now + RUN_LEASE_MS });

const cachedToken = toStr(global.get(KEY_TOKEN));
const cachedExpiresAt = Number(global.get(KEY_EXPIRES_AT) || 0);
if (cachedToken && Number.isFinite(cachedExpiresAt) && cachedExpiresAt > now + TOKEN_CACHE_GRACE_MS) {
  msg.vivaToken = cachedToken;
  msg.payload = {};
  return [msg, null, null];
}

const refreshLockUntil = Number(global.get(KEY_REFRESH_LOCK_UNTIL) || 0);
if (Number.isFinite(refreshLockUntil) && refreshLockUntil > now) {
  releaseLease(runId);
  return diagnostic("TOKEN_REFRESH_IN_PROGRESS", { mode });
}

const username = readEnv("VIVA_SERVICE_USERNAME");
const password = readEnv("VIVA_SERVICE_PASSWORD");
if (!username || !password) {
  releaseLease(runId);
  return diagnostic("SERVICE_AUTH_NOT_CONFIGURED", { mode });
}

const refreshOwner = `viva-projection:${now}:${Math.random().toString(36).slice(2, 10)}`;
global.set(KEY_REFRESH_OWNER, refreshOwner);
global.set(KEY_REFRESH_LOCK_UNTIL, now + TOKEN_REFRESH_LOCK_MS);
msg._vivaProjectionSyncTokenRefreshOwner = refreshOwner;
msg.method = "POST";
msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.requestTimeout = TOKEN_REQUEST_TIMEOUT_MS;
msg.followRedirects = false;
msg.maxRedirects = 0;
msg.payload = [
  ["grant_type", "password"],
  ["client_id", readEnv("VIVA_SERVICE_CLIENT_ID") || CLIENT_ID_DEFAULT],
  ["username", username],
  ["password", password],
]
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
  .join("&");
return [null, msg, null];
