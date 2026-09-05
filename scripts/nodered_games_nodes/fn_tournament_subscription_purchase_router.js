const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const REGIONAL_ANNUAL_TIME_ZONE = "Europe/Moscow";
const MANAGED_SALE_COMPATIBILITY = {
  adapterId: "LK_REGIONAL_BOOKING_GATEWAY",
  contractVersion: 1,
  capabilityDigest: "sha256:f1e00751ba2ef19b1945964f2ee90d2d88dbf11121fdb75dfe573b6b12f31791",
};
const NETWORK_FRIENDSHIP_PROVIDER_SCOPE = {
  kind: "STATION_SET",
  scopeId: "station-set:469c42f52aeda36c921660ab7eff8a89421953fbf1136af9cb6951612d26c877",
};
const REGIONAL_ANNUAL_LIFECYCLE = {
  network_friendship: {
    activationNotBeforeDate: "2026-10-01",
    validityDays: 365,
    visits: 365,
  },
  piter_friendship: {
    activationNotBeforeDate: "2026-10-01",
    validityDays: 365,
    visits: 365,
  },
};

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

const readManagedGlobal = (key) => {
  try {
    return toStr(global.get(key));
  } catch (_error) {
    return null;
  }
};
const isAtomicSaleCounter = (counterKey) => (
  counterKey === "piter_friendship" || counterKey === "network_friendship"
);

const cupRequest = (ctx, path, token, payload) => {
  const apiBase = readManagedGlobal("subscriptions_runtime_api_base_url");
  if (!apiBase || !token) return null;
  msg._summerSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = `${apiBase.replace(/\/+$/, "")}${path}`;
  msg.headers = {
    "Content-Type": "application/json",
    "X-Subscriptions-Integration-Token": token,
    "Idempotency-Key": `lk-sale-bind:${ctx.paymentRef}`,
    "X-Correlation-Id": `lk-sale:${ctx.paymentRef}`,
  };
  msg.httpRequestTimeout = Math.max(
    3000,
    Math.min(20000, Math.floor(Number(ctx.httpRequestTimeoutMs) || 10000)),
  );
  msg.payload = payload;
  return [msg, null, null, null];
};

const exactClientSubscriptionId = (value) => {
  if (!value || typeof value !== "object") return null;
  if (!Array.isArray(value)) {
    const direct = toStr(value.clientSubscriptionId);
    if (direct) return direct;
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = exactClientSubscriptionId(nested);
    if (found) return found;
  }
  return null;
};

const matchesExactManagedReadiness = (payload, ctx) => {
  const binding = payload?.binding;
  return payload && typeof payload === "object"
    && payload.schemaVersion === 1
    && payload.ready === true
    && payload.provider === "VIVA"
    && payload.providerProductId === ctx.productId
    && payload.providerScope?.kind === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind
    && payload.providerScope?.scopeId === NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId
    && payload.requiredCompatibility?.adapterId === MANAGED_SALE_COMPATIBILITY.adapterId
    && payload.requiredCompatibility?.contractVersion === MANAGED_SALE_COMPATIBILITY.contractVersion
    && payload.requiredCompatibility?.capabilityDigest === MANAGED_SALE_COMPATIBILITY.capabilityDigest
    && payload.instanceProjector?.status === "CURRENT"
    && binding && typeof binding === "object"
    && toStr(binding.mappingId)
    && Number.isInteger(binding.mappingRevision)
    && toStr(binding.subscriptionTypeId)
    && toStr(binding.publicationId)
    && Number.isInteger(binding.policyVersion)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.policyDigest) || "")
    && toStr(binding.fenceId)
    && Number.isInteger(binding.fenceRevision)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.fenceDigest) || "")
    && toStr(binding.releaseProgramId)
    && Number.isInteger(binding.releaseProgramRevision)
    && toStr(binding.releasePhaseId)
    && /^sha256:[a-f0-9]{64}$/.test(toStr(binding.projectorReconciliationDigest) || "");
};

const providerSubscriptionProductId = (record) => toStr(
  record?.productId
  || record?.subscriptionProductId
  || record?.product?.id
  || record?.subscription?.id
);

const providerSubscriptionHomeStationId = (record) => toStr(
  record?.homeStationId
  || record?.stationId
  || record?.studioId
  || record?.homeStation?.id
  || record?.station?.id
  || record?.studio?.id
);

const strictProviderInstant = (record, keys) => {
  for (const key of keys) {
    const value = toStr(record?.[key]);
    if (value && Number.isFinite(Date.parse(value))) return value;
  }
  return null;
};

