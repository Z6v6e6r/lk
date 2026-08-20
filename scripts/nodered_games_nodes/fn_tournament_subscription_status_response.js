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
const AB_LETO_STAGED_RA_DAILY_DROP_LIMIT = 10;
const DEFAULT_PLAN_KEY = "sport";
const DEFAULT_VISIBLE_COUNTER_KEYS = ["friendship", "sport", "academy", "ra", "energy5"];
const AB_LETO_TOTAL_LIMIT_DEFAULTS = {
  academy: 125,
  friendship: AB_LETO_DAILY_DROP_LIMIT,
  ra: AB_LETO_DAILY_DROP_LIMIT,
  sport: 132,
};
const PLAN_DEFAULTS = {
  friendship: {
    counterKey: "friendship",
    saleType: "summer_campaign",
    planKey: "friendship",
    campaignKey: "summer_padel_friendship_2026",
    productName: "Лето.Падел.Дружба",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productCostMinor: 980000,
  },
  sport: {
    counterKey: "sport",
    saleType: "summer_campaign",
    planKey: "sport",
    campaignKey: "summer_padel_sport_2026",
    productName: "Лето.Падел.Спорт",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productCostMinor: 1980000,
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
    productCostMinor: 1980000,
  },
  academy: {
    counterKey: "academy",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.Академия",
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productCostMinor: 2380000,
  },
  ra: {
    counterKey: "ra",
    saleType: "direct_product",
    planKey: null,
    campaignKey: null,
    productName: "Лето.Падел.РА",
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productCostMinor: 2380000,
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
const REGIONAL_FRIENDSHIP_CONFIGS = {
  kotelniki_friendship: {
    inventoryId: "kotelniki_friendship_12m_2026_v1",
    batchSize: 50,
    tierPricesMinor: [1980000, 2380000, 3680000, 5680000],
    productName: "Падел.Дружба.Котельники",
    bindingLabel: "Котельники",
    launchEnabled: false,
    providerProductId: null,
    providerProductCostMinor: null,
  },
  network_friendship: {
    inventoryId: "network_friendship_12m_2026_v1",
    batchSize: 50,
    tierPricesMinor: [5680000],
    productName: "Падел.Дружба.ХАБ",
    bindingLabel: "ХАБ",
    launchEnabled: true,
    providerProductId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
    providerProductName: "Падел.Дружба.ХАБ — годовая",
    providerProductCostMinor: 5680000,
  },
  piter_friendship: {
    inventoryId: "piter_friendship_12m_2026_v1",
    batchSize: 100,
    tierPricesMinor: [1980000, 2380000, 3680000, 5680000],
    productName: "Падел.Дружба.Питер",
    bindingLabel: "Питер",
    launchEnabled: true,
    providerProductId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    providerProductName: "Падел.Дружба.Питер — годовая",
    providerProductCostMinor: 5680000,
  },
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
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const toMoneyMinor = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.round(parsed));
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

const toBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
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
  return toInt(
    global.get(`summer_subscription_${normalized}_manual_paid_count`),
    MANUAL_PAID_COUNT_DEFAULTS[normalized] || 0,
  );
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
    dailyLimit: counterKey === "ra"
      ? AB_LETO_STAGED_RA_DAILY_DROP_LIMIT
      : AB_LETO_STAGED_DAILY_DROP_LIMIT,
    dailyDropDate: resolveDailyDropDate(),
    totalLimit: AB_LETO_STAGED_LAUNCH_LIMIT,
  });
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
      productCostMinor: toMoneyMinor(
        global.get("summer_subscription_sport_product_cost_minor")
          ?? global.get("summer_subscription_product_cost_minor"),
        base.productCostMinor,
      ),
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
    productCostMinor: toMoneyMinor(
      global.get("summer_subscription_friendship_product_cost_minor"),
      base.productCostMinor,
    ),
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
  productCostMinor: toMoneyMinor(
    readGlobalFirst([
      "summer_subscription_sirius_friendship_product_cost_minor",
      "summer_subscription_friendship_sirius_product_cost_minor",
    ]),
    friendshipPlan.productCostMinor,
  ),
  manualPaidCount: readManualPaidCount("sirius_friendship"),
  totalLimit: toPlanLimit(
    readGlobalFirst([
      "summer_subscription_sirius_friendship_limit",
      "summer_subscription_friendship_sirius_limit",
    ]),
    SIRIUS_FRIENDSHIP_DEFAULT_LIMIT,
  ),
});

