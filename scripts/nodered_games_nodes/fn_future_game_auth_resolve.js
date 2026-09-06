const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const fail = (ctx, statusCode, code, error) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: { ok: false, code, error, retryable: statusCode >= 500 },
  });
  delete response._futureGameAuth;
  delete response.url;
  delete response.method;
  return [null, null, response, response];
};
const bookingPage = (payload, expectedPage) => {
  if (!isObj(payload)) return null;
  const pagePayload = isObj(payload.data) ? payload.data : payload;
  let rows = null;
  for (const key of ["content", "items", "result"]) {
    if (Array.isArray(pagePayload[key])) { rows = pagePayload[key]; break; }
  }
  if (!rows) return null;
  const reportedPage = pagePayload.number === undefined ? expectedPage : Number(pagePayload.number);
  if (!Number.isSafeInteger(reportedPage) || reportedPage !== expectedPage) return null;
  const totalPages = Number(pagePayload.totalPages);
  const hasTotalPages = Number.isSafeInteger(totalPages) && totalPages >= 0;
  const hasLast = typeof pagePayload.last === "boolean";
  if (!hasTotalPages && !hasLast) return null;
  const last = hasLast ? pagePayload.last : expectedPage + 1 >= totalPages;
  if (hasLast && hasTotalPages && last !== (totalPages === 0 || expectedPage + 1 >= totalPages)) return null;
  return { rows, last };
};
const bookingId = (row) => toStr(row?.id || row?.bookingId || row?.uuid);
const exerciseId = (row) => toStr(
  row?.exercise?.id || row?.exerciseId || row?.vivaExerciseId || row?.exercise?.uuid,
);
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const normalizeDate = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/.exec(text);
  return match ? match[1] : null;
};
const normalizeTime = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const isoMatch = /T(\d{2}:\d{2})(?::\d{2})?/.exec(text);
  if (isoMatch) return isoMatch[1];
  const plainMatch = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(text);
  return plainMatch ? plainMatch[1] : null;
};
const providerTuple = (row) => ({
  studioId: normalizeId(
    row?.studio?.id || row?.studioId || row?.station?.id || row?.stationId
      || row?.exercise?.studio?.id || row?.exercise?.studioId,
  ),
  roomId: normalizeId(
    row?.room?.id || row?.roomId || row?.court?.id || row?.courtId
      || row?.exercise?.room?.id || row?.exercise?.roomId,
  ),
  date: normalizeDate(
    row?.date || row?.exerciseDate || row?.timeFrom || row?.startTime
      || row?.booking?.date || row?.exercise?.date || row?.exercise?.timeFrom,
  ),
  timeFrom: normalizeTime(
    row?.timeFrom || row?.startTime || row?.booking?.timeFrom || row?.exercise?.timeFrom,
  ),
  timeTo: normalizeTime(
    row?.timeTo || row?.endTime || row?.booking?.timeTo || row?.exercise?.timeTo,
  ),
});
const requestedTuple = (payload) => {
  const booking = isObj(payload?.booking) ? payload.booking : {};
  return {
    studioId: normalizeId(booking.studioId || payload?.studioId),
    roomId: normalizeId(booking.roomId || payload?.roomId),
    date: normalizeDate(booking.date || payload?.fromDate || booking.timeFromIso || payload?.timeFromIso),
    timeFrom: normalizeTime(booking.timeFrom || payload?.fromTime || booking.timeFromIso || payload?.timeFromIso),
    timeTo: normalizeTime(booking.timeTo || payload?.toTime || booking.timeToIso || payload?.timeToIso),
  };
};
const tupleComplete = (value) => Boolean(
  value?.studioId && value?.roomId && value?.date && value?.timeFrom && value?.timeTo,
);
const tupleEqual = (left, right) => tupleComplete(left) && tupleComplete(right)
  && left.studioId === right.studioId
  && left.roomId === right.roomId
  && left.date === right.date
  && left.timeFrom === right.timeFrom
  && left.timeTo === right.timeTo;
