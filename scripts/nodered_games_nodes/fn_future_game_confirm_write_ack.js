const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const fail = (ctx, statusCode, code, error) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { ok: false, code, error, retryable: true, paymentRef: ctx?.paymentRef || null },
  });
  return [null, response, response];
};
const paymentRefs = (record) => {
  const metadata = record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const split = metadata.splitPayment && typeof metadata.splitPayment === "object" ? metadata.splitPayment : {};
  return new Set([
    metadata.paymentRef,
    split.paymentRef,
    record?.payment?.paymentRef,
    ...asArray(split.payments).map((item) => item?.paymentRef),
  ].map(toStr).filter(Boolean));
};
const transactionIds = (record) => {
  const split = record?.metadata?.splitPayment && typeof record.metadata.splitPayment === "object"
    ? record.metadata.splitPayment
    : {};
  return new Set([
    record?.payment?.transactionId,
    ...asArray(split.payments).map((item) => item?.transactionId),
  ].map(toStr).filter(Boolean));
};
const bookingIds = (record) => new Set([
  record?.booking?.bookingId,
  ...asArray(record?.booking?.bookingIds),
  ...asArray(record?.metadata?.bookingIds),
  ...asArray(record?.payment?.bookingIds),
].map(toStr).filter(Boolean));
const exerciseIds = (record) => new Set([
  record?.booking?.exerciseId,
  record?.booking?.vivaExerciseId,
  record?.metadata?.exerciseId,
  record?.metadata?.vivaExerciseId,
  record?.metadata?.splitPayment?.exerciseId,
  record?.metadata?.splitPayment?.vivaExerciseId,
].map(toStr).filter(Boolean));
const prepareReadback = (ctx) => {
  ctx.step = "readback";
  msg._gameConfirmWriteAck = ctx;
  msg.payload = {
    _id: ctx.persistentId,
    tenantKey: ctx.tenantKey,
    id: ctx.gameId,
    revision: ctx.expectedNextRevision,
    updatedAt: ctx.expectedUpdatedAt,
    createdByFlow: true,
  };
  msg.limit = 2;
  msg.sort = { _id: 1 };
  return [msg, null, null];
};

const ctx = msg._gameConfirmWriteAck && typeof msg._gameConfirmWriteAck === "object"
  ? msg._gameConfirmWriteAck
  : null;
if (!ctx?.persistentId || !ctx?.gameId || !ctx?.tenantKey
  || !Number.isSafeInteger(ctx?.expectedNextRevision) || ctx.expectedNextRevision < 2
  || !ctx?.expectedUpdatedAt || !ctx?.paymentRef || !ctx?.transactionId
  || !ctx?.bookingId || !ctx?.exerciseId) {
  if (toStr(msg._requestMode)?.toLowerCase() !== "confirm") return [null, null, null];
  return fail(ctx, 500, "GAME_PAYMENT_WRITE_ACK_CONTEXT_MISSING", "Payment write acknowledgement context is missing");
}

if (ctx.step === "write_ack") {
  const raw = Array.isArray(msg.payload) ? (msg.payload[0] || {}) : (msg.payload || {});
  const acknowledged = raw?.acknowledged === true;
  const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? 0);
  const hasMongoError = Boolean(msg.error) || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
  if (!acknowledged || hasMongoError) {
    ctx.ambiguousAck = true;
    return prepareReadback(ctx);
  }
  if (matchedCount !== 1) {
    return fail(ctx, 409, "GAME_PAYMENT_CAS_MISS", "Payment confirmation state changed before persistence");
  }
  return prepareReadback(ctx);
}

if (ctx.step !== "readback") {
  return fail(ctx, 500, "GAME_PAYMENT_WRITE_ACK_STEP_INVALID", "Unsupported payment write acknowledgement step");
}
const records = asArray(msg.payload).filter((item) => item && typeof item === "object");
if (records.length !== 1) {
  return fail(ctx, 503, "GAME_PAYMENT_WRITE_READBACK_FAILED", "Confirmed game readback is missing or ambiguous");
}
const record = records[0];
const status = toStr(record.status)?.toUpperCase();
const exact = (
  toStr(record._id) === ctx.persistentId
  && toStr(record.id) === ctx.gameId
  && toStr(record.tenantKey) === ctx.tenantKey
  && Number(record.revision) === ctx.expectedNextRevision
  && toStr(record.updatedAt) === ctx.expectedUpdatedAt
  && record.createdByFlow === true
  && (status === "PAID" || status === "PAYED")
  && record?.payment?.paid === true
  && paymentRefs(record).has(ctx.paymentRef)
  && transactionIds(record).has(ctx.transactionId)
  && bookingIds(record).has(ctx.bookingId)
  && exerciseIds(record).has(ctx.exerciseId)
);
if (!exact) {
  return fail(ctx, 409, "GAME_PAYMENT_CAS_MISS", "Payment confirmation was not durably applied");
}
const response = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: record,
});
delete response._gameConfirmWriteAck;
return [null, response, null];
