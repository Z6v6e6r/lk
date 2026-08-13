const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => value === null || value === undefined ? null : (String(value).trim() || null);
const header = (name) => {
  const headers = isObj(msg.req?.headers) ? msg.req.headers : {};
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? toStr(headers[key]) : null;
};
const safeEqual = (left, right) => {
  const a = String(left || "");
  const b = String(right || "");
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    mismatch |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};
const respond = (statusCode, code, message) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { ok: false, code, message };
  delete msg._staffLeaveStatusCtx;
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
const operationId = toStr(msg.req?.params?.operationId);
if (!gameId || !operationId || !/^staff-leave:[A-Za-z0-9._:-]{8,480}$/.test(operationId)) {
  return respond(400, "INVALID_REQUEST", "Exact game and operation are required");
}
if (!operationId.startsWith(`staff-leave:${gameId}:`)) {
  return respond(409, "OPERATION_GAME_MISMATCH", "Operation does not belong to the game");
}
msg._staffLeaveStatusCtx = { gameId, operationId };
msg.payload = { _id: `${gameId}:${operationId}`, gameId, operationId };
delete msg.headers;
return [msg, null];
