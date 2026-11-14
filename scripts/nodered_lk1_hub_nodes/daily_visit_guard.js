// Embedded by patch_live_lk1_daily_visit.mjs. The original operation exists before
// this guard is acquired. Mongo's existing unique _id serializes all categories,
// including different Node-RED processes; no index migration or expiring lock.
const lk1DailyVisitKey = (ctx) => `lk1-daily-visit:${JSON.stringify([
  ctx.tenantKey, normalizeId(ctx.clientSubscriptionId), ctx.serviceDate,
])}`;
const lk1DailyVisitConflict = (operation) => operation?.state === "FAILED"
  && operation.failure?.rawCode === "LK1_DAILY_VISIT_CHANGED"
  && !operation.upstreamAttemptedAt && !operation.bookingId && !operation.upstreamBookingId
  && !operation.lk1?.createAttemptedAt && !operation.lk1?.bookingAttemptedAt
  && !operation.lk1?.transactionAttemptedAt && !operation.lk1?.visitJob;
const lk1DailyVisitAcquire = (ctx) => {
  if (!isValidDateKey(ctx.serviceDate) || !ctx.tenantKey || !ctx.clientSubscriptionId
    || !ctx.operationKey || !ctx.operationId) return lk1Stop(ctx, "LK1_DAILY_VISIT_IDENTITY_INVALID");
  // Old PREPARED decisions were priced with independent category allowances.
  // Fence them before any provider write, then retry through fresh usage/price.
  if (ctx.lk1.dailyVisitPolicyVersion !== 1) return lk1DailyVisitReject(ctx);
  ctx.step = "lk1_daily_visit_claim";
  msg._subscriptionBooking = ctx;
  // Deliberately no actorClientId/lk1.rule: a guard is not an allowance operation.
  msg.payload = [{ _id: lk1DailyVisitKey(ctx) }, { $setOnInsert: { kind: "LK1_DAILY_VISIT_V1",
    tenantKey: ctx.tenantKey, clientSubscriptionId: normalizeId(ctx.clientSubscriptionId),
    serviceDate: ctx.serviceDate, ownerOperationKey: ctx.operationKey,
    ownerOperationId: ctx.operationId } }, { upsert: true, writeConcern: { w: "majority", j: true } }];
  delete msg.error;
  return emit(OUTPUT_MONGO_UPDATE);
};
const lk1DailyVisitContinue = (ctx) => {
  ctx.lk1DailyVisitOwned = true;
  if (ctx.lk1DailyVisitContinuation === "booking") {
    delete ctx.lk1DailyVisitContinuation;
    return prepareBookingCreate(ctx);
  }
  return preparePreaccept(ctx);
};
const lk1DailyVisitReject = (ctx) => {
  const now = new Date().toISOString();
  return prepareMongoUpdate(ctx, "lk1_daily_visit_conflict_saved", {
    _id: ctx.operationKey, operationId: ctx.operationId, state: "PREPARED",
    upstreamAttemptedAt: { $exists: false }, bookingId: { $exists: false },
    upstreamBookingId: { $exists: false }, "lk1.createAttemptedAt": { $exists: false },
    "lk1.bookingAttemptedAt": { $exists: false },
  }, { $set: { state: "FAILED", failedAt: now, updatedAt: now,
    failure: { statusCode: 409, rawCode: "LK1_DAILY_VISIT_CHANGED",
      message: "Дневное посещение уже занято. Обновите стоимость записи." } } });
};

// A losing request may retry its deterministic operation ID with a freshly
// displayed quote. It never replays the stale free decision or repeats Viva.
if (["lk1_ingress_operation_find", "lk1_operation_find"].includes(ctx.step)
  && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1
  && lk1DailyVisitConflict(msg.payload[0])) {
  const operation = msg.payload[0];
  if (!lk1ReplayIdentityMatches(ctx, operation)) return lk1Stop(ctx, "LK1_REQUEST_IDENTITY_CHANGED");
  ctx.lk1DailyVisitRetry = { operationKey: operation._id, fingerprint: operation.lk1.fingerprint };
  msg.payload = [];
}

