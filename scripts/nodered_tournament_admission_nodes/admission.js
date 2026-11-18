// CUP reserves a canonical tournament seat, not a preview permission. Only a verified
// response to this request can enter ctx; request bodies cannot supply admission grants.
const tournamentAdmissionUrl = (ctx) => {
  const base = env.get("TOURNAMENT_OWNER_API_BASE");
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return url.href.replace(/\/$/, "") + "/tournaments/" + encodeURIComponent(ctx.exerciseId) + "/subscription-admission";
  } catch { return null; }
};
const tournamentAdmissionPending = (ctx) => finishPending(ctx, "Результат допуска требует сверки. Повторная запись не создана.", {
  code: "TOURNAMENT_ADMISSION_UNRESOLVED",
});
const tournamentAdmissionGate = (ctx, continuation) => {
  // category is resolved from the server-read exercise by the booking owner.
  if (ctx.category !== "tournament" || ctx.action === "release") return null;
  if (ctx.tournamentAdmission?.actorClientId === ctx.actorClientId
    && ctx.tournamentAdmission.exerciseId === ctx.exerciseId
    && ctx.tournamentAdmission.requestOperationId === ctx.operationId
    && ctx.tournamentAdmission.clientSubscriptionId === ctx.clientSubscriptionId) return null;
  const url = tournamentAdmissionUrl(ctx);
  if (!url || !ctx.actorClientId || !ctx.operationId || !ctx.operationKey || !ctx.clientSubscriptionId) return tournamentAdmissionPending(ctx);
  ctx.tournamentAdmissionContinuation = continuation;
  ctx.tournamentAdmissionRequestedUrl = url;
  return prepareManagedHttp(ctx, "tournament_admission", "POST", url,
    { operationId: ctx.operationId, clientSubscriptionId: ctx.clientSubscriptionId },
    { Authorization: ctx.authHeader, "Content-Type": "application/json", Accept: "application/json" });
};
const tournamentAdmissionFind = (ctx, step, key) => {
  ctx.step = step; msg._subscriptionBooking = ctx; msg.payload = { _id: key };
  delete msg.error; return emit(OUTPUT_MONGO_FIND);
};
const tournamentAdmissionGuardKey = (ctx) => `lk1-daily-visit:${JSON.stringify([
  ctx.tenantKey, normalizeId(ctx.clientSubscriptionId), ctx.serviceDate,
])}`;
const tournamentAdmissionRefusal = (ctx) => {
  if (ctx.tournamentAbortRecovery && !ctx.tournamentAbortCleanupComplete) {
    return tournamentAdmissionDurableUpdate(ctx, "tournament_abort_cleanup_saved", {
      ...tournamentAdmissionBinding(ctx), state: "FAILED", "tournamentAbort.acknowledged": true,
    }, { $set: { "tournamentAbort.cleanupComplete": true } });
  }
  return finishError(ctx, ctx.tournamentAbortRecovery ? 409 : 403, "Запись не соответствует правилам турнира.", {
    code: ctx.tournamentAdmissionRefusalCode || "TOURNAMENT_ADMISSION_REJECTED",
  });
};
const tournamentAdmissionTerminal = (ctx, row) => row?._id === ctx.operationKey && row.operationId === ctx.operationId
  && row.actorClientId === ctx.actorClientId && row.exerciseId === ctx.exerciseId
  && row.clientSubscriptionId === ctx.clientSubscriptionId && row.tenantKey === ctx.tenantKey
  && row.state === "FAILED" && row.failure?.rawCode === "TOURNAMENT_ADMISSION_REJECTED"
  && !row.upstreamAttemptedAt && !row.bookingId && !row.upstreamBookingId
  && !row.managedEntitlementOperationId && !row.lk1?.createAttemptedAt && !row.lk1?.bookingAttemptedAt
  && !row.lk1?.transactionAttemptedAt && !row.lk1?.visitJob;
