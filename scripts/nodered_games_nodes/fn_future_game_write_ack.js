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
const writeResult = (value) => Array.isArray(value) ? (value[0] || {}) : (value || {});
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
  const debug = Object.assign({}, response, {
    payload: { action: "future_game_write_failed", code, gameId: ctx?.gameId || null },
  });
  return [null, response, debug, null, null];
};

const ctx = msg._futureGameWrite && typeof msg._futureGameWrite === "object"
  ? msg._futureGameWrite
  : null;
if (!ctx?.persistentId || !ctx?.tenantKey || !ctx?.gameId || !ctx?.mode
  || !Number.isSafeInteger(ctx?.expectedNextRevision) || ctx.expectedNextRevision < 1) {
  return fail(ctx, 500, "GAME_WRITE_ACK_CONTEXT_MISSING", "Game write acknowledgement context is missing");
}
const prepareReadback = () => {
  ctx.step = "readback";
  msg._futureGameWrite = ctx;
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
  return [msg, null, null, null, null];
};

if (ctx.mode === "confirm") {
  return [null, null, null, null, msg];
}

if (ctx.step === "write_ack") {
  const raw = writeResult(msg.payload);
  const acknowledged = raw?.acknowledged === true;
  const matchedCount = Number(raw?.matchedCount ?? raw?.result?.matchedCount ?? 0);
  const upsertedCount = Number(raw?.upsertedCount ?? raw?.result?.upsertedCount ?? 0);
  const upsertedId = raw?.upsertedId ?? raw?.result?.upsertedId ?? null;
  const hasMongoError = Boolean(msg.error) || Boolean(raw?.error || raw?.errmsg || raw?.codeName || raw?.writeErrors);
  const exactWrite = ctx.upsert
    ? matchedCount === 0 && (upsertedCount === 1 || toStr(upsertedId) === ctx.persistentId)
    : matchedCount === 1 && upsertedCount === 0 && !upsertedId;
  if (!acknowledged || hasMongoError) {
    ctx.ambiguousAck = true;
    return prepareReadback();
  }
  if (!exactWrite) {
    return fail(
      ctx,
      409,
      "GAME_WRITE_VERSION_CONFLICT",
      "Game revision changed before persistence",
    );
  }
  return prepareReadback();
}

if (ctx.step !== "readback") {
  return fail(ctx, 500, "GAME_WRITE_ACK_STEP_INVALID", "Unsupported game write acknowledgement step");
}

const records = asArray(msg.payload).filter((item) => item && typeof item === "object");
if (records.length !== 1) {
  return fail(ctx, 503, "GAME_WRITE_READBACK_FAILED", "Persisted game readback is missing or ambiguous");
}
const record = records[0];
const exact = (
  toStr(record._id) === ctx.persistentId
  && toStr(record.tenantKey) === ctx.tenantKey
  && toStr(record.id) === ctx.gameId
  && toStr(record.dedupeKey) === ctx.dedupeKey
  && Number(record.revision) === ctx.expectedNextRevision
  && toStr(record.updatedAt) === ctx.expectedUpdatedAt
  && record.createdByFlow === true
  && (!ctx.paymentRef || paymentRefs(record).has(ctx.paymentRef))
);
if (!exact) {
  return fail(ctx, 409, "GAME_WRITE_READBACK_MISMATCH", "Persisted game does not match the acknowledged write");
}

const response = Object.assign({}, msg, {
  statusCode: Number(ctx.httpStatus) || 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: record,
});
const debug = Object.assign({}, msg, {
  payload: {
    action: "future_game_write_acknowledged",
    mode: ctx.mode,
    gameId: ctx.gameId,
    revision: ctx.expectedNextRevision,
  },
});
const autojoin = Object.assign({}, msg, {
  _requestMode: ctx.mode,
  _gameAutojoinSource: "games_create",
  payload: record,
});
for (const output of [response, debug, autojoin]) {
  delete output._futureGameWrite;
  delete output._gameConfirmWriteAck;
}
return [null, response, debug, autojoin, null];