const normalizeManagedProviderInstance = (record, ctx) => {
  if (!record || typeof record !== "object") return null;
  const clientSubscriptionId = toStr(record.clientSubscriptionId);
  if (!clientSubscriptionId || clientSubscriptionId !== ctx.clientSubscriptionId) return null;
  if (providerSubscriptionProductId(record) !== ctx.productId) return null;
  const rawStatus = normalizeTransactionStatus(
    record.status || record.state || record.subscriptionStatus || record.lifecycleState,
  );
  const isActive = ["ACTIVE", "ACTIVATED"].includes(rawStatus);
  const isPending = ["PENDING_ACTIVATION", "NOT_ACTIVE", "CREATED", "PAID"].includes(rawStatus);
  if (!isActive && !isPending) return null;
  const purchasedAt = strictProviderInstant(record, [
    "purchasedAt", "purchaseDate", "paidAt", "createdAt",
  ]);
  const activeFrom = strictProviderInstant(record, ["activeFrom", "activationDate", "activatedAt"]);
  const activeTo = strictProviderInstant(record, ["activeTo", "expirationDate", "expiresAt"]);
  const homeStationId = providerSubscriptionHomeStationId(record);
  if (!purchasedAt || !homeStationId) return null;
  if (isActive && (!activeFrom || !activeTo)) return null;
  if (!isActive && (activeFrom || activeTo)) return null;
  return {
    providerSubscriptionState: isActive ? "ACTIVE" : "PENDING_ACTIVATION",
    purchasedAt,
    activeFrom: isActive ? activeFrom : null,
    activeTo: isActive ? activeTo : null,
    homeStationId,
  };
};

const managedBindingPending = (ctx, code) => {
  const nowIso = new Date().toISOString();
  const providerObservedAt = toStr(ctx.managedProviderObservedAt)
    || toStr(ctx.saleRecord?.managedProviderObservedAt)
    || nowIso;
  const projection = {
    statusCode: 202,
    headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "5" },
    response: {
      ok: true,
      paid: true,
      status: "PENDING_INSTANCE_BINDING",
      retryable: true,
      counterKey: toStr(ctx.counterKey),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
    },
    set: {
        status: "PAID_PENDING_INSTANCE_BINDING",
        paidAt: toStr(ctx.saleRecord?.paidAt) || nowIso,
        lastCheckedAt: nowIso,
        updatedAt: nowIso,
        managedBindingState: "PENDING_INSTANCE_BINDING",
        managedBindingErrorCode: toStr(code) || "MANAGED_SUBSCRIPTION_INSTANCE_BINDING_UNAVAILABLE",
        managedProviderObservedAt: providerObservedAt,
        managedProviderInstance: ctx.managedProviderInstance && typeof ctx.managedProviderInstance === "object"
          ? { ...ctx.managedProviderInstance }
          : null,
        clientSubscriptionId: toStr(ctx.clientSubscriptionId),
        providerTransactionStatus: toStr(ctx.providerTransactionStatus),
    },
  };
  ctx.step = "managed_sale_projection_start";
  ctx.managedSaleProjection = projection;
  delete ctx.token;
  delete ctx.vivaTokenRequestBody;
  delete ctx.providerHeaders;
  delete ctx.providerPayload;
  const atomicMsg = Object.assign({}, msg, { _summerSubscriptionCtx: ctx, payload: null });
  delete atomicMsg.headers;
  delete atomicMsg.url;
  delete atomicMsg.method;
  delete atomicMsg.req;
  delete atomicMsg.res;
  delete atomicMsg.statusCode;
  return [null, null, null, null, atomicMsg];
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

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length === 11 ? digits : null;
};

const piterProductLineMatches = (line, productId) => Boolean(line && typeof line === "object" && [
  line.id,
  line.uuid,
  line.productId,
  line.subscriptionId,
  line.product?.id,
  line.product?.uuid,
].some((value) => toStr(value) === productId));

const piterProviderFactsMatch = (ctx, transaction) => {
  const expectedProductId = toStr(ctx.productId);
  const expectedAmountMinor = Number.isInteger(ctx.expectedAmountMinor) ? ctx.expectedAmountMinor : null;
  const expectedDiscountMinor = Number.isInteger(ctx.saleRecord?.discountMinor)
    ? ctx.saleRecord.discountMinor
    : Number.isInteger(ctx.discountMinor) ? ctx.discountMinor : null;
  const expectedProviderCostMinor = Number.isInteger(ctx.saleRecord?.providerProductCostMinor)
    ? ctx.saleRecord.providerProductCostMinor
    : Number.isInteger(ctx.providerProductCostMinor) ? ctx.providerProductCostMinor : null;
  const allProductLines = extractList(transaction?.products);
  const productLines = allProductLines.filter((line) => piterProductLineMatches(line, expectedProductId));
  const storedClientId = toStr(ctx.clientId);
  const storedPhone = normalizePhone(ctx.clientPhone);
  const providerClientId = toStr(transaction?.clientId)
    || toStr(transaction?.client?.id)
    || toStr(transaction?.client?.uuid)
    || toStr(transaction?.client?.clientId);
  const providerPhone = normalizePhone(
    transaction?.clientPhone
    || transaction?.client?.phone
    || transaction?.client?.mobile
    || transaction?.client?.phoneNumber,
  );
  const clientMatches = Boolean(storedClientId || storedPhone)
    && (!storedClientId || storedClientId === providerClientId)
    && (!storedPhone || storedPhone === providerPhone);
  return Boolean(
    expectedProductId
    && Number.isInteger(expectedAmountMinor) && expectedAmountMinor > 0
    && Number.isInteger(expectedDiscountMinor) && expectedDiscountMinor >= 0
    && Number.isInteger(expectedProviderCostMinor)
    && expectedAmountMinor + expectedDiscountMinor === expectedProviderCostMinor
    && toNum(transaction?.sum) === expectedAmountMinor
    && allProductLines.length === 1 && productLines.length === 1
    && toNum(productLines[0]?.discount) === expectedDiscountMinor
    && clientMatches
  );
};

