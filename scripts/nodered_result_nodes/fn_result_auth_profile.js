const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { error, code };
  return [null, null, null, null, null, msg];
};

const context = isObj(msg._resultAuth) ? msg._resultAuth : null;
if (!context) return respond(500, "RESULT_AUTH_CONTEXT_MISSING", "Не удалось проверить участника");

const upstreamStatus = Number(msg.statusCode) || 0;
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return respond(401, "RESULT_AUTH_TOKEN_INVALID", "Сессия истекла. Войдите снова");
}
const rawProfile = isObj(msg.payload) && isObj(msg.payload.data) ? msg.payload.data : msg.payload;
if (upstreamStatus < 200 || upstreamStatus >= 300 || !isObj(rawProfile)) {
  return respond(503, "RESULT_AUTH_SERVICE_UNAVAILABLE", "Не удалось проверить профиль участника");
}

const profileId = toStr(
  rawProfile.id
  || rawProfile.clientId
  || rawProfile.uuid
  || rawProfile.userId
  || rawProfile.playerId,
);
const profilePhone = normPhone(
  rawProfile.phoneNorm
  || rawProfile.phone
  || rawProfile.phoneNumber
  || rawProfile.mobile,
);
if (!profileId && !profilePhone) {
  return respond(403, "RESULT_AUTH_IDENTITY_MISSING", "В профиле отсутствует идентификатор участника");
}

const hint = isObj(context.actorHint) ? context.actorHint : {};
if (hint.id && profileId && hint.id !== profileId) {
  return respond(403, "RESULT_AUTH_ID_MISMATCH", "ID участника не совпадает с авторизованным профилем");
}
if (hint.phoneNorm && profilePhone && hint.phoneNorm !== profilePhone) {
  return respond(403, "RESULT_AUTH_PHONE_MISMATCH", "Телефон участника не совпадает с авторизованным профилем");
}

msg._resultActor = {
  id: profileId,
  phoneNorm: profilePhone,
  name: toStr(rawProfile.name || rawProfile.fullName || rawProfile.title || rawProfile.displayName) || hint.name,
  verified: true,
  source: "viva-profile",
};
msg.payload = isObj(context.requestPayload) ? context.requestPayload : {};
delete msg.statusCode;

const outputIndex = {
  state: 0,
  submit: 1,
  confirm: 2,
  "session-open": 3,
  "session-update": 4,
}[context.target];
if (!Number.isInteger(outputIndex)) {
  return respond(500, "RESULT_AUTH_TARGET_INVALID", "Не удалось продолжить обработку результата");
}
const outputs = [null, null, null, null, null, null];
outputs[outputIndex] = msg;
return outputs;
