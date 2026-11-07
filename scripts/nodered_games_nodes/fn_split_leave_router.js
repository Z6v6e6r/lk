// Internal graph-only capability; public request bodies cannot set message context.
if (msg._managedLeaveCapability) {
  const cap = msg._managedLeaveCapability;
  if (cap.version !== 1 || cap.stage !== "router") {
    msg.statusCode = 503; msg.payload = { code: "MANAGED_SELF_LEAVE_INCOMPATIBLE" };
    return [null, msg];
  }
  cap.stage = "complete";
  return [null, null, null, null, null, null, msg];
}
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
// Absence is evidence only from a complete, well-formed first page.
const completeBookingPage = (payload, limit) => {
  if (isObj(payload?.data) && !Array.isArray(payload.data.content)) return false;
  const page = isObj(payload?.data) ? payload.data : payload;
  const recognized = Array.isArray(page) || (isObj(page)
    && [page.content, page.items, page.data].some(Array.isArray));
  if (!recognized) return false;
  const rows = responseRows(payload);
  return rows.every(isObj) && rows.length < limit
    && [payload, page].every((value) => Array.isArray(value) || (
      value.last !== false && value.hasNext !== true && !value.next && !value.nextPage
      && !(Number(value.number || value.page || 0) > 0)
      && !(Number(value.totalPages) > 1)
      && !(Number(value.totalElements ?? value.total) > rows.length)
    ));
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
const rowClientSubscriptionId = (row) => toStr(
  row?.clientSubscriptionId || row?.clientSubId || row?.subscription?.clientSubscriptionId || row?.subscription?.subscriptionId,
);
const rowSubscriptionVisitCount = (row) => {
  const value = Number(row?.count ?? row?.visitsCount ?? row?.visitCount);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};
const subscriptionInstanceId = (row) => toStr(row?.clientSubscriptionId || row?.subscriptionId);
const subscriptionVisitsLeft = (row) => {
  const value = Number(row?.visitsLeft);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const subscriptionBookings = (row) => asArray(row?.bookings);
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
const upstream = (ctx, method, url, payload, authHeader = ctx.upstreamAuthHeader) => {
  if (ctx.managedSelfLeaveOwner) { ctx.managedOwnerExpectedUrl = url; ctx.managedOwnerExpectedStep = ctx.step; }
  if (ctx.monetarySelfLeave) {
    ctx.monetaryExpectedUrl = url; ctx.monetaryExpectedStep = ctx.step;
    msg.followRedirects = false; msg.requestTimeout = 10000;
  }
  msg._splitLeaveCtx = ctx;
  msg.method = method;
  msg.url = url;
  msg.headers = {
    Authorization: authHeader,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  msg.payload = payload;
  return [msg, null, null, null, null];
};
const serviceAuthHeader = () => {
  const token = toStr(global.get("vivacrm_access_token"));
  return token ? `Bearer ${token}` : null;
};
const subscriptionListUrl = (ctx) => (
  `${ADMIN_API}/clients/${encodeURIComponent(ctx.targetClientId)}/subscriptions?size=200`
);
const exactSubscriptionRow = (payload, clientSubscriptionId) => {
  const target = normalizeId(clientSubscriptionId);
  const rows = responseRows(payload).filter((row) => normalizeId(subscriptionInstanceId(row)) === target);
  return rows.length === 1 ? rows[0] : null;
};
const subscriptionHasActiveBooking = (row, bookingId) => subscriptionBookings(row).some((booking) => (
  rowBookingId(booking) === normalizeId(bookingId) && !isCancelled(booking)
));
const subscriptionBookingReturned = (row, bookingId) => {
  const exact = subscriptionBookings(row).filter((booking) => rowBookingId(booking) === normalizeId(bookingId));
  return exact.length === 0 || exact.every(isCancelled);
};
const exactActiveSubscriptionCandidates = (payload, bookingId) => responseRows(payload).filter((row) => (
  subscriptionInstanceId(row) && subscriptionHasActiveBooking(row, bookingId)
));
const fail = (ctx, statusCode, state, message) => {
  const retryScheduled = ctx.vivaTargetMode !== "DISCOVERY" && state === "VIVA_UNVERIFIED"
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
  return [null, msg, (msg._managedSelfLeave || ctx?.monetarySelfLeave) ? null : msg, null, null];
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
const markReturnPendingAndApply = (ctx, reason) => {
  ctx.subscriptionReturnState = "RETURN_PENDING";
  ctx.subscriptionReturnReason = reason;
  ctx.refundMessage = null;
  ctx.successMessage = "Вы вышли из игры. Возврат посещения проверяется";
  appendTrace(ctx, { step: "subscription_return_pending", reason });
  return toLocalApply(ctx);
};
const startSubscriptionReadback = (ctx, step) => {
  const authHeader = serviceAuthHeader();
  if (!authHeader) {
    if (step === "verify_subscription_return") {
      return markReturnPendingAndApply(ctx, "service_token_unavailable");
    }
    return fail(ctx, 503, "VIVA_UNVERIFIED", "Не удалось проверить абонемент до отмены");
  }
  ctx.step = step;
  appendTrace(ctx, { step: `${step}_request` });
  return upstream(ctx, "GET", subscriptionListUrl(ctx), undefined, authHeader);
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
// Monetary history is deliberately stricter than the legacy SERVICE projection.
const moneyPending = ctx => fail(ctx, 202, "RETRY_REQUIRED", "Проверяем исходную отмену; возврат средств не подтверждён");
const moneyCas = (ctx, action) => {
  ctx.monetaryAction = action;
  msg._splitLeaveCtx = ctx;
  delete msg.method; delete msg.url; delete msg.headers; delete msg.statusCode; delete msg.error;
  msg.payload = undefined;
  return [null, null, null, null, null, null, null, msg];
};
const moneySameIds = (values, expected) => {
  const supplied = values.filter(v => v !== undefined && v !== null);
  return supplied.length > 0 && supplied.every(v => typeof v === "string" && v === expected);
};
const moneyExactRow = (row, id, o) => isObj(row)
  && moneySameIds([row.id, row.bookingId, row.uuid], id)
  && moneySameIds([row.client?.id, row.clientId, row.playerId, row.userId], o.actorClientId)
  && moneySameIds([row.exercise?.id, row.exercise?.uuid, row.exerciseId, row.vivaExerciseId, row.timetable?.exerciseId], o.exerciseId);
const moneyCompletePage = payload => {
  if (!completeBookingPage(payload, 1000)) return false;
  const page = isObj(payload?.data) ? payload.data : payload;
  if (isObj(payload?.data) && (Array.isArray(payload.content) || Array.isArray(payload.items))) return false;
  if (!Array.isArray(page) && [page.content, page.items, page.data].filter(Array.isArray).length !== 1) return false;
  const count = responseRows(payload).length;
  return [payload, page].every(value => Array.isArray(value) || (
    [value.number, value.page].every(x => x === undefined || x === 0)
    && [value.totalElements, value.total].every(x => x === undefined || (Number.isSafeInteger(x) && x === count))
    && (value.totalPages === undefined || value.totalPages === 1 || (value.totalPages === 0 && count === 0))
    && (value.last === undefined || value.last === true)
    && (value.hasNext === undefined || value.hasNext === false)
    && [value.next, value.nextPage].every(x => x === undefined || x === null)
  ));
};
const moneyPageRows = (rows, actor) => {
  const aliases = values => { const v = values.filter(x => x !== undefined && x !== null);
    return v.length > 0 && v.every(x => typeof x === "string" && x.trim() && x === v[0]); };
  return new Set(rows.map(rowBookingId)).size === rows.length && rows.every(row =>
    aliases([row.id, row.bookingId, row.uuid])
    && moneySameIds([row.client?.id, row.clientId, row.playerId, row.userId], actor)
    && aliases([row.exercise?.id, row.exercise?.uuid, row.exerciseId, row.vivaExerciseId, row.timetable?.exerciseId]));
};
const moneyCancelled = row => {
  const flags = [row.isCancelled, row.cancelled, row.canceled].filter(v => v !== undefined && v !== null);
  const states = [row.bookingStatus, row.status, row.state].filter(v => v !== undefined && v !== null);
  const times = [row.cancellationDate, row.cancelledAt, row.canceledAt].filter(v => v !== undefined && v !== null);
  // Existing explicit boolean fields only; a substring or date alone never proves cancellation.
  return flags.length > 0 && flags.every(v => v === true)
    && states.every(v => v === "CANCELLED" || v === "CANCELED")
    && times.every(v => typeof v === "string" && Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now());
};
const startMoneyVerification = ctx => {
  ctx.step = "monetary_verify_active";
  return upstream(ctx, "GET", `${END_USER_V2}/bookings?size=1000`, undefined, ctx.actorAuthHeader);
};
const issueCurrentCancellation = (ctx) => {
  const bookingId = toStr(ctx.currentBookingId);
  const clientId = toStr(ctx.currentClientId);
  const refundMethod = toStr(ctx.currentRefundMethod);
  if (ctx.managedSelfLeaveOwner && (ctx.mode !== "SELF" || ctx.backgroundStartedRecovery === true
    || bookingId !== ctx.managedSelfLeaveOwner.providerBookingId || clientId !== ctx.managedSelfLeaveOwner.providerClientId
    || refundMethod !== "SERVICE" || !Number.isFinite(Date.parse(ctx.managedOwnerActorExpiresAt))
    || Date.parse(ctx.managedOwnerActorExpiresAt) <= Date.now()
    || !Number.isSafeInteger(ctx.managedOwnerDelegationExpiresAt) || ctx.managedOwnerDelegationExpiresAt <= Date.now())) {
    return fail(ctx, 202, "RETRY_REQUIRED", "Исходное посещение не подтверждено");
  }
  if (ctx.mode === "SELF" && (["CURRENCY", "DEPOSIT"].includes(refundMethod)
    || (ctx.monetarySelfLeave && refundMethod === "SERVICE"))) {
    if (!ctx.monetarySelfLeave || ctx.managedSelfLeaveOwner || ctx.backgroundRetry || ctx.backgroundStartedRecovery
      || ctx.actorClientId !== ctx.targetClientId || !/^Bearer \S+$/.test(ctx.actorAuthHeader || "")) return moneyPending(ctx);
    const permit = ctx.monetaryDispatchPermit;
    delete ctx.monetaryDispatchPermit;
    if (!permit) {
      if (ctx.operationState === "STARTED" && !ctx.monetaryInitialVerified) {
        ctx.step = "monetary_initial_active";
        return upstream(ctx, "GET", `${END_USER_V2}/bookings?size=1000`, undefined, ctx.actorAuthHeader);
      }
      return moneyCas(ctx, { kind: "dispatch", bookingId, refundMethod });
    }
    if (permit.bookingId !== bookingId || permit.refundMethod !== refundMethod
      || ctx.operationState !== "MONETARY_DISPATCH_STARTED"
      || !Number.isFinite(Date.parse(ctx.monetaryLeaseUntil)) || Date.parse(ctx.monetaryLeaseUntil) <= Date.now()
      || !ctx.monetarySelfLeave.markers.some(m => m.bookingId === bookingId && m.claimToken === ctx.claimToken
        && m.refundMethod === refundMethod)) return moneyPending(ctx);
  }
  ctx.step = "cancel_booking";
  const payload = usesEndUser(ctx)
    ? ((refundMethod === "SERVICE" || refundMethod === "NONE") ? {} : { refundMethod })
    : { refundMethod, cancelExercise: false };
  appendTrace(ctx, { step: "cancel_request", bookingId, refundMethod });
  return upstream(ctx, usesEndUser(ctx) ? "DELETE" : "PUT", cancelUrl(ctx, bookingId, clientId), payload,
    ctx.monetarySelfLeave && ["CURRENCY", "DEPOSIT", "SERVICE"].includes(refundMethod) ? ctx.actorAuthHeader : ctx.upstreamAuthHeader);
};
const captureSubscriptionBefore = (ctx, row, expectedReturnCount) => {
  const clientSubscriptionId = row ? subscriptionInstanceId(row) : null;
  const visitsLeft = row ? subscriptionVisitsLeft(row) : null;
  if (
    !clientSubscriptionId
    || visitsLeft === null
    || !Number.isSafeInteger(expectedReturnCount)
    || expectedReturnCount < 1
    || !subscriptionHasActiveBooking(row, ctx.currentBookingId)
  ) {
    return fail(ctx, 409, "CONFLICT", "Абонемент не подтверждает активную запись до отмены");
  }
  ctx.clientSubscriptionId = clientSubscriptionId;
  ctx.expectedReturnCount = expectedReturnCount;
  ctx.subscriptionVisitCount = expectedReturnCount;
  ctx.subscriptionReturnChecks = asArray(ctx.subscriptionReturnChecks).filter((item) => (
    normalizeId(item?.bookingId) !== normalizeId(ctx.currentBookingId)
  ));
  ctx.subscriptionReturnChecks.push({
    bookingId: toStr(ctx.currentBookingId),
    clientSubscriptionId,
    visitsLeftBefore: visitsLeft,
    expectedReturnCount,
  });
  appendTrace(ctx, { step: "subscription_before_verified", bookingId: toStr(ctx.currentBookingId) });
  return issueCurrentCancellation(ctx);
};
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
  return [null, msg, (msg._managedSelfLeave || ctx?.monetarySelfLeave) ? null : msg, null, null];
}
if (ctx.monetarySelfLeave && ctx.monetaryExpectedStep === ctx.step) {
  if (msg.error || msg.responseUrl !== ctx.monetaryExpectedUrl) return moneyPending(ctx);
  delete ctx.monetaryExpectedUrl; delete ctx.monetaryExpectedStep;
}
if (ctx.step === "monetary_initial_active") {
  const o = ctx.monetarySelfLeave?.original, rows = responseRows(msg.payload);
  if (!o || !isOk(msg.statusCode) || !moneyCompletePage(msg.payload)
    || !moneyPageRows(rows, o.actorClientId)
    || rows.some(row => rowExerciseId(row) === normalizeId(o.exerciseId)
      && !o.bookingIds.some(id => rowBookingId(row) === normalizeId(id)) && !moneyCancelled(row))
    || rows.filter(row => o.bookingIds.some(id => rowBookingId(row) === normalizeId(id))).some(row =>
      !moneyExactRow(row, o.bookingIds.find(id => rowBookingId(row) === normalizeId(id)), o))
    || !rows.some(row => moneyExactRow(row, ctx.currentBookingId, o) && !moneyCancelled(row))) return moneyPending(ctx);
  ctx.monetaryInitialVerified = true;
  return issueCurrentCancellation(ctx);
}
if (ctx.step === "monetary_dispatch_ack") return issueCurrentCancellation(ctx);
if (ctx.step === "start_monetary_verify") return startMoneyVerification(ctx);
if (ctx.step === "monetary_verify_active" || ctx.step === "monetary_verify_history") {
  const o = ctx.monetarySelfLeave?.original;
  if (!o || !isOk(msg.statusCode) || !moneyCompletePage(msg.payload)) return moneyPending(ctx);
  const rows = responseRows(msg.payload);
  // Ambiguous aliases/duplicates and new bookings of the same exercise cannot be adopted.
  const ids = rows.map(rowBookingId);
  if (ids.some(id => !id) || !moneyPageRows(rows, o.actorClientId)) return moneyPending(ctx);
  const originalRows = rows.filter(row => o.bookingIds.some(id => rowBookingId(row) === normalizeId(id)));
  if (originalRows.some(row => !moneyExactRow(row, o.bookingIds.find(id => rowBookingId(row) === normalizeId(id)), o))) return moneyPending(ctx);
  if (ctx.step === "monetary_verify_active") {
    if (rows.some(row => rowExerciseId(row) === normalizeId(o.exerciseId)
      && !o.bookingIds.some(id => rowBookingId(row) === normalizeId(id)) && !moneyCancelled(row))) return moneyPending(ctx);
    ctx.monetaryActiveIds = originalRows.filter(row => !moneyCancelled(row)).map(row => o.bookingIds.find(id => rowBookingId(row) === normalizeId(id)));
    ctx.step = "monetary_verify_history";
    return upstream(ctx, "GET", `${END_USER_V2}/bookings/history?includeCanceled=true&size=1000`, undefined, ctx.actorAuthHeader);
  }
  const active = ctx.monetaryActiveIds;
  if (!Array.isArray(active)) return moneyPending(ctx);
  const cancelled = o.bookingIds.filter(id => !active.includes(id));
  if (cancelled.some(id => !originalRows.some(row => moneyExactRow(row, id, o) && moneyCancelled(row)))
    || ctx.monetarySelfLeave.markers.some(m => !cancelled.includes(m.bookingId))) return moneyPending(ctx);
  ctx.monetaryRemaining = active.filter(id => !ctx.monetarySelfLeave.markers.some(m => m.bookingId === id));
  ctx.monetaryVerifiedAt = new Date().toISOString();
  ctx.monetaryHistory = { content: cancelled.map(id => ({ id, clientId: o.actorClientId,
    exerciseId: o.exerciseId, cancelled: true })) };
  return moneyCas(ctx, { kind: "readback", cancelledBookingIds: cancelled });
}
if (ctx.step === "monetary_readback_ack") {
  if (!Array.isArray(ctx.monetaryRemaining)) return moneyPending(ctx);
  if (ctx.monetaryRemaining.length) {
    delete ctx.monetaryHistory;
    ctx.bookingQueue = ctx.monetaryRemaining.map(bookingId => ({ bookingId, clientId: ctx.actorClientId }));
    return startNextBooking(ctx);
  }
  // Existing SERVICE verification and local apply remain after the stronger money proof.
  ctx.step = "verify_history"; ctx.preCancelVerification = false;
  ctx.vivaVerifiedAt = ctx.monetaryVerifiedAt;
  msg.payload = ctx.monetaryHistory; msg.statusCode = 200;
  delete ctx.monetaryHistory;
}
if (ctx.managedSelfLeaveOwner && (ctx.requestedRefundMethod !== "SERVICE"
  || ctx.mode !== "SELF" || ctx.actorClientId !== ctx.managedSelfLeaveOwner.providerClientId
  || ctx.targetClientId !== ctx.managedSelfLeaveOwner.providerClientId
  || ctx.exerciseId !== ctx.managedSelfLeaveOwner.providerExerciseId
  || ctx.membershipVersion !== ctx.managedSelfLeaveOwner.membershipVersion
  || (ctx.managedOwnerExpectedStep === ctx.step && ctx.managedOwnerExpectedUrl
    && (msg.error || msg.responseUrl !== ctx.managedOwnerExpectedUrl)))) {
  return fail(ctx, 202, "RETRY_REQUIRED", "Исходная управляемая запись требует сверки");
}
if (ctx.managedSelfLeaveOwner && ctx.managedOwnerExpectedStep === ctx.step) {
  delete ctx.managedOwnerExpectedUrl; delete ctx.managedOwnerExpectedStep;
}
if (ctx.localReconciliation && !["start_verify_active", "verify_active", "verify_history", "local_apply"].includes(ctx.step)) {
  return fail(ctx, 202, "RETRY_REQUIRED", "Требуется повторная проверка состава игры.");
}
if (ctx.step === "start_verify_subscription_return") {
  return startSubscriptionReadback(ctx, "verify_subscription_return");
}
if ((ctx.localAlreadyApplied === true && ctx.step !== "verify_subscription_return") || ctx.step === "local_apply") {
  return toLocalApply(ctx);
}
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
  if (selected.refundMethod === "SERVICE") {
    const evidence = isObj(ctx.bookingSubscriptionEvidence?.[normalizeId(bookingId)])
      ? ctx.bookingSubscriptionEvidence[normalizeId(bookingId)]
      : {};
    const clientSubscriptionId = toStr(evidence.clientSubscriptionId || ctx.clientSubscriptionId);
    const expectedReturnCount = Number(evidence.subscriptionVisitCount || ctx.subscriptionVisitCount);
    if (!Number.isSafeInteger(expectedReturnCount) || expectedReturnCount < 1) {
      return fail(ctx, 409, "CONFLICT", "Не удалось однозначно определить абонемент и число посещений");
    }
    ctx.expectedReturnCount = expectedReturnCount;
    if (!clientSubscriptionId) {
      return startSubscriptionReadback(ctx, "resolve_subscription_before");
    }
    ctx.clientSubscriptionId = clientSubscriptionId;
    return startSubscriptionReadback(ctx, "snapshot_subscription_before");
  }
  return issueCurrentCancellation(ctx);
}

if (ctx.step === "resolve_subscription_before") {
  if (!isOk(msg.statusCode)) {
    return fail(ctx, 422, "VIVA_UNVERIFIED", "Не удалось проверить абонемент до отмены");
  }
  const candidates = exactActiveSubscriptionCandidates(msg.payload, ctx.currentBookingId);
  if (candidates.length !== 1) {
    return fail(ctx, 409, "CONFLICT", "Не удалось однозначно определить абонемент списания");
  }
  const nestedVisitCounts = Array.from(new Set(
    subscriptionBookings(candidates[0])
      .filter((booking) => rowBookingId(booking) === normalizeId(ctx.currentBookingId) && !isCancelled(booking))
      .map(rowSubscriptionVisitCount)
      .filter(Boolean),
  ));
  if (
    nestedVisitCounts.length > 1
    || (nestedVisitCounts[0] && nestedVisitCounts[0] !== ctx.expectedReturnCount)
  ) {
    return fail(ctx, 409, "CONFLICT", "Viva вернула другой объём списания по абонементу");
  }
  return captureSubscriptionBefore(ctx, candidates[0], nestedVisitCounts[0] || ctx.expectedReturnCount);
}

if (ctx.step === "snapshot_subscription_before") {
  if (!isOk(msg.statusCode)) {
    return fail(ctx, 422, "VIVA_UNVERIFIED", "Не удалось проверить абонемент до отмены");
  }
  const row = exactSubscriptionRow(msg.payload, ctx.clientSubscriptionId);
  return captureSubscriptionBefore(ctx, row, ctx.expectedReturnCount);
}

if (ctx.step === "cancel_booking") {
  if (ctx.operationState === "MONETARY_DISPATCH_STARTED") {
    // Even a successful HTTP response is not cancellation/credit proof. Never repeat the marked write.
    if (msg.error) return moneyPending(ctx);
    if (isOk(msg.statusCode)) ctx.bookingResults.push({ bookingId: ctx.currentBookingId,
      clientId: ctx.currentClientId, provisional: "cancel_requested", refundMethod: ctx.currentRefundMethod });
    ctx.currentBookingId = null; ctx.currentClientId = null; ctx.currentRefundMethod = null;
    return startMoneyVerification(ctx);
  }
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
  if (ctx.vivaTargetMode === "DISCOVERY") {
    if (ctx.mode !== "STAFF_TARGET" || !ctx.bookingDiscovery || ctx.backgroundRetry === true
      || !completeBookingPage(msg.payload, 200)) {
      return fail(ctx, 409, "CONFLICT", "Не удалось полностью проверить текущую запись. Обновите игру.");
    }
    const rows = responseRows(msg.payload).filter((row) => !isCancelled(row));
    if (rows.some((row) => !rowClientId(row) || !rowBookingId(row)
      || (rowExerciseId(row) && rowExerciseId(row) !== normalizeId(ctx.exerciseId)))) {
      return fail(ctx, 422, "VIVA_UNVERIFIED", "Viva вернула неоднозначную принадлежность записи");
    }
    const exact = rows.filter((row) => rowClientId(row) === normalizeId(ctx.targetClientId));
    if (exact.length !== 1) {
      return fail(ctx, 409, "CONFLICT", exact.length > 1
        ? "В Viva несколько активных записей игрока. Требуется проверка администратора."
        : "В Viva нет активной записи игрока. Обновите состав игры.");
    }
    ctx.discoveredBooking = {
      bookingId: rowBookingId(exact[0]),
      clientSubscriptionId: rowClientSubscriptionId(exact[0]),
      subscriptionVisitCount: rowSubscriptionVisitCount(exact[0]),
    };
    msg._splitLeaveCtx = ctx;
    delete msg.method;
    delete msg.url;
    delete msg.headers;
    msg.payload = undefined;
    return [null, null, null, null, null, msg];
  }
  if (ctx.localReconciliation && !completeBookingPage(msg.payload, usesEndUser(ctx) ? 1000 : 200)) {
    return fail(ctx, 202, "RETRY_REQUIRED", "Не удалось полностью проверить записи Viva. Повторите проверку.");
  }
  const activeRows = responseRows(msg.payload).filter((row) => !isCancelled(row));
  if (ctx.localReconciliation) {
    const rowIsAmbiguous = (row) => (usesEndUser(ctx) ? !rowExerciseId(row) : !rowClientId(row));
    const rowMatchesTarget = (row) => (usesEndUser(ctx)
      ? Boolean(normalizeId(ctx.exerciseId)) && rowExerciseId(row) === normalizeId(ctx.exerciseId)
      : Boolean(normalizeId(ctx.targetClientId)) && rowClientId(row) === normalizeId(ctx.targetClientId));
    const attributableRows = activeRows.filter((row) => !rowIsAmbiguous(row) && rowMatchesTarget(row));
    const ambiguousRows = activeRows.filter(rowIsAmbiguous);
    // A player-initiated leave that finds its own live booking for this exercise must be
    // allowed to cancel it through the normal booking path. Background recovery and live
    // bookings that cannot be attributed keep failing closed.
    if (
      ctx.mode === "SELF"
      && ctx.foregroundRequest === true
      && ctx.backgroundStartedRecovery !== true
      && attributableRows.length > 0
      && ambiguousRows.length === 0
    ) {
      ctx.reconciliationDemoted = true;
      delete ctx.localReconciliation;
      appendTrace(ctx, { step: "local_reconciliation_demoted", activeBookings: attributableRows.length });
    } else if (attributableRows.length > 0 || ambiguousRows.length > 0) {
      return fail(ctx, 202, "RETRY_REQUIRED", "В Viva есть действующая запись. Обновите игру перед новым выходом.");
    }
  }
  const bookingIds = new Set(asArray(ctx.initialBookingIds).map(normalizeId).filter(Boolean));
  const targetClientId = normalizeId(ctx.targetClientId);
  const exerciseId = normalizeId(ctx.exerciseId);
  if (ctx.preCancelVerification === true && bookingIds.size > 0) {
    if (!completeBookingPage(msg.payload, usesEndUser(ctx) ? 1000 : 200)) {
      return fail(ctx, 422, "VIVA_UNVERIFIED", "Не удалось полностью проверить текущую запись Viva");
    }
    const boundRows = activeRows.filter((row) => bookingIds.has(rowBookingId(row)));
    const wrongTarget = boundRows.some((row) => (
      (rowClientId(row) && rowClientId(row) !== targetClientId)
      || (rowExerciseId(row) && rowExerciseId(row) !== exerciseId)
      || (usesEndUser(ctx) ? !rowExerciseId(row) : !rowClientId(row))
    ));
    const replacement = ctx.localMutationDisabled !== true && activeRows.some((row) => (
      (usesEndUser(ctx) ? rowExerciseId(row) === exerciseId : rowClientId(row) === targetClientId)
      && !bookingIds.has(rowBookingId(row))
    ));
    if (wrongTarget || replacement) {
      return fail(ctx, 409, "CONFLICT", "Запись игрока в Viva изменилась. Обновите состав игры перед удалением.");
    }
  }
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
    const exactTargetRows = activeRows.filter((row) => bookingIds.has(rowBookingId(row)));
    const subscriptionIds = Array.from(new Set(exactTargetRows.map(rowClientSubscriptionId).filter(Boolean)));
    const visitCounts = Array.from(new Set(exactTargetRows.map(rowSubscriptionVisitCount).filter(Boolean)));
    if (subscriptionIds.length > 1 || visitCounts.length > 1) {
      return fail(ctx, 409, "CONFLICT", "Записи Viva ссылаются на разные абонементы или объёмы списания");
    }
    if (ctx.clientSubscriptionId && subscriptionIds[0]
      && normalizeId(ctx.clientSubscriptionId) !== normalizeId(subscriptionIds[0])) {
      return fail(ctx, 409, "CONFLICT", "Viva вернула другой экземпляр абонемента");
    }
    ctx.clientSubscriptionId = subscriptionIds[0] || ctx.clientSubscriptionId || null;
    ctx.subscriptionVisitCount = visitCounts[0] || ctx.subscriptionVisitCount || null;
    ctx.bookingSubscriptionEvidence = isObj(ctx.bookingSubscriptionEvidence)
      ? ctx.bookingSubscriptionEvidence
      : {};
    exactTargetRows.forEach((row) => {
      const bookingId = rowBookingId(row);
      if (!bookingId) return;
      ctx.bookingSubscriptionEvidence[bookingId] = {
        clientSubscriptionId: rowClientSubscriptionId(row) || ctx.clientSubscriptionId || null,
        subscriptionVisitCount: rowSubscriptionVisitCount(row) || ctx.subscriptionVisitCount || null,
      };
    });
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
  if (ctx.localReconciliation) {
    const targetRows = rows.filter((row) => usesEndUser(ctx)
      ? rowExerciseId(row) === normalizeId(ctx.exerciseId)
      : rowClientId(row) === normalizeId(ctx.targetClientId));
    const proof = ctx.localReconciliation;
    if (!completeBookingPage(msg.payload, usesEndUser(ctx) ? 1000 : 200)
      || rows.some((row) => usesEndUser(ctx) ? !rowExerciseId(row) : !rowClientId(row))
      || targetRows.some((row) => !isCancelled(row))
      || !proof.priorBookingIds.every((id) => targetRows.some((row) => (
        rowBookingId(row) === normalizeId(id) && isCancelled(row)
      )))) {
      return fail(ctx, 202, "RETRY_REQUIRED", "Не удалось подтвердить отмену предыдущей записи. Повторите проверку.");
    }
    assignMembershipVersion(ctx, ["local-reconciliation", proof.priorOperationId, proof.snapshotUpdatedAt]);
    ctx.vivaVerifiedAt = new Date().toISOString();
    ctx.vivaVerification = "no_active_booking_for_exercise";
    ctx.vivaTargetMode = "NONE";
    ctx.preCancelVerification = false;
    ctx.successMessage = "Вы вышли из игры";
    if (ctx.preOperationDiscovery === true) {
      ctx.preOperationDiscovery = false;
      return toOperationStart(ctx);
    }
    return toLocalApply(ctx);
  }
  if (ctx.localOnlyNoBooking === true && asArray(ctx.initialBookingIds).length === 0) {
    const exerciseId = normalizeId(ctx.exerciseId);
    const exactHistoryRows = rows.filter((row) => exerciseId && rowExerciseId(row) === exerciseId);
    if (exactHistoryRows.some((row) => !isCancelled(row))) {
      return fail(ctx, 422, "VIVA_UNVERIFIED", "Запись Viva появилась во время проверки");
    }
    ctx.discoveredHistoryBookingIds = Array.from(new Set(
      exactHistoryRows.map((row) => toStr(row?.id || row?.bookingId || row?.uuid)).filter(Boolean),
    ));
    // Read-back proved this exercise holds no live booking, so there is no Viva
    // booking id to anchor the membership generation. For a participant that was
    // imported into the roster without any locally recorded booking of their own
    // there is nothing left to reconcile, and without an anchor every attempt
    // died here with 409 while leaving nothing durable - the player could never
    // leave the game at all. Anchor that shape on the frozen game snapshot: a
    // rejoin or roster move bumps `updatedAt` and yields a new generation, while
    // retries of the same snapshot reuse one idempotent operation. A payment row
    // of this very player that does carry a booking identifier still fails
    // closed, because that identifier can be reconciled elsewhere.
    const sameValue = (left, right) => Boolean(
      left && right && String(left).trim().toLowerCase() === String(right).trim().toLowerCase(),
    );
    const paymentBelongsToTarget = (item) => {
      const clientId = item.clientId || item.playerId || item.userId;
      const phone = item.phoneNorm || item.phone || item.clientPhoneNorm || item.clientPhone;
      if (!toStr(clientId) && !toStr(phone)) return true;
      return sameValue(clientId, ctx.targetClientId) || sameValue(phone, ctx.targetPhoneNorm);
    };
    const hasTargetLocalBookingAnchor = asArray(ctx.game?.metadata?.splitPayment?.payments)
      .filter(isObj)
      .filter(paymentBelongsToTarget)
      .some((item) => Boolean(
        toStr(item.bookingId)
        || asArray(item.bookingIds).some((bookingId) => Boolean(toStr(bookingId))),
      ));
    if (!ctx.membershipVersion) {
      if (hasTargetLocalBookingAnchor) {
        return fail(ctx, 202, "RETRY_REQUIRED", "Не удалось подтвердить отмену записи Viva. Обновите игру и повторите выход.");
      }
      if (!assignMembershipVersion(ctx, [
        "no-active-booking",
        ctx.gameId,
        ctx.targetClientId || ctx.targetPhoneNorm,
        ctx.game?.updatedAt,
      ])) {
        return fail(ctx, 409, "CONFLICT", "Не удалось зафиксировать поколение записи");
      }
    }
    ctx.preCancelVerification = false;
    ctx.vivaVerifiedAt = new Date().toISOString();
    ctx.vivaVerification = "no_active_booking_for_exercise";
    ctx.successMessage = "Вы вышли из игры";
    appendTrace(ctx, { step: "viva_verified_no_active_booking" });
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
  if (asArray(ctx.subscriptionReturnChecks).length > 0) {
    return startSubscriptionReadback(ctx, "verify_subscription_return");
  }
  if (ctx.requestedRefundMethod === "SERVICE"
    || ctx.currentRefundMethod === "SERVICE"
    || (ctx.clientSubscriptionId && ctx.requestedRefundMethod !== "NONE")) {
    return markReturnPendingAndApply(ctx, "subscription_return_baseline_missing");
  }
  return toLocalApply(ctx);
}

if (ctx.step === "verify_subscription_return") {
  if (!isOk(msg.statusCode)) {
    return markReturnPendingAndApply(ctx, "subscription_readback_unavailable");
  }
  const checks = asArray(ctx.subscriptionReturnChecks);
  if (checks.length === 0) {
    return markReturnPendingAndApply(ctx, "subscription_return_baseline_missing");
  }
  const verified = checks.every((check) => {
    const row = exactSubscriptionRow(msg.payload, check.clientSubscriptionId);
    const visitsLeft = row ? subscriptionVisitsLeft(row) : null;
    return Boolean(
      row
      && visitsLeft !== null
      && visitsLeft >= Number(check.visitsLeftBefore) + Number(check.expectedReturnCount)
      && subscriptionBookingReturned(row, check.bookingId),
    );
  });
  if (!verified) return markReturnPendingAndApply(ctx, "subscription_return_not_observed");
  ctx.subscriptionReturnState = "RETURN_VERIFIED";
  ctx.subscriptionReturnVerifiedAt = new Date().toISOString();
  ctx.subscriptionReturnReason = null;
  ctx.refundMessage = "Вернули занятие на абонемент.";
  ctx.successMessage = ctx.refundMessage;
  appendTrace(ctx, { step: "subscription_return_verified" });
  return toLocalApply(ctx);
}

return fail(ctx, 409, "CONFLICT", "Неизвестное состояние операции");
