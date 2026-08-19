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

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
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

const resolveTransactionPaymentMethod = (ctx) => {
  const explicit = normalizePaymentMethod(ctx?.transactionPaymentMethod || ctx?.paymentMethod);
  if (explicit) return explicit;
  return "SMS";
};

const buildRecordQuery = (ctx) => {
  const paymentRef = toStr(ctx?.paymentRef);
  const counterKey = toStr(ctx?.counterKey);
  const inventoryId = toStr(ctx?.inventoryId);
  const saleType = toStr(ctx?.saleType);
  const campaignKey = toStr(ctx?.campaignKey);
  const productId = toStr(ctx?.productId);
  const query = {};

  if (paymentRef) {
    query.paymentRef = paymentRef;
  }
  if (inventoryId) {
    query.inventoryId = inventoryId;
  }

  const conditions = [];
  if (counterKey) {
    conditions.push({ counterKey });
  }
  if (saleType === "summer_campaign" && campaignKey) {
    conditions.push({ campaignKey });
  }
  if (saleType === "direct_product" && productId) {
    conditions.push({ productId });
  }

  if (conditions.length === 1) {
    Object.assign(query, conditions[0]);
  } else if (conditions.length > 1) {
    query.$or = conditions;
  }

  return query;
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, null, response, response];
};

const adminRequest = (ctx, method, path, payload) => {
  const timeoutMs = Math.max(3000, Math.min(120000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 20000)));
  ctx.httpRequestTimeoutMs = timeoutMs;
  msg._summerSubscriptionCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.httpRequestTimeout = timeoutMs;
  msg.payload = payload;
  return [msg, null, null, null];
};

const extractList = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.content)) return value.content;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
};

const normalizeProductType = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  if (
    raw === "SERVICE"
    || raw === "ADVANCE_SUB_SERVICE"
    || raw === "BOOKING_PAYMENT"
    || raw === "FULL_PAYMENT_SERVICE"
    || raw === "SUBSCRIPTION"
  ) return raw;
  return "SUBSCRIPTION";
};

const normalizeProduct = (value) => {
  if (!value || typeof value !== "object") return null;
  const id = pickId(value);
  if (!id) return null;
  return {
    id,
    name: toStr(value.name || value.title || value.displayName) || "Абонемент",
    type: normalizeProductType(value.productType || value.type),
    costMinor: Math.max(0, Math.round(toNum(value.cost) ?? 0)),
    raw: value,
  };
};

const buildConfiguredProduct = (ctx) => {
  const id = toStr(ctx.productId);
  if (!id) return null;
  return {
    id,
    name: toStr(ctx.productName) || "Абонемент",
    type: "SUBSCRIPTION",
    costMinor: Math.max(0, Math.round(toNum(ctx.productCostMinor) ?? 0)),
    raw: null,
  };
};

const toStringArray = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStr(item))
      .filter((item) => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => toStr(item))
      .filter((item) => Boolean(item));
  }
  return [];
};

const normalizeName = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/\s+/g, " ");

const uniqueStrings = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = toStr(item);
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const computeProductScore = (productNameNormalized, targetNamesNormalized) => {
  let score = 0;
  for (const target of targetNamesNormalized) {
    if (!target) continue;
    if (productNameNormalized === target) {
      score = Math.max(score, 220);
      continue;
    }
    if (productNameNormalized.includes(target)) {
      score = Math.max(score, 170);
      continue;
    }
    if (target.includes(productNameNormalized) && productNameNormalized.length >= 6) {
      score = Math.max(score, 120);
      continue;
    }

    const targetTokens = target
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 4 || token.includes("🎾"));
    if (targetTokens.length > 0) {
      let tokenHits = 0;
      for (const token of targetTokens) {
        if (productNameNormalized.includes(token)) tokenHits += 1;
      }
      if (tokenHits > 0) {
        score = Math.max(score, 70 + tokenHits * 20);
      }
    }
  }

  if (productNameNormalized.includes("акцион")) score += 10;
  if (productNameNormalized.includes("🎾") || productNameNormalized.includes("теннис")) score += 5;

  return score;
};

