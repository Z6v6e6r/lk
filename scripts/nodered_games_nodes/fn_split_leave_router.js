const ADMIN_API = "https://api.vivacrm.ru/api/v1";

const isOk = (status) => Number(status) >= 200 && Number(status) < 300;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

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

const normalizeId = (value) => {
  const normalized = toStr(value);
  return normalized ? normalized.toLowerCase() : null;
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
  return [msg, null, null];
};

const isAlreadyCancelledResponse = (statusCode, payload) => {
  if (![400, 409, 422].includes(Number(statusCode))) return false;
  const text = JSON.stringify(payload || {}).toLowerCase();
  return (
    text.includes("already") && text.includes("cancel")
  ) || text.includes("уже отмен");
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

const buildCancelProbe = (ctx, bookingId, clientId) => {
  const encodedBookingId = encodeURIComponent(bookingId);
  if (clientId) {
    return {
      method: "GET",
      path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodedBookingId}/cancel`,
      payload: undefined,
      label: "client_cancel_probe",
      scope: "client",
    };
  }
  if (ctx.exerciseId) {
    return {
      method: "GET",
      path: `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings/${encodedBookingId}/cancel`,
      payload: undefined,
      label: "exercise_cancel_probe",
      scope: "exercise",
    };
  }
  return {
    unsupportedReason: "Не удалось определить клиента или занятие Viva для отмены",
    unsupportedCode: "missing_scoped_booking_target",
  };
};

const buildCancelRequest = (ctx, bookingId, clientId, options) => {
  const encodedBookingId = encodeURIComponent(bookingId);
  const payload = {
    refundMethod: options.refundMethod,
    cancelExercise: false,
  };
  if (clientId) {
    return {
      method: "PUT",
      path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodedBookingId}/cancel`,
      payload,
      label: `client_cancel_${options.label}`,
      scope: "client",
      refundMethod: options.refundMethod === "NONE" ? null : options.refundMethod,
      refundMessage: options.refundMessage || null,
    };
  }
  if (ctx.exerciseId) {
    return {
      method: "DELETE",
      path: `/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings/${encodedBookingId}`,
      payload,
      label: `exercise_cancel_${options.label}`,
      scope: "exercise",
      refundMethod: options.refundMethod === "NONE" ? null : options.refundMethod,
      refundMessage: options.refundMessage || null,
    };
  }
  return {
    unsupportedReason: "Не удалось определить клиента или занятие Viva для отмены",
    unsupportedCode: "missing_scoped_booking_target",
  };
};

const pickCancelRequest = (ctx, bookingId, clientId, payload) => {
  const options = resolveCancellationOptions(payload);
  if (options.money) {
    return buildCancelRequest(ctx, bookingId, clientId, {
      refundMethod: "CURRENCY",
      label: "currency",
    });
  }
  if (options.deposit) {
    return buildCancelRequest(ctx, bookingId, clientId, {
      refundMethod: "DEPOSIT",
      label: "deposit",
    });
  }
  if (options.subscription || options.exercise) {
    return buildCancelRequest(ctx, bookingId, clientId, {
      refundMethod: "SERVICE",
      label: "service",
      refundMessage: "Вернули 1 занятие на абонемент.",
    });
  }
  if (options.cancellationOnly) {
    return buildCancelRequest(ctx, bookingId, clientId, {
      refundMethod: "NONE",
      label: "none",
      refundMessage: "Запись отменена без возврата средств.",
    });
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

const buildClientVerifyRequest = (clientId, bookingId) => ({
  method: "GET",
  path: `/clients/${encodeURIComponent(clientId)}/bookings/${encodeURIComponent(bookingId)}`,
  payload: undefined,
  label: "verify_client_booking",
  scope: "client",
});

const buildExerciseVerifyRequest = (exerciseId) => ({
  method: "GET",
  path: `/exercises/${encodeURIComponent(exerciseId)}/bookings?showCancelled=true&page=0&size=200`,
  payload: undefined,
  label: "verify_exercise_bookings",
  scope: "exercise",
});

const isCancelledBookingRow = (row) => {
  if (!row || typeof row !== "object") return false;
  if (row.isCancelled === true || row.cancelled === true) return true;
  if (toStr(row.cancellationDate || row.cancelledAt)) return true;
  const status = String(row.bookingStatus || row.status || row.state || "").trim().toUpperCase();
  return status.includes("CANCEL");
};

const extractBookingRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.content)) return payload.content;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && typeof payload.data === "object") {
    if (Array.isArray(payload.data.content)) return payload.data.content;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  return [];
};