const readRegionalFriendshipConfig = (counterKey) => {
  const regional = REGIONAL_FRIENDSHIP_CONFIGS[counterKey];
  if (!regional) return null;
  const providerProductId = regional.launchEnabled
    ? readGlobalFirst([`summer_subscription_${counterKey}_product_id`]) || regional.providerProductId
    : null;
  const providerProductName = readGlobalFirst([`summer_subscription_${counterKey}_product_name`])
    || regional.providerProductName
    || regional.productName;
  const providerProductCostMinor = toMoneyMinor(
    global.get(`summer_subscription_${counterKey}_product_cost_minor`),
    regional.providerProductCostMinor,
  );
  const tiers = regional.tierPricesMinor.map((priceMinor, index) => {
    const tierNumber = index + 1;
    return {
      batchIndex: tierNumber,
      batchSize: regional.batchSize,
      priceMinor,
      productId: regional.launchEnabled
        ? readGlobalFirst([`summer_subscription_${counterKey}_tier_${tierNumber}_product_id`]) || providerProductId
        : null,
      productName: readGlobalFirst([`summer_subscription_${counterKey}_tier_${tierNumber}_product_name`])
        || providerProductName,
      providerProductCostMinor,
    };
  });
  return {
    counterKey,
    inventoryId: readGlobalFirst([`summer_subscription_${counterKey}_inventory_id`])
      || regional.inventoryId,
    saleType: "tiered_direct_product",
    planKey: null,
    campaignKey: null,
    productId: null,
    productName: tiers[0].productName,
    productCostMinor: providerProductCostMinor,
    manualPaidCount: 0,
    totalLimit: regional.batchSize * tiers.length,
    batchSize: regional.batchSize,
    tiers,
  };
};

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
    productCostMinor: toMoneyMinor(
      global.get(`summer_subscription_${counterKey}_product_cost_minor`),
      base.productCostMinor,
    ),
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
  const kotelnikiFriendship = readRegionalFriendshipConfig("kotelniki_friendship");
  const networkFriendship = readRegionalFriendshipConfig("network_friendship");
  const piterFriendship = readRegionalFriendshipConfig("piter_friendship");

  return {
    academy,
    energy5,
    friendship,
    kotelniki_friendship: kotelnikiFriendship,
    network_friendship: networkFriendship,
    piter_friendship: piterFriendship,
    ra,
    sirius_friendship: siriusFriendship,
    sport,
  };
};

