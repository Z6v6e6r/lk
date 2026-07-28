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

const body = (msg.payload && typeof msg.payload === 'object') ? msg.payload : {};
const trustedActor = (msg._resultActor && typeof msg._resultActor === 'object')
  ? msg._resultActor
  : null;
const actorHint = (body.actor && typeof body.actor === 'object')
  ? body.actor
  : (body.submittedBy && typeof body.submittedBy === 'object' ? body.submittedBy : {});
const actor = {
  id: toStr(
    trustedActor?.id
    || actorHint.id
    || actorHint.clientId
    || actorHint.uuid
    || actorHint.userId
    || actorHint.playerId,
  ),
  phoneNorm: normPhone(
    trustedActor?.phoneNorm
    || trustedActor?.phone
    || actorHint.phoneNorm
    || actorHint.phone
    || body.phone
    || body.confirmerPhone
    || body.disputerPhone
    || body.playerPhone
    || msg.req?.query?.phone,
  ),
  name: toStr(trustedActor?.name || actorHint.name || actorHint.fullName || actorHint.title),
  verified: trustedActor?.verified === true,
};
const phone = actor.phoneNorm;
if (!actor.id && !phone) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "actor id or phone is required" };
  return [null, msg, msg];
}

const url = String(msg.req?.route?.path || msg.req?.url || msg.req?.originalUrl || '').toLowerCase();
const bodyActionRaw = toStr(body.action || body.lifecycleAction);
const bodyAction = String(bodyActionRaw || '').toUpperCase().replace(/-/g, '_');

let action = 'CONFIRM';
if (url.includes('/dispute') || url.includes('/revert') || bodyAction === 'DISPUTE' || bodyAction === 'REVERT') {
  action = 'DISPUTE';
} else if (url.includes('/accept-correction') || bodyAction === 'ACCEPT_CORRECTION') {
  action = 'ACCEPT_CORRECTION';
} else if (url.includes('/expire') || bodyAction === 'EXPIRE') {
  action = 'EXPIRE';
}

msg._resultConfirm = {
  gameId,
  phone,
  actor,
  action,
  correctionPayload: body.correction || body.correctionPayload || null,
  reason: toStr(body.reason || body.disputeReason),
};
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null, msg];
