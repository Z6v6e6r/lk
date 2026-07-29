const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

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
  msg.payload = { ok: false, code, error };
  return [null, msg];
};

const reqHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(reqHeaders.authorization || reqHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return respond(
    401,
    "SPLIT_CLEANUP_AUTH_TOKEN_REQUIRED",
    "Необходимо войти в личный кабинет",
  );
}

msg._splitCleanupAuth = {
  authHeader,
  requestPayload: isObj(msg.payload) ? msg.payload : {},
};
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.headers = {
  Authorization: authHeader,
  Accept: "application/json",
};
msg.payload = undefined;

return [msg, null];
