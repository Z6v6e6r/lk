const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const REGIONAL_FRIENDSHIP_BINDING_LABELS = {
  kotelniki_friendship: "Котельники",
  network_friendship: "ХАБ",
  piter_friendship: "Питер",
};
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

const resolveNextDailyDropAt = (completedAtTs) => {
  if (!Number.isFinite(completedAtTs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(completedAtTs));
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dropTs = Date.parse(`${fields.year}-${fields.month}-${fields.day}T10:00:00+03:00`);
  return new Date(completedAtTs < dropTs ? dropTs : dropTs + 24 * 60 * 60 * 1000).toISOString();
};

const resolveDailyDropDate = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp)).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const localDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const dropDay = Number(parts.hour) >= 10 ? localDay : localDay - 24 * 60 * 60 * 1000;
  return new Date(dropDay).toISOString().slice(0, 10);
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
    || normalized === "kotelniki_friendship"
    || normalized === "network_friendship"
    || normalized === "piter_friendship"
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
let launchPaidCount = 0;
let launchReservedCount = 0;
let dailyPaidCount = 0;
let dailyReservedCount = 0;
const launchPaidTimestamps = [];
const stagedRows = [];

for (const row of rows) {
  if (!row || typeof row !== "object") continue;
  if (!matchesConfiguredCounter(row, ctx)) continue;
  if (!matchesConfiguredProduct(row, ctx.productId)) continue;

  const status = normalizeStatus(row.status);
  const stagedRelease = ctx.stagedRelease === true;
  const releasePhase = toStr(row.releasePhase) === "daily" ? "daily" : "launch";
  const eventTs = status === "PAID"
    ? (toTs(row.paidAt) ?? toTs(row.updatedAt) ?? toTs(row.createdAt))
    : (toTs(row.createdAt) ?? toTs(row.updatedAt));
  if (status === "PAID") {
    if (stagedRelease) {
      stagedRows.push({ status, releasePhase, dailyDropDate: toStr(row.dailyDropDate), eventTs });
      if (releasePhase === "launch") {
        launchPaidCount += 1;
        if (eventTs != null) launchPaidTimestamps.push(eventTs);
      }
      continue;
    }
    paidCount += 1;
    continue;
  }
  if (status !== "PAYMENT_PENDING") continue;

  const expiresAtTs = toTs(row.expiresAt);
  const activePending = expiresAtTs == null || expiresAtTs > now;
  if (activePending) {
    if (stagedRelease) {
      stagedRows.push({ status, releasePhase, dailyDropDate: toStr(row.dailyDropDate), eventTs });
      continue;
    }
    reservedCount += 1;
  }
}

const stagedRelease = ctx.stagedRelease === true;
const launchLimit = Math.max(0, Math.floor(Number(ctx.launchLimit) || 0));
const dailyLimit = Math.max(0, Math.floor(Number(ctx.dailyLimit) || 0));
launchPaidTimestamps.sort((left, right) => left - right);
const launchComplete = stagedRelease && launchPaidCount >= launchLimit;
const launchCompletedAtTs = launchComplete && launchPaidTimestamps.length >= launchLimit
  ? launchPaidTimestamps[launchLimit - 1]
  : null;
const launchCompletedAt = launchCompletedAtTs == null ? null : new Date(launchCompletedAtTs).toISOString();
const dailyDropStartsAt = launchComplete ? resolveNextDailyDropAt(launchCompletedAtTs) : null;
const dailyDropActive = Boolean(dailyDropStartsAt && Date.parse(dailyDropStartsAt) <= now);
if (stagedRelease) {
  const dailyDropStartsAtTs = toTs(dailyDropStartsAt);
  launchPaidCount = launchComplete ? launchLimit : launchPaidCount;
  for (const row of stagedRows) {
    const isCurrentDailyDrop = row.releasePhase === "daily"
      ? row.dailyDropDate === toStr(ctx.dailyDropDate)
      : dailyDropStartsAtTs != null
        && row.eventTs != null
        && row.eventTs >= dailyDropStartsAtTs
        && resolveDailyDropDate(row.eventTs) === toStr(ctx.dailyDropDate);
    if (row.status === "PAID") {
      if (isCurrentDailyDrop) dailyPaidCount += 1;
      continue;
    }
    if (isCurrentDailyDrop) dailyReservedCount += 1;
    else if (row.releasePhase === "launch") launchReservedCount += 1;
  }
}
const releasePhase = stagedRelease
  ? (dailyDropActive ? "daily" : launchComplete ? "daily_pending" : "launch")
  : null;
