const PITER_COUNTER_KEY = "piter_friendship";
const PITER_INVENTORY_ID = "piter_friendship_12m_2026_v1";
const HUB_COUNTER_KEY = "network_friendship";
const HUB_INVENTORY_ID = "network_friendship_12m_2026_v1";

const toStr = (value) => value == null ? null : (String(value).trim() || null);
const UPDATE_ACK_KEYS = ["acknowledged", "matchedCount", "modifiedCount", "upsertedCount", "upsertedId"];
const hasExactAckKeys = (value) => (
  value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\n") === [...UPDATE_ACK_KEYS].sort().join("\n")
);
const exactUpdateAck = (value) => Boolean(
  hasExactAckKeys(value)
  && value.acknowledged === true
  && Number.isInteger(value.matchedCount) && value.matchedCount === 1
  && Number.isInteger(value.modifiedCount) && value.modifiedCount === 1
  && Number.isInteger(value.upsertedCount) && value.upsertedCount === 0
  && (value.upsertedId === null || value.upsertedId === undefined)
);
const exactUpsertAck = (value) => Boolean(
  hasExactAckKeys(value)
  && value.acknowledged === true
  && Number.isInteger(value.matchedCount) && value.matchedCount === 0
  && Number.isInteger(value.modifiedCount) && value.modifiedCount === 0
  && Number.isInteger(value.upsertedCount) && value.upsertedCount === 1
  && value.upsertedId !== null && value.upsertedId !== undefined
);
const rows = (value) => Array.isArray(value) ? value : (value ? [value] : []);
const isHub = (ctx) => ctx?.counterKey === HUB_COUNTER_KEY && ctx?.inventoryId === HUB_INVENTORY_ID;
const isPiter = (ctx) => ctx?.counterKey === PITER_COUNTER_KEY && ctx?.inventoryId === PITER_INVENTORY_ID;
const ledgerId = (ctx) => `inventory:${ctx.inventoryId}`;
const saleId = (ctx) => `${isPiter(ctx) ? "piter" : "hub"}-sale:${ctx.inventoryId}:${ctx.paymentRef}`;
const dispatchGeneration = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};
const generationFilter = (value) => dispatchGeneration(value) === 0 ? { $in: [null, 0] } : dispatchGeneration(value);
const fail = (status, error, code, details = null) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: Object.assign({ code }, details || {}) };
  return [null, null, null, msg, null];
};
const response = (status, payload) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = payload;
  return [null, null, null, msg, null];
};
const ledgerFind = (ctx, step = "piter_ledger_find") => {
  ctx.step = step;
  msg._summerSubscriptionCtx = ctx;
  msg.payload = { _id: ledgerId(ctx) };
  return [msg, null, null, null, null];
};
const saleFind = (ctx, step) => {
  ctx.step = step;
  msg._summerSubscriptionCtx = ctx;
  msg.payload = { _id: saleId(ctx) };
  return [msg, null, null, null, null];
};
const ledgerUpdate = (ctx, filter, update, options = {}) => {
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, Object.assign({ upsert: false }, options)];
  return [null, msg, null, null, null];
};
const saleUpdate = (ctx, filter, update, options = {}) => {
  // Mongo rejects a field mentioned in both $setOnInsert and another operator,
  // even for updates of an existing document. Mutable projection fields belong
  // to the explicit operator; preserve only immutable insert defaults here.
  if (update.$setOnInsert) {
    const mutablePaths = Object.entries(update)
      .filter(([operator]) => operator !== "$setOnInsert")
      .flatMap(([, fields]) => Object.keys(fields));
    update.$setOnInsert = Object.fromEntries(Object.entries(update.$setOnInsert)
      .filter(([key]) => !mutablePaths.some((field) => (
        field === key || field.startsWith(`${key}.`) || key.startsWith(`${field}.`)
      ))));
  }
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, Object.assign({ upsert: true }, options)];
  return [null, null, msg, null, null];
};
const provider = (ctx) => {
  msg._summerSubscriptionCtx = ctx;
  msg.method = ctx.providerMethod;
  msg.url = ctx.providerUrl;
  msg.headers = ctx.providerHeaders;
  msg.httpRequestTimeout = ctx.httpRequestTimeoutMs;
  msg.payload = ctx.providerPayload;
  return [null, null, null, null, msg];
};
const fingerprint = (ctx) => [
  toStr(ctx.inventoryId), toStr(ctx.counterKey), toStr(ctx.paymentRef),
  toStr(ctx.clientPhone), toStr(ctx.clientId),
].join("\n");
const intentFingerprint = (ctx) => [
  toStr(ctx.inventoryId), toStr(ctx.counterKey), toStr(ctx.clientPhone), toStr(ctx.clientId),
].join("\n");
const ACTIVE_RESERVATION_STATES = ["CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN"];
const ledgerIsStructurallyValid = (ledger, totalLimit, ctx) => {
  if (!(ledger && typeof ledger.ready === "boolean"
    && ledger.schemaVersion === 1
    && Number.isInteger(ledger.revision) && ledger.revision >= 0
    && Number.isInteger(ledger.paidCount) && ledger.paidCount >= 0
    && Number.isInteger(ledger.reservedCount) && ledger.reservedCount >= 0
    && Number.isInteger(ledger.takenCount) && ledger.takenCount >= 0
    && ledger.takenCount === ledger.paidCount + ledger.reservedCount
    && ledger.takenCount <= totalLimit
    && /^[a-f0-9]{64}$/.test(toStr(ledger.baselineDigest) || "")
    && Number.isFinite(Date.parse(toStr(ledger.baselineCapturedAt) || ""))
    && Array.isArray(ledger.legacyPaymentRefs)
    && Array.isArray(ledger.reservations))) return false;
  const legacyRefs = ledger.legacyPaymentRefs.map(toStr);
  const reservationRefs = ledger.reservations.map((item) => toStr(item?.paymentRef));
  if (legacyRefs.some((item) => !item) || reservationRefs.some((item) => !item)) return false;
  if (ledger.reservations.some((item) => ![
    "CLAIMED", "DISPATCHING", "PAYMENT_PENDING", "PROVIDER_UNKNOWN", "PAID", "FAILED",
  ].includes(item?.state))) return false;
  if (new Set(legacyRefs).size !== legacyRefs.length
    || new Set(reservationRefs).size !== reservationRefs.length
    || reservationRefs.some((item) => legacyRefs.includes(item))) return false;
  const paidReservations = ledger.reservations.filter((item) => item?.state === "PAID").length;
  const activeReservations = ledger.reservations.filter((item) => ACTIVE_RESERVATION_STATES.includes(item?.state)).length;
  const activeIntentFingerprints = ledger.reservations
    .filter((item) => ACTIVE_RESERVATION_STATES.includes(item?.state))
    .map((item) => toStr(item?.intentFingerprint));
  const transactionIds = ledger.reservations.map((item) => toStr(item?.transactionId)).filter(Boolean);
  const baseValid = ledger.paidCount === legacyRefs.length + paidReservations
    && ledger.reservedCount === activeReservations
    && activeIntentFingerprints.every(Boolean)
    && new Set(activeIntentFingerprints).size === activeIntentFingerprints.length
    && new Set(transactionIds).size === transactionIds.length;
  if (!baseValid || !isHub(ctx)) return baseValid;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toStr(ledger.dailyDate) || "")
    || !Number.isInteger(ledger.dailyBaselinePaidCount) || ledger.dailyBaselinePaidCount < 0
    || !Number.isInteger(ledger.dailyPaidCount) || ledger.dailyPaidCount < 0
    || !Number.isInteger(ledger.dailyReservedCount) || ledger.dailyReservedCount < 0
    || ledger.dailyPaidCount + ledger.dailyReservedCount > Math.max(0, Number(ctx.dailyLimit) || 0)) {
    return false;
  }
  const dailyPaidReservations = ledger.reservations.filter((item) => (
    item?.state === "PAID" && item?.dailyDate === ledger.dailyDate
  )).length;
  const dailyActiveReservations = ledger.reservations.filter((item) => (
    ACTIVE_RESERVATION_STATES.includes(item?.state) && item?.dailyDate === ledger.dailyDate
  )).length;
  return ledger.dailyPaidCount === ledger.dailyBaselinePaidCount + dailyPaidReservations
    && ledger.dailyReservedCount === dailyActiveReservations;
};
const ledgerIsPurchaseReady = (ledger, totalLimit, ctx) => (
  ledger?.ready === true && ledgerIsStructurallyValid(ledger, totalLimit, ctx)
);
const saleInsert = (ctx, nowIso) => ({
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: ctx.clientPhone,
      clientId: ctx.clientId || null,
      studioId: toStr(ctx.studioId),
      batchIndex: ctx.batchIndex,
      batchSize: ctx.batchSize,
      productId: ctx.productId,
      productName: ctx.productName,
      amountMinor: ctx.priceMinor,
      providerProductCostMinor: ctx.productCostMinor,
      discountMinor: ctx.discountMinor,
      unlimited: ctx.unlimited === true,
      releasePhase: toStr(ctx.releasePhase),
      releaseStartDate: toStr(ctx.releaseStartDate),
      totalLimit: Number.isInteger(ctx.totalLimit) ? ctx.totalLimit : null,
      launchLimit: Math.max(0, Math.floor(Number(ctx.launchLimit) || 0)),
      dailyLimit: Math.max(0, Math.floor(Number(ctx.dailyLimit) || 0)),
      dailyDropDate: toStr(ctx.dailyDropDate),
      saleType: toStr(ctx.saleType),
      planKey: toStr(ctx.planKey),
      campaignKey: toStr(ctx.campaignKey),
      trainerQrCode: toStr(ctx.trainerQrCode),
      referralToken: toStr(ctx.referralToken),
      referralVisitId: toStr(ctx.referralVisitId),
      productType: ctx.productType || "SUBSCRIPTION",
      providerActivationDays: Number.isInteger(ctx.providerActivationDays) ? ctx.providerActivationDays : null,
      providerAutoActivationDate: toStr(ctx.providerAutoActivationDate),
      activationNotBeforeDate: toStr(ctx.activationNotBeforeDate),
      providerValidityDays: Number.isInteger(ctx.providerValidityDays) ? ctx.providerValidityDays : null,
      providerVisits: Number.isInteger(ctx.providerVisits) ? ctx.providerVisits : null,
      managedSaleBinding: ctx.managedSaleBinding && typeof ctx.managedSaleBinding === "object"
        ? { ...ctx.managedSaleBinding }
        : null,
      managedSaleReadinessCheckedAt: toStr(ctx.managedSaleReadinessCheckedAt),
      managedSaleProviderScope: ctx.managedSaleProviderScope && typeof ctx.managedSaleProviderScope === "object"
        ? { ...ctx.managedSaleProviderScope }
        : null,
      managedBindingState: isHub(ctx) ? "AWAITING_PAYMENT" : null,
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
      providerAttemptedAt: toStr(ctx.providerAttemptedAt),
      successUrl: ctx.successUrl || null,
      failUrl: ctx.failUrl || null,
      createdAt: ctx.reservationCreatedAt || nowIso,
});
const projectSale = (ctx, result, nextStep) => {
  const nowIso = new Date().toISOString();
  ctx.step = nextStep;
  const filter = {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  };
  if (nextStep === "piter_provider_sale_ack") {
    filter.status = "DISPATCHING";
    filter.providerAttemptedAt = toStr(ctx.providerAttemptedAt);
    filter.dispatchGeneration = dispatchGeneration(ctx.dispatchGeneration);
  }
  return saleUpdate(ctx, filter, {
    $setOnInsert: ctx.saleRecord || saleInsert(ctx, nowIso),
    $set: {
      status: result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN",
      transactionId: result.transactionId || null,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor ?? null,
      providerAttemptedAt: toStr(ctx.providerAttemptedAt),
      updatedAt: nowIso,
    },
  }, nextStep === "piter_provider_sale_ack" ? { upsert: false } : {});
};
const persistClaimedSale = (ctx, nextStep = "piter_claimed_sale_ack") => {
  const nowIso = new Date().toISOString();
  const generation = dispatchGeneration(ctx.dispatchGeneration);
  ctx.step = nextStep;
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    $or: [
      { status: { $exists: false } },
      { status: null },
      { status: "CLAIMED", dispatchGeneration: generationFilter(generation) },
      { status: "DISPATCH_REPAIRING", dispatchGeneration: generation },
    ],
  }, {
    $setOnInsert: ctx.saleRecord || saleInsert(ctx, nowIso),
    $set: {
      status: "CLAIMED",
      dispatchGeneration: generation,
      providerAttemptedAt: null,
      updatedAt: nowIso,
    },
    $unset: { dispatchRepairStartedAt: "", repairProviderAttemptedAt: "" },
  });
};
const saleProjectionMatches = (record, ctx, expectedStatus, result = {}) => Boolean(
  record
  && record._id === saleId(ctx)
  && record.requestFingerprint === ctx.requestFingerprint
  && record.status === expectedStatus
  && record.amountMinor === (ctx.expectedAmountMinor ?? ctx.priceMinor)
  && (expectedStatus !== "PAYMENT_PENDING" || (toStr(result.transactionId) && toStr(result.paymentUrl)))
  && (result.transactionId == null || record.transactionId === result.transactionId)
  && (result.paymentUrl == null || record.paymentUrl === result.paymentUrl)
  && (result.providerAttemptedAt == null || record.providerAttemptedAt === result.providerAttemptedAt)
);
const finishProviderProjection = () => {
  const result = ctx.providerResult || {};
  if (!result.ok) return response(503, result.response);
  return response(ctx.saleResponseStatus || 201, result.response);
};
const finishConfirmProjection = () => {
  if (ctx.confirmResult?.reconcile === true) return [null, null, null, null, null];
  return response(200, ctx.confirmResult?.response || { ok: true, status: ctx.confirmResult?.nextStatus });
};
const dispatchClaim = (ctx) => {
  ctx.step = "piter_dispatch_ack";
  const nowIso = new Date().toISOString();
  const previousGeneration = dispatchGeneration(ctx.dispatchGeneration);
  const nextGeneration = previousGeneration + 1;
  ctx.dispatchGeneration = nextGeneration;
  ctx.providerAttemptedAt = nowIso;
  return ledgerUpdate(ctx, {
    _id: ledgerId(ctx), ready: true,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      state: "CLAIMED",
      dispatchGeneration: generationFilter(previousGeneration),
    } },
  }, {
    $set: {
      "reservations.$.state": "DISPATCHING",
      "reservations.$.dispatchGeneration": nextGeneration,
      "reservations.$.updatedAt": nowIso,
      "reservations.$.providerAttemptedAt": nowIso,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
};
const resetDispatchAfterFence = (ctx) => {
  ctx.step = "piter_dispatch_repair_ack";
  const nowIso = new Date().toISOString();
  return ledgerUpdate(ctx, {
    _id: ledgerId(ctx),
    ready: true,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      state: "DISPATCHING",
      providerAttemptedAt: ctx.providerAttemptedAt,
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
    } },
  }, {
    $set: {
      "reservations.$.state": "CLAIMED",
      "reservations.$.updatedAt": nowIso,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
};

const ctx = msg._summerSubscriptionCtx;
if (!ctx || (!isPiter(ctx) && !isHub(ctx))) {
  return fail(500, "Regional atomic sale context is missing", "REGIONAL_ATOMIC_CONTEXT_MISSING");
}

if (ctx.step === "piter_reserve_start") return ledgerFind(ctx);

if (ctx.step === "piter_ledger_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit, ctx)) {
    return fail(503, "Продажа Питера ещё не активирована", "PITER_ATOMIC_LEDGER_NOT_READY");
  }
  if (isHub(ctx) && ledger.dailyDate > ctx.dailyDropDate) {
    return fail(409, "Запрос относится к уже закрытому дневному окну", "HUB_DAILY_CAP_STALE_REQUEST", {
      ledgerDailyDate: ledger.dailyDate,
      requestDailyDate: ctx.dailyDropDate,
    });
  }
  if (isHub(ctx) && ledger.dailyDate < ctx.dailyDropDate) {
    ctx.step = "hub_daily_reset_ack";
    return ledgerUpdate(ctx, {
      _id: ledgerId(ctx), ready: true, revision: ledger.revision,
      dailyDate: ledger.dailyDate,
      dailyPaidCount: ledger.dailyPaidCount,
      dailyReservedCount: ledger.dailyReservedCount,
    }, {
      $set: {
        dailyDate: ctx.dailyDropDate,
        dailyBaselinePaidCount: 0,
        dailyPaidCount: 0,
        dailyReservedCount: 0,
        updatedAt: new Date().toISOString(),
      },
      $inc: { revision: 1 },
    });
  }
  let requestFingerprint = fingerprint(ctx);
  const currentIntentFingerprint = intentFingerprint(ctx);
  if (ledger.legacyPaymentRefs.includes(ctx.paymentRef)) {
    return fail(409, "paymentRef уже использован до переключения продаж", "PITER_LEGACY_PAYMENT_REF_ALREADY_USED");
  }
  let existing = ledger.reservations.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!existing) {
    existing = ledger.reservations.find((item) => (
      item?.intentFingerprint === currentIntentFingerprint && ACTIVE_RESERVATION_STATES.includes(item?.state)
    ));
    if (existing) {
      ctx.requestedPaymentRef = ctx.paymentRef;
      ctx.paymentRef = existing.paymentRef;
      requestFingerprint = existing.requestFingerprint;
    }
  }
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      return fail(409, "paymentRef уже связан с другой покупкой", "PITER_PAYMENT_REF_CONFLICT");
    }
    if (existing.state === "PAYMENT_PENDING" && existing.paymentUrl) {
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = existing.productId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = existing.providerProductCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.providerResult = {
        ok: true,
        transactionId: existing.transactionId,
        paymentUrl: existing.paymentUrl,
        expiresAt: existing.expiresAt,
        toPayMinor: existing.toPayMinor,
        response: Object.assign({ ok: true, replayed: true }, existing.response || {}, {
        paymentRef: existing.paymentRef,
        transactionId: existing.transactionId,
        paymentUrl: existing.paymentUrl,
        status: "PAYMENT_PENDING",
        }),
      };
      ctx.saleResponseStatus = 200;
      return projectSale(ctx, ctx.providerResult, "piter_replay_sale_ack");
    }
    if (existing.state === "CLAIMED") {
      if (ledger.ready !== true) {
        return fail(503, "Продажа Питера остановлена", "PITER_ATOMIC_LEDGER_NOT_READY");
      }
      const providerLine = Array.isArray(ctx.providerPayload?.products) ? ctx.providerPayload.products[0] : null;
      const frozenProductId = toStr(existing.productId);
      const frozenProviderCostMinor = Math.max(0, Math.round(Number(existing.providerProductCostMinor)));
      if (!providerLine || !frozenProductId || toStr(providerLine.id) !== frozenProductId
        || Math.max(0, Math.round(Number(ctx.providerProductCostMinor))) !== frozenProviderCostMinor
        || !Number.isInteger(existing.priceMinor) || existing.priceMinor <= 0
        || !Number.isInteger(existing.discountMinor) || existing.discountMinor < 0
        || existing.discountMinor !== frozenProviderCostMinor - existing.priceMinor) {
        return fail(503, "Замороженная ценовая партия требует сверки", "PITER_CLAIMED_TIER_DRIFT");
      }
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = frozenProductId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = frozenProviderCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.studioId = toStr(existing.saleRecord?.studioId) || toStr(ctx.studioId);
      ctx.dispatchGeneration = dispatchGeneration(existing.dispatchGeneration);
      ctx.providerAttemptedAt = toStr(existing.providerAttemptedAt);
      providerLine.id = frozenProductId;
      providerLine.discount = existing.discountMinor;
      return persistClaimedSale(ctx);
    }
    if (existing.state === "DISPATCHING") {
      ctx.requestFingerprint = requestFingerprint;
      ctx.clientPhone = existing.clientPhone;
      ctx.clientId = existing.clientId || null;
      ctx.batchIndex = existing.batchIndex;
      ctx.batchSize = existing.batchSize;
      ctx.productId = existing.productId;
      ctx.productName = existing.productName;
      ctx.priceMinor = existing.priceMinor;
      ctx.productCostMinor = existing.providerProductCostMinor;
      ctx.discountMinor = existing.discountMinor;
      ctx.reservationCreatedAt = existing.createdAt;
      ctx.saleRecord = existing.saleRecord;
      ctx.studioId = toStr(existing.saleRecord?.studioId) || toStr(ctx.studioId);
      ctx.dispatchGeneration = dispatchGeneration(existing.dispatchGeneration);
      ctx.providerAttemptedAt = toStr(existing.providerAttemptedAt);
      return saleFind(ctx, "piter_dispatch_repair_sale_find");
    }
    return fail(503, "Предыдущая попытка оплаты требует сверки", "PITER_ACTIVE_PURCHASE_UNRESOLVED", {
      paymentRef: existing.paymentRef,
      status: existing.state, message: "Попытка оплаты уже обрабатывается; повторный запрос в Viva не выполняется.",
    });
  }
  if (!ledgerIsPurchaseReady(ledger, ctx.totalLimit, ctx)) {
    return fail(503, "Продажа Питера остановлена", "PITER_ATOMIC_LEDGER_NOT_READY");
  }
  if (ledger.takenCount >= ctx.totalLimit) {
    return fail(409, "Лимит абонементов исчерпан", "PITER_INVENTORY_EXHAUSTED", {
      totalLimit: ctx.totalLimit, takenCount: ledger.takenCount,
    });
  }
  if (isHub(ctx)
    && ledger.dailyPaidCount + ledger.dailyReservedCount >= ctx.dailyLimit) {
    return fail(409, "Дневной лимит подписок исчерпан", "HUB_DAILY_INVENTORY_EXHAUSTED", {
      dailyDate: ledger.dailyDate,
      dailyLimit: ctx.dailyLimit,
      dailyTakenCount: ledger.dailyPaidCount + ledger.dailyReservedCount,
    });
  }
  const tiers = Array.isArray(ctx.tiers) ? ctx.tiers : [];
  const batchSize = Math.max(1, Math.floor(Number(ctx.batchSize) || 100));
  const batchIndex = Math.max(1, Math.min(tiers.length || 1, Math.floor(ledger.takenCount / batchSize) + 1));
  const activeTier = tiers[batchIndex - 1];
  if (!activeTier || !toStr(activeTier.productId) || !Number.isFinite(Number(activeTier.priceMinor))) {
    return fail(503, "Ценовая партия Питера не настроена", "PITER_ATOMIC_TIER_NOT_READY", { batchIndex });
  }
  ctx.batchSize = batchSize;
  ctx.batchIndex = batchIndex;
  ctx.batchRemainingBefore = Math.max(0, batchSize - (ledger.takenCount - (batchIndex - 1) * batchSize));
  const atomicProductId = toStr(activeTier.productId);
  const atomicProviderCostMinor = Math.max(0, Math.round(Number(activeTier.providerProductCostMinor)));
  const validatedProviderCostMinor = Math.max(0, Math.round(Number(ctx.providerProductCostMinor)));
  const providerLine = Array.isArray(ctx.providerPayload?.products) ? ctx.providerPayload.products[0] : null;
  if (!providerLine || toStr(providerLine.id) !== atomicProductId
    || validatedProviderCostMinor !== atomicProviderCostMinor) {
    return fail(503, "Ценовая партия изменилась до резервирования", "PITER_ATOMIC_TIER_DRIFT", { batchIndex });
  }
  ctx.productId = atomicProductId;
  ctx.productName = toStr(activeTier.productName);
  ctx.priceMinor = Math.max(0, Math.round(Number(activeTier.priceMinor)));
  ctx.productCostMinor = atomicProviderCostMinor;
  ctx.discountMinor = ctx.productCostMinor - ctx.priceMinor;
  providerLine.discount = ctx.discountMinor;
  ctx.remainingBefore = Math.max(0, ctx.totalLimit - ledger.takenCount);
  const nowIso = new Date().toISOString();
  ctx.ledgerRevision = ledger.revision;
  ctx.requestFingerprint = requestFingerprint;
  ctx.intentFingerprint = currentIntentFingerprint;
  ctx.saleRecord = saleInsert(ctx, nowIso);
  ctx.step = "piter_reserve_ack";
  const reservation = {
    paymentRef: ctx.paymentRef,
    requestFingerprint,
    intentFingerprint: currentIntentFingerprint,
    state: "CLAIMED",
    clientPhone: ctx.clientPhone,
    clientId: ctx.clientId || null,
    batchIndex: ctx.batchIndex,
    batchSize: ctx.batchSize,
    priceMinor: ctx.priceMinor,
    productId: ctx.productId,
    productName: ctx.productName,
    providerProductCostMinor: ctx.productCostMinor,
    discountMinor: ctx.discountMinor,
    dailyDate: isHub(ctx) ? ctx.dailyDropDate : null,
    dispatchGeneration: 0,
    saleRecord: ctx.saleRecord,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const reserveFilter = {
    _id: ledgerId(ctx), ready: true, revision: ledger.revision,
    takenCount: ledger.takenCount,
    $and: [
      { "reservations.paymentRef": { $ne: ctx.paymentRef } },
      { reservations: { $not: { $elemMatch: {
        intentFingerprint: currentIntentFingerprint, state: { $in: ACTIVE_RESERVATION_STATES },
      } } } },
    ],
  };
  if (isHub(ctx)) {
    reserveFilter.dailyDate = ctx.dailyDropDate;
    reserveFilter.dailyPaidCount = ledger.dailyPaidCount;
    reserveFilter.dailyReservedCount = ledger.dailyReservedCount;
  }
  const reserveInc = { revision: 1, reservedCount: 1, takenCount: 1 };
  if (isHub(ctx)) reserveInc.dailyReservedCount = 1;
  return ledgerUpdate(ctx, reserveFilter, {
    $inc: reserveInc,
    $push: { reservations: reservation },
    $set: { updatedAt: nowIso },
  }, { upsert: false });
}

