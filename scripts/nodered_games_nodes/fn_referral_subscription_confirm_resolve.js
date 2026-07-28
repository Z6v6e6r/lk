const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toNum = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const normalizeDateOnly = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const matched = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!matched) return null;
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
};

const toMoscowDateBoundaryTs = (value) => {
  const dateOnly = normalizeDateOnly(value);
  if (dateOnly) {
    const ts = Date.parse(`${dateOnly}T00:00:00+03:00`);
    if (Number.isFinite(ts)) return ts;
  }
  return toTs(value);
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

const normalizePaymentStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "PAYMENT_PENDING";
  if (status.includes("PAID") || status.includes("SUCCESS") || status.includes("COMPLETE")) return "PAID";
  if (status.includes("FAIL") || status.includes("CANCEL") || status.includes("REJECT")) return "FAILED";
  if (status.includes("EXPIRE")) return "EXPIRED";
  return "PAYMENT_PENDING";
};

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const normalizeSubscriptionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "NOT_REQUESTED";
  if (status === "PENDING_ISSUE" || status === "ISSUED" || status === "ISSUE_FAILED" || status === "NOT_REQUESTED") {
    return status;
  }
  return "NOT_REQUESTED";
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

const extractPaymentUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return null;
    return text;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractPaymentUrl(item);
      if (nested) return nested;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const key of ["paymentUrl", "redirectUrl", "paymentLink", "checkoutUrl", "cardPaymentUrl", "paymentPageUrl"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["url", "link", "data", "payload", "result", "transaction", "transactionStatus", "payment", "paymentInfo", "cardPaymentInfo", "cardPaymentStatus"]) {
    const nested = extractPaymentUrl(value[key]);
    if (nested) return nested;
  }

  return null;
};

const normalizeTransactionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  return status || "UNKNOWN";
};

const isPaidTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  if (
    status.includes("PAID")
    || status.includes("SUCCESS")
    || status.includes("COMPLETE")
    || status.includes("APPROV")
  ) return true;

  const toPay = toNum(payload?.toPay);
  if (toPay != null && Math.round(toPay) <= 0 && !extractPaymentUrl(payload)) return true;
  return false;
};

const isFailedTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  return (
    status.includes("FAIL")
    || status.includes("CANCEL")
    || status.includes("REJECT")
    || status.includes("EXPIRE")
  );
};

const pickPaymentDeadline = (ctx, payload) => {
  const direct = [
    toStr(payload?.paymentDueDate),
    toStr(payload?.paymentDeadline),
    toStr(payload?.paymentDeadlineAt),
    toStr(payload?.expiresAt),
  ].find((value) => Boolean(value));
  if (direct) return direct;

  const fallbackTs = Date.now() + Math.max(5, Math.min(360, Math.floor(Number(ctx.reservationMinutes) || 30))) * 60 * 1000;
  return new Date(fallbackTs).toISOString();
};

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

const resolveSubscriptionState = (payload) => {
  if (!payload || typeof payload !== "object") return null;
  return (
    toStr(payload.status)
    || toStr(payload.subscriptionStatus)
    || toStr(payload.state)
    || toStr(payload.subscription?.status)
  );
};

const isSubscriptionActive = (value) => String(value || "").trim().toUpperCase() === "ACTIVE";

const pickSubscriptionId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.subscriptionId) || toStr(value.id) || toStr(value.uuid);
};

const scoreIssuedSubscription = (subscription, ctx) => {
  const planKey = normalizeOwnerPlanKey(resolveSubscriptionName(subscription));
  if (!planKey || planKey !== normalizePlanKey(ctx.planKey)) return Number.NEGATIVE_INFINITY;

  const subscriptionState = resolveSubscriptionState(subscription);
  const isActive = isSubscriptionActive(subscriptionState);
  const expirationDate = resolveExpirationDate(subscription);
  const expirationTs = toMoscowDateBoundaryTs(expirationDate);
  const ownerExpirationTs = toMoscowDateBoundaryTs(ctx.expirationDate);
  const extendsOwnerWindow = expirationTs !== null
    && ownerExpirationTs !== null
    && expirationTs > ownerExpirationTs;

  // Treat only clearly new or still-active subscriptions as issued.
  if (!isActive && !extendsOwnerWindow) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (isActive) score += 500;
  if (expirationTs !== null) score += expirationTs;
  if (extendsOwnerWindow) score += 1000000000000;

  const subscriptionId = pickSubscriptionId(subscription);
  if (subscriptionId && subscriptionId !== toStr(ctx.ownerSubscriptionId)) score += 1000000000;

  score += toTs(subscription.updatedAt) || toTs(subscription.createdAt) || 0;
  return score;
};

