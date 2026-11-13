// Legacy recovery only reads Viva and Mongo. The verified operation is retained
// in this request; neither old records nor visit counters are rewritten.
const lk1LegacyRequestBinding = ctx => JSON.stringify([ctx.tenantKey, ctx.actorClientId,
  ctx.clientSubscriptionId, ctx.operationId, ctx.exerciseId]);
const lk1LegacyVerified = (ctx, owner) => {
  const proof = ctx.lk1LegacyVerified;
  return proof && proof.request === lk1LegacyRequestBinding(ctx)
    && proof.owner === lk1LegacyCancellationSnapshot(owner)
    && Date.now() - proof.observedAt >= 0 && Date.now() - proof.observedAt <= 30000;
};
const lk1LegacyGet = (ctx, stage, path) => {
  const token = lk1FreeServiceToken();
  if (!token) return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_READ_UNAVAILABLE');
  ctx.lk1LegacyRecovery.stage = stage;
  ctx.lk1LegacyRecovery.url = VIVA_API_BASE + path;
  return prepareHttp(ctx, 'lk1_legacy_cancel_http', 'GET', VIVA_API_BASE + path,
    undefined, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
};
const lk1LegacyBegin = (ctx, owner) => {
  if (!lk1LegacyCancellationCandidate(owner) || owner.actorClientId !== ctx.actorClientId
    || owner.tenantKey !== ctx.tenantKey || owner.clientSubscriptionId !== ctx.clientSubscriptionId
    || (ctx.step === 'lk1_daily_visit_owner' && (owner.serviceDate !== ctx.serviceDate
      || owner.lk1.rule.productId !== ctx.lk1?.rule?.productId))) return null;
  if (lk1LegacyVerified(ctx, owner)) return null;
  if (ctx.lk1LegacyRecovery) return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_READ_UNAVAILABLE');
  ctx.lk1LegacyRecovery = { step: ctx.step, owner, request: lk1LegacyRequestBinding(ctx), startedAt: Date.now() };
  return lk1LegacyGet(ctx, 'booking', `/api/v1/clients/${encodeURIComponent(owner.actorClientId)}/bookings/${encodeURIComponent(owner.bookingId)}`);
};
if (ctx.step === 'lk1_legacy_cancel_http') {
  const recovery = ctx.lk1LegacyRecovery;
  if (!recovery || recovery.request !== lk1LegacyRequestBinding(ctx) || Date.now() - recovery.startedAt > 30000
    || msg.error || msg.statusCode !== 200 || msg.method !== 'GET'
    || msg.url !== recovery.url || msg.responseUrl !== recovery.url) return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_READ_UNAVAILABLE');
  const owner = recovery.owner;
  if (recovery.stage === 'booking') {
    // The exact client DTO must contain the full binding. Missing exercise ID
    // remains blocked rather than being invented from the requested route.
    if (lk1FreeBooking(msg.payload, lk1FreeBinding(owner))?.cancelled !== true) {
      return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_BOOKING_UNVERIFIED');
    }
    recovery.booking = msg.payload;
    return lk1LegacyGet(ctx, 'subscription', `/api/v1/clients/${encodeURIComponent(owner.actorClientId)}/subscriptions?includeFinished=true&size=200&page=0`);
  }
  if (recovery.stage !== 'subscription'
    || !lk1LegacyCancellationReadback(owner, recovery.booking, msg.payload)) {
    return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_RETURN_UNVERIFIED');
  }
  return lk1Find(ctx, 'lk1_legacy_cancel_owner_recheck', { _id: owner._id });
}
if (ctx.step === 'lk1_legacy_cancel_owner_recheck') {
  const recovery = ctx.lk1LegacyRecovery;
  if (!recovery || recovery.request !== lk1LegacyRequestBinding(ctx) || Date.now() - recovery.startedAt > 30000
    || msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || lk1LegacyCancellationSnapshot(msg.payload[0]) !== lk1LegacyCancellationSnapshot(recovery.owner)
    || !lk1LegacyCancellationCandidate(msg.payload[0])) return lk1Stop(ctx, 'LK1_LEGACY_CANCEL_OWNER_CHANGED');
  ctx.lk1LegacyVerified = { request: recovery.request, owner: lk1LegacyCancellationSnapshot(msg.payload[0]), observedAt: Date.now() };
  ctx.step = recovery.step;
  delete ctx.lk1LegacyRecovery;
}
if (['lk1_daily_visit_owner', 'lk1_ingress_operation_find', 'lk1_http_rejoin_predecessor_find'].includes(ctx.step)
  && ctx.caller === 'http' && ctx.action === 'book' && !ctx.trainingRegistration && !ctx.managedCreateBinding
  && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1) {
  const owner = msg.payload[0];
  // Existing ingress/predecessor handlers still validate the exact operation ID,
  // exercise and fingerprint before issuing a successor or entering fresh checks.
  const started = lk1LegacyBegin(ctx, owner);
  if (started) return started;
}
