const VIVA_API_BASE = "https://api.vivacrm.ru";
const SERV2_URL = "https://padlhub.su/seliger";
const DAILY_LIMIT_CODE = "SUBSCRIPTION_CATEGORY_DAILY_LIMIT_REACHED";
const SHARED_LIMIT_FROM = "2026-08-01";
const PREPARED_LEASE_MS = 2 * 60 * 1000;
// Viva normally confirms in seconds; keep the dedupe window short, then reconcile safely.
const PENDING_CONFIRMATION_MS = 15 * 60 * 1000;
const PITER_STATION_ID = "1ea77cbf-bc36-49a1-96d6-f35c216a409b";
const PITER_MANAGED_PRODUCT_ID = "8bf334ba-3050-4017-b40a-7eef2db1eb16";
const MANAGED_ENFORCEMENT_ALLOWLIST_GLOBAL = "subscriptions_managed_enforcement_product_ids";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGIONAL_ACTIVATION_MODE = "FIRST_USE_OR_FIXED_DATE";
const REGIONAL_ACTIVATION_FALLBACK_AT = "2026-09-30T21:00:00.000Z";
const REGIONAL_ACTIVATION_TIME_ZONE = "Europe/Moscow";
const REGIONAL_VALIDITY_DAYS = 365;
const TRUSTED_ENTITLEMENT_API_BASE = "https://padlhub.su/api";

const OUTPUT_HTTP = 0;
const OUTPUT_MONGO_FIND = 1;
const OUTPUT_MONGO_INSERT = 2;
const OUTPUT_MONGO_UPDATE = 3;
const OUTPUT_FINAL = 4;
const OUTPUT_DEBUG = 5;
const OUTPUT_MANAGED_POLICY = 6;