const buildQuery = (entries) => entries
  .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
  .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  .join("&");

const addExactIds = (target, value, objectKeys) => {
  const values = Array.isArray(value) ? value : [value];
  values.forEach((candidate) => {
    if (candidate && typeof candidate === "object") {
      for (const key of objectKeys) {
        const id = toStr(candidate[key]);
        if (id) target.add(id);
      }
      return;
    }
    const id = toStr(candidate);
    if (id) target.add(id);
  });
};

const exactTransactionIds = (transaction) => {
  const ids = new Set();
  for (const key of ["transactionId", "transactionUuid", "id", "uuid"]) {
    addExactIds(ids, transaction?.[key], ["transactionId", "transactionUuid", "id", "uuid"]);
  }
  addExactIds(ids, transaction?.transaction, ["transactionId", "transactionUuid", "id", "uuid"]);
  return [...ids];
};

const exactTransactionClientIds = (transaction) => {
  const ids = new Set();
  addExactIds(ids, transaction?.clientId, ["id", "uuid", "clientId"]);
  addExactIds(ids, transaction?.client, ["id", "uuid", "clientId"]);
  return [...ids];
};

const exactTransactionProductIds = (transaction) => {
  const ids = new Set();
  addExactIds(ids, transaction?.productId, ["id", "uuid", "productId", "subscriptionId"]);
  addExactIds(ids, transaction?.subscriptionProductId, ["id", "uuid", "productId", "subscriptionId"]);
  const products = Array.isArray(transaction?.products) ? transaction.products : [];
  products.forEach((product) => {
    addExactIds(ids, product, ["id", "uuid", "productId", "subscriptionId"]);
    addExactIds(ids, product?.product, ["id", "uuid", "productId", "subscriptionId"]);
  });
  return [...ids];
};

const exactTransactionStudioIds = (transaction) => {
  const ids = new Set();
  for (const key of ["studioId", "stationId", "paymentStudioId"]) {
    addExactIds(ids, transaction?.[key], ["id", "uuid", "studioId", "stationId"]);
  }
  for (const key of ["studio", "station", "paymentStudio"]) {
    addExactIds(ids, transaction?.[key], ["id", "uuid", "studioId", "stationId"]);
  }
  return [...ids];
};

const transactionCreateTs = (transaction) => {
  for (const key of ["createDate", "createdAt", "createdDate"]) {
    const timestamp = toTs(transaction?.[key]);
    if (timestamp !== null) return timestamp;
  }
  return null;
};

const transactionOriginalAmountMinor = (transaction) => {
  const values = [
    transaction?.sum,
    transaction?.sumMinor,
    transaction?.amount,
    transaction?.amountMinor,
    transaction?.totalAmount,
    transaction?.totalAmountMinor,
  ]
    .map((value) => toNum(value))
    .filter((value) => value !== null)
    .map((value) => Math.max(0, Math.round(value)));
  const unique = [...new Set(values)];
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;

  const status = normalizeTransactionStatus(
    transaction?.status || transaction?.state || transaction?.paymentStatus,
  );
  if (isExplicitlyPaidPiterTransaction(transaction)) return null;
  const toPayMinor = toNum(transaction?.toPay ?? transaction?.toPayMinor);
  if (toPayMinor === null || isExplicitlyFailedPiterTransaction(transaction)) return null;
  return Math.max(0, Math.round(toPayMinor));
};

const isRecoverableOpenTransaction = (transaction) => [
  "UNPAID",
  "PAYMENT_PENDING",
  "PENDING",
  "CREATED",
  "WAITING",
  "WAITING_FOR_PAYMENT",
].includes(normalizeTransactionStatus(
  transaction?.status || transaction?.state || transaction?.paymentStatus,
));

