const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const KEY_TOKEN = "vivacrm_access_token";
const KEY_EXPIRES_AT = "vivacrm_token_expires_at";
const TOKEN_CLIENT_ID_DEFAULT = "React-auth-dev";
const TOKEN_CACHE_GRACE_MS = 30 * 1000;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const toNumber = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (values) => Array.from(new Set(values.map((value) => toStr(value)).filter(Boolean)));
const clone = (value) => JSON.parse(JSON.stringify(value));
const readGlobal = (key) => {
  try { return global.get(key); } catch (_error) { return null; }
};
const writeGlobal = (key, value) => {
  try { global.set(key, value); } catch (_error) { /* cache is optional */ }
};
const readEnv = (key) => {
  try { return toStr(env.get(key)); } catch (_error) { return null; }
};
const normalizeStatus = (value) => String(value || "").trim().toUpperCase();
const recordPaymentRefs = (record) => {
  const metadata = record?.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const split = metadata.splitPayment && typeof metadata.splitPayment === "object" ? metadata.splitPayment : {};
  return uniq([
    metadata.paymentRef,
    split.paymentRef,
    record?.payment?.paymentRef,
    ...asArray(split.payments).map((item) => item?.paymentRef),
  ]);
};
const recordBookingIds = (record) => uniq([
  record?.booking?.bookingId,
  ...asArray(record?.booking?.bookingIds),
  ...asArray(record?.metadata?.bookingIds),
]);
const collectProviderIds = (payload, keys) => {
  const wanted = new Set(keys);
  const ids = new Set();
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    Object.entries(value).forEach(([key, candidate]) => {
      if (wanted.has(key)) {
        const values = Array.isArray(candidate) ? candidate : [candidate];
        values.forEach((entry) => {
          const id = toStr(entry && typeof entry === "object"
            ? (entry.id || entry.uuid || entry.bookingId || entry.exerciseId || entry.clientId)
            : entry);
          if (id) ids.add(id);
        });
      }
      visit(candidate, depth + 1);
    });
  };
  visit(payload, 0);
  return Array.from(ids);
};
const findExactTransactionRecord = (payload, expectedTransactionId) => {
  const expectedId = toStr(expectedTransactionId);
  if (!expectedId) return { record: null, reason: "expected_transaction_missing" };
  const matches = [];
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 8) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    const transactionId = toStr(value.transactionId || value.transaction_id || value.id);
    const status = normalizeStatus(value.status || value.state || value.paymentStatus || value.transactionStatus);
    const amount = toNumber(value.amountMinor ?? value.totalAmountMinor ?? value.paidAmountMinor ?? value.toPay);
    if (transactionId === expectedId && (status || amount !== null)) matches.push(value);
    Object.values(value).forEach((candidate) => visit(candidate, depth + 1));
  };
  visit(payload, 0);
  if (matches.length !== 1) {
    return {
      record: null,
      reason: matches.length === 0 ? "transaction_record_missing" : "transaction_record_ambiguous",
    };
  }
  return { record: matches[0], reason: null };
};
const fail = (ctx, statusCode, code, error, details = null) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      ok: false,
      code,
      error,
      retryable: code === "GAME_PAYMENT_PENDING" || statusCode >= 500,
      paymentRef: ctx?.paymentRef || null,
      details,
    },
  });
  return [null, null, response, response, null, null];
};
const requestTransaction = (ctx) => {
  msg._gamePaymentConfirmCtx = ctx;
  msg.method = "GET";
  msg.url = `${ADMIN_API}/transactions/${encodeURIComponent(ctx.transactionId)}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = null;
  ctx.step = "transaction_lookup";
  return [msg, null, null, null, null, null];
};
const finishVerified = (ctx, status) => {
  const nowIso = new Date().toISOString();
  const record = clone(ctx.record);
  const metadata = record.metadata && typeof record.metadata === "object" ? record.metadata : {};
  const split = metadata.splitPayment && typeof metadata.splitPayment === "object" ? metadata.splitPayment : {};
  const payments = asArray(split.payments).map((item) => {
    if (!item || typeof item !== "object" || toStr(item.paymentRef) !== ctx.paymentRef) return item;
    return {
      ...item,
      status: "PAID",
      paidAt: toStr(item.paidAt) || nowIso,
      transactionStatus: status,
      transactionStatusCheckedAt: nowIso,
      transactionStatusSource: "viva_transaction_readback",
    };
  });
  const verifiedPayload = {
    ...record,
    gameId: record.id,
    tenantKey: ctx.tenantKey,
    expectedRevision: ctx.expectedRevision,
    expectedUpdatedAt: ctx.expectedUpdatedAt,
    status: "PAID",
    paymentRef: ctx.paymentRef,
    payment: {
      ...(record.payment || {}),
      paymentRef: ctx.paymentRef,
      paid: true,
      paidAt: toStr(record.payment?.paidAt) || nowIso,
    },
    metadata: {
      ...metadata,
      paymentRef: ctx.paymentRef,
      splitPayment: {
        ...split,
        payments,
        organizerPaymentConfirmedAt: nowIso,
        organizerPaymentConfirmationSource: "viva_transaction_readback",
      },
    },
  };
  const verifiedMsg = Object.assign({}, msg, {
    payload: verifiedPayload,
    _action: "confirm",
    _gamePaymentVerified: {
      verified: true,
      source: "viva_transaction_readback",
      paymentRef: ctx.paymentRef,
      transactionId: ctx.transactionId,
      bookingId: ctx.bookingId,
      exerciseId: ctx.exerciseId,
      checkedAt: nowIso,
    },
  });
  delete verifiedMsg.method;
  delete verifiedMsg.url;
  delete verifiedMsg.statusCode;
  delete verifiedMsg.headers;
  return [null, verifiedMsg, null, null, null, null];
};
const requestToken = (ctx) => {
  const cachedToken = toStr(readGlobal(KEY_TOKEN));
  const expiresAt = Number(readGlobal(KEY_EXPIRES_AT) || 0);
  if (cachedToken && Number.isFinite(expiresAt) && expiresAt > Date.now() + TOKEN_CACHE_GRACE_MS) {
    ctx.token = cachedToken;
    return requestTransaction(ctx);
  }
  const username = readEnv("VIVA_SERVICE_USERNAME");
  const password = readEnv("VIVA_SERVICE_PASSWORD");
  if (!username || !password) {
    return fail(ctx, 503, "GAME_PAYMENT_PROVIDER_AUTH_UNAVAILABLE", "Viva service auth is not configured");
  }
  const clientId = readEnv("VIVA_SERVICE_CLIENT_ID") || TOKEN_CLIENT_ID_DEFAULT;
  const tokenUrl = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL;
  msg._gamePaymentConfirmCtx = ctx;
  msg.method = "POST";
  msg.url = tokenUrl;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload = [
    ["grant_type", "password"],
    ["client_id", clientId],
    ["username", username],
    ["password", password],
  ].map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  ctx.step = "token_lookup";
  return [msg, null, null, null];
};

const ctx = msg._gamePaymentConfirmCtx && typeof msg._gamePaymentConfirmCtx === "object"
  ? msg._gamePaymentConfirmCtx
  : null;
if (!ctx?.paymentRef) return fail(ctx, 500, "GAME_PAYMENT_CONFIRM_CONTEXT_MISSING", "Payment confirmation context is missing");

if (ctx.step === "claim_write") {
  ctx.step = "claim_read";
  msg._gamePaymentConfirmCtx = ctx;
  msg.payload = { _id: ctx.claimId };
  msg.limit = 2;
  msg.sort = { _id: 1 };
  return [null, null, null, null, null, msg];
}

if (ctx.step === "claim_read") {
  const claims = asArray(msg.payload).filter((item) => item && typeof item === "object");
  if (claims.length !== 1) {
    return fail(ctx, 503, "GAME_PAYMENT_CLAIM_READBACK_FAILED", "Не удалось подтвердить владение транзакцией");
  }
  const claim = claims[0];
  const exactOwner = (
    toStr(claim.gameId) === toStr(ctx.record?.id)
    && toStr(claim.paymentRef) === ctx.paymentRef
    && toStr(claim.transactionId) === ctx.transactionId
    && toStr(claim.bookingId) === ctx.bookingId
    && toStr(claim.exerciseId) === ctx.exerciseId
    && toStr(claim.clientId) === ctx.clientId
  );
  if (!exactOwner) {
    return fail(ctx, 409, "GAME_PAYMENT_EVIDENCE_REPLAY", "Транзакция уже привязана к другой игре");
  }
  return finishVerified(ctx, "PAID");
}

if (ctx.step === "draft_lookup") {
  const records = asArray(msg.payload).filter((item) => item && typeof item === "object");
  if (records.length === 0) return fail(ctx, 404, "GAME_PAYMENT_DRAFT_NOT_FOUND", "Черновик игры не найден");
  if (records.length !== 1) return fail(ctx, 409, "GAME_PAYMENT_DRAFT_COLLISION", "Найдено несколько черновиков платежа");
  const record = records[0];
  if (!recordPaymentRefs(record).includes(ctx.paymentRef)) {
    return fail(ctx, 409, "GAME_PAYMENT_REF_MISMATCH", "Черновик не соответствует paymentRef");
  }
  const recordStatus = normalizeStatus(record.status);
  if (["CANCELLED", "CANCELED", "FAILED", "EXPIRED", "REJECTED"].includes(recordStatus)) {
    return fail(ctx, 409, "GAME_PAYMENT_TERMINAL_FAILED", "Платёж завершился без публикации игры");
  }
  const tenantKey = toStr(record.tenantKey);
  const expectedRevision = Number(record.revision);
  const expectedUpdatedAt = toStr(record.updatedAt);
  if (!tenantKey || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !expectedUpdatedAt) {
    return fail(ctx, 409, "GAME_PAYMENT_STALE_GUARD_REQUIRED", "Черновик не содержит свежую tenant/revision identity");
  }
  const split = record?.metadata?.splitPayment && typeof record.metadata.splitPayment === "object"
    ? record.metadata.splitPayment
    : {};
  const payment = asArray(split.payments).find((item) => (
    item
    && typeof item === "object"
    && toStr(item.paymentRef) === ctx.paymentRef
    && normalizeStatus(item.role) === "ORGANIZER"
  ));
  const transactionId = toStr(payment?.transactionId);
  const bookingId = toStr(payment?.bookingId) || recordBookingIds(record)[0] || null;
  const exerciseId = toStr(record?.booking?.exerciseId || record?.booking?.vivaExerciseId || split.exerciseId || split.vivaExerciseId);
  const clientId = toStr(payment?.clientId || record?.organizer?.id);
  const paymentAmount = toNumber(payment?.amount);
  const amountMinor = toNumber(payment?.amountMinor) ?? (
    paymentAmount === null ? null : Math.round(paymentAmount * 100)
  );
  if (!transactionId || !bookingId || !exerciseId || !clientId || amountMinor === null) {
    return fail(ctx, 409, "GAME_PAYMENT_EVIDENCE_INCOMPLETE", "Черновик не содержит точных данных транзакции");
  }
  Object.assign(ctx, {
    record: clone(record),
    tenantKey,
    expectedRevision,
    expectedUpdatedAt,
    transactionId,
    bookingId,
    exerciseId,
    clientId,
    amountMinor: Math.round(amountMinor),
  });
  return requestToken(ctx);
}

if (ctx.step === "token_lookup") {
  const token = toStr(msg.payload?.access_token);
  if (Number(msg.statusCode) < 200 || Number(msg.statusCode) >= 300 || !token) {
    return fail(ctx, 503, "GAME_PAYMENT_PROVIDER_AUTH_FAILED", "Не удалось авторизоваться в Viva");
  }
  const expiresIn = Number(msg.payload?.expires_in);
  writeGlobal(KEY_TOKEN, token);
  writeGlobal(KEY_EXPIRES_AT, Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000);
  ctx.token = token;
  return requestTransaction(ctx);
}

if (ctx.step !== "transaction_lookup") {
  return fail(ctx, 500, "GAME_PAYMENT_CONFIRM_STEP_INVALID", "Unsupported payment confirmation step");
}
if (Number(msg.statusCode) < 200 || Number(msg.statusCode) >= 300) {
  return fail(ctx, 503, "GAME_PAYMENT_PROVIDER_READ_FAILED", "Не удалось проверить транзакцию Viva");
}
const exactTransaction = findExactTransactionRecord(msg.payload, ctx.transactionId);
if (!exactTransaction.record) {
  return fail(ctx, 409, "GAME_PAYMENT_EVIDENCE_MISMATCH", "Транзакция Viva не соответствует черновику игры", {
    reason: exactTransaction.reason,
  });
}
const transaction = exactTransaction.record;
const transactionId = toStr(transaction.transactionId || transaction.transaction_id || transaction.id);
const status = normalizeStatus(transaction.status || transaction.state || transaction.paymentStatus || transaction.transactionStatus);
const bookingIds = collectProviderIds(transaction, ["bookingId", "bookingIds", "bookings", "paymentBookingIds", "clientBookingId"]);
const exerciseIds = collectProviderIds(transaction, ["exerciseId", "exerciseIds", "exercise"]);
const clientIds = collectProviderIds(transaction, ["clientId", "clientIds", "client"]);
const providerAmountMinor = toNumber(
  transaction.amountMinor
  ?? transaction.totalAmountMinor
  ?? transaction.paidAmountMinor
  ?? transaction.toPay,
);
const currency = toStr(transaction.currency)?.toUpperCase() || null;
const exactEvidence = (
  transactionId === ctx.transactionId
  && bookingIds.includes(ctx.bookingId)
  && exerciseIds.includes(ctx.exerciseId)
  && clientIds.includes(ctx.clientId)
  && providerAmountMinor !== null
  && Math.round(providerAmountMinor) === ctx.amountMinor
  && currency === "RUB"
);
if (!exactEvidence) {
  return fail(ctx, 409, "GAME_PAYMENT_EVIDENCE_MISMATCH", "Транзакция Viva не соответствует черновику игры");
}
if (status !== "PAID") {
  const terminalFailed = ["UNPAID", "FAILED", "CANCELLED", "CANCELED", "REJECTED", "EXPIRED"].includes(status);
  return fail(
    ctx,
    409,
    terminalFailed ? "GAME_PAYMENT_TERMINAL_FAILED" : "GAME_PAYMENT_PENDING",
    terminalFailed ? "Платёж не выполнен" : "Платёж ещё не подтверждён Viva",
    { transactionStatus: status || null },
  );
}
const claimId = `viva_transaction:${ctx.transactionId}`;
const claimCreatedAt = new Date().toISOString();
ctx.step = "claim_write";
ctx.claimId = claimId;
ctx.transactionStatus = status;
msg._gamePaymentConfirmCtx = ctx;
msg.payload = [
  { _id: claimId },
  {
    $setOnInsert: {
      transactionId: ctx.transactionId,
      bookingId: ctx.bookingId,
      exerciseId: ctx.exerciseId,
      clientId: ctx.clientId || null,
      gameId: ctx.record.id,
      paymentRef: ctx.paymentRef,
      createdAt: claimCreatedAt,
    },
  },
  { upsert: true },
];
return [null, null, null, null, msg, null];