if (ctx.step === "hub_daily_reset_ack") {
  if (!exactUpdateAck(msg.payload)) {
    ctx.atomicRetryCount = Number(ctx.atomicRetryCount || 0) + 1;
    if (ctx.atomicRetryCount > 3) {
      return fail(409, "Не удалось переключить дневной лимит", "HUB_DAILY_CAP_CAS_CONFLICT");
    }
  }
  return ledgerFind(ctx);
}

if (ctx.step === "piter_reserve_ack") {
  if (!exactUpdateAck(msg.payload)) {
    ctx.atomicRetryCount = Number(ctx.atomicRetryCount || 0) + 1;
    if (ctx.atomicRetryCount > 3) {
      return fail(409, "Не удалось зафиксировать место, повторите попытку", "PITER_CAPACITY_CAS_CONFLICT");
    }
    return ledgerFind(ctx);
  }
  return persistClaimedSale(ctx);
}

if (ctx.step === "piter_dispatch_claim") {
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_claimed_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_claimed_sale_readback");
  }
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_claimed_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Резервация не подтверждена sale record", "PITER_CLAIMED_SALE_NOT_DURABLE");
  }
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_dispatch_repair_sale_find") {
  const record = rows(msg.payload)[0];
  const generation = dispatchGeneration(ctx.dispatchGeneration);
  const previousGeneration = Math.max(0, generation - 1);
  if (saleProjectionMatches(record, ctx, "DISPATCH_REPAIRING")
    && dispatchGeneration(record?.dispatchGeneration) === generation
    && !toStr(record?.providerAttemptedAt)) {
    return resetDispatchAfterFence(ctx);
  }
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== previousGeneration
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Предыдущая попытка оплаты требует сверки", "PITER_ACTIVE_PURCHASE_UNRESOLVED", {
      paymentRef: ctx.paymentRef,
      status: "DISPATCHING",
    });
  }
  ctx.step = "piter_dispatch_repair_fence_ack";
  const nowIso = new Date().toISOString();
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    status: "CLAIMED",
    providerAttemptedAt: null,
    dispatchGeneration: generationFilter(previousGeneration),
  }, {
    $set: {
      status: "DISPATCH_REPAIRING",
      dispatchGeneration: generation,
      dispatchRepairStartedAt: nowIso,
      repairProviderAttemptedAt: ctx.providerAttemptedAt,
      updatedAt: nowIso,
    },
  }, { upsert: false });
}

