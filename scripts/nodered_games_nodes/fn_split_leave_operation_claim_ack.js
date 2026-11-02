const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (ctx?.monetaryAction) {
  if (msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1
    || msg.payload?.modifiedCount !== 1 || !Number.isFinite(Date.parse(ctx.monetaryLeaseUntil))
    || Date.parse(ctx.monetaryLeaseUntil) <= Date.now()) {
    msg.statusCode = 202; msg.payload = { ok: true, state: "RETRY_REQUIRED", operationId: ctx.operationId };
    delete msg._splitLeaveCtx;
    return [null, msg];
  }
  const action = ctx.monetaryAction;
  ctx.monetarySelfLeave = ctx.monetaryNext;
  ctx.monetaryStoredService = ctx.monetaryNextService;
  if (action.refundMethod === "SERVICE") {
    ctx.subscriptionReturnChecks = ctx.monetaryNextService.checks;
    ctx.clientSubscriptionId = ctx.monetaryNextService.clientSubscriptionId;
    ctx.subscriptionVisitCount = ctx.monetaryNextService.subscriptionVisitCount;
    ctx.subscriptionReturnState = "RETURN_PENDING";
    ctx.subscriptionReturnReason = "monetary_service_readback_required";
  }
  delete ctx.monetaryNextService;
  delete ctx.monetaryNext; delete ctx.monetaryAction;
  ctx.operationState = "MONETARY_DISPATCH_STARTED";
  if (action.kind === "dispatch") {
    ctx.monetaryDispatchPermit = { bookingId: action.bookingId, refundMethod: action.refundMethod };
    ctx.step = "monetary_dispatch_ack";
  } else if (action.kind === "readback") ctx.step = "monetary_readback_ack";
  else ctx.step = "start_monetary_verify";
  delete msg.error; delete msg.statusCode; msg.payload = undefined;
  return [msg, null];
}
if (ctx?.monetarySelfLeave && (msg.error || msg.payload?.acknowledged !== true
  || msg.payload?.matchedCount !== 1 || msg.payload?.modifiedCount !== 1)) {
  msg.statusCode = 202; msg.payload = { ok: true, state: "RETRY_REQUIRED" };
  delete msg._splitLeaveCtx; return [null, msg];
}
if (ctx?.managedSelfLeaveReclaim) {
  if (msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1
    || msg.payload?.modifiedCount !== 1) {
    msg.statusCode = 202; msg.payload = { ok: true, state: "IN_PROGRESS", operationId: ctx.operationId };
    return [null, msg];
  }
  // The new claim owns only readback/compensation. Never enter cancellation again.
  ctx.step = "local_apply";
  msg.payload = undefined;
  return [null, null, msg];
}
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
if (!ctx || msg.error || matched < 1) {
  msg.statusCode = 202;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = {
    ok: true,
    state: "IN_PROGRESS",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Операцию уже забрал другой исполнитель",
  };
  delete msg._splitLeaveCtx;
  return [null, msg];
}
ctx.operationState = "STARTED";
ctx.preCancelVerification = true;
ctx.step = "start_verify_active";
msg._splitLeaveCtx = ctx;
msg.payload = undefined;
return [msg, null];