const resolveMoscowDate = (timestamp) => {
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REGIONAL_ANNUAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const recoveryCandidateMatches = (transaction, ctx) => {
  const transactionIds = exactTransactionIds(transaction);
  const clientIds = exactTransactionClientIds(transaction);
  const productIds = exactTransactionProductIds(transaction);
  const studioIds = exactTransactionStudioIds(transaction);
  const attemptedAtTs = toTs(ctx.providerAttemptedAt);
  const createdAtTs = transactionCreateTs(transaction);
  const expectedAmountMinor = Number(ctx.expectedAmountMinor);
  const providerAmountMinor = transactionOriginalAmountMinor(transaction);
  const beforeMs = 60 * 1000;
  const afterMs = Math.max(180 * 1000, Number(ctx.httpRequestTimeoutMs) + 120 * 1000);
  return transactionIds.length === 1
    && isRecoverableOpenTransaction(transaction)
    && clientIds.length === 1
    && clientIds[0] === toStr(ctx.clientId)
    && productIds.length === 1
    && productIds[0] === toStr(ctx.productId)
    && toStr(ctx.studioId)
    && studioIds.length === 1
    && studioIds[0] === toStr(ctx.studioId)
    && Number.isInteger(expectedAmountMinor)
    && expectedAmountMinor > 0
    && providerAmountMinor === expectedAmountMinor
    && attemptedAtTs !== null
    && createdAtTs !== null
    && createdAtTs >= attemptedAtTs - beforeMs
    && createdAtTs <= attemptedAtTs + afterMs;
};

const startMissingTransactionRecovery = (ctx) => {
  const attemptedAtTs = toTs(ctx.providerAttemptedAt);
  const beforeMs = 60 * 1000;
  const afterMs = Math.max(180 * 1000, Number(ctx.httpRequestTimeoutMs) + 120 * 1000);
  const dateFrom = resolveMoscowDate(attemptedAtTs === null ? null : attemptedAtTs - beforeMs);
  const dateTo = resolveMoscowDate(attemptedAtTs === null ? null : attemptedAtTs + afterMs);
  if (!toStr(ctx.clientId)
    || !toStr(ctx.productId)
    || !toStr(ctx.studioId)
    || !Number.isInteger(Number(ctx.expectedAmountMinor))
    || Number(ctx.expectedAmountMinor) <= 0
    || !dateFrom
    || !dateTo) return null;
  const query = buildQuery([
    ["clientIds", ctx.clientId],
    ["productIds", ctx.productId],
    ["dateFrom", dateFrom],
    ["dateTo", dateTo],
    ["page", 0],
    ["size", 100],
    ["sort", "createDate,desc"],
  ]);
  ctx.step = "confirm_recovery_list";
  ctx.transactionRecoveryDateFrom = dateFrom;
  ctx.transactionRecoveryDateTo = dateTo;
  return adminRequest(ctx, "GET", `/transactions?${query}`);
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
    reportedProductType: String(value.productType || value.type || "").trim().toUpperCase() || null,
    activationDays: Number.isInteger(value.activationDays) ? value.activationDays : null,
    validityDays: Number.isInteger(value.validityDays) ? value.validityDays : null,
    visits: Number.isInteger(value.visits) ? value.visits : null,
    raw: value,
  };
};

const resolveLocalDate = (now = new Date(Date.now())) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REGIONAL_ANNUAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const addLocalDateDays = (localDate, days) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate || ""))) return null;
  if (!Number.isInteger(days) || days < 0) return null;
  const [year, month, day] = localDate.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day) + days * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
};

const regionalAnnualLifecycleEvidence = (counterKey, product, now = new Date(Date.now())) => {
  const expected = REGIONAL_ANNUAL_LIFECYCLE[counterKey];
  if (!expected) return null;
  const purchaseDate = resolveLocalDate(now);
  const projectedAutoActivationDate = addLocalDateDays(purchaseDate, product.activationDays);
  const compatible = (
    product.reportedProductType === "SUBSCRIPTION"
    && Number.isInteger(product.activationDays)
    && product.activationDays >= 0
    && product.validityDays === expected.validityDays
    && product.visits === expected.visits
    && purchaseDate <= expected.activationNotBeforeDate
    && projectedAutoActivationDate !== null
    && projectedAutoActivationDate >= expected.activationNotBeforeDate
  );
  return {
    compatible,
    purchaseDate,
    projectedAutoActivationDate,
    activationNotBeforeDate: expected.activationNotBeforeDate,
    activationDays: product.activationDays,
    validityDays: product.validityDays,
    visits: product.visits,
    reportedProductType: product.reportedProductType,
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
    if (ctx.saleType === "tiered_direct_product") return null;
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

// Piter capacity can only become paid on an explicit provider terminal status.
// A zero outstanding balance is not proof that a transaction was paid.
const isExplicitlyPaidPiterTransaction = (payload) => [
  "PAID", "SUCCESS", "SUCCEEDED", "COMPLETE", "COMPLETED", "APPROVED",
].includes(normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus));
const isExplicitlyFailedPiterTransaction = (payload) => [
  "FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED",
].includes(normalizeTransactionStatus(payload?.status || payload?.state || payload?.paymentStatus));

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx) {
  return fail(500, "Summer subscription context is missing");
}