if (ctx.step === "piter_dispatch_repair_fence_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_repair_fence_readback");
  }
  return resetDispatchAfterFence(ctx);
}

if (ctx.step === "piter_dispatch_repair_fence_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "DISPATCH_REPAIRING")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)) {
    return fail(503, "Repair fence попытки Viva требует сверки", "PITER_DISPATCH_REPAIR_FENCE_NOT_DURABLE");
  }
  return resetDispatchAfterFence(ctx);
}

if (ctx.step === "piter_dispatch_repair_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return ledgerFind(ctx, "piter_dispatch_repair_ledger_readback");
  }
  return persistClaimedSale(
    ctx,
    ctx.dispatchRepairOnly === true
      ? "piter_dispatch_repair_claimed_sale_ack"
      : "piter_claimed_sale_ack",
  );
}

if (ctx.step === "piter_dispatch_repair_ledger_readback") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const reservation = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!reservation
    || reservation.requestFingerprint !== ctx.requestFingerprint
    || reservation.state !== "CLAIMED"
    || dispatchGeneration(reservation.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(reservation.providerAttemptedAt) !== toStr(ctx.providerAttemptedAt)) {
    return fail(503, "Состояние попытки Viva требует сверки", "PITER_DISPATCH_REPAIR_NOT_DURABLE");
  }
  return persistClaimedSale(
    ctx,
    ctx.dispatchRepairOnly === true
      ? "piter_dispatch_repair_claimed_sale_ack"
      : "piter_claimed_sale_ack",
  );
}