const createCounterState = (counter) => {
  const totalLimit = Math.max(0, Math.floor(Number(counter?.totalLimit) || 0));
  const productCostMinor = Number(counter?.productCostMinor);
  const priceMinor = Number.isFinite(productCostMinor) ? Math.max(0, Math.round(productCostMinor)) : null;
  const configuredManualPaidCount = Number(counter?.manualPaidCount);
  const manualPaidCount = Number.isFinite(configuredManualPaidCount)
    ? Math.max(0, Math.floor(configuredManualPaidCount))
    : readManualPaidCount(counter?.counterKey);
  return {
    counterKey: toStr(counter?.counterKey),
    inventoryId: toStr(counter?.inventoryId),
    unlimited: counter?.unlimited === true,
    saleType: toStr(counter?.saleType),
    planKey: normalizePlanKey(counter?.planKey),
    campaignKey: toStr(counter?.campaignKey),
    productId: toStr(counter?.productId),
    productName: toStr(counter?.productName),
    stagedRelease: counter?.stagedRelease === true,
    releaseStartDate: toStr(counter?.releaseStartDate),
    releasePhase: null,
    dailyDropActive: false,
    launchLimit: Math.max(0, Math.floor(Number(counter?.launchLimit) || 0)),
    launchPaidCount: 0,
    launchReservedCount: 0,
    launchRemainingCount: 0,
    launchCompletedAt: null,
    dailyLimit: Math.max(0, Math.floor(Number(counter?.dailyLimit) || 0)),
    dailyDropDate: toStr(counter?.dailyDropDate),
    dailyDropStartsAt: null,
    totalLimit,
    paidCount: manualPaidCount,
    reservedCount: 0,
    takenCount: manualPaidCount,
    remainingCount: Math.max(totalLimit - manualPaidCount, 0),
    canPurchase: counter?.unlimited === true || totalLimit - manualPaidCount > 0,
    bindingReady: true,
    bindingError: null,
    batchSize: Math.max(0, Math.floor(Number(counter?.batchSize) || 0)),
    batchIndex: 0,
    batchCount: Array.isArray(counter?.tiers) ? counter.tiers.length : 0,
    batchRemainingCount: 0,
    _tiers: Array.isArray(counter?.tiers) ? counter.tiers : [],
    providerProductCostMinor: null,
    discountMinor: null,
    priceMinor,
    price: priceMinor == null ? null : priceMinor / 100,
    updatedAt: null,
    _lastUpdatedAtTs: null,
    _dailyPaidCount: 0,
    _dailyReservedCount: 0,
    _launchPaidTimestamps: [],
    _stagedRows: [],
  };
};

const matchesConfiguredProduct = (doc, configuredProductId) => {
  const expectedProductId = toStr(configuredProductId);
  if (!expectedProductId || !doc || typeof doc !== "object") return true;

  const docProductId = toStr(doc.productId);
  if (!docProductId) return true;
  return docProductId === expectedProductId;
};

const matchesCounterRecord = (doc, counter) => {
  if (!doc || typeof doc !== "object" || !counter || typeof counter !== "object") return false;

  const inventoryId = toStr(counter.inventoryId);
  if (inventoryId) {
    return toStr(doc.inventoryId) === inventoryId
      && normalizeCounterKey(doc.counterKey) === normalizeCounterKey(counter.counterKey);
  }
  if (!matchesConfiguredProduct(doc, counter.productId)) return false;

  const rowCounterKey = normalizeCounterKey(doc.counterKey);
  const rowCampaignKey = toStr(doc.campaignKey);
  const rowProductId = toStr(doc.productId);

  if (counter.saleType === "summer_campaign") {
    if (rowCampaignKey && rowCampaignKey === toStr(counter.campaignKey)) {
      return true;
    }
    return rowCounterKey === normalizeCounterKey(counter.counterKey);
  }

  if (rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey)) {
    return true;
  }
  return Boolean(rowProductId && rowProductId === toStr(counter.productId));
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : {};
const configMap = buildCounterConfigMap();
const configuredCounters = Array.isArray(ctx.counters) && ctx.counters.length > 0
  ? ctx.counters
  : Array.isArray(ctx.plans) && ctx.plans.length > 0
    ? ctx.plans
  : DEFAULT_VISIBLE_COUNTER_KEYS
    .map((counterKey) => configMap[counterKey])
    .filter((counter) => Boolean(counter));

const statesByCounterKey = {};
const countersOrder = [];
configuredCounters.forEach((counter) => {
  const counterKey = normalizeCounterKey(counter?.counterKey);
  if (!counterKey || statesByCounterKey[counterKey]) return;
  statesByCounterKey[counterKey] = createCounterState(counter);
  countersOrder.push(counterKey);
});

if (countersOrder.length === 0) {
  DEFAULT_VISIBLE_COUNTER_KEYS.forEach((counterKey) => {
    const fallbackCounter = configMap[counterKey];
    if (!fallbackCounter || statesByCounterKey[counterKey]) return;
    statesByCounterKey[counterKey] = createCounterState(fallbackCounter);
    countersOrder.push(counterKey);
  });
}