const findIssuedSubscription = (items, ctx) => {
  const ranked = items
    .filter((item) => item && typeof item === "object")
    .map((item) => ({ item, score: scoreIssuedSubscription(item, ctx) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => right.score - left.score);

  return ranked[0]?.item || null;
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, response, response];
};

const adminRequest = (ctx, method, path) => {
  msg._referralSubscriptionCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = {};
  return [msg, null, null, null];
};

const buildRecordQuery = (ctx) => {
  const query = ctx.inviteId
    ? {
      inviteId: ctx.inviteId,
      paymentRef: ctx.paymentRef,
    }
    : {
      ownerPhone: ctx.ownerPhone,
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      paymentRef: ctx.paymentRef,
    };
  if (ctx.planKey) {
    query.planKey = ctx.planKey;
  }
  return query;
};

const respond = (ctx, payload) => {
  return Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      inviteId: toStr(ctx.inviteId),
      ownerPhone: null,
      ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
      ownerCycleKey: toStr(ctx.ownerCycleKey),
      flowType: normalizeFlowType(ctx.flowType),
      planKey: toStr(ctx.planKey),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: payload.subscriptionStatus === "ISSUED" ? "ISSUED" : payload.paymentStatus,
      paymentStatus: payload.paymentStatus,
      subscriptionStatus: payload.subscriptionStatus,
      paid: payload.paymentStatus === "PAID",
      failed: payload.paymentStatus === "FAILED" || payload.paymentStatus === "EXPIRED",
      paymentUrl: payload.paymentUrl || null,
      expiresAt: payload.paymentExpiresAt || null,
      paymentExpiresAt: payload.paymentExpiresAt || null,
      updatedAt: payload.updatedAt,
      issuedSubscriptionId: payload.issuedSubscriptionId || null,
      issuedAt: payload.issuedAt || null,
      issuedExpirationDate: payload.issuedExpirationDate || null,
    },
  });
};

const ctx = msg._referralSubscriptionCtx && typeof msg._referralSubscriptionCtx === "object"
  ? msg._referralSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "confirm") {
  return fail(500, "Referral subscription confirm context is missing");
}

ctx.flowType = normalizeFlowType(ctx.flowType);