if (ctx.step === "piter_dispatch_repair_claimed_sale_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_repair_claimed_sale_readback");
  }
  return [null, null, null, null, null];
}

if (ctx.step === "piter_dispatch_repair_claimed_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "CLAIMED")
    || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || toStr(record?.providerAttemptedAt)
    || toStr(record?.dispatchRepairStartedAt)
    || toStr(record?.repairProviderAttemptedAt)) {
    return fail(503, "Repair состояния Viva не подтверждён", "PITER_DISPATCH_REPAIR_NOT_DURABLE");
  }
  return [null, null, null, null, null];
}

if (ctx.step === "piter_dispatch_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return fail(409, "Попытка оплаты уже запущена", "PITER_PROVIDER_ATTEMPT_ALREADY_CLAIMED");
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_dispatch_sale_ack";
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
    status: "CLAIMED",
    providerAttemptedAt: null,
    dispatchGeneration: generationFilter(dispatchGeneration(ctx.dispatchGeneration) - 1),
  }, {
    $set: {
      status: "DISPATCHING",
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
      providerAttemptedAt: ctx.providerAttemptedAt,
      updatedAt: nowIso,
    },
  }, { upsert: false });
}

if (ctx.step === "piter_dispatch_sale_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "piter_dispatch_sale_readback");
  }
  ctx.step = "create_transaction";
  return provider(ctx);
}

