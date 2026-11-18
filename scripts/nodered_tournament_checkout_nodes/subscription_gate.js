const isTournamentSubscriptionWrite = (ctx) => ctx.category === "tournament"
  || ctx.managedAction === "BOOK_TOURNAMENT" || ctx.lk1?.target?.category === "TOURNAMENT";

const hasCupTournamentAdmission = (ctx) => ctx.cupTournamentAdmission?.actor === ctx.actorClientId
  && ctx.cupTournamentAdmission?.exercise === ctx.exerciseId && Boolean(ctx.cupTournamentAdmission?.ruleVersion);

const beginCupTournamentGate = (ctx, continuation) => {
  ctx.cupTournamentContinuation = continuation;
  const output = prepareHttp(ctx, "cup_tournament_admission", "GET", cupTournamentDecisionUrl(ctx.exerciseId),
    undefined, { Authorization: ctx.authHeader, Accept: "application/json" });
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.responseUrl;
  delete msg.statusCode;
  return output;
};

const postponeTournamentSubscription = (ctx) => finishPending(ctx,
  "Запись на турнир требует сверки допуска.", { code: "TOURNAMENT_LEVEL_ADMISSION_RECONCILIATION_REQUIRED" });

function beginSubscriptionEnrollment(ctx, mode, continuation) {
  if (mode === "acquire") ctx.tournamentPreacceptAt = new Date().toISOString();
  // Ingress reclaim runs before the gateway populates operationKey. Its fixed
  // CAS already identifies the exact row proven to belong to this actor.
  const operationKey = ctx.operationKey ?? (continuation?.type === "reclaim" ? continuation.payload?.[0]?._id : null);
  const result = teBegin(ctx.tenantKey, ctx.actorClientId, ctx.exerciseId, mode, {
    mode: "subscription", operationKey, operationId: ctx.operationId,
    attemptedAt: ctx.tournamentPreacceptAt, admission: ctx.cupTournamentAdmission,
  });
  ctx.tournamentEnrollmentStep = result.state;
  ctx.tournamentEnrollmentNext = continuation;
  return subscriptionEnrollmentEffect(ctx, result.effect);
}

function subscriptionEnrollmentEffect(ctx, effect) {
  if (effect.kind === "http") {
    const token = readGlobal("vivacrm_access_token");
    if (!token) return subscriptionEnrollmentEffect(ctx, teStep(ctx.tournamentEnrollmentStep, { error: true }));
    const output = prepareHttp(ctx, "tournament_enrollment", "GET", effect.url, undefined,
      { Authorization: "Bearer " + token, Accept: "application/json" });
    msg.followRedirects = false;
    msg.maxRedirects = 0;
    delete msg.responseUrl;
    delete msg.statusCode;
    return output;
  }
  if (effect.kind !== "result") {
    const output = { find: OUTPUT_MONGO_FIND, insert: OUTPUT_MONGO_INSERT, update: OUTPUT_MONGO_UPDATE };
    ctx.step = "tournament_enrollment";
    msg._subscriptionBooking = ctx;
    msg.payload = effect.payload;
    delete msg.error;
    return emit(output[effect.kind]);
  }
  const next = ctx.tournamentEnrollmentNext;
  delete ctx.tournamentEnrollmentNext;
  delete ctx.tournamentEnrollmentStep;
  switch (effect.outcome) {
    case "open":
      ctx.tournamentEnrollmentChecked = true;
      return continueTournamentSubscription(ctx, next);
    case "acquired":
      ctx.tournamentBookingClaim = effect.row;
      return continueTournamentSubscription(ctx, next);
    case "closed":
      return finishError(ctx, 409, "Предыдущая попытка закрыта. Запишитесь снова.",
        { code: "TOURNAMENT_PREVIOUS_ATTEMPT_CLOSED" });
    case "locked":
      return tournamentEnrollmentHeld(ctx);
    default:
      return postponeTournamentSubscription(ctx);
  }
}

function tournamentEnrollmentHeld(ctx) {
  return finishError(ctx, 409, "На турнир уже есть запись или незавершённая попытка.", { code: "TOURNAMENT_ENROLLMENT_HELD" });
}
function reserveTournamentSubscription(ctx, continuation) {
  if (!ctx.tournamentEnrollmentChecked) return beginSubscriptionEnrollment(ctx, "inspect", continuation);
  if (!ctx.tournamentBookingClaim) return beginSubscriptionEnrollment(ctx, "acquire", continuation);
  if (ctx.operationKey && ctx.operationKey !== ctx.tournamentBookingClaim.owner.operationKey) {
    return postponeTournamentSubscription(ctx);
  }
  return null;
}

// The lease is only for work before the first Viva mutation. After committing
// HELD, neither a clock timeout nor a lost acknowledgement allows takeover.
function claimTournamentDispatch(ctx, request) {
  const row = ctx.tournamentBookingClaim;
  if (row?.state !== "RESERVED" || !teDate(row.reservedUntil) || !hasCupTournamentAdmission(ctx)
    || ctx.tournamentPreaccepted !== true || request.method !== "POST"
    || row.owner.operationKey !== ctx.operationKey || row.owner.operationId !== ctx.operationId
    || row.owner.attemptedAt !== ctx.tournamentPreacceptAt) return postponeTournamentSubscription(ctx);
  ctx.tournamentBookingRequest = request;
  return prepareMongoUpdate(ctx, "tournament_enrollment_dispatch", {
    ...teFilter(row), reservedUntil: row.reservedUntil,
    $expr: { $gt: [{ $toDate: "$reservedUntil" }, "$$NOW"] },
  }, { $set: { state: "HELD" }, $unset: { reservedUntil: "" } });
}

function tournamentOwnPreaccept(ctx) {
  return { _id: ctx.operationKey, operationId: ctx.operationId, state: "PENDING_CONFIRMATION",
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId, category: "tournament",
    upstreamAttemptedAt: ctx.tournamentPreacceptAt, acceptedAt: { $in: [null, ""] },
    bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] } };
}

function continueTournamentSubscription(ctx, continuation) {
  if (continuation?.type === "preaccept") return preparePreaccept(ctx);
  if (["insert", "reclaim"].includes(continuation?.type)) {
    ctx.step = continuation.step;
    msg.payload = continuation.payload;
    return emit(continuation.type === "insert" ? OUTPUT_MONGO_INSERT : OUTPUT_MONGO_UPDATE);
  }
  return postponeTournamentSubscription(ctx);
}

function markTournamentBookingRefusal(ctx) {
  const request = ctx.tournamentBookingSent;
  if (!request || !ctx.tournamentBookingClaim || msg.error || !teRefusalCodes.includes(msg.statusCode)
    || msg.method !== "POST" || msg.url !== request.url || msg.responseUrl !== request.url
    || msg.followRedirects !== false || msg.maxRedirects !== 0
    || !isObj(msg.payload) || ![msg.payload.message, msg.payload.error].some(x => typeof x === "string" && x.trim())
    || [msg.payload.id, msg.payload.transactionId, msg.payload.correlationId, msg.payload.bookingId,
      msg.payload.data, msg.payload.booking, msg.payload.acceptedAt, msg.payload.paymentUrl].some(x => !teEmpty(x))) return;
  ctx.tournamentBookingRefusal = msg.statusCode;
}
