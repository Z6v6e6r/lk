const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";
const ADMIN_API = "https://api.vivacrm.ru/api/v1";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const uniq = (values) => {
  const result = [];
  const used = new Set();
  values.forEach((item) => {
    const normalized = toStr(item);
    if (!normalized || used.has(normalized)) return;
    used.add(normalized);
    result.push(normalized);
  });
  return result;
};

const clone = (value) => {
  if (!value || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value));
};

const appendTrace = (ctx, entry) => {
  if (!Array.isArray(ctx.trace)) ctx.trace = [];
  ctx.trace.push({
    at: new Date().toISOString(),
    ...entry,
  });
};

const adminRequest = (ctx, method, path, payload) => {
  msg._splitCleanupCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null];
};

const requestToken = (ctx) => {
  msg._splitCleanupCtx = ctx;
  msg.method = "POST";
  msg.url = TOKEN_URL;
  msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msg.payload =
    "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";
  return [msg, null, null, null];
};

const buildBookingAttempt = (ctx, bookingId, attempt) => {
  const encodedId = encodeURIComponent(bookingId);
  switch (attempt) {
    case 0:
      return {
        method: "DELETE",
        path: `/bookings/${encodedId}`,
        payload: { refundMethod: "CURRENCY" },
        label: "delete_currency",
      };
    case 1:
      return {
        method: "GET",
        path: `/bookings/${encodedId}/cancel`,
        payload: {},
        label: "cancel_probe",
      };
    case 2:
      return {
        method: "DELETE",
        path: `/bookings/${encodedId}`,
        payload: { refundType: "TO_DEPOSIT" },
        label: "delete_to_deposit",
      };
    case 3:
      return {
        method: "DELETE",
        path: `/bookings/${encodedId}`,
        payload: { refundType: "TO_CARD" },
        label: "delete_to_card",
      };
    default:
      return {
        method: "DELETE",
        path: `/bookings/${encodedId}`,
        payload: {},
        label: "delete_plain",
      };
  }
};

const buildExerciseAttempt = (ctx, attempt) => {
  const encodedId = encodeURIComponent(ctx.exerciseId);
  switch (attempt) {
    case 0:
      return {
        method: "DELETE",
        path: `/exercises/${encodedId}`,
        payload: {},
        label: "delete_exercise",
      };
    case 1:
      return {
        method: "POST",
        path: `/exercises/${encodedId}/cancel`,
        payload: {},
        label: "cancel_exercise",
      };
    default:
      return {
        method: "PATCH",
        path: `/exercises/${encodedId}`,
        payload: { status: "CANCELLED" },
        label: "patch_exercise_cancelled",
      };
  }
};

const nextBookingRequest = (ctx) => {
  if (!Array.isArray(ctx.bookingQueue) || ctx.bookingQueue.length === 0) return null;
  const bookingId = toStr(ctx.bookingQueue.shift());
  if (!bookingId) return nextBookingRequest(ctx);

  ctx.currentBookingId = bookingId;
  ctx.currentBookingAttempt = 0;
  ctx.step = "cancel_booking";

  const attemptPayload = buildBookingAttempt(ctx, bookingId, 0);
  ctx.currentBookingAttemptLabel = attemptPayload.label;
  appendTrace(ctx, {
    step: "cancel_booking_request",
    bookingId,
    attempt: 0,
    attemptLabel: attemptPayload.label,
  });
  return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
};

const nextExerciseRequest = (ctx) => {
  if (!ctx.exerciseId || ctx.exerciseProcessed === true) return null;

  const attempt = Number.isFinite(Number(ctx.exerciseAttempt))
    ? Number(ctx.exerciseAttempt)
    : 0;
  const attemptPayload = buildExerciseAttempt(ctx, attempt);

  ctx.step = "cancel_exercise";
  ctx.exerciseAttempt = attempt;
  appendTrace(ctx, {
    step: "cancel_exercise_request",
    exerciseId: ctx.exerciseId,
    attempt,
    attemptLabel: attemptPayload.label,
  });
  return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
};