if (ctx.step === "piter_dispatch_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "DISPATCHING", {
    providerAttemptedAt: ctx.providerAttemptedAt,
  }) || dispatchGeneration(record?.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)) {
    return fail(503, "Попытка Viva не подтверждена хранилищем", "PITER_DISPATCH_SALE_NOT_DURABLE");
  }
  ctx.step = "create_transaction";
  return provider(ctx);
}

if (ctx.step === "piter_provider_result") {
  const result = ctx.providerResult || {};
  const nowIso = new Date().toISOString();
  ctx.step = "piter_provider_ledger_ack";
  const resultFilter = {
    _id: ledgerId(ctx),
    $and: [{ reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef, requestFingerprint: ctx.requestFingerprint, state: "DISPATCHING",
      dispatchGeneration: dispatchGeneration(ctx.dispatchGeneration),
    } } }],
  };
  if (toStr(result.transactionId)) resultFilter.$and.push({ reservations: { $not: { $elemMatch: {
    transactionId: result.transactionId, paymentRef: { $ne: ctx.paymentRef },
  } } } });
  return ledgerUpdate(ctx, resultFilter, {
    $set: {
      "reservations.$.state": result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN",
      "reservations.$.updatedAt": nowIso,
      "reservations.$.transactionId": result.transactionId || null,
      "reservations.$.paymentUrl": result.paymentUrl || null,
      "reservations.$.response": result.response || null,
      "reservations.$.expiresAt": result.expiresAt || null,
      "reservations.$.toPayMinor": result.toPayMinor ?? null,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
}

if (ctx.step === "piter_provider_ledger_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return fail(503, "Результат Viva требует сверки", "PITER_PROVIDER_RESULT_NOT_DURABLE");
  }
  const result = ctx.providerResult || {};
  return projectSale(ctx, result, "piter_provider_sale_ack");
}

if (ctx.step === "piter_provider_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_provider_sale_readback");
  }
  return finishProviderProjection();
}

