const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
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
  };
  msg.payload = { ok: false, code, error };
  return [null, msg];
};

const context = isObj(msg._splitCleanupAuth) ? msg._splitCleanupAuth : null;
if (!context) {
  return respond(
    500,
    "SPLIT_CLEANUP_AUTH_CONTEXT_MISSING",
    "Не удалось проверить профиль клиента",
  );
}

const statusCode = Number(msg.statusCode) || 0;
if (statusCode === 401 || statusCode === 403) {
  return respond(
    401,
    "SPLIT_CLEANUP_AUTH_TOKEN_INVALID",
    "Сессия истекла. Войдите снова",
  );
}

const rawProfile = isObj(msg.payload) && isObj(msg.payload.data)
  ? msg.payload.data
  : msg.payload;
if (statusCode < 200 || statusCode >= 300 || !isObj(rawProfile)) {
  return respond(
    503,
    "SPLIT_CLEANUP_AUTH_SERVICE_UNAVAILABLE",
    "Не удалось проверить профиль клиента",
  );
}

const actorClientId = toStr(
  rawProfile.id
  || rawProfile.clientId
  || rawProfile.uuid
  || rawProfile.userId
  || rawProfile.playerId,
);
const actorPhoneNorm = normalizePhone(
  rawProfile.phoneNorm
  || rawProfile.phone
  || rawProfile.phoneNumber
  || rawProfile.mobile,
);
if (!actorClientId && !actorPhoneNorm) {
  return respond(
    403,
    "SPLIT_CLEANUP_AUTH_IDENTITY_MISSING",
    "В профиле отсутствует идентификатор клиента",
  );
}

msg._splitCleanupAuth = {
  ...context,
  actorClientId,
  actorPhoneNorm,
  verified: true,
};
msg.payload = isObj(context.requestPayload) ? context.requestPayload : {};
delete msg.statusCode;

return [msg, null];
