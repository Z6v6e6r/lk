const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const header = (name) => {
  const headers = isObj(msg.req?.headers) ? msg.req.headers : {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? toStr(headers[key]) : null;
};
const safeEqual = (left, right) => {
  const a = String(left || "");
  const b = String(right || "");
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};
const digest = (value) => {
  let left = 2166136261;
  let right = 2246822507;
  for (const char of String(value || "")) {
    const code = char.charCodeAt(0);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ code, 3266489909);
  }
  return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
};
const respond = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { ok: false, code, message };
  delete msg._staffLeaveCtx;
  return [null, msg];
};

const configuredToken = toStr(env.get("CUP_LK_PLAYER_LEAVE_TOKEN"));
const authorization = header("authorization");
const suppliedToken = authorization && /^Bearer\s+/i.test(authorization)
  ? authorization.replace(/^Bearer\s+/i, "").trim()
  : null;
if (!configuredToken) {
  return respond(503, "SERVICE_UNAVAILABLE", "Service authorization is not configured");
}
if (!suppliedToken || !safeEqual(configuredToken, suppliedToken)) {
  return respond(401, "UNAUTHORIZED", "Service authorization failed");
}

const gameId = toStr(msg.req?.params?.gameId);
const idempotencyKey = header("idempotency-key");
const body = isObj(msg.payload) ? msg.payload : {};
const target = isObj(body.target) ? body.target : {};
const staffActor = isObj(body.staffActor) ? body.staffActor : {};
const targetClientId = toStr(target.clientId);
const targetBookingId = toStr(target.bookingId);
const expectedMembershipVersion = toStr(body.expectedMembershipVersion);
const visitAction = toStr(body.visitAction)?.toUpperCase() || null;
const staffActorId = toStr(staffActor.id);
if (!gameId || !/^[A-Za-z0-9._:-]{3,160}$/.test(gameId)) {
  return respond(400, "INVALID_REQUEST", "gameId is required");
}
if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
  return respond(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key is required");
}
if (!targetClientId || !targetBookingId || !expectedMembershipVersion || !staffActorId) {
  return respond(400, "INVALID_REQUEST", "Exact target, membership version and staff actor are required");
}
if (!new Set(["RETURN_VISIT", "NO_RETURN"]).has(visitAction)) {
  return respond(400, "INVALID_VISIT_ACTION", "visitAction is invalid");
}
if (toStr(body.reason)?.toUpperCase() !== "CUP_STAFF_REMOVAL") {
  return respond(400, "INVALID_REASON", "reason must be CUP_STAFF_REMOVAL");
}

msg._staffLeaveCtx = {
  gameId,
  targetClientId,
  targetBookingId,
  expectedMembershipVersion,
  visitAction,
  requestedRefundMethod: visitAction === "RETURN_VISIT" ? "SERVICE" : "NONE",
  staffActorId,
  idempotencyDigest: digest(idempotencyKey),
};
msg.payload = { id: gameId, archived: { $ne: true } };
delete msg.headers;
return [msg, null];
