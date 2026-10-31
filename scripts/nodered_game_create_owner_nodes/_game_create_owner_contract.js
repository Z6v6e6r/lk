// Private CREATE command contract. Requires the existing delegation/preparation prelude.
// A capsule is only an immutable precondition; it cannot authorize a provider write.
const gcoAdmissionPath = '/lk/integrations/v1/game-create-operations/admissions';
const gcoReadPath = (id) => '/lk/integrations/v1/game-create-operations/' + id + '/read';
const gcoEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gcoCapsule = (value, request) => {
  if (!gcKeys(value, 'schemaVersion,nonBinding,operationId,requestSha256,idempotencyKeySha256,actor,subscription,target,pricing,observedAt,expiresAt,sha256')
    || value.schemaVersion !== 1 || value.nonBinding !== true || !gcUuid(value.operationId)
    || ![value.requestSha256, value.idempotencyKeySha256, value.sha256].every(gcDigest)
    || !gcKeys(value.actor, 'tenantId,userId,providerClientId,providerMappingId')
    || ![value.actor.tenantId, value.actor.userId, value.actor.providerMappingId].every(gcUuid)
    || !gcId(value.actor.providerClientId)
    || !gcKeys(value.subscription, 'id,providerClientSubscriptionId')
    || value.subscription.id !== request.subscriptionId || !gcId(value.subscription.providerClientSubscriptionId)
    || !gcKeys(value.target, 'draftId,expectedRevision,stationId,courtId,startsAt,durationMinutes,endsAt,stationMappingId,courtMappingId,mappingVersion,providerStationId,providerRoomId')
    || ![value.target.stationMappingId, value.target.courtMappingId].every(gcUuid)
    || ![value.target.mappingVersion, value.target.providerStationId, value.target.providerRoomId].every(gcId)
    || Object.keys(request.target).some((k) => value.target[k] !== request.target[k])
    || value.target.endsAt !== new Date(Date.parse(request.target.startsAt) + 3600000).toISOString()
    || !gcKeys(value.pricing, 'masterServiceId,subServiceIds,selectorRevision,catalogEvidenceSha256,participantCount,priceBasis,courtWindowPriceMinor,quarterPriceMinor,currency')
    || !gcId(value.pricing.masterServiceId) || !gcId(value.pricing.selectorRevision)
    || !Array.isArray(value.pricing.subServiceIds) || value.pricing.subServiceIds.length !== 1
    || !gcId(value.pricing.subServiceIds[0]) || !gcDigest(value.pricing.catalogEvidenceSha256)
    || value.pricing.participantCount !== 4 || value.pricing.priceBasis !== 'WHOLE_COURT_WINDOW'
    || value.pricing.currency !== 'RUB' || !Number.isSafeInteger(value.pricing.courtWindowPriceMinor)
    || value.pricing.courtWindowPriceMinor <= 0 || value.pricing.courtWindowPriceMinor > 10000000
    || value.pricing.courtWindowPriceMinor % 4 !== 0
    || value.pricing.quarterPriceMinor !== value.pricing.courtWindowPriceMinor / 4
    || !gcIso(value.observedAt) || !gcIso(value.expiresAt)
    || Date.parse(value.expiresAt) - Date.parse(value.observedAt) !== 60000
    || value.requestSha256 !== gcHash('game-create-preparation:v1\0' + JSON.stringify(request))) return null;
  const canonical = {
    schemaVersion: 1, nonBinding: true, operationId: value.operationId,
    requestSha256: value.requestSha256, idempotencyKeySha256: value.idempotencyKeySha256,
    actor: { tenantId: value.actor.tenantId, userId: value.actor.userId,
      providerClientId: value.actor.providerClientId, providerMappingId: value.actor.providerMappingId },
    subscription: { id: value.subscription.id, providerClientSubscriptionId: value.subscription.providerClientSubscriptionId },
    target: { ...request.target, endsAt: value.target.endsAt, stationMappingId: value.target.stationMappingId,
      courtMappingId: value.target.courtMappingId, mappingVersion: value.target.mappingVersion,
      providerStationId: value.target.providerStationId, providerRoomId: value.target.providerRoomId },
    pricing: { masterServiceId: value.pricing.masterServiceId, subServiceIds: [...value.pricing.subServiceIds],
      selectorRevision: value.pricing.selectorRevision, catalogEvidenceSha256: value.pricing.catalogEvidenceSha256,
      participantCount: 4, priceBasis: 'WHOLE_COURT_WINDOW', courtWindowPriceMinor: value.pricing.courtWindowPriceMinor,
      quarterPriceMinor: value.pricing.quarterPriceMinor, currency: 'RUB' },
    observedAt: value.observedAt, expiresAt: value.expiresAt,
  };
  return gcHash('game-create-capsule:v1\0' + JSON.stringify(canonical)) === value.sha256
    ? { ...canonical, sha256: value.sha256 } : null;
};
const gcoRequest = (value) => {
  if (!gcKeys(value, 'contractVersion,action,subscriptionId,target,preparation')) return null;
  const request = gcRequest({ contractVersion: value.contractVersion, action: value.action,
    subscriptionId: value.subscriptionId, target: value.target });
  if (!request || request.target.durationMinutes !== 60) return null;
  const preparation = gcoCapsule(value.preparation, request);
  return preparation ? { ...request, preparation } : null;
};
const gcoBodyHash = (body) => gcHash('game-create-admission:v1\0' + JSON.stringify(body));
const gcoReadRequest = (value) => gcKeys(value, 'contractVersion,operationId,admissionRequestSha256')
  && value.contractVersion === 1 && gcUuid(value.operationId) && gcDigest(value.admissionRequestSha256)
  ? { contractVersion: 1, operationId: value.operationId, admissionRequestSha256: value.admissionRequestSha256 } : null;
