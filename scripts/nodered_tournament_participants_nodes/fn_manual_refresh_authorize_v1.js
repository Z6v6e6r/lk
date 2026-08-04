const ACCESS_FIELD_ID = "e17a32f3-65f7-47c5-bda1-33d79932c884";
const ACCESS_VALUE = "проводит турниры";
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined || typeof value === "object") return null;
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
  msg.payload = { error: code, code, message };
  return [null, msg];
};

const context = isObj(msg._tournamentParticipantManualRefresh)
  ? msg._tournamentParticipantManualRefresh
  : null;
if (!context?.exerciseId) {
  return respond(500, "REFRESH_CONTEXT_MISSING", "Не удалось подготовить обновление состава");
}

const upstreamStatus = Number(msg.statusCode) || 0;
if (upstreamStatus === 401 || upstreamStatus === 403) {
  return respond(401, "AUTH_TOKEN_INVALID", "Сессия истекла. Войдите снова");
}
if (upstreamStatus < 200 || upstreamStatus >= 300 || !isObj(msg.payload)) {
  return respond(503, "AUTH_SERVICE_UNAVAILABLE", "Не удалось проверить доступ к турнирам");
}

const profile = msg.payload;
const profileId = toStr(profile.id || profile.clientId || profile.uuid);
if (!profileId) {
  return respond(403, "PROFILE_ID_MISSING", "Профиль не поддерживает управление турнирами");
}

const customFields = Array.isArray(profile.customFields) ? profile.customFields : [];
const accessField = customFields.find((field) => (
  isObj(field) && toStr(field.id) === ACCESS_FIELD_ID
));
const selectedValue = Array.isArray(accessField?.value)
  ? toStr(accessField.value[0])
  : null;
const options = Array.isArray(accessField?.attributes?.options)
  ? accessField.attributes.options
  : [];
const hasHostingAccess = selectedValue === ACCESS_VALUE
  || options.some((option) => (
    isObj(option)
    && toStr(option.id) === selectedValue
    && toStr(option.name)?.toLowerCase() === ACCESS_VALUE
  ));
if (!hasHostingAccess) {
  return respond(403, "TOURNAMENT_ACCESS_REQUIRED", "Обновление доступно только организатору турниров");
}

msg._tournamentParticipantManualRefresh = {
  ...context,
  authorized: true,
  profileId,
};
msg.payload = { exerciseId: context.exerciseId };
msg.headers = {};
delete msg.statusCode;
return [msg, null];