const findBookingRow = (payload, bookingId) => {
  const normalizedBookingId = normalizeId(bookingId);
  return extractBookingRows(payload).find((row) => (
    normalizeId(row?.id || row?.bookingId || row?.uuid) === normalizedBookingId
  )) || null;
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

const finalize = (ctx) => {
  const bookingResults = asArray(ctx.bookingResults);
  const bookingSuccess = bookingResults.filter((item) => item?.ok === true).map((item) => item.bookingId);
  const bookingFailed = bookingResults.filter((item) => item?.ok !== true).map((item) => item.bookingId);
  const withVivaErrors = bookingFailed.length > 0;
  const safeMsg = Object.assign({}, msg);
  delete safeMsg._splitCleanupAuth;
  delete safeMsg._splitLeaveCtx;
  delete safeMsg.method;
  delete safeMsg.url;
  safeMsg.statusCode = 200;
  safeMsg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  safeMsg.payload = {
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
    refundMessage: toStr(ctx.refundMessage),
    trace: clone(ctx.trace || []),
    finishedAt: new Date().toISOString(),
  };
  return [null, safeMsg, safeMsg];
};

const pushFailureAndContinue = (ctx, failure) => {
  ctx.bookingResults.push({
    bookingId: failure.bookingId,
    ok: false,
    clientId: failure.clientId || null,
    method: "scoped_admin_booking",
    statusCode: failure.statusCode,
    unsupportedReason: failure.unsupportedReason || null,
    response: clone(failure.response || null),
  });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentCancelRequest = null;
  ctx.currentVerifyRequest = null;
  const next = nextBookingRequest(ctx);
  return next || finalize(ctx);
};

const pushSuccessAndContinue = (ctx, result) => {
  ctx.bookingResults.push({
    bookingId: result.bookingId,
    ok: true,
    clientId: result.clientId || null,
    method: "scoped_admin_booking",
    refundMethod: result.refundMethod || null,
    alreadyCancelled: result.alreadyCancelled === true,
    statusCode: result.statusCode,
  });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentCancelRequest = null;
  ctx.currentVerifyRequest = null;
  const next = nextBookingRequest(ctx);
  return next || finalize(ctx);
};

const startVerification = (ctx, bookingId, clientId, meta = {}) => {
  let request = null;
  if (clientId) request = buildClientVerifyRequest(clientId, bookingId);
  else if (ctx.exerciseId) request = buildExerciseVerifyRequest(ctx.exerciseId);
  if (!request) {
    appendTrace(ctx, {
      step: "cancel_booking_unverified",
      bookingId,
      clientId: clientId || null,
      reason: "missing_verification_target",
    });
    return pushFailureAndContinue(ctx, {
      bookingId,
      clientId,
      statusCode: meta.statusCode,
      unsupportedReason: "Cancellation cannot be verified",
    });
  }
  ctx.step = "verify_booking_cancelled";
  ctx.currentVerifyRequest = {
    ...request,
    originStatusCode: meta.statusCode,
    originAlreadyCancelled: meta.alreadyCancelled === true,
  };
  appendTrace(ctx, {
    step: "cancel_booking_verify_request",
    bookingId,
    clientId: clientId || null,
    verifyScope: request.scope,
    attemptLabel: request.label,
    previousStatusCode: meta.statusCode,
  });
  return adminRequest(ctx, request.method, request.path, request.payload);
};

const startCancel = (ctx, bookingId, clientId) => {
  const probe = buildCancelProbe(ctx, bookingId, clientId);
  if (!probe || probe.unsupportedReason) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_unsupported",
      bookingId,
      clientId: clientId || null,
      unsupportedCode: probe?.unsupportedCode || null,
    });
    return pushFailureAndContinue(ctx, {
      bookingId,
      clientId,
      unsupportedReason: probe?.unsupportedReason || "Missing scoped booking target",
    });
  }
  ctx.currentBookingId = bookingId;
  ctx.currentClientId = clientId || null;
  ctx.currentCancelRequest = null;
  ctx.step = "cancel_probe";
  appendTrace(ctx, {
    step: "cancel_probe_request",
    bookingId,
    clientId: clientId || null,
    scope: probe.scope,
    attemptLabel: probe.label,
  });
  return adminRequest(ctx, probe.method, probe.path, probe.payload);
};

