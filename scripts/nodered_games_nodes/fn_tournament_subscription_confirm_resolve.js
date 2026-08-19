const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const DEFAULT_RESERVATION_MINUTES = 30;
const DEFAULT_PLAN_KEY = "sport";
const AB_LETO_INVENTORY_ID = "ab_leto_2026_50_v1";
const AB_LETO_DAILY_DROP_START_HOUR = 10;
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set(["friendship", "ra"]);
const PLAN_DEFAULTS = {
  friendship: {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
  },
};
const DIRECT_COUNTER_DEFAULTS = {
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
  },
  energy5: {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
    productName: "Энергия-5",
  },
};
const SIRIUS_FRIENDSHIP_DEFAULTS = {
  counterKey: "sirius_friendship",
  saleType: "summer_campaign",
  planKey: "friendship",
  campaignKey: "summer_padel_sirius_friendship_2026",
};
const PITER_FRIENDSHIP_INVENTORY_ID = "piter_friendship_12m_2026_v1";

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

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "friendship" || normalized === "sport") return normalized;
  return null;
};

const normalizeCounterKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "academy"
    || normalized === "energy5"
    || normalized === "friendship"
    || normalized === "piter_friendship"
    || normalized === "ra"
    || normalized === "sirius_friendship"
    || normalized === "sport"
  ) {
    return normalized;
  }
  return null;
};

const readGlobalFirst = (keys) => {
  for (const key of keys) {
    const value = toStr(global.get(key));
    if (value) return value;
  }
  return null;
};

const resolveDailyDropDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const localDay = Date.UTC(year, month - 1, day);
  const dropDay = hour >= AB_LETO_DAILY_DROP_START_HOUR
    ? localDay
    : localDay - 24 * 60 * 60 * 1000;
  return new Date(dropDay).toISOString().slice(0, 10);
};

const readAbLetoInventoryId = (counterKey = null) => {
  const baseInventoryId = readGlobalFirst(["summer_subscription_inventory_id"])
    || AB_LETO_INVENTORY_ID;
  const normalizedCounterKey = String(counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(normalizedCounterKey)) {
    return baseInventoryId;
  }
  return `${baseInventoryId}_${normalizedCounterKey}_${resolveDailyDropDate()}`;
};

const readSummerPlanConfig = (planKey) => {
  const base = PLAN_DEFAULTS[planKey] || PLAN_DEFAULTS[DEFAULT_PLAN_KEY];
  if (planKey === "sport") {
    return {
      counterKey: "sport",
      inventoryId: readAbLetoInventoryId(planKey),
      saleType: "summer_campaign",
      planKey: "sport",
      campaignKey:
        readGlobalFirst(["summer_subscription_sport_campaign_key", "summer_subscription_campaign_key"])
        || base.campaignKey,
      productId:
        readGlobalFirst(["summer_subscription_sport_product_id", "summer_subscription_product_id"])
        || base.productId,
      productName:
        readGlobalFirst(["summer_subscription_sport_product_name", "summer_subscription_product_name"])
        || base.productName,
    };
  }
  return {
    counterKey: "friendship",
    inventoryId: readAbLetoInventoryId(planKey),
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey:
      readGlobalFirst(["summer_subscription_friendship_campaign_key"])
      || base.campaignKey,
    productId:
      readGlobalFirst(["summer_subscription_friendship_product_id"])
      || base.productId,
    productName:
      readGlobalFirst(["summer_subscription_friendship_product_name"])
      || base.productName,
  };
};

const readSiriusFriendshipConfig = (friendshipPlan) => ({
  counterKey: "sirius_friendship",
  inventoryId: null,
  saleType: "summer_campaign",
  planKey: "friendship",
  campaignKey:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_campaign_key",
      "summer_subscription_friendship_sirius_campaign_key",
    ])
    || SIRIUS_FRIENDSHIP_DEFAULTS.campaignKey,
  productId:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_id",
      "summer_subscription_friendship_sirius_product_id",
    ])
    || friendshipPlan.productId,
  productName:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_name",
      "summer_subscription_friendship_sirius_product_name",
    ])
    || friendshipPlan.productName,
});

const readDirectCounterConfig = (counterKey) => {
  const base = DIRECT_COUNTER_DEFAULTS[counterKey];
  if (!base) return null;
  return {
    counterKey,
    inventoryId: readAbLetoInventoryId(counterKey),
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId:
      readGlobalFirst([`summer_subscription_${counterKey}_product_id`])
      || base.productId,
    productName:
      readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
      || base.productName,
    unlimited: counterKey === "academy" || counterKey === "energy5",
  };
};

const readPiterFriendshipConfig = () => ({
  counterKey: "piter_friendship",
  inventoryId: readGlobalFirst(["summer_subscription_piter_friendship_inventory_id"])
    || PITER_FRIENDSHIP_INVENTORY_ID,
  saleType: "tiered_direct_product",
  planKey: null,
  campaignKey: null,
  productId: null,
  productName: "Падел.Дружба.Питер",
  unlimited: false,
});

const buildCounterConfigMap = () => {
  const friendship = readSummerPlanConfig("friendship");
  return {
    academy: readDirectCounterConfig("academy"),
    energy5: readDirectCounterConfig("energy5"),
    friendship,
    piter_friendship: readPiterFriendshipConfig(),
    ra: readDirectCounterConfig("ra"),
    sirius_friendship: readSiriusFriendshipConfig(friendship),
    sport: readSummerPlanConfig("sport"),
  };
};

const resolveHttpTimeoutMs = () => {
  const raw = toInt(global.get("summer_subscription_http_timeout_ms"), 20000);
  return Math.max(3000, Math.min(120000, raw));
};

