const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
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

const actor = isObj(msg._chatActor) ? msg._chatActor : null;
const senderPhone = actor?.verified === true ? normPhone(actor.phoneNorm) : null;
if (!actor || actor.verified !== true || !senderPhone) {
  msg.statusCode = 401;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Verified chat actor is required", code: "CHAT_AUTH_REQUIRED" };
  return [null, msg, msg];
}

const body = isObj(msg.payload) ? msg.payload : {};
const text = toStr(body.text);
const messageType = toStr(body.type) || "TEXT";

if (!text) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "text is required" };
  return [null, msg, msg];
}

msg._chat = {
  gameId,
  senderPhone,
  text,
  type: messageType,
  senderName: toStr(actor.name),
  senderId: toStr(actor.clientId),
};

msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, msg];
