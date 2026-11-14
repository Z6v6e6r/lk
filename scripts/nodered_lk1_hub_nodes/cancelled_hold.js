// Executed inside the shared booking/preview usage step, after the zero-visit rule
// (ADR 0004). A CONFIRMED operation without money side effects stops holding the
// daily visit and free minutes once the same fresh (<= 60 s) self-API receipt proves
// its bound booking explicitly cancelled, whoever cancelled it. The receipt check is
// the zero-visit implementation itself, applied without its category/visit gate, so
// the provider proof has one implementation. Missing or stale evidence keeps the hold.
const lk1CancelledProviderHold = (operation) => {
  const lk1 = operation?.lk1, decision = lk1?.decision;
  if (operation?.state !== "CONFIRMED" || !isObj(lk1) || !isObj(decision)
    || ![0, 1].includes(decision.subscriptionVisitCount)
    || (decision.benefit?.finalPriceMinor ?? 0) !== 0
    || lk1.visitJob || operation.visitJob || operation.transactionId
    || ["transactionAttemptedAt", "transactionId", "transactionIntent", "checkout"].some(key => lk1[key] != null)
    || operation.managedEntitlementOperationId || operation.managedSubscriptionInstanceId
    || operation.activationState === "PENDING") return false;
  return lk1CancelledZeroVisitOperation({ ...operation, category: "group_training",
    lk1: { ...lk1, decision: { ...decision, subscriptionVisitCount: 0, gameMinutes: undefined, courtMinutes: undefined } } });
};
// The guard step runs after the receipt is gone: remember the exact owner documents
// this request proved cancelled, for the daily-visit takeover only.
const lk1RememberCancelledHold = (operation) => {
  ctx.lk1CancelledHolds = { ...(isObj(ctx.lk1CancelledHolds) ? ctx.lk1CancelledHolds : {}),
    [operation._id]: { owner: JSON.stringify(operation), observedAt: Date.now() } };
};
