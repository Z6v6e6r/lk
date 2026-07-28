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
  msg._splitLeaveCtx = ctx;
  msg.method = method;
  msg.url = `${ADMIN_API}${path}`;
  msg.headers = {
    Authorization: `Bearer ${ctx.token}`,
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, msg];
};

const isAlreadyCancelledResponse = (statusCode, payload) => {
  if (![400, 409, 422].includes(Number(statusCode))) return false;
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("already") && text.includes("cancel")
  ) || text.includes("уже отмен");
};

const buildBookingCancelProbe = (bookingId) => {
  const encodedId = encodeURIComponent(bookingId);
  return {
    method: "GET",
    path: `/bookings/${encodedId}/cancel`,
    payload: undefined,
    label: "cancel_probe",
  };
};

const buildClientScopedCancelProbe = (clientId, bookingId) => {
  const encodedClientId = encodeURIComponent(clientId);
  const encodedBookingId = encodeURIComponent(bookingId);
  return {
    method: "GET",
    path: `/clients/${encodedClientId}/bookings/${encodedBookingId}/cancel`,
    payload: undefined,
    label: "client_cancel_probe",
  };
};

const buildDeleteBookingRequest = (bookingId, options) => {
  const encodedId = encodeURIComponent(bookingId);
  return {
    method: "DELETE",
    path: `/bookings/${encodedId}`,
    payload: options.payload ?? {},
    label: options.label,
    refundMethod: options.refundMethod || null,
    refundMessage: options.refundMessage || null,
  };
};

const buildClientScopedCancelRequest = (clientId, bookingId, options) => {
  const encodedClientId = encodeURIComponent(clientId);
  const encodedBookingId = encodeURIComponent(bookingId);
  return {
    method: "PUT",
    path: `/clients/${encodedClientId}/bookings/${encodedBookingId}/cancel`,
    payload: {
      refundMethod: options.refundMethod,
      cancelExercise: false,
    },
    label: options.label,
    refundMethod: options.refundMethod === "NONE" ? null : options.refundMethod,
    refundMessage: options.refundMessage || null,
  };
};

const buildPlainDeleteBookingRequest = (bookingId) => buildDeleteBookingRequest(bookingId, {
  payload: undefined,
  label: "delete_plain",
  refundMethod: null,
  refundMessage: "Запись отменена без возврата средств.",
});

const buildExerciseScopedDeleteBookingRequest = (exerciseId, bookingId) => {
  const encodedExerciseId = encodeURIComponent(exerciseId);
  const encodedBookingId = encodeURIComponent(bookingId);
  return {
    method: "DELETE",
    path: `/exercises/${encodedExerciseId}/bookings/${encodedBookingId}`,
    payload: {
      refundMethod: "NONE",
      cancelExercise: false,
    },
    label: "delete_exercise_booking_none",
    refundMethod: null,
    refundMessage: "Запись отменена без возврата средств.",
  };
};

const isAvailableOption = (value) => value?.available === true;

const resolveCancellationOptions = (payload) => {
  const root = payload && typeof payload === "object" ? payload : {};
  const options = root.cancellationOptions && typeof root.cancellationOptions === "object"
    ? root.cancellationOptions
    : {};

  return {
    money: isAvailableOption(options.money),
    deposit: isAvailableOption(options.deposit),
    subscription: isAvailableOption(options.subscription),
    cancellationOnly: isAvailableOption(options.cancellationOnly),
    settlementAccount: isAvailableOption(options.settlementAccount),
    exercise: isAvailableOption(options.exercise),
  };
};

