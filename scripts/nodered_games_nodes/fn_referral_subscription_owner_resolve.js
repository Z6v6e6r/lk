const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const SUBSCRIPTION_NAME_LOOKUP_BASE_URLS = [
  "https://padlhub.su/seliger",
  "https://lk-reserve.89-108-64-209.sslip.io/seliger",
];
const DAY_MS = 24 * 60 * 60 * 1000;

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


const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const normalizeOwnerPlanKey = (value) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
  if (!raw) return null;
  if (raw.includes("друж")) return "friendship";
  if (raw.includes("спорт")) return "sport";
  if (raw.includes("академ")) return "academy";
  if (raw.includes("лето.падел.ра") || raw.endsWith("ра") || raw.includes(" ра")) return "ra";
  return null;
};

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toTs = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const parseList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return value.content;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
};

const normalizeDateOnly = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
};

const buildWindow = (expirationDateValue) => {
  const expirationDate = normalizeDateOnly(expirationDateValue);
  if (!expirationDate) return null;

  const expirationDayStartsAt = `${expirationDate}T00:00:00+03:00`;
  const expirationDayStartTs = Date.parse(expirationDayStartsAt);
  if (!Number.isFinite(expirationDayStartTs)) return null;

  return {
    expirationDate,
    referralEndsAt: new Date(expirationDayStartTs + DAY_MS).toISOString(),
    referralEndTs: expirationDayStartTs + DAY_MS,
    renewalWindowStartsAt: new Date(expirationDayStartTs - DAY_MS).toISOString(),
    renewalWindowEndsAt: new Date(expirationDayStartTs + 4 * DAY_MS).toISOString(),
    renewalWindowStartTs: expirationDayStartTs - DAY_MS,
    renewalWindowEndTs: expirationDayStartTs + 4 * DAY_MS,
  };
};

const resolveSubscriptionStatus = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    toStr(payload.status)
    || toStr(payload.subscriptionStatus)
    || toStr(payload.state)
    || toStr(payload.subscription?.status)
  );
};

const isSubscriptionActive = (statusValue) => String(statusValue || "").trim().toUpperCase() === "ACTIVE";

const pickObjectId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

const dedupeList = (values) => values.filter((value, index, list) => value && list.indexOf(value) === index);

const resolveSubscriptionName = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    toStr(payload.name)
    || toStr(payload.title)
    || toStr(payload.productName)
    || toStr(payload.subscriptionName)
    || toStr(payload.subscription?.name)
  );
};

const resolveExpirationDate = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    toStr(payload.expirationDate)
    || toStr(payload.expireAt)
    || toStr(payload.endDate)
    || toStr(payload.finishDate)
    || toStr(payload.validTill)
  );
};

const resolveLookupSubscriptionName = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    toStr(payload.sertName)
    || toStr(payload.subscriptionName)
    || toStr(payload.name)
    || toStr(payload.title)
    || toStr(payload.productName)
  );
};

const buildSubscriptionNameLookupUrls = () => dedupeList(
  SUBSCRIPTION_NAME_LOOKUP_BASE_URLS
    .map((baseUrl) => toStr(baseUrl))
    .filter(Boolean),
);

const resolveExactClientByPhone = (items, ownerPhone) => {
  const exact = items.find((item) => normalizePhone(item?.phone || item?.mobile || item?.phoneNumber) === ownerPhone);
  return exact || items[0] || null;
};

const buildOwnerCycleKey = (ownerSubscriptionId, expirationDate) => {
  const normalizedSubscriptionId = toStr(ownerSubscriptionId);
  const normalizedExpirationDate = normalizeDateOnly(expirationDate);
  if (!normalizedSubscriptionId || !normalizedExpirationDate) return null;
  return `${normalizedSubscriptionId}:${normalizedExpirationDate}`;
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, response, response];
};

const requestSubscriptionNameLookup = (ctx, lookupUrl) => {
  msg._referralSubscriptionCtx = ctx;
  msg.method = "GET";
  msg.url = `${lookupUrl}?type=get_sub_name&phone=${encodeURIComponent(ctx.ownerPhone)}&subId=${encodeURIComponent(ctx.ownerSubscriptionId)}`;
  msg.headers = {};
  msg.payload = null;
  return [msg, null, null, null];
};

