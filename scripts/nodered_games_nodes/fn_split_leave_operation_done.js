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
msg.payload = [
  { _id: ctx.operationKey, state: { $ne: "DONE" } },
  {
    $set: {
      state: "DONE",
      lkAppliedAt: ctx.localApplyAt || nowIso,
      doneAt: nowIso,
      successMessage: ctx.refundMessage || ctx.successMessage || "Вы вышли из игры",
      outcome: superseded ? "REJOIN_PRESERVED" : "REMOVED",
      dailyLimitReleaseOutcome: ctx.dailyLimitReleaseOutcome || "NOT_APPLICABLE",
      dailyLimitOperationKey: ctx.dailyLimitOperationKey || null,
      dailyLimitReleasedAt: ctx.dailyLimitReleasedAt || null,
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
          { state: "DONE", at: nowIso },
        ],
      },
    },
  },
  {},
];
return [msg, null];
