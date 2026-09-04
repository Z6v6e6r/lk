const PITER_COUNTER_KEY = "piter_friendship";
const PITER_INVENTORY_ID = "piter_friendship_12m_2026_v1";
const LEDGER_ID = `inventory:${PITER_INVENTORY_ID}`;

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
  msg.payload = { _id: LEDGER_ID };
  return [msg, null, null, null, null];
};
const saleFind = (ctx, step) => {
  ctx.step = step;
  msg._summerSubscriptionCtx = ctx;
  msg.payload = { _id: `piter-sale:${ctx.inventoryId}:${ctx.paymentRef}` };
  return [msg, null, null, null, null];
};
const ledgerUpdate = (ctx, filter, update, options = {}) => {
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, Object.assign({ upsert: false }, options)];
  return [null, msg, null, null, null];
};
const saleUpdate = (ctx, filter, update) => {
  msg._summerSubscriptionCtx = ctx;
  msg.payload = [filter, update, { upsert: true }];
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
const ledgerIsStructurallyValid = (ledger, totalLimit) => {
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
  return ledger.paidCount === legacyRefs.length + paidReservations
    && ledger.reservedCount === activeReservations
    && activeIntentFingerprints.every(Boolean)
    && new Set(activeIntentFingerprints).size === activeIntentFingerprints.length
    && new Set(transactionIds).size === transactionIds.length;
};
const ledgerIsPurchaseReady = (ledger, totalLimit) => (
  ledger?.ready === true && ledgerIsStructurallyValid(ledger, totalLimit)
);
const saleInsert = (ctx, nowIso) => ({
      counterKey: ctx.counterKey,
      inventoryId: ctx.inventoryId,
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      clientPhone: ctx.clientPhone,
      clientId: ctx.clientId || null,
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
      successUrl: ctx.successUrl || null,
      failUrl: ctx.failUrl || null,
      createdAt: ctx.reservationCreatedAt || nowIso,
});
const projectSale = (ctx, result, nextStep) => {
  const nowIso = new Date().toISOString();
  ctx.step = nextStep;
  return saleUpdate(ctx, {
    _id: `piter-sale:${ctx.inventoryId}:${ctx.paymentRef}`,
    requestFingerprint: ctx.requestFingerprint,
  }, {
    $setOnInsert: ctx.saleRecord || saleInsert(ctx, nowIso),
    $set: {
      status: result.ok ? "PAYMENT_PENDING" : "PROVIDER_UNKNOWN",
      transactionId: result.transactionId || null,
      paymentUrl: result.paymentUrl || null,
      expiresAt: result.expiresAt || null,
      toPayMinor: result.toPayMinor ?? null,
      updatedAt: nowIso,
    },
  });
};
const saleProjectionMatches = (record, ctx, expectedStatus, result = {}) => Boolean(
  record
  && record._id === `piter-sale:${ctx.inventoryId}:${ctx.paymentRef}`
  && record.requestFingerprint === ctx.requestFingerprint
  && record.status === expectedStatus
  && record.amountMinor === (ctx.expectedAmountMinor ?? ctx.priceMinor)
  && (expectedStatus !== "PAYMENT_PENDING" || (toStr(result.transactionId) && toStr(result.paymentUrl)))
  && (result.transactionId == null || record.transactionId === result.transactionId)
  && (result.paymentUrl == null || record.paymentUrl === result.paymentUrl)
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
  return ledgerUpdate(ctx, {
    _id: LEDGER_ID, ready: true,
    reservations: { $elemMatch: { paymentRef: ctx.paymentRef, requestFingerprint: ctx.requestFingerprint, state: "CLAIMED" } },
  }, {
    $set: {
      "reservations.$.state": "DISPATCHING",
      "reservations.$.updatedAt": nowIso,
      "reservations.$.providerAttemptedAt": nowIso,
      updatedAt: nowIso,
    },
    $inc: { revision: 1 },
  });
};

const ctx = msg._summerSubscriptionCtx;
if (!ctx || ctx.counterKey !== PITER_COUNTER_KEY || ctx.inventoryId !== PITER_INVENTORY_ID) {
  return fail(500, "Piter atomic sale context is missing", "PITER_ATOMIC_CONTEXT_MISSING");
}

if (ctx.step === "piter_reserve_start") return ledgerFind(ctx);

if (ctx.step === "piter_ledger_find") {
  const ledger = rows(msg.payload).find((row) => row?._id === LEDGER_ID);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit)) {
    return fail(503, "Продажа Питера ещё не активирована", "PITER_ATOMIC_LEDGER_NOT_READY");
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
      providerLine.id = frozenProductId;
      providerLine.discount = existing.discountMinor;
      return dispatchClaim(ctx);
    }
    return fail(503, "Предыдущая попытка оплаты требует сверки", "PITER_ACTIVE_PURCHASE_UNRESOLVED", {
      paymentRef: existing.paymentRef,
      status: existing.state, message: "Попытка оплаты уже обрабатывается; повторный запрос в Viva не выполняется.",
    });
  }
  if (!ledgerIsPurchaseReady(ledger, ctx.totalLimit)) {
    return fail(503, "Продажа Питера остановлена", "PITER_ATOMIC_LEDGER_NOT_READY");
  }
  if (ledger.takenCount >= ctx.totalLimit) {
    return fail(409, "Лимит абонементов исчерпан", "PITER_INVENTORY_EXHAUSTED", {
      totalLimit: ctx.totalLimit, takenCount: ledger.takenCount,
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
    saleRecord: ctx.saleRecord,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return ledgerUpdate(ctx, {
    _id: LEDGER_ID, ready: true, revision: ledger.revision,
    takenCount: ledger.takenCount,
    $and: [
      { "reservations.paymentRef": { $ne: ctx.paymentRef } },
      { reservations: { $not: { $elemMatch: {
        intentFingerprint: currentIntentFingerprint, state: { $in: ACTIVE_RESERVATION_STATES },
      } } } },
    ],
  }, {
    $inc: { revision: 1, reservedCount: 1, takenCount: 1 },
    $push: { reservations: reservation },
    $set: { updatedAt: nowIso },
  });
}

if (ctx.step === "piter_reserve_ack") {
  if (!exactUpdateAck(msg.payload)) {
    ctx.atomicRetryCount = Number(ctx.atomicRetryCount || 0) + 1;
    if (ctx.atomicRetryCount > 3) {
      return fail(409, "Не удалось зафиксировать место, повторите попытку", "PITER_CAPACITY_CAS_CONFLICT");
    }
    return ledgerFind(ctx);
  }
  ctx.step = "piter_dispatch_claim";
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_dispatch_claim") {
  return dispatchClaim(ctx);
}

if (ctx.step === "piter_dispatch_ack") {
  if (!exactUpdateAck(msg.payload)) {
    return fail(409, "Попытка оплаты уже запущена", "PITER_PROVIDER_ATTEMPT_ALREADY_CLAIMED");
  }
  ctx.step = "create_transaction";
  return provider(ctx);
}

if (ctx.step === "piter_provider_result") {
  const result = ctx.providerResult || {};
  const nowIso = new Date().toISOString();
  ctx.step = "piter_provider_ledger_ack";
  const resultFilter = {
    _id: LEDGER_ID,
    $and: [{ reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef, requestFingerprint: ctx.requestFingerprint, state: "DISPATCHING",
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
  const ledger = rows(msg.payload).find((row) => row?._id === LEDGER_ID);
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400)
    || !existing
    || existing.requestFingerprint !== ctx.requestFingerprint
    || existing.transactionId !== ctx.transactionId
    || existing.priceMinor !== ctx.expectedAmountMinor
    || !(["PAYMENT_PENDING", "PROVIDER_UNKNOWN"].includes(existing.state)
      || existing.state === result.nextStatus)) {
    return fail(503, "Atomic ledger не прошёл проверку перед подтверждением", "PITER_CONFIRM_LEDGER_INVALID");
  }
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_ledger_ack";
  const inc = { revision: 1 };
  if (result.nextStatus === "PAID") {
    inc.reservedCount = -1;
    inc.paidCount = 1;
  } else if (result.nextStatus === "FAILED") {
    inc.reservedCount = -1;
    inc.takenCount = -1;
  }
  return ledgerUpdate(ctx, {
    _id: LEDGER_ID,
    ready: ledger.ready,
    schemaVersion: 1,
    revision: ledger.revision,
    paidCount: ledger.paidCount,
    reservedCount: ledger.reservedCount,
    takenCount: ledger.takenCount,
    reservations: { $elemMatch: {
      paymentRef: ctx.paymentRef,
      requestFingerprint: ctx.requestFingerprint,
      transactionId: ctx.transactionId,
      priceMinor: expectedAmount,
      state: { $in: ["PAYMENT_PENDING", "PROVIDER_UNKNOWN"] },
    } },
  }, {
    $set: {
      "reservations.$.state": result.nextStatus,
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
  ctx.step = "piter_confirm_sale_ack";
  const nowIso = new Date().toISOString();
  return saleUpdate(ctx, {
    _id: `piter-sale:${ctx.inventoryId}:${ctx.paymentRef}`,
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
  const ledger = rows(msg.payload).find((row) => row?._id === LEDGER_ID);
  const existing = ledger?.reservations?.find((item) => item?.paymentRef === ctx.paymentRef);
  if (!ledgerIsStructurallyValid(ledger, ctx.totalLimit || 400)
    || !existing
    || existing.requestFingerprint !== ctx.requestFingerprint
    || existing.transactionId !== ctx.transactionId
    || existing.priceMinor !== ctx.expectedAmountMinor
    || existing.state !== ctx.confirmResult?.nextStatus) {
    return fail(503, "Atomic ledger не подтвердил результат оплаты", "PITER_CONFIRM_LEDGER_NOT_DURABLE");
  }
  const result = ctx.confirmResult || {};
  const nowIso = new Date().toISOString();
  ctx.step = "piter_confirm_sale_ack";
  return saleUpdate(ctx, {
    _id: `piter-sale:${ctx.inventoryId}:${ctx.paymentRef}`,
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

return fail(500, "Unsupported Piter atomic sale step", "PITER_ATOMIC_STEP_UNSUPPORTED", { step: ctx.step });
