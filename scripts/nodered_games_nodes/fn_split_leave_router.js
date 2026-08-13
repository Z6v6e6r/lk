const ADMIN_API = "https://api.vivacrm.ru/api/v1";
const END_USER_V1 = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";
const END_USER_V2 = "https://api.vivacrm.ru/end-user/api/v2/iSkq6G";

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const isOk = (statusCode) => Number(statusCode) >= 200 && Number(statusCode) < 300;
const responseRows = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!isObj(payload)) return [];
  if (Array.isArray(payload.content)) return payload.content;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  if (isObj(payload.data) && Array.isArray(payload.data.content)) return payload.data.content;
  return [];
};
const rowBookingId = (row) => normalizeId(row?.id || row?.bookingId || row?.uuid);
const rowClientId = (row) => normalizeId(
  row?.client?.id || row?.clientId || row?.playerId || row?.userId,
);
const rowExerciseId = (row) => normalizeId(
  row?.exercise?.id
  || row?.exercise?.uuid
  || row?.exerciseId
  || row?.vivaExerciseId
  || row?.timetable?.exerciseId,
);
const isCancelled = (row) => {
  if (!isObj(row)) return false;
  if (row.isCancelled === true || row.cancelled === true || row.canceled === true) return true;
  if (toStr(row.cancellationDate || row.cancelledAt || row.canceledAt)) return true;
  return /CANCEL/.test(String(row.bookingStatus || row.status || row.state || "").toUpperCase());
};
const appendTrace = (ctx, entry) => {
  if (!Array.isArray(ctx.trace)) ctx.trace = [];
  ctx.trace.push({ at: new Date().toISOString(), ...entry });
  if (ctx.trace.length > 40) ctx.trace = ctx.trace.slice(-40);
};
const assignMembershipVersion = (ctx, parts) => {
  const stableParts = Array.from(new Set(asArray(parts).map(toStr).filter(Boolean))).sort();
  if (stableParts.length === 0) return false;
  const hashPart = (value) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const membershipSeed = stableParts.join("|");
  ctx.membershipVersion = `${hashPart(membershipSeed)}${hashPart([...membershipSeed].reverse().join(""))}`;
  ctx.operationId = `self-leave:${ctx.gameId}:${ctx.actorClientId || ctx.actorPhoneNorm}:${ctx.membershipVersion}`;
  return true;
};
const upstream = (ctx, method, url, payload) => {
  msg._splitLeaveCtx = ctx;
  msg.method = method;
  msg.url = url;
  msg.headers = {
    Authorization: ctx.upstreamAuthHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null, null];
};
const fail = (ctx, statusCode, state, message) => {
  const retryScheduled = state === "VIVA_UNVERIFIED"
    && ctx.operationState === "STARTED"
    && Boolean(ctx.operationKey)
    && Boolean(ctx.claimToken);
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    ok: retryScheduled,
    state: retryScheduled ? "IN_PROGRESS" : state,
    ...(ctx.mode === "STAFF_TARGET" ? {
      status: retryScheduled ? "IN_PROGRESS" : state,
      visitAction: ctx.requestedRefundMethod === "SERVICE" ? "RETURN_VISIT" : "NO_RETURN",
      playerId: ctx.targetClientId || null,
    } : {}),
    operationId: ctx.operationId || null,
    gameId: ctx.gameId || null,
    message: retryScheduled
      ? "Запрос на выход обрабатывается. Проверяем отмену записи — это может занять несколько минут."
      : message,
  };
  if (retryScheduled) msg.statusCode = 202;
  delete msg._splitLeaveCtx;
  return [null, msg, msg, null, null];
};
const toLocalApply = (ctx) => {
  ctx.step = "local_apply";
  msg._splitLeaveCtx = ctx;
  delete msg.method;
  delete msg.url;
  delete msg.statusCode;
  msg.payload = undefined;
  return [null, null, null, msg, null];
};
const toOperationStart = (ctx) => {
  msg._splitLeaveCtx = ctx;
  delete msg.method;
  delete msg.url;
  delete msg.statusCode;
  msg.payload = undefined;
  return [null, null, null, null, msg];
};

