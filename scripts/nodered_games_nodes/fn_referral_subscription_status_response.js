const PLAN_CONFIGS = {
  academy: {
    planKey: "academy",
    productId: "9eb8a7a4-c195-492a-95e4-3fb82899ac10",
    productName: "Лето.Падел.Академия",
    priceMinor: 2380000,
  },
  friendship: {
    planKey: "friendship",
    productId: "b2e6a9d4-53b5-4f79-87ec-3fb076381e9b",
    productName: "Лето.Падел.Дружба",
    priceMinor: 980000,
  },
  ra: {
    planKey: "ra",
    productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759",
    productName: "Лето.Падел.РА",
    priceMinor: 2380000,
  },
  sport: {
    planKey: "sport",
    productId: "82caad6f-4d19-4d01-852b-932bdbb0f405",
    productName: "Лето.Падел.Спорт",
    priceMinor: 1980000,
  },
};
const PLAN_ORDER = ["friendship", "sport", "academy", "ra"];
const TOTAL_LIMIT = 1;

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

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "academy" || normalized === "friendship" || normalized === "ra" || normalized === "sport") {
    return normalized;
  }
  return null;
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const normalizePaymentStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "PAYMENT_PENDING";
  if (status.includes("PAID") || status.includes("SUCCESS") || status.includes("COMPLETE")) return "PAID";
  if (status.includes("FAIL") || status.includes("CANCEL") || status.includes("REJECT")) return "FAILED";
  if (status.includes("EXPIRE")) return "EXPIRED";
  return "PAYMENT_PENDING";
};

const normalizeSubscriptionStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return "NOT_REQUESTED";
  if (status === "PENDING_ISSUE" || status === "ISSUED" || status === "ISSUE_FAILED" || status === "NOT_REQUESTED") {
    return status;
  }
  return "NOT_REQUESTED";
};

const isActiveReservation = (row, nowTs) => {
  const paymentStatus = normalizePaymentStatus(row.paymentStatus || row.status);
  const subscriptionStatus = normalizeSubscriptionStatus(row.subscriptionStatus);
  if (subscriptionStatus === "ISSUED" || subscriptionStatus === "PENDING_ISSUE") return true;
  if (paymentStatus === "PAID") return true;
  if (paymentStatus !== "PAYMENT_PENDING") return false;

  const expiresAtTs = toTs(row.paymentExpiresAt || row.expiresAt);
  return expiresAtTs === null || expiresAtTs > nowTs;
};

const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [response, response];
};

const ctx = msg._referralSubscriptionCtx && typeof msg._referralSubscriptionCtx === "object"
  ? msg._referralSubscriptionCtx
  : null;

if (!ctx || ctx.action !== "status") {
  return fail(500, "Referral subscription status context is missing");
}

const flowType = normalizeFlowType(ctx.flowType);
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const nowTs = Date.now();
const scopedRows = rows.filter((row) => {
  if (!row || typeof row !== "object") return false;
  if (toStr(row.ownerSubscriptionId) && toStr(row.ownerSubscriptionId) !== toStr(ctx.ownerSubscriptionId)) return false;
  if (toStr(row.ownerCycleKey) && toStr(ctx.ownerCycleKey) && toStr(row.ownerCycleKey) !== toStr(ctx.ownerCycleKey)) return false;
  return normalizeFlowType(row.flowType || row.mode) === flowType;
});

const renewalPurchased = scopedRows.some((row) => {
  const paymentStatus = normalizePaymentStatus(row.paymentStatus || row.status);
  const subscriptionStatus = normalizeSubscriptionStatus(row.subscriptionStatus);
  return subscriptionStatus === "ISSUED" || subscriptionStatus === "PENDING_ISSUE" || paymentStatus === "PAID";
});

const planOrder = flowType === "renewal" && normalizePlanKey(ctx.ownerPlanKey)
  ? [normalizePlanKey(ctx.ownerPlanKey)]
  : PLAN_ORDER;

const plans = planOrder
  .filter((planKey) => Boolean(planKey && PLAN_CONFIGS[planKey]))
  .map((planKey) => {
    let paidCount = 0;
    let reservedCount = 0;
    let updatedAt = null;
    let activeRecord = null;

    scopedRows.forEach((row) => {
      if (!row || typeof row !== "object") return;
      if (normalizePlanKey(row.planKey) !== planKey) return;

      const rowUpdatedAtTs = toTs(row.updatedAt) || toTs(row.createdAt);
      if (rowUpdatedAtTs !== null) {
        if (!updatedAt || rowUpdatedAtTs > toTs(updatedAt)) {
          updatedAt = new Date(rowUpdatedAtTs).toISOString();
        }
      }

      const paymentStatus = normalizePaymentStatus(row.paymentStatus || row.status);
      const subscriptionStatus = normalizeSubscriptionStatus(row.subscriptionStatus);
      if (subscriptionStatus === "ISSUED" || paymentStatus === "PAID" || subscriptionStatus === "PENDING_ISSUE") {
        paidCount += 1;
      } else if (isActiveReservation(row, nowTs)) {
        reservedCount += 1;
      }

      if (!activeRecord && isActiveReservation(row, nowTs)) {
        activeRecord = row;
      }
    });

    const takenCount = paidCount + reservedCount;
    const remainingCount = Math.max(TOTAL_LIMIT - takenCount, 0);
    const config = PLAN_CONFIGS[planKey];

    return {
      planKey,
      flowType,
      ownerCycleKey: toStr(ctx.ownerCycleKey),
      productId: config.productId,
      productName: config.productName,
      totalLimit: TOTAL_LIMIT,
      paidCount,
      reservedCount,
      takenCount,
      remainingCount,
      canPurchase: flowType === "renewal" ? (!renewalPurchased && remainingCount > 0) : remainingCount > 0,
      priceMinor: config.priceMinor,
      price: config.priceMinor / 100,
      updatedAt,
      paymentStatus: normalizePaymentStatus(activeRecord?.paymentStatus || activeRecord?.status),
      subscriptionStatus: normalizeSubscriptionStatus(activeRecord?.subscriptionStatus),
      activePaymentRef: toStr(activeRecord?.paymentRef),
      activePaymentUrl: toStr(activeRecord?.paymentUrl),
      activePaymentExpiresAt: toStr(activeRecord?.paymentExpiresAt || activeRecord?.expiresAt),
      issuedSubscriptionId: toStr(activeRecord?.issuedSubscriptionId),
      issuedAt: toStr(activeRecord?.issuedAt),
    };
  });

const response = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: {
    ok: true,
    owner: {
      inviteId: toStr(ctx.inviteId),
      ownerPhone: null,
      ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
      ownerCycleKey: toStr(ctx.ownerCycleKey),
      flowType,
      subscriptionName: toStr(ctx.ownerSubscriptionName),
      expirationDate: toStr(ctx.expirationDate),
      windowStartsAt: toStr(ctx.windowStartsAt),
      windowEndsAt: toStr(ctx.windowEndsAt),
      windowActive: ctx.windowActive === true,
      countdownVisible: ctx.countdownVisible === true,
      renewalPurchased,
    },
    plans,
  },
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_response",
    inviteId: toStr(ctx.inviteId),
    ownerPhone: toStr(ctx.ownerPhone),
    ownerSubscriptionId: toStr(ctx.ownerSubscriptionId),
    ownerCycleKey: toStr(ctx.ownerCycleKey),
    flowType,
    renewalPurchased,
    plans,
  },
});

return [response, debugMsg];
