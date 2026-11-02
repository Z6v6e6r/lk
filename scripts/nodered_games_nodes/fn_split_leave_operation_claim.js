// Private capability traversal performs no journal or provider operation.
if (msg._managedLeaveCapability) {
  const cap = msg._managedLeaveCapability;
  if (cap.version !== 1 || cap.stage !== "claim") {
    msg.statusCode = 503; msg.payload = { code: "MANAGED_SELF_LEAVE_INCOMPATIBLE" };
    return [null, msg];
  }
  cap.stage = "router";
  return [null, null, msg];
}
const ctx = msg._splitLeaveCtx && typeof msg._splitLeaveCtx === "object" ? msg._splitLeaveCtx : null;
if (ctx?.monetaryAction) {
  const a = ctx.monetaryAction, before = ctx.monetarySelfLeave, o = before?.original;
  const deny = () => { msg.statusCode = 202; msg.payload = { ok: true, state: "RETRY_REQUIRED" }; return [null, msg]; };
  if (!o || before.version !== 1 || ctx.mode !== "SELF" || ctx.managedSelfLeaveOwner
    || ctx.backgroundRetry || ctx.backgroundStartedRecovery || !ctx.claimToken
    || ctx.actorClientId !== o.actorClientId || ctx.targetClientId !== o.actorClientId
    || ctx.operationId !== o.operationId || ctx.gameId !== o.gameId || ctx.exerciseId !== o.exerciseId
    || ctx.membershipVersion !== o.membershipVersion || ctx.operationKey !== `${o.gameId}:${o.operationId}`
    || !["STARTED", "MONETARY_DISPATCH_STARTED"].includes(ctx.operationState)) return deny();
  const now = new Date().toISOString();
  const query = { _id: ctx.operationKey, tenantKey: "iSkq6G", mode: "SELF",
    operationId: o.operationId, gameId: o.gameId, exerciseId: o.exerciseId,
    actorClientId: o.actorClientId, targetClientId: o.actorClientId,
    membershipVersion: o.membershipVersion, bookingIds: o.bookingIds,
    requestedRefundMethod: o.requestedRefundMethod, monetarySelfLeave: before,
    managedSelfLeaveOwner: { $exists: false }, state: ctx.operationState };
  const storedService = ctx.monetaryStoredService;
  if (!storedService || !Array.isArray(storedService.checks)) return deny();
  query.subscriptionReturnChecks = storedService.checks;
  query.clientSubscriptionId = storedService.clientSubscriptionId;
  query.subscriptionVisitCount = storedService.subscriptionVisitCount;
  query.subscriptionReturnState = storedService.subscriptionReturnState;
  const after = JSON.parse(JSON.stringify(before));
  let set = { updatedAt: now };
  if (a.kind === "recover") {
    if (ctx.operationState !== "MONETARY_DISPATCH_STARTED" || !before.markers.length
      || typeof a.previousClaimToken !== "string" || !a.previousClaimToken
      || !Number.isFinite(Date.parse(a.previousLeaseUntil))) return deny();
    query.claimToken = a.previousClaimToken; query.claimLeaseUntil = a.previousLeaseUntil;
    query.$expr = { $lte: [{ $convert: { input: "$claimLeaseUntil", to: "date", onError: null, onNull: null } }, "$$NOW"] };
    // Same-token continuation is not a recovery capability; every foreground retry gets a new claim.
    if (ctx.claimToken === a.previousClaimToken) return deny();
    ctx.monetaryLeaseUntil = new Date(Date.now() + 90_000).toISOString();
    set = { ...set, claimToken: ctx.claimToken, claimLeaseUntil: ctx.monetaryLeaseUntil };
  } else {
    query.claimToken = ctx.claimToken; query.claimLeaseUntil = ctx.monetaryLeaseUntil;
    query.$expr = { $gt: [{ $convert: { input: "$claimLeaseUntil", to: "date", onError: null, onNull: null } }, "$$NOW"] };
    if (!Number.isFinite(Date.parse(ctx.monetaryLeaseUntil))) return deny();
    if (a.kind === "dispatch") {
      if (!o.bookingIds.includes(a.bookingId) || before.markers.some(m => m.bookingId === a.bookingId)
        || before.readbacks.some(m => m.bookingId === a.bookingId)
        || before.markers.some(m => !before.readbacks.some(r => r.bookingId === m.bookingId))
        || !["CURRENCY", "DEPOSIT", "SERVICE"].includes(a.refundMethod)
        || (o.requestedRefundMethod && o.requestedRefundMethod !== a.refundMethod)) return deny();
      let baseline;
      if (a.refundMethod === "SERVICE") {
        const checks = Array.isArray(ctx.subscriptionReturnChecks) ? ctx.subscriptionReturnChecks : [];
        const exact = checks.filter(c => c?.bookingId === a.bookingId);
        baseline = exact[0];
        if (o.requestedRefundMethod !== null || exact.length !== 1 || !baseline
          || Object.keys(baseline).sort().join(",") !== "bookingId,clientSubscriptionId,expectedReturnCount,visitsLeftBefore"
          || typeof baseline.clientSubscriptionId !== "string" || !baseline.clientSubscriptionId.trim()
          || !Number.isSafeInteger(baseline.visitsLeftBefore) || baseline.visitsLeftBefore < 0
          || !Number.isSafeInteger(baseline.expectedReturnCount) || baseline.expectedReturnCount < 1
          || ctx.clientSubscriptionId !== baseline.clientSubscriptionId || ctx.subscriptionVisitCount !== baseline.expectedReturnCount
          || storedService.checks.some(c => c.bookingId === a.bookingId)
          || checks.length !== storedService.checks.length + 1
          || storedService.checks.some(c => !checks.some(n => Object.keys(c).every(k => c[k] === n[k])))) return deny();
        baseline = JSON.parse(JSON.stringify(baseline));
        set.subscriptionReturnChecks = [...JSON.parse(JSON.stringify(storedService.checks)), baseline];
        set.clientSubscriptionId = baseline.clientSubscriptionId;
        set.subscriptionVisitCount = baseline.expectedReturnCount;
        set.subscriptionReturnState = "RETURN_PENDING";
        set.subscriptionReturnReason = "monetary_service_readback_required";
      }
      after.markers.push({ bookingId: a.bookingId, dispatchId: `${o.operationId}:${a.bookingId}`,
        refundMethod: a.refundMethod, claimToken: ctx.claimToken, startedAt: now,
        ...(baseline ? { subscriptionBaseline: baseline } : {}) });
      set.state = "MONETARY_DISPATCH_STARTED";
      set.moneyRefundState = "UNVERIFIED";
    } else if (a.kind === "readback") {
      if (ctx.operationState !== "MONETARY_DISPATCH_STARTED" || !Array.isArray(a.cancelledBookingIds)
        || a.cancelledBookingIds.some(id => !o.bookingIds.includes(id))
        || before.markers.some(m => !a.cancelledBookingIds.includes(m.bookingId))) return deny();
      for (const bookingId of a.cancelledBookingIds) if (!after.readbacks.some(r => r.bookingId === bookingId)) {
        after.readbacks.push({ bookingId, verifiedAt: now, source: "VIVA_BOOKING_READBACK" });
      }
    } else return deny();
    after.revision++;
    if (!Number.isSafeInteger(after.revision)) return deny();
    set.monetarySelfLeave = after;
  }
  ctx.monetaryNext = after;
  ctx.monetaryNextService = a.refundMethod === "SERVICE" ? {
    checks: set.subscriptionReturnChecks, clientSubscriptionId: set.clientSubscriptionId,
    subscriptionVisitCount: set.subscriptionVisitCount, subscriptionReturnState: set.subscriptionReturnState,
  } : JSON.parse(JSON.stringify(storedService));
  msg.payload = [query, { $set: set }, {}];
  return [msg, null];
}
if (ctx?.managedSelfLeaveReclaim) {
  const claim = ctx.managedSelfLeaveReclaim;
  const now = new Date().toISOString();
  if (!ctx.claimToken || ctx.claimToken === claim.previousClaimToken || ctx.mode !== "SELF"
    || ctx.actorClientId !== ctx.targetClientId || ctx.subscriptionReturnState !== "RETURN_VERIFIED"
    || !["VIVA_CONFIRMED", "LK_APPLIED"].includes(claim.state)
    || !Number.isFinite(Date.parse(claim.previousLeaseUntil)) || Date.parse(claim.previousLeaseUntil) > Date.now()) {
    msg.statusCode = 202; msg.payload = { ok: true, state: "IN_PROGRESS" }; return [null, msg];
  }
  msg.payload = [{ _id: ctx.operationKey, operationId: ctx.operationId, tenantKey: "iSkq6G", mode: "SELF",
    actorClientId: ctx.actorClientId, targetClientId: ctx.actorClientId, gameId: ctx.gameId, exerciseId: ctx.exerciseId,
    state: claim.state, localApplyClaimToken: claim.previousClaimToken,
    localApplyLeaseUntil: claim.previousLeaseUntil, membershipVersion: claim.membershipVersion,
    bookingIds: [claim.bookingId], clientSubscriptionId: claim.clientSubscriptionId,
    subscriptionReturnState: "RETURN_VERIFIED", vivaVerification: "active_absent_history_cancelled",
    ...(ctx.managedSelfLeaveOwner ? { managedSelfLeaveOwner: ctx.managedSelfLeaveOwner } : {}) },
  { $set: { localApplyClaimToken: ctx.claimToken, localApplyLeaseUntil: new Date(Date.now() + 90_000).toISOString(),
    lastAttemptAt: now, updatedAt: now }, $inc: { localApplyAttempts: 1 } }, {}];
  return [msg, null];
}
if (!ctx || !ctx.operationKey || !ctx.claimToken || ctx.operationState !== "STARTED") {
  msg.statusCode = 202;
  msg.payload = { ok: true, state: "IN_PROGRESS", message: "Operation claim unavailable" };
  return [null, msg];
}
const nowIso = new Date().toISOString();
const leaseUntilIso = new Date(Date.now() + 90_000).toISOString();
const staleLease = ctx.previousClaimLeaseUntil
  ? { $lte: nowIso }
  : { $in: [null, ""] };