const buildPersistSet = (ctx, nowIso) => {
  const bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
  const bookingSuccess = bookingResults.filter((item) => item?.ok === true).map((item) => item.bookingId);
  const bookingFailed = bookingResults.filter((item) => item?.ok !== true).map((item) => item.bookingId);
  const exerciseCancelled = ctx.exerciseId
    ? (ctx.exerciseCancelled === true)
    : true;
  const hasVivaErrors = bookingFailed.length > 0 || !exerciseCancelled;
  const reasonMap = {
    PAYMENT_TIMEOUT: "SPLIT_PAYMENT_TIMEOUT_25M",
    ASSEMBLY_TIMEOUT: "SPLIT_ASSEMBLY_TIMEOUT_24H",
    FORCED: "SPLIT_FORCE_CLEANUP",
  };
  const reasonCode = reasonMap[ctx.reason] || "SPLIT_AUTOCLEANUP";

  const setDoc = {
    status: "CANCELLED",
    archived: true,
    updatedAt: nowIso,
    "metadata.splitPayment.status": hasVivaErrors ? "CANCELLED_WITH_VIVA_ERRORS" : "CANCELLED",
    "metadata.splitPayment.cancelReason": reasonCode,
    "metadata.splitPayment.cancelledAt": nowIso,
    "metadata.splitPayment.cleanupAt": nowIso,
    "metadata.splitPayment.cleanupSource": "split_cleanup",
    "metadata.splitPayment.vivaCancellation": {
      bookingSuccess,
      bookingFailed,
      exerciseId: ctx.exerciseId || null,
      exerciseCancelled,
      traces: clone(ctx.trace || []),
    },
  };

  if (ctx.reason === "ASSEMBLY_TIMEOUT") {
    setDoc["metadata.splitPayment.refundStatus"] = hasVivaErrors ? "REQUEST_FAILED" : "REQUESTED";
    setDoc["metadata.splitPayment.refundRequestedAt"] = nowIso;
  }

  return setDoc;
};

const finalizeTask = (ctx) => {
  const nowIso = new Date().toISOString();
  const bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
  const bookingSuccessCount = bookingResults.filter((item) => item?.ok === true).length;
  const bookingFailedCount = bookingResults.filter((item) => item?.ok !== true).length;
  const exerciseCancelled = ctx.exerciseId ? (ctx.exerciseCancelled === true) : true;
  const hasVivaErrors = bookingFailedCount > 0 || !exerciseCancelled;

  const summaryPayload = {
    ok: true,
    gameId: ctx.gameId,
    reason: ctx.reason,
    dryRun: ctx.dryRun === true,
    bookingIds: uniq(ctx.initialBookingIds || []),
    bookingSuccessCount,
    bookingFailedCount,
    exerciseId: ctx.exerciseId || null,
    exerciseCancelled,
    cancelledInLk: ctx.dryRun !== true,
    withVivaErrors: hasVivaErrors,
    trace: clone(ctx.trace || []),
    finishedAt: nowIso,
  };

  const summaryMsg = Object.assign({}, msg, {
    _splitCleanupCtx: ctx,
    payload: summaryPayload,
  });

  if (ctx.dryRun === true) {
    return [null, null, summaryMsg, summaryMsg];
  }

  const dbMsg = Object.assign({}, msg, {
    query: {
      id: ctx.gameId,
      archived: { $ne: true },
    },
    payload: {
      $set: buildPersistSet(ctx, nowIso),
    },
  });

  return [null, dbMsg, summaryMsg, summaryMsg];
};

const ctxFromMsg = msg._splitCleanupCtx && typeof msg._splitCleanupCtx === "object"
  ? msg._splitCleanupCtx
  : null;

if (!ctxFromMsg) {
  const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
  const gameId = toStr(payload?.gameId);
  if (!gameId) {
    return [null, null, null, null];
  }

  const initialCtx = {
    gameId,
    reason: toStr(payload.reason) || "PAYMENT_TIMEOUT",
    dryRun: payload.dryRun === true,
    exerciseId: toStr(payload.exerciseId),
    initialBookingIds: uniq(payload.bookingIds || []),
    bookingQueue: uniq(payload.bookingIds || []),
    bookingResults: [],
    exerciseAttempt: 0,
    exerciseProcessed: false,
    exerciseCancelled: null,
    token: null,
    step: "token_request",
    trace: [],
  };

  appendTrace(initialCtx, {
    step: "init",
    gameId,
    reason: initialCtx.reason,
    dryRun: initialCtx.dryRun,
  });

  return requestToken(initialCtx);
}

