// Exact backend-only TRAINING v1 capsule. Hashes are integrity bindings, not authority.
const trObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const trKeys = (value, fields) =>
  trObject(value) && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const trId = (value) =>
  typeof value === 'string' &&
  value.length >= 3 &&
  value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
  !/[\r\n]/.test(value);
const trUuid = (value) =>
  typeof value === 'string' &&
  value.length === 36 &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const trDigest = (value) =>
  typeof value === 'string' && value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value);
const trIso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const trDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const trPositive = (value) => Number.isSafeInteger(value) && value > 0;
const trCrypto =
  typeof nodeCrypto === 'object'
    ? nodeCrypto
    : (() => {
        try {
          return global.get('crypto');
        } catch {
          return null;
        }
      })();
const trHash = (value) =>
  'sha256:' + trCrypto.createHash('sha256').update(value, 'utf8').digest('hex');
const trEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const trUuidHash = (text, version = 8) => {
  const h = trCrypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32).split('');
  h[12] = String(version);
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const trPublicId = (id) => trUuidHash('phub-viva-exercise-v1:exercise:' + id, 4);
const trOperationId = (c) =>
  trUuidHash(
    'booked-operation-admission:v1\0lk2-api\0' +
      c.tenant_id +
      '\0' +
      c.sub +
      '\0' +
      c.idempotency_key_sha256,
  );
const trMoscowDate = (instant) =>
  new Date(Date.parse(instant) + 3 * 3600000).toISOString().slice(0, 10);