const pickTargetProduct = (products, ctx) => {
  const configuredId = toStr(ctx.productId);
  if (configuredId) {
    const byId = products.find((item) => item.id === configuredId);
    if (byId) return byId;
    const configuredProduct = buildConfiguredProduct(ctx);
    if (configuredProduct) return configuredProduct;
  }

  const targetNames = uniqueStrings([
    ...toStringArray(ctx.productAliases),
    ctx.productName,
  ]);
  const targetNamesNormalized = targetNames.map((name) => normalizeName(name)).filter((name) => Boolean(name));
  if (targetNamesNormalized.length === 0) return null;

  let best = null;
  let bestScore = -1;
  for (const product of products) {
    const normalized = normalizeName(product.name);
    const score = computeProductScore(normalized, targetNamesNormalized);
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }

  if (!best) return null;
  return bestScore >= 80 ? best : null;
};

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

const normalizeTransactionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "UNKNOWN";
  return status;
};

const hasStatusToken = (status, token) => status
  .split(/[^A-Z0-9]+/)
  .filter(Boolean)
  .some((part) => part === token || part.startsWith(token));

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

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx) {
  return fail(500, "Summer subscription context is missing");
}

if (ctx.step === "token_purchase") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  ctx.token = msg.payload.access_token;
  ctx.step = "load_products";
  return adminRequest(ctx, "GET", "/products/subscriptions?size=500");
}

if (ctx.step === "load_products") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Failed to load Viva subscriptions", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const products = extractList(msg.payload)
    .map((item) => normalizeProduct(item))
    .filter((item) => Boolean(item));

  if (products.length === 0) {
    return fail(502, "Viva returned no subscriptions", msg.payload || null);
  }

  const targetProduct = pickTargetProduct(products, ctx);
  if (!targetProduct) {
    const requestedName = toStr(ctx.productName) || "Абонемент";
    return fail(404, `Не найден абонемент ${requestedName}`, {
      requestedPlanKey: toStr(ctx.planKey),
      requestedName,
      requestedId: ctx.productId,
      requestedAliases: toStringArray(ctx.productAliases),
      availableProducts: products.map((item) => ({ id: item.id, name: item.name })),
    });
  }

  ctx.productId = targetProduct.id;
  ctx.productName = targetProduct.name;
  ctx.productType = targetProduct.type;
  ctx.productCostMinor = targetProduct.costMinor;

  const transactionPayload = {
    clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
    paymentMethod: resolveTransactionPaymentMethod(ctx),
    products: [
      {
        id: targetProduct.id,
        count: 1,
        customAmount: null,
        type: targetProduct.type,
        discount: 0,
      },
    ],
    offlineTillId: null,
    deposit: 0,
    ...(ctx.studioId ? { studioId: ctx.studioId } : {}),
    ...(ctx.successUrl ? { successUrl: ctx.successUrl } : {}),
    ...(ctx.failUrl ? { failUrl: ctx.failUrl } : {}),
  };

  ctx.step = "create_transaction";
  ctx.transactionPayload = transactionPayload;

  return adminRequest(ctx, "POST", "/transactions", transactionPayload);
}

