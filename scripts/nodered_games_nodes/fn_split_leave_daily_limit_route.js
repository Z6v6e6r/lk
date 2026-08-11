const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const retry = (ctx, reason) => {
  msg._splitLeaveCtx = ctx;
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Viva подтверждена; освобождаем дневной лимит записи",
    reason,
  };
  return [null, null, null, msg];
};
const continueApply = (ctx) => {
  msg._splitLeaveCtx = ctx;
  msg.payload = undefined;
  delete msg.statusCode;
  if (ctx.supersededByRejoin === true || ctx.localAlreadyApplied === true) {
    return [null, null, msg, null];
  }
  return [null, msg, null, null];
};

const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
if (!ctx) return retry(ctx, "context_missing");

const rows = asArray(msg.payload).filter(isObj);
if (rows.length === 0) {
  ctx.dailyLimitReleaseOutcome = ctx.dailyLimitReleaseOutcome || "NOT_APPLICABLE";
  return continueApply(ctx);
}
if (rows.length !== 1) return retry(ctx, "daily_limit_operation_ambiguous");

const operation = rows[0];
const targetBookingIds = Array.from(new Set(
  asArray(ctx.initialBookingIds).map(toStr).filter(Boolean),
));
const targetBookingIdSet = new Set(targetBookingIds.map(normalizeId).filter(Boolean));
const operationBookingIds = [operation.bookingId, operation.upstreamBookingId]
  .map(normalizeId).filter(Boolean);
const releasedBookingIds = asArray(operation.releasedBookingIds)
  .map(normalizeId).filter(Boolean);
const state = String(operation.state || "").trim().toUpperCase();

if (targetBookingIdSet.size > 0 && operationBookingIds.length > 0
  && !operationBookingIds.some((bookingId) => targetBookingIdSet.has(bookingId))) {
  return retry(ctx, "daily_limit_booking_mismatch");
}
if (["FAILED", "RELEASED"].includes(state)
  || (targetBookingIdSet.size > 0
    && Array.from(targetBookingIdSet).every((bookingId) => releasedBookingIds.includes(bookingId)))) {
  ctx.dailyLimitReleaseOutcome = "ALREADY_RELEASED";
  ctx.dailyLimitOperationKey = toStr(operation._id);
  ctx.dailyLimitReleasedAt = toStr(operation.releasedAt) || new Date().toISOString();
  return continueApply(ctx);
}
if (!["PREPARED", "PENDING_CONFIRMATION", "CONFIRMED"].includes(state)) {
  return retry(ctx, "daily_limit_state_unsupported");
}

const nowIso = new Date().toISOString();
ctx.dailyLimitOperationKey = toStr(operation._id);
ctx.dailyLimitPreviousState = state;
ctx.dailyLimitTargetBookingIds = targetBookingIds;
msg._splitLeaveCtx = ctx;
msg.payload = [
  {
    _id: operation._id,
    tenantKey: "iSkq6G",
    actorClientId: ctx.targetClientId,
    exerciseId: ctx.exerciseId,
    state: operation.state,
  },
  {
    $set: {
      state: "RELEASED",
      releasedAt: nowIso,
      releaseBookingId: targetBookingIds[0] || toStr(operation.bookingId || operation.upstreamBookingId),
      releaseSource: "GAME_LEAVE",
      releaseOperationId: ctx.operationId,
      updatedAt: nowIso,
    },
    ...(targetBookingIds.length > 0
      ? { $addToSet: { releasedBookingIds: { $each: targetBookingIds } } }
      : {}),
    $unset: {
      leaseUntil: "",
      pendingUntil: "",
      failure: "",
      failedAt: "",
    },
  },
  {},
];
return [msg, null, null];
