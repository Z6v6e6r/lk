const DEFAULT_TOTAL_LIMIT = 100;
const MAX_TOTAL_LIMIT = 1000;
const SIRIUS_FRIENDSHIP_DEFAULT_LIMIT = 100;
const AB_LETO_INVENTORY_ID = "ab_leto_2026_50_v1";
const AB_LETO_DAILY_DROP_LIMIT = 5;
const AB_LETO_DAILY_DROP_START_HOUR = 10;
const AB_LETO_DAILY_DROP_TIME_ZONE = "Europe/Moscow";
const AB_LETO_DAILY_DROP_COUNTER_KEYS = new Set(["friendship", "ra"]);
const AB_LETO_LEGACY_STAGED_RELEASE_START_DATE = "2026-08-01";
const AB_LETO_LEGACY_STAGED_INVENTORY_ID = "ab_leto_2026_100_then_7_v1";
const AB_LETO_LEGACY_STAGED_LAUNCH_LIMIT = 100;
const AB_LETO_STAGED_RELEASE_START_DATE = "2026-09-03";
const AB_LETO_STAGED_INVENTORY_ID = "ab_leto_2026_150_v2";
const AB_LETO_STAGED_LAUNCH_LIMIT = 150;
const AB_LETO_STAGED_DAILY_DROP_LIMIT = 7;
const AB_LETO_STAGED_RA_DAILY_DROP_LIMIT = 10;
const AB_LETO_STAGED_RELEASE_ACTIVATION_KEY = "summer_subscription_ab_leto_20260903_release_enabled";
const NETWORK_FRIENDSHIP_DAILY_LIMIT = 10;
const DEFAULT_RESERVATION_MINUTES = 30;
const PAYMENT_REF_QUERY_KEY = "summerPaymentRef";
const TRAINER_QR_CODE_PATTERN = /^TR-(?:00[1-9]|0[1-4]\d|050)$/;
const REFERRAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const REFERRAL_VISIT_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const DEFAULT_PLAN_KEY = "sport";
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
    launchEnabled: false,
    providerProductId: null,
    providerProductCostMinor: null,
  },
  network_friendship: {
    inventoryId: "network_friendship_12m_2026_v1",
    batchSize: 100,
    tierPricesMinor: [5680000],
    productName: "Падел.Дружба.ХАБ",
    launchEnabled: true,
    providerProductId: "db7a5250-7369-4f43-8ac5-9111be24bc74",
    providerProductName: "Падел.Дружба.ХАБ — годовая",
    providerProductCostMinor: 5680000,
    dailyCapEnabled: true,
    dailyLimit: NETWORK_FRIENDSHIP_DAILY_LIMIT,
  },
  piter_friendship: {
    inventoryId: "piter_friendship_12m_2026_v1",
    batchSize: 100,
    tierPricesMinor: [1980000, 2380000, 3680000, 5680000],
    productName: "Падел.Дружба.Питер",
    launchEnabled: true,
    providerProductId: "8bf334ba-3050-4017-b40a-7eef2db1eb16",
    providerProductName: "Падел.Дружба.Питер — годовая",
    providerProductCostMinor: 5680000,
  },
};
const REGIONAL_FRIENDSHIP_COUNTER_KEYS = new Set(Object.keys(REGIONAL_FRIENDSHIP_CONFIGS));

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

const resolveAbLetoStagedRelease = (now = new Date(Date.now())) => {
  const moscowDate = resolveMoscowDate(now);
  if (
    global.get(AB_LETO_STAGED_RELEASE_ACTIVATION_KEY) === true
    && moscowDate >= AB_LETO_STAGED_RELEASE_START_DATE
  ) {
    return {
      inventoryId: AB_LETO_STAGED_INVENTORY_ID,
      launchLimit: AB_LETO_STAGED_LAUNCH_LIMIT,
      releaseStartDate: AB_LETO_STAGED_RELEASE_START_DATE,
    };
  }
  if (moscowDate >= AB_LETO_LEGACY_STAGED_RELEASE_START_DATE) {
    return {
      inventoryId: AB_LETO_LEGACY_STAGED_INVENTORY_ID,
      launchLimit: AB_LETO_LEGACY_STAGED_LAUNCH_LIMIT,
      releaseStartDate: AB_LETO_LEGACY_STAGED_RELEASE_START_DATE,
    };
  }
  return null;
};

const isAbLeto20260903ReleaseActive = () => (
  resolveAbLetoStagedRelease()?.inventoryId === AB_LETO_STAGED_INVENTORY_ID
);

const readAbLetoInventoryId = (counterKey = null) => {
  const baseInventoryId = readGlobalFirst(["summer_subscription_inventory_id"])
    || AB_LETO_INVENTORY_ID;
  const normalizedCounterKey = String(counterKey || "").trim().toLowerCase();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(normalizedCounterKey)) {
    return baseInventoryId;
  }
  const stagedRelease = resolveAbLetoStagedRelease();
  if (stagedRelease) {
    return `${stagedRelease.inventoryId}_${normalizedCounterKey}`;
  }
  return `${baseInventoryId}_${normalizedCounterKey}_${resolveDailyDropDate()}`;
};