if (stagedRelease) {
  paidCount = dailyDropActive ? dailyPaidCount : launchPaidCount;
  reservedCount = dailyDropActive ? dailyReservedCount : launchReservedCount;
}
const totalLimit = stagedRelease
  ? (dailyDropActive ? dailyLimit : launchLimit)
  : Math.max(0, Math.floor(Number(ctx.totalLimit) || 0));
const takenCount = paidCount + reservedCount;
const unlimited = ctx.unlimited === true;
const remainingCount = unlimited ? null : Math.max(totalLimit - takenCount, 0);

const regionalCounterKey = normalizeCounterKey(ctx.counterKey);
const regionalBindingLabel = REGIONAL_FRIENDSHIP_BINDING_LABELS[regionalCounterKey];
if (regionalBindingLabel) {
  const tiers = Array.isArray(ctx.tiers) ? ctx.tiers.filter((tier) => tier && typeof tier === "object") : [];
  const batchSize = Math.max(1, Math.floor(Number(ctx.batchSize) || 50));
  const batchIndex = Math.max(1, Math.min(tiers.length || 1, Math.floor(takenCount / batchSize) + 1));
  const activeTier = tiers[batchIndex - 1] || null;
  const takenInBatch = Math.max(0, takenCount - (batchIndex - 1) * batchSize);
  ctx.batchSize = batchSize;
  ctx.batchIndex = batchIndex;
  ctx.batchCount = tiers.length;
  ctx.batchRemainingBefore = remainingCount <= 0 ? 0 : Math.max(0, batchSize - takenInBatch);
  ctx.productId = toStr(activeTier?.productId);
  ctx.productName = toStr(activeTier?.productName);
  ctx.productCostMinor = Number.isFinite(Number(activeTier?.priceMinor))
    ? Math.max(0, Math.round(Number(activeTier.priceMinor)))
    : null;

  if (remainingCount > 0 && (!ctx.productId || ctx.productCostMinor == null)) {
    return failMsg(503, `Текущая ценовая партия ${regionalBindingLabel} ещё не подключена к оплате`, {
      counterKey: regionalCounterKey,
      batchIndex,
      batchSize,
      bindingReady: false,
    });
  }
}

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
    releasePhase,
    dailyDropActive,
    launchLimit,
    launchPaidCount,
    launchReservedCount,
    launchCompletedAt,
    dailyLimit,
    dailyDropDate: toStr(ctx.dailyDropDate),
    dailyDropStartsAt,
  });
}

ctx.releasePhase = releasePhase;
ctx.dailyDropActive = dailyDropActive;
ctx.totalLimit = totalLimit;
ctx.launchPaidCount = launchPaidCount;
ctx.launchReservedCount = launchReservedCount;
ctx.launchCompletedAt = launchCompletedAt;
ctx.dailyDropStartsAt = dailyDropStartsAt;
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
    batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
    batchSize: Math.max(0, Math.floor(Number(ctx.batchSize) || 0)),
    batchRemainingBefore: Math.max(0, Math.floor(Number(ctx.batchRemainingBefore) || 0)),
    releasePhase,
    dailyDropActive,
    launchPaidCount,
    launchReservedCount,
    launchCompletedAt,
    dailyDropDate: toStr(ctx.dailyDropDate),
    dailyDropStartsAt,
    vivaTimeoutMs: ctx.httpRequestTimeoutMs,
  },
});

return [msg, null, debugMsg];
