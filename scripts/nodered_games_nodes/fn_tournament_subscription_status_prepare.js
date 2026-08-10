const DEFAULT_TOTAL_LIMIT = 100;
const MAX_TOTAL_LIMIT = 1000;
const SIRIUS_FRIENDSHIP_DEFAULT_LIMIT = 100;
const AB_LETO_INVENTORY_ID = "ab_leto_2026_50_v1";
const AB_LETO_DAILY_DROP_LIMIT = 5;
const AB_LETO_DAILY_DROP_START_HOUR = 10;
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set(["friendship", "ra"]);
const AB_LETO_STAGED_RELEASE_START_DATE = "2026-08-01";
const AB_LETO_STAGED_INVENTORY_ID = "ab_leto_2026_100_then_7_v1";
const AB_LETO_STAGED_LAUNCH_LIMIT = 100;
const AB_LETO_STAGED_DAILY_DROP_LIMIT = 7;

const DEFAULT_VISIBLE_COUNTER_KEYS = ["friendship", "sport", "academy", "ra", "energy5"];
const AB_LETO_TOTAL_LIMIT_DEFAULTS = {
  academy: 125,
  friendship: AB_LETO_DAILY_DROP_LIMIT,
  ra: AB_LETO_DAILY_DROP_LIMIT,
  sport: 132,
};
const DEFAULT_PLAN_KEY = "sport";
const PLAN_DEFAULTS = {
  friendship: {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productName: "Лето.Падел.Дружба",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productName: "Лето.Падел.Спорт",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
  },
};
const DIRECT_COUNTER_DEFAULTS = {
  energy5: {
    counterKey: "energy5",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Энергия-5",
    productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
  },
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.Академия",
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.РА",
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
  },
};
const MANUAL_PAID_COUNT_DEFAULTS = {
  academy: 4,
  ra: 37,
  sport: 38,
};
const SIRIUS_FRIENDSHIP_DEFAULTS = {
  counterKey: "sirius_friendship",
  saleType: "summer_campaign",
  planKey: "friendship",
  campaignKey: "summer_padel_sirius_friendship_2026",
};

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

const resolveMoscowDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AB_LETO_DAILY_DROP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
};

const isAbLetoStagedReleaseActive = (now = new Date(Date.now())) => (
  resolveMoscowDate(now) >= AB_LETO_STAGED_RELEASE_START_DATE
);

const readAbLetoInventoryId = (counterKey = null) => {
  const baseInventoryId = readGlobalFirst(["summer_subscription_inventory_id"])
    || AB_LETO_INVENTORY_ID;
  const normalizedCounterKey = String(counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(normalizedCounterKey)) {
    return baseInventoryId;
  }
  if (isAbLetoStagedReleaseActive()) {
    return `${AB_LETO_STAGED_INVENTORY_ID}_${normalizedCounterKey}`;
  }
  return `${baseInventoryId}_${normalizedCounterKey}_${resolveDailyDropDate()}`;
};

const withAbLetoStagedRelease = (counter) => {
  const counterKey = String(counter?.counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(counterKey) || !isAbLetoStagedReleaseActive()) {
    return counter;
  }
  return Object.assign({}, counter, {
    stagedRelease: true,
    releaseStartDate: AB_LETO_STAGED_RELEASE_START_DATE,
    launchLimit: AB_LETO_STAGED_LAUNCH_LIMIT,
    dailyLimit: AB_LETO_STAGED_DAILY_DROP_LIMIT,
    dailyDropDate: resolveDailyDropDate(),
    totalLimit: AB_LETO_STAGED_LAUNCH_LIMIT,
  });
};

const toPlanLimit = (value, fallback = DEFAULT_TOTAL_LIMIT) => {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  const limit = Math.floor(parsed);
  if (limit <= 0) return fallback;
  return Math.min(limit, MAX_TOTAL_LIMIT);
};

const getDefaultTotalLimit = (counterKey) => (
  AB_LETO_TOTAL_LIMIT_DEFAULTS[counterKey] || DEFAULT_TOTAL_LIMIT
);

const toNonNegativeInt = (value, fallback = 0) => {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
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
  return toNonNegativeInt(
    global.get(`summer_subscription_${normalized}_manual_paid_count`),
    MANUAL_PAID_COUNT_DEFAULTS[normalized] || 0,
  );
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
      productName:
        readGlobalFirst(["summer_subscription_sport_product_name", "summer_subscription_product_name"])
        || base.productName,
      productId:
        readGlobalFirst(["summer_subscription_sport_product_id", "summer_subscription_product_id"])
        || base.productId,
      manualPaidCount: 0,
      totalLimit: toPlanLimit(
        global.get("summer_subscription_sport_limit"),
        getDefaultTotalLimit("sport"),
      ),
    };
  }

  return withAbLetoStagedRelease({
    counterKey: "friendship",
    inventoryId: readAbLetoInventoryId(planKey),
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey:
      readGlobalFirst(["summer_subscription_friendship_campaign_key"])
      || base.campaignKey,
    productName:
      readGlobalFirst(["summer_subscription_friendship_product_name"])
      || base.productName,
    productId:
      readGlobalFirst(["summer_subscription_friendship_product_id"])
      || base.productId,
    manualPaidCount: 0,
    totalLimit: toPlanLimit(global.get("summer_subscription_friendship_limit"), getDefaultTotalLimit("friendship")),
  });
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
  productName:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_name",
      "summer_subscription_friendship_sirius_product_name",
    ])
    || friendshipPlan.productName,
  productId:
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_id",
      "summer_subscription_friendship_sirius_product_id",
    ])
    || friendshipPlan.productId,
  manualPaidCount: readManualPaidCount("sirius_friendship"),
  totalLimit: toPlanLimit(
    readGlobalFirst([
      "summer_subscription_sirius_friendship_limit",
      "summer_subscription_friendship_sirius_limit",
    ]),
    SIRIUS_FRIENDSHIP_DEFAULT_LIMIT,
  ),
});

