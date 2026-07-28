const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const DEFAULT_HTTP_TIMEOUT_MS = 20000;
const TOTAL_LIMIT = 1;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const toInt = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.floor(parsed);
};

const normalizePaymentStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "PAYMENT_PENDING";
  if (status.includes("PAID") || status.includes("SUCCESS") || status.includes("COMPLETE")) return "PAID";
  if (status.includes("FAIL") || status.includes("CANCEL") || status.includes("REJECT")) return "FAILED";
  if (status.includes("EXPIRE")) return "EXPIRED";
  return "PAYMENT_PENDING";
};

const normalizeSubscriptionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "NOT_REQUESTED";
  if (status === "PENDING_ISSUE" || status === "ISSUED" || status === "ISSUE_FAILED" || status === "NOT_REQUESTED") {
    return status;
  }
  return "NOT_REQUESTED";
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

const resolveHttpTimeoutMs = () => {
  const raw = toInt(global.get("referral_subscription_http_timeout_ms"), DEFAULT_HTTP_TIMEOUT_MS);
  return Math.max(3000, Math.min(120000, raw));
};

const isSameClient = (row, ctx) => {
  const rowClientId = toStr(row.clientId);
  const ctxClientId = toStr(ctx.clientId);
  if (rowClientId && ctxClientId) {
    return rowClientId === ctxClientId;
  }
  return toStr(row.clientPhone) === toStr(ctx.clientPhone);
};

const isLivePending = (row, nowTs) => {
  if (normalizePaymentStatus(row.paymentStatus || row.status) !== "PAYMENT_PENDING") return false;
  const expiresAtTs = toTs(row.paymentExpiresAt || row.expiresAt);
  return expiresAtTs === null || expiresAtTs > nowTs;
};

const isFinalized = (row) => {
  const paymentStatus = normalizePaymentStatus(row.paymentStatus || row.status);
  const subscriptionStatus = normalizeSubscriptionStatus(row.subscriptionStatus);
  return paymentStatus === "PAID" || subscriptionStatus === "PENDING_ISSUE" || subscriptionStatus === "ISSUED";
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, response, response];
};

const ctx = msg._referralSubscriptionCtx && typeof msg._referralSubscriptionCtx === "object"
  ? msg._referralSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "purchase") {
  return fail(500, "Referral subscription purchase context is missing");
}

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const nowTs = Date.now();
const flowType = normalizeFlowType(ctx.flowType);
const planKey = normalizePlanKey(ctx.planKey);
if (flowType === "renewal" && planKey !== normalizePlanKey(ctx.ownerPlanKey)) {
  return fail(403, "Продлить можно только текущий тип подписки владельца", {
    ownerPlanKey: normalizePlanKey(ctx.ownerPlanKey),
    requestedPlanKey: planKey,
  });
}

const scopedRows = rows.filter((row) => {
  if (!row || typeof row !== "object") return false;
  if (normalizeFlowType(row.flowType || row.mode) !== flowType) return false;
  if (normalizePlanKey(row.planKey) !== planKey) return false;
  if (toStr(row.ownerSubscriptionId) && toStr(row.ownerSubscriptionId) !== toStr(ctx.ownerSubscriptionId)) return false;
  if (toStr(row.ownerCycleKey) && toStr(ctx.ownerCycleKey) && toStr(row.ownerCycleKey) !== toStr(ctx.ownerCycleKey)) return false;
  return true;
});

const finalizedRow = scopedRows.find((row) => isFinalized(row));
if (finalizedRow) {
  const responseMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: flowType === "renewal"
        ? "Продление по этой подписке уже оплачено"
        : "Лимит по этой ссылке уже использован",
      details: {
        inviteId: toStr(ctx.inviteId),
        ownerPhone: toStr(ctx.ownerPhone),
        ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
        ownerCycleKey: toStr(ctx.ownerCycleKey),
        flowType,
        planKey,
        paymentStatus: normalizePaymentStatus(finalizedRow.paymentStatus || finalizedRow.status),
        subscriptionStatus: normalizeSubscriptionStatus(finalizedRow.subscriptionStatus),
      },
    },
  });
  return [null, responseMsg, responseMsg];
}