const tournamentAdmissionComplete = (ctx, bookingId) => {
  if (ctx.category !== "tournament" || ctx.action === "release" || ctx.tournamentCompletion === true) return null;
  const base = tournamentAdmissionUrl(ctx), token = env.get("TOURNAMENT_OWNER_INTEGRATION_TOKEN");
  if (!base || typeof token !== "string" || !token || !bookingId) return tournamentAdmissionPending(ctx);
  ctx.tournamentCompletionBookingId = bookingId;
  ctx.tournamentAdmissionRequestedUrl = base + "/complete";
  return prepareManagedHttp(ctx, "tournament_completion", "POST", ctx.tournamentAdmissionRequestedUrl,
    { operationId: ctx.operationId, clientSubscriptionId: ctx.clientSubscriptionId, bookingId },
    { Authorization: ctx.authHeader, "x-cup-integration-token": token, "Content-Type": "application/json", Accept: "application/json" });
};
// Versioned predispatch evidence is persisted with preaccept. The older upstreamAttemptedAt
// is deliberately not used as dispatch evidence: it predates exercise_recheck.
const tournamentAdmissionBinding = (ctx) => ({ _id: ctx.operationKey, operationId: ctx.operationId,
  actorClientId: ctx.actorClientId, exerciseId: ctx.exerciseId, clientSubscriptionId: ctx.clientSubscriptionId,
  tenantKey: ctx.tenantKey, tournamentAdmission: ctx.tournamentAdmission });
const tournamentAdmissionUnused = { bookingId: { $exists: false }, upstreamBookingId: { $exists: false },
  managedEntitlementOperationId: { $exists: false }, "lk1.createAttemptedAt": { $exists: false },
  "lk1.bookingAttemptedAt": { $exists: false }, "lk1.transactionAttemptedAt": { $exists: false }, "lk1.visitJob": { $exists: false } };
const tournamentAdmissionDurableUpdate = (ctx, step, filter, update) => {
  const out = prepareMongoUpdate(ctx, step, filter, update);
  msg.payload[2] = { writeConcern: { w: "majority", j: true } };
  return out;
};
const tournamentAdmissionDispatch = (ctx) => {
  if (ctx.category !== "tournament" || ctx.action === "release" || ctx.tournamentDispatchGranted === true) return null;
  if (!ctx.tournamentAdmission) return tournamentAdmissionPending(ctx);
  return tournamentAdmissionDurableUpdate(ctx, "tournament_dispatch_saved", {
    ...tournamentAdmissionBinding(ctx), state: "PENDING_CONFIRMATION", tournamentProviderPhase: "PRE_DISPATCH",
  }, { $set: { tournamentProviderPhase: "DISPATCHING" } });
};
const tournamentAdmissionAbortFailure = (ctx, statusCode, message, rawCode) => {
  if (ctx.category !== "tournament" || ctx.step !== "exercise_recheck"
    || rawCode !== "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE" || !ctx.tournamentAdmission) return null;
  ctx.finalFailure = { statusCode, message, rawCode };
  return tournamentAdmissionDurableUpdate(ctx, "tournament_abort_saved", {
    ...tournamentAdmissionBinding(ctx), ...tournamentAdmissionUnused,
    state: "PENDING_CONFIRMATION", tournamentProviderPhase: "PRE_DISPATCH",
  }, { $set: { state: "FAILED", failure: ctx.finalFailure, failedAt: new Date().toISOString(),
    tournamentAbort: { proof: "PRE_DISPATCH_REJECTED_V1", acknowledged: false } }, $unset: { pendingUntil: "" } });
};
const tournamentAdmissionAbortTerminal = (ctx, row) => row?._id === ctx.operationKey
  && row.actorClientId === ctx.actorClientId && row.exerciseId === ctx.exerciseId
  && row.clientSubscriptionId === ctx.clientSubscriptionId && row.tenantKey === ctx.tenantKey
  && isValidDateKey(row.serviceDate)
  && row.state === "FAILED" && row.tournamentProviderPhase === "PRE_DISPATCH"
  && row.failure?.rawCode === "SUBSCRIPTION_ELIGIBILITY_CHANGED_BEFORE_WRITE"
  && row.tournamentAbort?.proof === "PRE_DISPATCH_REJECTED_V1"
  && row.tournamentAdmission?.requestOperationId === row.operationId
  && row.tournamentAdmission?.actorClientId === row.actorClientId
  && row.tournamentAdmission?.exerciseId === row.exerciseId
  && row.tournamentAdmission?.clientSubscriptionId === row.clientSubscriptionId
  && !row.bookingId && !row.upstreamBookingId && !row.managedEntitlementOperationId
  && !row.lk1?.createAttemptedAt && !row.lk1?.bookingAttemptedAt && !row.lk1?.transactionAttemptedAt && !row.lk1?.visitJob;
