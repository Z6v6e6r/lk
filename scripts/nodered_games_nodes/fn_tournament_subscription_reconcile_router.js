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

const normalizeTransactionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "UNKNOWN";
  return status;
};

const hasStatusToken = (status, token) => status
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .some((part) => part === token || part.startsWith(token));

const isLikelyPaymentUrl = (value) => {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) return false;
  return /(pay|tbank|tinkoff|payment|checkout|bank|acquir)|([?&](payment|transaction|order|invoice)=)/i.test(text);
};

const extractPaymentUrl = (value) => {
  if (!value) return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^https?:\/\//i.test(text)) return null;
    return isLikelyPaymentUrl(text) ? text : null;
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

  for (const key of ["url", "link"]) {
    const direct = extractPaymentUrl(value[key]);
    if (direct) return direct;
  }

  for (const key of ["data", "payload", "result", "transaction", "transactionStatus", "cardPaymentStatus", "payment", "paymentInfo", "cardPaymentInfo"]) {
    const nested = extractPaymentUrl(value[key]);
    if (nested) return nested;
  }

  return null;
};

const pickPaymentDeadline = (ctx, payload, fallbackValue) => {
  const direct = [
    toStr(payload?.paymentDueDate),
    toStr(payload?.paymentDeadline),
    toStr(payload?.paymentDeadlineAt),
    toStr(payload?.expiresAt),
  ].find((value) => Boolean(value));
  if (direct) return direct;
  if (toStr(fallbackValue)) return toStr(fallbackValue);

  const ttlMinutes = Math.max(5, Math.min(360, Math.floor(Number(ctx.reservationMinutes) || 30)));
  return new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
};

const isPaidTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  if (
    hasStatusToken(status, "PAID")
    || hasStatusToken(status, "SUCCESS")
    || hasStatusToken(status, "COMPLETE")
    || hasStatusToken(status, "APPROV")
  ) return true;

  const toPay = toNum(payload?.toPay);
  if (toPay != null && Math.round(toPay) <= 0 && !extractPaymentUrl(payload)) return true;
  return false;
};

const isFailedTransaction = (payload) => {
  const status = normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus);
  return (
    hasStatusToken(status, "FAIL")
    || hasStatusToken(status, "CANCEL")
    || hasStatusToken(status, "REJECT")
    || hasStatusToken(status, "EXPIRE")
  );
};

const failMsg = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, null, response, response];
};

const buildFinalizeMsg = (ctx, rows) => {
  const nextMsg = Object.assign({}, msg, {
    payload: Array.isArray(rows) ? rows : [],
  });
  const nextCtx = Object.assign({}, ctx);
  delete nextCtx.token;
  delete nextCtx.currentReconcile;
  nextMsg._summerSubscriptionCtx = nextCtx;
  return nextMsg;
};

