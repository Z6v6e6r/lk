// Outputs: exact daily-journal find, insert, CAS update, bounded HTTP, response.
const ctx = msg._trainingRegistration;
const emit = (i) => Array.from({ length: 5 }, (_, n) => (i === n ? msg : null));
const answer = (status, payload) => {
  bookedOperationScrubDelegation(msg);
  for (const key of [
    '_trainingRegistration',
    '_subscriptionBooking',
    'error',
    'method',
    'url',
    'responseUrl',
    'requestTimeout',
    'followRedirects',
    'maxRedirects',
  ])
    delete msg[key];
  msg.statusCode = status;
  msg.headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  msg.payload = payload;
  return emit(4);
};
const reject = (status, code) => answer(status, { code, error: code });
const pending = (reason = 'OWNER_OUTCOME_UNKNOWN') =>
  answer(200, {
    contractVersion: 1,
    operationId: ctx?.claims?.operation_id,
    status: reason === 'OWNER_PENDING' ? 'PENDING' : 'UNKNOWN',
    asOf: new Date().toISOString(),
    reason,
  });
const find = (step, query) => {
  ctx.step = step;
  msg.payload = query;
  delete msg.error;
  delete msg.statusCode;
  return emit(0);
};
const fresh = () =>
  ctx?.actorToken &&
  ctx.claims.exp * 1000 > Date.now() &&
  Date.parse(ctx.claims.actor_token_expires_at) > Date.now() &&
  bookedOperationTokenBindingMatches(ctx.actorToken, ctx.claims.actor_token_sha256) &&
  bookedOperationExecutionFlagEnabled(env);
const http = (step, url, method = 'GET', payload = undefined, headers = {}) => {
  if (!fresh()) return pending();
  ctx.step = step;
  ctx.expectedUrl = url;
  msg.url = url;
  msg.method = method;
  msg.payload = payload;
  msg.headers = { Accept: 'application/json', ...headers };
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 10000;
  delete msg.error;
  delete msg.responseUrl;
  delete msg.statusCode;
  return emit(3);
};
const get = (step, path) =>
  http(step, 'https://api.vivacrm.ru' + path, 'GET', undefined, {
    Authorization: 'Bearer ' + ctx.actorToken,
  });
const goodHttp = () => !msg.error && msg.statusCode === 200 && msg.responseUrl === ctx.expectedUrl;
const original = () => find('original', { _id: ctx.claims.operation_id });
const canonical = () =>
  find('canonical', {
    tenantKey: 'iSkq6G',
    actorClientId: ctx.claims.provider_client_id,
    operationId: ctx.claims.operation_id,
  });
const capability = () => {
  const loaded = bookedOperationVivaReadExecutionConfig(env);
  if (!loaded.ok) return pending();
  ctx.ownerUrl = loaded.config.ownerBase + '/lk/subscription-bookings';
  return http('capability', ctx.ownerUrl, 'GET', undefined, {
    'X-Training-Registration-Owner-Contract': '1',
  });
};
const claim = () => {
  if (!fresh()) return pending();
  const d = ctx.doc;
  if (d.state !== 'PENDING' && (!trIso(d.leaseUntil) || Date.parse(d.leaseUntil) > Date.now()))
    return pending('OWNER_PENDING');
  if (d.state !== 'PENDING' && ctx.claims.recovery_only !== true) return pending();
  if (d.state === 'PENDING' && ctx.claims.recovery_only === true) return pending();
  ctx.attemptId = nodeCrypto.randomUUID();
  ctx.step = 'claim_ack';
  ctx.recovery = d.state !== 'PENDING';
  msg.payload = [
    {
      _id: d._id,
      kind: d.kind,
      bindingSha256: d.bindingSha256,
      requestSha256: d.requestSha256,
      state: d.state,
      attemptId: d.attemptId === undefined ? { $exists: false } : d.attemptId,
      leaseUntil: d.leaseUntil === undefined ? { $exists: false } : d.leaseUntil,
    },
    {
      $set: {
        state: 'ATTEMPTING',
        attemptId: ctx.attemptId,
        leaseUntil: new Date(Date.now() + 120000).toISOString(),
        attemptActorTokenSha256: ctx.claims.actor_token_sha256,
        attemptActorTokenExpiresAt: ctx.claims.actor_token_expires_at,
        attemptRecoveryOnly: ctx.recovery,
        updatedAt: new Date().toISOString(),
      },
    },
    {},
  ];
  delete msg.error;
  return emit(2);
};
const complete = (receipt) =>
  answer(200, {
    contractVersion: 1,
    operationId: ctx.claims.operation_id,
    status: 'CONFIRMED',
    asOf: new Date().toISOString(),
    reason: 'OWNER_CONFIRMED',
    receipt,
  });
if (!trObject(ctx) || !['prepare', 'admit', 'read'].includes(ctx.mode) || !trObject(ctx.claims))
  return reject(503, 'TRAINING_REGISTRATION_CONTEXT_INVALID');
