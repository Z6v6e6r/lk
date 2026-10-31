// Only a verified managed SELF-return context enters this bridge. No token,
// signature or arbitrary request body is written to either operation ledger.
const ctx = msg._splitLeaveCtx;
const pending = reason => {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "RETRY_REQUIRED", operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null, reason };
  return [null, null, null, msg];
};
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
let base;
let ownerTenant;
try { base = env.get("LK1_BOOKED_OPERATION_OWNER_BASE_URL"); ownerTenant = env.get("LK1_BOOKED_OPERATION_OWNER_TENANT_KEY"); } catch (_) { /* fail closed */ }
if (!isObject(ctx) || !isObject(ctx.managedSelfLeave)
  || ownerTenant !== "iSkq6G" || typeof base !== "string" || !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}$/.test(base)
  || !/^Bearer \S+$/.test(ctx.actorAuthHeader || "")) return pending("managed_self_leave_owner_unavailable");
const url = `${base}/lk/subscription-bookings`;
const send = (step, method, body, headers) => {
  ctx.managedSelfLeaveStep = step;
  msg.method = method; msg.url = url; msg.payload = body; msg.headers = headers;
  msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  delete msg.error; delete msg.statusCode; delete msg.responseUrl;
  return [msg, null, null, null];
};
if (ctx.managedSelfLeaveStep === "start") return send("probe", "GET", undefined,
  { "X-Booked-Operation-Owner-Contract": "3", Accept: "application/json" });
if (msg.error || msg.statusCode !== 200 || msg.responseUrl !== url) return pending("managed_self_leave_owner_pending");
const body = msg.payload;
if (ctx.managedSelfLeaveStep === "probe") {
  if (!isObject(body) || Object.keys(body).sort().join(",") !== "contractVersion,owner,policy"
    || body.contractVersion !== 3 || body.owner !== "LK1_SUBSCRIPTION_BOOKING_OWNER"
    || body.policy !== "MANAGED_SELF_LEAVE_V1") return pending("managed_self_leave_owner_incompatible");
  return send("release", "POST", { action: "release", operationId: ctx.operationId,
    bookingId: ctx.managedSelfLeave.bookingId, managedSelfLeave: ctx.managedSelfLeave },
  { Authorization: ctx.actorAuthHeader, "Idempotency-Key": ctx.operationId,
    "Content-Type": "application/json", Accept: "application/json" });
}
if (ctx.managedSelfLeaveStep !== "release" || !isObject(body)
  || Object.keys(body).sort().join(",") !== "bookingId,details,ok,operationId,state"
  || body.ok !== true || body.state !== "RELEASED" || body.operationId !== ctx.operationId
  || body.bookingId !== ctx.managedSelfLeave.bookingId || !isObject(body.details)
  || Object.keys(body.details).sort().join(",") !== "compensation,managedSelfLeave,operationFound"
  || body.details.operationFound !== true) return pending("managed_self_leave_receipt_unverified");
const { leaveClaimToken, ...binding } = ctx.managedSelfLeave;
const returned = body.details.managedSelfLeave;
const receipt = body.details.compensation;
if (!isObject(returned) || Object.keys(returned).sort().join(",") !== Object.keys(binding).sort().join(",")
  || Object.keys(binding).some(key => returned[key] !== binding[key])
  || !isObject(receipt) || Object.keys(receipt).sort().join(",") !== "compensationState,operationId,operationState,providerBookingId,releaseReason,schemaVersion,subscriptionInstanceId"
  || receipt.schemaVersion !== 1 || receipt.operationId !== binding.entitlementOperationId
  || receipt.subscriptionInstanceId !== binding.subscriptionInstanceId || receipt.providerBookingId !== binding.bookingId
  || receipt.operationState !== "COMPENSATED" || receipt.compensationState !== "APPLIED"
  || receipt.releaseReason !== "BOOKING_CANCELLED") return pending("managed_self_leave_receipt_unverified");
ctx.dailyLimitReleaseOutcome = "RELEASED";
ctx.dailyLimitReleasedAt = new Date().toISOString();
msg.payload = undefined;
delete msg.statusCode;
return ctx.localAlreadyApplied ? [null, null, msg, null] : [null, msg, null, null];