if (ctx.step === "piter_provider_sale_readback") {
  const record = rows(msg.payload)[0];
  const result = ctx.providerResult || {};
  const expectedStatus = result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN";
  if (!saleProjectionMatches(record, ctx, expectedStatus, result)) {
    return fail(503, "Результат оплаты не подтверждён хранилищем", "PITER_PROVIDER_SALE_NOT_DURABLE");
  }
  return finishProviderProjection();
}

if (ctx.step === "piter_replay_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_replay_sale_readback");
  }
  return response(ctx.saleResponseStatus || 200, ctx.providerResult?.response || { ok: true, replayed: true });
}

if (ctx.step === "piter_replay_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, "PAYMENT_PENDING", ctx.providerResult || {})) {
    return fail(503, "Проекция покупки не восстановлена", "PITER_REPLAY_SALE_NOT_DURABLE");
  }
  return response(ctx.saleResponseStatus || 200, ctx.providerResult?.response || { ok: true, replayed: true });
}

if (ctx.step === "piter_confirm_result") {
  const result = ctx.confirmResult || {};
  if (!toStr(ctx.requestFingerprint)) {
    if (result.reconcile === true) return [null, null, null, null, null];
    return fail(503, "Legacy-платёж Питера требует отдельной сверки", "PITER_LEGACY_CONFIRM_REQUIRES_RECONCILIATION");
  }
  const expectedAmount = ctx.expectedAmountMinor;
  const validStatus = ["PAID", "FAILED", "PAYMENT_PENDING"].includes(result.nextStatus);
  const validAmount = Number.isInteger(expectedAmount) && expectedAmount > 0
    && Number.isInteger(result.toPayMinor) && result.toPayMinor >= 0
    && (result.nextStatus === "PAID" ? result.toPayMinor === 0
      : result.nextStatus === "FAILED" ? [0, expectedAmount].includes(result.toPayMinor)
        : result.toPayMinor === expectedAmount);
  if (!validStatus || !validAmount || !toStr(ctx.transactionId) || result.transactionId !== ctx.transactionId) {
    return fail(503, "Подтверждение оплаты требует сверки", "PITER_CONFIRM_PROVIDER_MISMATCH");
  }
  return ledgerFind(ctx, "piter_confirm_validate");
}

