// Composed into the existing canonical subscription router; uses its HTTP/Mongo/proof owner.
function quarterCreateGateway(ctx) {
  const owner = msg._gameCreateOwner, binding = ctx.managedCreateBinding;
  const pending = (code = 'GAME_CREATE_OWNER_RECONCILIATION_REQUIRED') => finishPending(ctx,
    'Создание требует сверки исходной операции', { code });
  const capturingOriginalResponse = ['quarter_create_response', 'quarter_create_response_ack', 'quarter_create_response_read'].includes(ctx.step);
  if (!owner || owner.mode !== 'admit' || !gcoStoredMatches(owner.row, owner.claims, binding?.admissionRequestSha256)
    || !gcoEqual(owner.row.binding, binding) || !bookedOperationTokenBindingMatches(owner.actorToken, owner.claims.actor_token_sha256)
    || (!capturingOriginalResponse && (Date.parse(owner.claims.actor_token_expires_at) <= Date.now() || owner.claims.exp * 1000 <= Date.now()))
    || (!capturingOriginalResponse && !managedJoinV2SignerReady())) return pending('GAME_CREATE_OWNER_BINDING_REQUIRED');
  const identity = binding.identity, p = binding.body.preparation;
  if (ctx.operationId !== identity.operationId || ctx.tenantKey !== identity.tenantKey
    || ctx.actorClientId !== identity.providerClientId || ctx.clientSubscriptionId !== identity.providerClientSubscriptionId
    || ctx.authHeader !== 'Bearer ' + owner.actorToken) return pending('GAME_CREATE_OWNER_BINDING_REQUIRED');
  const find = (step, query) => {
    ctx.step = step; msg.payload = query; delete msg.error;
    for (const k of ['method', 'url', 'headers', 'responseUrl', 'statusCode']) delete msg[k];
    return emit(OUTPUT_MONGO_FIND);
  };
  const canonicalFind = () => find('quarter_operation', { _id: ctx.operationKey });
  const freshCapsule = () => Date.parse(p.observedAt) <= Date.now() && Date.parse(p.expiresAt) > Date.now()
    && Date.parse(p.target.startsAt) > Date.now();
  const abortFind = () => find('quarter_unused_abort_read', { _id: ctx.operationKey, operationId: ctx.operationId,
    tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, managedCreateBinding: binding });
  const abortReadback = () => {
    const config = managedEntitlementConfig();
    if (!validManagedEntitlementConfig(config, ctx)) return pending();
    return prepareManagedHttp(ctx, 'quarter_unused_readback', 'POST', `${config.apiBase}/internal/subscriptions/entitlements/readback`,
      { operationId: ctx.managedEntitlementOperationId, subscriptionInstanceId: ctx.managedSubscriptionInstanceId }, managedEntitlementHeaders(ctx, config));
  };
  if (ctx.step === 'quarter_unused_abort_ack' || ctx.step === 'quarter_unused_release_ack') return abortFind();
  if (ctx.step === 'quarter_unused_abort_read') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1) return pending();
    const row = msg.payload[0];
    if (!gcoUnusedMarkerMatches(row, owner.row)) return pending();
    ctx.quarterOriginal = row; ctx.quarterUnusedAbort = row.quarterPrecreateAbort;
    ctx.managedEntitlementOperationId = row.managedEntitlementOperationId;
    ctx.managedSubscriptionInstanceId = row.managedSubscriptionInstanceId;
    if (row.state === 'RELEASED') {
      if (!gcoUnusedCanonicalRejection(row, owner.row)) return pending();
      return finishError(ctx, 422, 'Срок подготовки истёк; резерв освобождён', { code: gcoUnusedReason });
    }
    if (row.state !== 'PRECREATE_ABORTING' || Object.hasOwn(row, 'managedCreateReleaseProof')) return pending();
    // Fresh reading of an irreversible no-dispatch marker may authorize a new short-lived
    // release-v1 proof. Its abortedAt/capsule expiry are immutable, never refreshed.
    recordOwnerReadback(ctx, gcoUnusedReason, null);
    return prepareManagedEntitlementRelease(ctx, gcoUnusedReason);
  }
  if (ctx.step === 'managed_entitlement_release' && ctx.quarterUnusedAbort) return abortReadback();
  if (ctx.step === 'quarter_unused_readback') {
    const r = msg.payload, marker = ctx.quarterUnusedAbort, config = managedEntitlementConfig();
    if (msg.error || msg.statusCode !== 200 || msg.responseUrl !== `${config.apiBase}/internal/subscriptions/entitlements/readback`
      || !gcoUnusedMarkerMatches(ctx.quarterOriginal, owner.row)
      || !gcKeys(r, 'schemaVersion,operationId,subscriptionInstanceId,operationState,compensationState,releaseReason,providerBookingId')
      || r.schemaVersion !== 1 || r.operationId !== marker.usageOperationId || r.subscriptionInstanceId !== marker.subscriptionInstanceId
      || r.operationState !== 'FAILED' || r.compensationState !== 'APPLIED' || r.releaseReason !== gcoUnusedReason || r.providerBookingId !== null) return pending();
    return prepareMongoUpdate(ctx, 'quarter_unused_release_ack', { ...ctx.quarterOriginal, state: 'PRECREATE_ABORTING',
      managedCreateReleaseProof: { $exists: false } }, { $set: { state: 'RELEASED', releaseReason: gcoUnusedReason,
        managedCreateReleaseProof: { schemaVersion: 1, observedAt: new Date().toISOString(), readback: r },
        releasedAt: new Date().toISOString(), updatedAt: new Date().toISOString() } });
  }
  if (ctx.step === 'quarter_owner_start') {
    return find('quarter_authority', { _id: binding.admissionId, tenant_id: identity.tenantId,
      kind: 'GAME_CREATE_ADMISSION', phase: 'CREATE_ATTEMPTING', admissionRequestSha256: binding.admissionRequestSha256 });
  }
  if (ctx.step === 'quarter_authority') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
      || !gcoStoredMatches(msg.payload[0], owner.claims, binding.admissionRequestSha256)
      || !gcoEqual(msg.payload[0].binding, binding) || msg.payload[0].dispatchId !== owner.row.dispatchId) return pending();
    return canonicalFind();
  }
  if (ctx.step === 'quarter_inserted' || ctx.step === 'operation_preaccept'
    || ctx.step === 'operation_entitlement_bind' || ctx.step === 'operation_reclaim') return canonicalFind();
  if (ctx.step === 'quarter_reclaim_authority') {
    const old = ctx.quarterReclaim;
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1 || !old || !freshCapsule()) return pending();
    const prior = msg.payload[0], receipt = gcoCanonicalRejection(old, prior);
    if (prior.phase !== 'CREATE_REJECTED' || !gcoBindingMatches(prior)
      || !gcoEqual(prior.binding, old.managedCreateBinding) || !receipt
      || !(receipt.schemaVersion === 2 ? gcoRejectionReceiptMatches(prior.rejectionReceipt, prior)
        && prior.rejectionReceiptSha256 === gcoUnusedReceiptDigest(receipt)
        : gcoEqual(prior.rejectionReceipt, receipt))) return pending('GAME_CREATE_OWNER_RECLAIM_REQUIRED');
    return prepareOperationReclaim(ctx, old);
  }
  if (ctx.step === 'quarter_operation') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return pending();
    const row = msg.payload[0];
    if (!row) {
      if (owner.recoveryOnly || !freshCapsule()) return pending('GAME_CREATE_OWNER_ORIGINAL_OPERATION_UNKNOWN');
      ctx.step = 'quarter_inserted';
      msg.payload = { _id: ctx.operationKey, tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
        clientSubscriptionId: ctx.clientSubscriptionId, serviceDate: ctx.serviceDate, operationId: ctx.operationId,
        exerciseId: ctx.exerciseId, category: 'open_game', planKey: 'quarter_create', limitMode: 'shared_day',
        state: 'PREPARED', attempts: 0, managedCreateBinding: binding, managedEnvironment: 'PROD',
        activationState: ctx.managedActivationRequired ? 'PENDING' : 'NOT_REQUIRED',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      return emit(OUTPUT_MONGO_INSERT);
    }
    if (!gcoCanonicalMatches(row, owner.row)) {
      const previous = row.managedCreateBinding?.identity;
      if (!owner.recoveryOnly && freshCapsule() && row.state === 'RELEASED' && row.operationId !== ctx.operationId
        && previous && previous.tenantId === identity.tenantId && previous.userId === identity.userId
        && previous.tenantKey === identity.tenantKey && previous.providerClientId === identity.providerClientId
        && previous.providerClientSubscriptionId === identity.providerClientSubscriptionId
        && row.serviceDate === ctx.serviceDate && !row.providerCreateReceipt && !row.bookingId && !row.upstreamBookingId
        && row.exerciseId === 'split-create:' + row.operationId) {
        ctx.quarterReclaim = row;
        return find('quarter_reclaim_authority', { _id: row.managedCreateBinding.admissionId,
          tenant_id: identity.tenantId, kind: 'GAME_CREATE_ADMISSION', phase: 'CREATE_REJECTED' });
      }
      return pending('GAME_CREATE_OWNER_ORIGINAL_OPERATION_CONFLICT');
    }
    ctx.quarterOriginal = row;
    ctx.managedDecision = row.managedDecision || null;
    ctx.managedEntitlementOperationId = row.managedEntitlementOperationId || null;
    ctx.managedSubscriptionInstanceId = row.managedSubscriptionInstanceId || binding.runtime.subscriptionInstanceId;
    ctx.managedEntitlementConfirmed = row.managedEntitlementState === 'CONFIRMED';
    ctx.managedActivationRequired = binding.runtime.instance.state === 'PENDING_ACTIVATION' && row.activationState !== 'CONFIRMED';
    if (row.state === 'PREPARED') {
      if (!freshCapsule()) return pending('GAME_CREATE_OWNER_CAPSULE_EXPIRED_BEFORE_DISPATCH');
      return preparePreaccept(ctx);
    }
    if (row.state === 'PRECREATE_RESERVING') {
      // Exact original reserve is idempotent, including after response loss; never re-preflight.
      return prepareManagedEntitlementReserve(ctx);
    }
    if (row.state === 'PRECREATE_ABORTING' || (row.state === 'RELEASED' && row.quarterPrecreateAbort)) return abortFind();
    if (row.state === 'PRECREATE_RESERVED') {
      if (!freshCapsule()) {
        if (!gcoUnusedOriginal(row, owner.row) || Date.parse(p.expiresAt) > Date.now()
          || Object.hasOwn(row, 'quarterPrecreateAbort') || Object.hasOwn(row, 'managedCreateReleaseProof')) return pending();
        const marker = { schemaVersion: 1, reason: gcoUnusedReason, abortId: nodeCrypto.randomUUID(), operationId: ctx.operationId,
          admissionRequestSha256: binding.admissionRequestSha256, capsuleSha256: p.sha256, capsuleExpiresAt: p.expiresAt,
          subscriptionInstanceId: row.managedSubscriptionInstanceId, usageOperationId: row.managedEntitlementOperationId,
          decisionSha256: gcHash(JSON.stringify(row.managedDecision)) };
        const clock = { $dateToString: { date: '$$NOW', format: '%Y-%m-%dT%H:%M:%S.%LZ', timezone: 'UTC' } };
        // Single Mongo-clock CAS competes with RESERVED→ATTEMPTING. No release before an exact readback.
        return prepareMongoUpdate(ctx, 'quarter_unused_abort_ack', { ...row, state: 'PRECREATE_RESERVED',
          ...Object.fromEntries([...gcoUnusedAbsent, 'quarterPrecreateAbort', 'managedCreateReleaseProof'].map(k => [k, { $exists: false }])),
          $expr: { $lte: [{ $dateFromString: { dateString: { $literal: p.expiresAt } } }, '$$NOW'] } },
          [{ $set: { state: 'PRECREATE_ABORTING', quarterPrecreateAbort: { $mergeObjects: [{ $literal: marker }, { abortedAt: clock }] }, updatedAt: clock } }]);
      }
      ctx.quarterAttemptId = nodeCrypto.randomUUID();
      return preparePrecreatedAttempt(ctx);
    }
    if (['PRECREATE_ATTEMPTING', 'PENDING_CONFIRMATION', 'CONFIRMED'].includes(row.state)) {
      const created = row.providerCreateReceipt;
      if (!gcObject(created) || created.schemaVersion !== 1 || created.operationId !== ctx.operationId
        || created.admissionRequestSha256 !== binding.admissionRequestSha256 || !gcId(created.exerciseId)
        || created.exerciseId !== row.exerciseId || !gcIso(created.observedAt)) return pending('GAME_CREATE_OWNER_PROVIDER_ACK_UNKNOWN');
      ctx.exerciseId = row.exerciseId; ctx.providerCreateReceipt = created;
      ctx.precreateRecoveryTarget = row.precreateRecoveryTarget;
      ctx.precreatedEntitlementReserved = true; ctx.caller = 'split';
      if (row.state === 'PRECREATE_ATTEMPTING') {
        // No organizer write marker exists yet; promotion CAS remains the single booking fence.
        return prepareUserGet(ctx, 'quarter_organizer_profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
      }
      ctx.quarterRecoveryOnly = true;
      ctx.immediateBookingId = row.bookingId || row.upstreamBookingId || null;
      return prepareUserGet(ctx, 'quarter_recovery_bookings', `/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`);
    }
    if (row.state === 'PRECREATE_RECONCILIATION_REQUIRED' || row.state === 'RELEASED') {
      if (row.precreateRejection) return resumePrecreateRejection(ctx, row);
      return pending();
    }
    return pending();
  }
  if (ctx.step === 'managed_entitlement_reserve') {
    const r = msg.payload;
    if (msg.error || msg.statusCode !== 200
      || msg.responseUrl !== `${managedEntitlementConfig().apiBase}/internal/subscriptions/entitlements/reserve`
      || !isObj(r) || r.schemaVersion !== 1 || r.outcome !== 'RESERVED' || !gcId(r.operationId)
      || r.subscriptionInstanceId !== binding.runtime.subscriptionInstanceId || !Number.isSafeInteger(r.aggregateRevision)
      || r.aggregateRevision < 1 || !['RESERVED', 'CONFIRMED'].includes(r.operationState)
      || typeof r.replayed !== 'boolean' || (r.operationState === 'CONFIRMED' && !r.replayed)
      || !Array.isArray(r.blockers) || r.blockers.length !== 0 || !validEntitlementDecision(ctx, r.decision)
      || r.decision.money.finalPriceMinor !== 0 || r.decision.money.basePriceMinor !== p.pricing.quarterPriceMinor
      || r.decision.usageUnits !== 1) return pending('GAME_CREATE_OWNER_RESERVE_ACK_UNKNOWN');
    ctx.managedEntitlementOperationId = r.operationId; ctx.managedDecision = r.decision;
    return prepareManagedEntitlementBind(ctx);
  }
  if (ctx.step === 'operation_precreated_attempt') {
    // Exact same-process nonce survives ACK loss; another request must never adopt dispatch authority.
    return find('quarter_attempt_read', { _id: ctx.operationKey, operationId: ctx.operationId,
      managedCreateBinding: binding, state: 'PRECREATE_ATTEMPTING', providerCreateAttemptId: ctx.quarterAttemptId });
  }
  if (ctx.step === 'quarter_attempt_read') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1 || !ctx.quarterAttemptId
      || msg.payload[0].providerCreateReceipt !== undefined
      || msg.payload[0].providerCreateAttemptId !== ctx.quarterAttemptId || !gcoCanonicalMatches(msg.payload[0], owner.row)) return pending();
    if (!freshCapsule()) return pending('GAME_CREATE_OWNER_CAPSULE_EXPIRED_BEFORE_DISPATCH');
    return finishManagedCreatePreflight(ctx);
  }
  if (ctx.step === 'quarter_create_response') {
    const r = ctx.providerCreateReceipt;
    if (!gcObject(r) || r.schemaVersion !== 1 || r.operationId !== ctx.operationId
      || r.admissionRequestSha256 !== binding.admissionRequestSha256 || !gcId(r.exerciseId)
      || !gcIso(r.observedAt) || !ctx.quarterAttemptId || r.attemptId !== ctx.quarterAttemptId) return pending();
    return prepareMongoUpdate(ctx, 'quarter_create_response_ack', {
      _id: ctx.operationKey, operationId: ctx.operationId, state: 'PRECREATE_ATTEMPTING',
      providerCreateAttemptId: ctx.quarterAttemptId, providerCreateReceipt: { $exists: false }
    }, { $set: { exerciseId: r.exerciseId, providerCreateReceipt: r, updatedAt: new Date().toISOString() } });
  }
  if (ctx.step === 'quarter_create_response_ack') {
    return find('quarter_create_response_read', { _id: ctx.operationKey, operationId: ctx.operationId,
      state: 'PRECREATE_ATTEMPTING', managedCreateBinding: binding, providerCreateReceipt: ctx.providerCreateReceipt });
  }
  if (ctx.step === 'quarter_create_response_read') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
      || !gcoCanonicalMatches(msg.payload[0], owner.row)) return pending('GAME_CREATE_OWNER_CREATE_ID_PERSIST_PENDING');
    ctx.quarterOriginal = msg.payload[0]; ctx.exerciseId = ctx.providerCreateReceipt.exerciseId;
    ctx.caller = 'split'; ctx.precreatedEntitlementReserved = true;
    if (Date.parse(owner.claims.actor_token_expires_at) <= Date.now() || owner.claims.exp * 1000 <= Date.now()) return pending('GAME_CREATE_OWNER_ACTOR_EXPIRED_AFTER_CREATE');
    return prepareUserGet(ctx, 'quarter_organizer_profile', `/end-user/api/v1/${ctx.tenantKey}/profile`);
  }
  if (ctx.step === 'quarter_organizer_profile') {
    if (msg.error || msg.statusCode !== 200 || msg.responseUrl !== `${VIVA_API_BASE}/end-user/api/v1/${ctx.tenantKey}/profile`
      || gcAlias(msg.payload, ['id', 'clientId']) !== ctx.actorClientId) return pending('GAME_CREATE_OWNER_ACTOR_READBACK_REQUIRED');
    return prepareUserGet(ctx, 'quarter_organizer_subscription', `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
  }
  if (ctx.step === 'quarter_organizer_subscription') {
    const rows = gcList(msg.payload);
    const selected = rows?.filter(row => gcoAliases(row.clientSubscriptionId, row.subscriptionId, row.clientSubId,
      row.clientSubscription?.id, row.clientSubscription?.clientSubscriptionId, row.clientSub?.id, row.id, row.uuid) === ctx.clientSubscriptionId);
    if (msg.error || msg.statusCode !== 200
      || msg.responseUrl !== `${VIVA_API_BASE}/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`
      || selected?.length !== 1 || !gcoActive(selected[0]) || selected[0].isActive === false
      || ([selected[0].clientId, selected[0].client?.id].some(x => x !== undefined)
        && gcoAliases(selected[0].clientId, selected[0].client?.id) !== ctx.actorClientId)) return pending('GAME_CREATE_OWNER_ACTOR_READBACK_REQUIRED');
    return prepareUserGet(ctx, 'quarter_organizer_exercise', `/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`);
  }
  if (ctx.step === 'quarter_organizer_exercise') {
    const value = msg.payload;
    if (msg.error || msg.statusCode !== 200
      || msg.responseUrl !== `${VIVA_API_BASE}/end-user/api/v1/${ctx.tenantKey}/exercises/${encodeURIComponent(ctx.exerciseId)}`
      || !gcoActive(value) || gcAlias(value, ['id', 'exerciseId']) !== ctx.exerciseId
      || gcoAliases(value.roomId, value.room?.id) !== binding.identity.providerRoomId
      || gcoAliases(value.studioId, value.studio?.id, value.room?.studioId) !== binding.identity.providerStationId
      || Date.parse(value.timeFrom) !== Date.parse(p.target.startsAt) || Date.parse(value.timeTo) !== Date.parse(p.target.endsAt)) return pending();
    return preparePrecreatedReservationPromotion(ctx);
  }
  if (ctx.step === 'operation_precreated_promote') {
    if (msg.error || mongoMatched(msg.payload) !== 1) return pending('GAME_CREATE_OWNER_BOOKING_FENCE_UNKNOWN');
    // The existing sole subscription booking writer follows this exact successful promotion.
    return prepareBookingCreate(ctx);
  }
  if (ctx.step === 'booking_create' && (!isHttpOk(msg.statusCode) || msg.error
    || msg.responseUrl !== `${VIVA_API_BASE}/api/v1/exercises/${encodeURIComponent(ctx.exerciseId)}/bookings`
    || !gcId(bookingId(msg.payload)) || !gcoActive(msg.payload))) {
    // An exercise may already exist; no invented compensation/deletion after possible creation.
    return pending('GAME_CREATE_OWNER_ORGANIZER_ACK_UNKNOWN');
  }
  if (ctx.step === 'quarter_recovery_bookings' || ctx.step === 'confirmation_bookings') {
    if (msg.error || msg.statusCode !== 200 || msg.responseUrl !== `${VIVA_API_BASE}/end-user/api/v2/${ctx.tenantKey}/bookings?size=1000`
      || !hasCompleteBookingList(msg.payload)) return pending();
    const exact = extractItems(msg.payload).filter(b => isObj(b) && !isInactiveBooking(b)
      && bookingClientId(b) === ctx.actorClientId && bookingSubscriptionId(b) === ctx.clientSubscriptionId
      && bookingExerciseId(b) === ctx.exerciseId && eventDate(b) === ctx.serviceDate);
    if (exact.length !== 1 || !bookingId(exact[0])
      || (ctx.immediateBookingId && bookingId(exact[0]) !== ctx.immediateBookingId)) return pending();
    // Recovery cannot adopt an unattributable organizer booking after its POST acknowledgement was lost.
    if (ctx.step === 'quarter_recovery_bookings' && !ctx.immediateBookingId) return pending('GAME_CREATE_OWNER_ORGANIZER_ACK_UNKNOWN');
    ctx.bookingsObservedAt = new Date().toISOString();
    if (ctx.quarterOriginal?.state === 'CONFIRMED') {
      ctx.confirmedBookingId = ctx.quarterOriginal.bookingId;
      if (ctx.confirmedBookingId !== bookingId(exact[0])) return pending();
      recordOwnerConfirmation(ctx, exact[0], ctx.bookingsObservedAt);
      if (!ctx.managedEntitlementConfirmed) return prepareManagedEntitlementConfirm(ctx);
      if (ctx.managedActivationRequired) return prepareManagedFirstUseActivation(ctx, ctx.confirmedBookingId);
      return finishConfirmed(ctx, ctx.confirmedBookingId);
    }
    ctx.step = 'confirmation_bookings';
    return prepareConfirmedUpdate(ctx, exact[0], ctx.quarterOriginal);
  }
  if (ctx.step === 'managed_entitlement_confirm' && (msg.error || msg.statusCode !== 200
    || msg.responseUrl !== `${managedEntitlementConfig().apiBase}/internal/subscriptions/entitlements/confirm`)) return pending();
  if (ctx.step === 'managed_first_use_activation' && (msg.error || msg.statusCode !== 200
    || msg.responseUrl !== `${managedActivationConfig().apiBase}/internal/subscriptions/activate-first-use`)) return pending();
  // A release envelope (or lost ACK) is not terminal compensation proof.
  if (ctx.step === 'managed_entitlement_release') return preparePrecreateEntitlementReadback(ctx);
  // These existing canonical handlers remain the single writers of booking/entitlement/activation.
  const pass = ['booking_create', 'operation_accept', 'operation_confirm', 'managed_entitlement_confirm',
    'operation_entitlement_confirm', 'managed_first_use_activation', 'operation_activation_confirm',
    'managed_precreate_abort', 'operation_precreate_rejection_persist', 'operation_precreate_rejection_read',
    'managed_precreate_entitlement_readback', 'managed_entitlement_release', 'operation_precreate_abort'];
  return pass.includes(ctx.step) ? null : pending();
}
