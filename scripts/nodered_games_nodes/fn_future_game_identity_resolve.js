const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
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
const fail = (ctx, statusCode, code, error) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: false,
      code,
      error,
      retryable: statusCode >= 500 || code === "GAME_WRITE_VERSION_CONFLICT",
      gameId: ctx?.gameId || null,
    },
  });
  return [null, response, response];
};

const ctx = msg._futureGameWrite && typeof msg._futureGameWrite === "object"
  ? msg._futureGameWrite
  : null;
if (!ctx?.persistentId || !ctx?.tenantKey || !ctx?.gameId || !ctx?.mode
  || !ctx?.update || typeof ctx.update !== "object") {
  return fail(ctx, 500, "GAME_WRITE_CONTEXT_MISSING", "Game persistence context is missing");
}
if (msg.error) {
  return fail(ctx, 503, "GAME_WRITE_IDENTITY_READ_FAILED", "Unable to read the existing game identity");
}

const records = asArray(msg.payload).filter((item) => item && typeof item === "object");
if (records.length > 1) {
  return fail(ctx, 409, "GAME_WRITE_IDENTITY_COLLISION", "Game identity is ambiguous");
}

const existing = records[0] || null;
let sourceRevision = null;
let upsert = false;
if (existing) {
  const exactIdentity = (
    toStr(existing._id) === ctx.persistentId
    && toStr(existing.tenantKey) === ctx.tenantKey
    && toStr(existing.id) === ctx.gameId
    && toStr(existing.dedupeKey) === ctx.dedupeKey
    && existing.createdByFlow === true
    && (!ctx.paymentRef || paymentRefs(existing).has(ctx.paymentRef))
  );
  sourceRevision = Number(existing.revision);
  if (!exactIdentity || !Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
    return fail(ctx, 409, "GAME_WRITE_LEGACY_IDENTITY", "Existing game does not have the future-write identity contract");
  }
  const existingStatus = toStr(existing.status)?.toUpperCase();
  const confirmAck = msg._gameConfirmWriteAck && typeof msg._gameConfirmWriteAck === "object"
    ? msg._gameConfirmWriteAck
    : null;
  if (
    ctx.mode === "confirm"
    && Number.isSafeInteger(ctx.expectedRevision)
    && sourceRevision === ctx.expectedRevision + 1
    && ["PAID", "PAYED"].includes(existingStatus)
    && confirmAck?.paymentRef === ctx.paymentRef
    && confirmAck?.transactionId
    && confirmAck?.bookingId
    && confirmAck?.exerciseId
    && toStr(existing.updatedAt)
  ) {
    confirmAck.step = "readback";
    confirmAck.tenantKey = ctx.tenantKey;
    confirmAck.persistentId = ctx.persistentId;
    confirmAck.expectedRevision = ctx.expectedRevision;
    confirmAck.expectedNextRevision = sourceRevision;
    confirmAck.expectedUpdatedAt = toStr(existing.updatedAt);
    msg._gameConfirmWriteAck = confirmAck;
    msg.payload = {
      _id: ctx.persistentId,
      tenantKey: ctx.tenantKey,
      id: ctx.gameId,
      revision: sourceRevision,
      updatedAt: confirmAck.expectedUpdatedAt,
      createdByFlow: true,
    };
    msg.limit = 2;
    msg.sort = { _id: 1 };
    delete msg.query;
    return [null, null, null, msg];
  }
  if (Number.isSafeInteger(ctx.expectedRevision) && sourceRevision !== ctx.expectedRevision) {
    return fail(ctx, 409, "GAME_WRITE_VERSION_CONFLICT", "Game revision changed before persistence");
  }
  if (ctx.mode !== "confirm") {
    return fail(ctx, 409, "GAME_WRITE_ALREADY_EXISTS", "Existing game cannot be replaced by an ordinary create request");
  }
} else {
  if (ctx.mode === "confirm" || Number.isSafeInteger(ctx.expectedRevision)) {
    return fail(ctx, 409, "GAME_WRITE_VERSION_CONFLICT", "Expected game revision is no longer available");
  }
  upsert = true;
}

const expectedNextRevision = existing ? sourceRevision + 1 : 1;
const identityFilter = ctx.paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": ctx.paymentRef },
        { "payment.paymentRef": ctx.paymentRef },
      ],
    }
  : { dedupeKey: ctx.dedupeKey };
const filter = {
  _id: ctx.persistentId,
  tenantKey: ctx.tenantKey,
  id: ctx.gameId,
  revision: existing ? sourceRevision : { $exists: false },
  ...(ctx.mode === "confirm" ? {
    archived: { $ne: true },
    status: "PAYMENT_PENDING",
  } : {}),
  ...identityFilter,
};

ctx.step = "write_ack";
ctx.upsert = upsert;
ctx.sourceRevision = sourceRevision;
ctx.expectedNextRevision = expectedNextRevision;
ctx.expectedUpdatedAt = toStr(ctx.update?.$set?.updatedAt);
msg._futureGameWrite = ctx;
msg.query = filter;
msg.payload = ctx.update;
delete msg.limit;
delete msg.sort;

if (msg._gameConfirmWriteAck && typeof msg._gameConfirmWriteAck === "object") {
  msg._gameConfirmWriteAck.tenantKey = ctx.tenantKey;
  msg._gameConfirmWriteAck.persistentId = ctx.persistentId;
  msg._gameConfirmWriteAck.expectedRevision = sourceRevision;
  msg._gameConfirmWriteAck.expectedNextRevision = expectedNextRevision;
  msg._gameConfirmWriteAck.expectedUpdatedAt = ctx.expectedUpdatedAt;
}

return [msg, null, null, null];