const gcoReadHash = (body) => gcHash('game-create-read:v1\0' + JSON.stringify(body));
const gcoClaimsTuple = (c) => ({
  tenantId: c.tenant_id, tenantKey: c.tenant_key, userId: c.sub, operationId: c.operation_id,
  idempotencyKeySha256: c.idempotency_key_sha256, providerClientId: c.provider_client_id,
  providerMappingId: c.provider_mapping_id, subscriptionId: c.subscription_id,
  providerClientSubscriptionId: c.provider_client_subscription_id, draftId: c.draft_id,
  expectedRevision: c.expected_revision, stationId: c.station_id, courtId: c.court_id,
  stationMappingId: c.station_mapping_id, courtMappingId: c.court_mapping_id,
  mappingVersion: c.mapping_version, providerStationId: c.provider_station_id, providerRoomId: c.provider_room_id,
});
const gcoCapsuleClaims = (body, c) => {
  const p = body.preparation;
  return p.operationId === c.operation_id && p.idempotencyKeySha256 === c.idempotency_key_sha256
    && p.actor.tenantId === c.tenant_id && p.actor.userId === c.sub
    && p.actor.providerClientId === c.provider_client_id && p.actor.providerMappingId === c.provider_mapping_id
    && p.subscription.providerClientSubscriptionId === c.provider_client_subscription_id
    && p.target.stationMappingId === c.station_mapping_id && p.target.courtMappingId === c.court_mapping_id
    && p.target.mappingVersion === c.mapping_version && p.target.providerStationId === c.provider_station_id
    && p.target.providerRoomId === c.provider_room_id;
};
const gcoKey = (c) => 'game-create-admission:' + c.tenant_id + ':' + c.operation_id;
const gcoFactsMatches = (row) => {
  const t = row.targetInput, r = row.runtime, i = row.identity, p = row.body.preparation;
  if (!gcKeys(r, 'schemaVersion,subscriptionInstanceId,clientSubscriptionId,policyDigest,policy,instance,evidence')
    || r.schemaVersion !== 1 || !gcId(r.subscriptionInstanceId) || r.clientSubscriptionId !== i.providerClientSubscriptionId
    || !gcDigest(r.policyDigest) || !gcKeys(r.policy, 'subscriptionTypeId,policyVersion,createGame')
    || !gcId(r.policy.subscriptionTypeId) || !Number.isSafeInteger(r.policy.policyVersion) || r.policy.policyVersion < 1
    || !gcoEqual(r.policy.createGame, { enabled: true, durationsMinutes: [60] })
    || !gcKeys(r.instance, 'subscriptionInstanceId,subscriptionTypeId,policyVersion,state,activeFrom,activeTo,frozenUntil,homeStationId,noShowBlockedUntil')
    || r.instance.subscriptionInstanceId !== r.subscriptionInstanceId || r.instance.subscriptionTypeId !== r.policy.subscriptionTypeId
    || r.instance.policyVersion !== r.policy.policyVersion || !['ACTIVE', 'PENDING_ACTIVATION'].includes(r.instance.state)
    || !gcKeys(r.evidence, 'mappingId,mappingRevision,mappingVerifiedAt,publicationId,publishedAt,instanceRevision,instanceAsOf')
    || !gcId(r.evidence.publicationId) || !gcObject(t?.catalogue)) return false;
  const roomIds = t.catalogue.roomIds;
  if (!(roomIds === null || (Array.isArray(roomIds) && roomIds.length <= 1000 && roomIds.every(gcId)
    && roomIds.includes(i.providerRoomId) && new Set(roomIds).size === roomIds.length && gcoEqual([...roomIds].sort(), roomIds)))) return false;
  if (gcHash('game-create-catalog:v1\0' + JSON.stringify({ stationId: i.providerStationId, roomId: i.providerRoomId,
    masterServiceId: p.pricing.masterServiceId, subServiceId: p.pricing.subServiceIds[0], roomIds })) !== p.pricing.catalogEvidenceSha256) return false;
  return gcoEqual(t, { contractVersion: 3, kind: 'ORGANIZER_QUARTER_CREATE', subscriptionInstanceId: r.subscriptionInstanceId,
    targetId: 'create-draft:' + i.draftId, revision: i.expectedRevision, state: 'ACTIVE', subscriptionTypeId: r.policy.subscriptionTypeId,
    policyVersion: r.policy.policyVersion, publicationId: r.evidence.publicationId, createOperationId: i.operationId,
    draftId: i.draftId, stationId: i.stationId, roomId: i.providerRoomId, startsAt: p.target.startsAt,
    observedAt: p.observedAt, expiresAt: p.expiresAt, catalogue: { directionId: '4588', typeId: '1613',
      providerStudioId: i.providerStationId, masterServiceId: p.pricing.masterServiceId, subServiceId: p.pricing.subServiceIds[0],
      selectorRevision: p.pricing.selectorRevision, roomIds }, price: { basis: 'WHOLE_COURT_WINDOW', amountMinor: p.pricing.courtWindowPriceMinor,
      currency: 'RUB', durationMinutes: 60, participantCount: 4, spot: 1 } });
};
const gcoStoredMatches = (row, c, admissionHash) => gcObject(row)
  && row._id === gcoKey(c) && row.tenant_id === c.tenant_id && row.kind === 'GAME_CREATE_ADMISSION'
  && row.contractVersion === 1 && gcoEqual(row.identity, gcoClaimsTuple(c))
  && row.admissionRequestSha256 === admissionHash && Boolean(gcoRequest(row.body))
  && gcoBodyHash(gcoRequest(row.body)) === admissionHash && gcoCapsuleClaims(row.body, c)
  && (row.targetInput === undefined || gcoFactsMatches(row))
  && (row.binding === undefined || gcoBindingMatches(row));
