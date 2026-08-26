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
  requestedAt: new Date().toISOString(),
};
msg.payload = {
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