const pickBookingCancelRequest = (bookingId, payload) => {
  const options = resolveCancellationOptions(payload);

  if (options.money) {
    return buildDeleteBookingRequest(bookingId, {
      payload: { refundMethod: "CURRENCY" },
      label: "delete_currency",
      refundMethod: "CURRENCY",
    });
  }

  if (options.deposit) {
    return buildDeleteBookingRequest(bookingId, {
      payload: { refundMethod: "DEPOSIT" },
      label: "delete_deposit",
      refundMethod: "DEPOSIT",
    });
  }

  if (options.subscription) {
    return buildDeleteBookingRequest(bookingId, {
      payload: undefined,
      label: "delete_subscription",
      refundMethod: null,
      refundMessage: "Вернули 1 занятие на абонемент.",
    });
  }

  if (options.cancellationOnly) {
    return buildDeleteBookingRequest(bookingId, {
      payload: undefined,
      label: "delete_plain",
      refundMethod: null,
      refundMessage: "Запись отменена без возврата средств.",
    });
  }

  if (options.exercise) {
    return {
      unsupportedReason: "Viva предлагает возврат только в виде услуги",
      unsupportedCode: "unsupported_exercise_refund",
    };
  }

  if (options.settlementAccount) {
    return {
      unsupportedReason: "Viva предлагает возврат только на лицевой счет",
      unsupportedCode: "unsupported_settlement_account",
    };
  }

  return {
    unsupportedReason: "Для записи нет поддержанного сценария возврата",
    unsupportedCode: "unsupported_refund_method",
  };
};

const pickClientScopedCancelRequest = (clientId, bookingId, payload) => {
  const options = resolveCancellationOptions(payload);

  if (options.money) {
    return buildClientScopedCancelRequest(clientId, bookingId, {
      refundMethod: "CURRENCY",
      label: "client_cancel_currency",
    });
  }

  if (options.deposit) {
    return buildClientScopedCancelRequest(clientId, bookingId, {
      refundMethod: "DEPOSIT",
      label: "client_cancel_deposit",
    });
  }

  if (options.subscription) {
    return buildClientScopedCancelRequest(clientId, bookingId, {
      refundMethod: "SERVICE",
      label: "client_cancel_subscription",
      refundMessage: "Вернули 1 занятие на абонемент.",
    });
  }

  if (options.cancellationOnly) {
    return buildClientScopedCancelRequest(clientId, bookingId, {
      refundMethod: "NONE",
      label: "client_cancel_none",
      refundMessage: "Запись отменена без возврата средств.",
    });
  }

  if (options.exercise) {
    return {
      unsupportedReason: "Viva предлагает возврат только в виде услуги",
      unsupportedCode: "unsupported_exercise_refund",
    };
  }

  if (options.settlementAccount) {
    return {
      unsupportedReason: "Viva предлагает возврат только на лицевой счет",
      unsupportedCode: "unsupported_settlement_account",
    };
  }

  return {
    unsupportedReason: "Для записи нет поддержанного сценария возврата",
    unsupportedCode: "unsupported_refund_method",
  };
};

const normalizeBookingQueueItem = (value, fallbackClientId) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      bookingId: toStr(value.bookingId || value.id || value.uuid),
      clientId: toStr(value.clientId || value.playerId || value.userId) || fallbackClientId || null,
    };
  }
  return {
    bookingId: toStr(value),
    clientId: fallbackClientId || null,
  };
};

const startGenericBookingCancel = (ctx, bookingId, clientId, meta = {}) => {
  const probeRequest = buildBookingCancelProbe(bookingId);
  ctx.currentBookingId = bookingId;
  ctx.currentClientId = toStr(clientId || ctx.clientId || ctx.playerId);
  ctx.currentCancelRequest = null;
  ctx.step = "cancel_probe";
  appendTrace(ctx, {
    step: "cancel_probe_request",
    bookingId,
    clientId: ctx.currentClientId || null,
    attemptLabel: probeRequest.label,
    ...meta,
  });
  return adminRequest(ctx, probeRequest.method, probeRequest.path, probeRequest.payload);
};

