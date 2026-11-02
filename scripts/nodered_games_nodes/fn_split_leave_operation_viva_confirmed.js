const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (!ctx) {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "RETRY_REQUIRED", message: "Operation context missing" };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 90_000).toISOString();
const previousState = String(ctx.operationState || "STARTED").toUpperCase();
if (previousState === "MONETARY_DISPATCH_STARTED" && (!ctx.monetarySelfLeave || !ctx.monetaryStoredService
  || ctx.monetarySelfLeave.original.bookingIds.some(id => !ctx.monetarySelfLeave.readbacks.some(r => r.bookingId === id)))) {
  msg.statusCode = 202; msg.payload = { ok: true, state: "RETRY_REQUIRED" }; return [null, msg];
}
const update = {
  $set: {
    state: "VIVA_CONFIRMED",
    vivaConfirmedAt: ctx.vivaVerifiedAt || nowIso,
    vivaVerification: ctx.vivaVerification || "active_absent_history_cancelled",
    bookingIds: Array.isArray(ctx.initialBookingIds) ? ctx.initialBookingIds : [],
    refundMessage: ctx.refundMessage || null,
    successMessage: ctx.refundMessage || ctx.successMessage || "Вы вышли из игры",
    clientSubscriptionId: ctx.clientSubscriptionId || null,
    subscriptionVisitCount: Number.isSafeInteger(ctx.subscriptionVisitCount)
      ? ctx.subscriptionVisitCount
      : null,
    subscriptionReturnChecks: Array.isArray(ctx.subscriptionReturnChecks)
      ? ctx.subscriptionReturnChecks
      : [],
    subscriptionReturnState: ctx.subscriptionReturnState || null,
    subscriptionReturnReason: ctx.subscriptionReturnReason || null,
    subscriptionReturnVerifiedAt: ctx.subscriptionReturnVerifiedAt || null,
    localApplyClaimToken: ctx.claimToken || null,
    localApplyLeaseUntil: leaseUntilIso,
    lastAttemptAt: nowIso,
    updatedAt: nowIso,
  },
  $inc: { localApplyAttempts: 1 },
};
if (previousState !== "VIVA_CONFIRMED") {
  update.$push = { transitions: { state: "VIVA_CONFIRMED", at: nowIso } };
}
ctx.operationState = "VIVA_CONFIRMED";
msg._splitLeaveCtx = ctx;
msg.payload = [{
  _id: ctx.operationKey,
  state: previousState === "MONETARY_DISPATCH_STARTED" ? "MONETARY_DISPATCH_STARTED"
    : previousState === "RETURN_PENDING" ? "RETURN_PENDING"
    : (ctx.localReconciliation && previousState === "VIVA_CONFIRMED" ? "VIVA_CONFIRMED" : "STARTED"),
  ...(previousState === "MONETARY_DISPATCH_STARTED" ? {
    tenantKey: "iSkq6G", mode: "SELF", actorClientId: ctx.actorClientId, targetClientId: ctx.actorClientId,
    gameId: ctx.gameId, exerciseId: ctx.exerciseId, membershipVersion: ctx.membershipVersion,
    bookingIds: ctx.monetarySelfLeave.original.bookingIds, monetarySelfLeave: ctx.monetarySelfLeave,
    managedSelfLeaveOwner: { $exists: false },
    subscriptionReturnChecks: ctx.monetaryStoredService.checks,
    clientSubscriptionId: ctx.monetaryStoredService.clientSubscriptionId,
    subscriptionVisitCount: ctx.monetaryStoredService.subscriptionVisitCount,
    subscriptionReturnState: ctx.monetaryStoredService.subscriptionReturnState,
  } : {}),
  ...(previousState === "RETURN_PENDING" ? {}
    : (ctx.localReconciliation && previousState === "VIVA_CONFIRMED"
      ? { localApplyClaimToken: ctx.claimToken } : { claimToken: ctx.claimToken })),
}, update, {}];
return [msg, null];
