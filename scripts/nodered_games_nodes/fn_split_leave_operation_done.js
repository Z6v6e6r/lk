const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
const gameApplied = ctx?.supersededByRejoin === true || ctx?.localAlreadyApplied === true || ctx?.gameApplyAcknowledged === true;
const chatApplied = ctx?.supersededByRejoin === true || ctx?.chatCleanupSkipped === true || ctx?.chatCleanupAcknowledged === true;
if (!ctx || msg.error || !gameApplied || !chatApplied) {
  msg.statusCode = 202;
  msg.payload = {
    ok: true,
    state: "RETRY_REQUIRED",
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    message: "Viva подтверждена; требуется повторить синхронизацию игры",
  };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const superseded = ctx.supersededByRejoin === true;
const returnPending = ctx.subscriptionReturnState === "RETURN_PENDING";
const finalState = returnPending ? "RETURN_PENDING" : "DONE";
msg.payload = [
  { _id: ctx.operationKey, state: { $nin: ["DONE", "RETURN_PENDING"] } },
  {
    $set: {
      state: finalState,
      lkAppliedAt: ctx.localApplyAt || nowIso,
      ...(returnPending ? {} : { doneAt: nowIso }),
      successMessage: ctx.refundMessage || ctx.successMessage || "Вы вышли из игры",
      outcome: superseded ? "REJOIN_PRESERVED" : "REMOVED",
      dailyLimitReleaseOutcome: ctx.dailyLimitReleaseOutcome || "NOT_APPLICABLE",
      dailyLimitOperationKey: ctx.dailyLimitOperationKey || null,
      dailyLimitReleasedAt: ctx.dailyLimitReleasedAt || null,
      subscriptionReturnState: ctx.subscriptionReturnState || null,
      subscriptionReturnReason: ctx.subscriptionReturnReason || null,
      subscriptionReturnVerifiedAt: ctx.subscriptionReturnVerifiedAt || null,
      updatedAt: nowIso,
    },
    $unset: {
      claimLeaseUntil: "",
      localApplyLeaseUntil: "",
    },
    $push: {
      transitions: {
        $each: [
          superseded
            ? { state: "SUPERSEDED", at: ctx.localApplyAt || nowIso, outcome: "REJOIN_PRESERVED" }
            : { state: "LK_APPLIED", at: ctx.localApplyAt || nowIso },
          { state: finalState, at: nowIso },
        ],
      },
    },
  },
  {},
];
return [msg, null];