if (ctx.step === "managed_sale_readiness") {
  if (!isOk(msg.statusCode) || !matchesExactManagedReadiness(msg.payload, ctx)) {
    return fail(503, "Контур managed-продажи ХАБ не готов", {
      code: "MANAGED_SUBSCRIPTION_SALE_READINESS_UNAVAILABLE",
      counterKey: toStr(ctx.counterKey),
      readinessStatusCode: Number(msg.statusCode) || null,
    });
  }
  ctx.managedSaleBinding = { ...msg.payload.binding };
  ctx.managedSaleReadinessCheckedAt = toStr(msg.payload.checkedAt);
  ctx.managedSaleProviderScope = { ...NETWORK_FRIENDSHIP_PROVIDER_SCOPE };
  if (!toStr(ctx.vivaTokenRequestBody)) {
    return fail(503, "Сервисная авторизация Viva не настроена", {
      code: "VIVA_SERVICE_AUTH_NOT_CONFIGURED",
    });
  }
  ctx.step = "token_purchase";
  msg._summerSubscriptionCtx = ctx;
  msg.method = "POST";
  msg.url = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
  msg.payload = ctx.vivaTokenRequestBody;
  return [msg, null, null, null];
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

  const configuredProductCostMinor = Number.isFinite(Number(ctx.productCostMinor))
    ? Math.max(0, Math.round(Number(ctx.productCostMinor)))
    : null;
  const configuredPriceMinor = Number.isFinite(Number(ctx.priceMinor))
    ? Math.max(0, Math.round(Number(ctx.priceMinor)))
    : null;
  const isTieredDirectProduct = ctx.saleType === "tiered_direct_product";
  if (
    isTieredDirectProduct
    && (
      configuredProductCostMinor == null
      || configuredPriceMinor == null
      || targetProduct.costMinor !== configuredProductCostMinor
      || configuredPriceMinor > targetProduct.costMinor
    )
  ) {
    return fail(503, "Цена Viva-продукта не соответствует ценовой партии", {
      counterKey: toStr(ctx.counterKey),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      productId: targetProduct.id,
      expectedProductCostMinor: configuredProductCostMinor,
      actualProductCostMinor: targetProduct.costMinor,
      priceMinor: configuredPriceMinor,
    });
  }

  const lifecycleEvidence = regionalAnnualLifecycleEvidence(ctx.counterKey, targetProduct);
  if (lifecycleEvidence && !lifecycleEvidence.compatible) {
    return fail(503, "Параметры активации Viva-продукта не соответствуют годовому предложению", {
      code: "REGIONAL_SUBSCRIPTION_PROVIDER_LIFECYCLE_INCOMPATIBLE",
      counterKey: toStr(ctx.counterKey),
      productId: targetProduct.id,
      ...lifecycleEvidence,
    });
  }

  const priceMinor = isTieredDirectProduct ? configuredPriceMinor : targetProduct.costMinor;
  const discountMinor = isTieredDirectProduct ? targetProduct.costMinor - priceMinor : 0;
  ctx.productId = targetProduct.id;
  ctx.productName = targetProduct.name;
  ctx.productType = targetProduct.type;
  ctx.providerProductCostMinor = targetProduct.costMinor;
  ctx.productCostMinor = priceMinor;
  ctx.priceMinor = priceMinor;
  ctx.discountMinor = discountMinor;
  if (lifecycleEvidence) {
    ctx.providerActivationDays = lifecycleEvidence.activationDays;
    ctx.providerAutoActivationDate = lifecycleEvidence.projectedAutoActivationDate;
    ctx.activationNotBeforeDate = lifecycleEvidence.activationNotBeforeDate;
    ctx.providerValidityDays = lifecycleEvidence.validityDays;
    ctx.providerVisits = lifecycleEvidence.visits;
  }

  const transactionPayload = {
    clientPhone: ctx.clientPhone.startsWith("+") ? ctx.clientPhone : `+${ctx.clientPhone}`,
    paymentMethod: resolveTransactionPaymentMethod(ctx),
    products: [
      {
        id: targetProduct.id,
        count: 1,
        customAmount: null,
        type: targetProduct.type,
        discount: discountMinor,
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
  const request = adminRequest(ctx, "POST", "/transactions", transactionPayload);
  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_reserve_start";
    ctx.providerMethod = request[0].method;
    ctx.providerUrl = request[0].url;
    ctx.providerHeaders = request[0].headers;
    ctx.providerPayload = request[0].payload;
    return [null, null, null, null, request[0]];
  }
  return request;
}

if (ctx.step === "create_transaction") {
  if (!isOk(msg.statusCode)) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId: null,
        paymentUrl: null,
        response: {
          ok: false,
          status: "PROVIDER_UNKNOWN",
          paymentRef: ctx.paymentRef,
          message: "Результат запроса Viva неоднозначен; автоматический повтор запрещён.",
        },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
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
  if (isAtomicSaleCounter(ctx.counterKey) && !transactionId) {
    ctx.step = "piter_provider_result";
    ctx.providerResult = {
      ok: false,
      response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
        message: "Viva не вернула подтверждённый идентификатор транзакции." },
    };
    return [null, null, null, null, msg];
  }
  if (
    ctx.saleType === "tiered_direct_product"
    && toPayMinor !== Math.max(0, Math.round(Number(ctx.priceMinor) || 0))
  ) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId,
        paymentUrl,
        response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
          message: "Viva вернула сумму, не совпадающую с атомарно зафиксированной ценой." },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
    return fail(502, "Viva вернула неверную сумму к оплате", {
      counterKey: toStr(ctx.counterKey),
      batchIndex: Math.max(0, Math.floor(Number(ctx.batchIndex) || 0)),
      productId: toStr(ctx.productId),
      expectedToPayMinor: Math.max(0, Math.round(Number(ctx.priceMinor) || 0)),
      actualToPayMinor: toPayMinor,
      transactionId: pickId(msg.payload),
    });
  }
  if (!paymentUrl && toPayMinor > 0) {
    if (isAtomicSaleCounter(ctx.counterKey)) {
      ctx.step = "piter_provider_result";
      ctx.providerResult = {
        ok: false,
        transactionId,
        paymentUrl: null,
        response: { ok: false, status: "PROVIDER_UNKNOWN", paymentRef: ctx.paymentRef,
          message: "Viva создала транзакцию без подтверждённой ссылки оплаты." },
      };
      msg._summerSubscriptionCtx = ctx;
      return [null, null, null, null, msg];
    }
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
    referralToken: toStr(ctx.referralToken),
    referralVisitId: toStr(ctx.referralVisitId),
    productId: ctx.productId,
    productName: ctx.productName,
    productType: ctx.productType || "SUBSCRIPTION",
    amountMinor: Math.max(0, Math.round(Number(ctx.productCostMinor) || 0)),
    providerProductCostMinor: Math.max(0, Math.round(Number(ctx.providerProductCostMinor) || 0)),
    discountMinor: Math.max(0, Math.round(Number(ctx.discountMinor) || 0)),
    providerActivationDays: Number.isInteger(ctx.providerActivationDays)
      ? ctx.providerActivationDays
      : null,
    providerAutoActivationDate: toStr(ctx.providerAutoActivationDate),
    activationNotBeforeDate: toStr(ctx.activationNotBeforeDate),
    providerValidityDays: Number.isInteger(ctx.providerValidityDays)
      ? ctx.providerValidityDays
      : null,
    providerVisits: Number.isInteger(ctx.providerVisits) ? ctx.providerVisits : null,
    managedSaleBinding: ctx.counterKey === "network_friendship" && ctx.managedSaleBinding
      ? { ...ctx.managedSaleBinding }
      : null,
    managedSaleReadinessCheckedAt: ctx.counterKey === "network_friendship"
      ? toStr(ctx.managedSaleReadinessCheckedAt)
      : null,
    managedSaleProviderScope: ctx.counterKey === "network_friendship"
      ? { ...NETWORK_FRIENDSHIP_PROVIDER_SCOPE }
      : null,
    managedBindingState: ctx.counterKey === "network_friendship" ? "AWAITING_PAYMENT" : null,
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
      priceMinor: Math.max(0, Math.round(Number(ctx.priceMinor) || 0)),
      discountMinor: Math.max(0, Math.round(Number(ctx.discountMinor) || 0)),
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

  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_provider_result";
    ctx.providerResult = {
      ok: true,
      transactionId,
      paymentUrl,
      expiresAt,
      toPayMinor,
      response: responseMsg.payload,
    };
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }

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
    const recoveryRequest = startMissingTransactionRecovery(ctx);
    if (!recoveryRequest) {
      return fail(503, "Транзакция Viva требует ручной сверки", {
        code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_CONTEXT_INCOMPLETE",
        paymentRef: ctx.paymentRef,
      });
    }
    return recoveryRequest;
  }

  ctx.step = "confirm_lookup";
  return adminRequest(
    ctx,
    "GET",
    `/transactions/${encodeURIComponent(ctx.transactionId)}`,
  );
}