const tournamentAdmissionAbortSend = (ctx) => {
  const base = tournamentAdmissionUrl(ctx), token = env.get("TOURNAMENT_OWNER_INTEGRATION_TOKEN");
  if (!base || typeof token !== "string" || !token) return tournamentAdmissionPending(ctx);
  ctx.tournamentAdmissionRequestedUrl = base + "/abort";
  return prepareManagedHttp(ctx, "tournament_abort", "POST", ctx.tournamentAdmissionRequestedUrl,
    { operationId: ctx.operationId, ownerOperationId: ctx.tournamentAdmission.operationId,
      clientSubscriptionId: ctx.clientSubscriptionId, proof: "PRE_DISPATCH_REJECTED_V1",
      code: ctx.finalFailure.rawCode },
    { Authorization: ctx.authHeader, "x-cup-integration-token": token, "Content-Type": "application/json", Accept: "application/json" });
};
// A shared/day ledger can be reused by another event or category. Its old CUP hold
// must remain recoverable until both compensation and exact guard cleanup finish.
const tournamentAdmissionReclaimFence = { $or: [
  { tournamentAbort: { $exists: false } },
  { "tournamentAbort.proof": "PRE_DISPATCH_REJECTED_V1", "tournamentAbort.acknowledged": true,
    "tournamentAbort.cleanupComplete": true },
] };
const tournamentAdmissionAbortUnfinished = (row) => row.tournamentAbort !== undefined
  && !(row.tournamentAbort?.proof === "PRE_DISPATCH_REJECTED_V1"
    && row.tournamentAbort.acknowledged === true && row.tournamentAbort.cleanupComplete === true);