const nextBookingRequest = (ctx) => {
  if (!Array.isArray(ctx.bookingQueue) || ctx.bookingQueue.length === 0) return null;
  const item = normalizeBookingQueueItem(
    ctx.bookingQueue.shift(),
    toStr(ctx.clientId || ctx.playerId),
  );
  if (!item.bookingId) return nextBookingRequest(ctx);
  return startCancel(ctx, item.bookingId, item.clientId);
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
    asArray(ctx.bookingQueue).forEach((item) => {
      const normalized = normalizeBookingQueueItem(item, toStr(ctx.clientId || ctx.playerId));
      if (!normalized.bookingId) return;
      ctx.bookingResults.push({
        bookingId: normalized.bookingId,
        ok: false,
        clientId: normalized.clientId,
        method: "scoped_admin_booking",
        statusCode: msg.statusCode,
      });
    });
    ctx.bookingQueue = [];
    return finalize(ctx);
  }
  ctx.token = msg.payload.access_token;
  appendTrace(ctx, { step: "token_success" });
  return nextBookingRequest(ctx) || finalize(ctx);
}

if (ctx.step === "cancel_probe") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);

  if (isAlreadyCancelledResponse(statusCode, msg.payload) || statusCode === 404) {
    appendTrace(ctx, {
      step: statusCode === 404
        ? "cancel_booking_probe_not_found"
        : "cancel_booking_already_cancelled",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return startVerification(ctx, bookingId, clientId, {
      statusCode,
      alreadyCancelled: statusCode !== 404,
    });
  }
  if (!isOk(statusCode)) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_failed",
      bookingId,
      clientId,
      statusCode,
      response: clone(msg.payload || null),
    });
    return pushFailureAndContinue(ctx, {
      bookingId,
      clientId,
      statusCode,
      response: msg.payload || null,
    });
  }

  const cancelRequest = pickCancelRequest(ctx, bookingId, clientId, msg.payload || null);
  if (!cancelRequest || cancelRequest.unsupportedReason) {
    appendTrace(ctx, {
      step: "cancel_booking_probe_unsupported",
      bookingId,
      clientId,
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || null,
      unsupportedCode: cancelRequest?.unsupportedCode || null,
    });
    return pushFailureAndContinue(ctx, {
      bookingId,
      clientId,
      statusCode,
      unsupportedReason: cancelRequest?.unsupportedReason || "Unsupported refund path",
    });
  }

  ctx.currentCancelRequest = cancelRequest;
  ctx.step = "cancel_booking";
  if (cancelRequest.refundMessage && !ctx.refundMessage) {
    ctx.refundMessage = cancelRequest.refundMessage;
  }
  appendTrace(ctx, {
    step: "cancel_booking_request",
    bookingId,
    clientId,
    scope: cancelRequest.scope,
    attemptLabel: cancelRequest.label,
    refundMethod: cancelRequest.refundMethod || null,
  });
  return adminRequest(ctx, cancelRequest.method, cancelRequest.path, cancelRequest.payload);
}

