const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const REGIONAL_FRIENDSHIP_CONFIGS = {
  kotelniki_friendship: { batchSize: 50, bindingLabel: "Котельники" },
  network_friendship: { batchSize: 100, bindingLabel: "ХАБ" },
  piter_friendship: { batchSize: 100, bindingLabel: "Питер" },
};

const toTs = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const ts = Date.parse(text);
  return Number.isFinite(ts) ? ts : null;
};

const resolveNextDailyDropAt = (completedAtTs) => {
  if (!Number.isFinite(completedAtTs)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
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
    timeZone: "Europe/Moscow",
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
    launchCompletedAt: null,
    dailyLimit: Math.max(0, Math.floor(Number(counter.dailyLimit) || 0)),
    dailyDropDate: toStr(counter.dailyDropDate),
    dailyDropStartsAt: null,
    totalLimit,
    paidCount: manualPaidCount,
    reservedCount: 0,
    takenCount: manualPaidCount,
    remainingCount: Math.max(0, totalLimit - manualPaidCount),
    canPurchase: counter.unlimited === true || totalLimit - manualPaidCount > 0,
    bindingReady: true,
    bindingError: null,
    batchSize: Math.max(0, Math.floor(Number(counter.batchSize) || 0)),
    batchIndex: 0,
    batchCount: Array.isArray(counter.tiers) ? counter.tiers.length : 0,
    batchRemainingCount: 0,
    _tiers: Array.isArray(counter.tiers) ? counter.tiers : [],
    providerProductCostMinor: null,
    discountMinor: null,
    priceMinor: Number.isFinite(Number(counter.productCostMinor)) ? Math.max(0, Math.round(Number(counter.productCostMinor))) : null,
    price: Number.isFinite(Number(counter.productCostMinor)) ? Math.round(Number(counter.productCostMinor)) / 100 : null,
    updatedAt: refreshedAt,
    sourceUpdatedAt: null,
    _lastUpdatedAtTs: null,
    _dailyPaidCount: 0,
    _dailyReservedCount: 0,
    _launchPaidTimestamps: [],
    _stagedRows: [],
  };
});

rows.forEach((doc) => {
  const state = states.find((candidate) => matchesCounterRecord(doc, candidate));
  if (!state) return;

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
      return;
    }
    state.paidCount += 1;
    return;
  }

  const isPending = status === "PAYMENT_PENDING";
  const isActivePending = isPending && (expiresAtTs == null || expiresAtTs > nowTs);
  if (isActivePending) {
    if (state.stagedRelease) {
      state._stagedRows.push({
        status,
        releasePhase,
        dailyDropDate: toStr(doc.dailyDropDate),
        eventTs,
      });
      return;
    }
    state.reservedCount += 1;
  }
});

const updateMessages = states.map((state) => {
  if (state.stagedRelease) {
    state._launchPaidTimestamps.sort((left, right) => left - right);
    const launchComplete = state.launchPaidCount >= state.launchLimit;
    const launchCompletedAtTs = launchComplete && state._launchPaidTimestamps.length >= state.launchLimit
      ? state._launchPaidTimestamps[state.launchLimit - 1]
      : null;
    state.launchCompletedAt = launchCompletedAtTs == null ? null : new Date(launchCompletedAtTs).toISOString();
    state.dailyDropStartsAt = launchComplete ? resolveNextDailyDropAt(launchCompletedAtTs) : null;
    state.dailyDropActive = Boolean(state.dailyDropStartsAt && Date.parse(state.dailyDropStartsAt) <= nowTs);
    const dailyDropStartsAtTs = toTs(state.dailyDropStartsAt);
    state.launchPaidCount = launchComplete ? state.launchLimit : state.launchPaidCount;
    for (const row of state._stagedRows) {
      const isCurrentDailyDrop = row.releasePhase === "daily"
        ? row.dailyDropDate === state.dailyDropDate
        : dailyDropStartsAtTs != null
          && row.eventTs != null
          && row.eventTs >= dailyDropStartsAtTs
          && resolveDailyDropDate(row.eventTs) === state.dailyDropDate;
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
  state.sourceUpdatedAt = state._lastUpdatedAtTs == null
    ? null
    : new Date(state._lastUpdatedAtTs).toISOString();
  delete state._lastUpdatedAtTs;
  delete state._dailyPaidCount;
  delete state._dailyReservedCount;
  delete state._launchPaidTimestamps;
  delete state._stagedRows;
  delete state._tiers;

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
