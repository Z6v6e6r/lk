const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (ctx?.managedSelfLeaveReclaim) {
  const claim = ctx.managedSelfLeaveReclaim;
  const now = new Date().toISOString();
  if (!ctx.claimToken || ctx.claimToken === claim.previousClaimToken || ctx.mode !== "SELF"
    || ctx.actorClientId !== ctx.targetClientId || ctx.subscriptionReturnState !== "RETURN_VERIFIED"
    || !["VIVA_CONFIRMED", "LK_APPLIED"].includes(claim.state)
    || !Number.isFinite(Date.parse(claim.previousLeaseUntil)) || Date.parse(claim.previousLeaseUntil) > Date.now()) {
    msg.statusCode = 202; msg.payload = { ok: true, state: "IN_PROGRESS" }; return [null, msg];
  }
  msg.payload = [{ _id: ctx.operationKey, operationId: ctx.operationId, tenantKey: "iSkq6G", mode: "SELF",
    actorClientId: ctx.actorClientId, targetClientId: ctx.actorClientId, gameId: ctx.gameId, exerciseId: ctx.exerciseId,
    state: claim.state, localApplyClaimToken: claim.previousClaimToken,
    localApplyLeaseUntil: claim.previousLeaseUntil, membershipVersion: claim.membershipVersion,
    bookingIds: [claim.bookingId], clientSubscriptionId: claim.clientSubscriptionId,
    subscriptionReturnState: "RETURN_VERIFIED", vivaVerification: "active_absent_history_cancelled" },
  { $set: { localApplyClaimToken: ctx.claimToken, localApplyLeaseUntil: new Date(Date.now() + 90_000).toISOString(),
    lastAttemptAt: now, updatedAt: now }, $inc: { localApplyAttempts: 1 } }, {}];
  return [msg, null];
}
if (!ctx || !ctx.operationKey || !ctx.claimToken || ctx.operationState !== "STARTED") {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "IN_PROGRESS", message: "Operation claim unavailable" };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 90_000).toISOString();
const staleLease = ctx.previousClaimLeaseUntil
  ? { $lte: nowIso }
  : { $in: [null, ""] };
const claimFilter = {
  _id: ctx.operationKey,
  state: "STARTED",
  claimToken: ctx.previousClaimToken || { $in: [null, ""] },
};
if (ctx.foregroundReclaim !== true) claimFilter.claimLeaseUntil = staleLease;
msg.payload = [
  claimFilter,
  {
    $set: {
      claimToken: ctx.claimToken,
      claimLeaseUntil: leaseUntilIso,
      lastAttemptAt: nowIso,
      updatedAt: nowIso,
    },
    ...(ctx.foregroundReclaim === true ? { $inc: { foregroundRecoveryAttempts: 1 } } : {}),
  },
  {},
];
return [msg, null];