const resolveReservationMinutes = () => {
  const raw = toInt(global.get("summer_subscription_reservation_minutes"), DEFAULT_RESERVATION_MINUTES);
  return Math.max(5, Math.min(360, raw));
};

const failMsg = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [null, response, response];
};

const resolveCounterFromRecord = (record, configMap) => {
  const recordCounterKey = normalizeCounterKey(record?.counterKey);
  if (recordCounterKey && configMap[recordCounterKey]) {
    return configMap[recordCounterKey];
  }

  const recordCampaignKey = toStr(record?.campaignKey);
  if (recordCampaignKey) {
    const byCampaign = Object.values(configMap).find((counter) => toStr(counter?.campaignKey) === recordCampaignKey);
    if (byCampaign) return byCampaign;
  }

  const recordProductId = toStr(record?.productId);
  if (recordProductId) {
    const byProduct = Object.values(configMap).find((counter) => toStr(counter?.productId) === recordProductId);
    if (byProduct) return byProduct;
  }

  const recordPlanKey = normalizePlanKey(record?.planKey);
  if (recordPlanKey === "friendship") return configMap.friendship;
  if (recordPlanKey === "sport") return configMap.sport;
  return null;
};

const scoreRecord = (record, ctx, configMap) => {
  let score = 0;
  const recordCounter = resolveCounterFromRecord(record, configMap);
  const recordCounterKey = toStr(recordCounter?.counterKey) || normalizeCounterKey(record?.counterKey);
  const recordInventoryId = toStr(record?.inventoryId);
  const recordCampaignKey = toStr(record?.campaignKey);
  const recordPlanKey = normalizePlanKey(record?.planKey);
  const recordProductId = toStr(record?.productId);

  if (recordCounterKey && recordCounterKey === normalizeCounterKey(ctx.counterKey)) score += 500;
  if (recordInventoryId && recordInventoryId === toStr(ctx.inventoryId)) score += 600;
  if (recordCampaignKey && recordCampaignKey === toStr(ctx.campaignKey)) score += 400;
  if (recordPlanKey && recordPlanKey === normalizePlanKey(ctx.planKey)) score += 250;
  if (recordProductId && recordProductId === toStr(ctx.productId)) score += 200;
  score += toTs(record?.updatedAt) ?? toTs(record?.createdAt) ?? 0;
  return score;
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "confirm") {
  return failMsg(500, "Summer subscription confirm context is missing");
}

const configMap = buildCounterConfigMap();
const docs = rows
  .filter((item) => item && typeof item === "object")
  .sort((left, right) => scoreRecord(right, ctx, configMap) - scoreRecord(left, ctx, configMap));

const record = docs[0] || null;
if (!record) {
  return failMsg(404, "Платеж не найден", {
    counterKey: ctx.counterKey || null,
    campaignKey: ctx.campaignKey || null,
    paymentRef: ctx.paymentRef,
  });
}

const recordCounter = resolveCounterFromRecord(record, configMap);
ctx.counterKey = toStr(ctx.counterKey) || toStr(recordCounter?.counterKey) || normalizeCounterKey(record.counterKey);
ctx.inventoryId = toStr(record.inventoryId) || toStr(ctx.inventoryId) || toStr(recordCounter?.inventoryId) || null;
ctx.saleType = toStr(ctx.saleType) || toStr(recordCounter?.saleType) || null;
ctx.campaignKey = toStr(ctx.campaignKey) || toStr(record.campaignKey) || toStr(recordCounter?.campaignKey) || null;
ctx.planKey = normalizePlanKey(ctx.planKey) || normalizePlanKey(record.planKey) || normalizePlanKey(recordCounter?.planKey);
ctx.transactionId = toStr(record.transactionId) || null;
ctx.clientPhone = toStr(record.clientPhone) || null;
ctx.clientId = toStr(record.clientId) || null;
ctx.productId = toStr(record.productId) || toStr(recordCounter?.productId) || null;
ctx.productName = toStr(record.productName) || toStr(recordCounter?.productName) || null;
ctx.toPayMinor = Number.isFinite(Number(record.toPayMinor)) ? Number(record.toPayMinor) : null;
ctx.unlimited = record.unlimited === true || recordCounter?.unlimited === true;
ctx.reservationMinutes = resolveReservationMinutes();
ctx.httpRequestTimeoutMs = resolveHttpTimeoutMs();

const currentStatus = String(record.status || "").trim().toUpperCase();
if (currentStatus === "PAID" && ctx.reconcile !== true) {
  const response = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: normalizePlanKey(ctx.planKey),
      planType: normalizePlanKey(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      status: "PAID",
      paid: true,
      updatedAt: toStr(record.updatedAt) || toStr(record.createdAt) || new Date().toISOString(),
    },
  });
  return [null, response, response];
}

if (!ctx.transactionId) {
  const response = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: true,
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      planKey: normalizePlanKey(ctx.planKey),
      planType: normalizePlanKey(ctx.planKey),
      campaignKey: ctx.campaignKey,
      paymentRef: ctx.paymentRef,
      transactionId: null,
      status: currentStatus || "PAYMENT_PENDING",
      paid: false,
      updatedAt: new Date().toISOString(),
    },
  });
  return [null, response, response];
}

ctx.step = "token_confirm";
msg._summerSubscriptionCtx = ctx;

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "confirm_resolve_record",
    counterKey: toStr(ctx.counterKey),
    planKey: normalizePlanKey(ctx.planKey),
    campaignKey: ctx.campaignKey,
    paymentRef: ctx.paymentRef,
    transactionId: ctx.transactionId,
    vivaTimeoutMs: ctx.httpRequestTimeoutMs,
  },
});

return [msg, null, debugMsg];
