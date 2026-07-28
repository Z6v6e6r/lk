const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { ok: false, code, message };
  return [null, msg];
};

const context = isObj(msg._tournamentBroadcast) ? msg._tournamentBroadcast : null;
if (!context) return respond(500, "BROADCAST_CONTEXT_MISSING", "Не удалось подготовить команду трансляции");

const upstreamStatus = Number(msg.statusCode) || 0;
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return respond(401, "AUTH_TOKEN_INVALID", "Сессия истекла. Войдите снова");
}
if (upstreamStatus < 200 || upstreamStatus >= 300 || !isObj(msg.payload)) {
  return respond(503, "AUTH_SERVICE_UNAVAILABLE", "Не удалось проверить доступ к турниру");
}

const profile = msg.payload;
const profileId = toStr(profile.id || profile.clientId || profile.uuid);
if (!profileId) return respond(403, "PROFILE_ID_MISSING", "Профиль не поддерживает управление турниром");

const accessFieldId = "e17a32f3-65f7-47c5-bda1-33d79932c884";
const customFields = Array.isArray(profile.customFields) ? profile.customFields : [];
const accessField = customFields.find((field) => isObj(field) && toStr(field.id) === accessFieldId);
const selectedValue = Array.isArray(accessField?.value) ? toStr(accessField.value[0]) : null;
const options = Array.isArray(accessField?.attributes?.options) ? accessField.attributes.options : [];
const hasHostingAccess = selectedValue === "проводит турниры"
  || options.some((option) => (
    isObj(option)
    && toStr(option.id) === selectedValue
    && toStr(option.name)?.toLowerCase() === "проводит турниры"
  ));

msg._tournamentBroadcast = {
  ...context,
  profileId,
  hasHostingAccess,
};
msg.payload = { tournamentId: context.tournamentId };
delete msg.statusCode;
return [msg, null];
