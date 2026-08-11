const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
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