if (ctx.step === 'start') return get('profile', '/end-user/api/v1/iSkq6G/profile');
if (ctx.step === 'profile') {
  if (
    !goodHttp() ||
    trAlias([msg.payload?.id, msg.payload?.clientId]) !== ctx.claims.provider_client_id
  )
    return reject(403, 'TRAINING_REGISTRATION_ACTOR_MISMATCH');
  return original();
}
if (ctx.step === 'original' || ctx.step === 'insert_readback') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return pending();
  const d = msg.payload[0];
  if (d) {
    if (!trStored(d, ctx.claims)) return reject(409, 'TRAINING_REGISTRATION_BINDING_CONFLICT');
    if (ctx.mode === 'prepare') return reject(409, 'TRAINING_REGISTRATION_ALREADY_ADMITTED');
    if (
      ctx.mode === 'admit' &&
      (d.requestSha256 !== ctx.claims.request_sha256 || !trEqual(d.request, ctx.request))
    )
      return reject(409, 'TRAINING_REGISTRATION_BINDING_CONFLICT');
    ctx.doc = d;
    ctx.request = d.request;
    return canonical();
  }
  if (ctx.mode === 'read' || ctx.claims.recovery_only === true || ctx.step === 'insert_readback')
    return pending();
  if (
    ctx.mode === 'admit' &&
    (Date.parse(ctx.request.preparation.observedAt) > Date.now() ||
      Date.parse(ctx.request.preparation.expiresAt) <= Date.now())
  )
    return reject(409, 'TRAINING_REGISTRATION_PREPARATION_EXPIRED');
  return capability();
}
if (ctx.step === 'capability') {
  if (
    !goodHttp() ||
    !trKeys(msg.payload, 'contractVersion,owner,policy') ||
    msg.payload.contractVersion !== 1 ||
    msg.payload.owner !== 'LK1_SUBSCRIPTION_BOOKING_OWNER' ||
    msg.payload.policy !== 'TRAINING_LEGACY_V1'
  )
    return reject(503, 'TRAINING_REGISTRATION_OWNER_UNAVAILABLE');
  if (ctx.doc) return claim();
  return get(
    'schedule',
    '/end-user/api/v1/iSkq6G/exercises?date=' +
      encodeURIComponent(ctx.claims.date_hint) +
      '&includePast=true&past=true&size=1000',
  );
}
if (ctx.step === 'schedule') {
  const rows = goodHttp() ? trList(msg.payload) : null;
  if (!rows) return pending('TARGET_UNAVAILABLE');
  const ids = rows.map((x) => trAlias([x.id, x.exerciseId]));
  if (ids.some((x) => !x) || new Set(ids).size !== ids.length) return pending('TARGET_UNAVAILABLE');
  const matches = ids.filter((id) => trPublicId(id) === ctx.claims.target_id);
  if (matches.length !== 1) return pending('TARGET_UNAVAILABLE');
  ctx.exerciseId = matches[0];
  return get('exercise', '/end-user/api/v1/iSkq6G/exercises/' + encodeURIComponent(ctx.exerciseId));
}
if (ctx.step === 'exercise') {
  const target = goodHttp()
    ? trExerciseTarget(msg.payload, ctx.exerciseId, ctx.claims.date_hint)
    : null;
  const selection = target
    ? trSelection(
        msg.payload,
        ctx.claims.provider_client_subscription_id,
        ctx.claims.provider_client_id,
      )
    : null;
  if (
    !target ||
    !selection ||
    target.id !== ctx.claims.target_id ||
    Date.parse(target.startsAt) <= Date.now()
  )
    return reject(409, 'TRAINING_REGISTRATION_UNSUPPORTED');
  if (ctx.mode === 'prepare') {
    const observedAt = new Date().toISOString();
    const core = {
      schemaVersion: 1,
      operationId: ctx.claims.operation_id,
      actor: {
        tenantId: ctx.claims.tenant_id,
        userId: ctx.claims.sub,
        providerClientId: ctx.claims.provider_client_id,
        providerMappingId: ctx.claims.provider_mapping_id,
      },
      subscription: {
        id: ctx.claims.subscription_id,
        providerClientSubscriptionId: ctx.claims.provider_client_subscription_id,
      },
      target,
      selection,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
    };
    return answer(200, {
      contractVersion: 1,
      nonBinding: true,
      operationId: ctx.claims.operation_id,
      action: 'BOOK_GROUP_TRAINING',
      preparation: {
        ...core,
        sha256: trHash('training-registration-capsule:v1\0' + JSON.stringify(core)),
      },
    });
  }
  if (
    !trEqual(target, ctx.request.preparation.target) ||
    !trEqual(selection, ctx.request.preparation.selection) ||
    Date.parse(ctx.request.preparation.expiresAt) <= Date.now()
  )
    return reject(409, 'TRAINING_REGISTRATION_PREPARATION_CHANGED');
  ctx.step = 'insert_ack';
  msg.payload = {
    _id: ctx.claims.operation_id,
    operationId: ctx.claims.operation_id,
    kind: 'TRAINING_REGISTRATION_ADMISSION',
    request: ctx.request,
    requestSha256: ctx.claims.request_sha256,
    bindingSha256: trBinding(ctx.claims),
    identity: ctx.request.preparation.actor,
    providerBinding: ctx.request.preparation.subscription,
    state: 'PENDING',
    createdAt: new Date().toISOString(),
  };
  delete msg.error;
  return emit(1);
}
if (ctx.step === 'insert_ack') return find('insert_readback', { _id: ctx.claims.operation_id });
if (ctx.step === 'canonical') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return pending();
  const row = msg.payload[0];
  if (!row) {
    if (
      ctx.mode === 'admit' &&
      ctx.doc.state === 'PENDING' &&
      ctx.claims.recovery_only !== true &&
      !ctx.afterDispatch
    )
      return capability();
    return pending();
  }
  if (!trCanonicalRow(row, ctx.doc)) return pending();
  ctx.canonical = row;
  const receipt = trReceipt(ctx.doc, row);
  if (receipt && ctx.mode === 'admit' && ctx.doc.state !== 'CONFIRMED' && !ctx.afterDispatch) {
    if (ctx.claims.recovery_only !== true) return pending('OWNER_PENDING');
    return capability();
  }
  if (receipt) {
    ctx.receipt = receipt;
    return get('active', '/end-user/api/v2/iSkq6G/bookings?size=1000');
  }
  if (
    ctx.mode === 'admit' &&
    ctx.claims.recovery_only === true &&
    ['ATTEMPTING', 'UNKNOWN'].includes(ctx.doc.state) &&
    row.state === 'PENDING_CONFIRMATION' &&
    !ctx.afterDispatch
  )
    return capability();
  return pending();
}
if (ctx.step === 'claim_ack') {
  if (
    msg.error ||
    msg.payload?.acknowledged !== true ||
    msg.payload.matchedCount !== 1 ||
    msg.payload.modifiedCount !== 1
  )
    return pending('OWNER_PENDING');
  if (!fresh()) return pending();
  const p = ctx.request.preparation;
  return http(
    'owner',
    ctx.ownerUrl,
    'POST',
    {
      operationId: ctx.claims.operation_id,
      exerciseId: p.target.providerExerciseId,
      clientSubscriptionId: p.subscription.providerClientSubscriptionId,
      trainingRegistration: {
        schemaVersion: 1,
        admissionId: ctx.claims.operation_id,
        requestSha256: ctx.doc.requestSha256,
        preparationSha256: p.sha256,
        attemptId: ctx.attemptId,
        recoveryOnly: ctx.recovery,
      },
    },
    {
      Authorization: 'Bearer ' + ctx.actorToken,
      'Content-Type': 'application/json',
      'Idempotency-Key': ctx.claims.operation_id,
    },
  );
}
if (ctx.step === 'owner') {
  // A callback is never proof. An ambiguous response can only trigger exact durable reads.
  ctx.afterDispatch = true;
  return canonical();
}
if (ctx.step === 'active') {
  const rows = goodHttp() ? trList(msg.payload) : null;
  const p = ctx.request.preparation;
  const relevant = rows?.filter((x) => trBookingExercise(x) === p.target.providerExerciseId);
  if (
    !relevant ||
    relevant.length !== 1 ||
    !trBookingMatches(relevant[0], p) ||
    !trBookingActive(relevant[0]) ||
    trBookingId(relevant[0]) !== ctx.receipt.providerBookingId
  )
    return pending();
  if (ctx.doc.state === 'CONFIRMED')
    return trEqual(ctx.doc.receipt, ctx.receipt) ? complete(ctx.receipt) : pending();
  if (ctx.mode === 'read') return complete(ctx.receipt);
  // Read the current lease before finalization; stale ACK cannot finalize a later attempt.
  return find('before_finalize', { _id: ctx.doc._id });
}
if (ctx.step === 'before_finalize') {
  const d =
    !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : null;
  if (!d || !trStored(d, ctx.claims) || d.state !== 'ATTEMPTING' || d.attemptId !== ctx.attemptId)
    return pending();
  ctx.step = 'final_ack';
  msg.payload = [
    {
      _id: d._id,
      kind: d.kind,
      state: 'ATTEMPTING',
      bindingSha256: d.bindingSha256,
      requestSha256: d.requestSha256,
      attemptId: ctx.attemptId,
    },
    {
      $set: { state: 'CONFIRMED', receipt: ctx.receipt, updatedAt: new Date().toISOString() },
      $unset: { leaseUntil: '', attemptActorTokenSha256: '', attemptActorTokenExpiresAt: '' },
    },
    {},
  ];
  delete msg.error;
  return emit(2);
}
if (ctx.step === 'final_ack') return find('final_readback', { _id: ctx.doc._id });
if (ctx.step === 'final_readback') {
  const d =
    !msg.error && Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : null;
  return d && trStored(d, ctx.claims) && d.state === 'CONFIRMED' && trEqual(d.receipt, ctx.receipt)
    ? complete(ctx.receipt)
    : pending();
}
return pending();