const startClientScopedBookingCancel = (ctx, bookingId, clientId, meta = {}) => {
  const normalizedClientId = toStr(clientId || ctx.clientId || ctx.playerId);
  if (!normalizedClientId) {
    return startGenericBookingCancel(ctx, bookingId, clientId, {
      fallbackFromClientCancel: "missing_client_id",
      ...meta,
    });
  }
  const probeRequest = buildClientScopedCancelProbe(normalizedClientId, bookingId);
  ctx.currentBookingId = bookingId;
  ctx.currentClientId = normalizedClientId;
  ctx.currentCancelRequest = null;
  ctx.step = "client_cancel_probe";
  appendTrace(ctx, {
    step: "client_cancel_probe_request",
    bookingId,
    clientId: normalizedClientId,
    attemptLabel: probeRequest.label,
    ...meta,
  });
  return adminRequest(ctx, probeRequest.method, probeRequest.path, probeRequest.payload);
};

const nextBookingRequest = (ctx) => {
  if (!Array.isArray(ctx.bookingQueue) || ctx.bookingQueue.length === 0) return null;
  const queueItem = normalizeBookingQueueItem(ctx.bookingQueue.shift(), toStr(ctx.clientId || ctx.playerId));
  const bookingId = toStr(queueItem.bookingId);
  if (!bookingId) return nextBookingRequest(ctx);
  const clientId = toStr(queueItem.clientId);

  ctx.currentBookingId = bookingId;
  ctx.currentClientId = clientId;

  if (!clientId) {
    appendTrace(ctx, {
      step: "cancel_booking_without_client",
      bookingId,
    });
  }

  if (clientId) {
    return startClientScopedBookingCancel(ctx, bookingId, clientId);
  }

  return startGenericBookingCancel(ctx, bookingId, clientId);
};

const finalize = (ctx) => {
  const bookingResults = Array.isArray(ctx.bookingResults) ? ctx.bookingResults : [];
  const bookingSuccess = bookingResults.filter((item) => item?.ok === true).map((item) => item.bookingId);
  const bookingFailed = bookingResults.filter((item) => item?.ok !== true).map((item) => item.bookingId);
  const withVivaErrors = bookingFailed.length > 0;

  msg.statusCode = 200;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    ok: !withVivaErrors,
    gameId: ctx.gameId || null,
    clientId: ctx.clientId || null,
    playerId: ctx.playerId || null,
    playerPhone: ctx.playerPhone || null,
    playerName: ctx.playerName || null,
    reason: ctx.reason || "PLAYER_LEFT",
    bookingIds: uniq(ctx.initialBookingIds || []),
    bookingSuccess,
    bookingFailed,
    withVivaErrors,
    trace: clone(ctx.trace || []),
    finishedAt: new Date().toISOString(),
  };
  return [null, msg, msg];
};

const pushBookingFailureAndContinue = (ctx, failure) => {
  ctx.bookingResults.push({
    bookingId: failure.bookingId,
    ok: false,
    clientId: failure.clientId || null,
    method: failure.method || "generic_booking",
    statusCode: failure.statusCode,
    unsupportedReason: failure.unsupportedReason || null,
    response: clone(failure.response || null),
  });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentCancelRequest = null;
  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;
  return finalize(ctx);
};

const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object"
  ? msg._splitLeaveCtx
  : null;

if (!ctx) {
  msg.statusCode = 500;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { ok: false, error: "split leave context missing" };
  return [null, msg, msg];
}

if (ctx.step === "token_request") {
  if (!isOk(msg.statusCode) || !msg.payload?.access_token) {
    appendTrace(ctx, {
      step: "token_failed",
      statusCode: msg.statusCode,
      response: clone(msg.payload || null),
    });
    return finalize(ctx);
  }

  ctx.token = msg.payload.access_token;
  appendTrace(ctx, { step: "token_success" });
  const bookingReq = nextBookingRequest(ctx);
  if (bookingReq) return bookingReq;
  return finalize(ctx);
}

