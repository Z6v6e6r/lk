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
if (ctx.localReconciliation) {
  ctx.dailyLimitReleaseOutcome = "NOT_APPLICABLE";
  return continueApply(ctx);
}

if (msg.error || !Array.isArray(msg.payload)) return retry(ctx, "daily_limit_read_unavailable");
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
// Paid mixed JOIN returns its separately adjusted limit through the visit worker.
// This is deliberately separate from legacy SUBSCRIPTION-booking return checks.
if (operation.lk1?.visitJob !== undefined) {
  const job = operation.lk1.visitJob;
  ctx.dailyLimitOperationKey = toStr(operation._id);
  if (job?.operationKey !== operation._id || job?.operationId !== operation.operationId
    || ["tenantKey", "actorClientId", "clientSubscriptionId", "exerciseId", "bookingId", "serviceDate"].some(key => job?.[key] !== operation[key])
    || job?.actorClientId !== ctx.targetClientId || job?.exerciseId !== ctx.exerciseId
    || !targetBookingIdSet.has(normalizeId(job?.bookingId))) return retry(ctx, "visit_cancel_binding_unverified");
  if (state === "RELEASED" && job?.cancellation) {
    try {
      if (!__subscriptionVisitLifecycle.visitAllowanceRelease(job)) return retry(ctx, "visit_return_unverified");
      ctx.dailyLimitReleaseOutcome = "RELEASED";
      return continueApply(ctx);
    } catch (_) { return retry(ctx, "visit_job_invalid"); }
  }
  if (ctx.mode === "STAFF_TARGET" && ctx.reason === "CUP_STAFF_REMOVAL" && ctx.requestedRefundMethod === "NONE") {
    try {
      const after = __subscriptionVisitLifecycle.retainVisitByStaff(job, { kind: "STAFF_NO_RETURN",
        bookingId: job.bookingId, operationId: ctx.operationId, staffActorId: ctx.staffActorId,
        verifiedAt: ctx.vivaVerifiedAt }, new Date().toISOString());
      ctx.dailyLimitReleaseOutcome = "VISIT_RETAINED_BY_STAFF";
      if (after.revision === job.revision) return continueApply(ctx);
      const command = __subscriptionVisitLifecycle.visitJobCas(job, after);
      command.query.state = "CONFIRMED";
      ctx.dailyLimitVisitJobWrite = true;
      msg._splitLeaveCtx = ctx;
      msg.payload = [command.query, command.update, command.options];
      return [msg, null, null, null];
    } catch (_) { return retry(ctx, "visit_staff_retention_unverified"); }
  }
  const cancelled = asArray(ctx.bookingResults).find((row) => normalizeId(row.bookingId) === normalizeId(job?.bookingId));
  if (state !== "CONFIRMED" || job?.operationKey !== operation._id
    || job?.actorClientId !== ctx.targetClientId || job?.exerciseId !== ctx.exerciseId
    || !targetBookingIdSet.has(normalizeId(job?.bookingId))
    || ctx.vivaVerification !== "active_absent_history_cancelled" || !ctx.vivaVerifiedAt) {
    return retry(ctx, "visit_cancel_binding_unverified");
  }
  // A persisted cancellation survives retry contexts that no longer carry the
  // original successful refund request. First insertion requires that request.
  if (!job.cancellation && (!cancelled || cancelled.provisional !== "cancel_requested"
    || !["CURRENCY", "DEPOSIT", "NONE"].includes(cancelled.refundMethod))) {
    return retry(ctx, "visit_money_cancel_unverified");
  }
  try {
    const cancellation = job.cancellation || { source: "VIVA_BOOKING_READBACK", operationId: ctx.operationId,
      tenantKey: job.tenantKey, actorClientId: job.actorClientId, clientSubscriptionId: job.clientSubscriptionId,
      exerciseId: job.exerciseId, bookingId: job.bookingId, bookingCancelled: true,
      verifiedAt: ctx.vivaVerifiedAt, moneyRefundState: cancelled.refundMethod === "NONE" ? "NO_REFUND_REQUESTED" : "REQUEST_ACCEPTED" };
    const after = __subscriptionVisitLifecycle.requestVisitReturn(job, cancellation, new Date().toISOString());
    ctx.dailyLimitReleaseOutcome = "VISIT_RETURN_PENDING";
    if (after.revision === job.revision) return continueApply(ctx);
    const command = __subscriptionVisitLifecycle.visitJobCas(job, after);
    command.query.state = "CONFIRMED";
    command.update.$set["lk1.visitNextCheckAt"] = new Date().toISOString();
    ctx.dailyLimitVisitJobWrite = true;
    msg._splitLeaveCtx = ctx;
    msg.payload = [command.query, command.update, command.options];
    return [msg, null, null, null];
  } catch (_) { return retry(ctx, "visit_job_invalid"); }
}
// Removing the cancelled booking from the roster may finish while Viva is still
// returning its visit. Keep the allowance reserved until the existing recovery
// path observes RETURN_VERIFIED and passes through this node again.
if (ctx.subscriptionReturnState === "RETURN_PENDING") {
  ctx.dailyLimitReleaseOutcome = "RETURN_PENDING";
  ctx.dailyLimitOperationKey = toStr(operation._id);
  return continueApply(ctx);
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