const ctx = ctxFromMsg;

if (ctx.step === "token_request") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    appendTrace(ctx, {
      step: "token_failed",
      statusCode: msg.statusCode,
      response: clone(msg.payload || null),
    });
    ctx.token = null;
    return finalizeTask(ctx);
  }

  ctx.token = msg.payload.access_token;
  appendTrace(ctx, {
    step: "token_success",
  });

  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;

  const exerciseReq = nextExerciseRequest(ctx);
  if (exerciseReq) return exerciseReq;

  return finalizeTask(ctx);
}

if (ctx.step === "cancel_booking") {
  const bookingId = toStr(ctx.currentBookingId);
  const attempt = Number.isFinite(Number(ctx.currentBookingAttempt)) ? Number(ctx.currentBookingAttempt) : 0;

  if (isOk(msg.statusCode)) {
    appendTrace(ctx, {
      step: "cancel_booking_success",
      bookingId,
      attempt,
      statusCode: msg.statusCode,
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      attempt,
      statusCode: msg.statusCode,
    });
    ctx.currentBookingId = null;

    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;

    const exerciseReq = nextExerciseRequest(ctx);
    if (exerciseReq) return exerciseReq;

    return finalizeTask(ctx);
  }

  if (attempt < 4) {
    const nextAttempt = attempt + 1;
    const attemptPayload = buildBookingAttempt(ctx, bookingId, nextAttempt);
    ctx.currentBookingAttempt = nextAttempt;
    ctx.currentBookingAttemptLabel = attemptPayload.label;
    appendTrace(ctx, {
      step: "cancel_booking_retry",
      bookingId,
      attempt: nextAttempt,
      statusCode: msg.statusCode,
      attemptLabel: attemptPayload.label,
      response: clone(msg.payload || null),
    });
    return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
  }

  appendTrace(ctx, {
    step: "cancel_booking_failed",
    bookingId,
    attempt,
    statusCode: msg.statusCode,
    response: clone(msg.payload || null),
  });
  ctx.bookingResults.push({
    bookingId,
    ok: false,
    attempt,
    statusCode: msg.statusCode,
  });
  ctx.currentBookingId = null;

  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;

  const exerciseReq = nextExerciseRequest(ctx);
  if (exerciseReq) return exerciseReq;

  return finalizeTask(ctx);
}

if (ctx.step === "cancel_exercise") {
  const attempt = Number.isFinite(Number(ctx.exerciseAttempt)) ? Number(ctx.exerciseAttempt) : 0;

  if (isOk(msg.statusCode)) {
    appendTrace(ctx, {
      step: "cancel_exercise_success",
      exerciseId: ctx.exerciseId,
      attempt,
      statusCode: msg.statusCode,
    });
    ctx.exerciseProcessed = true;
    ctx.exerciseCancelled = true;
    return finalizeTask(ctx);
  }

  if (attempt < 2) {
    const nextAttempt = attempt + 1;
    ctx.exerciseAttempt = nextAttempt;
    const attemptPayload = buildExerciseAttempt(ctx, nextAttempt);
    appendTrace(ctx, {
      step: "cancel_exercise_retry",
      exerciseId: ctx.exerciseId,
      attempt: nextAttempt,
      statusCode: msg.statusCode,
      attemptLabel: attemptPayload.label,
      response: clone(msg.payload || null),
    });
    return adminRequest(ctx, attemptPayload.method, attemptPayload.path, attemptPayload.payload);
  }

  appendTrace(ctx, {
    step: "cancel_exercise_failed",
    exerciseId: ctx.exerciseId,
    attempt,
    statusCode: msg.statusCode,
    response: clone(msg.payload || null),
  });
  ctx.exerciseProcessed = true;
  ctx.exerciseCancelled = false;
  return finalizeTask(ctx);
}

appendTrace(ctx, {
  step: "unknown_step",
  currentStep: ctx.step,
});
return finalizeTask(ctx);
