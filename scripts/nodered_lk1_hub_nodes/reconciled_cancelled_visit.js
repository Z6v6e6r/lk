const lk1ReconciledRequest = ctx => JSON.stringify([ctx.tenantKey, ctx.actorClientId,
  ctx.clientSubscriptionId, ctx.operationId, ctx.exerciseId]);
const lk1ReconciledVerified = (ctx, owner) => {
  const proof = ctx.lk1ReconciledVerified;
  return lk1ReconciledCandidate(owner) && proof?.request === lk1ReconciledRequest(ctx)
    && proof.owner === JSON.stringify(owner)
    && Date.now() - proof.startedAt >= 0 && Date.now() - proof.startedAt <= 30000;
};
const lk1ReconciledGet = (ctx, stage, path) => {
  const token = lk1FreeServiceToken();
  if (!token) return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_READ_UNAVAILABLE');
  ctx.lk1ReconciledRecovery.stage = stage;
  ctx.lk1ReconciledRecovery.url = VIVA_API_BASE + path;
  return prepareHttp(ctx, 'lk1_reconciled_cancel_http', 'GET', VIVA_API_BASE + path,
    undefined, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
};
if (ctx.step === 'lk1_reconciled_cancel_http') {
  const s = ctx.lk1ReconciledRecovery;
  if (!s || s.request !== lk1ReconciledRequest(ctx) || Date.now() - s.startedAt > 30000
    || msg.error || msg.statusCode !== 200 || msg.method !== 'GET'
    || msg.url !== s.url || msg.responseUrl !== s.url) return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_READ_UNAVAILABLE');
  const owner = s.owner;
  if (s.stage === 'booking') {
    if (lk1FreeBooking(msg.payload, lk1FreeBinding(owner))?.cancelled !== true) {
      return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_BOOKING_UNVERIFIED');
    }
    s.booking = msg.payload;
    return lk1ReconciledGet(ctx, 'transaction', `/api/v1/transactions/${encodeURIComponent(owner.lk1.transactionId)}`);
  }
  if (s.stage === 'transaction') {
    s.transaction = msg.payload;
    return lk1ReconciledGet(ctx, 'subscription', `/api/v1/clients/${encodeURIComponent(owner.actorClientId)}/subscriptions?includeFinished=true&size=200&page=0`);
  }
  if (s.stage !== 'subscription' || !lk1ReconciledReadback(owner, s.booking, s.transaction, msg.payload, new Date().toISOString())) {
    return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_NONCONSUMPTION_UNVERIFIED');
  }
  return lk1Find(ctx, 'lk1_reconciled_cancel_owner_recheck', { _id: owner._id });
}
if (ctx.step === 'lk1_reconciled_cancel_owner_recheck') {
  const s = ctx.lk1ReconciledRecovery;
  if (!s || s.request !== lk1ReconciledRequest(ctx) || Date.now() - s.startedAt > 30000
    || msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || JSON.stringify(msg.payload[0]) !== JSON.stringify(s.owner)
    || !lk1ReconciledCandidate(msg.payload[0])) return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_OWNER_CHANGED');
  ctx.lk1ReconciledVerified = { request: s.request, owner: JSON.stringify(s.owner), startedAt: s.startedAt };
  ctx.step = 'lk1_daily_visit_owner';
  delete ctx.lk1ReconciledRecovery;
}
if (ctx.step === 'lk1_daily_visit_owner' && ctx.caller === 'split' && ctx.managedAction === 'JOIN_GAME'
  && !ctx.trainingRegistration && !ctx.managedCreateBinding && !msg.error
  && Array.isArray(msg.payload) && msg.payload.length === 1) {
  const owner = msg.payload[0];
  if (lk1ReconciledCandidate(owner) && owner.actorClientId === ctx.actorClientId
    && owner.tenantKey === ctx.tenantKey && owner.clientSubscriptionId === ctx.clientSubscriptionId
    && owner.serviceDate === ctx.serviceDate && owner.lk1.rule.productId === ctx.lk1?.rule?.productId
    && !lk1ReconciledVerified(ctx, owner)) {
    if (ctx.lk1ReconciledRecovery) return lk1Stop(ctx, 'LK1_RECONCILED_CANCEL_READ_UNAVAILABLE');
    ctx.lk1ReconciledRecovery = { owner, request: lk1ReconciledRequest(ctx), startedAt: Date.now() };
    return lk1ReconciledGet(ctx, 'booking', `/api/v1/clients/${encodeURIComponent(owner.actorClientId)}/bookings/${encodeURIComponent(owner.bookingId)}`);
  }
}