const finalizeOwnerSubscription = (ctx, subscriptionPayload, ownerSubscriptionNameOverride) => {
  const ownerSubscriptionName = toStr(ownerSubscriptionNameOverride) || resolveSubscriptionName(subscriptionPayload);
  const ownerPlanKey = normalizeOwnerPlanKey(ownerSubscriptionName);
  if (!ownerSubscriptionName || !ownerPlanKey) {
    return fail(403, "Реферальная программа недоступна для этой подписки", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
    });
  }

  const window = buildWindow(resolveExpirationDate(subscriptionPayload));
  if (!window) {
    return fail(502, "Не удалось определить окно действия ссылки", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
    });
  }

  const ownerCycleKey = buildOwnerCycleKey(ctx.ownerSubscriptionId, window.expirationDate);
  if (!ownerCycleKey) {
    return fail(502, "Не удалось определить цикл подписки", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
      expirationDate: window.expirationDate,
    });
  }

  const ownerSubscriptionStatus = resolveSubscriptionStatus(subscriptionPayload);
  const nowTs = Date.now();
  const renewalWindowActive = nowTs >= window.renewalWindowStartTs && nowTs < window.renewalWindowEndTs;
  const flowActiveUntil = nowTs < window.renewalWindowEndTs;

  if (!flowActiveUntil) {
    return fail(410, "Действие реферальной страницы завершилось", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
      renewalWindowEndsAt: window.renewalWindowEndsAt,
      flowType: ctx.flowType,
    });
  }

  if (ctx.flowType === "renewal" && !renewalWindowActive) {
    return fail(410, "Продление пока недоступно", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
      renewalWindowStartsAt: window.renewalWindowStartsAt,
      renewalWindowEndsAt: window.renewalWindowEndsAt,
    });
  }

  if (!isSubscriptionActive(ownerSubscriptionStatus) && !renewalWindowActive) {
    return fail(403, "Ссылка доступна только для активной подписки или в окне продления", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
      ownerSubscriptionStatus,
    });
  }

  ctx.ownerPlanKey = ownerPlanKey;
  ctx.ownerSubscriptionName = ownerSubscriptionName;
  ctx.ownerSubscriptionStatus = ownerSubscriptionStatus;
  ctx.ownerCycleKey = ownerCycleKey;
  ctx.expirationDate = window.expirationDate;
  ctx.referralEndsAt = window.referralEndsAt;
  ctx.windowStartsAt = window.renewalWindowStartsAt;
  ctx.windowEndsAt = window.renewalWindowEndsAt;
  ctx.windowActive = renewalWindowActive;
  ctx.countdownVisible = ctx.flowType === "renewal" && renewalWindowActive;
  delete ctx.ownerSubscriptionPayload;
  delete ctx.subscriptionNameLookupUrls;
  delete ctx.subscriptionNameLookupIndex;
  msg._referralSubscriptionCtx = ctx;

  const dbQuery = {
    ownerPhone: ctx.ownerPhone,
    ownerSubscriptionId: ctx.ownerSubscriptionId,
  };
  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: dbQuery,
  });
  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "owner_resolved",
      ownerPhone: ctx.ownerPhone,
      ownerClientId: ctx.ownerClientId,
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
      ownerPlanKey,
      ownerCycleKey,
      flowType: ctx.flowType,
      renewalWindowStartsAt: window.renewalWindowStartsAt,
      renewalWindowEndsAt: window.renewalWindowEndsAt,
      renewalWindowActive,
      nextStep: ctx.postOwnerStep || null,
    },
  });

  return [null, dbMsg, null, debugMsg];
};

const adminRequest = (ctx, method, path, payload) => {
  msg._referralSubscriptionCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null];
};

const ctx = msg._referralSubscriptionCtx && typeof msg._referralSubscriptionCtx === "object"
  ? msg._referralSubscriptionCtx
  : null;

if (!ctx) {
  return fail(500, "Referral subscription owner context is missing");
}

ctx.flowType = normalizeFlowType(ctx.flowType || ctx.mode);

