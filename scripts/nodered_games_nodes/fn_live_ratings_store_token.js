const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";

if (msg.statusCode !== 200 || !msg.payload?.access_token) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "Viva token error",
    details: msg.payload || null,
  };
  return [null, msg, msg];
}

const token = msg.payload.access_token;
const expiresIn = Number(msg.payload.expires_in || 300);
const players = Array.isArray(msg._liveRatingsCtx?.players) ? msg._liveRatingsCtx.players : [];

global.set(KEY_TOKEN, token);
global.set(KEY_EXPIRES_AT, Date.now() + expiresIn * 1000);

msg.vivaToken = token;
msg.payload = players;
return [msg, null, msg];
