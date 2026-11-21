if (responseStatus === 403 && ctx?.step === "tournament_admission_guard_read"
  && ctx.caller === "http" && ctx.action === "book" && ctx.category === "tournament"
  && ctx.managedAction === "BOOK_TOURNAMENT"
  && !ctx.tournamentAbortRecovery && !ctx.tournamentAdmission && !ctx.tournamentDispatchGranted
  && typeof payload.details?.code === "string"
  && ctx.tournamentLevelRefusal === JSON.stringify([ctx.operationKey, ctx.operationId, ctx.tenantKey,
    ctx.actorClientId, ctx.clientSubscriptionId, ctx.exerciseId, ctx.lk1?.fingerprint, payload.details.code])) {
  return [null, msg];
}