const emit = (index, value = msg) => {
  const outputs = [null, null, null, null, null, null, null];
  outputs[index] = value;
  return outputs;
};

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const normalizeDate = (value) => {
  const matched = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]}` : null;
};
const normalizeMarker = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^a-z0-9а-я]+/gi, "");
const isHttpOk = (status) => Number(status) >= 200 && Number(status) < 300;
const readGlobal = (key) => {
  try {
    return toStr(global.get(key));
  } catch (_) {
    return null;
  }
};

const readManagedEnforcementAllowlist = () => {
  let configured;
  try {
    configured = global.get(MANAGED_ENFORCEMENT_ALLOWLIST_GLOBAL);
  } catch (_) {
    configured = undefined;
  }
  if (configured === undefined || configured === null || configured === "") {
    return { ok: true, productIds: [] };
  }
  if (typeof configured === "string") {
    const text = configured.trim();
    if (!text) return { ok: true, productIds: [] };
    try {
      configured = JSON.parse(text);
    } catch (_) {
      return { ok: false, code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID" };
    }
  }
  if (!Array.isArray(configured)) {
    return { ok: false, code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID" };
  }
  const normalized = [];
  for (const value of configured) {
    const productId = normalizeId(value);
    if (!productId || !UUID_PATTERN.test(productId)) {
      return { ok: false, code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID" };
    }
    normalized.push(productId);
  }
  return { ok: true, productIds: [...new Set(normalized)].sort() };
};

const responseHeaders = () => ({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
});

const finishError = (ctx, statusCode, error, details) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = statusCode;
  msg.headers = responseHeaders();
  msg.payload = { error, details: details || null };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishPending = (ctx, message, details) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = 202;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "PENDING_CONFIRMATION",
    operationId: ctx.operationId,
    exerciseId: ctx.exerciseId,
    message: message || "Запись принята и ожидает подтверждения Viva",
    details: details || null,
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishConfirmed = (ctx, bookingId, statusCode = 200) => {
  const normalizedBookingId = toStr(bookingId);
  if (!normalizedBookingId) {
    return finishPending(ctx, "Запись найдена в Viva без устойчивого bookingId и требует сверки");
  }
  msg._subscriptionBooking = ctx;
  msg.statusCode = statusCode;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "CONFIRMED",
    operationId: ctx.operationId,
    exerciseId: ctx.exerciseId,
    bookingId: normalizedBookingId,
    clientSubscriptionId: ctx.clientSubscriptionId,
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishReleased = (ctx, details = null) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = 200;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "RELEASED",
    operationId: ctx.operationId,
    bookingId: ctx.releaseBookingId,
    details,
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const finishFullPriceFallback = (ctx, blockers) => {
  msg._subscriptionBooking = ctx;
  msg.statusCode = 200;
  msg.headers = responseHeaders();
  msg.payload = {
    ok: true,
    state: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
    operationId: ctx.operationId,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    blockers: asArray(blockers),
  };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};

const prepareHttp = (ctx, step, method, url, payload, headers = {}) => {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.method = method;
  msg.url = url;
  msg.headers = headers;
  msg.payload = payload;
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_HTTP);
};

const prepareUserGet = (ctx, step, path) => prepareHttp(
  ctx,
  step,
  "GET",
  `${VIVA_API_BASE}${path}`,
  undefined,
  { Authorization: ctx.authHeader, Accept: "application/json" },
);

const prepareManagedRuntimeContext = (ctx, step = "managed_runtime_context") => {
  if (ctx.managedEnforcement?.enabled !== true
    || ctx.managedEnforcement.exactProductId !== PITER_MANAGED_PRODUCT_ID
    || ctx.planKey !== "piter_friendship") {
    const details = { code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONTEXT_INVALID" };
    return step === "managed_runtime_recheck"
      ? prepareFailedUpdate(ctx, 409, "Контекст управляемой подписки изменился до записи", details.code)
      : finishError(ctx, 409, "Контекст управляемой подписки не подтверждён", details);
  }
  const apiBase = (readGlobal("subscriptions_runtime_api_base_url") || "").replace(/\/+$/, "");
  const integrationToken = readGlobal("subscriptions_runtime_context_integration_token");
  if (!apiBase || !/^https:\/\//i.test(apiBase) || !integrationToken) {
    return finishError(ctx, 503, "Контур правил подписки временно недоступен", {
      code: "MANAGED_SUBSCRIPTION_RUNTIME_NOT_CONFIGURED",
    });
  }
  return prepareHttp(
    ctx,
    step,
    "POST",
    `${apiBase}/internal/subscriptions/runtime-context`,
    { clientSubscriptionId: ctx.clientSubscriptionId },
    {
      Authorization: ctx.authHeader,
      "X-Subscriptions-Integration-Token": integrationToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  );
};

const managedActivationConfig = () => ({
  apiBase: (readGlobal("subscriptions_runtime_api_base_url") || "").replace(/\/+$/, ""),
  integrationToken: readGlobal("subscriptions_activation_integration_token"),
});

const validManagedActivationConfig = (config) => (
  /^https:\/\//i.test(config.apiBase)
  && Buffer.byteLength(config.integrationToken || "", "utf8") >= 32
);

const managedActivationConfigured = () => {
  const config = managedActivationConfig();
  return validManagedActivationConfig(config);
};

const managedEntitlementConfig = () => {
  const configuredApiBase = (readGlobal("subscriptions_runtime_api_base_url") || "")
    .replace(/\/+$/, "");
  return {
    apiBase: configuredApiBase,
    trustedOrigin: configuredApiBase === TRUSTED_ENTITLEMENT_API_BASE,
    integrationToken: readGlobal("subscriptions_entitlement_integration_token"),
  };
};

const validManagedEntitlementConfig = (config) => (
  config.trustedOrigin === true
  && config.apiBase === TRUSTED_ENTITLEMENT_API_BASE
  && Buffer.byteLength(config.integrationToken || "", "utf8") >= 32
);

const managedEntitlementHeaders = (ctx, config) => ({
  Authorization: ctx.authHeader,
  "X-Subscriptions-Integration-Token": config.integrationToken,
  "X-Correlation-Id": ctx.operationId,
  "Content-Type": "application/json",
  Accept: "application/json",
});

const prepareManagedEntitlementReserve = (ctx) => {
  const config = managedEntitlementConfig();
  if (!validManagedEntitlementConfig(config)) {
    return prepareFailedUpdate(
      ctx,
      503,
      "Резерв льготы подписки ещё не настроен",
      config.trustedOrigin
        ? "SUBSCRIPTION_ENTITLEMENT_NOT_CONFIGURED"
        : "SUBSCRIPTION_ENTITLEMENT_ORIGIN_NOT_TRUSTED",
    );
  }
  return prepareHttp(
    ctx,
    "managed_entitlement_reserve",
    "POST",
    `${TRUSTED_ENTITLEMENT_API_BASE}/internal/subscriptions/entitlements/reserve`,
    {
      subscriptionInstanceId: ctx.managedRuntime.subscriptionInstanceId,
      action: ctx.managedAction,
      target: { targetId: ctx.exerciseId },
    },
    {
      ...managedEntitlementHeaders(ctx, config),
      "Idempotency-Key": ctx.operationId,
    },
  );
};

const prepareManagedEntitlementConfirm = (ctx) => {
  const config = managedEntitlementConfig();
  if (!validManagedEntitlementConfig(config)) {
    return finishPending(ctx, "Запись подтверждена Viva; льгота ожидает подтверждения ЦУП", {
      code: "SUBSCRIPTION_ENTITLEMENT_NOT_CONFIGURED",
    });
  }
  return prepareHttp(
    ctx,
    "managed_entitlement_confirm",
    "POST",
    `${TRUSTED_ENTITLEMENT_API_BASE}/internal/subscriptions/entitlements/confirm`,
    {
      operationId: ctx.managedEntitlementOperationId,
      providerBookingId: ctx.confirmedBookingId,
    },
    managedEntitlementHeaders(ctx, config),
  );
};

const prepareManagedEntitlementRelease = (ctx, reason, providerBookingId = null) => {
  const config = managedEntitlementConfig();
  if (!validManagedEntitlementConfig(config) || !toStr(ctx.managedEntitlementOperationId)) {
    return finishPending(ctx, "Резерв льготы требует ручной сверки", {
      code: "SUBSCRIPTION_ENTITLEMENT_RELEASE_NOT_CONFIGURED",
    });
  }
  const payload = {
    operationId: ctx.managedEntitlementOperationId,
    reason,
  };
  if (providerBookingId) payload.providerBookingId = providerBookingId;
  ctx.entitlementReleaseReason = reason;
  return prepareHttp(
    ctx,
    "managed_entitlement_release",
    "POST",
    `${TRUSTED_ENTITLEMENT_API_BASE}/internal/subscriptions/entitlements/release`,
    payload,
    managedEntitlementHeaders(ctx, config),
  );
};

const validEntitlementDecision = (ctx, decision) => {
  if (!isObj(decision) || decision.decisionKind !== "ENTITLEMENT"
    || decision.policyVersion !== ctx.managedRuntime?.policy?.policyVersion
    || decision.policyDigest !== ctx.managedRuntime?.policyDigest
    || decision.action !== ctx.managedAction
    || normalizeId(decision.target?.targetId) !== normalizeId(ctx.exerciseId)
    || normalizeId(decision.target?.stationId) !== normalizeId(ctx.managedTarget?.stationId)
    || toStr(decision.target?.eventTypeId) !== toStr(ctx.managedTarget?.externalEventTypeId)
    || toStr(decision.target?.productTypeId) !== toStr(ctx.managedTarget?.productTypeId)
    || Number(decision.target?.durationMinutes) !== Number(ctx.managedTarget?.durationMinutes)
    || finiteDate(decision.target?.startsAt)?.getTime() !== finiteDate(ctx.managedTarget?.startsAt)?.getTime()
    || !Number.isInteger(decision.usageUnits) || decision.usageUnits < 1
    || !isObj(decision.money) || decision.money.currency !== "RUB") return false;
  return [
    decision.money.basePriceMinor,
    decision.money.discountMinor,
    decision.money.surchargeMinor,
    decision.money.finalPriceMinor,
  ].every((value) => value === null || (Number.isSafeInteger(value) && value >= 0))
    && Number.isSafeInteger(decision.money.finalPriceMinor);
};

const prepareManagedEntitlementBind = (ctx) => {
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, "operation_entitlement_bind", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PENDING_CONFIRMATION",
    $or: [
      { managedEntitlementOperationId: { $exists: false } },
      { managedEntitlementOperationId: null },
      { managedEntitlementOperationId: ctx.managedEntitlementOperationId },
    ],
  }, {
    $set: {
      managedEntitlementOperationId: ctx.managedEntitlementOperationId,
      managedSubscriptionInstanceId: ctx.managedRuntime.subscriptionInstanceId,
      managedEntitlementState: "RESERVED",
      managedDecision: ctx.managedDecision,
      updatedAt: nowIso,
    },
  });
};

const prepareManagedEntitlementConfirmedUpdate = (ctx) => {
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, "operation_entitlement_confirm", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "CONFIRMED",
    managedEntitlementOperationId: ctx.managedEntitlementOperationId,
  }, {
    $set: {
      managedEntitlementState: "CONFIRMED",
      managedEntitlementConfirmedAt: nowIso,
      updatedAt: nowIso,
    },
  });
};

const prepareFullPriceFallbackUpdate = (ctx, blockers) => {
  const nowIso = new Date().toISOString();
  ctx.fullPriceFallbackBlockers = asArray(blockers);
  return prepareMongoUpdate(ctx, "operation_full_price_fallback", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PENDING_CONFIRMATION",
  }, {
    $set: {
      state: "RELEASED",
      releaseReason: "FULL_PRICE_WITHOUT_SUBSCRIPTION",
      releasedAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { pendingUntil: "", leaseUntil: "" },
  });
};

const projectedFirstUseInstance = (instance, lifecycle, evaluatedAt) => {
  const now = finiteDate(evaluatedAt);
  const deadline = finiteDate(lifecycle?.fixedActivationAt);
  const validityDays = lifecycle?.validityDays;
  if (!now || !deadline || !Number.isInteger(validityDays) || validityDays < 1) return null;
  const activeFromMs = Math.min(now.getTime(), deadline.getTime());
  const activeToMs = activeFromMs + validityDays * 24 * 60 * 60 * 1000 - 1;
  if (!Number.isSafeInteger(activeToMs)) return null;
  return {
    ...instance,
    state: "ACTIVE",
    activeFrom: new Date(activeFromMs).toISOString(),
    activeTo: new Date(activeToMs).toISOString(),
    frozenUntil: null,
  };
};

const prepareManagedFirstUseActivation = (ctx, providerBookingId) => {
  if (ctx.managedEnforcement?.enabled !== true
    || ctx.managedEnforcement.exactProductId !== PITER_MANAGED_PRODUCT_ID) {
    return finishPending(ctx, "Запись подтверждена Viva; rollout активации требует повторной проверки", {
      code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONTEXT_INVALID",
    });
  }
  const config = managedActivationConfig();
  if (!validManagedActivationConfig(config)) {
    return finishPending(ctx, "Запись подтверждена Viva; активация подписки ожидает настройки ЦУП", {
      code: "SUBSCRIPTION_ACTIVATION_NOT_CONFIGURED",
    });
  }
  ctx.step = "managed_first_use_activation";
  msg._subscriptionBooking = ctx;
  msg.method = "POST";
  msg.url = `${config.apiBase}/internal/subscriptions/activate-first-use`;
  msg.headers = {
    Authorization: ctx.authHeader,
    "X-Subscriptions-Integration-Token": config.integrationToken,
    "X-Correlation-Id": ctx.operationId,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  msg.payload = {
    subscriptionInstanceId: ctx.managedRuntime.subscriptionInstanceId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    providerBookingId,
    expectedInstanceRevision: ctx.managedActivationExpectedRevision,
  };
  delete msg.error;
  delete msg.statusCode;
  return emit(OUTPUT_HTTP);
};

const prepareAdminGet = (ctx, step, path) => {
  let serviceToken = null;
  try {
    serviceToken = toStr(global.get("vivacrm_access_token"));
  } catch {
    serviceToken = null;
  }
  if (!serviceToken) {
    return finishError(ctx, 503, "Сервисный токен Viva временно недоступен", {
      code: "VIVA_SERVICE_TOKEN_UNAVAILABLE",
    });
  }
  return prepareHttp(
    ctx,
    step,
    "GET",
    `${VIVA_API_BASE}${path}`,
    undefined,
    { Authorization: `Bearer ${serviceToken}`, Accept: "application/json" },
  );
};

const unwrapRecord = (value) => {
  if (!isObj(value)) return null;
  if (toStr(value.id || value.uuid || value.exerciseId || value.clientId)) return value;
  for (const key of ["data", "payload", "result"]) {
    if (isObj(value[key])) return unwrapRecord(value[key]) || value[key];
  }
  return value;
};

const extractItems = (value, seen = new Set()) => {
  if (Array.isArray(value)) return value;
  if (!isObj(value) || seen.has(value)) return [];
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings", "data", "payload", "result"]) {
    if (Array.isArray(value[key])) return value[key];
    const nested = extractItems(value[key], seen);
    if (nested.length > 0) return nested;
  }
  return [];
};

const hasBookingListShape = (value, seen = new Set()) => {
  if (Array.isArray(value)) return true;
  if (!isObj(value) || seen.has(value)) return false;
  seen.add(value);
  for (const key of ["content", "items", "records", "bookings"]) {
    if (Array.isArray(value[key])) return true;
  }
  return ["data", "payload", "result"].some((key) => hasBookingListShape(value[key], seen));
};

const hasCompleteBookingList = (value, seen = new Set()) => {
  if (Array.isArray(value)) return true;
  if (!isObj(value) || seen.has(value)) return false;
  seen.add(value);
  const listKey = ["content", "items", "records", "bookings"]
    .find((key) => Array.isArray(value[key]));
  if (listKey) {
    const items = value[listKey];
    const total = Number(value.totalElements ?? value.totalCount);
    const page = Number(value.number ?? value.page);
    const totalPages = Number(value.totalPages);
    if (Number.isFinite(total) && total > items.length) return false;
    if (value.last === false || value.hasNext === true) return false;
    if (Number.isFinite(page) && Number.isFinite(totalPages) && page + 1 < totalPages) return false;
    return true;
  }
  return ["data", "payload", "result"].some((key) => hasCompleteBookingList(value[key], seen));
};

const findArrayForKey = (value, targetKey, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (isObj(value) && Array.isArray(value[targetKey])) return value[targetKey];
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findArrayForKey(nested, targetKey, seen);
    if (found.length > 0) return found;
  }
  return [];
};

const findOwnedSubscription = (exercise, clientSubscriptionId) => {
  const target = normalizeId(clientSubscriptionId);
  return findArrayForKey(exercise, "availableClientSubscriptions")
    .find((item) => {
      if (!isObj(item)) return false;
      const explicitIds = [
        item.clientSubscriptionId,
        item.subscriptionId,
        item.clientSubId,
        item.clientSubscription?.id,
        item.clientSubscription?.clientSubscriptionId,
        item.clientSub?.id,
      ].map(normalizeId).filter(Boolean);
      if (explicitIds.length > 0) return explicitIds.includes(target);
      return [item.id, item.uuid].map(normalizeId).filter(Boolean).includes(target);
    }) || null;
};

const pickName = (value) => {
  if (!isObj(value)) return null;
  for (const key of ["subscriptionName", "productName", "name", "title", "displayName"]) {
    const candidate = toStr(value[key]);
    if (candidate) return candidate;
  }
  for (const key of ["subscription", "product", "template"]) {
    const nested = pickName(value[key]);
    if (nested) return nested;
  }
  return null;
};

const PLAN_PRODUCT_IDS = {
  friendship: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
  sport: "82caad6f-4d19-4d01-852b-932bdbb0f405",
  academy: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
  ra: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
};

const collectPlanMarkers = (value, seen = new Set()) => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => collectPlanMarkers(item, seen));
  const markers = [
    "productId", "subscriptionProductId", "planKey", "counterKey",
    "name", "title", "productName", "subscriptionName", "subscriptionProductName",
  ].flatMap((key) => collectPlanMarkers(value[key], seen));
  for (const key of ["subscription", "product", "template"]) {
    markers.push(...collectPlanMarkers(value[key], seen));
  }
  return markers;
};

const collectExactProductIds = (value) => {
  if (!isObj(value)) return [];
  const ids = [value.productId, value.subscriptionProductId, value.templateId]
    .map(normalizeId)
    .filter(Boolean);
  const addProductShapeIds = (nested) => {
    if (!isObj(nested)) return;
    ids.push(...[nested.id, nested.uuid, nested.productId].map(normalizeId).filter(Boolean));
  };
  addProductShapeIds(value.product);
  addProductShapeIds(value.template);
  if (isObj(value.subscription)) {
    ids.push(...[value.subscription.productId, value.subscription.subscriptionProductId]
      .map(normalizeId)
      .filter(Boolean));
    addProductShapeIds(value.subscription.product);
    addProductShapeIds(value.subscription.template);
  }
  return ids;
};

const resolveManagedEnforcementDecision = (value) => {
  const allowlist = readManagedEnforcementAllowlist();
  if (!allowlist.ok) return allowlist;
  const productIdentities = [...new Set(collectExactProductIds(value))].sort();
  if (productIdentities.length > 1) {
    return { ok: false, code: "SUBSCRIPTION_PRODUCT_IDENTITY_AMBIGUOUS" };
  }
  const productIdentity = productIdentities[0] || null;
  const exactProductId = productIdentity && UUID_PATTERN.test(productIdentity)
    ? productIdentity
    : null;
  const enabled = exactProductId === PITER_MANAGED_PRODUCT_ID
    && allowlist.productIds.includes(exactProductId);
  return {
    ok: true,
    configuredProductIds: allowlist.productIds,
    exactProductId,
    productIdentity,
    enabled,
    planKey: enabled ? "piter_friendship" : null,
  };
};

const compatibilityPlanKey = (planKey, managedEnforcement) => {
  if (managedEnforcement?.enabled === true) return managedEnforcement.planKey;
  if (["piter_friendship", "network_friendship"].includes(planKey)) return "friendship";
  return planKey;
};

const resolvePlanKey = (value) => {
  const markers = collectPlanMarkers(value);
  for (const [planKey, productId] of Object.entries(PLAN_PRODUCT_IDS)) {
    if (markers.some((marker) => normalizeId(marker) === productId)) return planKey;
  }
  const normalized = markers.map(normalizeMarker).filter(Boolean);
  if (normalized.some((marker) => (
    (marker.includes("котельник") || marker.includes("kotelniki") || marker.includes("kotelnik"))
    && (marker.includes("дружба") || marker.includes("friendship") || marker.includes("druzhba"))
  ))) return "kotelniki_friendship";
  if (normalized.some((marker) => (
    (marker.includes("питер") || marker.includes("piter") || marker.includes("spb"))
    && (marker.includes("дружба") || marker.includes("friendship") || marker.includes("druzhba"))
  ))) return "piter_friendship";
  if (normalized.some((marker) => (
    marker.includes("networkfriendship")
    || marker.includes("friendshipnetwork")
    || marker.includes("паделдружбахаб")
    || marker.includes("padldruzhbahub")
    || marker.includes("padlhubfriendship")
    || (marker.includes("всясеть") && marker.includes("дружба"))
  ))) return "network_friendship";
  if (normalized.some((marker) => marker.includes("friendship") || marker.includes("дружба") || marker.includes("druzhba"))) return "friendship";
  if (normalized.some((marker) => marker.includes("sport") || marker.includes("спорт"))) return "sport";
  if (normalized.some((marker) => marker.includes("academy") || marker.includes("академ"))) return "academy";
  if (normalized.some((marker) => marker === "ра" || marker === "ra" || marker.includes("летопаделра") || marker.includes("padelra"))) return "ra";
  return null;
};

const PLAN_CATEGORIES = {
  friendship: ["open_game", "tournament"],
  kotelniki_friendship: [],
  network_friendship: [],
  piter_friendship: [],
  sport: ["open_game", "tournament"],
  academy: ["open_game", "group_training"],
  ra: ["open_game", "group_training", "tournament"],
};
const MANAGED_PLAN_KEYS = new Set([
  "kotelniki_friendship",
  "piter_friendship",
]);

const resolveLimitMode = (planKey, serviceDate) => {
  if (!planKey) return "event";
  return serviceDate >= SHARED_LIMIT_FROM ? "shared_day" : "category_day";
};

const buildOperationKey = (ctx) => {
  if (ctx.managedEnforcement?.enabled === true) {
    return [
      "managed",
      ctx.tenantKey,
      ctx.clientSubscriptionId,
      ctx.exerciseId,
      ctx.managedAction,
    ].join(":");
  }
  const dailyKey = `${ctx.tenantKey}:${ctx.clientSubscriptionId}:${ctx.serviceDate}`;
  if (ctx.limitMode === "shared_day") return dailyKey;
  if (ctx.limitMode === "category_day") return `${dailyKey}:${ctx.category}`;
  return `${dailyKey}:${ctx.exerciseId}`;
};

const numericId = (value) => {
  if (isObj(value)) return Number(value.id ?? value.uuid ?? value.value);
  return Number(value);
};
const markerName = (value) => (isObj(value) ? toStr(value.name || value.title || value.label) : toStr(value));

const managedExternalEventTypeId = (value) => {
  const exercise = isObj(value?.exercise) ? value.exercise : value;
  if (!isObj(exercise)) return null;
  const type = exercise.type || exercise.exerciseType || exercise.serviceType || value?.exerciseType;
  const direction = exercise.direction || exercise.exerciseDirection || value?.exerciseDirection;
  const typeId = numericId(type ?? exercise.typeId ?? value?.exerciseTypeId);
  const directionId = numericId(direction ?? exercise.directionId ?? value?.exerciseDirectionId);
  if (!Number.isInteger(directionId) || directionId <= 0 || !Number.isInteger(typeId) || typeId <= 0) {
    return null;
  }
  return `viva:direction:${directionId}:type:${typeId}`;
};

const resolveCategory = (value) => {
  const exercise = isObj(value?.exercise) ? value.exercise : value;
  if (!isObj(exercise)) return null;
  const type = exercise.type || exercise.exerciseType || exercise.serviceType || value?.exerciseType;
  const direction = exercise.direction || exercise.exerciseDirection || value?.exerciseDirection;
  const typeId = numericId(type ?? exercise.typeId ?? value?.exerciseTypeId);
  const directionId = numericId(direction ?? exercise.directionId ?? value?.exerciseDirectionId);
  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";
  if ([839, 1013].includes(typeId) || [2617, 3284, 4769].includes(directionId)) return "tournament";
  if ([605, 847, 963, 1208].includes(typeId)) return "group_training";
  const markers = [markerName(type), markerName(direction), exercise.name, exercise.title]
    .map(normalizeMarker)
    .filter(Boolean);
  if (markers.some((item) => /турнир|tournament|американо|americano|мексикано|mexicano/.test(item))) return "tournament";
  if (markers.some((item) => /трен|training|coach|групп|group|игратренер/.test(item))) return "group_training";
  if (markers.some((item) => /свояигра|открытаяигра|opengame|сплит|split|игра|game/.test(item))) return "open_game";
  return null;
};

const eventDate = (value) => {
  if (!isObj(value)) return normalizeDate(value);
  for (const key of [
    "date", "bookingDate", "exerciseDate", "serviceDate", "visitDate", "startsAt", "startAt", "timeFrom", "fromTime",
  ]) {
    const normalized = normalizeDate(value[key]);
    if (normalized) return normalized;
  }
  for (const key of ["exercise", "event", "tournament"]) {
    const nested = eventDate(value[key]);
    if (nested) return nested;
  }
  return null;
};

const finiteDate = (value) => {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date : null;
};

const eventStartsAt = (exercise) => {
  if (!isObj(exercise)) return null;
  for (const value of [exercise.timeFrom, exercise.startsAt, exercise.startAt, exercise.fromTime]) {
    const date = finiteDate(value);
    if (date) return date.toISOString();
  }
  return null;
};

const eventDurationMinutes = (exercise) => {
  if (!isObj(exercise)) return null;
  const explicit = Number(exercise.durationMinutes ?? exercise.duration);
  if (Number.isInteger(explicit) && explicit > 0 && explicit <= 1440) return explicit;
  const from = finiteDate(exercise.timeFrom || exercise.startsAt || exercise.startAt);
  const to = finiteDate(exercise.timeTo || exercise.endsAt || exercise.endAt);
  if (from && to) {
    const minutes = Math.round((to.getTime() - from.getTime()) / 60000);
    if (minutes > 0 && minutes <= 1440) return minutes;
  }
  const parseClock = (value) => {
    const match = String(value || "").match(/(?:^|T)(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const startMinutes = parseClock(exercise.timeFrom || exercise.startsAt);
  const endMinutes = parseClock(exercise.timeTo || exercise.endsAt);
  if (startMinutes === null || endMinutes === null) return null;
  const minutes = endMinutes > startMinutes
    ? endMinutes - startMinutes
    : endMinutes + 1440 - startMinutes;
  return minutes > 0 && minutes <= 1440 ? minutes : null;
};

const managedActionForTarget = (ctx) => {
  if (["CREATE_GAME", "JOIN_GAME"].includes(ctx.managedAction)) return ctx.managedAction;
  if (ctx.category === "group_training") return "BOOK_GROUP_TRAINING";
  if (ctx.category === "tournament") return "BOOK_TOURNAMENT";
  return null;
};

const managedTargetCategory = (category) => ({
  open_game: "GAME",
  group_training: "GROUP_TRAINING",
  tournament: "TOURNAMENT",
}[category] || null);

const bookingExercise = (value) => (isObj(value?.exercise) ? value.exercise : null);
const bookingId = (value) => toStr(value?.id || value?.bookingId || value?.uuid);
const bookingExerciseId = (value) => {
  const exercise = bookingExercise(value);
  return toStr(exercise?.id || exercise?.uuid || value?.exerciseId || value?.vivaExerciseId || value?.eventId);
};
const bookingSubscriptionId = (value) => {
  const subscription = isObj(value?.subscription)
    ? value.subscription
    : isObj(value?.clientSubscription)
      ? value.clientSubscription
      : null;
  return toStr(
    value?.clientSubscriptionId
    || value?.subscriptionId
    || value?.clientSubId
    || subscription?.clientSubscriptionId
    || subscription?.subscriptionId
    || subscription?.id
    || subscription?.uuid,
  );
};
const bookingClientId = (value) => toStr(
  value?.clientId
  || value?.client?.id
  || value?.client?.clientId
  || value?.playerId
  || value?.userId,
);
const isSubscriptionBooking = (value) => {
  const paymentType = String(value?.paymentType || value?.paymentMethod || "").trim().toUpperCase();
  return paymentType === "SUBSCRIPTION" || Boolean(bookingSubscriptionId(value));
};
const isInactiveBooking = (value) => {
  if (!isObj(value)) return true;
  const exercise = bookingExercise(value);
  if (
    value.isCancelled === true
    || value.cancelled === true
    || value.canceled === true
    || value.archived === true
    || toStr(value.cancellationDate)
    || toStr(value.cancelledAt)
    || exercise?.isCancelled === true
    || exercise?.cancelled === true
    || exercise?.canceled === true
    || exercise?.archived === true
  ) return true;
  const statuses = [
    value.status,
    value.state,
    value.bookingStatus,
    value.cancellationReason,
    exercise?.status,
    exercise?.state,
    value.transactionStatus?.transactionStatus,
    value.transactionStatus?.cardPaymentStatus?.status,
    value.transactionStatus?.cardPaymentStatus?.originalStatus,
  ];
  return statuses.some((status) => /CANCEL|DECLIN|FAIL|ERROR|EXPIRE|REFUND|REJECT|VOID|ARCHIVE|REMOV/i.test(String(status || "")));
};

const mergeBookings = (activePayload, historyPayload) => {
  const byId = new Map();
  const withoutId = [];
  [...extractItems(activePayload), ...extractItems(historyPayload)].forEach((booking) => {
    if (!isObj(booking)) return;
    const id = bookingId(booking);
    if (!id) {
      withoutId.push(booking);
      return;
    }
    const previous = byId.get(id);
    byId.set(id, previous ? { ...previous, ...booking } : booking);
  });
  return [...byId.values(), ...withoutId];
};

const eventSummary = (booking) => {
  const exercise = bookingExercise(booking) || {};
  const studio = isObj(exercise.studio) ? exercise.studio : isObj(booking.studio) ? booking.studio : {};
  const from = toStr(exercise.timeFrom || booking.timeFrom || booking.fromTime);
  const to = toStr(exercise.timeTo || booking.timeTo || booking.toTime);
  return {
    bookingId: bookingId(booking),
    exerciseId: bookingExerciseId(booking),
    title: toStr(exercise.name || exercise.title || booking.serviceName || booking.title || booking.name) || "событие",
    date: eventDate(booking),
    timeFrom: from,
    timeTo: to,
    timeLabel: [from?.match(/\d{2}:\d{2}/)?.[0], to?.match(/\d{2}:\d{2}/)?.[0]].filter(Boolean).join("–"),
    studioName: toStr(studio.name || booking.studioName || booking.stationName),
    category: resolveCategory(booking),
  };
};

const cancelledBookingRef = (booking) => ({
  bookingId: bookingId(booking),
  exerciseId: bookingExerciseId(booking),
});

const operationHasConfirmedCancellation = (operation, cancelledBookings) => {
  if (!isObj(operation)) return false;
  const operationBookingId = normalizeId(operation.bookingId || operation.upstreamBookingId);
  const operationExerciseId = normalizeId(operation.exerciseId);
  return asArray(cancelledBookings).some((booking) => {
    if (!isObj(booking)) return false;
    const cancelledBookingId = normalizeId(booking.bookingId);
    const cancelledExerciseId = normalizeId(booking.exerciseId);
    if (operationBookingId) return Boolean(cancelledBookingId === operationBookingId);
    return Boolean(operationExerciseId && cancelledExerciseId === operationExerciseId);
  });
};

const findNumber = (value, keys, seen = new Set()) => {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of keys) {
    const numeric = Number(value[key]);
    if (Number.isFinite(numeric)) return numeric;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findNumber(nested, keys, seen);
    if (found !== null) return found;
  }
  return null;
};

const mongoMatched = (value) => findNumber(value, ["matchedCount", "modifiedCount", "upsertedCount"]);
const mongoInserted = (value) => {
  if (findNumber(value, ["insertedCount"]) > 0) return true;
  if (isObj(value) && (value.insertedId || value.acknowledged === true)) return true;
  if (Array.isArray(value)) return value.some(mongoInserted);
  return false;
};

const prepareOperationFind = (ctx, query = { _id: ctx.operationKey }) => {
  ctx.step = "operation_find";
  msg._subscriptionBooking = ctx;
  msg.payload = query;
  delete msg.error;
  return emit(OUTPUT_MONGO_FIND);
};

const prepareOperationRelease = (ctx, operation) => {
  const nowIso = new Date().toISOString();
  ctx.releaseOperationKey = toStr(operation._id);
  ctx.releasePreviousState = toStr(operation.state);
  ctx.managedEntitlementOperationId = toStr(operation.managedEntitlementOperationId)
    || ctx.managedEntitlementOperationId
    || null;
  ctx.managedSubscriptionInstanceId = toStr(operation.managedSubscriptionInstanceId)
    || ctx.managedSubscriptionInstanceId
    || null;
  return prepareMongoUpdate(ctx, "operation_release", {
    _id: operation._id,
    state: operation.state,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    serviceDate: ctx.serviceDate,
    releasedBookingIds: { $ne: ctx.releaseBookingId },
  }, {
    $set: {
      state: "RELEASED",
      releasedAt: nowIso,
      releaseBookingId: ctx.releaseBookingId,
      updatedAt: nowIso,
    },
    $addToSet: { releasedBookingIds: ctx.releaseBookingId },
    $unset: {
      leaseUntil: "",
      pendingUntil: "",
      failure: "",
      failedAt: "",
    },
  });
};

const prepareMongoUpdate = (ctx, step, query, update) => {
  ctx.step = step;
  msg._subscriptionBooking = ctx;
  msg.payload = [query, update, {}];
  delete msg.error;
  return emit(OUTPUT_MONGO_UPDATE);
};

const preparePreaccept = (ctx) => {
  const now = new Date();
  return prepareMongoUpdate(ctx, "operation_preaccept", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PREPARED",
  }, {
    $set: {
      state: "PENDING_CONFIRMATION",
      upstreamAttemptedAt: now.toISOString(),
      pendingUntil: new Date(now.getTime() + PENDING_CONFIRMATION_MS).toISOString(),
      updatedAt: now.toISOString(),
    },
    $inc: { attempts: 1 },
    $unset: { leaseUntil: "" },
  });
};

const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {
  _id: ctx.operationKey,
  operationId: operation.operationId ?? null,
  state: operation.state,
}, {
  $set: {
    operationId: ctx.operationId,
    actorClientId: ctx.actorClientId,
    exerciseId: ctx.exerciseId,
    category: ctx.category,
    planKey: ctx.planKey || null,
    limitMode: ctx.limitMode,
    managedDecision: ctx.managedDecision || null,
    activationState: ctx.managedActivationRequired ? "PENDING" : "NOT_REQUIRED",
    state: "PREPARED",
    attempts: 0,
    leaseUntil: new Date(now.getTime() + PREPARED_LEASE_MS).toISOString(),
    updatedAt: now.toISOString(),
  },
  $unset: {
    bookingId: "",
    confirmedAt: "",
    pendingUntil: "",
    failure: "",
    failedAt: "",
    correlationId: "",
    acceptedAt: "",
    upstreamBookingId: "",
    releaseBookingId: "",
    releasedAt: "",
    managedEntitlementOperationId: "",
    managedSubscriptionInstanceId: "",
    managedEntitlementState: "",
    managedEntitlementConfirmedAt: "",
  },
});

const prepareExpiredPendingRelease = (ctx, operation) => {
  const nowIso = new Date().toISOString();
  ctx.expiredPendingOperation = operation;
  return prepareMongoUpdate(ctx, "operation_expired_pending_release", {
    _id: operation._id,
    operationId: operation.operationId,
    state: "PENDING_CONFIRMATION",
    pendingUntil: operation.pendingUntil,
    $and: [
      { $or: [{ bookingId: { $exists: false } }, { bookingId: null }, { bookingId: "" }] },
      { $or: [{ upstreamBookingId: { $exists: false } }, { upstreamBookingId: null }, { upstreamBookingId: "" }] },
    ],
  }, {
    $set: {
      state: "RELEASED",
      releasedAt: nowIso,
      updatedAt: nowIso,
      reconciliation: {
        source: "expired_pending_viva_readback",
        decision: "SAFE_TO_RELEASE",
        reconciledAt: nowIso,
      },
    },
    $unset: { pendingUntil: "", leaseUntil: "" },
  });
};

const prepareExpiredPendingReconciliation = (ctx, operation) => {
  ctx.expiredPendingOperation = operation;
  return prepareAdminGet(
    ctx,
    "expired_pending_reconciliation",
    `/api/v1/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings?showCancelled=true&size=200`,
  );
};

const prepareConfirmedUpdate = (ctx, booking) => {
  const nowIso = new Date().toISOString();
  ctx.confirmedBookingId = bookingId(booking) || ctx.immediateBookingId || null;
  ctx.confirmedSpot = Number(booking?.spot) || ctx.spot || null;
  return prepareMongoUpdate(ctx, "operation_confirm", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
  }, {
    $set: {
      state: "CONFIRMED",
      bookingId: ctx.confirmedBookingId,
      exerciseId: ctx.exerciseId,
      confirmedAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { pendingUntil: "", failure: "" },
  });
};

const prepareActivationConfirmedUpdate = (ctx, activation) => {
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, "operation_activation_confirm", {
    _id: ctx.operationKey,
    operationId: ctx.activationOperationId || ctx.operationId,
    state: "CONFIRMED",
    activationState: "PENDING",
  }, {
    $set: {
      activationState: "CONFIRMED",
      activationOutcome: activation.outcome,
      activationRevision: activation.revision,
      activationConfirmedAt: nowIso,
      updatedAt: nowIso,
    },
  });
};

const prepareFailedUpdate = (ctx, statusCode, message, rawCode) => {
  const nowIso = new Date().toISOString();
  ctx.finalFailure = { statusCode, message, rawCode: rawCode || null };
  return prepareMongoUpdate(ctx, "operation_fail", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
  }, {
    $set: {
      state: "FAILED",
      failure: ctx.finalFailure,
      failedAt: nowIso,
      updatedAt: nowIso,
    },
    $unset: { pendingUntil: "" },
  });
};

const extractCorrelationId = (value) => {
  if (!isObj(value)) return null;
  return toStr(value.correlationId || value.requestId || value.operationId)
    || extractCorrelationId(value.data)
    || extractCorrelationId(value.payload);
};

const serviceTokenAvailable = () => {
  try {
    return Boolean(toStr(global.get("vivacrm_access_token")));
  } catch {
    return false;
  }
};

const prepareBookingCreate = (ctx) => {
  let serviceToken = null;
  try {
    serviceToken = toStr(global.get("vivacrm_access_token"));
  } catch {
    serviceToken = null;
  }
  if (!serviceToken) {
    if (ctx.managedEntitlementOperationId) {
      ctx.finalFailure = {
        statusCode: 503,
        message: "Сервисный токен Viva временно недоступен",
        rawCode: "VIVA_SERVICE_TOKEN_UNAVAILABLE",
      };
      ctx.entitlementReleaseNext = "persist_failure";
      return prepareManagedEntitlementRelease(ctx, "PROVIDER_REJECTED");
    }
    return prepareFailedUpdate(ctx, 503, "Сервисный токен Viva временно недоступен", "VIVA_SERVICE_TOKEN_UNAVAILABLE");
  }
  const payload = {
    clientId: ctx.actorClientId,
    phone: ctx.actorPhone ? `+${ctx.actorPhone}` : undefined,
    paymentType: "SUBSCRIPTION",
    clientSubscriptionId: ctx.clientSubscriptionId,
    customFields: [],
  };
  if (ctx.spot) payload.spot = ctx.spot;
  const subscriptionVisitCount = Math.floor(Number(ctx.subscriptionVisitCount));
  if (ctx.caller === "split" && subscriptionVisitCount >= 1 && subscriptionVisitCount <= 2) {
    payload.count = subscriptionVisitCount;
  }
  const adminVersion = ctx.caller === "split" ? "v1" : "v2";
  return prepareHttp(
    ctx,
    "booking_create",
    "POST",
    `${VIVA_API_BASE}/api/${adminVersion}/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`,
    payload,
    {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  );
};

const prepareManagedPolicyEvaluation = (ctx, step) => {
  ctx.step = step;
  const evaluatedAt = new Date().toISOString();
  const policyInstance = ctx.managedActivationRequired
    ? projectedFirstUseInstance(
      ctx.managedRuntime.instance,
      ctx.managedRuntime.policy.lifecycle,
      evaluatedAt,
    )
    : ctx.managedRuntime.instance;
  if (!policyInstance) {
    if (step === "managed_policy_recheck_decision") {
      return prepareFailedUpdate(
        ctx,
        409,
        "Нельзя безопасно рассчитать период первой активации",
        "SUBSCRIPTION_ACTIVATION_RANGE_INVALID",
      );
    }
    return finishError(ctx, 409, "Нельзя безопасно рассчитать период первой активации", {
      code: "SUBSCRIPTION_ACTIVATION_RANGE_INVALID",
    });
  }
  msg._subscriptionBooking = ctx;
  msg._managedSubscriptionPolicyInput = {
    evaluatedAt,
    action: ctx.managedAction,
    policy: ctx.managedRuntime.policy,
    instance: policyInstance,
    target: ctx.managedTarget,
    usage: {
      activeServiceScope: ctx.managedRuntime.policy.activeServicesLimit?.scope
        || "SUBSCRIPTION_BENEFIT_ONLY",
      dailyBucketLocalDate: ctx.serviceDate,
      activeServices: 0,
      dailyUsed: 0,
      weeklyUsed: 0,
      monthlyUsed: 0,
      futureBookings: 0,
      activeServiceStartsAt: [],
    },
  };
  delete msg.error;
  return emit(OUTPUT_MANAGED_POLICY);
};

const ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;
if (!ctx) {
  return finishError({}, 500, "Контекст серверной записи по абонементу потерян", {
    code: "SUBSCRIPTION_BOOKING_CONTEXT_MISSING",
  });
}

if (ctx.step === "profile") {
  if (!isHttpOk(msg.statusCode)) {
    const profileStatus = Number(msg.statusCode);
    const responseStatus = profileStatus >= 400 && profileStatus < 500 ? profileStatus : 502;
    return finishError(ctx, responseStatus, "Не удалось подтвердить профиль Viva", {
      code: "SUBSCRIPTION_BOOKING_PROFILE_UNAVAILABLE",
    });
  }
  const profile = unwrapRecord(msg.payload);
  ctx.actorClientId = toStr(profile?.id || profile?.clientId);
  ctx.actorPhone = normalizePhone(profile?.phone || profile?.phoneNumber || profile?.mobile);
  if (!ctx.actorClientId || !ctx.actorPhone) {
    return finishError(ctx, 502, "Профиль Viva не содержит устойчивую идентичность", {
      code: "SUBSCRIPTION_BOOKING_PROFILE_INCOMPLETE",
    });
  }
  if (ctx.action === "release") {
    return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
  }
  return prepareUserGet(
    ctx,
    "exercise",
    `/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`,
  );
}

if (ctx.step === "exercise") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, Number(msg.statusCode) || 502, "Не удалось получить упражнение Viva", {
      code: "SUBSCRIPTION_BOOKING_EXERCISE_UNAVAILABLE",
    });
  }
  const exercise = unwrapRecord(msg.payload);
  const actualExerciseId = toStr(exercise?.id || exercise?.exerciseId || exercise?.uuid);
  if (!exercise || normalizeId(actualExerciseId) !== normalizeId(ctx.exerciseId)) {
    return finishError(ctx, 409, "Упражнение Viva не совпало с целью записи", {
      code: "SUBSCRIPTION_BOOKING_EXERCISE_MISMATCH",
    });
  }
  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);
  if (!ownedSubscription) {
    return finishError(ctx, 409, "Выбранный абонемент недоступен этому пользователю для упражнения", {
      code: "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
    });
  }
  ctx.serviceDate = eventDate(exercise);
  ctx.category = resolveCategory(exercise);
  ctx.studioId = toStr(exercise.studio?.id || exercise.studioId);
  ctx.subscriptionName = pickName(ownedSubscription);
  const managedEnforcement = resolveManagedEnforcementDecision(ownedSubscription);
  if (!managedEnforcement.ok) {
    const configInvalid = managedEnforcement.code === "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID";
    return finishError(
      ctx,
      configInvalid ? 503 : 409,
      configInvalid
        ? "Конфигурация управляемой подписки временно недоступна"
        : "Нельзя однозначно определить продукт выбранной подписки",
      { code: managedEnforcement.code },
    );
  }
  ctx.managedEnforcement = {
    source: "SERVER_GLOBAL_ALLOWLIST",
    configuredProductIds: managedEnforcement.configuredProductIds,
    exactProductId: managedEnforcement.exactProductId,
    productIdentity: managedEnforcement.productIdentity,
    enabled: managedEnforcement.enabled,
    planKey: managedEnforcement.planKey,
  };
  const resolvedPlanKey = resolvePlanKey(ownedSubscription) || resolvePlanKey(ctx.subscriptionName);
  ctx.planKey = compatibilityPlanKey(resolvedPlanKey, managedEnforcement);
  if (MANAGED_PLAN_KEYS.has(ctx.planKey)) {
    if (ctx.planKey === "kotelniki_friendship") {
      return finishError(ctx, 409, "Подписка Котельников ещё не подключена к правилам записи", {
        code: "MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED",
        planKey: ctx.planKey,
      });
    }
    ctx.managedAction = managedActionForTarget(ctx);
    ctx.managedTarget = {
      resolutionSource: "SERVER",
      stationId: ctx.studioId,
      category: managedTargetCategory(ctx.category),
      externalEventTypeId: managedExternalEventTypeId(exercise),
      productTypeId: null,
      eventId: actualExerciseId,
      durationMinutes: eventDurationMinutes(exercise),
      startsAt: eventStartsAt(exercise),
      basePriceMinor: null,
      currency: "RUB",
    };
    if (!ctx.managedAction || !ctx.managedTarget.stationId || !ctx.managedTarget.category
      || !ctx.managedTarget.externalEventTypeId || !ctx.managedTarget.durationMinutes
      || !ctx.managedTarget.startsAt) {
      return finishError(ctx, 409, "Нельзя безопасно определить действие и параметры подписки", {
        code: "MANAGED_SUBSCRIPTION_TARGET_UNRESOLVED",
        planKey: ctx.planKey,
      });
    }
    ctx.limitMode = "shared_day";
    ctx.trackedDailyLimit = true;
    return prepareManagedRuntimeContext(ctx);
  }
  if (!ctx.serviceDate || !ctx.category) {
    return finishError(ctx, 502, "Не удалось определить дату или категорию упражнения Viva", {
      code: "SUBSCRIPTION_BOOKING_TARGET_UNRESOLVED",
    });
  }
  if (ctx.planKey && !PLAN_CATEGORIES[ctx.planKey].includes(ctx.category)) {
    return finishError(ctx, 409, "Этот абонемент не разрешён для выбранной категории", {
      code: "SUBSCRIPTION_CATEGORY_NOT_ALLOWED",
      category: ctx.category,
      planKey: ctx.planKey,
    });
  }

  const nameMarker = normalizeMarker(ctx.subscriptionName);
  const isKnownUntrackedPlan = nameMarker.includes("энерг") || nameMarker.includes("energy");
  if (!ctx.planKey && !isKnownUntrackedPlan) {
    ctx.serverTarget = {
      resolutionSource: "SERVER",
      stationId: ctx.studioId,
      category: managedTargetCategory(ctx.category),
      externalEventTypeId: managedExternalEventTypeId(exercise),
      productTypeId: null,
      eventId: actualExerciseId,
      durationMinutes: eventDurationMinutes(exercise),
      startsAt: eventStartsAt(exercise),
      basePriceMinor: null,
      currency: "RUB",
    };
    const search = `?type=get_sub_name&phone=${encodeURIComponent(ctx.actorPhone)}&subId=${encodeURIComponent(ctx.clientSubscriptionId)}`;
    return prepareHttp(ctx, "subscription_name", "GET", `${SERV2_URL}${search}`, undefined, {
      Accept: "application/json",
    });
  }
  ctx.limitMode = resolveLimitMode(ctx.planKey, ctx.serviceDate);
  ctx.trackedDailyLimit = ctx.limitMode !== "event";
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "subscription_name") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось подтвердить тип выбранного абонемента", {
      code: "SUBSCRIPTION_PLAN_LOOKUP_FAILED",
    });
  }
  const payload = unwrapRecord(msg.payload) || msg.payload;
  ctx.subscriptionName = toStr(payload?.sertName || payload?.subscriptionName || payload?.name);
  const resolvedPlanKey = resolvePlanKey(payload) || resolvePlanKey(ctx.subscriptionName);
  ctx.planKey = compatibilityPlanKey(resolvedPlanKey, ctx.managedEnforcement);
  if (MANAGED_PLAN_KEYS.has(ctx.planKey)) {
    if (ctx.planKey === "kotelniki_friendship") {
      return finishError(ctx, 409, "Подписка Котельников ещё не подключена к правилам записи", {
        code: "MANAGED_SUBSCRIPTION_PLAN_NOT_ACTIVATED",
        planKey: ctx.planKey,
      });
    }
    ctx.managedAction = managedActionForTarget(ctx);
    ctx.managedTarget = ctx.serverTarget;
    delete ctx.serverTarget;
    if (!ctx.managedAction || !isObj(ctx.managedTarget)
      || !ctx.managedTarget.stationId || !ctx.managedTarget.category
      || !ctx.managedTarget.externalEventTypeId || !ctx.managedTarget.durationMinutes
      || !ctx.managedTarget.startsAt) {
      return finishError(ctx, 409, "Нельзя безопасно определить действие и параметры подписки", {
        code: "MANAGED_SUBSCRIPTION_TARGET_UNRESOLVED",
        planKey: ctx.planKey,
      });
    }
    ctx.limitMode = "shared_day";
    ctx.trackedDailyLimit = true;
    return prepareManagedRuntimeContext(ctx);
  }
  delete ctx.serverTarget;
  if (!ctx.subscriptionName) {
    return finishError(ctx, 502, "Источник не вернул тип выбранного абонемента", {
      code: "SUBSCRIPTION_PLAN_UNRESOLVED",
    });
  }
  if (ctx.planKey && !PLAN_CATEGORIES[ctx.planKey].includes(ctx.category)) {
    return finishError(ctx, 409, "Этот абонемент не разрешён для выбранной категории", {
      code: "SUBSCRIPTION_CATEGORY_NOT_ALLOWED",
      category: ctx.category,
      planKey: ctx.planKey,
    });
  }
  ctx.limitMode = resolveLimitMode(ctx.planKey, ctx.serviceDate);
  ctx.trackedDailyLimit = ctx.limitMode !== "event";
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "exercise_recheck") {
  if (!isHttpOk(msg.statusCode)) {
    return prepareFailedUpdate(
      ctx,
      409,
      "Не удалось повторно подтвердить доступность подписки перед записью",
      "SUBSCRIPTION_ELIGIBILITY_RECHECK_UNAVAILABLE",
    );
  }
  const exercise = unwrapRecord(msg.payload);
  const actualExerciseId = toStr(exercise?.id || exercise?.exerciseId || exercise?.uuid);
  const ownedSubscription = findOwnedSubscription(exercise, ctx.clientSubscriptionId);
  if (!exercise || !ownedSubscription) {
    return prepareFailedUpdate(
      ctx,
      409,
      "Доступность или параметры подписки изменились до записи",
      "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE",
    );
  }
  const nextManagedEnforcement = resolveManagedEnforcementDecision(ownedSubscription);
  if (!nextManagedEnforcement.ok) {
    return prepareFailedUpdate(
      ctx,
      nextManagedEnforcement.code === "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONFIG_INVALID" ? 503 : 409,
      "Нельзя повторно подтвердить rollout управляемой подписки",
      nextManagedEnforcement.code,
    );
  }
  const previousManagedEnforcement = ctx.managedEnforcement;
  if (!isObj(previousManagedEnforcement)
    || previousManagedEnforcement.productIdentity !== nextManagedEnforcement.productIdentity
    || previousManagedEnforcement.exactProductId !== nextManagedEnforcement.exactProductId) {
    return prepareFailedUpdate(
      ctx,
      409,
      "Продукт подписки изменился до записи",
      "SUBSCRIPTION_PRODUCT_IDENTITY_CHANGED_BEFORE_WRITE",
    );
  }
  if (previousManagedEnforcement.enabled !== nextManagedEnforcement.enabled
    || previousManagedEnforcement.planKey !== nextManagedEnforcement.planKey) {
    return prepareFailedUpdate(
      ctx,
      409,
      "Rollout управляемой подписки изменился до записи",
      "MANAGED_SUBSCRIPTION_ENFORCEMENT_CHANGED_BEFORE_WRITE",
    );
  }
  const resolvedPlanKey = resolvePlanKey(ownedSubscription) || resolvePlanKey(ctx.subscriptionName);
  const nextPlanKey = compatibilityPlanKey(resolvedPlanKey, nextManagedEnforcement);
  const nextServiceDate = eventDate(exercise);
  const nextCategory = resolveCategory(exercise);
  const nextStudioId = toStr(exercise?.studio?.id || exercise?.studioId);
  const managedIdentityMatches = previousManagedEnforcement.enabled !== true || (
    nextManagedEnforcement.exactProductId === PITER_MANAGED_PRODUCT_ID
    && ctx.planKey === "piter_friendship"
    && managedExternalEventTypeId(exercise) === ctx.managedTarget?.externalEventTypeId
    && eventDurationMinutes(exercise) === ctx.managedTarget?.durationMinutes
    && eventStartsAt(exercise) === ctx.managedTarget?.startsAt
  );
  if (normalizeId(actualExerciseId) !== normalizeId(ctx.exerciseId)
    || nextPlanKey !== ctx.planKey
    || nextServiceDate !== ctx.serviceDate
    || nextCategory !== ctx.category
    || normalizeId(nextStudioId) !== normalizeId(ctx.studioId)
    || !managedIdentityMatches) {
    return prepareFailedUpdate(
      ctx,
      409,
      "Доступность или параметры подписки изменились до записи",
      "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE",
    );
  }
  if (previousManagedEnforcement.enabled === true) {
    return prepareManagedRuntimeContext(ctx, "managed_runtime_recheck");
  }
  return prepareBookingCreate(ctx);
}

if (["managed_runtime_context", "managed_runtime_recheck"].includes(ctx.step)) {
  const isRecheck = ctx.step === "managed_runtime_recheck";
  const rejectRuntime = (statusCode, error, details) => (
    isRecheck
      ? prepareFailedUpdate(ctx, statusCode, error, details?.code)
      : finishError(ctx, statusCode, error, details)
  );
  if (ctx.managedEnforcement?.enabled !== true
    || ctx.managedEnforcement.exactProductId !== PITER_MANAGED_PRODUCT_ID
    || ctx.planKey !== "piter_friendship") {
    return rejectRuntime(409, "Контекст управляемой подписки не подтверждён", {
      code: "MANAGED_SUBSCRIPTION_ENFORCEMENT_CONTEXT_INVALID",
    });
  }
  if (!isHttpOk(msg.statusCode)) {
    return rejectRuntime(409, "Опубликованные правила подписки сейчас недоступны", {
      code: "MANAGED_SUBSCRIPTION_RUNTIME_CONTEXT_UNAVAILABLE",
      upstreamStatus: Number(msg.statusCode) || null,
    });
  }
  const runtime = unwrapRecord(msg.payload);
  const policy = runtime?.policy;
  const instance = runtime?.instance;
  if (!runtime || runtime.schemaVersion !== 1
    || normalizeId(runtime.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)
    || !toStr(runtime.subscriptionInstanceId) || !toStr(runtime.policyDigest)
    || !isObj(policy) || !isObj(instance)
    || runtime.subscriptionInstanceId !== instance.subscriptionInstanceId
    || policy.policyVersion !== instance.policyVersion
    || !Number.isInteger(runtime.evidence?.instanceRevision)
    || policy.subscriptionTypeId !== instance.subscriptionTypeId) {
    return rejectRuntime(502, "ЦУП вернул несогласованный контекст подписки", {
      code: "MANAGED_SUBSCRIPTION_RUNTIME_CONTEXT_INVALID",
    });
  }
  const unsupportedUsage = Number(policy.usage?.minHoursBetweenUses || 0) !== 0
    || Number(policy.dailyUsageLimit) !== 1
    || ["60", "90", "120"].some((key) => Number(policy.usageUnitsByDuration?.[key]) !== 1);
  const createDurations = Array.isArray(policy.createGame?.durationsMinutes)
    ? policy.createGame.durationsMinutes.map(Number).sort((left, right) => left - right)
    : [];
  const enabledStationRules = Array.isArray(policy.stationAccessRules)
    ? policy.stationAccessRules.filter((rule) => rule?.enabled === true)
    : [];
  const stationPolicySupported = ctx.planKey === "piter_friendship"
    && enabledStationRules.length > 0 && enabledStationRules.every((rule) => (
      rule.selector?.kind === "STATION_LIST"
      && Array.isArray(rule.selector.stationIds)
      && rule.selector.stationIds.length === 1
      && normalizeId(rule.selector.stationIds[0]) === normalizeId(PITER_STATION_ID)
      && rule.surcharge?.kind === "NONE"
    ));
  const regionalLifecycleSupported = policy.lifecycle?.activationMode === REGIONAL_ACTIVATION_MODE
    && Number.isInteger(policy.lifecycle?.activationWindowDays)
    && policy.lifecycle.activationWindowDays === 0
    && toStr(policy.lifecycle?.fixedActivationAt) === REGIONAL_ACTIVATION_FALLBACK_AT
    && policy.lifecycle?.fixedActivationTimeZone === REGIONAL_ACTIVATION_TIME_ZONE
    && Number.isInteger(policy.lifecycle?.validityDays)
    && policy.lifecycle.validityDays === REGIONAL_VALIDITY_DAYS
    && policy.lifecycle?.allowBookingsAfterExpiry === false;
  const regionalRulesUnsupported = policy.createGame?.enabled !== true
    || createDurations.length !== 3
    || createDurations.some((duration, index) => duration !== [60, 90, 120][index])
    || policy.joinGame?.enabled !== true
    || Number(policy.joinGame?.minDurationMinutes) !== 60
    || Number(policy.joinGame?.maxDurationMinutes) !== 120
    || !stationPolicySupported
    || !regionalLifecycleSupported;
  if (unsupportedUsage || regionalRulesUnsupported) {
    return rejectRuntime(409, "Эта версия правил требует ещё не подключённого счётчика", {
      code: "MANAGED_SUBSCRIPTION_POLICY_UNSUPPORTED",
      policyVersion: policy.policyVersion ?? null,
    });
  }
  const pendingFirstUse = instance.state === "PENDING_ACTIVATION"
    && instance.activeFrom === null
    && instance.activeTo === null;
  if (pendingFirstUse && !managedActivationConfigured()) {
    return rejectRuntime(503, "Активация подписки после первой записи ещё не настроена", {
      code: "SUBSCRIPTION_ACTIVATION_NOT_CONFIGURED",
    });
  }
  const nextManagedRuntime = {
    subscriptionInstanceId: runtime.subscriptionInstanceId,
    policyDigest: runtime.policyDigest,
    policy,
    instance,
    evidence: runtime.evidence || null,
  };
  if (isRecheck) {
    const previous = ctx.managedRuntime;
    const identityChanged = !isObj(previous)
      || previous.subscriptionInstanceId !== nextManagedRuntime.subscriptionInstanceId
      || previous.policyDigest !== nextManagedRuntime.policyDigest
      || previous.policy?.policyVersion !== nextManagedRuntime.policy?.policyVersion
      || previous.instance?.subscriptionTypeId !== nextManagedRuntime.instance?.subscriptionTypeId
      || previous.evidence?.instanceRevision !== nextManagedRuntime.evidence?.instanceRevision
      || ctx.managedActivationRequired !== pendingFirstUse;
    if (identityChanged) {
      return prepareFailedUpdate(
        ctx,
        409,
        "Контекст подписки изменился до записи; требуется повторная проверка",
        "MANAGED_SUBSCRIPTION_RUNTIME_CHANGED_BEFORE_WRITE",
      );
    }
    ctx.managedRuntime = nextManagedRuntime;
    ctx.managedActivationExpectedRevision = runtime.evidence.instanceRevision;
    return prepareManagedEntitlementReserve(ctx);
  }
  ctx.managedRuntime = nextManagedRuntime;
  ctx.managedActivationRequired = pendingFirstUse;
  ctx.managedActivationExpectedRevision = runtime.evidence.instanceRevision;
  return prepareUserGet(ctx, "active_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "active_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось загрузить активные записи для проверки лимита", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_UNAVAILABLE",
    });
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishError(ctx, 502, "Viva вернула неизвестный формат активных записей", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_SCHEMA_UNRECOGNIZED",
    });
  }
  if (!hasCompleteBookingList(msg.payload)) {
    return finishError(ctx, 502, "Список активных записей Viva неполон", {
      code: "SUBSCRIPTION_BOOKINGS_ACTIVE_INCOMPLETE",
    });
  }
  ctx.activeBookingsPayload = msg.payload;
  return prepareUserGet(
    ctx,
    "history_bookings",
    `/end-user/api/v2/${ctx.tenantKey}/bookings/history?includeCanceled=true&size=1000`,
  );
}

if (ctx.step === "history_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishError(ctx, 502, "Не удалось загрузить историю записей для проверки лимита", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_UNAVAILABLE",
    });
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishError(ctx, 502, "Viva вернула неизвестный формат истории записей", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_SCHEMA_UNRECOGNIZED",
    });
  }
  if (!hasCompleteBookingList(msg.payload)) {
    return finishError(ctx, 502, "История записей Viva неполна", {
      code: "SUBSCRIPTION_BOOKINGS_HISTORY_INCOMPLETE",
    });
  }
  const activeBookingsPayload = ctx.activeBookingsPayload;
  const bookings = mergeBookings(activeBookingsPayload, msg.payload);
  delete ctx.activeBookingsPayload;
  if (ctx.action === "release") {
    const exactBookingId = normalizeId(ctx.releaseBookingId);
    const exactBookings = [
      ...extractItems(activeBookingsPayload),
      ...extractItems(msg.payload),
    ].filter((booking) => isObj(booking) && normalizeId(bookingId(booking)) === exactBookingId);
    if (exactBookings.length === 0) {
      return finishError(ctx, 409, "Отменённая запись не найдена в истории Viva", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_NOT_VERIFIED",
      });
    }
    if (exactBookings.some((booking) => !isInactiveBooking(booking))) {
      return finishError(ctx, 409, "Viva всё ещё считает запись активной", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_STILL_ACTIVE",
      });
    }
    const cancelledBooking = exactBookings.find((booking) => (
      isSubscriptionBooking(booking)
      && bookingSubscriptionId(booking)
      && bookingExerciseId(booking)
      && eventDate(booking)
    ));
    if (!cancelledBooking) {
      return finishError(ctx, 409, "Отменённая запись не содержит точной связи с абонементом", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_TARGET_UNRESOLVED",
      });
    }
    ctx.exerciseId = bookingExerciseId(cancelledBooking);
    ctx.clientSubscriptionId = bookingSubscriptionId(cancelledBooking);
    ctx.serviceDate = eventDate(cancelledBooking);
    return prepareOperationFind(ctx, {
      tenantKey: ctx.tenantKey,
      actorClientId: ctx.actorClientId,
      serviceDate: ctx.serviceDate,
      exerciseId: ctx.exerciseId,
    });
  }
  let sameExerciseBooking = null;
  let dailyConflict = null;
  let unresolvedBooking = null;
  const cancelledSubscriptionBookings = [];
  for (const booking of bookings) {
    if (!isObj(booking) || !isSubscriptionBooking(booking)) continue;
    if (eventDate(booking) !== ctx.serviceDate) continue;
    const subscriptionId = bookingSubscriptionId(booking);
    if (!subscriptionId) {
      if (ctx.trackedDailyLimit && !isInactiveBooking(booking)) unresolvedBooking = booking;
      continue;
    }
    if (normalizeId(subscriptionId) !== normalizeId(ctx.clientSubscriptionId)) continue;
    if (isInactiveBooking(booking)) {
      cancelledSubscriptionBookings.push(cancelledBookingRef(booking));
      continue;
    }
    if (normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)) {
      sameExerciseBooking = booking;
      continue;
    }
    if (ctx.limitMode === "event") continue;
    const category = resolveCategory(booking);
    if (!category) {
      unresolvedBooking = booking;
      continue;
    }
    const consumesSameLimit = ctx.limitMode === "shared_day"
      ? (ctx.managedEnforcement?.enabled === true || PLAN_CATEGORIES[ctx.planKey].includes(category))
      : category === ctx.category;
    if (consumesSameLimit) {
      dailyConflict = booking;
      break;
    }
  }
  if (dailyConflict && ctx.managedEnforcement?.enabled !== true) {
    const existingEvent = eventSummary(dailyConflict);
    return finishError(ctx, 409, "По этому абонементу уже есть посещение на выбранную дату", {
      code: DAILY_LIMIT_CODE,
      existingEvent,
    });
  }
  if (unresolvedBooking && ctx.managedEnforcement?.enabled !== true) {
    return finishError(ctx, 502, "Нельзя безопасно определить принадлежность существующей записи дневному лимиту", {
      code: "SUBSCRIPTION_DAILY_LIMIT_BOOKING_UNRESOLVED",
    });
  }
  if (!serviceTokenAvailable()) {
    return finishError(ctx, 503, "Сервисный токен Viva временно недоступен", {
      code: "VIVA_SERVICE_TOKEN_UNAVAILABLE",
    });
  }
  ctx.sameExerciseBooking = sameExerciseBooking;
  ctx.cancelledSubscriptionBookings = cancelledSubscriptionBookings;
  ctx.operationKey = buildOperationKey(ctx);
  if (ctx.managedEnforcement?.enabled === true) {
    if (!isObj(ctx.managedRuntime) || !isObj(ctx.managedTarget) || !ctx.managedAction) {
      return finishError(ctx, 502, "Контекст проверки региональной подписки потерян", {
        code: "MANAGED_SUBSCRIPTION_CONTEXT_MISSING",
      });
    }
    return prepareOperationFind(ctx);
  }
  return prepareOperationFind(ctx);
}

if (["managed_policy_decision", "managed_policy_recheck_decision"].includes(ctx.step)) {
  const isRecheck = ctx.step === "managed_policy_recheck_decision";
  const decision = msg._managedSubscriptionPolicyDecision;
  if (!isObj(decision) || decision.eligible !== true
    || decision.policyVersion !== ctx.managedRuntime?.policy?.policyVersion) {
    if (isRecheck) {
      return prepareFailedUpdate(
        ctx,
        409,
        "Правила подписки не разрешили эту запись",
        "MANAGED_SUBSCRIPTION_POLICY_BLOCKED",
      );
    }
    return finishError(ctx, 409, "Правила подписки не разрешили эту запись", {
      code: "MANAGED_SUBSCRIPTION_POLICY_BLOCKED",
    });
  }
  if (decision.benefit?.kind !== "FREE_ENTITLEMENT") {
    if (isRecheck) {
      return prepareFailedUpdate(
        ctx,
        409,
        "Правила подписки не покрывают это действие",
        "MANAGED_SUBSCRIPTION_BENEFIT_NOT_APPLICABLE",
      );
    }
    return finishError(ctx, 409, "Правила подписки не покрывают это действие", {
      code: "MANAGED_SUBSCRIPTION_BENEFIT_NOT_APPLICABLE",
    });
  }
  ctx.managedDecision = {
    policyVersion: decision.policyVersion,
    policyDigest: ctx.managedRuntime.policyDigest,
    subscriptionInstanceId: ctx.managedRuntime.subscriptionInstanceId,
    usageUnits: decision.usageUnits,
    benefit: decision.benefit || null,
    evaluatedAt: decision.evaluatedAt,
  };
  delete msg._managedSubscriptionPolicyInput;
  delete msg._managedSubscriptionPolicyDecision;
  if (isRecheck) return prepareBookingCreate(ctx);
  return prepareOperationFind(ctx);
}

if (ctx.step === "managed_entitlement_reserve") {
  const result = unwrapRecord(msg.payload);
  if (!isHttpOk(msg.statusCode) || !result || result.schemaVersion !== 1
    || result.subscriptionInstanceId !== (
      ctx.managedRuntime?.subscriptionInstanceId || ctx.managedSubscriptionInstanceId
    )
    || !Number.isInteger(result.aggregateRevision) || result.aggregateRevision < 1) {
    return prepareFailedUpdate(
      ctx,
      Number(msg.statusCode) >= 400 && Number(msg.statusCode) < 500 ? Number(msg.statusCode) : 502,
      "ЦУП не подтвердил резерв льготы подписки",
      toStr(result?.code || result?.error?.code) || "SUBSCRIPTION_ENTITLEMENT_RESERVE_FAILED",
    );
  }
  if (result.outcome === "FULL_PRICE_WITHOUT_SUBSCRIPTION") {
    const blockers = asArray(result.blockers);
    if (result.operationId !== null || result.operationState !== null || result.decision !== null
      || blockers.length !== 1 || blockers[0]?.code !== "ACTIVE_SERVICES_LIMIT_REACHED") {
      return prepareFailedUpdate(
        ctx,
        502,
        "ЦУП вернул небезопасный переход на полную стоимость",
        "SUBSCRIPTION_FULL_PRICE_FALLBACK_INVALID",
      );
    }
    return prepareFullPriceFallbackUpdate(ctx, blockers);
  }
  if (result.outcome !== "RESERVED" || !toStr(result.operationId)
    || !["RESERVED", "CONFIRMED"].includes(result.operationState)
    || typeof result.replayed !== "boolean"
    || (result.operationState === "CONFIRMED" && result.replayed !== true)
    || asArray(result.blockers).length > 0
    || !validEntitlementDecision(ctx, result.decision)) {
    return prepareFailedUpdate(
      ctx,
      502,
      "ЦУП вернул несогласованный резерв льготы",
      "SUBSCRIPTION_ENTITLEMENT_RESERVE_INVALID",
    );
  }
  ctx.managedEntitlementOperationId = toStr(result.operationId);
  ctx.managedDecision = result.decision;
  ctx.managedEntitlementReplayedConfirmed = result.operationState === "CONFIRMED";
  return prepareManagedEntitlementBind(ctx);
}

if (ctx.step === "operation_entitlement_bind") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Льгота зарезервирована в ЦУП; локальная связь требует сверки", {
      code: "SUBSCRIPTION_ENTITLEMENT_BIND_PENDING",
    });
  }
  if (ctx.managedDecision?.money?.finalPriceMinor > 0) {
    ctx.entitlementReleaseNext = "pricing_not_configured";
    return prepareManagedEntitlementRelease(ctx, "PROVIDER_REJECTED");
  }
  if (ctx.managedEntitlementReplayedConfirmed === true) {
    return finishPending(ctx, "Льгота уже подтверждена в ЦУП; запись Viva требует точной сверки", {
      code: "SUBSCRIPTION_ENTITLEMENT_CONFIRMED_RECONCILIATION_REQUIRED",
    });
  }
  return prepareBookingCreate(ctx);
}

if (ctx.step === "operation_full_price_fallback") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Переход на полную стоимость ожидает локального подтверждения", {
      code: "SUBSCRIPTION_FULL_PRICE_FALLBACK_PENDING",
    });
  }
  return finishFullPriceFallback(ctx, ctx.fullPriceFallbackBlockers);
}

if (ctx.step === "operation_find") {
  const rows = asArray(msg.payload);
  if (ctx.action === "release") {
    if (rows.length === 0) {
      return finishReleased(ctx, { operationFound: false });
    }
    if (rows.length > 1) {
      return finishError(ctx, 502, "Найдено несколько операций для отменённой записи", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_OPERATION_AMBIGUOUS",
      });
    }
    const releaseOperation = isObj(rows[0]) ? rows[0] : null;
    if (!releaseOperation) {
      return finishError(ctx, 502, "Операция дневного посещения имеет неизвестный формат", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_OPERATION_INVALID",
      });
    }
    if (normalizeId(releaseOperation.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)) {
      return finishError(ctx, 409, "Абонемент отменённой записи не совпал с дневной операцией", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_SUBSCRIPTION_MISMATCH",
      });
    }
    if (asArray(releaseOperation.releasedBookingIds).some((id) => normalizeId(id) === normalizeId(ctx.releaseBookingId))) {
      return finishReleased(ctx, { operationFound: true, alreadyReleased: true });
    }
    const operationBookingId = normalizeId(releaseOperation.bookingId || releaseOperation.upstreamBookingId);
    if (operationBookingId && operationBookingId !== normalizeId(ctx.releaseBookingId)) {
      return finishError(ctx, 409, "Отменённая запись не совпала с подтверждённой операцией", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_OPERATION_MISMATCH",
      });
    }
    if (["FAILED", "RELEASED"].includes(String(releaseOperation.state || ""))) {
      return finishReleased(ctx, { operationFound: true, alreadyReleased: true });
    }
    if (!["PREPARED", "PENDING_CONFIRMATION", "CONFIRMED"].includes(String(releaseOperation.state || ""))) {
      return finishError(ctx, 409, "Операция дневного посещения требует ручной сверки", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_STATE_UNSUPPORTED",
        state: toStr(releaseOperation.state),
      });
    }
    ctx.managedEntitlementOperationId = toStr(releaseOperation.managedEntitlementOperationId);
    ctx.managedSubscriptionInstanceId = toStr(releaseOperation.managedSubscriptionInstanceId);
    if (ctx.managedEntitlementOperationId) {
      ctx.releaseOperation = releaseOperation;
      ctx.entitlementReleaseNext = "local_operation_release";
      return prepareManagedEntitlementRelease(ctx, "BOOKING_CANCELLED", ctx.releaseBookingId);
    }
    return prepareOperationRelease(ctx, releaseOperation);
  }
  const operation = isObj(rows[0]) ? rows[0] : null;
  if (ctx.sameExerciseBooking) {
    if (operation
      && ctx.managedActivationRequired
      && operation.state === "CONFIRMED"
      && operation.activationState === "PENDING") {
      const stableBookingId = bookingId(ctx.sameExerciseBooking)
        || toStr(operation.bookingId || operation.upstreamBookingId);
      if (!stableBookingId) {
        return finishPending(ctx, "Активная запись Viva найдена без устойчивого bookingId и требует сверки");
      }
      ctx.confirmedBookingId = stableBookingId;
      ctx.activationOperationId = toStr(operation.operationId);
      ctx.managedEntitlementOperationId = toStr(operation.managedEntitlementOperationId);
      ctx.managedSubscriptionInstanceId = toStr(operation.managedSubscriptionInstanceId);
      if (ctx.managedEntitlementOperationId
        && operation.managedEntitlementState !== "CONFIRMED") {
        return prepareManagedEntitlementConfirm(ctx);
      }
      return prepareManagedFirstUseActivation(ctx, stableBookingId);
    }
    if (operation && toStr(operation.operationId) === ctx.operationId) {
      const stableBookingId = bookingId(ctx.sameExerciseBooking)
        || toStr(operation.bookingId || operation.upstreamBookingId);
      if (!stableBookingId) {
        return finishPending(ctx, "Активная запись Viva найдена без устойчивого bookingId и требует сверки");
      }
      ctx.immediateBookingId = stableBookingId;
      ctx.managedEntitlementOperationId = toStr(operation.managedEntitlementOperationId);
      ctx.managedSubscriptionInstanceId = toStr(operation.managedSubscriptionInstanceId);
      return prepareConfirmedUpdate(ctx, ctx.sameExerciseBooking);
    }
    return finishError(ctx, 409, "По этому абонементу уже есть запись на выбранное событие", {
      code: DAILY_LIMIT_CODE,
      existingEvent: eventSummary(ctx.sameExerciseBooking),
    });
  }

  const now = new Date();
  const confirmedOperationWasCancelled = operationHasConfirmedCancellation(
    operation,
    ctx.cancelledSubscriptionBookings,
  );
  if (!operation) {
    ctx.step = "operation_insert";
    msg._subscriptionBooking = ctx;
    msg.payload = {
      _id: ctx.operationKey,
      tenantKey: ctx.tenantKey,
      clientSubscriptionId: ctx.clientSubscriptionId,
      serviceDate: ctx.serviceDate,
      operationId: ctx.operationId,
      actorClientId: ctx.actorClientId,
      exerciseId: ctx.exerciseId,
      category: ctx.category,
      planKey: ctx.planKey || null,
      limitMode: ctx.limitMode,
      managedDecision: ctx.managedDecision || null,
      activationState: ctx.managedActivationRequired ? "PENDING" : "NOT_REQUIRED",
      state: "PREPARED",
      attempts: 0,
      leaseUntil: new Date(now.getTime() + PREPARED_LEASE_MS).toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    delete msg.error;
    return emit(OUTPUT_MONGO_INSERT);
  }

  if (toStr(operation.operationId) === ctx.operationId) {
    if (operation.state === "CONFIRMED") {
      if (confirmedOperationWasCancelled) return prepareOperationReclaim(ctx, operation, now);
      return finishPending(
        ctx,
        "Подтверждённая ранее запись не найдена среди активных и требует сверки с Viva",
        { code: "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED" },
      );
    }
    if (operation.state === "FAILED") {
      return prepareOperationReclaim(ctx, operation, now);
    }
    if (operation.state === "PENDING_CONFIRMATION") {
      const pendingUntil = Date.parse(String(operation.pendingUntil || ""));
      if (!Number.isFinite(pendingUntil) || pendingUntil > now.getTime()) {
        return finishPending(ctx, "Предыдущая попытка ещё ожидает подтверждения Viva");
      }
      return prepareExpiredPendingReconciliation(ctx, operation);
    }
    if (operation.state === "PREPARED") return preparePreaccept(ctx);
  }

  const leaseUntil = Date.parse(String(operation.leaseUntil || ""));
  const pendingUntil = Date.parse(String(operation.pendingUntil || ""));
  if (
    (operation.state === "PENDING_CONFIRMATION" && (!Number.isFinite(pendingUntil) || pendingUntil > now.getTime()))
    || (operation.state === "PREPARED" && Number.isFinite(leaseUntil) && leaseUntil > now.getTime())
  ) {
    return finishPending(ctx, "Другая операция уже резервирует дневное посещение");
  }

  if (operation.state === "PENDING_CONFIRMATION") {
    return prepareExpiredPendingReconciliation(ctx, operation);
  }

  const reclaimable = ["FAILED", "RELEASED"].includes(String(operation.state || ""))
    || (operation.state === "CONFIRMED" && confirmedOperationWasCancelled)
    || (operation.state === "PREPARED" && (!Number.isFinite(leaseUntil) || leaseUntil <= now.getTime()));
  if (!reclaimable) {
    const details = operation.state === "CONFIRMED"
      ? { code: "SUBSCRIPTION_BOOKING_CONFIRMED_RECONCILIATION_REQUIRED" }
      : null;
    return finishPending(ctx, "Дневное посещение уже обрабатывается или требует сверки с Viva", details);
  }
  return prepareOperationReclaim(ctx, operation, now);
}

if (ctx.step === "expired_pending_reconciliation") {
  const operation = ctx.expiredPendingOperation;
  if (!operation || !isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) {
    return finishPending(ctx, "Просроченная операция требует сверки с Viva");
  }
  const actorClientId = normalizeId(operation.actorClientId);
  const clientSubscriptionId = normalizeId(operation.clientSubscriptionId);
  if (!actorClientId || !clientSubscriptionId) {
    return finishPending(ctx, "Просроченная операция не содержит устойчивой идентичности для сверки");
  }
  const actorBookings = extractItems(msg.payload).filter((booking) => (
    isObj(booking) && normalizeId(bookingClientId(booking)) === actorClientId
  ));
  if (actorBookings.some((booking) => !bookingSubscriptionId(booking))) {
    return finishPending(ctx, "Viva вернула запись без связи с абонементом; требуется сверка");
  }
  const exactBookings = actorBookings.filter((booking) => (
    normalizeId(bookingSubscriptionId(booking)) === clientSubscriptionId
  ));
  if (exactBookings.some((booking) => !isInactiveBooking(booking))) {
    return finishPending(ctx, "Просроченная операция подтверждена активной записью Viva");
  }
  ctx.managedEntitlementOperationId = toStr(operation.managedEntitlementOperationId);
  ctx.managedSubscriptionInstanceId = toStr(operation.managedSubscriptionInstanceId);
  if (ctx.managedEntitlementOperationId) {
    ctx.entitlementReleaseNext = "expired_pending_release";
    return prepareManagedEntitlementRelease(ctx, "PROVIDER_REJECTED");
  }
  return prepareExpiredPendingRelease(ctx, operation);
}

if (ctx.step === "operation_expired_pending_release") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Просроченная операция была изменена параллельно и требует повторной проверки");
  }
  return prepareOperationFind(ctx);
}

if (ctx.step === "operation_insert") {
  if (msg.error || !mongoInserted(msg.payload)) {
    return finishPending(ctx, "Другая операция одновременно заняла дневное посещение");
  }
  return preparePreaccept(ctx);
}

if (ctx.step === "operation_reclaim") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Другая операция одновременно заняла дневное посещение");
  }
  return preparePreaccept(ctx);
}

if (ctx.step === "operation_preaccept") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Не удалось подтвердить владельца атомарной операции");
  }
  return prepareUserGet(
    ctx,
    "exercise_recheck",
    `/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`,
  );
}

if (ctx.step === "booking_create") {
  const statusCode = Number(msg.statusCode) || null;
  if (!isHttpOk(statusCode)) {
    const rawMessage = toStr(msg.payload?.message || msg.payload?.error || msg.error?.message);
    if (statusCode && statusCode >= 400 && statusCode < 500 && statusCode !== 408) {
      if (ctx.managedEntitlementOperationId) {
        ctx.finalFailure = {
          statusCode,
          message: rawMessage || "Viva отклонила создание записи",
          rawCode: toStr(msg.payload?.code),
        };
        ctx.entitlementReleaseNext = "persist_failure";
        return prepareManagedEntitlementRelease(ctx, "PROVIDER_REJECTED");
      }
      return prepareFailedUpdate(
        ctx,
        statusCode,
        rawMessage || "Viva отклонила создание записи",
        toStr(msg.payload?.code),
      );
    }
    return finishPending(ctx, "Результат создания записи в Viva пока неизвестен");
  }
  ctx.correlationId = extractCorrelationId(msg.payload);
  ctx.immediateBookingId = bookingId(msg.payload) || null;
  const nowIso = new Date().toISOString();
  return prepareMongoUpdate(ctx, "operation_accept", {
    _id: ctx.operationKey,
    operationId: ctx.operationId,
    state: "PENDING_CONFIRMATION",
  }, {
    $set: {
      acceptedAt: nowIso,
      correlationId: ctx.correlationId || null,
      upstreamBookingId: ctx.immediateBookingId || null,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "operation_accept") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Viva приняла запрос; локальное подтверждение ещё выполняется");
  }
  return prepareUserGet(ctx, "confirmation_bookings", `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
}