const tournamentAdmissionRoute = (ctx) => {
  if (ctx.step === "tournament_dispatch_saved") {
    // A lost database ACK cannot authorize a POST, even if a later read finds DISPATCHING.
    if (msg.error || mongoMatched(msg.payload) !== 1) return tournamentAdmissionPending(ctx);
    ctx.tournamentDispatchGranted = true;
    return prepareBookingCreate(ctx);
  }
  if (["operation_find", "lk1_operation_find", "lk1_ingress_operation_find", "tournament_abort_read"].includes(ctx.step)
    && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1
    && tournamentAdmissionAbortTerminal(ctx, msg.payload[0])) {
    const row = msg.payload[0];
    // A new operation may reclaim only after the old compensation was durably acknowledged.
    if (row.operationId !== ctx.operationId && row.tournamentAbort.acknowledged === true && row.tournamentAbort.cleanupComplete === true) return null;
    ctx.operationId = row.operationId;
    ctx.serviceDate = row.serviceDate;
    ctx.tournamentAdmission = row.tournamentAdmission;
    ctx.finalFailure = row.failure;
    ctx.tournamentAdmissionRefusalCode = row.failure.rawCode;
    ctx.tournamentAbortRecovery = true;
    ctx.tournamentAbortCleanupComplete = row.tournamentAbort.cleanupComplete === true;
    return row.tournamentAbort.acknowledged === true
      ? tournamentAdmissionFind(ctx, "tournament_admission_guard_read", tournamentAdmissionGuardKey(ctx))
      : tournamentAdmissionAbortSend(ctx);
  }
  if (["operation_find", "lk1_operation_find", "lk1_ingress_operation_find"].includes(ctx.step)
    && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1
    && msg.payload[0]?._id === ctx.operationKey && tournamentAdmissionAbortUnfinished(msg.payload[0])) {
    // Do not reinterpret an old grant using the new event's context. The original
    // request can still recover its exact abort through the branch above.
    return tournamentAdmissionPending(ctx);
  }
  if (["tournament_abort_saved", "tournament_abort_ack_saved", "tournament_abort_cleanup_saved"].includes(ctx.step)) {
    return tournamentAdmissionFind(ctx, "tournament_abort_read", ctx.operationKey);
  }
  if (ctx.step === "tournament_abort_read") return tournamentAdmissionPending(ctx);
  if (ctx.step === "tournament_abort") {
    const body = msg.payload;
    if (msg.error || !isHttpOk(msg.statusCode) || msg.url !== ctx.tournamentAdmissionRequestedUrl
      || msg.responseUrl !== ctx.tournamentAdmissionRequestedUrl || msg.method !== "POST"
      || msg.followRedirects !== false || msg.maxRedirects !== 0
      || body?.state !== "ABORTED" || body.ownerOperationId !== ctx.tournamentAdmission.operationId
      || body.requestOperationId !== ctx.operationId || body.actorClientId !== ctx.actorClientId
      || body.exerciseId !== ctx.exerciseId || body.clientSubscriptionId !== ctx.clientSubscriptionId) return tournamentAdmissionPending(ctx);
    return tournamentAdmissionDurableUpdate(ctx, "tournament_abort_ack_saved", {
      ...tournamentAdmissionBinding(ctx), ...tournamentAdmissionUnused, state: "FAILED",
      tournamentProviderPhase: "PRE_DISPATCH", "tournamentAbort.proof": "PRE_DISPATCH_REJECTED_V1",
    }, { $set: { "tournamentAbort.acknowledged": true } });
  }
  if (ctx.step === "tournament_completion") {
    if (msg.error || !isHttpOk(msg.statusCode) || msg.responseUrl !== ctx.tournamentAdmissionRequestedUrl
      || msg.url !== ctx.tournamentAdmissionRequestedUrl || msg.method !== "POST"
      || !["COMPLETED", "LEGACY_UNTRACKED"].includes(msg.payload?.state)
      || msg.payload.requestOperationId !== ctx.operationId
      || (msg.payload.state === "COMPLETED" && msg.payload.bookingId !== ctx.tournamentCompletionBookingId)) return tournamentAdmissionPending(ctx);
    ctx.tournamentCompletion = true;
    return ctx.lk1 && typeof lk1Finish === "function" ? lk1Finish(ctx)
      : finishConfirmed(ctx, ctx.tournamentCompletionBookingId);
  }
  // A crash after the durable refusal resumes cleanup, never the provider call.
  if (["operation_find", "lk1_operation_find", "lk1_ingress_operation_find"].includes(ctx.step)
    && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1
    && tournamentAdmissionTerminal(ctx, msg.payload[0])) {
    ctx.tournamentAdmissionRefusalCode = msg.payload[0].failure.admissionCode;
    return tournamentAdmissionFind(ctx, "tournament_admission_guard_read", tournamentAdmissionGuardKey(ctx));
  }
  if (ctx.step === "tournament_admission") {
    const body = msg.payload;
    if (msg.error || msg.url !== ctx.tournamentAdmissionRequestedUrl || msg.method !== "POST"
      || msg.responseUrl !== ctx.tournamentAdmissionRequestedUrl || msg.followRedirects !== false || msg.maxRedirects !== 0) {
      return tournamentAdmissionPending(ctx);
    }
    if (isHttpOk(msg.statusCode) && body?.schemaVersion === 1 && body.state === "ADMITTED"
      && body.actorClientId === ctx.actorClientId && body.exerciseId === ctx.exerciseId
      && body.requestOperationId === ctx.operationId && body.clientSubscriptionId === ctx.clientSubscriptionId
      && typeof body.operationId === "string") {
      ctx.tournamentAdmission = body;
      const continuation = ctx.tournamentAdmissionContinuation;
      delete ctx.tournamentAdmissionContinuation;
      return continuation === "booking" ? prepareBookingCreate(ctx)
        : continuation === "reserve" ? prepareManagedEntitlementReserve(ctx) : preparePreaccept(ctx);
    }
    // Only an authoritative deterministic refusal is eligible for exact predispatch cleanup.
    if (![403, 409].includes(msg.statusCode) || !["LEVEL_NOT_ALLOWED", "PLAYER_LEVEL_REQUIRED", "PLAYER_LEVEL_UNKNOWN",
      "ACTIVITY_LEVEL_INVALID", "PLAYER_GENDER_REQUIRED", "GENDER_NOT_ALLOWED"].includes(body?.code)) return tournamentAdmissionPending(ctx);
    ctx.tournamentAdmissionRefusalCode = body.code;
    const out = prepareMongoUpdate(ctx, "tournament_admission_refusal_saved", {
      _id: ctx.operationKey, operationId: ctx.operationId, actorClientId: ctx.actorClientId,
      exerciseId: ctx.exerciseId, clientSubscriptionId: ctx.clientSubscriptionId, tenantKey: ctx.tenantKey,
      state: "PREPARED", upstreamAttemptedAt: { $exists: false }, bookingId: { $exists: false }, upstreamBookingId: { $exists: false },
      managedEntitlementOperationId: { $exists: false }, "lk1.createAttemptedAt": { $exists: false },
      "lk1.bookingAttemptedAt": { $exists: false }, "lk1.transactionAttemptedAt": { $exists: false }, "lk1.visitJob": { $exists: false },
    }, { $set: { state: "FAILED", failedAt: new Date().toISOString(),
      failure: { rawCode: "TOURNAMENT_ADMISSION_REJECTED", admissionCode: body.code } } });
    msg.payload[2] = { writeConcern: { w: "majority", j: true } };
    return out;
  }
  if (ctx.step === "tournament_admission_refusal_saved") {
    // Always read back, including a lost update acknowledgement.
    return tournamentAdmissionFind(ctx, "tournament_admission_refusal_read", ctx.operationKey);
  }
  if (ctx.step === "tournament_admission_refusal_read") {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
      || !tournamentAdmissionTerminal(ctx, msg.payload[0])) return tournamentAdmissionPending(ctx);
    return tournamentAdmissionFind(ctx, "tournament_admission_guard_read", tournamentAdmissionGuardKey(ctx));
  }
  if (ctx.step === "tournament_admission_guard_read") {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return tournamentAdmissionPending(ctx);
    const guard = msg.payload[0];
    if (!guard || guard.ownerOperationKey !== ctx.operationKey || guard.ownerOperationId !== ctx.operationId) return tournamentAdmissionRefusal(ctx);
    if (guard._id !== tournamentAdmissionGuardKey(ctx) || guard.kind !== "LK1_DAILY_VISIT_V1") return tournamentAdmissionPending(ctx);
    if (guard.admissionRelease?.operationKey === ctx.operationKey && guard.admissionRelease?.operationId === ctx.operationId) return tournamentAdmissionRefusal(ctx);
    ctx.step = "tournament_admission_guard_saved"; msg._subscriptionBooking = ctx;
    msg.payload = [{ _id: guard._id, kind: guard.kind, ownerOperationKey: ctx.operationKey, ownerOperationId: ctx.operationId },
      { $set: { admissionRelease: { operationKey: ctx.operationKey, operationId: ctx.operationId } } },
      { writeConcern: { w: "majority", j: true } }];
    delete msg.error; return emit(OUTPUT_MONGO_UPDATE);
  }
  if (ctx.step === "tournament_admission_guard_saved") return tournamentAdmissionFind(ctx, "tournament_admission_guard_read", tournamentAdmissionGuardKey(ctx));
  return null;
};