if (ctx.step === "confirm_recovery_list") {
  if (!isOk(msg.statusCode)) {
    return fail(503, "Не удалось проверить транзакции Viva по клиенту", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_UNAVAILABLE",
      paymentRef: ctx.paymentRef,
      statusCode: Number(msg.statusCode) || null,
    });
  }

  const transactions = extractList(msg.payload)
    .filter((item) => item && typeof item === "object");
  const totalPages = msg.payload?.totalPages;
  const pageNumber = msg.payload?.number;
  const totalElements = msg.payload?.totalElements;
  const numberOfElements = msg.payload?.numberOfElements;
  const completeFirstPage = Number.isInteger(totalPages)
    && totalPages >= 0
    && totalPages <= 1
    && Number.isInteger(pageNumber)
    && pageNumber === 0
    && msg.payload?.last === true
    && Number.isInteger(totalElements)
    && totalElements === transactions.length
    && Number.isInteger(numberOfElements)
    && numberOfElements === transactions.length
    && totalPages === (transactions.length > 0 ? 1 : 0);
  const incompletePage = !completeFirstPage;
  if (incompletePage) {
    return fail(503, "Список транзакций Viva требует постраничной сверки", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_INCOMPLETE",
      paymentRef: ctx.paymentRef,
    });
  }

  const matches = transactions.filter((transaction) => recoveryCandidateMatches(transaction, ctx));
  if (matches.length !== 1) {
    return fail(503, "Транзакция Viva не определена однозначно", {
      code: matches.length === 0
        ? "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_NOT_FOUND"
        : "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_AMBIGUOUS",
      paymentRef: ctx.paymentRef,
      matchCount: matches.length,
    });
  }

  const transactionId = exactTransactionIds(matches[0])[0];
  ctx.transactionId = transactionId;
  ctx.transactionRecovered = true;
  ctx.transactionRecoveredAt = new Date().toISOString();
  ctx.step = "confirm_lookup";
  return adminRequest(ctx, "GET", `/transactions/${encodeURIComponent(transactionId)}`);
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

  if (ctx.transactionRecovered === true && !recoveryCandidateMatches(msg.payload, ctx)) {
    return fail(503, "Транзакция Viva не прошла повторную проверку", {
      code: "REGIONAL_PROVIDER_TRANSACTION_RECOVERY_GET_MISMATCH",
      paymentRef: ctx.paymentRef,
    });
  }

  const nowIso = new Date().toISOString();
  const isPiter = ctx.counterKey === "piter_friendship";
  const isManagedAnnual = isPiter || ctx.counterKey === "network_friendship";
  const paid = isManagedAnnual ? isExplicitlyPaidPiterTransaction(msg.payload) : isPaidTransaction(msg.payload);
  const failed = !paid && (isManagedAnnual
    ? isExplicitlyFailedPiterTransaction(msg.payload)
    : isFailedTransaction(msg.payload));
  const nextStatus = paid ? "PAID" : failed ? "FAILED" : "PAYMENT_PENDING";
  if (isManagedAnnual) {
    const providerToPay = toNum(msg.payload?.toPay);
    const expectedAmount = ctx.expectedAmountMinor;
    const validAmount = Number.isInteger(expectedAmount) && expectedAmount > 0
      && Number.isInteger(providerToPay) && providerToPay >= 0
      && (paid ? providerToPay === 0
        : failed ? (providerToPay === 0 || providerToPay === expectedAmount)
          : providerToPay === expectedAmount);
    if (!toStr(ctx.transactionId) || pickId(msg.payload) !== ctx.transactionId
      || !validAmount || !piterProviderFactsMatch(ctx, msg.payload)) {
      return fail(503, "Подтверждение Viva требует сверки; состояние покупки не изменено", {
        code: isPiter ? "PITER_CONFIRM_PROVIDER_MISMATCH" : "HUB_CONFIRM_PROVIDER_MISMATCH",
        paymentRef: ctx.paymentRef,
      });
    }
  }
  const expiresAt = pickPaymentDeadline(ctx, msg.payload);
  if (ctx.counterKey === "network_friendship" && paid) {
    const clientSubscriptionId = exactClientSubscriptionId(msg.payload);
    const providerClientId = toStr(
      msg.payload?.providerClientId || msg.payload?.clientId || msg.payload?.client?.id,
    );
    if (!clientSubscriptionId
      || !providerClientId
      || (toStr(ctx.clientId) && toStr(ctx.clientId) !== providerClientId)
      || !ctx.managedSaleBinding
      || typeof ctx.managedSaleBinding !== "object") {
      return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_INSTANCE_ID_UNAVAILABLE");
    }
    ctx.clientSubscriptionId = clientSubscriptionId;
    ctx.clientId = providerClientId;
    ctx.providerTransactionStatus = normalizeTransactionStatus(
      msg.payload?.status || msg.payload?.state || msg.payload?.paymentStatus,
    );
    ctx.providerTransactionObservedAt = nowIso;
    // Preserve transaction facts before adminRequest replaces msg.payload.
    ctx.confirmResult = {
      nextStatus,
      transactionId: pickId(msg.payload),
      paid,
      failed,
      expiresAt,
      paymentUrl: extractPaymentUrl(msg.payload),
      toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
      response: null,
      reconcile: ctx.reconcile === true,
    };
    const readbackRequest = adminRequest(
      ctx,
      "GET",
      `/clients/${encodeURIComponent(ctx.clientId)}/subscriptions?size=200`,
    );
    ctx.step = "piter_confirm_result";
    ctx.providerMethod = readbackRequest[0].method;
    ctx.providerUrl = readbackRequest[0].url;
    ctx.providerHeaders = readbackRequest[0].headers;
    ctx.providerPayload = readbackRequest[0].payload;
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }
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

  if (isAtomicSaleCounter(ctx.counterKey)) {
    ctx.step = "piter_confirm_result";
    ctx.confirmResult = {
      nextStatus,
      transactionId: pickId(msg.payload),
      paid,
      failed,
      expiresAt,
      paymentUrl: extractPaymentUrl(msg.payload),
      toPayMinor: Math.max(0, Math.round((toNum(msg.payload?.toPay) ?? Number(ctx.toPayMinor)) || 0)),
      response: responseMsg?.payload || null,
      reconcile: ctx.reconcile === true,
    };
    msg._summerSubscriptionCtx = ctx;
    return [null, null, null, null, msg];
  }

  return [null, dbMsg, responseMsg, debugMsg];
}

