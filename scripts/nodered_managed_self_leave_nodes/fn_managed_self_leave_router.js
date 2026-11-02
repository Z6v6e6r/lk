// Outputs: daily find/upsert/update, SELF find, game find, bounded HTTP, canonical SELF, response.
const ctx = msg._managedSelfLeave;
const emit = (index) => Array.from({ length: 8 }, (_, i) => (i === index ? msg : null));
const answer = (status, payload) => {
  bookedOperationScrubDelegation(msg);
  delete msg._managedSelfLeave;
  delete msg._managedLeaveCapability;
  delete msg._splitCleanupAuth;
  delete msg._splitLeaveCtx;
  delete msg.error;
  msg.statusCode = status;
  msg.headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  msg.payload = payload;
  return emit(7);
};
const reject = (status, code) => answer(status, { code, error: code });
const pending = (reason = 'RECONCILIATION_REQUIRED') =>
  answer(200, {
    contractVersion: 1,
    operationId: ctx?.claims?.operation_id,
    status: reason === 'OWNER_PENDING' ? 'PENDING' : 'UNKNOWN',
    asOf: null,
    reason,
  });
const find = (step, query, index = 0) => {
  ctx.step = step;
  msg.payload = query;
  delete msg.error;
  delete msg.statusCode;
  return emit(index);
};
const one = () =>
  !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : null;
const actorFresh = () =>
  ctx.actorToken &&
  mslIso(ctx.claims.actor_token_expires_at) &&
  Date.parse(ctx.claims.actor_token_expires_at) > Date.now() &&
  ctx.claims.exp * 1000 > Date.now();
const request = (step, path) => {
  if (!actorFresh()) return pending();
  ctx.step = step;
  ctx.expectedUrl = 'https://api.vivacrm.ru' + path;
  msg.method = 'GET';
  msg.url = ctx.expectedUrl;
  msg.payload = undefined;
  msg.headers = { Authorization: 'Bearer ' + ctx.actorToken, Accept: 'application/json' };
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.error;
  delete msg.statusCode;
  delete msg.responseUrl;
  return emit(5);
};
const confirm = (receipt) =>
  answer(200, {
    contractVersion: 1,
    operationId: ctx.claims.operation_id,
    status: 'CONFIRMED',
    asOf: receipt.completedAt,
    reason: 'OWNER_LEAVE_CONFIRMED',
    receipt,
  });
const pinnedFind = () =>
  find(
    'terminal_leave',
    {
      _id: ctx.doc.ownerLeaveOperationKey,
      tenantKey: ctx.doc.tenantKey,
      mode: 'SELF',
      actorClientId: ctx.doc.providerClientId,
    },
    3,
  );
const startFresh = () =>
  find('join', {
    _id: ctx.request.joinOperationId,
    kind: 'BOOKED_OPERATION_ADMISSION',
    tenantId: ctx.claims.tenant_id,
    userId: ctx.claims.sub,
  });
const capability = (next) => {
  ctx.afterCapability = next;
  ctx.step = 'capability';
  msg._managedLeaveCapability = { version: 1, stage: 'prepare' };
  msg.payload = undefined;
  delete msg.error;
  return emit(6);
};
const claim = () => {
  if (!actorFresh() || !bookedOperationExecutionFlagEnabled(env)) return pending();
  const d = ctx.doc;
  const now = new Date().toISOString();
  if (d.leaseUntil && (!mslIso(d.leaseUntil) || Date.parse(d.leaseUntil) > Date.now()))
    return pending('OWNER_PENDING');
  const token = nodeCrypto.randomUUID();
  ctx.claimToken = token;
  ctx.step = 'claim_ack';
  msg.payload = [
    {
      _id: d._id,
      kind: d.kind,
      tenantId: d.tenantId,
      userId: d.userId,
      bindingSha256: d.bindingSha256,
      state: d.state,
      leaseToken: d.leaseToken === undefined ? { $exists: false } : d.leaseToken,
      leaseUntil: d.leaseUntil === undefined ? { $exists: false } : d.leaseUntil,
    },
    {
      $set: {
        state: 'ATTEMPTING',
        leaseToken: token,
        leaseUntil: new Date(Date.now() + 90000).toISOString(),
        updatedAt: now,
      },
    },
    {},
  ];
  delete msg.error;
  return emit(2);
};
if (!mslObject(ctx) || !['admit', 'read'].includes(ctx.mode) || !mslObject(ctx.claims))
  return reject(503, 'MANAGED_SELF_LEAVE_CONTEXT_INVALID');