const claimFilter = {
  _id: ctx.operationKey,
  state: "STARTED",
  claimToken: ctx.previousClaimToken || { $in: [null, ""] },
};
if (ctx.managedSelfLeaveOwner) {
  claimFilter.tenantKey = ctx.managedSelfLeaveOwner.tenantKey;
  claimFilter.mode = "SELF";
  claimFilter.actorClientId = ctx.managedSelfLeaveOwner.providerClientId;
  claimFilter.membershipVersion = ctx.managedSelfLeaveOwner.membershipVersion;
  claimFilter.bookingIds = [ctx.managedSelfLeaveOwner.providerBookingId];
  claimFilter.managedSelfLeaveOwner = ctx.managedSelfLeaveOwner;
}
if (ctx.monetarySelfLeave) {
  const o = ctx.monetarySelfLeave.original;
  claimFilter.tenantKey = "iSkq6G"; claimFilter.mode = "SELF";
  claimFilter.actorClientId = o.actorClientId; claimFilter.targetClientId = o.actorClientId;
  claimFilter.gameId = o.gameId; claimFilter.exerciseId = o.exerciseId;
  claimFilter.operationId = o.operationId; claimFilter.membershipVersion = o.membershipVersion;
  claimFilter.bookingIds = o.bookingIds; claimFilter.monetarySelfLeave = ctx.monetarySelfLeave;
  claimFilter.managedSelfLeaveOwner = { $exists: false };
  claimFilter.$expr = { $lte: [{ $convert: { input: "$claimLeaseUntil", to: "date", onError: null, onNull: null } }, "$$NOW"] };
  claimFilter.claimLeaseUntil = ctx.previousClaimLeaseUntil;
  ctx.monetaryLeaseUntil = leaseUntilIso;
} else if (ctx.foregroundReclaim !== true) claimFilter.claimLeaseUntil = staleLease;
msg.payload = [
  claimFilter,
  {
    $set: {
      claimToken: ctx.claimToken,
      claimLeaseUntil: leaseUntilIso,
      lastAttemptAt: nowIso,
      updatedAt: nowIso,
    },
    ...(ctx.foregroundReclaim === true ? { $inc: { foregroundRecoveryAttempts: 1 } } : {}),
  },
  {},
];
return [msg, null];
