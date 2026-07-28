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
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}

const trustedActor = (msg._resultActor && typeof msg._resultActor === "object")
  ? msg._resultActor
  : null;
const actor = trustedActor ? {
  id: toStr(trustedActor.id || trustedActor.clientId || trustedActor.uuid),
  phoneNorm: normPhone(trustedActor.phoneNorm || trustedActor.phone),
  name: toStr(trustedActor.name || trustedActor.fullName || trustedActor.title),
  verified: trustedActor.verified === true,
} : {
  id: toStr(msg.req?.query?.clientId || msg.req?.query?.playerId),
  phoneNorm: normPhone(msg.req?.query?.phone || msg.req?.query?.phoneNumber || msg.req?.query?.mobile),
  name: null,
  verified: false,
};
msg._resultState = { gameId, phone: actor.phoneNorm, actor };
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, msg];