if (ctx.step === "managed_sale_instance_readback") {
  if (!isOk(msg.statusCode)) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_READBACK_UNAVAILABLE");
  }
  const exactRecord = extractList(msg.payload).find(
    (item) => toStr(item?.clientSubscriptionId) === ctx.clientSubscriptionId,
  );
  const providerInstance = normalizeManagedProviderInstance(exactRecord, ctx);
  if (!providerInstance) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_PROVIDER_INSTANCE_UNCONFIRMED");
  }
  const bindingToken = readManagedGlobal("subscriptions_sale_binding_integration_token");
  const binding = ctx.managedSaleBinding;
  const scope = ctx.managedSaleProviderScope;
  if (!bindingToken || !binding || !scope
    || scope.kind !== NETWORK_FRIENDSHIP_PROVIDER_SCOPE.kind
    || scope.scopeId !== NETWORK_FRIENDSHIP_PROVIDER_SCOPE.scopeId) {
    return managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_SALE_BINDING_NOT_CONFIGURED");
  }
  ctx.managedProviderInstance = providerInstance;
  ctx.managedProviderObservedAt = toStr(ctx.saleRecord?.managedProviderObservedAt)
    || providerInstance.purchasedAt;
  ctx.step = "managed_sale_binding_confirm";
  const request = cupRequest(
    ctx,
    "/internal/subscriptions/sale-bindings/confirm",
    bindingToken,
    {
      provider: "VIVA",
      providerProductId: ctx.productId,
      providerScopeKind: scope.kind,
      providerScopeId: scope.scopeId,
      providerClientId: ctx.clientId,
      clientSubscriptionId: ctx.clientSubscriptionId,
      providerTransactionId: ctx.transactionId,
      providerTransactionStatus: ctx.providerTransactionStatus,
      providerSubscriptionState: providerInstance.providerSubscriptionState,
      homeStationId: providerInstance.homeStationId,
      purchasePriceMinor: ctx.expectedAmountMinor,
      purchasedAt: providerInstance.purchasedAt,
      activeFrom: providerInstance.activeFrom,
      activeTo: providerInstance.activeTo,
      providerObservedAt: ctx.managedProviderObservedAt,
      requiredAdapterId: MANAGED_SALE_COMPATIBILITY.adapterId,
      requiredContractVersion: MANAGED_SALE_COMPATIBILITY.contractVersion,
      requiredCapabilityDigest: MANAGED_SALE_COMPATIBILITY.capabilityDigest,
      expectedMappingId: binding.mappingId,
      expectedMappingRevision: binding.mappingRevision,
      expectedSubscriptionTypeId: binding.subscriptionTypeId,
      expectedPublicationId: binding.publicationId,
      expectedPolicyVersion: binding.policyVersion,
      expectedPolicyDigest: binding.policyDigest,
      expectedFenceId: binding.fenceId,
      expectedFenceRevision: binding.fenceRevision,
      expectedFenceDigest: binding.fenceDigest,
      expectedProjectorReconciliationDigest: binding.projectorReconciliationDigest,
      expectedReleaseProgramId: binding.releaseProgramId,
      expectedReleaseProgramRevision: binding.releaseProgramRevision,
      expectedReleasePhaseId: binding.releasePhaseId,
    },
  );
  return request || managedBindingPending(ctx, "MANAGED_SUBSCRIPTION_SALE_BINDING_NOT_CONFIGURED");
}