const withAbLetoStagedRelease = (counter) => {
  const counterKey = String(counter?.counterKey || "").trim().toLowerCase();
  const stagedRelease = resolveAbLetoStagedRelease();
  if (!AB_LETO_DAILY_DROP_COUNTER_KEYS.has(counterKey) || !stagedRelease) {
    return counter;
  }
  return Object.assign({}, counter, {
    stagedRelease: true,
    releaseStartDate: stagedRelease.releaseStartDate,
    launchLimit: stagedRelease.launchLimit,
    dailyLimit: counterKey === "ra"
      ? AB_LETO_STAGED_RA_DAILY_DROP_LIMIT
      : AB_LETO_STAGED_DAILY_DROP_LIMIT,
    dailyDropDate: resolveDailyDropDate(),
    totalLimit: stagedRelease.launchLimit,
  });
};

const toInt = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  const parsed = Number(text.replace(",", "."));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
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

const toMoneyMinor = (value, fallback) => {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(String(value).trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.max(0, Math.round(parsed));
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
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

const normalizeTrainerQrCode = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return TRAINER_QR_CODE_PATTERN.test(code) ? code : null;
};

const normalizeReferralAttribution = (tokenValue, visitIdValue) => {
  const referralToken = String(tokenValue || "").trim();
  const referralVisitId = String(visitIdValue || "").trim();
  if (!REFERRAL_TOKEN_PATTERN.test(referralToken)) return { referralToken: null, referralVisitId: null };
  if (!REFERRAL_VISIT_ID_PATTERN.test(referralVisitId)) return { referralToken: null, referralVisitId: null };
  return { referralToken, referralVisitId };
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
  const dailyCapEnabled = regional.dailyCapEnabled === true && isAbLeto20260903ReleaseActive();
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
    dailyCapEnabled,
    dailyLimit: dailyCapEnabled ? regional.dailyLimit : 0,
    dailyDropDate: dailyCapEnabled ? resolveMoscowDate() : null,
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

const buildCounterQuery = (counter) => {
  if (!counter || typeof counter !== "object") return {};

  const inventoryId = toStr(counter.inventoryId);
  const counterKey = normalizeCounterKey(counter.counterKey);
  if (inventoryId && counterKey) {
    return { inventoryId, counterKey };
  }
  if (counter.saleType === "summer_campaign") {
    const campaignKey = toStr(counter.campaignKey);
    return campaignKey ? { campaignKey } : {};
  }

  const clauses = [
    counter.counterKey ? { counterKey: counter.counterKey } : null,
    counter.productId ? { productId: counter.productId } : null,
  ].filter((value) => Boolean(value));

  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0];
  return { $or: clauses };
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const clientPhone = normalizePhone(body.clientPhone || body.phone);
if (!clientPhone) {
  return fail(400, "clientPhone is required");
}

const requestedCounterRaw = toStr(body.counterKey || body.statusKey || query.counterKey || query.statusKey);
const requestedCounterKey = normalizeCounterKey(requestedCounterRaw);
if (requestedCounterRaw && !requestedCounterKey) {
  return fail(400, "Unsupported counterKey", { counterKey: requestedCounterRaw });
}

const requestedPlanRaw = toStr(
  body.planKey
  || body.plan
  || body.planType
  || body.tariff
  || query.planKey
  || query.plan,
);
const requestedPlanKey = normalizePlanKey(requestedPlanRaw);
if (requestedPlanRaw && !requestedPlanKey) {
  return fail(400, "Unsupported planKey", { planKey: requestedPlanRaw });
}

const requestedCampaignKey = toStr(body.campaignKey || query.campaignKey);
const requestedProductId = toStr(body.productId || body.subscriptionProductId);
const configMap = buildCounterConfigMap();
const configByCampaign = {};
Object.values(configMap).forEach((counter) => {
  const campaignKey = toStr(counter?.campaignKey);
  if (campaignKey) {
    configByCampaign[campaignKey] = counter;
  }
});

let activeCounter = configMap.sport;
let campaignKeyInputIgnored = false;
let campaignKeyInputReason = null;
if (requestedCounterKey) {
  const mappedByCounter = configMap[requestedCounterKey] || null;
  if (!mappedByCounter) {
    return fail(400, "Unsupported counterKey", { counterKey: requestedCounterKey });
  }
  activeCounter = mappedByCounter;
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
  const mappedByCampaign = configByCampaign[requestedCampaignKey] || null;
  if (!mappedByCampaign) {
    return fail(400, "Unsupported campaignKey", { campaignKey: requestedCampaignKey });
  }
  activeCounter = mappedByCampaign;
}

if (REGIONAL_FRIENDSHIP_COUNTER_KEYS.has(activeCounter.counterKey)) {
  return fail(503, "Продажа годовой подписки ожидает authoritative-привязку оплаты к экземпляру", {
    code: "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE",
    counterKey: activeCounter.counterKey,
  });
}

const productId = REGIONAL_FRIENDSHIP_COUNTER_KEYS.has(activeCounter.counterKey)
  ? null
  : activeCounter.productId || requestedProductId;
const totalLimit = activeCounter.totalLimit;
const reservationMinutes = Math.max(
  5,
  Math.min(360, toInt(global.get("summer_subscription_reservation_minutes"), DEFAULT_RESERVATION_MINUTES)),
);

const paymentRef =
  toStr(body.paymentRef)
  || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const clientId = toStr(body.clientId);
const trainerQrCode = normalizeTrainerQrCode(body.trainerQrCode || body.qr);
const referralAttribution = normalizeReferralAttribution(body.referralToken || body.ref, body.referralVisitId || body.ref_visit);
const successUrlInput =
  toStr(body.successUrl)
  || toStr(body.baseRedirectUrl)
  || toStr(body.returnUrl)
  || null;
const failUrlInput =
  toStr(body.failUrl)
  || toStr(body.baseRedirectUrl)
  || toStr(body.returnUrl)
  || successUrlInput;

const safeDecode = (value) => {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
};

const appendPaymentRef = (value) => {
  const raw = toStr(value);
  if (!raw) return null;

  const hashIndex = raw.indexOf("#");
  const mainPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const hashSuffix = hashIndex >= 0 ? raw.slice(hashIndex) : "";

  const queryIndex = mainPart.indexOf("?");
  const pathPart = queryIndex >= 0 ? mainPart.slice(0, queryIndex) : mainPart;
  const queryPart = queryIndex >= 0 ? mainPart.slice(queryIndex + 1) : "";

  const encodedKey = encodeURIComponent(PAYMENT_REF_QUERY_KEY);
  const encodedValue = encodeURIComponent(paymentRef);
  const queryItems = queryPart
    ? queryPart.split("&").filter((item) => Boolean(item))
    : [];
  const filteredItems = queryItems.filter((item) => {
    const keyPart = item.includes("=") ? item.split("=")[0] : item;
    return keyPart !== encodedKey && safeDecode(keyPart) !== PAYMENT_REF_QUERY_KEY;
  });

  filteredItems.push(`${encodedKey}=${encodedValue}`);
  const nextQuery = filteredItems.join("&");
  const querySuffix = nextQuery ? `?${nextQuery}` : "";
  return `${pathPart}${querySuffix}${hashSuffix}`;
};

const successUrl = appendPaymentRef(successUrlInput);
const failUrl = appendPaymentRef(failUrlInput);
const transactionPaymentMethod =
  toStr(body.transactionPaymentMethod || body.paymentMethod)
  || toStr(global.get("summer_subscription_payment_method"))
  || null;

msg._summerSubscriptionCtx = {
  action: "purchase",
  step: "limit_check",
  counterKey: activeCounter.counterKey,
  inventoryId: activeCounter.inventoryId,
  unlimited: activeCounter.unlimited === true,
  saleType: activeCounter.saleType,
  planKey: activeCounter.planKey,
  plans: [activeCounter],
  counters: [activeCounter],
  campaignKey: activeCounter.campaignKey,
  productName: activeCounter.productName,
  productId,
  productCostMinor: activeCounter.productCostMinor,
  batchSize: Math.max(0, Math.floor(Number(activeCounter.batchSize) || 0)),
  tiers: Array.isArray(activeCounter.tiers) ? activeCounter.tiers : [],
  totalLimit,
  stagedRelease: activeCounter.stagedRelease === true,
  releaseStartDate: toStr(activeCounter.releaseStartDate),
  launchLimit: Math.max(0, Math.floor(Number(activeCounter.launchLimit) || 0)),
  dailyLimit: Math.max(0, Math.floor(Number(activeCounter.dailyLimit) || 0)),
  dailyDropDate: toStr(activeCounter.dailyDropDate),
  reservationMinutes,
  paymentRef,
  clientPhone,
  clientId,
  trainerQrCode,
  referralToken: referralAttribution.referralToken,
  referralVisitId: referralAttribution.referralVisitId,
  transactionPaymentMethod,
  successUrl,
  failUrl,
  studioId: toStr(global.get("summer_subscription_studio_id")) || null,
};

const counterQuery = buildCounterQuery(activeCounter);
const dbMsg = Object.assign({}, msg, {
  query: counterQuery,
  payload: counterQuery,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "purchase_prepare",
    counterKey: activeCounter.counterKey,
    inventoryId: activeCounter.inventoryId,
    unlimited: activeCounter.unlimited === true,
    saleType: activeCounter.saleType,
    planKey: activeCounter.planKey,
    campaignKey: activeCounter.campaignKey,
    productId,
    productName: activeCounter.productName,
    totalLimit,
    reservationMinutes,
    paymentRef,
    clientPhone,
    trainerQrCode,
    referralToken: referralAttribution.referralToken,
    referralVisitId: referralAttribution.referralVisitId,
    campaignKeyInput: requestedCampaignKey,
    campaignKeyInputIgnored,
    campaignKeyInputReason,
  },
});

return [dbMsg, null, debugMsg];