const isCancelled = (row) => {
  const status = String(row?.bookingStatus || row?.status || row?.state || "").toUpperCase();
  return row?.isCancelled === true || row?.cancelled === true || row?.canceled === true
    || Boolean(toStr(row?.cancellationDate || row?.cancelledAt))
    || status.includes("CANCEL") || status.includes("ARCHIVE");
};
const statusPaid = (value) => {
  const token = String(value || "").trim().toUpperCase();
  if (!token) return null;
  if (["PENDING", "CREATED", "WAIT", "UNPAID", "NOT_PAID", "FAILED", "DECLINED", "CANCEL", "EXPIRED", "ERROR", "REFUND", "CHARGEBACK"]
    .some((marker) => token.includes(marker))) return false;
  if (["PAID", "PAYED", "SUCCESS", "SUCCEEDED", "CAPTURED", "COMPLETED", "DONE", "CONFIRMED", "APPROVED"]
    .some((marker) => token.includes(marker))) return true;
  return null;
};
const numericCostMinor = (row) => {
  const rawCost = row?.cost;
  const hasNumericCost = typeof rawCost === "number"
    ? Number.isFinite(rawCost)
    : typeof rawCost === "string" && rawCost.trim() !== "" && /^-?\d+(?:[.,]\d+)?$/.test(rawCost.trim());
  const value = hasNumericCost ? Number(String(rawCost).replace(",", ".")) : null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
};
const currencyCode = (row) => toStr(
  row?.currency || row?.currencyCode || row?.paymentCurrency || row?.transactionStatus?.currency,
)?.toUpperCase() || "RUB";
const settlementKind = (row) => {
  const card = statusPaid(row?.transactionStatus?.cardPaymentStatus?.status);
  const original = statusPaid(row?.transactionStatus?.cardPaymentStatus?.originalStatus);
  const transaction = statusPaid(row?.transactionStatus?.transactionStatus);
  if (card === false || original === false || transaction === false) return null;
  const paymentType = String(row?.paymentType || "").trim().toUpperCase();
  if (paymentType === "SUBSCRIPTION") return "SUBSCRIPTION";
  if (card === true || original === true || transaction === true) return "ONE_TIME_PAID";
  const cost = numericCostMinor(row);
  return Number.isFinite(cost) && cost === 0 ? "ZERO_DUE" : null;
};

const ctx = isObj(msg._futureGameAuth) ? msg._futureGameAuth : null;
if (!ctx?.step || !ctx?.authHeader || !ctx?.exerciseId || !ctx?.actorBookingId || !isObj(ctx.requestPayload)) {
  return fail(ctx, 500, "GAME_AUTH_CONTEXT_MISSING", "Не удалось проверить бронь Viva");
}
if (msg.error) return fail(ctx, 503, "GAME_AUTH_PROVIDER_UNAVAILABLE", "Viva временно недоступна");
const statusCode = Number(msg.statusCode) || 0;
if (statusCode === 401 || statusCode === 403) {
  return fail(ctx, 401, "GAME_AUTH_TOKEN_INVALID", "Сессия истекла. Войдите снова");
}
if (statusCode < 200 || statusCode >= 300) {
  return fail(ctx, 503, "GAME_AUTH_PROVIDER_UNAVAILABLE", "Viva временно недоступна");
}

