// A successor is selected by a later explicit click, never by a polling retry.
const lk1HttpRejoinIdentity = id => {
  const match = typeof id === "string" && /^(lk-subscription-[a-z0-9]+)(?::rejoin:([1-9]\d{0,3}))?$/.exec(id);
  return match && Number(match[2] || 0) <= 1000
    ? { base: match[1], generation: Number(match[2] || 0) } : null;
};
const lk1HttpRejoinPrevious = id => {
  const value = lk1HttpRejoinIdentity(id);
  return value?.generation > 0
    ? (value.generation === 1 ? value.base : `${value.base}:rejoin:${value.generation - 1}`) : null;
};
const lk1HttpRejoinRequest = ctx => ctx.caller === "http" && ctx.action === "book";
const lk1SafeCancelledUnpaidSuccessor = operation => {
  const proof = operation.lk1?.cancelledAllowanceRelease;
  const checkout = operation.lk1?.checkout;
  const intent = operation.lk1?.transactionIntent;
  const identity = lk1HttpRejoinIdentity(operation.operationId);
  const previousId = lk1HttpRejoinPrevious(operation.operationId);
  return identity && identity.generation < 1000 && operation.state === "RELEASED"
    && ["group_training", "tournament"].includes(operation.category)
    && (operation.releaseReason === "CANCELLED_UNPAID_BOOKING" ? !operation.lk1?.unpaidCancellation
      : operation.releaseReason === "LK1_UNPAID_CHECKOUT_EXPIRED"
        && operation.lk1?.unpaidCancellation?.phase === "CANCELLED"
        && operation.lk1.unpaidCancellation.verifiedAt === operation.releasedAt)
    && operation.lk1?.decision?.subscriptionVisitCount === 0 && !operation.lk1?.visitJob
    && proof?.schemaVersion === 1
    && proof.proofId === operation.operationId && proof.bookingState === "CANCELLED"
    && proof.transactionState === "UNPAID_EXPIRED" && proof.verifiedAt === operation.releasedAt
    && Number.isFinite(Date.parse(proof.verifiedAt))
    && proof.bookingId === operation.bookingId && proof.transactionId === checkout?.transactionId
    && proof.transactionId === operation.lk1.transactionId
    && intent?.bookingId === operation.bookingId && intent.actorClientId === operation.actorClientId
    && Number.isSafeInteger(proof.amountMinor) && proof.amountMinor > 0
    && proof.amountMinor === checkout.toPayMinor && proof.amountMinor === intent.chargeMinor
    && proof.amountMinor === operation.lk1.decision.benefit?.finalPriceMinor
    && (!operation.upstreamBookingId || operation.upstreamBookingId === operation.bookingId)
    && operation.serviceDate === operation.lk1.target?.startsAt?.slice(0, 10)
    && (!previousId || (operation.rejoinPredecessor?.rootOperationId === identity.base
      && operation.rejoinPredecessor?.operationId === previousId));
};
if (ctx.step === "lk1_http_rejoin_predecessor_find") {
  const previousId = lk1HttpRejoinPrevious(ctx.operationId);
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || !lk1HttpRejoinRequest(ctx) || !previousId
    || !lk1ReplayIdentityMatches(ctx, msg.payload[0], previousId)
    || !lk1SafeCancelledUnpaidSuccessor(msg.payload[0])) {
    return lk1Stop(ctx, "LK1_RELEASE_RECONCILIATION_REQUIRED");
  }
  const previous = msg.payload[0];
  ctx.lk1Rejoin = { operationId: previousId, rootOperationId: lk1HttpRejoinIdentity(ctx.operationId).base,
    bookingId: previous.bookingId, releaseOperationId: previous.lk1.cancelledAllowanceRelease.proofId,
    releasedAt: previous.releasedAt };
  delete ctx.lk1IngressReplay;
  ctx.step = "lk1_profile_continue";
}