if (ctx.step === "resolve_record") {
  const rows = Array.isArray(msg.payload) ? msg.payload : [];
  const record = rows
    .filter((item) => item && typeof item === "object")
    .sort((left, right) => (toTs(right.updatedAt) || toTs(right.createdAt) || 0) - (toTs(left.updatedAt) || toTs(left.createdAt) || 0))[0] || null;

  if (!record) {
    return fail(404, "Платеж по ссылке не найден", {
      ownerPhone: ctx.ownerPhone,
      ownerSubscriptionId: ctx.ownerSubscriptionId,
      paymentRef: ctx.paymentRef,
      flowType: ctx.flowType,
    });
  }

  ctx.planKey = normalizePlanKey(ctx.planKey) || normalizePlanKey(record.planKey);
  ctx.inviteId = toStr(record.inviteId) || toStr(ctx.inviteId);
  ctx.flowType = normalizeFlowType(record.flowType || ctx.flowType);
  ctx.ownerCycleKey = toStr(record.ownerCycleKey) || toStr(ctx.ownerCycleKey);
  ctx.transactionId = toStr(record.transactionId) || null;
  ctx.productId = toStr(record.productId) || null;
  ctx.productName = toStr(record.productName) || null;
  ctx.ownerSubscriptionName = toStr(record.ownerSubscriptionName) || null;
  ctx.expirationDate = toStr(record.expirationDate) || null;
  ctx.windowStartsAt = toStr(record.windowStartsAt) || null;
  ctx.windowEndsAt = toStr(record.windowEndsAt) || null;
  ctx.clientPhone = toStr(record.clientPhone) || null;
  ctx.clientId = toStr(record.clientId) || null;
  ctx.reservationMinutes = 30;
  ctx._paymentStatus = normalizePaymentStatus(record.paymentStatus || record.status);
  ctx._subscriptionStatus = normalizeSubscriptionStatus(record.subscriptionStatus);
  ctx._paymentUrl = toStr(record.paymentUrl) || null;
  ctx._paymentExpiresAt = toStr(record.paymentExpiresAt || record.expiresAt) || null;
  ctx._issuedSubscriptionId = toStr(record.issuedSubscriptionId) || null;
  ctx._issuedAt = toStr(record.issuedAt) || null;
  ctx._issuedExpirationDate = toStr(record.issuedExpirationDate) || null;
  msg._referralSubscriptionCtx = ctx;

  if (ctx._subscriptionStatus === "ISSUED") {
    const response = respond(ctx, {
      paymentStatus: "PAID",
      subscriptionStatus: "ISSUED",
      paymentUrl: ctx._paymentUrl,
      paymentExpiresAt: ctx._paymentExpiresAt,
      updatedAt: toStr(record.updatedAt) || toStr(record.createdAt) || new Date().toISOString(),
      issuedSubscriptionId: ctx._issuedSubscriptionId,
      issuedAt: ctx._issuedAt,
      issuedExpirationDate: ctx._issuedExpirationDate,
    });
    return [null, null, response, response];
  }

  if (ctx._paymentStatus === "FAILED" || ctx._paymentStatus === "EXPIRED") {
    const response = respond(ctx, {
      paymentStatus: ctx._paymentStatus,
      subscriptionStatus: ctx._subscriptionStatus,
      paymentUrl: ctx._paymentUrl,
      paymentExpiresAt: ctx._paymentExpiresAt,
      updatedAt: toStr(record.updatedAt) || toStr(record.createdAt) || new Date().toISOString(),
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, null, response, response];
  }

  if (ctx._paymentStatus === "PAID" && ctx.clientId) {
    ctx.step = "token_issue_lookup";
    msg._referralSubscriptionCtx = ctx;
    msg.method = "POST";
    msg.url = TOKEN_URL;
    msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    msg.payload =
      "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";
    return [msg, null, null, null];
  }

  if (!ctx.transactionId) {
    const response = respond(ctx, {
      paymentStatus: ctx._paymentStatus,
      subscriptionStatus: ctx._subscriptionStatus,
      paymentUrl: ctx._paymentUrl,
      paymentExpiresAt: ctx._paymentExpiresAt,
      updatedAt: toStr(record.updatedAt) || toStr(record.createdAt) || new Date().toISOString(),
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, null, response, response];
  }

  ctx.step = "token_confirm";
  msg._referralSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = TOKEN_URL;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload =
    "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";
  return [msg, null, null, null];
}

if (ctx.step === "token_confirm" || ctx.step === "token_issue_lookup") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      statusCode: msg.statusCode || null,
      payload: msg.payload || null,
      error: msg.error || null,
    });
  }

  ctx.token = msg.payload.access_token;
  if (ctx.step === "token_issue_lookup") {
    ctx.step = "lookup_client_subscriptions";
    return adminRequest(ctx, "GET", `/clients/${encodeURIComponent(ctx.clientId)}/subscriptions?size=200`);
  }
  ctx.step = "confirm_lookup";
  return adminRequest(ctx, "GET", `/transactions/${encodeURIComponent(ctx.transactionId)}`);
}

