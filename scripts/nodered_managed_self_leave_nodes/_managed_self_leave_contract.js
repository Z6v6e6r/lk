// Concrete LK2 managed FREE SELF-return contract. Existing crypto/config primitives
// are supplied by the booked-operation prelude; all new claims are an exact allowlist.
const MSL_ADMIT = '/lk/integrations/v1/managed-self-leave-admissions';
const MSL_READ = '/lk/integrations/v1/managed-self-leaves/';
const mslObject = bookedOperationIsObject;
const mslKeys = (row, keys) =>
  mslObject(row) && Object.keys(row).sort().join(',') === [...keys].sort().join(',');
const mslId = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value) &&
  !/[\r\n]/.test(value);
const mslStoreKey = (value) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(value) &&
  !/[\r\n]/.test(value);
const mslDigest = (value) =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) && value.length === 71;
const mslUuid = (value) =>
  typeof value === 'string' && value.length === 36 && bookedOperationIsLowerUuid(value);
const mslIso = bookedOperationIsCanonicalIso;
const mslHash = bookedOperationSha256;
const mslEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mslRequest = (value) => {
  if (
    !mslKeys(value, [
      'contractVersion',
      'action',
      'target',
      'participationId',
      'reservationId',
      'joinOperationId',
      'joinReceiptSha256',
      'returnMode',
    ]) ||
    value.contractVersion !== 1 ||
    value.action !== 'LEAVE_GAME' ||
    value.returnMode !== 'SERVICE' ||
    !mslKeys(value.target, ['id', 'expectedRevision']) ||
    !mslUuid(value.target.id) ||
    !Number.isSafeInteger(value.target.expectedRevision) ||
    value.target.expectedRevision < 1 ||
    ![value.participationId, value.reservationId, value.joinOperationId].every(mslUuid) ||
    !mslDigest(value.joinReceiptSha256)
  )
    return null;
  return {
    contractVersion: 1,
    action: 'LEAVE_GAME',
    target: { id: value.target.id, expectedRevision: value.target.expectedRevision },
    participationId: value.participationId,
    reservationId: value.reservationId,
    joinOperationId: value.joinOperationId,
    joinReceiptSha256: value.joinReceiptSha256,
    returnMode: 'SERVICE',
  };
};
const mslOperationId = (c) => {
  const chars = nodeCrypto
    .createHash('sha256')
    .update(
      'managed-self-leave-operation:v1\0' +
        c.tenant_id +
        '\0' +
        c.sub +
        '\0' +
        c.idempotency_key_sha256,
    )
    .digest('hex')
    .slice(0, 32)
    .split('');
  chars[12] = '8';
  chars[16] = ((parseInt(chars[16], 16) & 3) | 8).toString(16);
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const mslBinding = (c) =>
  mslHash(
    'managed-self-leave-delegation:v1\0' +
      JSON.stringify([
        c.iss,
        c.aud,
        c.sub,
        c.tenant_id,
        c.tenant_key,
        c.provider,
        c.provider_client_id,
        c.provider_mapping_id,
        c.operation_id,
        c.method,
        c.path,
        c.request_sha256,
        c.idempotency_key_sha256,
        c.legacy_game_id,
        c.legacy_game_mapping_id,
        c.legacy_game_mapping_version,
      ]),
  );
const mslReceiptHash = (receipt) =>
  mslHash(JSON.stringify(Object.entries(receipt).sort(([a], [b]) => a.localeCompare(b))));
const mslVerify = (msg, env, mode) => {
  const fail = (statusCode, code) => ({ ok: false, statusCode, code });
  const loaded = bookedOperationReadConfig(env);
  if (!loaded.ok || !bookedOperationExecutionFlagEnabled(env))
    return fail(503, 'MANAGED_SELF_LEAVE_UNAVAILABLE');
  const config = loaded.config;
  if (
    !mslObject(msg.req) ||
    !mslObject(msg.req.query || {}) ||
    Object.keys(msg.req.query || {}).length
  )
    return fail(400, 'MANAGED_SELF_LEAVE_REQUEST_INVALID');
  const token = bookedOperationHeader(msg, 'x-subscription-actor-delegation');
  if (!token || !BOOKED_OP_TOKEN.test(token))
    return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  const parts = token.split('.');
  if (parts.length !== 3) return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  const bytes = parts.map(bookedOperationDecode);
  if (bytes.some((x) => !x)) return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  const header = bookedOperationParseObject(bytes[0]);
  if (
    !mslKeys(header, ['alg', 'kid', 'typ']) ||
    header.alg !== 'RS256' ||
    header.kid !== config.keyId ||
    header.typ !== BOOKED_OP_DELEGATION_TYPE
  )
    return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  try {
    if (
      !nodeCrypto.verify(
        'RSA-SHA256',
        Buffer.from(parts[0] + '.' + parts[1]),
        config.publicKeyPem,
        bytes[2],
      )
    )
      return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  } catch {
    return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  }
  const c = bookedOperationParseObject(bytes[1]);
  const keys = [
    ...BOOKED_OP_READ_CLAIMS,
    ...(mode === 'admit'
      ? [
          'request_sha256',
          'idempotency_key_sha256',
          'actor_token_sha256',
          'actor_token_expires_at',
          'legacy_game_id',
          'legacy_game_mapping_id',
          'legacy_game_mapping_version',
        ]
      : ['receipt_version']),
  ];
  if (
    !c ||
    !mslKeys(c, [
      ...keys,
      ...(mode === 'admit' && Object.hasOwn(c, 'recovery_only') ? ['recovery_only'] : []),
    ])
  )
    return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  const now = Math.floor(Date.now() / 1000);
  if (
    c.iss !== config.issuer ||
    c.aud !== config.audience ||
    ![c.sub, c.jti, c.tenant_id, c.sid, c.operation_id, c.provider_mapping_id].every(mslUuid) ||
    ![c.iat, c.nbf, c.exp].every(bookedOperationIsInteger) ||
    c.exp <= now - config.clockSkewSeconds ||
    c.nbf > now + config.clockSkewSeconds ||
    c.iat > now + config.clockSkewSeconds ||
    c.exp <= c.iat ||
    c.exp - c.iat > config.maxLifetimeSeconds ||
    c.iat - c.nbf > config.clockSkewSeconds ||
    c.contract_version !== 1 ||
    c.provider !== 'VIVA' ||
    c.tenant_key !== 'iSkq6G' ||
    !mslId(c.provider_client_id) ||
    typeof c.correlation_id !== 'string' ||
    !BOOKED_OP_CORRELATION.test(c.correlation_id) ||
    /[\r\n]/.test(c.correlation_id) ||
    (Object.hasOwn(c, 'recovery_only') && c.recovery_only !== true)
  )
    return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  const path = mode === 'admit' ? MSL_ADMIT : MSL_READ + c.operation_id;
  if (
    c.caller !== 'lk2-api' ||
    c.scope !== 'subscription-runtime.managed-self-leave.' + mode ||
    c.method !== (mode === 'admit' ? 'POST' : 'GET') ||
    c.path !== path ||
    (msg.req.originalUrl || msg.req.url) !== path ||
    msg.req.method !== c.method ||
    bookedOperationHeader(msg, 'x-correlation-id') !== c.correlation_id
  )
    return fail(403, 'MANAGED_SELF_LEAVE_CONTEXT_MISMATCH');
  let actorToken = null;
  if (mode === 'admit') {
    actorToken = bookedOperationHeader(msg, BOOKED_OP_ACTOR_TOKEN_HEADER);
    if (
      !mslDigest(c.request_sha256) ||
      !mslDigest(c.idempotency_key_sha256) ||
      !mslDigest(c.actor_token_sha256) ||
      !mslIso(c.actor_token_expires_at) ||
      Date.parse(c.actor_token_expires_at) <= Date.now() + config.clockSkewSeconds * 1000 ||
      !mslId(c.legacy_game_id) ||
      !mslUuid(c.legacy_game_mapping_id) ||
      typeof c.legacy_game_mapping_version !== 'string' ||
      !BOOKED_OP_TARGET_VERSION.test(c.legacy_game_mapping_version) ||
      /[\r\n]/.test(c.legacy_game_mapping_version) ||
      !bookedOperationTokenBindingMatches(actorToken, c.actor_token_sha256) ||
      mslOperationId(c) !== c.operation_id
    )
      return fail(403, 'MANAGED_SELF_LEAVE_BINDING_MISMATCH');
  } else if (c.receipt_version !== 1) return fail(401, 'MANAGED_SELF_LEAVE_DELEGATION_INVALID');
  return {
    ok: true,
    claims: c,
    actorToken,
    bindingSha256: mode === 'admit' ? mslBinding(c) : null,
  };
};
const mslJoinReceipt = (stored, row, c, request) => {
  const a = managedJoinV2Request(stored?.managedJoinV2);
  const d = row?.managedDecision;
  if (
    !a ||
    stored.kind !== 'BOOKED_OPERATION_ADMISSION' ||
    stored.contractVersion !== 2 ||
    stored.operationId !== request.joinOperationId ||
    stored.tenantId !== c.tenant_id ||
    stored.tenantKey !== c.tenant_key ||
    stored.userId !== c.sub ||
    stored.providerClientId !== c.provider_client_id ||
    stored.providerMappingId !== c.provider_mapping_id ||
    stored.targetId !== request.target.id ||
    stored.reservationId !== request.reservationId ||
    stored.requestSha256 !== mslHash('booked-operation-admission:v2\0' + JSON.stringify(a)) ||
    !row ||
    ['BOOKED_OPERATION_ADMISSION', 'MANAGED_SELF_LEAVE_ADMISSION'].includes(row.kind) ||
    row.operationId !== stored.operationId ||
    row.tenantKey !== stored.tenantKey ||
    row.actorClientId !== stored.providerClientId ||
    row.exerciseId !== stored.providerExerciseId ||
    row.clientSubscriptionId !== stored.providerClientSubscriptionId ||
    row.state !== 'CONFIRMED' ||
    !mslId(row.bookingId) ||
    !mslIso(row.confirmedAt) ||
    !['NOT_REQUIRED', 'CONFIRMED'].includes(row.activationState) ||
    !mslEqual(managedJoinV2Request(row.managedJoinV2), a) ||
    row.managedSubscriptionInstanceId !== a.entitlement.subscriptionInstanceId ||
    row.managedEntitlementState !== 'CONFIRMED' ||
    typeof row.managedEntitlementOperationId !== 'string' ||
    !/^booking:[a-f0-9]{48}$/.test(row.managedEntitlementOperationId) ||
    row.managedEntitlementOperationId.length !== 56 ||
    d?.decisionKind !== 'ENTITLEMENT' ||
    d.action !== 'JOIN_GAME' ||
    d.target?.targetId !== stored.providerExerciseId ||
    d.policyVersion !== a.entitlement.expectations.policyVersion ||
    d.policyDigest !== a.entitlement.expectations.policyDigest ||
    d.money?.currency !== 'RUB' ||
    d.money.finalPriceMinor !== 0 ||
    !Number.isSafeInteger(d.usageUnits) ||
    d.usageUnits < 1 ||
    row.lk1?.visitJob !== undefined
  )
    return null;
  const receipt = {
    contractVersion: 2,
    source: 'LK1_SUBSCRIPTION_BOOKING_OWNER',
    operationId: stored.operationId,
    tenantId: stored.tenantId,
    userId: stored.userId,
    gameId: stored.targetId,
    reservationId: stored.reservationId,
    providerClientId: stored.providerClientId,
    providerClientSubscriptionId: stored.providerClientSubscriptionId,
    providerExerciseId: stored.providerExerciseId,
    providerMappingId: stored.providerMappingId,
    targetMappingId: stored.targetMappingId,
    targetVersion: stored.targetVersion,
    requestSha256: stored.requestSha256,
    idempotencyKeySha256: stored.idempotencyKeySha256,
    bookingId: row.bookingId,
    verifiedAt: row.confirmedAt,
    entitlement: {
      subscriptionInstanceId: row.managedSubscriptionInstanceId,
      policyRef: { policyVersion: d.policyVersion, policyDigest: d.policyDigest },
      usageRef: { usageRef: row.managedEntitlementOperationId, reservationUnits: d.usageUnits },
    },
  };
  return mslReceiptHash(receipt) === request.joinReceiptSha256 ? receipt : null;
};
const mslMembership = (game, actorId, phone, bookingId) => {
  const {
    isObj,
    asArray,
    toStr,
    normalizeId,
    normalizePhone,
    matchesActor,
    inactiveStatus,
    stableVersion,
    phoneIdentityAmbiguous,
  } = mslLegacy;
  const metadata = isObj(game.metadata) ? game.metadata : {};
  const split = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
  const records = [
    game.organizer,
    { id: metadata.organizerId, phone: metadata.organizerPhoneNorm || metadata.organizerPhone },
    ...asArray(game.participants),
    ...asArray(game.waitlist),
    ...asArray(split.payments),
  ].filter(isObj);
  const actor = normalizeId(actorId);
  const normalizedPhone = normalizePhone(phone);
  if (
    phoneIdentityAmbiguous(records, actor, normalizedPhone) ||
    matchesActor(game.organizer, actor, normalizedPhone) ||
    matchesActor(
      { id: metadata.organizerId, phone: metadata.organizerPhoneNorm || metadata.organizerPhone },
      actor,
      normalizedPhone,
    )
  )
    return null;
  const active = (rows) =>
    asArray(rows).filter(
      (row) => matchesActor(row, actor, normalizedPhone) && !inactiveStatus(row.status),
    );
  const payments = active(split.payments),
    participants = active(game.participants),
    waitlist = active(game.waitlist);
  const response =
    normalizedPhone &&
    isObj(metadata.joinResponses?.[normalizedPhone]) &&
    !inactiveStatus(metadata.joinResponses[normalizedPhone].status)
      ? metadata.joinResponses[normalizedPhone]
      : null;
  const bookingIds = [
    ...new Set(
      [
        ...payments.flatMap((row) => [...asArray(row.bookingIds), row.bookingId]),
        ...participants.map((row) => row.bookingId),
        ...waitlist.map((row) => row.bookingId),
      ]
        .map(toStr)
        .filter(Boolean),
    ),
  ];
  const activeExists =
    payments.length + participants.length + waitlist.length > 0 || Boolean(response);
  if (activeExists && (bookingIds.length !== 1 || bookingIds[0] !== bookingId)) return null;
  const generation = stableVersion([
    ...payments.flatMap((row) => [
      row.membershipId,
      ...asArray(row.bookingIds),
      row.bookingId,
      row.paymentRef,
    ]),
    ...participants.flatMap((row) => [row.membershipId, row.bookingId, row.paymentRef]),
    ...waitlist.flatMap((row) => [row.membershipId, row.bookingId, row.paymentRef]),
    response?.membershipId,
    response?.paymentRef,
  ]);
  return { membershipVersion: generation || stableVersion([bookingId]), actorKnown: activeExists };
};
const mslCanonicalBinding = (doc) => ({
  schemaVersion: 1,
  tenantId: doc.tenantId,
  userId: doc.userId,
  tenantKey: doc.tenantKey,
  gameId: doc.request.target.id,
  legacyGameId: doc.legacyGameId,
  providerClientId: doc.providerClientId,
  providerMappingId: doc.providerMappingId,
  legacyGameMappingId: doc.legacyGameMappingId,
  legacyGameMappingVersion: doc.legacyGameMappingVersion,
  participationId: doc.request.participationId,
  reservationId: doc.request.reservationId,
  joinOperationId: doc.request.joinOperationId,
  joinReceiptSha256: doc.request.joinReceiptSha256,
  bookingOperationKey: doc.bookingOperationKey,
  providerExerciseId: doc.originalJoinReceipt.providerExerciseId,
  providerClientSubscriptionId: doc.originalJoinReceipt.providerClientSubscriptionId,
  providerBookingId: doc.originalJoinReceipt.bookingId,
  subscriptionInstanceId: doc.originalJoinReceipt.entitlement.subscriptionInstanceId,
  entitlementOperationId: doc.originalJoinReceipt.entitlement.usageRef.usageRef,
  membershipVersion: doc.membershipVersion,
  ownerLeaveOperationId: doc.ownerLeaveOperationId,
  ownerLeaveOperationKey: doc.ownerLeaveOperationKey,
});
const mslCanonicalEqual = (a, b) =>
  mslObject(a) &&
  mslObject(b) &&
  Object.keys(a).sort().join(',') === Object.keys(b).sort().join(',') &&
  Object.keys(a).every((k) => a[k] === b[k]);
const mslOriginalReceipt = (value) => {
  if (
    !mslKeys(value, [
      'contractVersion',
      'source',
      'operationId',
      'tenantId',
      'userId',
      'gameId',
      'reservationId',
      'providerClientId',
      'providerClientSubscriptionId',
      'providerExerciseId',
      'providerMappingId',
      'targetMappingId',
      'targetVersion',
      'requestSha256',
      'idempotencyKeySha256',
      'bookingId',
      'verifiedAt',
      'entitlement',
    ]) ||
    value.contractVersion !== 2 ||
    value.source !== 'LK1_SUBSCRIPTION_BOOKING_OWNER' ||
    ![
      value.operationId,
      value.tenantId,
      value.userId,
      value.gameId,
      value.reservationId,
      value.providerMappingId,
      value.targetMappingId,
    ].every(mslUuid) ||
    ![
      value.providerClientId,
      value.providerClientSubscriptionId,
      value.providerExerciseId,
      value.bookingId,
      value.targetVersion,
    ].every(mslId) ||
    !mslDigest(value.requestSha256) ||
    !mslDigest(value.idempotencyKeySha256) ||
    !mslIso(value.verifiedAt) ||
    !mslKeys(value.entitlement, ['subscriptionInstanceId', 'policyRef', 'usageRef']) ||
    !mslId(value.entitlement.subscriptionInstanceId) ||
    !mslKeys(value.entitlement.policyRef, ['policyVersion', 'policyDigest']) ||
    !Number.isSafeInteger(value.entitlement.policyRef.policyVersion) ||
    value.entitlement.policyRef.policyVersion < 1 ||
    !mslDigest(value.entitlement.policyRef.policyDigest) ||
    !mslKeys(value.entitlement.usageRef, ['usageRef', 'reservationUnits']) ||
    !Number.isSafeInteger(value.entitlement.usageRef.reservationUnits) ||
    value.entitlement.usageRef.reservationUnits < 1 ||
    typeof value.entitlement.usageRef.usageRef !== 'string' ||
    !/^booking:[a-f0-9]{48}$/.test(value.entitlement.usageRef.usageRef) ||
    value.entitlement.usageRef.usageRef.length !== 56
  )
    return null;
  // Restore the same canonical nested ordering used by the JOIN receipt parser.
  return {
    ...value,
    entitlement: {
      subscriptionInstanceId: value.entitlement.subscriptionInstanceId,
      policyRef: {
        policyVersion: value.entitlement.policyRef.policyVersion,
        policyDigest: value.entitlement.policyRef.policyDigest,
      },
      usageRef: {
        usageRef: value.entitlement.usageRef.usageRef,
        reservationUnits: value.entitlement.usageRef.reservationUnits,
      },
    },
  };
};
const mslStoredMatches = (doc, c) =>
  mslObject(doc) &&
  doc.kind === 'MANAGED_SELF_LEAVE_ADMISSION' &&
  doc._id === c.operation_id &&
  doc.operationId === c.operation_id &&
  doc.tenantId === c.tenant_id &&
  doc.tenantKey === c.tenant_key &&
  doc.userId === c.sub &&
  doc.providerClientId === c.provider_client_id &&
  doc.providerMappingId === c.provider_mapping_id &&
  ['PENDING', 'ATTEMPTING', 'CONFIRMED'].includes(doc.state) &&
  mslDigest(doc.bindingSha256) &&
  mslDigest(doc.idempotencyKeySha256) &&
  mslOperationId({
    tenant_id: doc.tenantId,
    sub: doc.userId,
    idempotency_key_sha256: doc.idempotencyKeySha256,
  }) === doc.operationId &&
  mslStoreKey(doc.bookingOperationKey) &&
  mslRequest(doc.request) &&
  doc.requestSha256 ===
    mslHash('managed-self-leave-admission:v1\0' + JSON.stringify(mslRequest(doc.request))) &&
  mslOriginalReceipt(doc.originalJoinReceipt) &&
  mslReceiptHash(mslOriginalReceipt(doc.originalJoinReceipt)) === doc.request.joinReceiptSha256 &&
  doc.originalJoinReceipt.providerMappingId === doc.providerMappingId &&
  doc.originalJoinReceipt.tenantId === doc.tenantId &&
  doc.originalJoinReceipt.userId === doc.userId &&
  doc.originalJoinReceipt.gameId === doc.request.target.id &&
  doc.originalJoinReceipt.reservationId === doc.request.reservationId &&
  doc.originalJoinReceipt.operationId === doc.request.joinOperationId &&
  doc.originalJoinReceipt.providerClientId === doc.providerClientId &&
  mslId(doc.legacyGameId) &&
  mslUuid(doc.legacyGameMappingId) &&
  mslId(doc.legacyGameMappingVersion) &&
  mslId(doc.membershipVersion) &&
  typeof doc.ownerLeaveOperationId === 'string' &&
  doc.ownerLeaveOperationId ===
    `self-leave:${doc.legacyGameId}:${doc.providerClientId}:${doc.membershipVersion}` &&
  doc.ownerLeaveOperationKey === `${doc.legacyGameId}:${doc.ownerLeaveOperationId}`;
const mslCompensationMatches = (value, doc) =>
  mslKeys(value, [
    'schemaVersion',
    'operationId',
    'subscriptionInstanceId',
    'operationState',
    'compensationState',
    'releaseReason',
    'providerBookingId',
  ]) &&
  value.schemaVersion === 1 &&
  value.operationId === doc.originalJoinReceipt.entitlement.usageRef.usageRef &&
  value.subscriptionInstanceId === doc.originalJoinReceipt.entitlement.subscriptionInstanceId &&
  value.providerBookingId === doc.originalJoinReceipt.bookingId &&
  value.operationState === 'COMPENSATED' &&
  value.compensationState === 'APPLIED' &&
  value.releaseReason === 'BOOKING_CANCELLED';
const mslTerminalReceipt = (doc, leave, booking) => {
  const bind = mslCanonicalBinding(doc);
  const marker = booking?.managedSelfLeaveCancellation;
  if (
    !mslObject(leave) ||
    leave._id !== doc.ownerLeaveOperationKey ||
    leave.operationId !== doc.ownerLeaveOperationId ||
    leave.tenantKey !== doc.tenantKey ||
    leave.mode !== 'SELF' ||
    leave.actorClientId !== doc.providerClientId ||
    leave.targetClientId !== doc.providerClientId ||
    leave.gameId !== doc.legacyGameId ||
    leave.exerciseId !== bind.providerExerciseId ||
    leave.clientSubscriptionId !== bind.providerClientSubscriptionId ||
    leave.membershipVersion !== doc.membershipVersion ||
    !mslEqual(leave.bookingIds, [bind.providerBookingId]) ||
    !mslCanonicalEqual(leave.managedSelfLeaveOwner, bind) ||
    leave.state !== 'DONE' ||
    !['REMOVED', 'REJOIN_PRESERVED'].includes(leave.outcome) ||
    !mslIso(leave.lkAppliedAt) ||
    !mslIso(leave.doneAt) ||
    Date.parse(leave.doneAt) > Date.now() ||
    leave.dailyLimitReleaseOutcome !== 'RELEASED' ||
    leave.subscriptionReturnState !== 'RETURN_VERIFIED' ||
    leave.vivaVerification !== 'active_absent_history_cancelled' ||
    !booking ||
    booking._id !== doc.bookingOperationKey ||
    booking.operationId !== bind.joinOperationId ||
    booking.tenantKey !== doc.tenantKey ||
    booking.actorClientId !== doc.providerClientId ||
    booking.exerciseId !== bind.providerExerciseId ||
    booking.clientSubscriptionId !== bind.providerClientSubscriptionId ||
    booking.bookingId !== bind.providerBookingId ||
    booking.managedEntitlementOperationId !== bind.entitlementOperationId ||
    booking.managedSubscriptionInstanceId !== bind.subscriptionInstanceId ||
    booking.state !== 'RELEASED' ||
    !mslCompensationMatches(booking.managedSelfLeaveReceipt, doc) ||
    !mslObject(marker) ||
    marker.schemaVersion !== 1 ||
    !mslIso(marker.observedAt) ||
    Date.parse(marker.observedAt) > Date.now() ||
    marker.binding?.leaveOperationKey !== doc.ownerLeaveOperationKey ||
    marker.binding?.leaveOperationId !== doc.ownerLeaveOperationId ||
    marker.binding?.membershipVersion !== doc.membershipVersion ||
    marker.binding?.bookingOperationKey !== doc.bookingOperationKey ||
    marker.binding?.bookingOperationId !== bind.joinOperationId ||
    marker.binding?.tenantKey !== doc.tenantKey ||
    marker.binding?.actorClientId !== doc.providerClientId ||
    marker.binding?.exerciseId !== bind.providerExerciseId ||
    marker.binding?.clientSubscriptionId !== bind.providerClientSubscriptionId ||
    marker.binding?.bookingId !== bind.providerBookingId ||
    marker.binding?.entitlementOperationId !== bind.entitlementOperationId ||
    marker.binding?.subscriptionInstanceId !== bind.subscriptionInstanceId ||
    marker.binding?.gameId !== doc.legacyGameId ||
    marker.binding?.serviceDate !== booking.serviceDate ||
    !mslKeys(marker, ['schemaVersion', 'binding', 'observedAt']) ||
    !mslKeys(marker.binding, [
      'schemaVersion',
      'tenantKey',
      'actorClientId',
      'exerciseId',
      'clientSubscriptionId',
      'bookingId',
      'serviceDate',
      'bookingOperationKey',
      'bookingOperationId',
      'entitlementOperationId',
      'subscriptionInstanceId',
      'leaveOperationKey',
      'leaveOperationId',
      'gameId',
      'membershipVersion',
    ]) ||
    marker.binding.schemaVersion !== 1
  )
    return null;
  return mslReceipt(doc, leave.doneAt, booking.managedSelfLeaveReceipt);
};
const mslReceipt = (doc, completedAt, compensation) => {
  const bind = mslCanonicalBinding(doc);
  return {
    contractVersion: 1,
    source: 'LK1_MANAGED_SELF_LEAVE_OWNER',
    operationId: doc.operationId,
    tenantId: doc.tenantId,
    userId: doc.userId,
    gameId: doc.request.target.id,
    participationId: doc.request.participationId,
    reservationId: doc.request.reservationId,
    joinOperationId: doc.request.joinOperationId,
    joinReceiptSha256: doc.request.joinReceiptSha256,
    legacyGameId: doc.legacyGameId,
    ownerLeaveOperationId: doc.ownerLeaveOperationId,
    membershipVersion: doc.membershipVersion,
    providerClientId: doc.providerClientId,
    providerClientSubscriptionId: bind.providerClientSubscriptionId,
    providerExerciseId: bind.providerExerciseId,
    providerBookingId: bind.providerBookingId,
    completedAt,
    compensation: {
      schemaVersion: 1,
      operationId: compensation.operationId,
      subscriptionInstanceId: compensation.subscriptionInstanceId,
      operationState: compensation.operationState,
      compensationState: compensation.compensationState,
      releaseReason: compensation.releaseReason,
      providerBookingId: compensation.providerBookingId,
    },
    requestSha256: doc.requestSha256,
    idempotencyKeySha256: doc.idempotencyKeySha256,
    providerMappingId: doc.providerMappingId,
    legacyGameMappingId: doc.legacyGameMappingId,
    legacyGameMappingVersion: doc.legacyGameMappingVersion,
  };
};

const mslConfirmedReceipt = (doc) => {
  const value = doc.receipt;
  if (
    doc.state !== 'CONFIRMED' ||
    !mslObject(value) ||
    !mslIso(value.completedAt) ||
    Date.parse(value.completedAt) > Date.now() ||
    !mslCompensationMatches(value.compensation, doc) ||
    !mslDigest(doc.receiptSha256)
  )
    return null;
  const compensation = {
    schemaVersion: 1,
    operationId: value.compensation.operationId,
    subscriptionInstanceId: value.compensation.subscriptionInstanceId,
    operationState: 'COMPENSATED',
    compensationState: 'APPLIED',
    releaseReason: 'BOOKING_CANCELLED',
    providerBookingId: value.compensation.providerBookingId,
  };
  const expected = mslReceipt(doc, value.completedAt, compensation);
  if (
    !mslKeys(value, Object.keys(expected)) ||
    Object.keys(expected).some((key) => key !== 'compensation' && value[key] !== expected[key]) ||
    mslReceiptHash(expected) !== doc.receiptSha256
  )
    return null;
  return expected;
};
