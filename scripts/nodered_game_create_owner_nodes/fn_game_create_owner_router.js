// Outputs: exact find, CAS/upsert, bounded HTTP, original read-only observation,
// canonical split preparation, sanitized reply. No provider business writer here.
const o = msg._gameCreateOwner;
const out = (index) => { const a = [null, null, null, null, null, null]; a[index] = msg; return a; };
const reply = (code, status = 202) => {
  msg.statusCode = status;
  msg._gameCreateOwnerReply = { contractVersion: 1, operationId: o?.claims?.operation_id || null,
    status: 'UNKNOWN', asOf: null, reason: code };
  return out(5);
};
if (!gcObject(o) || !gcObject(o.claims) || !['admit', 'read'].includes(o.mode)) return reply('GAME_CREATE_OWNER_CONTEXT_INVALID', 400);
const c = o.claims;
const admissionHash = o.mode === 'read' ? o.body.admissionRequestSha256 : gcoBodyHash(o.body);
const now = () => new Date().toISOString();
const freshActor = () => c.exp * 1000 > Date.now() && Date.parse(c.actor_token_expires_at) > Date.now()
  && bookedOperationExecutionFlagEnabled(env) && bookedOperationReadConfig(env).ok
  && bookedOperationTokenBindingMatches(o.actorToken, c.actor_token_sha256);
const scrub = () => { for (const k of ['url', 'method', 'headers', 'error', 'statusCode', 'responseUrl', 'requestTimeout']) delete msg[k]; };
const find = (step, query) => { scrub(); o.step = step; msg.payload = query; return out(0); };
const findOuter = (step = 'found') => find(step, { _id: gcoKey(c), tenant_id: c.tenant_id });
const cas = (step, query, update, options = {}) => { scrub(); o.step = step; msg.payload = [query, update, options]; return out(1); };
const exactAck = () => !msg.error && msg.payload?.acknowledged === true && msg.payload.matchedCount === 1;
const globalValue = (name) => { try { return global.get(name); } catch { return null; } };
const cup = (step, endpoint, body, credential) => {
  if (!freshActor() || globalValue('subscriptions_runtime_environment') !== 'PROD'
    || String(globalValue('subscriptions_runtime_api_base_url') || '').replace(/\/+$/, '') !== 'https://padlhub.su/api') return reply('GAME_CREATE_OWNER_UNAVAILABLE');
  const token = globalValue(credential);
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32 || /[\r\n]/.test(token)) return reply('GAME_CREATE_OWNER_UNAVAILABLE');
  scrub(); o.step = step; o.expectedUrl = 'https://padlhub.su/api/internal/subscriptions/' + endpoint;
  msg.url = o.expectedUrl; msg.method = 'POST'; msg.payload = body;
  msg.headers = { Authorization: 'Bearer ' + o.actorToken, 'X-Subscriptions-Integration-Token': token,
    'Content-Type': 'application/json', Accept: 'application/json' };
  msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0;
  return out(2);
};
const httpOkay = () => !msg.error && msg.statusCode === 200 && msg.responseUrl === o.expectedUrl && msg.url === o.expectedUrl;
const observe = (step, path) => {
  scrub(); o.step = step; o.expectedUrl = 'https://api.vivacrm.ru' + path;
  msg.url = o.expectedUrl; msg.method = 'GET'; msg.payload = undefined;
  msg.headers = { Authorization: 'Bearer ' + o.actorToken, Accept: 'application/json' };
  msg.requestTimeout = 10000; msg.followRedirects = false; msg.maxRedirects = 0; return out(2);
};
const view = (registration = 'UNKNOWN', observedAt = null) => {
  const receipt = o.row?.phase === 'CREATE_CONFIRMED' && gcoReceiptMatches(o.row.receipt, o.row) ? o.row.receipt : null;
  msg.statusCode = receipt ? 200 : 202;
  msg._gameCreateOwnerReply = { contractVersion: 1, operationId: c.operation_id,
    operation: { status: receipt ? 'CONFIRMED' : 'UNKNOWN', receipt,
      ...(!receipt ? { reason: o.pendingReason || 'GAME_CREATE_OWNER_RECONCILIATION_REQUIRED' } : {}) },
    registration: { status: registration, asOf: observedAt } };
  return out(5);
};
const rejectedView = () => {
  if (!gcoRejectionReceiptMatches(o.row.rejectionReceipt, o.row)) return view();
  msg.statusCode = 200;
  msg._gameCreateOwnerReply = { contractVersion: 1, operationId: c.operation_id,
    operation: { status: 'REJECTED', receipt: o.row.rejectionReceipt }, registration: { status: 'UNKNOWN', asOf: null } };
  return out(5);
};
const freshCapsule = (body) => Date.parse(body.preparation.observedAt) <= Date.now()
  && Date.parse(body.preparation.expiresAt) > Date.now() && Date.parse(body.target.startsAt) > Date.now();
