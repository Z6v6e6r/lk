const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const MANUAL_PAID_COUNT_DEFAULTS = {
  academy: 4,
  ra: 37,
  sport: 38,
};

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

const resolveHttpTimeoutMs = () => {
  const raw = toInt(global.get("summer_subscription_http_timeout_ms"), 20000);
  return Math.max(3000, Math.min(120000, raw));
};

const normalizeStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "PAYMENT_PENDING";
  const hasStatusToken = (token) => status
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .some((part) => part === token || part.startsWith(token));
  if (hasStatusToken("PAID") || hasStatusToken("SUCCESS") || hasStatusToken("COMPLETE")) return "PAID";
  if (status.includes("FAIL") || status.includes("CANCEL") || status.includes("REJECT")) return "FAILED";
  if (status.includes("EXPIRE")) return "EXPIRED";
  return "PAYMENT_PENDING";
};

const normalizeCounterKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "academy"
    || normalized === "energy5"
    || normalized === "friendship"
    || normalized === "ra"
    || normalized === "sirius_friendship"
    || normalized === "sport"
  ) {
    return normalized;
  }
  return null;
};

const readManualPaidCount = (counterKey) => {
  const normalized = normalizeCounterKey(counterKey);
  if (!normalized) return 0;
  return Math.max(
    0,
    toInt(
      global.get(`summer_subscription_${normalized}_manual_paid_count`),
      MANUAL_PAID_COUNT_DEFAULTS[normalized] || 0,
    ),
  );
};

const matchesConfiguredProduct = (row, configuredProductId) => {
  const expectedProductId = toStr(configuredProductId);
  if (!expectedProductId || !row || typeof row !== "object") return true;

  const rowProductId = toStr(row.productId);
  if (!rowProductId) return true;
  return rowProductId === expectedProductId;
};

const matchesConfiguredCounter = (row, ctx) => {
  if (!row || typeof row !== "object") return false;

  const inventoryId = toStr(ctx.inventoryId);
  if (inventoryId) {
    return toStr(row.inventoryId) === inventoryId
      && normalizeCounterKey(row.counterKey) === normalizeCounterKey(ctx.counterKey);
  }

  const rowCounterKey = normalizeCounterKey(row.counterKey);
  const rowCampaignKey = toStr(row.campaignKey);
  const rowProductId = toStr(row.productId);
  const counterKey = normalizeCounterKey(ctx.counterKey);
  const saleType = toStr(ctx.saleType);
  const campaignKey = toStr(ctx.campaignKey);
  const productId = toStr(ctx.productId);

  if (!rowCounterKey && !rowCampaignKey && !rowProductId) {
    return true;
  }
  if (campaignKey && rowCampaignKey && campaignKey === rowCampaignKey) {
    return true;
  }
  if (saleType === "summer_campaign") {
    return Boolean(counterKey && rowCounterKey === counterKey);
  }

  if (counterKey && rowCounterKey && counterKey === rowCounterKey) {
    return true;
  }
  return Boolean(productId && rowProductId && productId === rowProductId);
};

const failMsg = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, response, response];
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "purchase") {
  return failMsg(500, "Summer subscription purchase context is missing");
}

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const now = Date.now();
let paidCount = toStr(ctx?.inventoryId) ? 0 : readManualPaidCount(ctx?.counterKey);
let reservedCount = 0;

for (const row of rows) {
  if (!row || typeof row !== "object") continue;
  if (!matchesConfiguredCounter(row, ctx)) continue;
  if (!matchesConfiguredProduct(row, ctx.productId)) continue;

  const status = normalizeStatus(row.status);
  if (status === "PAID") {
    paidCount += 1;
    continue;
  }
  if (status !== "PAYMENT_PENDING") continue;

  const expiresAtTs = toTs(row.expiresAt);
  const activePending = expiresAtTs == null || expiresAtTs > now;
  if (activePending) {
    reservedCount += 1;
  }
}

const totalLimit = Math.max(0, Math.floor(Number(ctx.totalLimit) || 0));
const takenCount = paidCount + reservedCount;
const unlimited = ctx.unlimited === true;
const remainingCount = unlimited ? null : Math.max(totalLimit - takenCount, 0);

if (!unlimited && remainingCount <= 0) {
  return failMsg(409, "Лимит абонементов исчерпан", {
    counterKey: normalizeCounterKey(ctx.counterKey),
    inventoryId: toStr(ctx.inventoryId),
    saleType: toStr(ctx.saleType),
    planKey: toStr(ctx.planKey),
    campaignKey: toStr(ctx.campaignKey),
    totalLimit,
    takenCount,
    paidCount,
    reservedCount,
    remainingCount,
  });
}

ctx.remainingBefore = remainingCount;
ctx.step = "token_purchase";
ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();
msg._summerSubscriptionCtx = ctx;

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "purchase_limit_ok",
    counterKey: normalizeCounterKey(ctx.counterKey),
    inventoryId: toStr(ctx.inventoryId),
    unlimited,
    planKey: toStr(ctx.planKey),
    campaignKey: toStr(ctx.campaignKey),
    paymentRef: ctx.paymentRef,
    totalLimit,
    takenCount,
    remainingBefore: remainingCount,
    vivaTimeoutMs: ctx.httpRequestTimeoutMs,
  },
});

return [msg, null, debugMsg];
