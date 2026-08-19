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
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
  },
};
const DIRECT_COUNTER_DEFAULTS = {
  energy5: {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
  },
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
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
  };
};

const readSiriusFriendshipConfig = () => ({
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
});

const buildCounterConfigMap = () => {
  return {
    academy: readDirectCounterConfig("academy"),
    energy5: readDirectCounterConfig("energy5"),
    friendship: readSummerPlanConfig("friendship"),
    piter_friendship: readPiterFriendshipConfig(),
    ra: readDirectCounterConfig("ra"),
    sirius_friendship: readSiriusFriendshipConfig(),
    sport: readSummerPlanConfig("sport"),
  };
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const paymentRef = toStr(body.paymentRef || body.ref || query.paymentRef || query.ref || query.summerPaymentRef);
if (!paymentRef) {
  return fail(400, "paymentRef is required");
}

const requestedCounterRaw = toStr(body.counterKey || body.statusKey || query.counterKey || query.statusKey);
const requestedCounterKey = normalizeCounterKey(requestedCounterRaw);
if (requestedCounterRaw && !requestedCounterKey) {
  return fail(400, "Unsupported counterKey", { counterKey: requestedCounterRaw });
}

const requestedPlanRaw = toStr(body.planKey || body.plan || body.planType || body.tariff || query.planKey || query.plan);
const requestedPlanKey = normalizePlanKey(requestedPlanRaw);
if (requestedPlanRaw && !requestedPlanKey) {
  return fail(400, "Unsupported planKey", { planKey: requestedPlanRaw });
}
const requestedCampaignKey = toStr(body.campaignKey || query.campaignKey);

const configMap = buildCounterConfigMap();
const configByCampaign = {};
Object.values(configMap).forEach((counter) => {
  const campaignKey = toStr(counter?.campaignKey);
  if (campaignKey) {
    configByCampaign[campaignKey] = counter;
  }
});

let activeCounter = null;
let campaignKeyInputIgnored = false;
let campaignKeyInputReason = null;

if (requestedCounterKey) {
  activeCounter = configMap[requestedCounterKey] || null;
  if (!activeCounter) {
    return fail(400, "Unsupported counterKey", { counterKey: requestedCounterKey });
  }
  if (requestedCampaignKey && activeCounter.saleType === "summer_campaign" && requestedCampaignKey !== activeCounter.campaignKey) {
    campaignKeyInputIgnored = true;
    campaignKeyInputReason = "counter_and_campaign_conflict";
  }
} else if (requestedPlanKey) {
  activeCounter = requestedPlanKey === "friendship" ? configMap.friendship : configMap.sport;
  if (requestedCampaignKey) {
    const mappedByCampaign = configByCampaign[requestedCampaignKey] || null;
    if (!mappedByCampaign) {
      campaignKeyInputIgnored = true;
      campaignKeyInputReason = "unsupported_campaign_for_explicit_plan";
    } else if (mappedByCampaign.planKey !== activeCounter.planKey) {
      campaignKeyInputIgnored = true;
      campaignKeyInputReason = "plan_and_campaign_conflict";
    } else {
      activeCounter = mappedByCampaign;
    }
  }
} else if (requestedCampaignKey) {
  activeCounter = configByCampaign[requestedCampaignKey] || null;
  if (!activeCounter) {
    return fail(400, "Unsupported campaignKey", { campaignKey: requestedCampaignKey });
  }
}

msg._summerSubscriptionCtx = {
  action: "confirm",
  step: "resolve_record",
  counterKey: toStr(activeCounter?.counterKey),
  inventoryId: toStr(activeCounter?.inventoryId),
  saleType: toStr(activeCounter?.saleType),
  planKey: normalizePlanKey(activeCounter?.planKey),
  campaignKey: toStr(activeCounter?.campaignKey) || requestedCampaignKey || null,
  productId: toStr(activeCounter?.productId),
  paymentRef,
};

const dbMsg = Object.assign({}, msg, { query: { paymentRef } });

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "confirm_prepare",
    counterKey: toStr(activeCounter?.counterKey),
    inventoryId: toStr(activeCounter?.inventoryId),
    planKey: normalizePlanKey(activeCounter?.planKey),
    campaignKey: toStr(activeCounter?.campaignKey) || requestedCampaignKey || null,
    campaignKeyInput: requestedCampaignKey,
    campaignKeyInputIgnored,
    campaignKeyInputReason,
    paymentRef,
  },
});

return [dbMsg, null, debugMsg];