const gcoBindingMatches = (row) => {
  const b = row.binding, i = row.identity, p = row.body.preparation, t = b?.targetInput, r = b?.runtime, e = b?.expectations;
  if (!gcKeys(b, 'schemaVersion,admissionId,identity,admissionRequestSha256,body,targetInput,runtime,expectations')
    || b.schemaVersion !== 1 || b.admissionId !== row._id || !gcoEqual(b.identity, i)
    || !gcoEqual(b.targetInput, row.targetInput) || !gcoEqual(b.runtime, row.runtime)
    || b.admissionRequestSha256 !== row.admissionRequestSha256 || !gcoEqual(b.body, row.body)
    || !gcKeys(t, 'contractVersion,kind,subscriptionInstanceId,targetId,revision,state,subscriptionTypeId,policyVersion,publicationId,createOperationId,draftId,stationId,roomId,startsAt,observedAt,expiresAt,catalogue,price')
    || t.contractVersion !== 3 || t.kind !== 'ORGANIZER_QUARTER_CREATE' || t.state !== 'ACTIVE'
    || t.targetId !== 'create-draft:' + i.draftId || t.revision !== i.expectedRevision || t.createOperationId !== i.operationId
    || t.draftId !== i.draftId || t.stationId !== i.stationId || t.roomId !== i.providerRoomId
    || t.startsAt !== p.target.startsAt || t.observedAt !== p.observedAt || t.expiresAt !== p.expiresAt
    || !gcKeys(t.catalogue, 'directionId,typeId,providerStudioId,masterServiceId,subServiceId,selectorRevision,roomIds')
    || t.catalogue.directionId !== '4588' || t.catalogue.typeId !== '1613' || t.catalogue.providerStudioId !== i.providerStationId
    || t.catalogue.masterServiceId !== p.pricing.masterServiceId || t.catalogue.subServiceId !== p.pricing.subServiceIds[0]
    || t.catalogue.selectorRevision !== p.pricing.selectorRevision
    || !(t.catalogue.roomIds === null || (Array.isArray(t.catalogue.roomIds) && t.catalogue.roomIds.every(gcId)
      && new Set(t.catalogue.roomIds).size === t.catalogue.roomIds.length && t.catalogue.roomIds.includes(i.providerRoomId)))
    || gcHash('game-create-catalog:v1\0' + JSON.stringify({ stationId: i.providerStationId, roomId: i.providerRoomId,
      masterServiceId: t.catalogue.masterServiceId, subServiceId: t.catalogue.subServiceId, roomIds: t.catalogue.roomIds })) !== p.pricing.catalogEvidenceSha256
    || !gcoEqual(t.price, { basis: 'WHOLE_COURT_WINDOW', amountMinor: p.pricing.courtWindowPriceMinor,
      currency: 'RUB', durationMinutes: 60, participantCount: 4, spot: 1 })
    || !gcObject(r) || r.clientSubscriptionId !== i.providerClientSubscriptionId || r.subscriptionInstanceId !== t.subscriptionInstanceId
    || r.policy?.subscriptionTypeId !== t.subscriptionTypeId || r.policy?.policyVersion !== t.policyVersion
    || r.evidence?.publicationId !== t.publicationId || r.instance?.subscriptionInstanceId !== t.subscriptionInstanceId
    || !gcKeys(e, 'schemaVersion,policyVersion,policyDigest,targetSnapshot,createQuarter') || e.schemaVersion !== 1
    || e.policyVersion !== t.policyVersion || e.policyDigest !== r.policyDigest || !gcDigest(e.policyDigest)
    || !gcKeys(e.targetSnapshot, 'snapshotId,revision,evidenceRef') || !gcId(e.targetSnapshot.snapshotId)
    || e.targetSnapshot.revision !== t.revision || !gcId(e.targetSnapshot.evidenceRef)) return false;
  const q = e.createQuarter;
  return gcKeys(q, 'schemaVersion,createOperationId,draftId,clientRefHash,publicationId,descriptorDigest')
    && q.schemaVersion === 1 && q.createOperationId === i.operationId && q.draftId === i.draftId
    && q.publicationId === t.publicationId && gcDigest(q.descriptorDigest)
    && typeof q.clientRefHash === 'string' && q.clientRefHash.length === 64 && /^[a-f0-9]{64}$/.test(q.clientRefHash);
};
// No top-level legacy daily/worker fields, BSON Date expiry, or renewable request authority.
const gcoInitialRow = (context, now) => ({
  _id: gcoKey(context.claims), tenant_id: context.claims.tenant_id,
  kind: 'GAME_CREATE_ADMISSION', contractVersion: 1, phase: 'CREATE_ACCEPTED',
  identity: gcoClaimsTuple(context.claims), admissionRequestSha256: gcoBodyHash(context.body),
  body: context.body, createdAt: now, updatedAt: now,
});
const gcoCanonicalMatches = (operation, row) => gcObject(operation) && gcObject(row.binding)
  && operation.tenantKey === row.identity.tenantKey && operation.actorClientId === row.identity.providerClientId
  && operation.clientSubscriptionId === row.identity.providerClientSubscriptionId
  && operation.operationId === row.identity.operationId && gcoEqual(operation.managedCreateBinding, row.binding);
