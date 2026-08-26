const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = { error, code };
  return [null, msg, msg];
};

const body = isObj(msg.payload) ? msg.payload : {};
let tenantKey = null;
try {
  tenantKey = toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY"));
} catch {
  tenantKey = null;
}
if (!tenantKey || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)) {
  return respond(503, "LEGACY_GAME_TENANT_CONFIG_INVALID", "Tenant игры не настроен");
}
const requestedTenantKey = hasOwn(body, "tenantKey") ? toStr(body.tenantKey) : null;
if (requestedTenantKey && requestedTenantKey !== tenantKey) {
  return respond(409, "LEGACY_GAME_TENANT_CONFLICT", "Tenant игры не совпадает");
}
if (!hasOwn(body, "expectedRevision")) {
  return respond(
    428,
    "GAME_PATCH_PRECONDITION_REQUIRED",
    "Для изменения игры требуется актуальная revision",
  );
}
const expectedRevisionText = String(body.expectedRevision ?? "").trim();
const expectedRevision = /^\d+$/.test(expectedRevisionText) ? Number(expectedRevisionText) : undefined;
if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
  return respond(400, "GAME_PATCH_PRECONDITION_INVALID", "expectedRevision имеет неверный формат");
}

msg._gamePatchCas = {
  required: true,
  gameId: toStr(msg.req?.params?.gameId),
  tenantKey,
  expectedRevision,
};
return [msg, null, null];