if (ctx.step === "profile") {
  const rawProfile = isObj(msg.payload?.data) ? msg.payload.data : msg.payload;
  if (!isObj(rawProfile)) return fail(ctx, 503, "GAME_AUTH_PROFILE_UNAVAILABLE", "Не удалось проверить профиль клиента");
  const actorClientId = toStr(rawProfile.id || rawProfile.clientId || rawProfile.uuid || rawProfile.userId);
  const actorPhoneNorm = normalizePhone(
    rawProfile.phoneNorm || rawProfile.phone || rawProfile.phoneNumber || rawProfile.mobile,
  );
  const organizer = isObj(ctx.requestPayload.organizer) ? ctx.requestPayload.organizer : {};
  const requestedClientId = toStr(organizer.id || organizer.clientId || ctx.requestPayload.clientId);
  const requestedPhoneNorm = normalizePhone(
    organizer.phone || organizer.phoneNumber || organizer.mobile || ctx.requestPayload.clientPhone,
  );
  if ((!actorClientId && !actorPhoneNorm) || (!requestedClientId && !requestedPhoneNorm)) {
    return fail(ctx, 403, "GAME_AUTH_IDENTITY_MISSING", "Не удалось связать профиль с организатором игры");
  }
  if (
    (requestedClientId && actorClientId !== requestedClientId)
    || (requestedPhoneNorm && actorPhoneNorm !== requestedPhoneNorm)
  ) return fail(ctx, 403, "GAME_AUTH_ORGANIZER_MISMATCH", "Организатор игры не совпадает с текущим профилем");
  ctx.step = "bookings";
  ctx.actorClientId = actorClientId;
  ctx.actorPhoneNorm = actorPhoneNorm;
  ctx.bookingsPage = 0;
  ctx.matchedRows = [];
  msg._futureGameAuth = ctx;
  msg.method = "GET";
  msg.url = "https://api.vivacrm.ru/end-user/api/v2/iSkq6G/bookings?page=0&size=200";
  msg.headers = { Authorization: ctx.authHeader, Accept: "application/json" };
  msg.payload = undefined;
  msg.requestTimeout = 10000;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  delete msg.statusCode;
  return [msg, null, null, null];
}

if (ctx.step !== "bookings") return fail(ctx, 500, "GAME_AUTH_STEP_INVALID", "Не удалось проверить бронь Viva");
const currentPage = Number(ctx.bookingsPage);
if (!Number.isSafeInteger(currentPage) || currentPage < 0 || currentPage >= 10) {
  return fail(ctx, 503, "GAME_AUTH_BOOKINGS_TRUNCATED", "Не удалось полностью проверить брони клиента");
}
const page = bookingPage(msg.payload, currentPage);
if (!page) return fail(ctx, 503, "GAME_AUTH_BOOKINGS_UNAVAILABLE", "Не удалось проверить брони клиента");
const pageMatches = page.rows.filter((row) => (
  isObj(row) && !isCancelled(row) && exerciseId(row) === ctx.exerciseId
  && bookingId(row) === ctx.actorBookingId
));
ctx.matchedRows = [...asArray(ctx.matchedRows), ...pageMatches];
if (!page.last) {
  if (currentPage + 1 >= 10) {
    return fail(ctx, 503, "GAME_AUTH_BOOKINGS_TRUNCATED", "Не удалось полностью проверить брони клиента");
  }
  ctx.bookingsPage = currentPage + 1;
  msg._futureGameAuth = ctx;
  msg.method = "GET";
  msg.url = `https://api.vivacrm.ru/end-user/api/v2/iSkq6G/bookings?page=${ctx.bookingsPage}&size=200`;
  msg.headers = { Authorization: ctx.authHeader, Accept: "application/json" };
  msg.payload = undefined;
  msg.requestTimeout = 10000;
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  delete msg.statusCode;
  return [msg, null, null, null];
}
const activeForExercise = asArray(ctx.matchedRows);
if (activeForExercise.length !== 1) {
  return fail(ctx, 409, "GAME_AUTH_BOOKING_MISMATCH", "Бронь организатора не принадлежит текущему профилю");
}
const matched = activeForExercise;
const authoritativeBookingIds = Array.from(new Set(matched.map(bookingId).filter(Boolean)));
const expectedTuple = requestedTuple(ctx.requestPayload);
if (!tupleComplete(expectedTuple)) {
  return fail(ctx, 409, "GAME_AUTH_REQUEST_SLOT_INCOMPLETE", "Не удалось однозначно определить слот создаваемой игры");
}
const authoritativeTuples = matched.map(providerTuple);
if (authoritativeTuples.some((tuple) => !tupleEqual(tuple, expectedTuple))) {
  return fail(ctx, 409, "GAME_AUTH_BOOKING_SLOT_MISMATCH", "Слот игры не совпадает с бронью Viva");
}
const settlementKinds = Array.from(new Set(matched.map(settlementKind).filter(Boolean)));
const settled = matched.length > 0 && settlementKinds.length === 1 && matched.every((row) => settlementKind(row));
const authoritativeSettlementKind = settled ? settlementKinds[0] : null;
const providerCostsMinor = Array.from(new Set(
  matched.map(numericCostMinor).filter((value) => Number.isFinite(value)),
));
const providerCostMinor = providerCostsMinor.length === 1 ? providerCostsMinor[0] : null;
const providerCost = Number.isFinite(providerCostMinor) ? providerCostMinor / 100 : null;
const providerCurrencies = Array.from(new Set(matched.map(currencyCode)));
const providerCurrency = providerCurrencies.length === 1 ? providerCurrencies[0] : null;
const requestPayment = isObj(ctx.requestPayload.payment) ? ctx.requestPayload.payment : {};
const requestPaymentRefs = Array.from(new Set(asArray(ctx.requestPaymentRefs).map(toStr).filter(Boolean)));
const requestAmount = Number(requestPayment.amount);
const requestAmountMinor = Number.isSafeInteger(requestAmount) && requestAmount >= 0
  && Number.isSafeInteger(requestAmount * 100)
  ? requestAmount * 100
  : null;
