const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};

const gameId = toStr(msg.req?.params?.gameId);
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}

const actor = msg._chatActor && typeof msg._chatActor === "object" ? msg._chatActor : null;
const phone = actor?.verified === true ? normPhone(actor.phoneNorm) : null;
const clientId = actor?.verified === true ? toStr(actor.clientId)?.toLowerCase() || null : null;
if (!actor || actor.verified !== true || !phone) {
  msg.statusCode = 401;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Verified chat actor is required", code: "CHAT_AUTH_REQUIRED" };
  return [null, msg, msg];
}

const q = msg.req?.query || {};
const limitRaw = Number(q.limit);
const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;
const beforeRaw = Number(q.beforeTs || q.before);
const beforeTs = Number.isFinite(beforeRaw) ? beforeRaw : Date.now();

msg._chatGet = { gameId, phone, clientId, limit, beforeTs };
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, msg];