if (ctx.step === "client_cancel_probe") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId || ctx.clientId || ctx.playerId);
  const statusCode = Number(msg.statusCode);

  if (isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: "client_cancel_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      clientId,
      method: "client_scoped_cancel",
      notFound: statusCode === 404,
      alreadyCancelled: statusCode !== 404,
      statusCode,
    });
    ctx.currentBookingId = null;
    ctx.currentClientId = null;
    ctx.currentCancelRequest = null;

    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;

    return finalize(ctx);
  }

  if (!isOk(statusCode)) {
    appendTrace(ctx, {
      step: "client_cancel_probe_failed",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return startGenericBookingCancel(ctx, bookingId, clientId, {
      fallbackFromClientCancel: "probe_failed",
      clientCancelStatusCode: statusCode,
    });
  }

  const cancelRequest = pickClientScopedCancelRequest(clientId, bookingId, msg.payload || null);
  if (!cancelRequest || cancelRequest.unsupportedReason) {
    appendTrace(ctx, {
      step: "client_cancel_probe_unsupported",
      bookingId,
      clientId,
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || null,
      unsupportedCode: cancelRequest?.unsupportedCode || null,
      response: clone(msg.payload || null),
    });
    return startGenericBookingCancel(ctx, bookingId, clientId, {
      fallbackFromClientCancel: cancelRequest?.unsupportedCode || "unsupported_refund_method",
      clientCancelStatusCode: statusCode,
    });
  }

  ctx.currentCancelRequest = cancelRequest;
  ctx.step = "client_cancel_booking";
  if (cancelRequest.refundMessage && !ctx.refundMessage) {
    ctx.refundMessage = cancelRequest.refundMessage;
  }
  appendTrace(ctx, {
    step: "client_cancel_request",
    bookingId,
    clientId,
    statusCode,
    attemptLabel: cancelRequest.label,
    refundMethod: cancelRequest.refundMethod || null,
  });
  return adminRequest(ctx, cancelRequest.method, cancelRequest.path, cancelRequest.payload);
}

if (ctx.step === "client_cancel_booking") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId || ctx.clientId || ctx.playerId);
  const statusCode = Number(msg.statusCode);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;

  if (isOk(statusCode) || isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: isOk(statusCode)
        ? "client_cancel_success"
        : "client_cancel_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      refundMethod: cancelRequest?.refundMethod || null,
      response: isOk(statusCode) ? undefined : clone(msg.payload || null),
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      clientId,
      method: "client_scoped_cancel",
      refundMethod: cancelRequest?.refundMethod || null,
      alreadyCancelled: !isOk(statusCode),
      notFound: false,
      statusCode,
    });
    ctx.currentBookingId = null;
    ctx.currentClientId = null;
    ctx.currentCancelRequest = null;
    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;
    return finalize(ctx);
  }

  appendTrace(ctx, {
    step: "client_cancel_failed",
    bookingId,
    clientId,
    statusCode,
    refundMethod: cancelRequest?.refundMethod || null,
    response: clone(msg.payload || null),
  });
  return startGenericBookingCancel(ctx, bookingId, clientId, {
    fallbackFromClientCancel: "request_failed",
    clientCancelStatusCode: statusCode,
    clientCancelAttemptLabel: cancelRequest?.label || null,
  });
}