const gcoCanonicalReceipt = (operation, row) => {
  const b = row.binding, created = operation?.providerCreateReceipt;
  if (!gcoCanonicalMatches(operation, row) || operation.state !== 'CONFIRMED'
    || operation.managedEntitlementState !== 'CONFIRMED' || !['NOT_REQUIRED', 'CONFIRMED'].includes(operation.activationState)
    || !gcObject(created) || created.schemaVersion !== 1 || created.exerciseId !== operation.exerciseId
    || created.operationId !== row.identity.operationId || created.admissionRequestSha256 !== row.admissionRequestSha256
    || !gcIso(created.observedAt) || !gcId(operation.exerciseId) || !gcId(operation.bookingId)
    || !gcIso(operation.confirmedAt) || !gcId(operation.managedEntitlementOperationId)
    || operation.managedSubscriptionInstanceId !== b.runtime.subscriptionInstanceId
    || operation.managedDecision?.policyDigest !== b.expectations.policyDigest
    || operation.managedDecision?.policyVersion !== b.expectations.policyVersion
    || operation.managedDecision?.money?.finalPriceMinor !== 0 || operation.managedDecision?.usageUnits !== 1) return null;
  return { schemaVersion: 1, operationId: row.identity.operationId, admissionRequestSha256: row.admissionRequestSha256,
    actor: { tenantId: row.identity.tenantId, userId: row.identity.userId }, target: row.body.target,
    providerExerciseId: operation.exerciseId, providerBookingId: operation.bookingId,
    entitlement: { subscriptionInstanceId: operation.managedSubscriptionInstanceId,
      policyVersion: b.expectations.policyVersion, policyDigest: b.expectations.policyDigest,
      usageOperationId: operation.managedEntitlementOperationId, reservedUnits: 1 }, confirmedAt: operation.confirmedAt };
};
const gcoReceiptMatches = (receipt, row) => gcKeys(receipt, 'schemaVersion,operationId,admissionRequestSha256,actor,target,providerExerciseId,providerBookingId,entitlement,confirmedAt')
  && receipt.schemaVersion === 1 && receipt.operationId === row.identity.operationId
  && receipt.admissionRequestSha256 === row.admissionRequestSha256
  && gcoEqual(receipt.actor, { tenantId: row.identity.tenantId, userId: row.identity.userId })
  && gcoEqual(receipt.target, row.body.target) && gcId(receipt.providerExerciseId) && gcId(receipt.providerBookingId)
  && gcIso(receipt.confirmedAt) && Date.parse(receipt.confirmedAt) <= Date.now()
  && gcKeys(receipt.entitlement, 'subscriptionInstanceId,policyVersion,policyDigest,usageOperationId,reservedUnits')
  && receipt.entitlement.subscriptionInstanceId === row.binding?.runtime.subscriptionInstanceId
  && receipt.entitlement.policyVersion === row.binding?.expectations.policyVersion
  && receipt.entitlement.policyDigest === row.binding?.expectations.policyDigest
  && gcId(receipt.entitlement.usageOperationId) && receipt.entitlement.reservedUnits === 1;