if (ctx.step === 'capability') {
  if (
    msg._managedLeaveCapability?.stage !== 'complete' ||
    msg._managedLeaveCapability.version !== 1
  )
    return pending();
  delete msg._managedLeaveCapability;
  return ctx.afterCapability === 'fresh'
    ? startFresh()
    : request('recovery_profile', `/end-user/api/v1/${ctx.doc.tenantKey}/profile`);
}
if (ctx.step === 'find' || ctx.step === 'insert_readback' || ctx.step === 'final_readback') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return pending();
  if (!msg.payload.length) {
    if (ctx.mode === 'read' || ctx.claims.recovery_only === true || ctx.step !== 'find')
      return pending();
    return capability('fresh');
  }
  const d = msg.payload[0];
  if (!mslStoredMatches(d, ctx.claims)) return reject(404, 'MANAGED_SELF_LEAVE_NOT_FOUND');
  if (
    ctx.mode === 'admit' &&
    (d.bindingSha256 !== ctx.bindingSha256 || d.requestSha256 !== ctx.claims.request_sha256)
  )
    return reject(409, 'MANAGED_SELF_LEAVE_BINDING_CONFLICT');
  ctx.doc = {
    ...d,
    request: mslRequest(d.request),
    originalJoinReceipt: mslOriginalReceipt(d.originalJoinReceipt),
  };
  ctx.request = ctx.doc.request;
  if (ctx.step === 'final_readback') {
    const saved = mslConfirmedReceipt(ctx.doc);
    if (!saved || mslReceiptHash(saved) !== mslReceiptHash(ctx.receipt)) return pending();
    return confirm(saved);
  }
  if (d.state === 'CONFIRMED') {
    const saved = mslConfirmedReceipt(ctx.doc);
    return saved ? confirm(saved) : pending();
  }
  return pinnedFind();
}
if (ctx.step === 'terminal_leave') {
  ctx.leave = one();
  if (!ctx.leave) {
    if (ctx.mode === 'admit' && ctx.claims.recovery_only !== true && ctx.doc.state === 'PENDING')
      return capability('fresh');
    return pending();
  }
  if (!mslCanonicalEqual(ctx.leave.managedSelfLeaveOwner, mslCanonicalBinding(ctx.doc)))
    return pending();
  return find('terminal_booking', {
    _id: ctx.doc.bookingOperationKey,
    tenantKey: ctx.doc.tenantKey,
    actorClientId: ctx.doc.providerClientId,
  });
}
if (ctx.step === 'terminal_booking') {
  const row = one();
  const receipt = mslTerminalReceipt(ctx.doc, ctx.leave, row);
  if (receipt) {
    if (ctx.doc.state === 'CONFIRMED')
      return mslEqual(ctx.doc.receipt, receipt) ? confirm(receipt) : pending();
    ctx.receipt = receipt;
    ctx.step = 'final_ack';
    msg.payload = [
      {
        _id: ctx.doc._id,
        kind: ctx.doc.kind,
        tenantId: ctx.doc.tenantId,
        userId: ctx.doc.userId,
        bindingSha256: ctx.doc.bindingSha256,
        state: ctx.doc.state,
        receipt: { $exists: false },
      },
      {
        $set: {
          state: 'CONFIRMED',
          receipt,
          receiptSha256: mslReceiptHash(receipt),
          updatedAt: receipt.completedAt,
        },
        $unset: { leaseToken: '', leaseUntil: '' },
      },
      {},
    ];
    delete msg.error;
    return emit(2);
  }
  if (ctx.mode === 'read' || ctx.afterDispatch) return pending();
  if (ctx.doc.state === 'CONFIRMED') return pending();
  if (
    !row ||
    row._id !== ctx.doc.bookingOperationKey ||
    row.operationId !== ctx.doc.request.joinOperationId
  )
    return pending();
  // Never create a replacement canonical row on a replay. Both retries and
  // concurrent keys resume only the exact row already bound to the original JOIN.
  ctx.recovery = true;
  return capability('recovery');
}
if (ctx.step === 'final_ack')
  return find('final_readback', {
    _id: ctx.doc._id,
    kind: ctx.doc.kind,
    tenantId: ctx.doc.tenantId,
    userId: ctx.doc.userId,
  });