const trPaths = {
  prepare: '/lk/integrations/v1/training-registration-preparations',
  admit: '/lk/integrations/v1/training-registration-admissions',
  read: '/lk/integrations/v1/training-registrations/',
};
const trTarget = (v) => {
  if (
    !trKeys(
      v,
      'id,dateHint,providerExerciseId,providerStudioId,providerRoomId,providerTypeId,providerDirectionId,category,startsAt,endsAt,durationMinutes,capacity,fingerprint',
    ) ||
    !trUuid(v.id) ||
    !trDate(v.dateHint) ||
    ![v.providerExerciseId, v.providerStudioId, v.providerRoomId].every(trId) ||
    ![v.providerTypeId, v.providerDirectionId, v.durationMinutes, v.capacity].every(trPositive) ||
    v.durationMinutes > 1440 ||
    v.capacity > 1000 ||
    v.category !== 'GROUP_TRAINING' ||
    !trIso(v.startsAt) ||
    !trIso(v.endsAt) ||
    Date.parse(v.endsAt) - Date.parse(v.startsAt) !== v.durationMinutes * 60000 ||
    trMoscowDate(v.startsAt) !== v.dateHint ||
    trPublicId(v.providerExerciseId) !== v.id ||
    !trDigest(v.fingerprint)
  )
    return null;
  const target = {
    id: v.id,
    dateHint: v.dateHint,
    providerExerciseId: v.providerExerciseId,
    providerStudioId: v.providerStudioId,
    providerRoomId: v.providerRoomId,
    providerTypeId: v.providerTypeId,
    providerDirectionId: v.providerDirectionId,
    category: 'GROUP_TRAINING',
    startsAt: v.startsAt,
    endsAt: v.endsAt,
    durationMinutes: v.durationMinutes,
    capacity: v.capacity,
  };
  return trHash('training-registration-target:v1\0' + JSON.stringify(target)) === v.fingerprint
    ? { ...target, fingerprint: v.fingerprint }
    : null;
};
const trCapsule = (v) => {
  if (
    !trKeys(
      v,
      'schemaVersion,operationId,actor,subscription,target,selection,observedAt,expiresAt,sha256',
    ) ||
    v.schemaVersion !== 1 ||
    !trUuid(v.operationId) ||
    !trKeys(v.actor, 'tenantId,userId,providerClientId,providerMappingId') ||
    ![v.actor.tenantId, v.actor.userId, v.actor.providerMappingId].every(trUuid) ||
    !trId(v.actor.providerClientId) ||
    !trKeys(v.subscription, 'id,providerClientSubscriptionId') ||
    !trUuid(v.subscription.id) ||
    !trId(v.subscription.providerClientSubscriptionId) ||
    !trKeys(v.selection, 'management,authority,cupSelection,lk1Selection,chargeMode') ||
    v.selection.management !== 'LEGACY' ||
    v.selection.authority !== 'LK1_SUBSCRIPTION' ||
    v.selection.cupSelection !== 'EXPLICIT_UNMANAGED' ||
    !['LEGACY', 'UNMATCHED'].includes(v.selection.lk1Selection) ||
    v.selection.chargeMode !== 'SUBSCRIPTION_ONLY' ||
    !trIso(v.observedAt) ||
    !trIso(v.expiresAt) ||
    Date.parse(v.expiresAt) - Date.parse(v.observedAt) !== 60000 ||
    !trDigest(v.sha256)
  )
    return null;
  const target = trTarget(v.target);
  if (!target) return null;
  const core = {
    schemaVersion: 1,
    operationId: v.operationId,
    actor: {
      tenantId: v.actor.tenantId,
      userId: v.actor.userId,
      providerClientId: v.actor.providerClientId,
      providerMappingId: v.actor.providerMappingId,
    },
    subscription: {
      id: v.subscription.id,
      providerClientSubscriptionId: v.subscription.providerClientSubscriptionId,
    },
    target,
    selection: {
      management: 'LEGACY',
      authority: 'LK1_SUBSCRIPTION',
      cupSelection: 'EXPLICIT_UNMANAGED',
      lk1Selection: v.selection.lk1Selection,
      chargeMode: 'SUBSCRIPTION_ONLY',
    },
    observedAt: v.observedAt,
    expiresAt: v.expiresAt,
  };
  return trHash('training-registration-capsule:v1\0' + JSON.stringify(core)) === v.sha256
    ? { ...core, sha256: v.sha256 }
    : null;
};
const trRequest = (v, admission = false) => {
  if (
    !trKeys(
      v,
      'contractVersion,action,target,subscriptionId,paymentIntent' +
        (admission ? ',preparation' : ''),
    ) ||
    v.contractVersion !== 1 ||
    v.action !== 'BOOK_GROUP_TRAINING' ||
    v.paymentIntent !== 'USE_SUBSCRIPTION' ||
    !trKeys(v.target, 'id,dateHint') ||
    !trUuid(v.target.id) ||
    !trDate(v.target.dateHint) ||
    !trUuid(v.subscriptionId)
  )
    return null;
  const preparation = admission ? trCapsule(v.preparation) : null;
  if (admission && !preparation) return null;
  return {
    contractVersion: 1,
    action: 'BOOK_GROUP_TRAINING',
    target: { id: v.target.id, dateHint: v.target.dateHint },
    subscriptionId: v.subscriptionId,
    paymentIntent: 'USE_SUBSCRIPTION',
    ...(admission ? { preparation } : {}),
  };
};
const trBindingFields = [
  'iss',
  'aud',
  'caller',
  'tenant_id',
  'tenant_key',
  'sub',
  'provider',
  'provider_client_id',
  'provider_mapping_id',
  'subscription_id',
  'provider_client_subscription_id',
  'operation_id',
  'idempotency_key_sha256',
  'target_id',
  'date_hint',
  'request_sha256',
];
const trBinding = (claims, admissionHash = claims.request_sha256) =>
  trHash(
    'training-registration-binding:v1\0' +
      JSON.stringify(
        trBindingFields.map((k) => (k === 'request_sha256' ? admissionHash : claims[k])),
      ),
  );