if (ctx.step === "confirmation_bookings") {
  if (!isHttpOk(msg.statusCode)) {
    return finishPending(ctx, "Viva приняла запрос; список записей ещё недоступен");
  }
  if (!hasBookingListShape(msg.payload)) {
    return finishPending(ctx, "Viva приняла запрос; формат списка записей требует повторной проверки");
  }
  const confirmed = extractItems(msg.payload).find((booking) => (
    isObj(booking)
    && !isInactiveBooking(booking)
    && normalizeId(bookingExerciseId(booking)) === normalizeId(ctx.exerciseId)
    && normalizeId(bookingSubscriptionId(booking)) === normalizeId(ctx.clientSubscriptionId)
  ));
  if (!confirmed) {
    return finishPending(ctx, "Viva приняла запрос; запись ещё не появилась в активных");
  }
  if (!bookingId(confirmed) && !ctx.immediateBookingId) {
    return finishPending(ctx, "Viva показала запись без устойчивого bookingId; требуется повторная проверка");
  }
  return prepareConfirmedUpdate(ctx, confirmed);
}

if (ctx.step === "operation_confirm") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Запись появилась в Viva; локальное подтверждение ещё выполняется");
  }
  if (ctx.managedEntitlementOperationId && ctx.managedEntitlementConfirmed !== true) {
    return prepareManagedEntitlementConfirm(ctx);
  }
  if (ctx.managedActivationRequired) {
    return prepareManagedFirstUseActivation(ctx, ctx.confirmedBookingId);
  }
  return finishConfirmed(ctx, ctx.confirmedBookingId, 201);
}

