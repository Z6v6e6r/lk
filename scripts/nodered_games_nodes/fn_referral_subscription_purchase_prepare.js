const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const DEFAULT_RESERVATION_MINUTES = 30;

const PLAN_CONFIGS = {
  academy: {
    planKey: "academy",
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
    productCostMinor: 2380000,
  },
  friendship: {
    planKey: "friendship",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
    productCostMinor: 980000,
  },
  ra: {
    planKey: "ra",
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
    productCostMinor: 2380000,
  },
  sport: {
    planKey: "sport",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
    productCostMinor: 1980000,
  },
};

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


const toInt = (value, fallback) => {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "academy" || normalized === "friendship" || normalized === "ra" || normalized === "sport") {
    return normalized;
  }
  return null;
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const resolveReservationMinutes = () => {
  const raw = toInt(global.get("referral_subscription_reservation_minutes"), DEFAULT_RESERVATION_MINUTES);
  return Math.max(5, Math.min(360, raw));
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg, null];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const inviteId = toStr(body.inviteId || body.referralInviteId);
const ownerPhone = normalizePhone(body.ownerPhone || body.phone || body.owner);
const ownerSubscriptionId = toStr(body.ownerSubscriptionId || body.subscriptionId || body.ownerSubId);
const clientPhone = normalizePhone(body.clientPhone || body.buyerPhone || body.phoneBuyer);
const clientId = toStr(body.clientId);
const planKey = normalizePlanKey(body.planKey || body.planType || body.type);
const flowType = normalizeFlowType(body.mode || body.flowType);
const paymentRef = toStr(body.paymentRef) || `referral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const planConfig = planKey ? PLAN_CONFIGS[planKey] : null;

if ((!inviteId && (!ownerPhone || !ownerSubscriptionId)) || !clientPhone || !planConfig) {
  return fail(400, "inviteId or ownerPhone/ownerSubscriptionId, clientPhone and planKey are required");
}

if (inviteId) {
  msg._referralSubscriptionCtx = {
    action: "purchase",
    step: "resolve_invite",
    postOwnerStep: "purchase_limit",
    inviteId,
    flowType,
    clientPhone,
    clientId,
    planKey: planConfig.planKey,
    productId: planConfig.productId,
    productName: planConfig.productName,
    productCostMinor: planConfig.productCostMinor,
    paymentRef,
    reservationMinutes: resolveReservationMinutes(),
    successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
    failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
  };

  const dbQuery = { inviteId };
  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: dbQuery,
  });
  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "purchase_prepare",
      inviteId,
      flowType,
      clientPhone,
      planKey: planConfig.planKey,
      paymentRef,
    },
  });

  return [null, null, debugMsg, dbMsg];
}

msg._referralSubscriptionCtx = {
  action: "purchase",
  step: "token_owner",
  postOwnerStep: "purchase_limit",
  ownerPhone,
  ownerSubscriptionId,
  flowType,
  clientPhone,
  clientId,
  planKey: planConfig.planKey,
  productId: planConfig.productId,
  productName: planConfig.productName,
  productCostMinor: planConfig.productCostMinor,
  paymentRef,
  reservationMinutes: resolveReservationMinutes(),
  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),
  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),
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
    action: "purchase_prepare",
    inviteId,
    ownerPhone,
    ownerSubscriptionId,
    flowType,
    clientPhone,
    planKey: planConfig.planKey,
    paymentRef,
  },
});

return [msg, null, debugMsg, null];