if (ctx.step === "cancel_probe") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId || ctx.clientId || ctx.playerId);
  const statusCode = Number(msg.statusCode);

  if (isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: "cancel_booking_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      clientId,
      method: "generic_booking",
      notFound: statusCode === 404,
      alreadyCancelled: statusCode !== 404,
      statusCode,
    });
    ctx.currentBookingId = null;
    ctx.currentClientId = null;
    ctx.currentCancelRequest = null;

    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;

    return finalize(ctx);
  }

  if (statusCode === 404) {
    // Some Viva tenants return 404 on the probe, but the plain DELETE still succeeds.
    const cancelRequest = buildPlainDeleteBookingRequest(bookingId);
    ctx.currentCancelRequest = cancelRequest;
    if (cancelRequest.refundMessage && !ctx.refundMessage) {
      ctx.refundMessage = cancelRequest.refundMessage;
    }
    ctx.step = "cancel_booking";
    appendTrace(ctx, {
      step: "cancel_booking_probe_not_found",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
      attemptLabel: cancelRequest.label,
    });
    appendTrace(ctx, {
      step: "cancel_booking_request",
      bookingId,
      clientId,
      statusCode,
      attemptLabel: cancelRequest.label,
      refundMethod: cancelRequest.refundMethod || null,
      fallbackFromProbe404: true,
    });
    return adminRequest(ctx, cancelRequest.method, cancelRequest.path, cancelRequest.payload);
  }

  if (!isOk(statusCode)) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_failed",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId,
      method: "generic_booking",
      statusCode,
      response: msg.payload || null,
    });
  }

  const cancelRequest = pickBookingCancelRequest(bookingId, msg.payload || null);
  if (!cancelRequest || cancelRequest.unsupportedReason) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_unsupported",
      bookingId,
      clientId,
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || null,
      unsupportedCode: cancelRequest?.unsupportedCode || null,
      response: clone(msg.payload || null),
    });
    return pushBookingFailureAndContinue(ctx, {
      bookingId,
      clientId,
      method: "generic_booking",
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || "Unsupported refund path",
      response: msg.payload || null,
    });
  }

  ctx.currentCancelRequest = cancelRequest;
  ctx.step = "cancel_booking";
  appendTrace(ctx, {
    step: "cancel_booking_request",
    bookingId,
    clientId,
    statusCode,
    attemptLabel: cancelRequest.label,
    refundMethod: cancelRequest.refundMethod || null,
  });
  return adminRequest(ctx, cancelRequest.method, cancelRequest.path, cancelRequest.payload);
}

if (ctx.step === "cancel_booking") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId || ctx.clientId || ctx.playerId);
  const statusCode = Number(msg.statusCode);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;

  if (isOk(statusCode) || isAlreadyCancelledResponse(statusCode, msg.payload)) {
    appendTrace(ctx, {
      step: isOk(statusCode)
        ? "cancel_booking_success"
        : "cancel_booking_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      refundMethod: cancelRequest?.refundMethod || null,
      response: isOk(statusCode) ? undefined : clone(msg.payload || null),
    });
    ctx.bookingResults.push({
      bookingId,
      ok: true,
      clientId,
      method: "generic_booking",
      refundMethod: cancelRequest?.refundMethod || null,
      alreadyCancelled: true,
      notFound: false,
      statusCode,
    });
    ctx.currentBookingId = null;
    ctx.currentClientId = null;
    ctx.currentCancelRequest = null;
    const bookingReq = nextBookingRequest(ctx);
    if (bookingReq) return bookingReq;
    return finalize(ctx);
  }

  if (
    statusCode === 404
    && cancelRequest?.label === "delete_plain"
    && toStr(ctx.exerciseId)
  ) {
    const exerciseScopedRequest = buildExerciseScopedDeleteBookingRequest(toStr(ctx.exerciseId), bookingId);
    ctx.currentCancelRequest = exerciseScopedRequest;
    appendTrace(ctx, {
      step: "cancel_booking_retry_exercise_scope",
      bookingId,
      clientId,
      statusCode,
      previousAttemptLabel: cancelRequest.label,
      attemptLabel: exerciseScopedRequest.label,
      exerciseId: toStr(ctx.exerciseId),
      response: clone(msg.payload || null),
    });
    appendTrace(ctx, {
      step: "cancel_booking_request",
      bookingId,
      clientId,
      statusCode,
      attemptLabel: exerciseScopedRequest.label,
      refundMethod: exerciseScopedRequest.refundMethod || null,
      retryAfterBooking404: true,
      exerciseId: toStr(ctx.exerciseId),
    });
    return adminRequest(
      ctx,
      exerciseScopedRequest.method,
      exerciseScopedRequest.path,
      exerciseScopedRequest.payload,
    );
  }

  appendTrace(ctx, {
    step: "cancel_booking_failed",
    bookingId,
    clientId,
    statusCode,
    refundMethod: cancelRequest?.refundMethod || null,
    response: clone(msg.payload || null),
  });
  return pushBookingFailureAndContinue(ctx, {
    bookingId,
    clientId,
    method: "generic_booking",
    statusCode,
    response: msg.payload || null,
  });
}

appendTrace(ctx, {
  step: "unknown_step",
  currentStep: ctx.step,
});
return finalize(ctx);
