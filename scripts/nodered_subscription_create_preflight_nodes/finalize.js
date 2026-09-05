if (ctx?.caller === "split_create_readonly_preflight") {
  const split = msg._splitCtx;
  const headers = msg.req?.headers || {};
  const operationId = String(headers["idempotency-key"] || headers["Idempotency-Key"]
    || msg.req?.query?.operationId || "").trim();
  const target = ctx.prospectiveTarget;
  const bound = split?.action === "create" && !split.exerciseId && split.ownsExercise !== true
    && operationId && operationId === ctx.operationId
    && ctx.exerciseId === `preflight:${operationId}`
    && ctx.clientSubscriptionId === split.clientSubscriptionId
    && target?.roomId === split.roomId && target?.studioId === split.studioId
    && target?.timeFrom === `${split.date}T${split.fromTime}+03:00`
    && target?.timeTo === `${split.date}T${split.toTime}+03:00`;
  if (Number(msg.statusCode) === 200 && payload.state === "CREATE_PREFLIGHT_PASSED" && bound) {
    split.subscriptionCreatePreflightDone = true;
    split.step = "subscription_create_preflight_complete";
    delete msg._subscriptionBooking;
    return [msg, null];
  }
  if (Number(msg.statusCode) < 400 || !bound) {
    msg.statusCode = 409;
    msg.payload = { error: "Предварительная проверка создания игры не подтверждена",
      details: { code: "SUBSCRIPTION_CREATE_PREFLIGHT_UNCONFIRMED" } };
  }
  return [null, msg];
}

// There is no proven provider atomic empty-only DELETE contract. Preserve late
// failures/accepted bookings; expose exact reconciliation identity without retrying.
if (ctx?.caller === "split" && msg._splitCtx?.action === "create"
  && msg._splitCtx.ownsExercise === true && msg._splitCtx.reusedConflictingExercise !== true
  && ctx.exerciseId && ctx.exerciseId === msg._splitCtx.exerciseId
  && (Number(msg.statusCode) >= 400 || payload.state === "PENDING_CONFIRMATION")) {
  msg.payload = { ...payload, details: { ...(payload.details || {}),
    exerciseId: ctx.exerciseId, reconciliationRequired: true, destructiveRetryBlocked: true,
  } };
  return [null, msg];
}