if (ctx.step === 'join') {
  const row = one();
  if (!row || row.contractVersion !== 2 || row.providerMappingId !== ctx.claims.provider_mapping_id)
    return pending();
  ctx.join = row;
  return find('booking', {
    operationId: row.operationId,
    tenantKey: ctx.claims.tenant_key,
    actorClientId: ctx.claims.provider_client_id,
    exerciseId: row.providerExerciseId,
    clientSubscriptionId: row.providerClientSubscriptionId,
    state: 'CONFIRMED',
  });
}
if (ctx.step === 'booking') {
  const row = one();
  const receipt = mslJoinReceipt(ctx.join, row, ctx.claims, ctx.request);
  if (!receipt || !mslStoreKey(row._id) || !mslId(row.serviceDate)) return pending();
  ctx.originalReceipt = receipt;
  ctx.bookingOperationKey = row._id;
  return request('profile', `/end-user/api/v1/${ctx.claims.tenant_key}/profile`);
}
if (['profile', 'recovery_profile', 'service'].includes(ctx.step)) {
  if (
    msg.error ||
    msg.statusCode !== 200 ||
    msg.responseUrl !== ctx.expectedUrl ||
    !mslObject(msg.payload)
  )
    return pending();
  if (ctx.step === 'service') {
    const options = msg.payload.cancellationOptions;
    if (options?.subscription?.available !== true && options?.exercise?.available !== true)
      return reject(409, 'MANAGED_SELF_LEAVE_SERVICE_UNAVAILABLE');
    if (ctx.doc) {
      if (!mslCanonicalEqual(mslCanonicalBinding(ctx.doc), mslCanonicalBinding(ctx.proposed)))
        return pending();
      return claim();
    }
    ctx.step = 'insert_ack';
    msg.payload = [{ _id: ctx.proposed._id }, { $setOnInsert: ctx.proposed }, { upsert: true }];
    delete msg.error;
    return emit(1);
  }
  const profile = mslObject(msg.payload.data) ? msg.payload.data : msg.payload;
  const actor =
    profile.id || profile.clientId || profile.uuid || profile.userId || profile.playerId;
  if (actor !== ctx.claims.provider_client_id)
    return reject(403, 'MANAGED_SELF_LEAVE_ACTOR_MISMATCH');
  ctx.actorPhone = mslLegacy.normalizePhone(
    profile.phoneNorm || profile.phone || profile.phoneNumber || profile.mobile,
  );
  if (ctx.step === 'recovery_profile') return claim();
  return find('game', { id: ctx.claims.legacy_game_id, archived: { $ne: true } }, 4);
}
if (ctx.step === 'game') {
  const game = one();
  const receipt = ctx.originalReceipt;
  if (!game || game.id !== ctx.claims.legacy_game_id) return pending();
  const meta = mslObject(game.metadata) ? game.metadata : {};
  const split = mslObject(meta.splitPayment) ? meta.splitPayment : {};
  const exercise =
    split.vivaExerciseId ||
    game.booking?.vivaExerciseId ||
    game.booking?.exerciseId ||
    meta.vivaExerciseId ||
    meta.exerciseId;
  if (exercise !== receipt.providerExerciseId) return pending();
  const membership = mslMembership(
    game,
    ctx.claims.provider_client_id,
    ctx.actorPhone,
    receipt.bookingId,
  );
  if (!membership) return pending();
  const ownerId = `self-leave:${game.id}:${ctx.claims.provider_client_id}:${membership.membershipVersion}`;
  const now = new Date().toISOString();
  ctx.proposed = {
    _id: ctx.claims.operation_id,
    kind: 'MANAGED_SELF_LEAVE_ADMISSION',
    operationId: ctx.claims.operation_id,
    tenantId: ctx.claims.tenant_id,
    tenantKey: ctx.claims.tenant_key,
    userId: ctx.claims.sub,
    providerClientId: ctx.claims.provider_client_id,
    providerMappingId: ctx.claims.provider_mapping_id,
    legacyGameId: game.id,
    legacyGameMappingId: ctx.claims.legacy_game_mapping_id,
    legacyGameMappingVersion: ctx.claims.legacy_game_mapping_version,
    request: ctx.request,
    requestSha256: ctx.claims.request_sha256,
    idempotencyKeySha256: ctx.claims.idempotency_key_sha256,
    bindingSha256: ctx.bindingSha256,
    originalJoinReceipt: receipt,
    bookingOperationKey: ctx.bookingOperationKey,
    membershipVersion: membership.membershipVersion,
    ownerLeaveOperationId: ownerId,
    ownerLeaveOperationKey: `${game.id}:${ownerId}`,
    state: 'PENDING',
    createdAt: now,
    updatedAt: now,
  };
  return request(
    'service',
    `/end-user/api/v1/${ctx.claims.tenant_key}/bookings/${encodeURIComponent(receipt.bookingId)}/cancel`,
  );
}
if (ctx.step === 'insert_ack') {
  // Read back the first-writer-wins immutable row even if insertion ACK was lost.
  return find('insert_readback', {
    _id: ctx.proposed._id,
    kind: ctx.proposed.kind,
    tenantId: ctx.proposed.tenantId,
    userId: ctx.proposed.userId,
  });
}
if (ctx.step === 'claim_ack') {
  if (
    msg.error ||
    msg.payload?.acknowledged !== true ||
    msg.payload.matchedCount !== 1 ||
    msg.payload.modifiedCount !== 1
  )
    return pending();
  if (!actorFresh()) return pending();
  ctx.doc = { ...ctx.doc, state: 'ATTEMPTING', leaseToken: ctx.claimToken };
  ctx.canonicalIngress = {
    binding: mslCanonicalBinding(ctx.doc),
    recoveryOnly: ctx.recovery === true || ctx.claims.recovery_only === true,
    actorTokenExpiresAt: ctx.claims.actor_token_expires_at,
    delegationExpiresAt: ctx.claims.exp * 1000,
  };
  ctx.step = 'canonical';
  msg._splitCleanupAuth = {
    verified: true,
    actorClientId: ctx.doc.providerClientId,
    actorPhoneNorm: ctx.actorPhone,
    authHeader: 'Bearer ' + ctx.actorToken,
  };
  delete ctx.actorToken;
  delete ctx.actorPhone;
  msg.req = { ...msg.req, params: { gameId: ctx.doc.legacyGameId } };
  msg.payload = { refundMethod: 'SERVICE' };
  delete msg.error;
  delete msg.statusCode;
  return emit(6);
}
if (ctx.step === 'canonical') {
  ctx.afterDispatch = true;
  delete msg._splitLeaveCtx;
  delete msg._splitCleanupAuth;
  return pinnedFind();
}
return pending();