if (ctx.step === "managed_entitlement_confirm") {
  const result = unwrapRecord(msg.payload);
  if (!isHttpOk(msg.statusCode) || !result || result.schemaVersion !== 1
    || result.outcome !== "CONFIRMED"
    || result.operationId !== ctx.managedEntitlementOperationId
    || result.subscriptionInstanceId !== (
      ctx.managedRuntime?.subscriptionInstanceId || ctx.managedSubscriptionInstanceId
    )
    || result.operationState !== "CONFIRMED"
    || !Number.isInteger(result.aggregateRevision) || result.aggregateRevision < 1) {
    return finishPending(ctx, "Запись подтверждена Viva; подтверждение льготы в ЦУП ожидает повтора", {
      code: "SUBSCRIPTION_ENTITLEMENT_CONFIRM_PENDING",
      upstreamStatus: Number(msg.statusCode) || null,
    });
  }
  ctx.managedEntitlementConfirmed = true;
  return prepareManagedEntitlementConfirmedUpdate(ctx);
}

if (ctx.step === "operation_entitlement_confirm") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Льгота подтверждена в ЦУП; локальная связь ожидает сверки", {
      code: "SUBSCRIPTION_ENTITLEMENT_CONFIRM_BIND_PENDING",
    });
  }
  if (ctx.managedActivationRequired) {
    return prepareManagedFirstUseActivation(ctx, ctx.confirmedBookingId);
  }
  return finishConfirmed(ctx, ctx.confirmedBookingId, 201);
}