const buildAdminRequest = (ctx, transactionId) => {
  const timeoutMs = Math.max(3000, Math.min(120000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 20000)));
  ctx.httpRequestTimeoutMs = timeoutMs;
  ctx.step = "reconcile_lookup";
  msg._summerSubscriptionCtx = ctx;
  msg.method = "GET";
  msg.url = `${ADMIN_API}/transactions/${encodeURIComponent(transactionId)}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.httpRequestTimeout = timeoutMs;
  msg.payload = null;
  return msg;
};

const continueOrFinalize = (ctx, debugPayload, dbMsg) => {
  const queue = Array.isArray(ctx.reconcileQueue) ? ctx.reconcileQueue : [];
  const nextEntry = queue[ctx.reconcileCursor] || null;
  const debugMsg = Object.assign({}, msg, { payload: debugPayload });
  if (!nextEntry || !toStr(nextEntry.transactionId)) {
    return [null, dbMsg || null, buildFinalizeMsg(ctx, ctx.reconcileRows), null, debugMsg];
  }

  ctx.currentReconcile = nextEntry;
  const requestMsg = buildAdminRequest(ctx, nextEntry.transactionId);
  return [requestMsg, dbMsg || null, null, null, debugMsg];
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || (ctx.action !== "status" && ctx.action !== "purchase")) {
  return failMsg(500, "Summer subscription reconcile router context is missing", {
    action: ctx && ctx.action ? ctx.action : null,
    step: ctx && ctx.step ? ctx.step : null,
  });
}

if (ctx.step === "token_reconcile") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    if (ctx.reconcileAllowFallback) {
      ctx.reconcileFallback = {
        step: ctx.step,
        statusCode: msg.statusCode || null,
        error: msg.error || null,
      };
      const debugMsg = Object.assign({}, msg, {
        payload: {
          action: "reconcile_fallback",
          sourceAction: ctx.action,
          step: ctx.step,
          statusCode: msg.statusCode || null,
        },
      });
      return [null, null, buildFinalizeMsg(ctx, ctx.reconcileRows), null, debugMsg];
    }

    return failMsg(502, "Viva token error during summer subscription reconcile", {
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  ctx.token = msg.payload.access_token;
  return continueOrFinalize(ctx, {
    action: "reconcile_token_ok",
    sourceAction: ctx.action,
    queueSize: Array.isArray(ctx.reconcileQueue) ? ctx.reconcileQueue.length : 0,
  });
}

if (ctx.step === "reconcile_lookup") {
  const queue = Array.isArray(ctx.reconcileQueue) ? ctx.reconcileQueue : [];
  const entry = ctx.currentReconcile || queue[ctx.reconcileCursor] || null;
  if (!entry || !toStr(entry.transactionId)) {
    return failMsg(500, "Summer subscription reconcile entry is missing", {
      sourceAction: ctx.action,
      cursor: ctx.reconcileCursor,
    });
  }

  if (!isOk(msg.statusCode)) {
    if (ctx.reconcileAllowFallback) {
      ctx.reconcileFallback = {
        step: ctx.step,
        transactionId: entry.transactionId,
        statusCode: msg.statusCode || null,
        error: msg.error || null,
      };
      const debugMsg = Object.assign({}, msg, {
        payload: {
          action: "reconcile_fallback",
          sourceAction: ctx.action,
          step: ctx.step,
          transactionId: entry.transactionId,
          statusCode: msg.statusCode || null,
        },
      });
      return [null, null, buildFinalizeMsg(ctx, ctx.reconcileRows), null, debugMsg];
    }

    return failMsg(502, "Failed to fetch Viva transaction during summer subscription reconcile", {
      transactionId: entry.transactionId,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const rows = Array.isArray(ctx.reconcileRows) ? ctx.reconcileRows : [];
  const targetRow = rows[entry.index] && typeof rows[entry.index] === "object"
    ? rows[entry.index]
    : {};
  const nowIso = new Date().toISOString();
  const paid = isPaidTransaction(msg.payload);
  const failed = !paid && isFailedTransaction(msg.payload);
  const nextStatus = paid ? "PAID" : failed ? "FAILED" : "PAYMENT_PENDING";
  const paymentUrl = extractPaymentUrl(msg.payload);
  const expiresAt = pickPaymentDeadline(ctx, msg.payload, targetRow.expiresAt);
  const toPayMinor = Math.max(
    0,
    Math.round((toNum(msg.payload?.toPay) ?? Number(targetRow.toPayMinor) ?? 0) || 0),
  );

  rows[entry.index] = Object.assign({}, targetRow, {
    status: nextStatus,
    updatedAt: nowIso,
    lastCheckedAt: nowIso,
    paymentUrl: paymentUrl || null,
    expiresAt,
    toPayMinor,
    paidAt: paid ? toStr(targetRow.paidAt) || nowIso : null,
  });
  ctx.reconcileRows = rows;
  ctx.reconcileCursor = Number(ctx.reconcileCursor) + 1;
  delete ctx.currentReconcile;

  const dbQuery = {};
  const paymentRef = toStr(targetRow.paymentRef) || toStr(entry.paymentRef);
  const campaignKey = toStr(targetRow.campaignKey) || toStr(entry.campaignKey);
  if (campaignKey) dbQuery.campaignKey = campaignKey;
  if (paymentRef) {
    dbQuery.paymentRef = paymentRef;
  } else if (toStr(entry.transactionId)) {
    dbQuery.transactionId = toStr(entry.transactionId);
  }

  const dbMsg = Object.keys(dbQuery).length > 0
    ? Object.assign({}, msg, {
        query: dbQuery,
        payload: {
          $set: {
            status: nextStatus,
            updatedAt: nowIso,
            lastCheckedAt: nowIso,
            paymentUrl: paymentUrl || null,
            expiresAt,
            toPayMinor,
            paidAt: paid ? nowIso : null,
          },
        },
      })
    : null;

  return continueOrFinalize(ctx, {
    action: "reconcile_lookup_done",
    sourceAction: ctx.action,
    transactionId: entry.transactionId,
    paymentRef,
    status: nextStatus,
    paid,
    failed,
  }, dbMsg);
}

return failMsg(500, "Unsupported summer subscription reconcile step", {
  action: ctx.action,
  step: ctx.step,
});
