const rows = Array.isArray(msg.payload) ? msg.payload : [];
const operation = rows[0] && typeof rows[0] === "object" ? rows[0] : null;
if (!operation) return [null, msg];
const nowIso = new Date().toISOString();
const claimToken = `retry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
const operationState = String(operation.state || "").toUpperCase();
const vivaTargetMode = operation.vivaTargetMode || "BOOKINGS";
if (operationState === "STARTED" && vivaTargetMode !== "NONE"
  && !String(global.get("vivacrm_access_token") || "").trim()) {
  msg.payload = { operationId: operation.operationId || null, reason: "service_token_missing_before_claim" };
  return [null, msg];
}
msg._splitLeaveCtx = {
  backgroundRetry: true,
  operationKey: operation._id,
  operationId: operation.operationId,
  operationState,
  claimToken,
  gameId: operation.gameId,
  exerciseId: operation.exerciseId,
  mode: operation.mode,
  reason: operation.reason,
  actorClientId: operation.actorClientId,
  actorPhoneNorm: operation.actorPhoneNorm,
  targetClientId: operation.targetClientId,
  targetPhoneNorm: operation.targetPhoneNorm,
  membershipVersion: operation.membershipVersion || null,
  vivaTargetMode,
  initialBookingIds: Array.isArray(operation.bookingIds) ? operation.bookingIds : [],
  bookingQueue: Array.isArray(operation.bookingIds) ? operation.bookingIds.filter(Boolean).map((bookingId) => ({
    bookingId,
    clientId: operation.targetClientId || null,
  })) : [],
  bookingResults: [],
  trace: [],
  refundMessage: operation.refundMessage || null,
  successMessage: operation.successMessage || "Вы вышли из игры",
  vivaVerification: operation.vivaVerification || null,
  requestedRefundMethod: operation.requestedRefundMethod || null,
  step: "local_apply",
};
if (operationState === "STARTED") {
  msg.payload = [
    {
      _id: operation._id,
      state: "STARTED",
      claimToken: operation.claimToken || { $in: [null, ""] },
      recoveryAttempts: { $not: { $gte: 20 } },
      $or: [
        { claimLeaseUntil: { $exists: false } },
        { claimLeaseUntil: null },
        { claimLeaseUntil: { $lte: nowIso } },
      ],
    },
    {
      $set: {
        claimToken,
        claimLeaseUntil: new Date(Date.now() + 90_000).toISOString(),
        lastAttemptAt: nowIso,
        updatedAt: nowIso,
      },
      $inc: { recoveryAttempts: 1 },
    },
    {},
  ];
} else {
  msg.payload = [
    {
      _id: operation._id,
      state: "VIVA_CONFIRMED",
      localApplyAttempts: { $lt: 20 },
      $or: [
        { localApplyLeaseUntil: { $exists: false } },
        { localApplyLeaseUntil: null },
        { localApplyLeaseUntil: { $lte: nowIso } },
      ],
    },
    {
      $set: {
        localApplyClaimToken: claimToken,
        localApplyLeaseUntil: new Date(Date.now() + 3 * 60_000).toISOString(),
        lastAttemptAt: nowIso,
        updatedAt: nowIso,
      },
      $inc: { localApplyAttempts: 1 },
    },
    {},
  ];
}
return [msg, null];
