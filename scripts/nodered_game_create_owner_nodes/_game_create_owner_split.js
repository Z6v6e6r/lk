function quarterCreateSplitPrepare() {
  const owner = msg._gameCreateOwner;
  if (msg._quarterCreateCapability !== undefined) {
    const cap = msg._quarterCreateCapability;
    if (cap.version !== 1 || cap.stage !== 'split_prepare' || owner?.step !== 'capability_return'
      || cap.nonce !== owner.capabilityNonce) return [null, msg, null, null];
    cap.stage = 'split_router'; msg._splitCtx = { quarterCapability: true };
    return [null, null, null, msg];
  }
  if (!owner || owner.mode !== 'admit' || owner.step !== 'canonical_callback'
    || !gcoStoredMatches(owner.row, owner.claims, gcoBodyHash(owner.body))
    || owner.row.phase !== 'CREATE_ATTEMPTING' || !gcObject(owner.row.binding)
    || !bookedOperationTokenBindingMatches(owner.actorToken, owner.claims.actor_token_sha256)) return [null, msg, null, null];
  const b = owner.row.binding, i = b.identity, p = b.body.preparation;
  if (Date.parse(owner.claims.actor_token_expires_at) <= Date.now() || owner.claims.exp * 1000 <= Date.now()) return [null, msg, null, null];
  let adminToken; try { adminToken = global.get('vivacrm_access_token'); } catch { adminToken = null; }
  if (typeof adminToken !== 'string' || !BOOKED_OP_ACTOR_TOKEN.test(adminToken)) return [null, msg, null, null];
  const start = gcMoscow(p.target.startsAt), end = gcMoscow(p.target.endsAt);
  msg.req.headers['idempotency-key'] = i.operationId;
  msg._splitCtx = { action: 'create', step: 'quarter_owner_start', operationId: i.operationId,
    managedCreateBinding: b, userAuthHeader: 'Bearer ' + owner.actorToken, token: adminToken,
    clientId: i.providerClientId, clientSubscriptionId: i.providerClientSubscriptionId,
    studioId: i.providerStationId, roomId: i.providerRoomId,
    verifiedStudioId: i.providerStationId, verifiedRoomId: i.providerRoomId,
    date: start.slice(0, 10), fromTime: start.slice(11, 19), toTime: end.slice(11, 19),
    durationMinutes: 60, shareCount: 4, maxClientsCount: 4, spot: 1, subscriptionVisitCount: 1,
    shareAmount: p.pricing.quarterPriceMinor / 100, totalAmount: p.pricing.courtWindowPriceMinor / 100,
    masterServiceId: p.pricing.masterServiceId, subServiceIds: p.pricing.subServiceIds,
    vivaDirectionId: 4588, vivaExerciseTypeId: 1613, paymentMode: 'subscription', selectedPaymentMode: 'subscription' };
  msg._subscriptionBooking = { caller: 'split_create_preflight', action: 'book', step: 'quarter_owner_start',
    tenantKey: i.tenantKey, operationId: i.operationId, actorClientId: i.providerClientId,
    clientSubscriptionId: i.providerClientSubscriptionId, authHeader: 'Bearer ' + owner.actorToken,
    exerciseId: 'split-create:' + i.operationId, category: 'open_game', planKey: 'quarter_create', limitMode: 'shared_day',
    serviceDate: start.slice(0, 10), operationKey: i.tenantKey + ':' + i.providerClientSubscriptionId + ':' + start.slice(0, 10),
    managedCreateBinding: b, managedAction: 'CREATE_GAME', managedRuntime: b.runtime,
    managedEnforcement: { enabled: true, environment: 'PROD' }, managedEnvironment: 'PROD',
    managedActivationRequired: b.runtime.instance.state === 'PENDING_ACTIVATION',
    managedActivationExpectedRevision: b.runtime.evidence.instanceRevision,
    managedTarget: { stationId: i.providerStationId, roomId: i.providerRoomId, category: 'GAME',
      externalEventTypeId: 'viva:direction:4588:type:1613', productTypeId: null, durationMinutes: 60,
      startsAt: p.target.startsAt, basePriceMinor: p.pricing.quarterPriceMinor, currency: 'RUB' },
    subscriptionVisitCount: 1, spot: 1 };
  return [null, null, null, msg];
}
function quarterCreateSplit(ctx) {
  const owner = msg._gameCreateOwner;
  if (msg._quarterCreateCapability !== undefined) {
    const cap = msg._quarterCreateCapability;
    if (cap.version !== 1 || cap.stage !== 'split_router' || owner?.step !== 'capability_return'
      || cap.nonce !== owner.capabilityNonce) return [null, msg, null, null];
    cap.stage = 'gateway_prepare'; msg._quarterCreateBridge = 'prepare';
    return [null, null, null, msg];
  }
  if (!owner || !gcoStoredMatches(owner.row, owner.claims, ctx.managedCreateBinding?.admissionRequestSha256)
    || !gcoEqual(ctx.managedCreateBinding, owner.row.binding)) return [null, msg, null, null];
  const b = ctx.managedCreateBinding;
  const bridge = () => {
    for (const key of ['method', 'url', 'headers', 'responseUrl', 'requestTimeout', 'payload', 'error', 'statusCode']) delete msg[key];
    msg._quarterCreateBridge = 'router'; return [null, null, null, msg];
  };
  if (ctx.step === 'quarter_owner_start') return bridge();
  if (ctx.step === 'managed_create_preflight_complete') {
    const reservation = ctx.managedCreateReservation;
    if (!reservation || !reservation.quarterAttemptId || ctx.managedCreateAttemptBound !== true
      || !gcoEqual(reservation.managedCreateBinding, b) || ctx.managedCreateRecoveredExerciseId
      || Date.parse(b.body.preparation.expiresAt) <= Date.now()) return [null, msg, null, null];
    delete msg.statusCode; delete msg.error; delete msg.responseUrl;
    return continueSplitAfterVerifiedPrice(ctx); // The existing sole /exercises POST.
  }
  if (ctx.step === 'create_exercise') {
    const exactTransport = !msg.error && msg.responseUrl === ADMIN_API + '/exercises' && msg.url === msg.responseUrl;
    if (!exactTransport || !isOk(msg.statusCode)) {
      if (exactTransport && [400, 401, 403, 404, 405, 410, 415, 422].includes(msg.statusCode)) {
        const aborted = abortManagedCreateReservation(ctx, msg.statusCode, 'CREATE rejected', { code: 'VIVA_EXERCISE_CREATE_REJECTED' });
        // The existing helper's fourth output historically led directly to HTTP.
        // Quarter compensation must instead enter the canonical durable rejection owner.
        return aborted[3] ? bridge() : aborted;
      }
      return [null, msg, null, null]; // Includes 409, timeout and incomplete/redirected ACK. No adoption.
    }
    const exerciseId = gcAlias(msg.payload, ['id', 'exerciseId']);
    if (!exerciseId || !gcoActive(msg.payload) || (msg.payload.roomId !== undefined && msg.payload.roomId !== b.identity.providerRoomId)
      || (msg.payload.room?.id !== undefined && msg.payload.room.id !== b.identity.providerRoomId)) return [null, msg, null, null];
    const reservation = ctx.managedCreateReservation;
    if (!reservation?.quarterAttemptId || !gcoEqual(reservation.managedCreateBinding, b)) return [null, msg, null, null];
    ctx.exerciseId = exerciseId; ctx.ownsExercise = true;
    msg._subscriptionBooking = { ...reservation, step: 'quarter_create_response',
      providerCreateReceipt: { schemaVersion: 1, operationId: b.identity.operationId,
        admissionRequestSha256: b.admissionRequestSha256, attemptId: reservation.quarterAttemptId,
        exerciseId, observedAt: new Date().toISOString() } };
    return bridge();
  }
  return [null, msg, null, null];
}