const rowQuery = (row) => ({ _id: row._id, tenant_id: c.tenant_id, kind: 'GAME_CREATE_ADMISSION',
  identity: row.identity, admissionRequestSha256: admissionHash, phase: row.phase });
if (!freshActor()) return reply('GAME_CREATE_OWNER_ACTOR_EXPIRED', 403);
if (o.step === 'start') return findOuter();
if (o.step === 'inserted') return findOuter(); // Lost/duplicate ACK never authorizes execution.
if (o.step === 'found') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return reply('GAME_CREATE_OWNER_STORAGE_UNAVAILABLE');
  const row = msg.payload[0];
  if (!row) {
    if (o.mode === 'read' || o.recoveryOnly) return reply('GAME_CREATE_OWNER_OPERATION_UNKNOWN');
    if (!freshCapsule(o.body)) return reply('GAME_CREATE_OWNER_PREPARATION_EXPIRED', 409);
    const initial = gcoInitialRow(o, now());
    return cas('inserted', { _id: initial._id, tenant_id: c.tenant_id }, { $setOnInsert: initial }, { upsert: true });
  }
  if (!gcoStoredMatches(row, c, admissionHash)) return reply('GAME_CREATE_OWNER_BINDING_CONFLICT', 409);
  o.row = row;
  if (row.phase === 'CREATE_REJECTED') return rejectedView();
  if (o.mode === 'read' || ['CREATE_ATTEMPTING', 'CREATE_CONFIRMED'].includes(row.phase)) {
    return find('canonical_read', { tenantKey: c.tenant_key, actorClientId: c.provider_client_id, operationId: c.operation_id });
  }
  if (row.phase === 'CREATE_READY') return claimDispatch();
  if (row.phase === 'CREATE_FACTS_READY') return ingestTarget();
  if (!['CREATE_ACCEPTED', 'CREATE_OBSERVING'].includes(row.phase) || !freshCapsule(row.body)) return reply('GAME_CREATE_OWNER_PENDING');
  if (row.lease && Date.parse(row.lease.until) > Date.now()) return reply('GAME_CREATE_OWNER_BUSY');
  o.lease = { id: nodeCrypto.randomUUID(), until: new Date(Date.now() + 60000).toISOString() };
  return cas('claimed_observation', { ...rowQuery(row), ...(row.lease ? { lease: row.lease } : { lease: { $exists: false } }) },
    { $set: { phase: 'CREATE_OBSERVING', lease: o.lease, updatedAt: now() } });
}
if (o.step === 'claimed_observation') {
  if (!exactAck()) return reply('GAME_CREATE_OWNER_PENDING');
  // Probe the real composed split/gateway stages before any authority can reach a writer.
  o.step = 'capability_return'; o.capabilityNonce = nodeCrypto.randomUUID();
  msg._quarterCreateCapability = { version: 1, stage: 'split_prepare', nonce: o.capabilityNonce };
  scrub(); msg.payload = undefined; return out(4);
}
if (o.step === 'capability_return') {
  const capability = msg._quarterCreateCapability;
  if (!gcKeys(capability, 'version,stage,nonce') || capability.version !== 1 || capability.stage !== 'complete'
    || capability.nonce !== o.capabilityNonce) return reply('GAME_CREATE_OWNER_GRAPH_UNAVAILABLE');
  delete msg._quarterCreateCapability;
  o.step = 'observed';
  const body = o.row.body;
  msg._gameCreatePreparation = { step: 'start', actorToken: o.actorToken,
    claims: { ...c, request_sha256: body.preparation.requestSha256 },
    body: gcRequest({ contractVersion: 1, action: 'CREATE_GAME', subscriptionId: body.subscriptionId, target: body.target }) };
  scrub(); return out(3);
}
if (o.step === 'observed') {
  const previous = o.row.body.preparation, current = msg.payload;
  if (msg.error || msg.statusCode !== 200 || !gcObject(current) || !freshCapsule(o.row.body)
    || !['actor', 'subscription', 'target', 'pricing'].every(k => gcoEqual(previous[k], current[k]))
    || current.operationId !== previous.operationId || current.requestSha256 !== previous.requestSha256
    || !Object.hasOwn(msg._gameCreatePreparation || {}, 'catalogueRoomIds')) return reply('GAME_CREATE_OWNER_OBSERVATION_MISMATCH', 409);
  o.roomIds = msg._gameCreatePreparation.catalogueRoomIds;
  delete msg._gameCreatePreparation;
  return cup('runtime', 'runtime-context', { clientSubscriptionId: c.provider_client_subscription_id }, 'subscriptions_runtime_context_integration_token');
}
if (o.step === 'runtime') {
  const raw = msg.payload, p = o.row.body.preparation;
  const r = raw && { schemaVersion: raw.schemaVersion, subscriptionInstanceId: raw.subscriptionInstanceId,
    clientSubscriptionId: raw.clientSubscriptionId, policyDigest: raw.policyDigest,
    policy: { subscriptionTypeId: raw.policy?.subscriptionTypeId, policyVersion: raw.policy?.policyVersion,
      createGame: { enabled: raw.policy?.createGame?.enabled, durationsMinutes: raw.policy?.createGame?.durationsMinutes } },
    instance: raw.instance, evidence: raw.evidence };
  if (!httpOkay() || !gcKeys(raw, 'schemaVersion,subscriptionInstanceId,clientSubscriptionId,policyDigest,policy,instance,evidence')
    || r.schemaVersion !== 1 || !gcId(r.subscriptionInstanceId)
    || r.clientSubscriptionId !== c.provider_client_subscription_id || !gcDigest(r.policyDigest)
    || !gcObject(r.policy) || !gcKeys(r.instance, 'subscriptionInstanceId,subscriptionTypeId,policyVersion,state,activeFrom,activeTo,frozenUntil,homeStationId,noShowBlockedUntil')
    || !gcKeys(r.evidence, 'mappingId,mappingRevision,mappingVerifiedAt,publicationId,publishedAt,instanceRevision,instanceAsOf')
    || r.instance.subscriptionInstanceId !== r.subscriptionInstanceId || r.instance.policyVersion !== r.policy.policyVersion
    || !gcId(r.policy.subscriptionTypeId) || !Number.isSafeInteger(r.policy.policyVersion)
    || !gcId(r.evidence.publicationId) || !gcoEqual(r.policy.createGame?.durationsMinutes, [60])
    || r.policy.createGame?.enabled !== true || r.instance.state !== 'ACTIVE'
    || !Number.isSafeInteger(r.evidence.instanceRevision) || r.evidence.instanceRevision < 1) return reply('GAME_CREATE_OWNER_RUNTIME_UNAVAILABLE');
  o.runtime = r;
  o.targetInput = { contractVersion: 3, kind: 'ORGANIZER_QUARTER_CREATE', subscriptionInstanceId: r.subscriptionInstanceId,
    targetId: 'create-draft:' + c.draft_id, revision: c.expected_revision, state: 'ACTIVE',
    subscriptionTypeId: r.policy.subscriptionTypeId, policyVersion: r.policy.policyVersion, publicationId: r.evidence.publicationId,
    createOperationId: c.operation_id, draftId: c.draft_id, stationId: c.station_id, roomId: c.provider_room_id,
    startsAt: p.target.startsAt, observedAt: p.observedAt, expiresAt: p.expiresAt,
    catalogue: { directionId: '4588', typeId: '1613', providerStudioId: c.provider_station_id,
      masterServiceId: p.pricing.masterServiceId, subServiceId: p.pricing.subServiceIds[0],
      selectorRevision: p.pricing.selectorRevision, roomIds: o.roomIds },
    price: { basis: 'WHOLE_COURT_WINDOW', amountMinor: p.pricing.courtWindowPriceMinor, currency: 'RUB',
      durationMinutes: 60, participantCount: 4, spot: 1 } };
  return cas('facts_ack', { ...rowQuery({ ...o.row, phase: 'CREATE_OBSERVING' }), lease: o.lease },
    { $set: { phase: 'CREATE_FACTS_READY', targetInput: o.targetInput, runtime: r, updatedAt: now() }, $unset: { lease: '' } });
}
if (o.step === 'facts_ack') return findOuter();
function ingestTarget() {
  if (!freshCapsule(o.row.body) || !gcObject(o.row.targetInput) || !gcObject(o.row.runtime)) return reply('GAME_CREATE_OWNER_PENDING');
  return cup('target', 'canonical-targets', o.row.targetInput, 'subscriptions_target_ingest_integration_token');
}
if (o.step === 'target') {
  const r = msg.payload, t = o.row.targetInput;
  if (!httpOkay() || !gcKeys(r, 'targetId,action,revision,snapshotId,replay') || r.targetId !== t.targetId
    || r.action !== 'CREATE_GAME' || r.revision !== t.revision || !gcId(r.snapshotId) || typeof r.replay !== 'boolean') return reply('GAME_CREATE_OWNER_TARGET_PENDING');
  o.targetReceipt = r;
  return cup('preflight', 'entitlements/preflight', { contractVersion: 2, subscriptionInstanceId: t.subscriptionInstanceId,
    action: 'CREATE_GAME', target: { targetId: t.targetId } }, 'subscriptions_entitlement_integration_token');
}
if (o.step === 'preflight') {
  const r = msg.payload, t = o.row.targetInput, runtime = o.row.runtime;
  const e = r?.expectations, q = e?.createQuarter;
  if (!httpOkay() || !gcKeys(r, 'schemaVersion,nonBinding,subscriptionInstanceId,action,target,expectations')
    || r.schemaVersion !== 1 || r.nonBinding !== true || r.subscriptionInstanceId !== t.subscriptionInstanceId
    || r.action !== 'CREATE_GAME' || !gcKeys(r.target, 'targetId') || r.target.targetId !== t.targetId
    || !gcKeys(e, 'schemaVersion,policyVersion,policyDigest,targetSnapshot,createQuarter') || e.schemaVersion !== 1
    || e.policyVersion !== runtime.policy.policyVersion || e.policyDigest !== runtime.policyDigest
    || !gcKeys(e.targetSnapshot, 'snapshotId,revision,evidenceRef') || e.targetSnapshot.snapshotId !== o.targetReceipt.snapshotId
    || e.targetSnapshot.revision !== t.revision || !gcId(e.targetSnapshot.evidenceRef)
    || !gcKeys(q, 'schemaVersion,createOperationId,draftId,clientRefHash,publicationId,descriptorDigest') || q.schemaVersion !== 1
    || q.createOperationId !== c.operation_id || q.draftId !== c.draft_id || q.publicationId !== t.publicationId
    || typeof q.clientRefHash !== 'string' || !/^[a-f0-9]{64}$/.test(q.clientRefHash) || q.clientRefHash.length !== 64
    || !gcDigest(q.descriptorDigest)) return reply('GAME_CREATE_OWNER_PREFLIGHT_PENDING');
  const binding = { schemaVersion: 1, admissionId: o.row._id, identity: o.row.identity,
    admissionRequestSha256: admissionHash, body: o.row.body, targetInput: t, runtime, expectations: e };
  return cas('ready_ack', rowQuery(o.row), { $set: { phase: 'CREATE_READY', binding, updatedAt: now() } });
}
if (['ready_ack', 'dispatch_ack', 'completed_ack'].includes(o.step)) return findOuter(o.step === 'dispatch_ack' ? 'dispatch_reread' : 'found');
function claimDispatch() {
  if (o.recoveryOnly || !freshCapsule(o.row.body) || !gcObject(o.row.binding)) return reply('GAME_CREATE_OWNER_PENDING');
  o.dispatchId = nodeCrypto.randomUUID();
  return cas('dispatch_ack', rowQuery(o.row), { $set: { phase: 'CREATE_ATTEMPTING', dispatchId: o.dispatchId,
    dispatchStartedAt: now(), updatedAt: now() } });
}
if (o.step === 'dispatch_reread') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length !== 1
    || !gcoStoredMatches(msg.payload[0], c, admissionHash) || msg.payload[0].phase !== 'CREATE_ATTEMPTING'
    || msg.payload[0].dispatchId !== o.dispatchId) return reply('GAME_CREATE_OWNER_PENDING');
  o.row = msg.payload[0]; o.step = 'canonical_callback';
  scrub(); msg.payload = undefined; return out(4);
}
if (o.step === 'canonical_callback') {
  const code = msg.payload?.details?.code;
  if (['GAME_CREATE_OWNER_CAPSULE_EXPIRED_BEFORE_DISPATCH', 'GAME_CREATE_OWNER_PROVIDER_ACK_UNKNOWN',
    'GAME_CREATE_OWNER_ACTOR_EXPIRED_AFTER_CREATE', 'GAME_CREATE_OWNER_ORGANIZER_ACK_UNKNOWN',
    'GAME_CREATE_OWNER_CREATE_ID_PERSIST_PENDING', 'GAME_CREATE_OWNER_RESERVE_ACK_UNKNOWN'].includes(code)) o.pendingReason = code;
  return findOuter();
}
if (o.step === 'canonical_read') {
  // Canonical confirmation/observation is completed by the restrictive execution adapter.
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) return reply('GAME_CREATE_OWNER_PENDING');
  o.canonical = msg.payload[0] || null;
  if (!gcoCanonicalMatches(o.canonical, o.row)) return view();
  const rejected = gcoCanonicalRejection(o.canonical, o.row);
  if (o.mode === 'admit' && rejected && o.row.phase === 'CREATE_ATTEMPTING') {
    return cas('completed_ack', { ...rowQuery(o.row), binding: o.row.binding },
      { $set: { phase: 'CREATE_REJECTED', rejectionReceipt: rejected,
        ...(rejected.schemaVersion === 2 ? { rejectionReceiptSha256: gcoUnusedReceiptDigest(rejected) } : {}), updatedAt: now() } });
  }
  if (['PREPARED', 'PRECREATE_RESERVING', 'PRECREATE_RESERVED'].includes(o.canonical.state) && !freshCapsule(o.row.body))
    o.pendingReason = 'GAME_CREATE_OWNER_CAPSULE_EXPIRED_BEFORE_DISPATCH';
  if (o.canonical.state === 'PRECREATE_ATTEMPTING' && !o.canonical.providerCreateReceipt)
    o.pendingReason = 'GAME_CREATE_OWNER_PROVIDER_ACK_UNKNOWN';
  const receipt = gcoCanonicalReceipt(o.canonical, o.row);
  if (o.mode === 'admit' && receipt && o.row.phase === 'CREATE_ATTEMPTING') {
    return cas('completed_ack', { ...rowQuery(o.row), binding: o.row.binding },
      { $set: { phase: 'CREATE_CONFIRMED', receipt, updatedAt: now() } });
  }
  if (o.mode === 'admit' && o.recoveryOnly && !o.recoveryDispatched && o.row.phase === 'CREATE_ATTEMPTING') {
    o.recoveryDispatched = true; o.step = 'canonical_callback'; scrub(); msg.payload = undefined; return out(4);
  }
  if (!receipt || (o.row.receipt && !gcoEqual(o.row.receipt, receipt))) return view();
  o.currentReceipt = receipt;
  return observe('observe_exercise', '/end-user/api/v1/' + c.tenant_key + '/exercises/' + encodeURIComponent(receipt.providerExerciseId));
}
if (o.step === 'observe_exercise') {
  const exercise = msg.payload, p = o.row.body.preparation;
  if (!httpOkay() || !gcoActive(exercise) || gcAlias(exercise, ['id', 'exerciseId']) !== o.currentReceipt.providerExerciseId
    || gcoAliases(exercise.roomId, exercise.room?.id) !== p.target.providerRoomId
    || Date.parse(exercise.timeFrom) !== Date.parse(p.target.startsAt)
    || Date.parse(exercise.timeTo) !== Date.parse(p.target.endsAt)) return view();
  return observe('observe_booking', '/end-user/api/v2/' + c.tenant_key + '/bookings?size=1000');
}
if (o.step === 'observe_booking') {
  const rows = httpOkay() ? gcList(msg.payload) : null;
  const matches = rows?.filter(b => gcAlias(b, ['id', 'bookingId']) === o.currentReceipt.providerBookingId);
  if (!matches || matches.length !== 1) return view();
  const b = matches[0];
  if (!gcoActive(b) || (b.exercise && !gcoActive(b.exercise))
    || gcoAliases(b.clientId, b.client?.id) !== c.provider_client_id
    || gcoAliases(b.clientSubscriptionId, b.clientSubscription?.id, b.subscription?.id) !== c.provider_client_subscription_id
    || gcoAliases(b.exerciseId, b.exercise?.id) !== o.currentReceipt.providerExerciseId) return view();
  return view('CONFIRMED', now());
}
return reply('GAME_CREATE_OWNER_STATE_INVALID');