const directCreateAuthorized = ["ZERO_DUE", "SUBSCRIPTION"].includes(authoritativeSettlementKind)
  || (authoritativeSettlementKind === "ONE_TIME_PAID" && requestPaymentRefs.length === 0);
if (
  ctx.mode === "create"
  && (
    !directCreateAuthorized
    || providerCurrency !== "RUB"
    || !Number.isSafeInteger(providerCostMinor)
    || !Number.isSafeInteger(requestAmountMinor)
    || requestAmountMinor !== providerCostMinor
  )
) {
  return fail(
    ctx,
    409,
    authoritativeSettlementKind === "ONE_TIME_PAID"
      ? (requestPaymentRefs.length ? "GAME_AUTH_TRANSACTION_CONFIRM_REQUIRED" : "GAME_AUTH_BOOKING_PAYMENT_MISMATCH")
      : "GAME_AUTH_BOOKING_NOT_SETTLED",
    authoritativeSettlementKind === "ONE_TIME_PAID"
      ? (requestPaymentRefs.length
        ? "Платёж должен быть подтверждён через серверную проверку транзакции Viva"
        : "Сумма оплаченной брони Viva не совпадает с суммой игры")
      : "Бронь Viva ещё не оплачена",
  );
}
msg._futureGameAuth = {
  verified: true,
  mode: ctx.mode,
  tenantKey: ctx.tenantKey,
  actorClientId: ctx.actorClientId || null,
  actorPhoneNorm: ctx.actorPhoneNorm || null,
  providerEvidence: {
    source: "viva_end_user_bookings",
    exerciseId: ctx.exerciseId,
    actorBookingId: ctx.actorBookingId,
    bookingIds: authoritativeBookingIds,
    ...expectedTuple,
    settled,
    settlementKind: authoritativeSettlementKind,
    providerCost,
    providerCostMinor,
    providerCurrency,
    checkedAt: new Date().toISOString(),
  },
};
msg.payload = ctx.requestPayload;
delete msg.statusCode;
delete msg.url;
delete msg.method;
delete msg.headers;
delete msg.requestTimeout;
delete msg.followRedirects;
delete msg.maxRedirects;
return [null, msg, null, null];
