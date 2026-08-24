const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const readVivaServiceEnv = (key) => {
  try {
    return typeof env !== "undefined" && env && typeof env.get === "function"
      ? toStr(env.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const readVivaServiceGlobal = (key) => {
  try {
    return typeof global !== "undefined" && global && typeof global.get === "function"
      ? toStr(global.get(key))
      : null;
  } catch (_error) {
    return null;
  }
};

const buildVivaServiceTokenRequestBody = () => {
  const configuredBody = readVivaServiceEnv("VIVACRM_TOKEN_REQUEST_BODY")
    || readVivaServiceGlobal("vivacrm_token_request_body");
  if (configuredBody) return configuredBody;
  const username = readVivaServiceEnv("VIVA_SERVICE_USERNAME");
  const password = readVivaServiceEnv("VIVA_SERVICE_PASSWORD");
  if (!username || !password) return null;
  const clientId = readVivaServiceEnv("VIVA_SERVICE_CLIENT_ID") || "React-auth-dev";
  return [
    ["grant_type", "password"],
    ["client_id", clientId],
    ["username", username],
    ["password", password],
  ].map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value)).join("&");
};


const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg, null];
};

const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const inviteId = toStr(query.inviteId || query.referralInviteId);
const ownerPhone = normalizePhone(query.ownerPhone || query.phone || query.owner);
const ownerSubscriptionId = toStr(query.ownerSubscriptionId || query.subscriptionId || query.subId);
const flowType = normalizeFlowType(query.mode || query.flowType || query.type);

if (!inviteId && (!ownerPhone || !ownerSubscriptionId)) {
  return fail(400, "inviteId or ownerPhone and ownerSubscriptionId are required");
}

if (inviteId) {
  msg._referralSubscriptionCtx = {
    action: "status",
    step: "resolve_invite",
    postOwnerStep: "status_query",
    inviteId,
    flowType,
  };

  const dbQuery = { inviteId };
  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: dbQuery,
  });
  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "status_prepare",
      inviteId,
      flowType,
    },
  });

  return [null, null, debugMsg, dbMsg];
}

msg._referralSubscriptionCtx = {
  action: "status",
  step: "token_owner",
  postOwnerStep: "status_query",
  ownerPhone,
  ownerSubscriptionId,
  flowType,
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload = buildVivaServiceTokenRequestBody();
if (!msg.payload) {
  return fail(503, "Сервисная авторизация Viva не настроена", {
    code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
  });
}

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_prepare",
    inviteId,
    ownerPhone,
    ownerSubscriptionId,
    flowType,
  },
});

return [msg, null, debugMsg, null];