const readDirectCounterConfig = (counterKey) => {
  const base = DIRECT_COUNTER_DEFAULTS[counterKey];
  if (!base) return null;
  const unlimited = counterKey === "academy" || counterKey === "energy5";
  return withAbLetoStagedRelease({
    counterKey,
    inventoryId: readAbLetoInventoryId(counterKey),
    unlimited,
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName:
      readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
      || base.productName,
    productId:
      readGlobalFirst([`summer_subscription_${counterKey}_product_id`])
      || base.productId,
    manualPaidCount: 0,
    totalLimit: unlimited
      ? 0
      : toPlanLimit(global.get(`summer_subscription_${counterKey}_limit`), getDefaultTotalLimit(counterKey)),
  });
};

const buildCounterConfigMap = () => {
  const friendship = readSummerPlanConfig("friendship");
  const sport = readSummerPlanConfig("sport");
  const siriusFriendship = readSiriusFriendshipConfig(friendship);
  const academy = readDirectCounterConfig("academy");
  const energy5 = readDirectCounterConfig("energy5");
  const ra = readDirectCounterConfig("ra");

  return {
    academy,
    energy5,
    friendship,
    ra,
    sirius_friendship: siriusFriendship,
    sport,
  };
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const requestedCounterRaw = toStr(query.counterKey || query.statusKey);
const requestedCounterKey = normalizeCounterKey(requestedCounterRaw);
if (requestedCounterRaw && !requestedCounterKey) {
  return fail(400, "Unsupported counterKey", { counterKey: requestedCounterRaw });
}

const requestedPlanRaw = toStr(query.planKey || query.plan);
const requestedPlanKey = normalizePlanKey(requestedPlanRaw);
if (requestedPlanRaw && !requestedPlanKey) {
  return fail(400, "Unsupported planKey", { planKey: requestedPlanRaw });
}

const requestedCampaignKey = toStr(query.campaignKey);
const configMap = buildCounterConfigMap();

const configByCampaign = {};
for (const counter of Object.values(configMap)) {
  if (!counter || !counter.campaignKey) continue;
  configByCampaign[counter.campaignKey] = counter;
}

let singleCounter = false;
let activeCounter = configMap.sport;
let campaignKeyInputIgnored = false;
let campaignKeyInputReason = null;

if (requestedCounterKey) {
  const mappedByCounter = configMap[requestedCounterKey] || null;
  if (!mappedByCounter) {
    return fail(400, "Unsupported counterKey", { counterKey: requestedCounterKey });
  }
  activeCounter = mappedByCounter;
  singleCounter = true;
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
  singleCounter = true;
} else if (requestedCampaignKey) {
  const mappedByCampaign = configByCampaign[requestedCampaignKey] || null;
  if (!mappedByCampaign) {
    return fail(400, "Unsupported campaignKey", { campaignKey: requestedCampaignKey });
  }
  activeCounter = mappedByCampaign;
  singleCounter = true;
}

const counters = singleCounter
  ? [activeCounter]
  : DEFAULT_VISIBLE_COUNTER_KEYS
    .map((counterKey) => configMap[counterKey])
    .filter((counter) => Boolean(counter));

msg._summerSubscriptionCtx = {
  action: "status",
  counters,
  plans: counters,
  singleCounter,
  activeCounter,
  selectedCounterKey: activeCounter.counterKey,
  selectedPlanKey: activeCounter.planKey,
  selectedCampaignKey: activeCounter.campaignKey,
  nowIso: new Date().toISOString(),
};

const buildCounterQuery = (counter) => {
  if (!counter || typeof counter !== "object") return null;

  const inventoryId = toStr(counter.inventoryId);
  const counterKey = normalizeCounterKey(counter.counterKey);
  if (inventoryId && counterKey) {
    return { inventoryId, counterKey };
  }

  if (counter.saleType === "summer_campaign") {
    const campaignKey = toStr(counter.campaignKey);
    return campaignKey ? { campaignKey } : null;
  }

  const directClauses = [
    counter.counterKey ? { counterKey: counter.counterKey } : null,
    counter.productId ? { productId: counter.productId } : null,
  ].filter((value) => Boolean(value));

  if (directClauses.length === 0) return null;
  if (directClauses.length === 1) return directClauses[0];
  return { $or: directClauses };
};

const queryClauses = counters
  .map((counter) => buildCounterQuery(counter))
  .filter((value) => Boolean(value));

const resolvedQuery = queryClauses.length <= 1
  ? (queryClauses[0] || {})
  : { $or: queryClauses };

const dbMsg = Object.assign({}, msg, {
  query: resolvedQuery,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_prepare",
    mode: singleCounter ? "single" : "aggregate",
    selectedCounterKey: activeCounter.counterKey,
    selectedPlanKey: activeCounter.planKey,
    selectedCampaignKey: activeCounter.campaignKey,
    campaignKeyInput: requestedCampaignKey,
    campaignKeyInputIgnored,
    campaignKeyInputReason,
    counters: counters.map((counter) => ({
      counterKey: counter.counterKey,
      inventoryId: counter.inventoryId,
      planKey: counter.planKey,
      campaignKey: counter.campaignKey,
      productId: counter.productId,
      productName: counter.productName,
      totalLimit: counter.totalLimit,
    })),
  },
});

return [dbMsg, null, debugMsg];