const resolveOptions = (payload, requestedRefundMethod) => {
  const options = isObj(payload?.cancellationOptions) ? payload.cancellationOptions : {};
  const available = {
    CURRENCY: options.money?.available === true,
    DEPOSIT: options.deposit?.available === true,
    SERVICE: options.subscription?.available === true || options.exercise?.available === true,
    NONE: options.cancellationOnly?.available === true,
  };
  const preferred = toStr(requestedRefundMethod)?.toUpperCase() || null;
  if (preferred) {
    if (available[preferred] !== true) return null;
    return {
      refundMethod: preferred,
      message: preferred === "SERVICE" ? "Вернули занятие на абонемент." : null,
    };
  }
  if (available.CURRENCY) return { refundMethod: "CURRENCY", message: null };
  if (available.DEPOSIT) return { refundMethod: "DEPOSIT", message: null };
  if (available.SERVICE) return { refundMethod: "SERVICE", message: "Вернули занятие на абонемент." };
  if (available.NONE) return { refundMethod: "NONE", message: null };
  return null;
};
const usesEndUser = (ctx) => ctx.mode === "SELF" && ctx.backgroundStartedRecovery !== true;
const cancelProbeUrl = (ctx, bookingId, clientId) => (
  usesEndUser(ctx)
    ? `${END_USER_V1}/bookings/${encodeURIComponent(bookingId)}/cancel`
    : `${ADMIN_API}/clients/${encodeURIComponent(clientId)}/bookings/${encodeURIComponent(bookingId)}/cancel`
);
const cancelUrl = (ctx, bookingId, clientId) => (
  usesEndUser(ctx)
    ? `${END_USER_V1}/bookings/${encodeURIComponent(bookingId)}`
    : `${ADMIN_API}/clients/${encodeURIComponent(clientId)}/bookings/${encodeURIComponent(bookingId)}/cancel`
);
const startActiveVerification = (ctx) => {
  ctx.step = "verify_active";
  const url = usesEndUser(ctx)
    ? `${END_USER_V2}/bookings?size=1000`
    : `${ADMIN_API}/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings?showCancelled=false&page=0&size=200`;
  appendTrace(ctx, { step: "verify_active_request" });
  return upstream(ctx, "GET", url, undefined);
};
const startNextBooking = (ctx) => {
  const next = asArray(ctx.bookingQueue).shift();
  ctx.bookingQueue = asArray(ctx.bookingQueue);
  if (!next) return startActiveVerification(ctx);
  const bookingId = toStr(next.bookingId);
  const clientId = toStr(next.clientId || ctx.targetClientId);
  if (!bookingId || !clientId) return fail(ctx, 409, "CONFLICT", "Не удалось определить запись Viva");
  ctx.currentBookingId = bookingId;
  ctx.currentClientId = clientId;
  ctx.step = "cancel_probe";
  appendTrace(ctx, { step: "cancel_probe_request", bookingId });
  return upstream(ctx, "GET", cancelProbeUrl(ctx, bookingId, clientId), undefined);
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
if (!ctx) {
  msg.statusCode = 500;
  msg.payload = { ok: false, state: "CONFLICT", message: "split leave context missing" };
  return [null, msg, msg, null, null];
}
if (ctx.localAlreadyApplied === true || ctx.step === "local_apply") return toLocalApply(ctx);
if (ctx.step === "start_verify_active") return startActiveVerification(ctx);
if (ctx.step === "start_cancel") return startNextBooking(ctx);

if (ctx.step === "cancel_probe") {
  const statusCode = Number(msg.statusCode) || 0;
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  if (!isOk(statusCode)) {
    if ([400, 404, 409, 422].includes(statusCode)) {
      ctx.bookingResults.push({ bookingId, clientId, provisional: "already_absent" });
      appendTrace(ctx, { step: "cancel_probe_absent", bookingId, statusCode });
      return startNextBooking(ctx);
    }
    return fail(ctx, 422, "VIVA_UNVERIFIED", "Viva не подтвердила сценарий отмены");
  }
  const selected = resolveOptions(msg.payload, ctx.requestedRefundMethod);
  if (!selected) return fail(ctx, 409, "CONFLICT", "Для записи нет поддержанного сценария возврата");
  ctx.currentRefundMethod = selected.refundMethod;
  if (selected.message) ctx.refundMessage = selected.message;
  ctx.step = "cancel_booking";
  const payload = usesEndUser(ctx)
    ? ((selected.refundMethod === "SERVICE" || selected.refundMethod === "NONE")
      ? {}
      : { refundMethod: selected.refundMethod })
    : { refundMethod: selected.refundMethod, cancelExercise: false };
  appendTrace(ctx, { step: "cancel_request", bookingId, refundMethod: selected.refundMethod });
  return upstream(
    ctx,
    usesEndUser(ctx) ? "DELETE" : "PUT",
    cancelUrl(ctx, bookingId, clientId),
    payload,
  );
}

if (ctx.step === "cancel_booking") {
  const statusCode = Number(msg.statusCode) || 0;
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  if (!isOk(statusCode) && ![400, 404, 409, 422].includes(statusCode)) {
    return fail(ctx, 422, "VIVA_UNVERIFIED", "Viva не подтвердила отмену записи");
  }
  ctx.bookingResults.push({
    bookingId,
    clientId,
    provisional: isOk(statusCode) ? "cancel_requested" : "already_absent",
    refundMethod: ctx.currentRefundMethod || null,
  });
  appendTrace(ctx, { step: "cancel_response", bookingId, statusCode });
  ctx.currentBookingId = null;
  ctx.currentClientId = null;
  ctx.currentRefundMethod = null;
  return startNextBooking(ctx);
}

if (ctx.step === "verify_active") {
  if (!isOk(msg.statusCode)) return fail(ctx, 422, "VIVA_UNVERIFIED", "Не удалось проверить активные записи Viva");
  const activeRows = responseRows(msg.payload).filter((row) => !isCancelled(row));
  const bookingIds = new Set(asArray(ctx.initialBookingIds).map(normalizeId).filter(Boolean));
  const targetClientId = normalizeId(ctx.targetClientId);
  const exerciseId = normalizeId(ctx.exerciseId);
  if (ctx.mode === "SELF" && bookingIds.size === 0) {
    const exactExerciseRows = activeRows.filter((row) => (
      ctx.backgroundStartedRecovery === true
        ? Boolean(targetClientId && rowClientId(row) === targetClientId)
        : Boolean(exerciseId && rowExerciseId(row) === exerciseId)
    ));
    const missingBookingId = exactExerciseRows.some((row) => !rowBookingId(row));
    if (missingBookingId) {
      return fail(ctx, 422, "VIVA_UNVERIFIED", "Активная запись Viva найдена без идентификатора");
    }
    const discoveredBookingIds = Array.from(new Set(
      exactExerciseRows.map((row) => toStr(row?.id || row?.bookingId || row?.uuid)).filter(Boolean),
    ));
    if (discoveredBookingIds.length > 0) {
      ctx.initialBookingIds = discoveredBookingIds;
      ctx.bookingQueue = discoveredBookingIds.map((bookingId) => ({
        bookingId,
        clientId: ctx.targetClientId,
      }));
      ctx.discoveredBookingIds = discoveredBookingIds;
      ctx.vivaTargetMode = "BOOKINGS";
      if (!ctx.membershipVersion && !assignMembershipVersion(ctx, discoveredBookingIds)) {
        return fail(ctx, 409, "CONFLICT", "Не удалось зафиксировать поколение записи");
      }
      ctx.preCancelVerification = false;
      ctx.step = "start_cancel";
      appendTrace(ctx, { step: "booking_ids_discovered", count: discoveredBookingIds.length });
      if (ctx.preOperationDiscovery === true) {
        ctx.preOperationDiscovery = false;
        return toOperationStart(ctx);
      }
      return startNextBooking(ctx);
    }
    ctx.localOnlyNoBooking = true;
    ctx.successMessage = "Вы вышли из игры";
    ctx.vivaVerification = "no_active_booking_for_exercise";
  }
  const stillActive = activeRows.some((row) => (
    !isCancelled(row)
    && (
      bookingIds.has(rowBookingId(row))
      || (ctx.mode !== "SELF" && targetClientId && rowClientId(row) === targetClientId)
    )
  ));
  if (stillActive && ctx.preCancelVerification === true) {
    ctx.preCancelVerification = false;
    ctx.step = "start_cancel";
    return startNextBooking(ctx);
  }
  if (stillActive) return fail(ctx, 422, "VIVA_UNVERIFIED", "Viva всё ещё держит запись активной");
  ctx.step = "verify_history";
  const url = usesEndUser(ctx)
    ? `${END_USER_V2}/bookings/history?includeCanceled=true&size=1000`
    : `${ADMIN_API}/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings?showCancelled=true&page=0&size=200`;
  appendTrace(ctx, { step: "verify_history_request" });
  return upstream(ctx, "GET", url, undefined);
}

if (ctx.step === "verify_history") {
  if (!isOk(msg.statusCode)) return fail(ctx, 422, "VIVA_UNVERIFIED", "Не удалось проверить историю записей Viva");
  const rows = responseRows(msg.payload);
  if (ctx.localOnlyNoBooking === true && asArray(ctx.initialBookingIds).length === 0) {
    const exerciseId = normalizeId(ctx.exerciseId);
    const exactHistoryRows = rows.filter((row) => exerciseId && rowExerciseId(row) === exerciseId);
    if (exactHistoryRows.some((row) => !isCancelled(row))) {
      return fail(ctx, 422, "VIVA_UNVERIFIED", "Запись Viva появилась во время проверки");
    }
    ctx.discoveredHistoryBookingIds = Array.from(new Set(
      exactHistoryRows.map((row) => toStr(row?.id || row?.bookingId || row?.uuid)).filter(Boolean),
    ));
    ctx.preCancelVerification = false;
    ctx.vivaVerifiedAt = new Date().toISOString();
    ctx.vivaVerification = "no_active_booking_for_exercise";
    ctx.successMessage = "Вы вышли из игры";
    appendTrace(ctx, { step: "viva_verified_no_active_booking" });
    if (!ctx.membershipVersion) {
      return fail(ctx, 409, "CONFLICT", "Не удалось зафиксировать поколение записи");
    }
    ctx.vivaTargetMode = "NONE";
    if (ctx.preOperationDiscovery === true) {
      ctx.preOperationDiscovery = false;
      return toOperationStart(ctx);
    }
    return toLocalApply(ctx);
  }
  const missing = asArray(ctx.initialBookingIds).filter((bookingId) => {
    const row = rows.find((item) => rowBookingId(item) === normalizeId(bookingId));
    return !row || !isCancelled(row);
  });
  if (missing.length > 0) return fail(ctx, 422, "VIVA_UNVERIFIED", "Отмена записи не подтверждена историей Viva");
  ctx.preCancelVerification = false;
  ctx.vivaVerifiedAt = new Date().toISOString();
  ctx.vivaVerification = "active_absent_history_cancelled";
  appendTrace(ctx, { step: "viva_verified" });
  return toLocalApply(ctx);
}

return fail(ctx, 409, "CONFLICT", "Неизвестное состояние операции");