if (ctx.step === "managed_first_use_activation") {
  const activation = unwrapRecord(msg.payload);
  if (!isHttpOk(msg.statusCode)
    || !activation
    || activation.schemaVersion !== 1
    || !["ACTIVATED", "ALREADY_ACTIVE"].includes(activation.outcome)
    || activation.state !== "ACTIVE"
    || activation.subscriptionInstanceId !== ctx.managedRuntime?.subscriptionInstanceId
    || !Number.isInteger(activation.revision)
    || !finiteDate(activation.activeFrom)
    || !finiteDate(activation.activeTo)) {
    return finishPending(ctx, "Запись подтверждена Viva; активация подписки в ЦУП ожидает повтора", {
      code: "SUBSCRIPTION_ACTIVATION_PENDING",
      upstreamStatus: Number(msg.statusCode) || null,
    });
  }
  return prepareActivationConfirmedUpdate(ctx, activation);
}

if (ctx.step === "operation_activation_confirm") {
  if (msg.error || Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Подписка активирована; локальная операция ожидает повторной сверки");
  }
  return finishConfirmed(ctx, ctx.confirmedBookingId, 201);
}

if (ctx.step === "operation_fail") {
  if (ctx.managedEntitlementOperationId
    && ctx.managedEntitlementReleased !== true
    && ctx.entitlementReleaseNext !== "finish_failure") {
    ctx.entitlementReleaseNext = "finish_failure";
    return prepareManagedEntitlementRelease(ctx, "PROVIDER_REJECTED");
  }
  const failure = ctx.finalFailure || {};
  return finishError(
    ctx,
    Number(failure.statusCode) || 409,
    toStr(failure.message) || "Viva отклонила создание записи",
    { code: toStr(failure.rawCode) || "VIVA_SUBSCRIPTION_BOOKING_REJECTED" },
  );
}