if (ctx.step === "managed_sale_binding_confirm") {
  const body = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
  const bound = isOk(msg.statusCode)
    && body?.schemaVersion === 1
    && body?.state === "BOUND"
    && body?.clientSubscriptionId === ctx.clientSubscriptionId
    && toStr(body?.subscriptionInstanceId);
  if (!bound) {
    const code = toStr(body?.error?.code)
      || toStr(body?.code)
      || "MANAGED_SUBSCRIPTION_INSTANCE_BINDING_UNAVAILABLE";
    return managedBindingPending(ctx, code);
  }
  const nowIso = new Date().toISOString();
  const providerInstance = ctx.managedProviderInstance || {};
  ctx.step = "managed_sale_projection_start";
  ctx.managedSaleProjection = {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    response: {
      ok: true,
      paid: true,
      status: "PAID",
      managedBindingState: "BOUND",
      counterKey: toStr(ctx.counterKey),
      inventoryId: toStr(ctx.inventoryId),
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      updatedAt: nowIso,
    },
    set: {
        status: "PAID",
        paidAt: toStr(ctx.saleRecord?.paidAt) || toStr(providerInstance.purchasedAt) || nowIso,
        lastCheckedAt: nowIso,
        updatedAt: nowIso,
        managedBindingState: "BOUND",
        managedBindingErrorCode: null,
        subscriptionInstanceId: body.subscriptionInstanceId,
        clientSubscriptionId: ctx.clientSubscriptionId,
        managedPolicyVersion: Number(body.policyVersion),
    },
  };
  delete ctx.token;
  delete ctx.vivaTokenRequestBody;
  delete ctx.providerHeaders;
  delete ctx.providerPayload;
  const atomicMsg = Object.assign({}, msg, { _summerSubscriptionCtx: ctx, payload: null });
  delete atomicMsg.headers;
  delete atomicMsg.url;
  delete atomicMsg.method;
  delete atomicMsg.req;
  delete atomicMsg.res;
  delete atomicMsg.statusCode;
  return [null, null, null, null, atomicMsg];
}

return fail(500, "Unsupported summer subscription step", {
  step: ctx.step,
  action: ctx.action,
});