if (ctx.step === "confirm_lookup") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Failed to fetch Viva transaction", {
      statusCode: msg.statusCode || null,
      payload: msg.payload || null,
      error: msg.error || null,
    });
  }

  const nowIso = new Date().toISOString();
  const paid = isPaidTransaction(msg.payload);
  const failed = !paid && isFailedTransaction(msg.payload);
  const paymentStatus = paid ? "PAID" : failed ? "FAILED" : "PAYMENT_PENDING";
  const paymentExpiresAt = pickPaymentDeadline(ctx, msg.payload);
  const paymentUrl = extractPaymentUrl(msg.payload);

  if (!paid) {
    const dbMsg = Object.assign({}, msg, {
      query: buildRecordQuery(ctx),
      payload: {
        $set: {
          status: paymentStatus,
          paymentStatus,
          subscriptionStatus: "NOT_REQUESTED",
          updatedAt: nowIso,
          lastCheckedAt: nowIso,
          paymentUrl,
          paymentExpiresAt,
          expiresAt: paymentExpiresAt,
          toPayMinor: Math.max(0, Math.round(toNum(msg.payload?.toPay) ?? 0)),
          paidAt: null,
        },
      },
    });

    const responseMsg = respond(ctx, {
      paymentStatus,
      subscriptionStatus: "NOT_REQUESTED",
      paymentUrl,
      paymentExpiresAt,
      updatedAt: nowIso,
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, dbMsg, responseMsg, responseMsg];
  }

  ctx._paymentStatus = "PAID";
  ctx._paymentUrl = paymentUrl;
  ctx._paymentExpiresAt = paymentExpiresAt;
  msg._referralSubscriptionCtx = ctx;

  if (!ctx.clientId) {
    const dbMsg = Object.assign({}, msg, {
      query: buildRecordQuery(ctx),
      payload: {
        $set: {
          status: "PAID",
          paymentStatus: "PAID",
          subscriptionStatus: "PENDING_ISSUE",
          updatedAt: nowIso,
          lastCheckedAt: nowIso,
          paymentUrl,
          paymentExpiresAt,
          expiresAt: paymentExpiresAt,
          toPayMinor: Math.max(0, Math.round(toNum(msg.payload?.toPay) ?? 0)),
          paidAt: nowIso,
        },
      },
    });
    const responseMsg = respond(ctx, {
      paymentStatus: "PAID",
      subscriptionStatus: "PENDING_ISSUE",
      paymentUrl,
      paymentExpiresAt,
      updatedAt: nowIso,
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, dbMsg, responseMsg, responseMsg];
  }

  ctx.step = "lookup_client_subscriptions";
  return adminRequest(ctx, "GET", `/clients/${encodeURIComponent(ctx.clientId)}/subscriptions?size=200`);
}

if (ctx.step === "lookup_client_subscriptions") {
  const nowIso = new Date().toISOString();
  const paymentStatus = "PAID";
  const paymentUrl = ctx._paymentUrl || null;
  const paymentExpiresAt = ctx._paymentExpiresAt || null;

  if (!isOk(msg.statusCode)) {
    const dbMsg = Object.assign({}, msg, {
      query: buildRecordQuery(ctx),
      payload: {
        $set: {
          status: paymentStatus,
          paymentStatus,
          subscriptionStatus: "PENDING_ISSUE",
          updatedAt: nowIso,
          lastCheckedAt: nowIso,
          paymentUrl,
          paymentExpiresAt,
          expiresAt: paymentExpiresAt,
          paidAt: nowIso,
        },
      },
    });
    const responseMsg = respond(ctx, {
      paymentStatus,
      subscriptionStatus: "PENDING_ISSUE",
      paymentUrl,
      paymentExpiresAt,
      updatedAt: nowIso,
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, dbMsg, responseMsg, responseMsg];
  }

  const issuedSubscription = findIssuedSubscription(parseList(msg.payload), ctx);
  if (!issuedSubscription) {
    const dbMsg = Object.assign({}, msg, {
      query: buildRecordQuery(ctx),
      payload: {
        $set: {
          status: paymentStatus,
          paymentStatus,
          subscriptionStatus: "PENDING_ISSUE",
          updatedAt: nowIso,
          lastCheckedAt: nowIso,
          paymentUrl,
          paymentExpiresAt,
          expiresAt: paymentExpiresAt,
          paidAt: nowIso,
        },
      },
    });
    const responseMsg = respond(ctx, {
      paymentStatus,
      subscriptionStatus: "PENDING_ISSUE",
      paymentUrl,
      paymentExpiresAt,
      updatedAt: nowIso,
      issuedSubscriptionId: null,
      issuedAt: null,
      issuedExpirationDate: null,
    });
    return [null, dbMsg, responseMsg, responseMsg];
  }

  const issuedSubscriptionId = pickSubscriptionId(issuedSubscription);
  const issuedExpirationDate = resolveExpirationDate(issuedSubscription);
  const dbMsg = Object.assign({}, msg, {
    query: buildRecordQuery(ctx),
    payload: {
      $set: {
        status: "PAID",
        paymentStatus: "PAID",
        subscriptionStatus: "ISSUED",
        updatedAt: nowIso,
        lastCheckedAt: nowIso,
        paymentUrl,
        paymentExpiresAt,
        expiresAt: paymentExpiresAt,
        paidAt: nowIso,
        issuedSubscriptionId,
        issuedAt: nowIso,
        issuedExpirationDate: issuedExpirationDate || null,
      },
    },
  });
  const responseMsg = respond(ctx, {
    paymentStatus,
    subscriptionStatus: "ISSUED",
    paymentUrl,
    paymentExpiresAt,
    updatedAt: nowIso,
    issuedSubscriptionId,
    issuedAt: nowIso,
    issuedExpirationDate: issuedExpirationDate || null,
  });
  return [null, dbMsg, responseMsg, responseMsg];
}

return fail(500, "Unsupported referral confirm step", {
  step: ctx.step,
});