const gcoActive = (value) => gcObject(value)
  && !['isCancelled', 'cancelled', 'canceled', 'archived', 'deleted', 'disabled'].some(k => value[k] === true)
  && !['cancelledAt', 'cancellationDate', 'archivedAt', 'deletedAt'].some(k => value[k] != null && value[k] !== '')
  && !['status', 'state', 'bookingStatus'].some(k => value[k] !== undefined
    && !['CONFIRMED', 'ACTIVE', 'BOOKED'].includes(String(value[k]).toUpperCase()));
// Every present provider alias must agree. A correct primary field never masks a
// contradictory nested identity in the same authoritative response.
const gcoAliases = (...values) => {
  const present = values.filter(v => v !== undefined);
  return present.length && present.every(gcId) && new Set(present).size === 1 ? present[0] : null;
};
const gcoRejectionReceiptMatches = (r, row) => gcKeys(r, 'schemaVersion,outcome,operationId,admissionRequestSha256,actor,target,reason,providerStatusCode,providerRejectedAt,rejectedAt,entitlement')
  && r.schemaVersion === 1 && r.outcome === 'REJECTED' && r.operationId === row.identity.operationId
  && r.admissionRequestSha256 === row.admissionRequestSha256 && r.reason === 'PROVIDER_REJECTED'
  && gcoEqual(r.actor, { tenantId: row.identity.tenantId, userId: row.identity.userId }) && gcoEqual(r.target, row.body.target)
  && [400, 401, 403, 404, 405, 410, 415, 422].includes(r.providerStatusCode)
  && gcIso(r.providerRejectedAt) && gcIso(r.rejectedAt) && Date.parse(r.providerRejectedAt) <= Date.parse(r.rejectedAt)
  && Date.parse(r.rejectedAt) <= Date.now()
  && gcKeys(r.entitlement, 'subscriptionInstanceId,usageOperationId,operationState,compensationState,releaseReason,providerBookingId')
  && r.entitlement.subscriptionInstanceId === row.binding?.runtime.subscriptionInstanceId && gcId(r.entitlement.usageOperationId)
  && r.entitlement.operationState === 'FAILED' && r.entitlement.compensationState === 'APPLIED'
  && r.entitlement.releaseReason === 'PROVIDER_REJECTED' && r.entitlement.providerBookingId === null;
