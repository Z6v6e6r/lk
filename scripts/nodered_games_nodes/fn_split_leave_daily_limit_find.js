const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const actorClientId = String(ctx?.targetClientId || "").trim();
const exerciseId = String(ctx?.exerciseId || "").trim();

if (!ctx || ctx.localReconciliation || !actorClientId || !exerciseId) {
  if (ctx) ctx.dailyLimitReleaseOutcome = "NOT_APPLICABLE";
  msg._splitLeaveCtx = ctx;
  msg.payload = [];
  return [null, msg, null];
}

msg.payload = {
  tenantKey: "iSkq6G",
  actorClientId,
  exerciseId,
  ...(Array.isArray(ctx.initialBookingIds) && ctx.initialBookingIds.length > 0
    ? { $or: [{ bookingId: { $in: ctx.initialBookingIds } }, { upstreamBookingId: { $in: ctx.initialBookingIds } }] }
    : {}),
};
return [msg, null, null];
