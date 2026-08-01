const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (!ctx || !ctx.operationKey || !ctx.claimToken || ctx.operationState !== "STARTED") {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "IN_PROGRESS", message: "Operation claim unavailable" };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 5 * 60_000).toISOString();
const staleLease = ctx.previousClaimLeaseUntil
  ? { $lte: nowIso }
  : { $in: [null, ""] };
msg.payload = [
  {
    _id: ctx.operationKey,
    state: "STARTED",
    claimToken: ctx.previousClaimToken || { $in: [null, ""] },
    claimLeaseUntil: staleLease,
  },
  {
    $set: {
      claimToken: ctx.claimToken,
      claimLeaseUntil: leaseUntilIso,
      lastAttemptAt: nowIso,
      updatedAt: nowIso,
    },
  },
  {},
];
return [msg, null];