if (ctx.step === "create_transaction") {
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
        return adminRequest(ctx, "POST", "/transactions", retryPayload);
      }
    }
    return fail(msg.statusCode || 502, "Failed to create Viva transaction", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const transactionId = pickId(msg.payload);
  const paymentUrl = extractPaymentUrl(msg.payload);
  const toPayMinor = Math.max(0, Math.round(toNum(msg.payload?.toPay) ?? 0));
  if (!paymentUrl && toPayMinor > 0) {
    return fail(502, "Viva transaction has no paymentUrl", {
      transactionId,
      response: msg.payload || null,
    });
  }

  const expiresAt = pickPaymentDeadline(ctx, msg.payload);
  const nowIso = new Date().toISOString();

  const reservationRecord = {
    counterKey: toStr(ctx.counterKey),
    inventoryId: toStr(ctx.inventoryId),
    unlimited: ctx.unlimited === true,
    releasePhase: toStr(ctx.releasePhase),
    releaseStartDate: toStr(ctx.releaseStartDate),
    launchLimit: Math.max(0, Math.floor(Number(ctx.launchLimit) || 0)),
    dailyLimit: Math.max(0, Math.floor(Number(ctx.dailyLimit) || 0)),
    dailyDropDate: toStr(ctx.dailyDropDate),
    batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
    batchSize: Math.max(0, Math.floor(Number(ctx.batchSize) || 0)),
    saleType: toStr(ctx.saleType),
    planKey: toStr(ctx.planKey),
    campaignKey: ctx.campaignKey,
    paymentRef: ctx.paymentRef,
    transactionId,
    clientPhone: ctx.clientPhone,
    clientId: ctx.clientId || null,
    trainerQrCode: toStr(ctx.trainerQrCode),
    productId: ctx.productId,
    productName: ctx.productName,
    productType: ctx.productType || "SUBSCRIPTION",
    amountMinor: Math.max(0, Math.round(Number(ctx.productCostMinor) || 0)),
    toPayMinor,
    status: "PAYMENT_PENDING",
    paymentUrl,
    expiresAt,
    successUrl: ctx.successUrl || null,
    failUrl: ctx.failUrl || null,
    updatedAt: nowIso,
  };

  const dbMsg = Object.assign({}, msg, {
    query: buildRecordQuery(ctx),
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
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      unlimited: ctx.unlimited === true,
      releasePhase: toStr(ctx.releasePhase),
      dailyDropActive: ctx.dailyDropActive === true,
      dailyDropDate: toStr(ctx.dailyDropDate),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      batchSize: Math.max(0, Math.floor(Number(ctx.batchSize) || 0)),
      batchRemainingBefore: Math.max(0, Math.floor(Number(ctx.batchRemainingBefore) || 0)),
      batchRemainingAfterReservation: Math.max(0, Math.floor(Number(ctx.batchRemainingBefore) || 0) - 1),
      planKey: toStr(ctx.planKey),
      planType: toStr(ctx.planKey),
      campaignKey: ctx.campaignKey,
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
      status: "PAYMENT_PENDING",
    },
  });

  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "purchase_transaction_created",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId,
      toPayMinor,
      productId: ctx.productId,
    },
  });

  return [null, dbMsg, responseMsg, debugMsg];
}

if (ctx.step === "token_confirm") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    return fail(502, "Viva token error", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  ctx.token = msg.payload.access_token;
  if (!ctx.transactionId) {
    return fail(400, "transactionId is required for confirmation", { paymentRef: ctx.paymentRef });
  }

  ctx.step = "confirm_lookup";
  return adminRequest(
    ctx,
    "GET",
    `/transactions/${encodeURIComponent(ctx.transactionId)}`,
  );
}

if (ctx.step === "confirm_lookup") {
  if (!isOk(msg.statusCode)) {
    return fail(msg.statusCode || 502, "Failed to fetch Viva transaction", {
      step: ctx.step,
      statusCode: msg.statusCode || null,
      error: msg.error || null,
      payload: msg.payload || null,
    });
  }

  const nowIso = new Date().toISOString();
  const paid = isPaidTransaction(msg.payload);
  const failed = !paid && isFailedTransaction(msg.payload);
  const nextStatus = paid ? "PAID" : failed ? "FAILED" : "PAYMENT_PENDING";
  const expiresAt = pickPaymentDeadline(ctx, msg.payload);
  const dbQuery = buildRecordQuery(ctx);

  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: {
      $set: {
        status: nextStatus,
        updatedAt: nowIso,
        lastCheckedAt: nowIso,
        paymentUrl: extractPaymentUrl(msg.payload),
        expiresAt,
        toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
        paidAt: paid ? nowIso : null,
      },
    },
  });

  const responseMsg = ctx.reconcile === true ? null : Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: toStr(ctx.planKey),
      planType: toStr(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: nextStatus,
      paid,
      failed,
      paymentUrl: extractPaymentUrl(msg.payload),
      expiresAt,
      updatedAt: nowIso,
    },
  });

  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "confirm_lookup_done",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: nextStatus,
    },
  });

  return [null, dbMsg, responseMsg, debugMsg];
}

return fail(500, "Unsupported summer subscription step", {
  step: ctx.step,
  action: ctx.action,
});