if (ctx.step === "managed_entitlement_release") {
  const result = unwrapRecord(msg.payload);
  if (!isHttpOk(msg.statusCode) || !result || result.schemaVersion !== 1
    || result.outcome !== "RELEASED"
    || result.operationId !== ctx.managedEntitlementOperationId
    || result.subscriptionInstanceId !== (
      ctx.managedRuntime?.subscriptionInstanceId || ctx.managedSubscriptionInstanceId
    )
    || !["FAILED", "COMPENSATED"].includes(result.operationState)
    || !Number.isInteger(result.aggregateRevision) || result.aggregateRevision < 1) {
    return finishPending(ctx, "Резерв льготы требует ручной сверки после неуспешного освобождения", {
      code: "SUBSCRIPTION_ENTITLEMENT_RELEASE_PENDING",
      upstreamStatus: Number(msg.statusCode) || null,
    });
  }
  ctx.managedEntitlementReleased = true;
  const next = ctx.entitlementReleaseNext;
  delete ctx.entitlementReleaseNext;
  if (next === "local_operation_release") {
    const operation = ctx.releaseOperation;
    delete ctx.releaseOperation;
    if (!isObj(operation)) {
      return finishPending(ctx, "Льгота освобождена; локальная операция требует сверки", {
        code: "SUBSCRIPTION_BOOKING_RELEASE_OPERATION_MISSING",
      });
    }
    return prepareOperationRelease(ctx, operation);
  }
  if (next === "expired_pending_release") {
    if (!isObj(ctx.expiredPendingOperation)) {
      return finishPending(ctx, "Льгота освобождена; просроченная операция требует сверки", {
        code: "SUBSCRIPTION_EXPIRED_OPERATION_MISSING",
      });
    }
    return prepareExpiredPendingRelease(ctx, ctx.expiredPendingOperation);
  }
  if (next === "persist_failure") {
    const failure = ctx.finalFailure || {};
    return prepareFailedUpdate(
      ctx,
      Number(failure.statusCode) || 409,
      toStr(failure.message) || "Viva отклонила создание записи",
      toStr(failure.rawCode) || "VIVA_SUBSCRIPTION_BOOKING_REJECTED",
    );
  }
  if (next === "pricing_not_configured") {
    return prepareFailedUpdate(
      ctx,
      409,
      "Доплата по льготе рассчитана, но её точная передача в Viva ещё не подключена",
      "MANAGED_SUBSCRIPTION_PROVIDER_PRICING_NOT_CONFIGURED",
    );
  }
  if (next === "finish_failure") {
    const failure = ctx.finalFailure || {};
    return finishError(
      ctx,
      Number(failure.statusCode) || 409,
      toStr(failure.message) || "Viva отклонила создание записи",
      { code: toStr(failure.rawCode) || "VIVA_SUBSCRIPTION_BOOKING_REJECTED" },
    );
  }
  return finishPending(ctx, "Льгота освобождена; продолжение операции требует сверки", {
    code: "SUBSCRIPTION_ENTITLEMENT_RELEASE_CONTINUATION_MISSING",
  });
}

if (ctx.step === "operation_release") {
  if (msg.error) {
    return finishError(ctx, 502, "Не удалось освободить дневное посещение", {
      code: "SUBSCRIPTION_BOOKING_RELEASE_PERSISTENCE_FAILED",
    });
  }
  if (Number(mongoMatched(msg.payload) || 0) < 1) {
    return finishPending(ctx, "Состояние дневного посещения изменилось; требуется повторная сверка", {
      code: "SUBSCRIPTION_BOOKING_RELEASE_RACE",
    });
  }
  return finishReleased(ctx, {
    operationFound: true,
    previousState: ctx.releasePreviousState || null,
  });
}

return finishError(ctx, 500, "Неизвестный этап серверной записи по абонементу", {
  code: "SUBSCRIPTION_BOOKING_STEP_UNSUPPORTED",
  step: ctx.step || null,
});