const singleCounter = ctx.singleCounter === true;
const selectedCounterFromPlan = (() => {
  const planKey = normalizePlanKey(ctx.selectedPlanKey);
  if (planKey === "sport") return "sport";
  if (planKey === "friendship") {
    return toStr(ctx.selectedCampaignKey) === toStr(configMap.sirius_friendship?.campaignKey)
      ? "sirius_friendship"
      : "friendship";
  }
  return null;
})();
const selectedCounterKey = normalizeCounterKey(ctx.selectedCounterKey)
  || selectedCounterFromPlan
  || countersOrder[0]
  || "sport";
const now = Date.now();
const docs = rows.filter((item) => item && typeof item === "object");

for (const doc of docs) {
  const matchedCounterKey = countersOrder.find((counterKey) => {
    const state = statesByCounterKey[counterKey];
    return matchesCounterRecord(doc, state);
  });
  if (!matchedCounterKey) continue;

  const state = statesByCounterKey[matchedCounterKey];
  const status = normalizeStatus(doc.status);
  const releasePhase = toStr(doc.releasePhase) === "daily" ? "daily" : "launch";
  const expiresAtTs = toTs(doc.expiresAt);
  const eventTs = status === "PAID"
    ? (toTs(doc.paidAt) ?? toTs(doc.updatedAt) ?? toTs(doc.createdAt))
    : (toTs(doc.createdAt) ?? toTs(doc.updatedAt));
  const updatedAtTs = toTs(doc.updatedAt) ?? toTs(doc.createdAt);
  if (updatedAtTs != null) {
    if (state._lastUpdatedAtTs == null || updatedAtTs > state._lastUpdatedAtTs) {
      state._lastUpdatedAtTs = updatedAtTs;
    }
  }

  if (!state.campaignKey) state.campaignKey = toStr(doc.campaignKey);
  if (!state.planKey) state.planKey = normalizePlanKey(doc.planKey);
  if (!state.productId) state.productId = toStr(doc.productId);
  if (!state.productName) state.productName = toStr(doc.productName);

  if (state.priceMinor == null) {
    const amountMinor = Number(doc.amountMinor);
    if (Number.isFinite(amountMinor) && amountMinor >= 0) {
      state.priceMinor = Math.max(0, Math.round(amountMinor));
      state.price = state.priceMinor / 100;
    }
  }

  if (status === "PAID") {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      if (releasePhase === "launch") {
        state.launchPaidCount += 1;
        if (eventTs != null) state._launchPaidTimestamps.push(eventTs);
      }
      continue;
    }
    state.paidCount += 1;
    continue;
  }

  const isPending = status === "PAYMENT_PENDING";
  const isActivePending = isPending && (expiresAtTs == null || expiresAtTs > now);
  if (isActivePending) {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      continue;
    }
    state.reservedCount += 1;
  }
}