const trCapsuleClaims = (p, c) =>
  p.operationId === c.operation_id &&
  p.actor.tenantId === c.tenant_id &&
  p.actor.userId === c.sub &&
  p.actor.providerClientId === c.provider_client_id &&
  p.actor.providerMappingId === c.provider_mapping_id &&
  p.subscription.id === c.subscription_id &&
  p.subscription.providerClientSubscriptionId === c.provider_client_subscription_id &&
  p.target.id === c.target_id &&
  p.target.dateHint === c.date_hint;
const trCanonicalBinding = (v) =>
  trKeys(v, 'schemaVersion,admissionId,requestSha256,preparationSha256,attemptId,recoveryOnly') &&
  v.schemaVersion === 1 &&
  [v.admissionId, v.attemptId].every(trUuid) &&
  [v.requestSha256, v.preparationSha256].every(trDigest) &&
  typeof v.recoveryOnly === 'boolean';
const trCanonicalImmutable = (v) => ({
  schemaVersion: 1,
  admissionId: v.admissionId,
  requestSha256: v.requestSha256,
  preparationSha256: v.preparationSha256,
});
const trList = (v) => {
  if (
    !trObject(v) ||
    !Array.isArray(v.content) ||
    v.content.length > 1000 ||
    v.last !== true ||
    !Number.isSafeInteger(v.totalElements) ||
    v.totalElements !== v.content.length ||
    v.content.some((row) => !trObject(row)) ||
    (v.number !== undefined && v.number !== 0) ||
    (v.totalPages !== undefined && v.totalPages > 1)
  )
    return null;
  return v.content;
};
// Accept only same-record, agreeing provider aliases. No siblings/name fallback.
const trAlias = (values, validate = trId) => {
  const present = values.filter((v) => v !== undefined && v !== null);
  return present.length && present.every(validate) && new Set(present).size === 1
    ? present[0]
    : null;
};
const trBookingId = (b) => trAlias([b?.id, b?.bookingId]);
const trBookingActor = (b) => trAlias([b?.clientId, b?.client?.id]);
const trBookingExercise = (b) => trAlias([b?.exerciseId, b?.exercise?.id]);
const trBookingSubscription = (b) =>
  trAlias([b?.clientSubscriptionId, b?.clientSubscription?.id, b?.subscription?.id]);
const trBookingMatches = (b, p) =>
  trBookingActor(b) === p.actor.providerClientId &&
  trBookingExercise(b) === p.target.providerExerciseId &&
  trBookingSubscription(b) === p.subscription.providerClientSubscriptionId;
const trNotCancelled = (value) =>
  trObject(value) &&
  [value.isCancelled, value.cancelled, value.canceled, value.archived].every(
    (v) => v === undefined || v === false,
  ) &&
  [value.cancelledAt, value.cancellationDate, value.cancellationReason].every(
    (v) => v === undefined || v === null || v === '',
  );