if (ctx.step === "lk1_daily_visit_claim") {
  // Upsert matches only _id, never the owner: normal contention is a no-op,
  // not an E11000 sent to the graph's catch/finalize branch. Always read back.
  return lk1Find(ctx, "lk1_daily_visit_read", { _id: lk1DailyVisitKey(ctx) });
}
if (ctx.step === "lk1_daily_visit_read") {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1) {
    return lk1Stop(ctx, "LK1_DAILY_VISIT_READ_UNRESOLVED");
  }
  const guard = msg.payload[0];
  if (guard._id !== lk1DailyVisitKey(ctx) || guard.kind !== "LK1_DAILY_VISIT_V1"
    || guard.tenantKey !== ctx.tenantKey || guard.clientSubscriptionId !== normalizeId(ctx.clientSubscriptionId)
    || guard.serviceDate !== ctx.serviceDate || typeof guard.ownerOperationKey !== "string"
    || typeof guard.ownerOperationId !== "string") return lk1Stop(ctx, "LK1_DAILY_VISIT_BINDING_INVALID");
  if (guard.ownerOperationKey === ctx.operationKey) {
    if (guard.ownerOperationId !== ctx.operationId) return lk1Stop(ctx, "LK1_DAILY_VISIT_BINDING_INVALID");
    return lk1DailyVisitContinue(ctx);
  }
  ctx.lk1DailyVisitPrevious = guard;
  return lk1Find(ctx, "lk1_daily_visit_owner", { _id: guard.ownerOperationKey });
}
if (ctx.step === "lk1_daily_visit_owner") {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1) {
    return lk1Stop(ctx, "LK1_DAILY_VISIT_OWNER_UNRESOLVED");
  }
  const owner = msg.payload[0], guard = ctx.lk1DailyVisitPrevious;
  if (!guard || owner._id !== guard.ownerOperationKey || owner.operationId !== guard.ownerOperationId
    || owner.tenantKey !== ctx.tenantKey || normalizeId(owner.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)
    || owner.serviceDate !== ctx.serviceDate || owner.actorClientId !== ctx.actorClientId
    || owner.lk1?.decision?.subscriptionVisitCount !== 1) {
    return lk1Stop(ctx, "LK1_DAILY_VISIT_BINDING_INVALID");
  }
  const returnedNative = typeof lk1FreeReturnedOperation === "function" && lk1FreeReturnedOperation(owner);
  const existingGameLeave = owner.releaseSource === "GAME_LEAVE" && typeof owner.releaseOperationId === "string";
  const released = (returnedNative || existingGameLeave) && owner.state === "RELEASED" && typeof owner.releasedAt === "string"
    && Number.isFinite(Date.parse(owner.releasedAt))
    && !owner.lk1?.transactionAttemptedAt && !owner.lk1?.visitJob
    && ((owner.bookingId && owner.releaseBookingId === owner.bookingId
      && owner.releasedBookingIds?.includes(owner.bookingId))
      || owner.reconciliation?.decision === "SAFE_TO_RELEASE");
  const seatReleased = typeof lk1SeatReleasedOperation === "function" && lk1SeatReleasedOperation(owner);
  if (!released && !seatReleased && !(typeof lk1ReconciledVerified === "function" && lk1ReconciledVerified(ctx, owner))) {
    if (typeof lk1SeatStart === 'function') { const started = lk1SeatStart(ctx, owner); if (started) return started; }
    return lk1DailyVisitReject(ctx);
  }
  // No timeout/FAILED takeover: a failed owner can still retry its own operation.
  // RELEASED is terminal for that operation ID; a rejoin uses a new ID and CAS.
  ctx.step = "lk1_daily_visit_takeover";
  msg._subscriptionBooking = ctx;
  msg.payload = [{
    _id: guard._id, kind: guard.kind, ownerOperationKey: guard.ownerOperationKey,
    ownerOperationId: guard.ownerOperationId,
  }, { $set: { ownerOperationKey: ctx.operationKey, ownerOperationId: ctx.operationId } },
  { writeConcern: { w: "majority", j: true } }];
  delete msg.error;
  return emit(OUTPUT_MONGO_UPDATE);
}
if (ctx.step === "lk1_daily_visit_takeover") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Find(ctx, "lk1_daily_visit_read", { _id: lk1DailyVisitKey(ctx) });
  }
  return lk1DailyVisitContinue(ctx);
}
if (ctx.step === "lk1_daily_visit_conflict_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Stop(ctx, "LK1_DAILY_VISIT_CONFLICT_UNRESOLVED");
  }
  return finishError(ctx, 409, "Дневное посещение уже занято. Обновите стоимость записи.", {
    code: "LK1_DAILY_VISIT_CHANGED",
  });
}
if (ctx.step === "lk1_daily_visit_retry_saved") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    return lk1Stop(ctx, "LK1_DAILY_VISIT_RETRY_UNRESOLVED");
  }
  delete ctx.lk1DailyVisitRetry;
  return preparePreaccept(ctx);
}
