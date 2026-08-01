const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeId = (value) => {
  const normalized = toStr(value);
  return normalized ? normalized.toLowerCase() : null;
};

const normalizePhone = (value) => {
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
    Vary: "Authorization",
  };
  msg.payload = { ok: false, code, error };
  delete msg._chatActor;
  if (isObj(msg._chatAuth)) {
    delete msg._chatAuth.authHeader;
    delete msg._chatAuth.requestPayload;
  }
  return [null, null, null, null, msg, msg];
};

const context = isObj(msg._chatAuth) ? msg._chatAuth : null;
if (!context || !toStr(context.routeKind)) {
  return respond(500, "CHAT_AUTH_CONTEXT_MISSING", "Не удалось проверить сессию чата");
}

const statusCode = Number(msg.statusCode) || 0;
if (statusCode === 401 || statusCode === 403) {
  return respond(401, "CHAT_AUTH_TOKEN_INVALID", "Сессия истекла. Войдите снова");
}

const rawProfile = isObj(msg.payload) && isObj(msg.payload.data)
  ? msg.payload.data
  : msg.payload;
if (statusCode < 200 || statusCode >= 300 || !isObj(rawProfile)) {
  return respond(503, "CHAT_AUTH_SERVICE_UNAVAILABLE", "Не удалось проверить сессию чата");
}

const actorClientId = toStr(
  rawProfile.id
  || rawProfile.clientId
  || rawProfile.uuid
  || rawProfile.userId,
);
const actorPhoneNorm = normalizePhone(
  rawProfile.phoneNorm
  || rawProfile.phone
  || rawProfile.phoneNumber
  || rawProfile.mobile,
);
if (!actorPhoneNorm) {
  return respond(403, "CHAT_ACTOR_IDENTITY_MISSING", "В профиле не найден подтверждённый телефон");
}

const requestPayload = isObj(context.requestPayload) ? context.requestPayload : {};
const query = isObj(msg.req?.query) ? msg.req.query : {};
const routeKind = toStr(context.routeKind);
const suppliedPhone = routeKind === "send"
  ? normalizePhone(requestPayload.senderPhone || requestPayload.phone || requestPayload.clientPhone || query.phone)
  : routeKind === "read"
    ? normalizePhone(requestPayload.phone || requestPayload.phoneNumber || requestPayload.userPhone || query.phone)
    : normalizePhone(query.phone || query.phoneNumber || query.userPhone || query.mobile);
const suppliedClientId = normalizeId(
  requestPayload.senderId
  || requestPayload.clientId
  || requestPayload.userId
  || query.clientId
  || query.userId,
);
const verifiedClientId = normalizeId(actorClientId);

if (suppliedPhone && suppliedPhone !== actorPhoneNorm) {
  return respond(403, "CHAT_ACTOR_IDENTITY_MISMATCH", "Нельзя действовать от имени другого пользователя");
}
if (suppliedClientId && (!verifiedClientId || suppliedClientId !== verifiedClientId)) {
  return respond(403, "CHAT_ACTOR_IDENTITY_MISMATCH", "Нельзя действовать от имени другого пользователя");
}

const firstName = toStr(rawProfile.firstName);
const lastName = toStr(rawProfile.lastName);
const actorName = toStr(rawProfile.displayName || rawProfile.fullName || rawProfile.name)
  || [firstName, lastName].filter(Boolean).join(" ").trim()
  || null;

msg._chatActor = {
  verified: true,
  phoneNorm: actorPhoneNorm,
  clientId: actorClientId || null,
  name: actorName,
};
msg._chatAuth = {
  routeKind,
  verified: true,
};
msg.payload = requestPayload;
delete msg.statusCode;

if (routeKind === "send") return [msg, null, null, null, null, msg];
if (routeKind === "get") return [null, msg, null, null, null, msg];
if (routeKind === "read") return [null, null, msg, null, null, msg];
if (routeKind === "list") return [null, null, null, msg, null, msg];
return respond(500, "CHAT_ROUTE_UNSUPPORTED", "Маршрут чата не поддерживается");
