// lk1Free* pure protocol is embedded from lib/lk1FreeCancellation.mjs.
const lk1FreeServiceToken = () => {
  try {
    const token = toStr(readGlobal('vivacrm_access_token'));
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof claims.exp === 'number' && claims.exp * 1000 > Date.now() + 60_000 ? token : null;
  } catch (_) { return null; }
};
const lk1FreeApplyEffect = (ctx, effect) => {
  if (effect.kind === 'reply') {
    delete ctx.lk1FreeCancellation;
    if (effect.status >= 400) return finishError(ctx, effect.status, effect.payload.message, effect.payload.details);
    msg._subscriptionBooking = ctx; msg.statusCode = effect.status;
    msg.headers = responseHeaders(); msg.payload = effect.payload;
    return emit(OUTPUT_FINAL);
  }
  if (effect.kind === 'find') {
    delete ctx.lk1FreeExpectedHttp;
    return lk1Find(ctx, 'lk1_free_cancel_effect', effect.query);
  }
  if (effect.kind === 'update') {
    delete ctx.lk1FreeExpectedHttp;
    if (effect.change.$set?.phase === 'CANCEL_INTENT' && !lk1FreeServiceToken()) {
      return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation, { error: true }));
    }
    ctx.step = 'lk1_free_cancel_effect'; msg._subscriptionBooking = ctx;
    msg.payload = [effect.query, effect.change, effect.options]; delete msg.error;
    return emit(OUTPUT_MONGO_UPDATE);
  }
  if (effect.kind === 'http') {
    const token = lk1FreeServiceToken();
    if (!token) return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation, { error: true }));
    ctx.lk1FreeExpectedHttp = { method: effect.method, url: VIVA_API_BASE + effect.path };
    return prepareHttp(ctx, 'lk1_free_cancel_effect', effect.method, VIVA_API_BASE + effect.path,
      effect.body, { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' });
  }
  return lk1Stop(ctx, 'LK1_FREE_CANCEL_EFFECT_INVALID');
};
const lk1FreeStart = (ctx, verifyOnly = false) => {
  const begun = lk1FreeBegin({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    bookingId: ctx.releaseBookingId, requestId: verifyOnly ? null : ctx.operationId, verifyOnly });
  ctx.lk1FreeCancellation = begun.state;
  return lk1FreeApplyEffect(ctx, begun.effect);
};
const lk1FreePrewriteGate = (ctx, continuation) => {
  ctx.lk1FreeGateContinuation = continuation;
  return lk1Find(ctx, 'lk1_free_cancel_booking_gate', { kind: 'LK1_FREE_CANCEL_JOB_V1',
    tenantKey: ctx.tenantKey, clientSubscriptionId: normalizeId(ctx.clientSubscriptionId),
    phase: { $in: lk1FreePending } });
};
const lk1SeatApplyEffect = (ctx, effect) => {
  if (effect.kind === 'reply') {
    const resume = ctx.lk1SeatContinuation;
    ctx.lk1SeatSeen = { ...ctx.lk1SeatSeen, [resume.ownerKey]: true };
    delete ctx.lk1SeatRecovery; delete ctx.lk1SeatContinuation; delete ctx.lk1SeatExpectedHttp;
    return lk1Find(ctx, resume.step, resume.step === 'lk1_usage_operations'
      ? { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, clientSubscriptionId: ctx.clientSubscriptionId }
      : { _id: resume.ownerKey });
  }
  if (effect.kind === 'find') return lk1Find(ctx, 'lk1_seat_recovery', effect.query);
  if (effect.kind === 'update') {
    ctx.step = 'lk1_seat_recovery'; msg._subscriptionBooking = ctx;
    msg.payload = [effect.query, effect.change, effect.options]; delete msg.error;
    return emit(OUTPUT_MONGO_UPDATE);
  }
  if (effect.kind === 'http' && effect.method === 'GET') {
    const token = lk1FreeServiceToken();
    if (!token) return lk1SeatApplyEffect(ctx, lk1FreeStep(ctx.lk1SeatRecovery, { error: true }));
    ctx.lk1SeatExpectedHttp = VIVA_API_BASE + effect.path;
    return prepareHttp(ctx, 'lk1_seat_recovery', 'GET', ctx.lk1SeatExpectedHttp,
      undefined, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
  }
  return lk1Stop(ctx, 'LK1_SEAT_EFFECT_INVALID');
};
const lk1SeatStart = (ctx, owner) => {
  if (!lk1SeatCandidate(owner) || ctx.lk1SeatSeen?.[owner._id]
    || owner.actorClientId !== ctx.actorClientId || owner.tenantKey !== ctx.tenantKey
    || normalizeId(owner.clientSubscriptionId) !== normalizeId(ctx.clientSubscriptionId)) return null;
  const begun = lk1FreeBegin({ tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
    bookingId: owner.bookingId || null, seatOnly: true, operationKey: owner._id,
    reservationKey: ctx.operationKey, requestId: `lk-seat-release:${owner.operationId.slice(0, 130)}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 12)}` });
  ctx.lk1SeatContinuation = { step: ctx.step, ownerKey: owner._id };
  ctx.lk1SeatRecovery = begun.state;
  return lk1SeatApplyEffect(ctx, begun.effect);
};
// FREE_CANCEL_STEPS
if (ctx.step === 'lk1_seat_recovery') {
  if (!ctx.lk1SeatRecovery || !ctx.lk1SeatContinuation) return lk1Stop(ctx, 'LK1_SEAT_CONTEXT_MISSING');
  const expected = ctx.lk1SeatExpectedHttp;
  const invalid = expected && (msg.method !== 'GET' || msg.url !== expected || msg.responseUrl !== expected);
  delete ctx.lk1SeatExpectedHttp;
  return lk1SeatApplyEffect(ctx, lk1FreeStep(ctx.lk1SeatRecovery,
    { payload: msg.payload, status: msg.statusCode, error: !!msg.error || !!invalid }));
}
if (['lk1_ingress_operation_find', 'lk1_http_rejoin_predecessor_find', 'lk1_rejoin_predecessor_find'].includes(ctx.step)
  && !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1) {
  const started = lk1SeatStart(ctx, msg.payload[0]);
  if (started) return started;
}
if (ctx.step === 'lk1_usage_operations' && !msg.error && Array.isArray(msg.payload)) {
  for (const owner of msg.payload) {
    if (owner?.serviceDate !== ctx.serviceDate || owner.state !== 'CONFIRMED') continue;
    const cancelled = ctx.lk1?.bookings?.some(row => (row.id || row.bookingId) === owner.bookingId
      && (row.isCancelled === true || row.cancelled === true));
    if (cancelled) { const started = lk1SeatStart(ctx, owner); if (started) return started; }
  }
}
if (ctx.step === 'lk1_profile_continue' && ctx.action === 'cancel-free') return lk1FreeStart(ctx);
if (ctx.step === 'lk1_free_cancel_effect') {
  if (!ctx.lk1FreeCancellation) return lk1Stop(ctx, 'LK1_FREE_CANCEL_CONTEXT_MISSING');
  const expected = ctx.lk1FreeExpectedHttp;
  const provenanceError = expected && (msg.method !== expected.method || msg.url !== expected.url || msg.responseUrl !== expected.url);
  delete ctx.lk1FreeExpectedHttp;
  return lk1FreeApplyEffect(ctx, lk1FreeStep(ctx.lk1FreeCancellation,
    { payload: msg.payload, status: msg.statusCode, error: !!msg.error || !!provenanceError }));
}
if (ctx.step === 'lk1_free_cancel_booking_gate') {
  if (msg.error || !Array.isArray(msg.payload)) return lk1Stop(ctx, 'LK1_FREE_CANCEL_GATE_READ_UNAVAILABLE');
  if (msg.payload.length) return finishError(ctx, 409,
    'Дождитесь подтверждения возврата посещения по отменяемой записи.', { code: 'LK1_FREE_CANCEL_RETURN_PENDING' });
  const continuation = ctx.lk1FreeGateContinuation;
  delete ctx.lk1FreeGateContinuation; ctx.lk1FreeGateCleared = true;
  return continuation === 'booking' ? prepareBookingCreate(ctx) : preparePreaccept(ctx);
}
