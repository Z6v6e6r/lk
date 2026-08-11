const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (!ctx) {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "RETRY_REQUIRED", message: "Operation context missing" };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 90_000).toISOString();
const update = {
  $set: {
    state: "VIVA_CONFIRMED",
    vivaConfirmedAt: ctx.vivaVerifiedAt || nowIso,
    vivaVerification: ctx.vivaVerification || "active_absent_history_cancelled",
    bookingIds: Array.isArray(ctx.initialBookingIds) ? ctx.initialBookingIds : [],
    refundMessage: ctx.refundMessage || null,
    successMessage: ctx.refundMessage || ctx.successMessage || "Вы вышли из игры",
    localApplyClaimToken: ctx.claimToken || null,
    localApplyLeaseUntil: leaseUntilIso,
    lastAttemptAt: nowIso,
    updatedAt: nowIso,
  },
  $inc: { localApplyAttempts: 1 },
};
if (ctx.operationState !== "VIVA_CONFIRMED") {
  update.$push = { transitions: { state: "VIVA_CONFIRMED", at: nowIso } };
}
ctx.operationState = "VIVA_CONFIRMED";
msg._splitLeaveCtx = ctx;
msg.payload = [{
  _id: ctx.operationKey,
  state: "STARTED",
  claimToken: ctx.claimToken,
}, update, {}];
return [msg, null];