if (ctx.step === "piter_confirm_validate") {
  const result = ctx.confirmResult || {};
  const expectedAmount = ctx.expectedAmountMinor;
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  const recoveredTransaction = ctx.transactionRecovered === true
    && existing
    && !toStr(existing.transactionId);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400, ctx)
    || !existing
    || existing.requestFingerprint !== ctx.requestFingerprint
    || dispatchGeneration(existing.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || (!recoveredTransaction && existing.transactionId !== ctx.transactionId)
    || existing.priceMinor !== ctx.expectedAmountMinor
    || !(["PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(existing.state)
      || (recoveredTransaction && existing.state === "DISPATCHING")
      || existing.state === result.nextStatus)) {
    return fail(503, "Atomic ledger не прошёл проверку перед подтверждением", "PITER_CONFIRM_LEDGER_INVALID");
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_ledger_ack";
  const inc = { revision: 1 };
  if (result.nextStatus === "PAID") {
    inc.reservedCount = -1;
    inc.paidCount = 1;
    if (isHub(ctx) && existing.dailyDate === ledger.dailyDate) {
      inc.dailyReservedCount = -1;
      inc.dailyPaidCount = 1;
    }
  } else if (result.nextStatus === "FAILED") {
    inc.reservedCount = -1;
    inc.takenCount = -1;
    if (isHub(ctx) && existing.dailyDate === ledger.dailyDate) {
      inc.dailyReservedCount = -1;
    }
  }
  const confirmFilter = {
    _id: ledgerId(ctx),
    ready: ledger.ready,
    schemaVersion: 1,
    revision: ledger.revision,
    paidCount: ledger.paidCount,
    reservedCount: ledger.reservedCount,
    takenCount: ledger.takenCount,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      transactionId: recoveredTransaction ? { $in: [null, ""] } : ctx.transactionId,
      dispatchGeneration: generationFilter(ctx.dispatchGeneration),
      priceMinor: expectedAmount,
      state: { $in: recoveredTransaction
        ? ["DISPATCHING", "PROVIDER_UNKNOWN"]
        : ["PAYMENT_PENDING", "PROVIDER_UNKNOWN"] },
    } },
  };
  if (recoveredTransaction) {
    confirmFilter.$and = [{ reservations: { $not: { $elemMatch: {
      transactionId: ctx.transactionId,
      paymentRef: { $ne: ctx.paymentRef },
    } } } }];
  }
  return ledgerUpdate(ctx, confirmFilter, {
    $set: {
      "reservations.$.state": result.nextStatus,
      "reservations.$.transactionId": ctx.transactionId,
      "reservations.$.updatedAt": nowIso,
      "reservations.$.paymentUrl": result.paymentUrl || null,
      "reservations.$.paidAt": result.nextStatus === "PAID" ? nowIso : null,
      updatedAt: nowIso,
    },
    $inc: inc,
  });
}