if (ctx.step === "resolve_invite") {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const inviteRecord = rows
    .filter((item) => item && typeof item === "object")
    .sort((left, right) => (toTs(right.updatedAt) || toTs(right.createdAt) || 0) - (toTs(left.updatedAt) || toTs(left.createdAt) || 0))[0] || null;

  if (!inviteRecord) {
    return fail(404, "Реферальная ссылка не найдена", {
      inviteId: toStr(ctx.inviteId),
    });
  }

  ctx.inviteId = toStr(inviteRecord.inviteId) || toStr(ctx.inviteId);
  ctx.ownerPhone = normalizePhone(inviteRecord.ownerPhone) || normalizePhone(ctx.ownerPhone);
  ctx.ownerSubscriptionId = toStr(inviteRecord.ownerSubscriptionId) || toStr(ctx.ownerSubscriptionId);
  ctx.flowType = normalizeFlowType(inviteRecord.flowType || inviteRecord.mode || ctx.flowType);
  if (!ctx.ownerPhone || !ctx.ownerSubscriptionId) {
    return fail(502, "Реферальная ссылка повреждена", {
      inviteId: toStr(ctx.inviteId),
      ownerPhone: ctx.ownerPhone || null,
      ownerSubscriptionId: ctx.ownerSubscriptionId || null,
    });
  }

  ctx.step = "token_owner";
  msg._referralSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = TOKEN_URL;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload = buildVivaServiceTokenRequestBody();
if (!msg.payload) {
  return fail(503, "Сервисная авторизация Viva не настроена", {
    code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
  });
}
  return [msg, null, null, null];
}

if (ctx.step === "token_owner") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      payload: msg.payload || null,
      error: msg.error || null,
    });
  }

  ctx.token = msg.payload.access_token;
  ctx.step = "find_owner_client";
  return adminRequest(
    ctx,
    "GET",
    `/clients?phone=${encodeURIComponent(ctx.ownerPhone)}&size=20`,
  );
}

if (ctx.step === "find_owner_client") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Не удалось найти владельца подписки", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      payload: msg.payload || null,
      error: msg.error || null,
    });
  }

  const ownerClient = resolveExactClientByPhone(parseList(msg.payload), ctx.ownerPhone);
  const ownerClientId = pickObjectId(ownerClient);
  if (!ownerClientId) {
    return fail(404, "Владелец подписки не найден", {
      ownerPhone: ctx.ownerPhone,
    });
  }

  ctx.ownerClientId = ownerClientId;
  ctx.step = "load_owner_subscription";
  return adminRequest(
    ctx,
    "GET",
    `/clients/${encodeURIComponent(ownerClientId)}/subscriptions/${encodeURIComponent(ctx.ownerSubscriptionId)}`,
  );
}

if (ctx.step === "load_owner_subscription") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Не удалось загрузить подписку владельца", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      payload: msg.payload || null,
      error: msg.error || null,
      ownerSubscriptionId: ctx.ownerSubscriptionId,
    });
  }

  const ownerSubscriptionName = resolveSubscriptionName(msg.payload);
  const ownerPlanKey = normalizeOwnerPlanKey(ownerSubscriptionName);
  if (ownerSubscriptionName && ownerPlanKey) {
    return finalizeOwnerSubscription(ctx, msg.payload, ownerSubscriptionName);
  }

  const lookupUrls = buildSubscriptionNameLookupUrls();
  if (lookupUrls.length === 0) {
    return fail(403, "Реферальная программа недоступна для этой подписки", {
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      ownerSubscriptionName,
    });
  }

  ctx.ownerSubscriptionPayload = msg.payload;
  ctx.subscriptionNameLookupUrls = lookupUrls;
  ctx.subscriptionNameLookupIndex = 0;
  ctx.step = "lookup_owner_subscription_name";
  return requestSubscriptionNameLookup(ctx, lookupUrls[0]);
}

if (ctx.step === "lookup_owner_subscription_name") {
  const lookupUrls = Array.isArray(ctx.subscriptionNameLookupUrls)
    ? ctx.subscriptionNameLookupUrls.map((item) => toStr(item)).filter(Boolean)
    : [];
  const lookupName = isOk(msg.statusCode) ? resolveLookupSubscriptionName(msg.payload) : null;
  const ownerSubscriptionPayload = ctx.ownerSubscriptionPayload && typeof ctx.ownerSubscriptionPayload === "object"
    ? ctx.ownerSubscriptionPayload
    : null;

  if (lookupName && ownerSubscriptionPayload) {
    return finalizeOwnerSubscription(ctx, ownerSubscriptionPayload, lookupName);
  }

  const nextIndex = Number(ctx.subscriptionNameLookupIndex || 0) + 1;
  if (nextIndex < lookupUrls.length) {
    ctx.subscriptionNameLookupIndex = nextIndex;
    return requestSubscriptionNameLookup(ctx, lookupUrls[nextIndex]);
  }

  return fail(403, "Реферальная программа недоступна для этой подписки", {
    ownerSubscriptionId: ctx.ownerSubscriptionId,
    ownerSubscriptionName: lookupName,
  });
}

return fail(500, "Unsupported referral owner resolve step", {
  step: ctx.step,
});