const plansPayload = (singleCounter ? [selectedCounterKey] : countersOrder)
  .map((counterKey) => {
    const state = statesByCounterKey[counterKey];
    if (!state) return null;
    if (state.stagedRelease) {
      state._launchPaidTimestamps.sort((left, right) => left - right);
      const launchComplete = state.launchPaidCount >= state.launchLimit;
      const launchCompletedAtTs = launchComplete && state._launchPaidTimestamps.length >= state.launchLimit
        ? state._launchPaidTimestamps[state.launchLimit - 1]
        : null;
      state.launchCompletedAt = launchCompletedAtTs == null ? null : new Date(launchCompletedAtTs).toISOString();
      state.dailyDropStartsAt = launchComplete ? resolveNextDailyDropAt(launchCompletedAtTs) : null;
      state.dailyDropActive = Boolean(state.dailyDropStartsAt && Date.parse(state.dailyDropStartsAt) <= now);
      const dailyDropStartsAtTs = toTs(state.dailyDropStartsAt);
      state.launchPaidCount = launchComplete ? state.launchLimit : state.launchPaidCount;
      for (const row of state._stagedRows) {
        const isCurrentDailyDrop = row.releasePhase === "daily"
          ? row.dailyDropDate === state.dailyDropDate
          : dailyDropStartsAtTs != null
            && row.eventTs != null
            && row.eventTs >= dailyDropStartsAtTs
            && resolveDailyDropDate(new Date(row.eventTs)) === state.dailyDropDate;
        if (row.status === "PAID") {
          if (isCurrentDailyDrop) state._dailyPaidCount += 1;
          continue;
        }
        if (isCurrentDailyDrop) state._dailyReservedCount += 1;
        else if (row.releasePhase === "launch") state.launchReservedCount += 1;
      }
      state.releasePhase = state.dailyDropActive ? "daily" : launchComplete ? "daily_pending" : "launch";
      state.launchRemainingCount = Math.max(
        state.launchLimit - state.launchPaidCount - state.launchReservedCount,
        0,
      );
      state.totalLimit = state.dailyDropActive ? state.dailyLimit : state.launchLimit;
      state.paidCount = state.dailyDropActive ? state._dailyPaidCount : state.launchPaidCount;
      state.reservedCount = state.dailyDropActive ? state._dailyReservedCount : state.launchReservedCount;
    }
    state.takenCount = state.paidCount + state.reservedCount;
    state.remainingCount = state.unlimited ? 0 : Math.max(state.totalLimit - state.takenCount, 0);
    const regional = REGIONAL_FRIENDSHIP_CONFIGS[state.counterKey];
    if (regional) {
      const tiers = Array.isArray(state._tiers) ? state._tiers : [];
      const batchSize = Math.max(1, state.batchSize || regional.batchSize);
      const batchIndex = Math.max(1, Math.min(tiers.length || 1, Math.floor(state.takenCount / batchSize) + 1));
      const activeTier = tiers[batchIndex - 1] || null;
      const takenInBatch = Math.max(0, state.takenCount - (batchIndex - 1) * batchSize);
      state.batchSize = batchSize;
      state.batchIndex = batchIndex;
      state.batchCount = tiers.length;
      state.batchRemainingCount = state.remainingCount <= 0 ? 0 : Math.max(0, batchSize - takenInBatch);
      state.productId = toStr(activeTier?.productId);
      state.productName = toStr(activeTier?.productName);
      state.priceMinor = Number.isFinite(Number(activeTier?.priceMinor))
        ? Math.max(0, Math.round(Number(activeTier.priceMinor)))
        : null;
      state.providerProductCostMinor = Number.isFinite(Number(activeTier?.providerProductCostMinor))
        ? Math.max(0, Math.round(Number(activeTier.providerProductCostMinor)))
        : null;
      state.discountMinor = state.priceMinor != null && state.providerProductCostMinor != null
        ? state.providerProductCostMinor - state.priceMinor
        : null;
      state.price = state.priceMinor == null ? null : state.priceMinor / 100;
      state.bindingReady = Boolean(
        state.productId
        && state.priceMinor != null
        && state.providerProductCostMinor != null
        && state.discountMinor != null
        && state.discountMinor >= 0
      );
      state.bindingError = state.bindingReady
        ? null
        : `Текущая ценовая партия ${regional.bindingLabel} ещё не подключена к оплате`;
    }
    state.canPurchase = (state.unlimited || state.remainingCount > 0) && state.bindingReady;
    state.updatedAt = state._lastUpdatedAtTs == null
      ? new Date().toISOString()
      : new Date(state._lastUpdatedAtTs).toISOString();
    delete state._lastUpdatedAtTs;
    delete state._dailyPaidCount;
    delete state._dailyReservedCount;
    delete state._launchPaidTimestamps;
    delete state._stagedRows;
    delete state._tiers;
    return state;
  })
  .filter((state) => Boolean(state));

const selectedCounter = (plansPayload.find((state) => state.counterKey === selectedCounterKey))
  || plansPayload[0]
  || statesByCounterKey[selectedCounterKey]
  || createCounterState(configMap[selectedCounterKey] || configMap.sport);