if (ctx.step === "cancel_booking") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;
  if (isOk(statusCode) || isAlreadyCancelledResponse(statusCode, msg.payload) || statusCode === 404) {
    appendTrace(ctx, {
      step: isOk(statusCode)
        ? "cancel_booking_success"
        : (statusCode === 404 ? "cancel_booking_not_found" : "cancel_booking_already_cancelled"),
      bookingId,
      clientId,
      statusCode,
      refundMethod: cancelRequest?.refundMethod || null,
      response: isOk(statusCode) ? undefined : clone(msg.payload || null),
    });
    return startVerification(ctx, bookingId, clientId, {
      statusCode,
      alreadyCancelled: !isOk(statusCode) && statusCode !== 404,
    });
  }
  appendTrace(ctx, {
    step: "cancel_booking_failed",
    bookingId,
    clientId,
    statusCode,
    refundMethod: cancelRequest?.refundMethod || null,
    response: clone(msg.payload || null),
  });
  return pushFailureAndContinue(ctx, {
    bookingId,
    clientId,
    statusCode,
    response: msg.payload || null,
  });
}

if (ctx.step === "verify_booking_cancelled") {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const statusCode = Number(msg.statusCode);
  const verifyRequest = ctx.currentVerifyRequest && typeof ctx.currentVerifyRequest === "object"
    ? ctx.currentVerifyRequest
    : null;
  const verifyScope = toStr(verifyRequest?.scope);
  const cancelRequest = ctx.currentCancelRequest && typeof ctx.currentCancelRequest === "object"
    ? ctx.currentCancelRequest
    : null;

  if (statusCode === 404 && verifyScope === "client" && ctx.exerciseId) {
    const historyRequest = buildExerciseVerifyRequest(ctx.exerciseId);
    ctx.currentVerifyRequest = {
      ...historyRequest,
      originStatusCode: verifyRequest?.originStatusCode,
      originAlreadyCancelled: verifyRequest?.originAlreadyCancelled === true,
    };
    appendTrace(ctx, {
      step: "cancel_booking_verify_history_request",
      bookingId,
      clientId,
      exerciseId: ctx.exerciseId,
    });
    return adminRequest(ctx, historyRequest.method, historyRequest.path, historyRequest.payload);
  }

  let verifiedCancelled = false;
  let activeBooking = false;
  if (isOk(statusCode) && verifyScope === "client") {
    verifiedCancelled = isCancelledBookingRow(msg.payload);
    activeBooking = !verifiedCancelled;
  } else if (isOk(statusCode) && verifyScope === "exercise") {
    const row = findBookingRow(msg.payload, bookingId);
    verifiedCancelled = Boolean(row && isCancelledBookingRow(row));
    activeBooking = Boolean(row && !verifiedCancelled);
  }

  if (verifiedCancelled) {
    appendTrace(ctx, {
      step: "cancel_booking_verified_cancelled",
      bookingId,
      clientId,
      verifyScope,
      statusCode,
    });
    return pushSuccessAndContinue(ctx, {
      bookingId,
      clientId,
      refundMethod: cancelRequest?.refundMethod || null,
      alreadyCancelled: verifyRequest?.originAlreadyCancelled === true,
      statusCode,
    });
  }

  appendTrace(ctx, {
    step: activeBooking ? "cancel_booking_still_active" : "cancel_booking_unverified",
    bookingId,
    clientId,
    verifyScope,
    statusCode,
    response: clone(msg.payload || null),
  });
  return pushFailureAndContinue(ctx, {
    bookingId,
    clientId,
    statusCode,
    response: msg.payload || null,
  });
}

appendTrace(ctx, {
  step: "unknown_step",
  currentStep: ctx.step,
});
return finalize(ctx);