const trBookingActive = (b) => {
  if (
    !trObject(b) ||
    !trNotCancelled(b) ||
    (b.exercise !== undefined && !trNotCancelled(b.exercise))
  )
    return false;
  const statuses = [b.status, b.state, b.bookingStatus].filter(
    (v) => v !== undefined && v !== null,
  );
  return (
    statuses.length > 0 &&
    statuses.every((v) => ['ACTIVE', 'CONFIRMED', 'BOOKED'].includes(v)) &&
    [
      b.isCancelled,
      b.cancelled,
      b.canceled,
      b.archived,
      b.inWaitlist,
      b.isWaitlist,
      b.waitlisted,
    ].every((v) => v === undefined || v === false) &&
    [b.cancelledAt, b.cancellationDate, b.waitlistNumber, b.waitlistPosition].every(
      (v) => v === undefined || v === null,
    ) &&
    [b.exercise?.status, b.exercise?.state].every(
      (v) => v === undefined || ['ACTIVE', 'SCHEDULED', 'CONFIRMED', 'BOOKED'].includes(v),
    )
  );
};
const trStored = (row, c) => {
  const request = trRequest(row?.request, true);
  return (
    request &&
    row.kind === 'TRAINING_REGISTRATION_ADMISSION' &&
    row._id === c.operation_id &&
    row.operationId === c.operation_id &&
    row.requestSha256 ===
      trHash('training-registration-admission:v1\0' + JSON.stringify(request)) &&
    row.bindingSha256 === trBinding(c, row.requestSha256) &&
    trCapsuleClaims(request.preparation, c) &&
    trEqual(row.identity, request.preparation.actor) &&
    trEqual(row.providerBinding, request.preparation.subscription) &&
    ['PENDING', 'ATTEMPTING', 'UNKNOWN', 'CONFIRMED', 'REJECTED'].includes(row.state) &&
    ['actorClientId', 'clientSubscriptionId', 'exerciseId', 'serviceDate', 'lk1'].every(
      (k) => !Object.hasOwn(row, k),
    )
  );
};
const trCanonicalRow = (row, outer) => {
  const p = outer.request.preparation;
  return (
    trObject(row) &&
    ![
      'BOOKED_OPERATION_ADMISSION',
      'MANAGED_SELF_LEAVE_ADMISSION',
      'TRAINING_REGISTRATION_ADMISSION',
    ].includes(row.kind) &&
    row.operationId === outer.operationId &&
    row.tenantKey === 'iSkq6G' &&
    row.actorClientId === p.actor.providerClientId &&
    row.exerciseId === p.target.providerExerciseId &&
    row.clientSubscriptionId === p.subscription.providerClientSubscriptionId &&
    row.serviceDate === p.target.dateHint &&
    trEqual(row.trainingRegistrationBinding, {
      schemaVersion: 1,
      admissionId: outer.operationId,
      requestSha256: outer.requestSha256,
      preparationSha256: p.sha256,
    }) &&
    row.managedEntitlementOperationId == null &&
    row.managedSubscriptionInstanceId == null &&
    row.managedJoinV2 === undefined &&
    row.lk1 === undefined &&
    row.activationState === 'NOT_REQUIRED' &&
    trKeys(
      row.trainingRegistrationRecovery,
      'schemaVersion,targetFingerprint,preparationSha256,originalAttemptId',
    ) &&
    row.trainingRegistrationRecovery.schemaVersion === 1 &&
    trUuid(row.trainingRegistrationRecovery.originalAttemptId) &&
    row.trainingRegistrationRecovery.targetFingerprint === p.target.fingerprint &&
    row.trainingRegistrationRecovery.preparationSha256 === p.sha256
  );
};
const trReceipt = (outer, row) => {
  if (
    !trCanonicalRow(row, outer) ||
    row.state !== 'CONFIRMED' ||
    !trId(row.bookingId) ||
    !trIso(row.confirmedAt)
  )
    return null;
  const p = outer.request.preparation;
  return {
    contractVersion: 1,
    receiptId: trUuidHash(
      'training-registration-receipt:v1\0' +
        p.actor.tenantId +
        '\0' +
        p.actor.userId +
        '\0' +
        outer.operationId +
        '\0' +
        outer.requestSha256 +
        '\0' +
        row.bookingId,
    ),
    authority: 'LK1_SUBSCRIPTION',
    operationId: outer.operationId,
    action: 'BOOK_GROUP_TRAINING',
    tenantId: p.actor.tenantId,
    userId: p.actor.userId,
    subscriptionId: p.subscription.id,
    trainingId: p.target.id,
    targetFingerprint: p.target.fingerprint,
    requestSha256: outer.requestSha256,
    preparationSha256: p.sha256,
    provider: 'VIVA',
    providerClientId: p.actor.providerClientId,
    providerMappingId: p.actor.providerMappingId,
    providerClientSubscriptionId: p.subscription.providerClientSubscriptionId,
    providerExerciseId: p.target.providerExerciseId,
    providerBookingId: row.bookingId,
    chargeMode: 'SUBSCRIPTION_ONLY',
    confirmedAt: row.confirmedAt,
  };
};