if (ctx.step === "piter_confirm_ledger_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return ledgerFind(ctx, "piter_confirm_replay_find");
  }
  const result = ctx.confirmResult || {};
  if (isHub(ctx) && result.nextStatus === "PAID") {
    ctx.step = "managed_sale_instance_readback";
    return provider(ctx);
  }
  ctx.step = "piter_confirm_sale_ack";
  const nowIso = new Date().toISOString();
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $setOnInsert: ctx.saleRecord || {
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: ctx.clientPhone,
      clientId: ctx.clientId || null,
      productId: ctx.productId,
      productName: ctx.productName,
      amountMinor: ctx.expectedAmountMinor,
      createdAt: nowIso,
    },
    $set: {
      status: result.nextStatus,
      transactionId: ctx.transactionId,
      transactionRecoveredAt: toStr(ctx.transactionRecoveredAt),
      paidAt: result.paid ? nowIso : null,
      lastCheckedAt: nowIso,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "piter_confirm_replay_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === ledgerId(ctx));
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400, ctx)
    || !existing
    || existing.requestFingerprint !== ctx.requestFingerprint
    || dispatchGeneration(existing.dispatchGeneration) !== dispatchGeneration(ctx.dispatchGeneration)
    || existing.transactionId !== ctx.transactionId
    || existing.priceMinor !== ctx.expectedAmountMinor
    || existing.state !== ctx.confirmResult?.nextStatus) {
    return fail(503, "Atomic ledger не подтвердил результат оплаты", "PITER_CONFIRM_LEDGER_NOT_DURABLE");
  }
  const result = ctx.confirmResult || {};
  if (isHub(ctx) && result.nextStatus === "PAID") {
    ctx.step = "managed_sale_instance_readback";
    return provider(ctx);
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_sale_ack";
  return saleUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $setOnInsert: existing.saleRecord || {
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: existing.clientPhone,
      clientId: existing.clientId || null,
      batchIndex: existing.batchIndex,
      batchSize: existing.batchSize,
      productId: existing.productId,
      productName: existing.productName,
      amountMinor: existing.priceMinor,
      createdAt: existing.createdAt || nowIso,
    },
    $set: {
      status: result.nextStatus,
      transactionId: ctx.transactionId,
      transactionRecoveredAt: toStr(ctx.transactionRecoveredAt),
      paidAt: result.paid ? existing.paidAt || nowIso : null,
      lastCheckedAt: nowIso,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor,
      updatedAt: nowIso,
    },
  });
}

if (ctx.step === "piter_confirm_sale_ack") {
  if (!exactUpdateAck(msg.payload) && !exactUpsertAck(msg.payload)) {
    return saleFind(ctx, "piter_confirm_sale_readback");
  }
  return finishConfirmProjection();
}

if (ctx.step === "piter_confirm_sale_readback") {
  const record = rows(msg.payload)[0];
  if (!saleProjectionMatches(record, ctx, ctx.confirmResult?.nextStatus, {
    ...ctx.confirmResult, transactionId: ctx.transactionId,
  })) {
    return fail(503, "Результат оплаты не подтверждён sale record", "PITER_CONFIRM_SALE_NOT_DURABLE");
  }
  return finishConfirmProjection();
}

const managedProjectionMatches = (record, projection) => {
  if (!record || typeof record !== "object" || !projection?.set) return false;
  return Object.entries(projection.set).every(([key, expected]) => {
    const actual = record[key];
    if (expected && typeof expected === "object") {
      return JSON.stringify(actual) === JSON.stringify(expected);
    }
    return actual === expected;
  });
};

const finishManagedProjection = () => {
  const projection = ctx.managedSaleProjection || {};
  if (ctx.reconcile === true) return [null, null, null, null, null];
  msg.statusCode = Number(projection.statusCode) || 503;
  msg.headers = projection.headers || { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = projection.response || {
    error: "Результат подписки требует сверки",
    details: { code: "MANAGED_SALE_PROJECTION_RESPONSE_MISSING" },
  };
  delete msg.url;
  delete msg.method;
  return [null, null, null, msg, null];
};

if (ctx.step === "managed_sale_projection_start") {
  if (!isHub(ctx)
    || !toStr(ctx.paymentRef)
    || !toStr(ctx.requestFingerprint)
    || !ctx.managedSaleProjection?.set) {
    return fail(503, "Проекция продажи не подготовлена", "MANAGED_SALE_PROJECTION_INVALID");
  }
  ctx.step = "managed_sale_projection_ack";
  return ledgerUpdate(ctx, {
    _id: saleId(ctx),
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $set: ctx.managedSaleProjection.set,
  });
}

if (ctx.step === "managed_sale_projection_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return saleFind(ctx, "managed_sale_projection_readback");
  }
  return finishManagedProjection();
}

if (ctx.step === "managed_sale_projection_readback") {
  const record = rows(msg.payload)[0];
  if (!managedProjectionMatches(record, ctx.managedSaleProjection)) {
    return fail(503, "Проекция продажи не подтверждена хранилищем",
      "MANAGED_SALE_PROJECTION_NOT_DURABLE");
  }
  return finishManagedProjection();
}

return fail(500, "Unsupported Piter atomic sale step", "PITER_ATOMIC_STEP_UNSUPPORTED", { step: ctx.step });
