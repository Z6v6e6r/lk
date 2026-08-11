const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const actorClientId = String(ctx?.targetClientId || "").trim();
const exerciseId = String(ctx?.exerciseId || "").trim();

if (!ctx || !actorClientId || !exerciseId) {
  if (ctx) ctx.dailyLimitReleaseOutcome = "NOT_APPLICABLE";
  msg._splitLeaveCtx = ctx;
  msg.payload = [];
  return [null, msg, null];
}

msg.payload = {
  tenantKey: "iSkq6G",
  actorClientId,
  exerciseId,
};
return [msg, null, null];
