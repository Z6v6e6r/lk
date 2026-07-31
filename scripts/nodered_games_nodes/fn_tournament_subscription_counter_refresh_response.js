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

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "friendship" || normalized === "sport") return normalized;
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
    return Boolean(rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey));
  }

  if (rowCounterKey && rowCounterKey === normalizeCounterKey(counter.counterKey)) {
    return true;
  }
  return Boolean(rowProductId && rowProductId === toStr(counter.productId));
};

const ctx = msg._summerSubscriptionCtx && typeof msg._summerSubscriptionCtx === "object"
  ? msg._summerSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "refresh_counters") {
  return null;
}

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const counters = Array.isArray(ctx.counters) ? ctx.counters.filter((counter) => counter && typeof counter === "object") : [];
const refreshedAt = toStr(ctx.refreshedAt) || new Date().toISOString();
const nowTs = Date.now();

const states = counters.map((counter) => {
  const totalLimit = Math.max(0, Math.floor(Number(counter.totalLimit) || 0));
  const manualPaidCount = Math.max(0, Math.floor(Number(counter.manualPaidCount) || 0));
  return {
    counterKey: toStr(counter.counterKey),
    inventoryId: toStr(counter.inventoryId),
    unlimited: counter.unlimited === true,
    saleType: toStr(counter.saleType),
    planKey: normalizePlanKey(counter.planKey),
    campaignKey: toStr(counter.campaignKey),
    productId: toStr(counter.productId),
    productName: toStr(counter.productName),
    stagedRelease: counter.stagedRelease === true,
    releaseStartDate: toStr(counter.releaseStartDate),
    releasePhase: null,
    dailyDropActive: false,
    launchLimit: Math.max(0, Math.floor(Number(counter.launchLimit) || 0)),
    launchPaidCount: 0,
    launchReservedCount: 0,
    launchRemainingCount: 0,
    dailyLimit: Math.max(0, Math.floor(Number(counter.dailyLimit) || 0)),
    dailyDropDate: toStr(counter.dailyDropDate),
    totalLimit,
    paidCount: manualPaidCount,
    reservedCount: 0,
    takenCount: manualPaidCount,
    remainingCount: Math.max(0, totalLimit - manualPaidCount),
    canPurchase: counter.unlimited === true || totalLimit - manualPaidCount > 0,
    priceMinor: Number.isFinite(Number(counter.productCostMinor)) ? Math.max(0, Math.round(Number(counter.productCostMinor))) : null,
    price: Number.isFinite(Number(counter.productCostMinor)) ? Math.round(Number(counter.productCostMinor)) / 100 : null,
    updatedAt: refreshedAt,
    sourceUpdatedAt: null,
    _lastUpdatedAtTs: null,
    _dailyPaidCount: 0,
    _dailyReservedCount: 0,
  };
});

rows.forEach((doc) => {
  const state = states.find((candidate) => matchesCounterRecord(doc, candidate));
  if (!state) return;

  const status = normalizeStatus(doc.status);
  const releasePhase = toStr(doc.releasePhase) === "daily" ? "daily" : "launch";
  const isCurrentDailyDrop = releasePhase === "daily"
    && toStr(doc.dailyDropDate) === state.dailyDropDate;
  const expiresAtTs = toTs(doc.expiresAt);
  const updatedAtTs = toTs(doc.updatedAt) ?? toTs(doc.createdAt);
  if (updatedAtTs != null) {
    if (state._lastUpdatedAtTs == null || updatedAtTs > state._lastUpdatedAtTs) {
      state._lastUpdatedAtTs = updatedAtTs;
    }
  }

  if (!state.planKey) state.planKey = normalizePlanKey(doc.planKey);
  if (!state.campaignKey) state.campaignKey = toStr(doc.campaignKey);
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
      if (releasePhase === "launch") state.launchPaidCount += 1;
      if (isCurrentDailyDrop) state._dailyPaidCount += 1;
      return;
    }
    state.paidCount += 1;
    return;
  }

  const isPending = status === "PAYMENT_PENDING";
  const isActivePending = isPending && (expiresAtTs == null || expiresAtTs > nowTs);
  if (isActivePending) {
    if (state.stagedRelease) {
      if (releasePhase === "launch") state.launchReservedCount += 1;
      if (isCurrentDailyDrop) state._dailyReservedCount += 1;
      return;
    }
    state.reservedCount += 1;
  }
});

const updateMessages = states.map((state) => {
  if (state.stagedRelease) {
    state.dailyDropActive = state.launchPaidCount >= state.launchLimit;
    state.releasePhase = state.dailyDropActive ? "daily" : "launch";
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
  state.canPurchase = state.unlimited || state.remainingCount > 0;
  state.sourceUpdatedAt = state._lastUpdatedAtTs == null
    ? null
    : new Date(state._lastUpdatedAtTs).toISOString();
  delete state._lastUpdatedAtTs;
  delete state._dailyPaidCount;
  delete state._dailyReservedCount;

  return {
    query: state.inventoryId
      ? { inventoryId: state.inventoryId, counterKey: state.counterKey }
      : { counterKey: state.counterKey },
    payload: {
      $set: state,
      $setOnInsert: {
        createdAt: refreshedAt,
      },
    },
  };
});

return [updateMessages];
