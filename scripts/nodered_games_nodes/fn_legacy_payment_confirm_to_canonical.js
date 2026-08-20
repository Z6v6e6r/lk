const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const envValue = (key) => {
  try {
    return toStr(env.get(key));
  } catch {
    return null;
  }
};
const respond = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
  msg.payload = { code, error };
  return [null, msg];
};

const ctx = isObj(msg._legacyPaymentConfirm) ? msg._legacyPaymentConfirm : null;
const evidence = isObj(msg._verifiedPaymentEvidence) ? msg._verifiedPaymentEvidence : null;
const baseUrl = envValue("PADLHUB_PLATFORM_INTERNAL_API_BASE_URL")?.replace(/\/+$/, "");
const tenantKey = envValue("PADLHUB_PLATFORM_TENANT_KEY");
const integrationToken = envValue("PADLHUB_LEGACY_ROSTER_TOKEN");
if (
  !ctx
  || !evidence
  || !baseUrl
  || !/^https?:\/\/[^\s]+$/i.test(baseUrl)
  || !tenantKey
  || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(tenantKey)
  || !integrationToken
  || integrationToken.length < 32
) {
  return respond(503, "LEGACY_PAYMENT_CONFIRM_CONTEXT_INVALID", "Подтверждение оплаты временно недоступно");
}
if (
  evidence.operationType !== ctx.operationType
  || evidence.operationId !== ctx.operationId
  || evidence.bookingId !== ctx.bookingId
  || evidence.exerciseId !== ctx.expectedExerciseId
  || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(toStr(evidence.exerciseId) || "")
  || !/^\+[1-9][0-9]{7,14}$/.test(toStr(evidence.clientPhoneE164) || "")
) {
  return respond(409, "LEGACY_PAYMENT_EVIDENCE_MISMATCH", "Проверка оплаты вернула противоречивые данные");
}
if (
  evidence.operationType === "SUBSCRIPTION_BOOKING"
  && (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(toStr(evidence.clientSubscriptionId) || "")
    || !Number.isSafeInteger(evidence.subscriptionVisitCount)
    || evidence.subscriptionVisitCount < 1
  )
) {
  return respond(409, "LEGACY_SUBSCRIPTION_BINDING_MISSING", "Viva не подтвердила точный абонемент списания");
}

msg._legacyRosterBridge = {
  gameId: ctx.gameId,
  idempotencyKey: ctx.idempotencyKey,
  command: "CONFIRM_PAYMENT",
  reservationId: ctx.reservationId,
  retryCount: 0,
};
msg._legacyPaymentEvidence = evidence;
msg.method = "POST";
msg.url = `${baseUrl}/${encodeURIComponent(tenantKey)}/legacy-games/${encodeURIComponent(ctx.gameId)}/roster-commands`;
msg.headers = {
  Authorization: ctx.authorization,
  "Content-Type": "application/json",
  "Idempotency-Key": ctx.idempotencyKey,
  "X-Phub-Legacy-Roster-Token": integrationToken,
  "X-Correlation-ID": toStr(msg.req?.headers?.["x-correlation-id"]) || ctx.idempotencyKey,
};
msg.payload = {
  command: "CONFIRM_PAYMENT",
  reservationId: ctx.reservationId,
  evidence: {
    provider: "VIVA",
    operationType: evidence.operationType,
    operationId: evidence.operationId,
    bookingId: evidence.bookingId,
    exerciseId: evidence.exerciseId,
    clientPhoneE164: evidence.clientPhoneE164,
    status: "CONFIRMED",
    verifiedAt: evidence.verifiedAt,
    ...(Number.isSafeInteger(evidence.amountMinor) && evidence.amountMinor >= 0
      ? { amountMinor: evidence.amountMinor }
      : {}),
    ...(toStr(evidence.currency) ? { currency: toStr(evidence.currency) } : {}),
  },
};
return [msg, null];
