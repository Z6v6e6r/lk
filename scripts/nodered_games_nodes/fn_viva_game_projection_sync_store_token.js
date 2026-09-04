const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";
const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const clearRefreshLock = () => {
  const owner = toStr(global.get(KEY_REFRESH_OWNER));
  if (!msg._vivaProjectionSyncTokenRefreshOwner || owner !== msg._vivaProjectionSyncTokenRefreshOwner) return;
  global.set(KEY_REFRESH_OWNER, null);
  global.set(KEY_REFRESH_LOCK_UNTIL, 0);
};
const releaseLease = () => {
  const lease = global.get(LEASE_KEY);
  const runId = msg._vivaProjectionSync?.runId;
  if (lease && typeof lease === "object" && lease.runId === runId) global.set(LEASE_KEY, null);
};
const fail = (code) => {
  clearRefreshLock();
  releaseLease();
  const payload = {
    ok: false,
    source: "viva_game_projection_sync",
    code,
    mode: msg._vivaProjectionSync?.mode || null,
    runId: msg._vivaProjectionSync?.runId || null,
    at: new Date().toISOString(),
  };
  global.set("lk_viva_game_projection_sync_last_report", payload);
  msg.payload = payload;
  delete msg.headers;
  delete msg.url;
  delete msg.vivaToken;
  return [null, msg];
};

const statusCode = Number(msg.statusCode);
const token = toStr(msg.payload?.access_token);
if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300 || !token) {
  return fail("SERVICE_AUTH_UNAVAILABLE");
}

const expiresIn = Number(msg.payload?.expires_in || 300);
global.set(KEY_TOKEN, token);
global.set(
  KEY_EXPIRES_AT,
  Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000,
);
clearRefreshLock();
msg.vivaToken = token;
msg.payload = {};
delete msg.headers;
delete msg.url;
return [msg, null];
