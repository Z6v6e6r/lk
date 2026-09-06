const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const fail = (statusCode, code, error) => {
  const response = Object.assign({}, msg, {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    payload: { ok: false, code, error },
  });
  delete response._futureGameAuth;
  return [null, response, response];
};
const parseIds = (value) => {
  if (Array.isArray(value)) return value.map(toStr).filter(Boolean);
  if (typeof value === "string") return value.split(",").map(toStr).filter(Boolean);
  return [];
};
const unique = (values) => Array.from(new Set(values.map(toStr).filter(Boolean)));

const body = isObj(msg.payload) ? msg.payload : {};
const reqPath = toStr(msg.req?.path || msg.req?.originalUrl || msg.req?.url)?.toLowerCase() || "";
const explicitAction = toStr(body.action || body._action || msg._action || msg.action)?.toLowerCase();
let mode = reqPath.includes("/draft") ? "draft" : "create";
if (["create", "draft"].includes(explicitAction)) mode = explicitAction;
if (reqPath.includes("/confirm") || explicitAction === "confirm") {
  return fail(500, "GAME_AUTH_ROUTE_INVALID", "Payment confirmation must use its verified server route");
}
const requestHeaders = isObj(msg.req?.headers) ? msg.req.headers : {};
const authHeader = toStr(requestHeaders.authorization || requestHeaders.Authorization);
if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
  return fail(401, "GAME_AUTH_TOKEN_REQUIRED", "Необходимо войти в личный кабинет");
}
const booking = isObj(body.booking) ? body.booking : {};
const payment = isObj(body.payment) ? body.payment : {};
const metadata = isObj(body.metadata) ? body.metadata : {};
const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
const query = isObj(msg.req?.query) ? msg.req.query : {};
const requestPaymentRefs = unique([
  body.paymentRef,
  payment.paymentRef,
  metadata.paymentRef,
  splitPayment.paymentRef,
  query.paymentRef,
  query.phPaymentRef,
  ...(Array.isArray(splitPayment.payments)
    ? splitPayment.payments.map((item) => isObj(item) ? item.paymentRef : null)
    : []),
]);
const exerciseId = toStr(
  booking.vivaExerciseId
  || booking.exerciseId
  || metadata.vivaExerciseId
  || metadata.exerciseId
  || splitPayment.vivaExerciseId
  || splitPayment.exerciseId,
);
const associatedBookingIds = unique([
  ...parseIds(body.bookingIds),
  ...parseIds(booking.bookingIds),
  ...parseIds(payment.bookingIds),
  ...parseIds(metadata.bookingIds),
  ...parseIds(query.bookingIds),
  body.bookingId,
  booking.bookingId,
  payment.bookingId,
  splitPayment.organizerBookingId,
]);
const actorBookingId = toStr(
  body.organizerBookingId
  || metadata.bookingId
  || splitPayment.organizerBookingId
  || body.bookingId
  || booking.bookingId
  || payment.bookingId
  || associatedBookingIds[0],
);
if (
  !exerciseId
  || !actorBookingId
  || exerciseId.length > 180
  || actorBookingId.length > 180
  || associatedBookingIds.some((id) => id.length > 180)
  || requestPaymentRefs.some((id) => id.length > 180)
) {
  return fail(409, "GAME_BOOKING_IDENTITY_REQUIRED", "Не удалось определить бронь Viva для игры");
}

msg._futureGameAuth = {
  step: "profile",
  mode,
  tenantKey: "iSkq6G",
  authHeader,
  requestPayload: body,
  exerciseId,
  actorBookingId,
  associatedBookingIds,
  requestPaymentRefs,
  bookingsPage: 0,
  matchedRows: [],
};
msg.method = "GET";
msg.url = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile";
msg.headers = { Authorization: authHeader, Accept: "application/json" };
msg.payload = undefined;
msg.requestTimeout = 10000;
msg.followRedirects = false;
msg.maxRedirects = 0;
return [msg, null, null];