const summary = {
  totalLimit: 0,
  paidCount: 0,
  reservedCount: 0,
  takenCount: 0,
  remainingCount: 0,
  canPurchase: false,
  updatedAt: null,
};
let summaryUpdatedTs = null;

plansPayload.forEach((state) => {
  summary.totalLimit += state.totalLimit;
  summary.paidCount += state.paidCount;
  summary.reservedCount += state.reservedCount;
  summary.takenCount += state.takenCount;
  summary.remainingCount += state.remainingCount;
  const ts = toTs(state.updatedAt);
  if (ts != null && (summaryUpdatedTs == null || ts > summaryUpdatedTs)) {
    summaryUpdatedTs = ts;
  }
});
summary.canPurchase = plansPayload.some((state) => state.canPurchase);
summary.updatedAt = summaryUpdatedTs == null
  ? new Date().toISOString()
  : new Date(summaryUpdatedTs).toISOString();

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  counterKey: toStr(selectedCounter.counterKey),
  inventoryId: toStr(selectedCounter.inventoryId),
  saleType: toStr(selectedCounter.saleType),
  unlimited: selectedCounter.unlimited === true,
  planKey: normalizePlanKey(selectedCounter.planKey),
  planType: normalizePlanKey(selectedCounter.planKey),
  campaignKey: toStr(selectedCounter.campaignKey),
  productId: toStr(selectedCounter.productId),
  productName: toStr(selectedCounter.productName),
  totalLimit: toInt(selectedCounter.totalLimit, 0),
  paidCount: toInt(selectedCounter.paidCount, 0),
  reservedCount: toInt(selectedCounter.reservedCount, 0),
  takenCount: toInt(selectedCounter.takenCount, 0),
  remainingCount: toInt(selectedCounter.remainingCount, 0),
  canPurchase: toBool(selectedCounter.canPurchase) ?? false,
  bindingReady: toBool(selectedCounter.bindingReady) ?? true,
  bindingError: toStr(selectedCounter.bindingError),
  batchSize: toInt(selectedCounter.batchSize, 0),
  batchIndex: toInt(selectedCounter.batchIndex, 0),
  batchCount: toInt(selectedCounter.batchCount, 0),
  batchRemainingCount: toInt(selectedCounter.batchRemainingCount, 0),
  providerProductCostMinor: Number.isFinite(Number(selectedCounter.providerProductCostMinor))
    ? Math.max(0, Math.round(Number(selectedCounter.providerProductCostMinor)))
    : null,
  discountMinor: Number.isFinite(Number(selectedCounter.discountMinor))
    ? Math.max(0, Math.round(Number(selectedCounter.discountMinor)))
    : null,
  releasePhase: toStr(selectedCounter.releasePhase),
  dailyDropActive: selectedCounter.dailyDropActive === true,
  releaseStartDate: toStr(selectedCounter.releaseStartDate),
  launchLimit: toInt(selectedCounter.launchLimit, 0),
  launchPaidCount: toInt(selectedCounter.launchPaidCount, 0),
  launchReservedCount: toInt(selectedCounter.launchReservedCount, 0),
  launchRemainingCount: toInt(selectedCounter.launchRemainingCount, 0),
  launchCompletedAt: toStr(selectedCounter.launchCompletedAt),
  dailyLimit: toInt(selectedCounter.dailyLimit, 0),
  dailyDropDate: toStr(selectedCounter.dailyDropDate),
  dailyDropStartsAt: toStr(selectedCounter.dailyDropStartsAt),
  priceMinor: selectedCounter.priceMinor == null ? null : Math.max(0, Math.round(Number(selectedCounter.priceMinor) || 0)),
  price: selectedCounter.price == null ? null : Number(selectedCounter.price),
  updatedAt: toStr(selectedCounter.updatedAt) || new Date().toISOString(),
  plans: plansPayload,
  summary,
};

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_response",
    mode: singleCounter ? "single" : "aggregate",
    counterKey: msg.payload.counterKey,
    planKey: msg.payload.planKey,
    campaignKey: msg.payload.campaignKey,
    summary,
  },
});

return [msg, debugMsg];
