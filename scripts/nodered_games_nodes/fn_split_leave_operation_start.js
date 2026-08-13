const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (!ctx) {
  msg.statusCode = 409;
  msg.payload = { ok: false, state: "CONFLICT", message: "Operation context missing" };
  return [null, msg];
}
const bookingIds = Array.isArray(ctx.initialBookingIds) ? ctx.initialBookingIds.filter(Boolean) : [];
if (!ctx.membershipVersion || (bookingIds.length === 0 && ctx.vivaTargetMode !== "NONE")) {
  msg.statusCode = 409;
  msg.payload = {
    ok: false,
    state: "CONFLICT",
    ...(ctx.mode === "STAFF_TARGET" ? {
      status: "CONFLICT",
      visitAction: ctx.requestedRefundMethod === "SERVICE" ? "RETURN_VISIT" : "NO_RETURN",
      playerId: ctx.targetClientId || null,
    } : {}),
    message: "Stable membership target is required",
  };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 90_000).toISOString();
const operationKey = `${ctx.gameId}:${ctx.operationId}`;
ctx.operationKey = operationKey;
msg._splitLeaveCtx = ctx;
msg.payload = [
  { _id: operationKey },
  {
    $setOnInsert: {
      _id: operationKey,
      operationId: ctx.operationId,
      gameId: ctx.gameId,
      exerciseId: ctx.exerciseId || null,
      mode: ctx.mode,
      reason: ctx.reason,
      requestedRefundMethod: ctx.requestedRefundMethod || null,
      actorClientId: ctx.actorClientId || null,
      actorPhoneNorm: ctx.actorPhoneNorm || null,
      targetClientId: ctx.targetClientId || null,
      targetPhoneNorm: ctx.targetPhoneNorm || null,
      source: ctx.source || "LK",
      staffActorId: ctx.staffActorId || null,
      idempotencyDigest: ctx.idempotencyDigest || null,
      membershipVersion: ctx.membershipVersion || null,
      bookingIds,
      vivaTargetMode: ctx.vivaTargetMode || "BOOKINGS",
      vivaVerifiedAt: ctx.vivaVerifiedAt || null,
      vivaVerification: ctx.vivaVerification || null,
      successMessage: ctx.successMessage || null,
      state: "STARTED",
      claimToken: ctx.claimToken,
      claimLeaseUntil: leaseUntilIso,
      localApplyAttempts: 0,
      lastAttemptAt: nowIso,
      createdAt: nowIso,
      transitions: [{ state: "STARTED", at: nowIso }],
    },
    $set: { lastSeenAt: nowIso },
  },
  { upsert: true },
];
return [msg, null];
