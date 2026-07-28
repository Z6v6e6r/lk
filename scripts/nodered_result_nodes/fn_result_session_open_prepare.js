const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};
const normalizeActor = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    id: toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId),
    phoneNorm: normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile),
    name: toStr(value.name || value.fullName || value.title),
  };
};

const gameId = toStr(msg.req?.params?.gameId);
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const trustedActor = normalizeActor(msg._resultActor);
const phone = normPhone(
  trustedActor?.phoneNorm
  || body.phone
  || body.senderPhone
  || body.playerPhone
  || body.openedBy?.phone
  || body.actor?.phone
  || msg.req?.query?.phone,
);
const actor = trustedActor || normalizeActor(body.submittedBy || body.actor || body.openedBy) || {
  id: null,
  phoneNorm: phone,
  name: null,
};
if (!actor.id && !phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "actor id or phone is required" };
  return [null, msg, msg];
}

msg._resultSessionOpen = {
  gameId,
  phone: actor.phoneNorm || phone,
  actor,
  requestedSessionId: toStr(body.sessionId),
};
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, msg];