const pendingSameClientRow = scopedRows.find((row) => isSameClient(row, ctx) && isLivePending(row, nowTs));
if (pendingSameClientRow) {
  const existingPaymentUrl = toStr(pendingSameClientRow.paymentUrl);
  const responseMsg = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      inviteId: toStr(ctx.inviteId),
      ownerPhone: null,
      ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
      ownerCycleKey: toStr(ctx.ownerCycleKey),
      flowType,
      planKey,
      paymentRef: toStr(pendingSameClientRow.paymentRef),
      transactionId: toStr(pendingSameClientRow.transactionId),
      paymentUrl: existingPaymentUrl,
      paymentExpiresAt: toStr(pendingSameClientRow.paymentExpiresAt || pendingSameClientRow.expiresAt),
      productId: toStr(pendingSameClientRow.productId) || toStr(ctx.productId),
      productName: toStr(pendingSameClientRow.productName) || toStr(ctx.productName),
      remainingBefore: 1,
      remainingAfterReservation: 0,
      paymentStatus: normalizePaymentStatus(pendingSameClientRow.paymentStatus || pendingSameClientRow.status),
      subscriptionStatus: normalizeSubscriptionStatus(pendingSameClientRow.subscriptionStatus),
      reusedExistingPayment: true,
      status: normalizePaymentStatus(pendingSameClientRow.paymentStatus || pendingSameClientRow.status),
    },
  });
  return [null, responseMsg, responseMsg];
}

const pendingOtherClientRow = scopedRows.find((row) => !isSameClient(row, ctx) && isLivePending(row, nowTs));
if (pendingOtherClientRow) {
  return fail(409, "Лимит по этой ссылке уже временно занят другим платежом", {
    inviteId: toStr(ctx.inviteId),
    ownerPhone: toStr(ctx.ownerPhone),
    ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
    ownerCycleKey: toStr(ctx.ownerCycleKey),
    flowType,
    planKey,
    paymentRef: toStr(pendingOtherClientRow.paymentRef),
    expiresAt: toStr(pendingOtherClientRow.paymentExpiresAt || pendingOtherClientRow.expiresAt),
  });
}

const transactionPayload = {
  clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
  paymentMethod: "SMS",
  products: [
    {
      id: ctx.productId,
      count: 1,
      customAmount: null,
      type: "SUBSCRIPTION",
      discount: 0,
    },
  ],
  offlineTillId: null,
  deposit: 0,
};

if (ctx.successUrl) {
  transactionPayload.successUrl = ctx.successUrl;
  transactionPayload.baseRedirectUrl = ctx.successUrl;
  transactionPayload.redirectUrl = ctx.successUrl;
  transactionPayload.returnUrl = ctx.successUrl;
  transactionPayload.successRedirectUrl = ctx.successUrl;
}
if (ctx.failUrl) {
  transactionPayload.failUrl = ctx.failUrl;
  transactionPayload.failRedirectUrl = ctx.failUrl;
  transactionPayload.failureRedirectUrl = ctx.failUrl;
}

ctx.step = "create_transaction";
ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();
ctx.remainingBefore = TOTAL_LIMIT;
ctx.transactionPayload = transactionPayload;
msg._referralSubscriptionCtx = ctx;
msg.method = "POST";
msg.url = `${ADMIN_API}/transactions`;
msg.headers = {
  Authorization: `Bearer ${ctx.token}`,
  "Content-Type": "application/json",
};
msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
msg.payload = transactionPayload;

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "purchase_limit_ok",
    inviteId: toStr(ctx.inviteId),
    ownerPhone: toStr(ctx.ownerPhone),
    ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
    ownerCycleKey: toStr(ctx.ownerCycleKey),
    flowType,
    planKey,
    remainingBefore: TOTAL_LIMIT,
  },
});

return [msg, null, debugMsg];
