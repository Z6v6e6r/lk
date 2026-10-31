// Composed beside the canonical writer, never a second booking writer.
const trainingPending = (ctx) =>
  finishPending(ctx, 'Запись на тренировку требует точной сверки', {
    code: 'TRAINING_REGISTRATION_RECONCILIATION_REQUIRED',
  });
const trainingLease = (ctx) => {
  const d = ctx.trainingAdmission,
    b = ctx.trainingRegistration,
    t = trainingOwner;
  return (
    d &&
    t.trCanonicalBinding(b) &&
    d.kind === 'TRAINING_REGISTRATION_ADMISSION' &&
    d._id === b.admissionId &&
    d.operationId === ctx.operationId &&
    d.state === 'ATTEMPTING' &&
    d.attemptId === b.attemptId &&
    d.requestSha256 === b.requestSha256 &&
    t.trIso(d.leaseUntil) &&
    Date.parse(d.leaseUntil) > Date.now() &&
    t.trIso(d.attemptActorTokenExpiresAt) &&
    Date.parse(d.attemptActorTokenExpiresAt) > Date.now() &&
    d.attemptActorTokenSha256 === t.trHash(String(ctx.authHeader || '').replace(/^Bearer /, '')) &&
    d.attemptRecoveryOnly === b.recoveryOnly &&
    ctx.caller === 'http' &&
    ctx.action === 'book'
  );
};
const trainingRowQuery = (ctx, row) => ({
  _id: row._id,
  tenantKey: ctx.tenantKey,
  actorClientId: ctx.actorClientId,
  operationId: ctx.operationId,
  exerciseId: ctx.exerciseId,
  clientSubscriptionId: ctx.clientSubscriptionId,
  serviceDate: ctx.trainingAdmission.request.preparation.target.dateHint,
  state: row.state,
  trainingRegistrationBinding: row.trainingRegistrationBinding,
  trainingRegistrationRecovery: row.trainingRegistrationRecovery,
  ...(row.upstreamBookingId ? { upstreamBookingId: row.upstreamBookingId } : {}),
  ...(row.bookingId ? { bookingId: row.bookingId } : {}),
});
const trainingCanonicalFind = (ctx) => {
  ctx.step = 'training_operation';
  msg.payload = {
    tenantKey: ctx.tenantKey,
    actorClientId: ctx.actorClientId,
    operationId: ctx.operationId,
  };
  delete msg.error;
  return emit(OUTPUT_MONGO_FIND);
};
const trainingFinal = (ctx) => {
  const row = ctx.trainingCanonical,
    t = trainingOwner,
    b = ctx.trainingRegistration;
  if (
    !trainingLease(ctx) ||
    !t.trCanonicalRow(row, ctx.trainingAdmission) ||
    row.state !== 'CONFIRMED' ||
    !t.trId(row.bookingId) ||
    !t.trIso(row.confirmedAt)
  )
    return trainingPending(ctx);
  msg.statusCode = 200;
  msg.payload = {
    schemaVersion: 1,
    authority: 'LK1_SUBSCRIPTION',
    operationId: ctx.operationId,
    admissionId: b.admissionId,
    attemptId: b.attemptId,
    requestSha256: b.requestSha256,
    preparationSha256: b.preparationSha256,
    state: 'CONFIRMED',
    actorClientId: ctx.actorClientId,
    exerciseId: ctx.exerciseId,
    clientSubscriptionId: ctx.clientSubscriptionId,
    bookingId: row.bookingId,
    confirmedAt: row.confirmedAt,
  };
  return emit(OUTPUT_FINAL);
};
// Called by emit: restrictive boundary covers composed monetary hooks too.
const trainingOutput = (ctx, index) => {
  const t = trainingOwner;
  if (index === OUTPUT_DEBUG || index === OUTPUT_MANAGED_POLICY) return trainingPending(ctx);
  if (index === OUTPUT_HTTP) {
    const userPrefix = VIVA_API_BASE + '/end-user/api/';
    if (
      msg.method === 'GET' &&
      typeof msg.url === 'string' &&
      msg.url.startsWith(userPrefix) &&
      msg.headers?.Authorization === ctx.authHeader &&
      trainingLease(ctx)
    )
      return null;
    if (
      msg.method === 'POST' &&
      ctx.step === 'booking_create' &&
      msg.url ===
        VIVA_API_BASE + '/api/v2/exercises/' + encodeURIComponent(ctx.exerciseId) + '/bookings' &&
      trainingLease(ctx) &&
      ctx.trainingWriteAllowed === true &&
      ctx.trainingRegistration.recoveryOnly === false &&
      ctx.managedEnforcement?.enabled === false &&
      !ctx.lk1 &&
      !ctx.managedEntitlementOperationId &&
      msg.payload?.clientId === ctx.actorClientId &&
      msg.payload?.clientSubscriptionId === ctx.clientSubscriptionId &&
      msg.payload?.paymentType === 'SUBSCRIPTION'
    ) {
      delete ctx.trainingWriteAllowed;
      return null;
    }
    return trainingPending(ctx);
  }
  if ([OUTPUT_MONGO_INSERT, OUTPUT_MONGO_UPDATE].includes(index)) {
    if (!trainingLease(ctx)) return trainingPending(ctx);
    const binding = t.trCanonicalImmutable(ctx.trainingRegistration);
    if (index === OUTPUT_MONGO_INSERT) {
      if (
        ctx.step !== 'operation_insert' ||
        ctx.trainingRegistration.recoveryOnly ||
        msg.payload?.operationId !== ctx.operationId
      )
        return trainingPending(ctx);
      msg.payload.trainingRegistrationBinding = binding;
      msg.payload.trainingRegistrationRecovery = {
        schemaVersion: 1,
        targetFingerprint: ctx.trainingAdmission.request.preparation.target.fingerprint,
        preparationSha256: binding.preparationSha256,
        originalAttemptId: ctx.trainingRegistration.attemptId,
      };
      ctx.trainingOriginalRecovery = msg.payload.trainingRegistrationRecovery;
    } else {
      if (
        ![
          'operation_preaccept',
          'operation_accept',
          'operation_confirm',
          'operation_fail',
          'training_confirm',
        ].includes(ctx.step)
      )
        return trainingPending(ctx);
      const query = msg.payload?.[0];
      if (!query || query.operationId !== ctx.operationId) return trainingPending(ctx);
      Object.assign(query, {
        tenantKey: ctx.tenantKey,
        actorClientId: ctx.actorClientId,
        exerciseId: ctx.exerciseId,
        clientSubscriptionId: ctx.clientSubscriptionId,
        trainingRegistrationBinding: binding,
        trainingRegistrationRecovery:
          ctx.trainingOriginalRecovery || ctx.trainingCanonical?.trainingRegistrationRecovery,
      });
      if (query.trainingRegistrationRecovery === undefined) return trainingPending(ctx);
      if (ctx.step === 'operation_confirm' || ctx.step === 'operation_fail')
        query.state = 'PENDING_CONFIRMATION';
    }
  }
  return null;
};
const trainingOwnerRoute = (ctx) => {
  const t = trainingOwner,
    b = ctx.trainingRegistration;
  if (
    !t.trCanonicalBinding(b) ||
    ctx.caller !== 'http' ||
    ctx.action !== 'book' ||
    ctx.managedJoinV2 ||
    ctx.lk2LegacyJoin ||
    ctx.managedSelfLeave ||
    !/^Bearer [!-~]{16,4096}$/.test(ctx.authHeader || '')
  )
    return trainingPending(ctx);
  const good = (path) =>
    !msg.error && msg.statusCode === 200 && msg.responseUrl === VIVA_API_BASE + path;
  if (ctx.step === 'profile') {
    if (!good('/end-user/api/v1/iSkq6G/profile')) return trainingPending(ctx);
    const id = t.trAlias([msg.payload?.id, msg.payload?.clientId]);
    if (!id) return trainingPending(ctx);
    ctx.actorClientId = id;
    ctx.actorPhone = normalizePhone(
      msg.payload?.phone || msg.payload?.phoneNumber || msg.payload?.mobile,
    );
    if (!ctx.actorPhone) return trainingPending(ctx);
    ctx.step = 'training_authority';
    msg.payload = { _id: b.admissionId, kind: 'TRAINING_REGISTRATION_ADMISSION' };
    delete msg.error;
    return emit(OUTPUT_MONGO_FIND);
  }
  if (ctx.step === 'training_authority') {
    const d =
      !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : null;
    const r = t.trRequest(d?.request, true),
      p = r?.preparation;
    if (
      !r ||
      d.requestSha256 !== t.trHash('training-registration-admission:v1\0' + JSON.stringify(r)) ||
      p.sha256 !== b.preparationSha256 ||
      !t.trEqual(d.identity, p.actor) ||
      !t.trEqual(d.providerBinding, p.subscription) ||
      !t.trDigest(d.bindingSha256) ||
      p.operationId !== ctx.operationId ||
      p.actor.providerClientId !== ctx.actorClientId ||
      p.target.providerExerciseId !== ctx.exerciseId ||
      p.subscription.providerClientSubscriptionId !== ctx.clientSubscriptionId ||
      ctx.tenantKey !== 'iSkq6G' ||
      ['actorClientId', 'clientSubscriptionId', 'exerciseId', 'serviceDate', 'lk1'].some((k) =>
        Object.hasOwn(d, k),
      )
    )
      return trainingPending(ctx);
    ctx.trainingAdmission = { ...d, request: r };
    if (!trainingLease(ctx)) return trainingPending(ctx);
    return trainingCanonicalFind(ctx);
  }
  if (!trainingLease(ctx)) return trainingPending(ctx);
  if (ctx.step === 'training_operation') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1)
      return trainingPending(ctx);
    const row = msg.payload[0];
    if (!row) {
      if (b.recoveryOnly || ctx.trainingAfterConfirm) return trainingPending(ctx);
      return prepareUserGet(
        ctx,
        'exercise',
        '/end-user/api/v1/iSkq6G/exercises/' + encodeURIComponent(ctx.exerciseId),
      );
    }
    if (
      !t.trCanonicalRow(row, ctx.trainingAdmission) ||
      !['PENDING_CONFIRMATION', 'CONFIRMED'].includes(row.state)
    )
      return trainingPending(ctx);
    const recovery = row.trainingRegistrationRecovery;
    if (
      !t.trKeys(recovery, 'schemaVersion,targetFingerprint,preparationSha256,originalAttemptId') ||
      recovery.schemaVersion !== 1 ||
      recovery.targetFingerprint !== ctx.trainingAdmission.request.preparation.target.fingerprint ||
      recovery.preparationSha256 !== b.preparationSha256 ||
      !t.trUuid(recovery.originalAttemptId)
    )
      return trainingPending(ctx);
    ctx.trainingCanonical = row;
    ctx.trainingOriginalRecovery = recovery;
    ctx.operationKey = row._id;
    ctx.serviceDate = row.serviceDate;
    // No attributable booking ID after a lost provider ACK: never adopt by actor/time alone.
    if (!t.trId(row.bookingId || row.upstreamBookingId)) return trainingPending(ctx);
    return prepareUserGet(ctx, 'training_readback', '/end-user/api/v2/iSkq6G/bookings?size=1000');
  }
  if (['exercise', 'exercise_recheck'].includes(ctx.step)) {
    const p = ctx.trainingAdmission.request.preparation;
    const target = good('/end-user/api/v1/iSkq6G/exercises/' + encodeURIComponent(ctx.exerciseId))
      ? t.trExerciseTarget(msg.payload, ctx.exerciseId, p.target.dateHint)
      : null;
    const selection = target
      ? t.trSelection(msg.payload, ctx.clientSubscriptionId, ctx.actorClientId)
      : null;
    if (
      !target ||
      !selection ||
      !t.trEqual(target, p.target) ||
      !t.trEqual(selection, p.selection) ||
      Date.parse(target.startsAt) <= Date.now() ||
      Date.parse(p.expiresAt) <= Date.now() ||
      b.recoveryOnly
    )
      return trainingPending(ctx);
    ctx.trainingWriteAllowed = ctx.step === 'exercise_recheck';
    return null;
  }
  if (['active_bookings', 'history_bookings'].includes(ctx.step)) {
    const path =
      ctx.step === 'active_bookings'
        ? '/end-user/api/v2/iSkq6G/bookings?size=1000'
        : '/end-user/api/v2/iSkq6G/bookings/history?includeCanceled=true&size=1000';
    const rows = good(path) ? t.trList(msg.payload) : null;
    if (!rows) return trainingPending(ctx);
    if (rows.some((x) => t.trBookingExercise(x) === ctx.exerciseId)) return trainingPending(ctx);
    return null;
  }
  if (ctx.step === 'operation_find') {
    if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 0)
      return trainingPending(ctx);
    return null;
  }
  if (ctx.step === 'booking_create') {
    if (
      msg.error ||
      ![200, 201].includes(msg.statusCode) ||
      msg.responseUrl !==
        VIVA_API_BASE + '/api/v2/exercises/' + encodeURIComponent(ctx.exerciseId) + '/bookings' ||
      !t.trBookingId(msg.payload)
    )
      return trainingPending(ctx);
    // Existing canonical acceptance persistence binds this original POST's returned ID.
    return null;
  }
  if (['confirmation_bookings', 'training_readback'].includes(ctx.step)) {
    const rows = good('/end-user/api/v2/iSkq6G/bookings?size=1000') ? t.trList(msg.payload) : null;
    const p = ctx.trainingAdmission.request.preparation;
    const matches = rows?.filter((x) => t.trBookingExercise(x) === ctx.exerciseId);
    const expected =
      ctx.trainingCanonical?.bookingId ||
      ctx.trainingCanonical?.upstreamBookingId ||
      ctx.immediateBookingId;
    if (
      !matches ||
      matches.length !== 1 ||
      !t.trBookingMatches(matches[0], p) ||
      !t.trBookingActive(matches[0]) ||
      !t.trId(expected) ||
      t.trBookingId(matches[0]) !== expected
    )
      return trainingPending(ctx);
    if (ctx.trainingCanonical?.state === 'CONFIRMED') return trainingFinal(ctx);
    if (ctx.step === 'training_readback') {
      return prepareMongoUpdate(
        ctx,
        'training_confirm',
        trainingRowQuery(ctx, ctx.trainingCanonical),
        {
          $set: {
            state: 'CONFIRMED',
            bookingId: expected,
            confirmedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          $unset: { pendingUntil: '', failure: '' },
        },
      );
    }
    return prepareConfirmedUpdate(ctx, matches[0]);
  }
  if (['operation_confirm', 'training_confirm'].includes(ctx.step)) {
    ctx.trainingAfterConfirm = true;
    return trainingCanonicalFind(ctx); // Lost local ACK is handled by exact durable readback.
  }
  if (
    [
      'operation_reclaim',
      'expired_pending_reconciliation',
      'operation_expired_pending_release',
    ].includes(ctx.step)
  )
    return trainingPending(ctx);
  return null;
};