const gcoCanonicalRejection = (operation, row) => {
  if (!gcObject(row) || !gcObject(row.identity) || !gcoRequest(row.body) || !gcoBindingMatches(row) || !gcoFactsMatches(row)) return null;
  const marker = operation?.precreateRejection, proof = operation?.managedCreateReleaseProof, readback = proof?.readback;
  const i = row.identity, p = row.body.preparation;
  const expectedTarget = { placeholderExerciseId: 'split-create:' + i.operationId, actorClientId: i.providerClientId,
    clientSubscriptionId: i.providerClientSubscriptionId, subscriptionInstanceId: row.binding?.runtime.subscriptionInstanceId,
    policyDigest: row.binding?.expectations.policyDigest, stationId: i.providerStationId, roomId: i.providerRoomId,
    category: 'open_game', externalEventTypeId: 'viva:direction:4588:type:1613', startsAt: p.target.startsAt,
    durationMinutes: 60, serviceDate: gcMoscow(p.target.startsAt).slice(0, 10) };
  if (!gcoCanonicalMatches(operation, row) || operation.state !== 'RELEASED' || operation.releaseReason !== 'VIVA_EXERCISE_CREATE_REJECTED'
    || operation.exerciseId !== expectedTarget.placeholderExerciseId || operation.providerCreateReceipt !== undefined
    || operation.bookingId || operation.upstreamBookingId || operation.precreateRecoveredAt || operation.precreatedEntitlementReserved
    || !gcoEqual(operation.precreateRecoveryTarget, expectedTarget)
    || !gcKeys(marker, 'schemaVersion,reason,operationId,entitlementOperationId,providerStatusCode,observedAt,tenantKey,actorClientId,clientSubscriptionId,subscriptionInstanceId,placeholderExerciseId,recoveryTarget')
    || marker.schemaVersion !== 1 || marker.reason !== 'PROVIDER_REJECTED' || marker.operationId !== i.operationId
    || marker.tenantKey !== i.tenantKey || marker.actorClientId !== i.providerClientId || marker.clientSubscriptionId !== i.providerClientSubscriptionId
    || marker.subscriptionInstanceId !== expectedTarget.subscriptionInstanceId || marker.entitlementOperationId !== operation.managedEntitlementOperationId
    || marker.placeholderExerciseId !== expectedTarget.placeholderExerciseId || !gcoEqual(marker.recoveryTarget, expectedTarget)
    || !gcKeys(proof, 'schemaVersion,observedAt,readback') || proof.schemaVersion !== 1 || !gcIso(proof.observedAt)
    || !gcKeys(readback, 'schemaVersion,operationId,subscriptionInstanceId,operationState,compensationState,releaseReason,providerBookingId')
    || readback.schemaVersion !== 1 || readback.operationId !== marker.entitlementOperationId
    || readback.subscriptionInstanceId !== marker.subscriptionInstanceId) return null;
  const receipt = { schemaVersion: 1, outcome: 'REJECTED', operationId: i.operationId, admissionRequestSha256: row.admissionRequestSha256,
    actor: { tenantId: i.tenantId, userId: i.userId }, target: row.body.target, reason: 'PROVIDER_REJECTED',
    providerStatusCode: marker.providerStatusCode, providerRejectedAt: marker.observedAt, rejectedAt: proof.observedAt,
    entitlement: { subscriptionInstanceId: readback.subscriptionInstanceId, usageOperationId: readback.operationId,
      operationState: readback.operationState, compensationState: readback.compensationState,
      releaseReason: readback.releaseReason, providerBookingId: readback.providerBookingId } };
  return gcoRejectionReceiptMatches(receipt, row) ? receipt : null;
};
