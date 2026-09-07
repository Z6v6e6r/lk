const PLATFORM_TENANT_KEY = "iSkq6G";
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const fail = (statusCode, code, error) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { ok: false, code, error },
  });
  return [null, response];
};

let runtimeTenantKey = null;
try { runtimeTenantKey = toStr(env.get("PADLHUB_PLATFORM_TENANT_KEY")); } catch (_error) { runtimeTenantKey = null; }
if (runtimeTenantKey && runtimeTenantKey !== PLATFORM_TENANT_KEY) {
  return fail(503, "GAME_TENANT_CONFIG_MISMATCH", "Game tenant configuration does not match this deployment");
}

const body = msg.payload && typeof msg.payload === "object" && !Array.isArray(msg.payload)
  ? msg.payload
  : {};
const paymentRef = toStr(body.paymentRef || body.payment?.paymentRef || body.metadata?.paymentRef);
if (!paymentRef || paymentRef.length > 180) {
  return fail(400, "GAME_PAYMENT_REF_REQUIRED", "paymentRef is required");
}

msg._gamePaymentConfirmCtx = {
  step: "draft_lookup",
  paymentRef,
  tenantKey: PLATFORM_TENANT_KEY,
  requestedAt: new Date().toISOString(),
};
msg.payload = {
  tenantKey: PLATFORM_TENANT_KEY,
  $or: [
    { "metadata.paymentRef": paymentRef },
    { "metadata.splitPayment.paymentRef": paymentRef },
    { "metadata.splitPayment.payments.paymentRef": paymentRef },
    { "payment.paymentRef": paymentRef },
  ],
};
msg.limit = 2;
msg.sort = { updatedAt: -1, _id: -1 };
return [msg, null];
