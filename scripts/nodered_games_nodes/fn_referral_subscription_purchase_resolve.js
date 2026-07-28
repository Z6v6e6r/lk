const ADMIN_API = "https://api.vivacrm.ru/api/v1";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

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

const pickId = (value) => {
  if (!value || typeof value !== "object") return null;
  return toStr(value.id) || toStr(value.uuid);
};

const normalizePaymentMethod = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  if (["CARD", "CASH", "DEPOSIT", "WIDGET", "SUBSCRIPTION", "SMS"].includes(raw)) return raw;
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

const pickPaymentDeadline = (ctx, payload) => {
  const direct = [
    toStr(payload?.paymentDueDate),
    toStr(payload?.paymentDeadline),
    toStr(payload?.paymentDeadlineAt),
    toStr(payload?.expiresAt),
  ].find((value) => Boolean(value));
  if (direct) return direct;

  const ttlMinutes = Math.max(5, Math.min(360, Math.floor(Number(ctx.reservationMinutes) || 30)));
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, response, response];
};

const adminRequest = (ctx, payload) => {
  msg._referralSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = `${ADMIN_API}/transactions`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.httpRequestTimeout = Math.max(3000, Math.min(120000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 20000)));
  msg.payload = payload;
  return [msg, null, null, null];
};

const ctx = msg._referralSubscriptionCtx && typeof msg._referralSubscriptionCtx === "object"
  ? msg._referralSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "purchase" || ctx.step !== "create_transaction") {
  return fail(500, "Referral subscription purchase resolve context is missing");
}

if (!isOk(msg.statusCode)) {
  const errorMessage = String(
    msg.payload?.message
    || msg.payload?.error
    || msg.payload?.details?.message
    || "",
  ).toLowerCase();

  if (errorMessage.includes("payment method") && errorMessage.includes("not implemented")) {
    const currentMethod = normalizePaymentMethod(ctx.transactionPayload?.paymentMethod);
    const fallbackMap = {
      SMS: "CARD",
      SUBSCRIPTION: "CARD",
      WIDGET: "CARD",
      CARD: "CASH",
    };
    const fallbackMethod = currentMethod ? fallbackMap[currentMethod] || null : null;
    if (fallbackMethod && fallbackMethod !== currentMethod) {
      const retryPayload = Object.assign({}, ctx.transactionPayload, { paymentMethod: fallbackMethod });
      ctx.transactionPayload = retryPayload;
      return adminRequest(ctx, retryPayload);
    }
  }

  return fail(msg.statusCode || 502, "Failed to create Viva transaction", {
    statusCode: msg.statusCode || null,
    payload: msg.payload || null,
    error: msg.error || null,
  });
}

const transactionId = pickId(msg.payload);
const paymentUrl = extractPaymentUrl(msg.payload);
const toPayMinor = Math.max(0, Math.round(toNum(msg.payload?.toPay) ?? 0));
if (!paymentUrl && toPayMinor > 0) {
  return fail(502, "Viva transaction has no paymentUrl", {
    transactionId,
    payload: msg.payload || null,
  });
}

const expiresAt = pickPaymentDeadline(ctx, msg.payload);
const nowIso = new Date().toISOString();
const reservationRecord = {
  inviteId: ctx.inviteId || null,
  ownerPhone: ctx.ownerPhone,
  ownerClientId: ctx.ownerClientId || null,
  ownerSubscriptionId: ctx.ownerSubscriptionId,
  ownerCycleKey: ctx.ownerCycleKey || null,
  ownerSubscriptionName: ctx.ownerSubscriptionName || null,
  ownerPlanKey: ctx.ownerPlanKey || null,
  expirationDate: ctx.expirationDate || null,
  windowStartsAt: ctx.windowStartsAt || null,
  windowEndsAt: ctx.windowEndsAt || null,
  flowType: normalizeFlowType(ctx.flowType),
  planKey: ctx.planKey,
  paymentRef: ctx.paymentRef,
  transactionId,
  clientPhone: ctx.clientPhone,
  clientId: ctx.clientId || null,
  productId: ctx.productId,
  productName: ctx.productName,
  productType: "SUBSCRIPTION",
  amountMinor: Math.max(0, Math.round(Number(ctx.productCostMinor) || 0)),
  toPayMinor,
  paymentStatus: "PAYMENT_PENDING",
  subscriptionStatus: "NOT_REQUESTED",
  status: "PAYMENT_PENDING",
  paymentUrl,
  paymentExpiresAt: expiresAt,
  expiresAt,
  successUrl: ctx.successUrl || null,
  failUrl: ctx.failUrl || null,
  updatedAt: nowIso,
};

const dbQuery = {
  ownerPhone: ctx.ownerPhone,
  ownerSubscriptionId: ctx.ownerSubscriptionId,
  planKey: ctx.planKey,
  paymentRef: ctx.paymentRef,
};
if (ctx.inviteId) {
  dbQuery.inviteId = ctx.inviteId;
}

const dbMsg = Object.assign({}, msg, {
  query: dbQuery,
  payload: {
    $set: reservationRecord,
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 201,
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
    transactionId,
    paymentUrl,
    paymentExpiresAt: expiresAt,
    productId: ctx.productId,
    productName: ctx.productName,
    toPayMinor,
    toPay: toPayMinor / 100,
    remainingBefore: Math.max(0, Math.floor(Number(ctx.remainingBefore) || 0)),
    remainingAfterReservation: Math.max(0, Math.floor(Number(ctx.remainingBefore) || 0) - 1),
    paymentStatus: "PAYMENT_PENDING",
    subscriptionStatus: "NOT_REQUESTED",
    reusedExistingPayment: false,
    status: "PAYMENT_PENDING",
  },
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "purchase_transaction_created",
    inviteId: toStr(ctx.inviteId),
    ownerPhone: toStr(ctx.ownerPhone),
    ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
    ownerCycleKey: toStr(ctx.ownerCycleKey),
    flowType: normalizeFlowType(ctx.flowType),
    planKey: toStr(ctx.planKey),
    paymentRef: ctx.paymentRef,
    transactionId,
  },
});

return [null, dbMsg, responseMsg, debugMsg];
