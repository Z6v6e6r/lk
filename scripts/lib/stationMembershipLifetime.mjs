import crypto from 'node:crypto';

// Private STATION owner protocol. No provider calls; activation is coordinated separately.
export const SM_VERSION = 1;
export const SM_FLAG = 'LK_STATION_MEMBERSHIP_LIFETIME_ENABLED';
export const smObject = x => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
export const smId = x => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(x);
export const smUuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export const smDigest = x => typeof x === 'string' && /^sha256:[a-f0-9]{64}$/.test(x);
export const smKeys = (x, keys) => smObject(x) && Object.keys(x).sort().join(',') === [...keys].sort().join(',');
export function smCanonical(x) {
  if (Array.isArray(x)) return '[' + x.map(smCanonical).join(',') + ']';
  if (smObject(x)) return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + smCanonical(x[k])).join(',') + '}';
  if (x === undefined || (typeof x === 'number' && !Number.isFinite(x))) throw Error('STATION_INVALID_JSON');
  return JSON.stringify(x);
}
export const smHash = (domain, value) => 'sha256:' + crypto.createHash('sha256').update(domain + '\0' + smCanonical(value)).digest('hex');
export const smEqual = (a, b) => smCanonical(a) === smCanonical(b);
export const smIdentity = row => [row?.id, row?.clientId, row?.userId, row?.uuid].find(smId) || null;
export const smRows = x => Array.isArray(x) ? x : [];
export function smLifetime(community) {
  const value = community.stationMembershipLifetime;
  if (value === undefined) return { version: 1, revision: 0, players: [] };
  if (!smKeys(value, ['version', 'revision', 'players']) || value.version !== 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(value.players)) throw Error('STATION_LIFETIME_INVALID');
  const seen = new Set();
  for (const row of value.players) {
    if (!smObject(row) || !smId(row.playerId) || seen.has(row.playerId) ||
      !Number.isSafeInteger(row.epoch) || row.epoch < 0 || row.epoch >= Number.MAX_SAFE_INTEGER ||
      !['ACTIVE', 'LEFT', 'REMOVED', 'BANNED'].includes(row.state) ||
      (row.canonicalUserId !== undefined && !smUuid(row.canonicalUserId))) throw Error('STATION_LIFETIME_INVALID');
    seen.add(row.playerId);
  }
  return value;
}
export function smPlayer(community, playerId) {
  return smLifetime(community).players.find(p => p.playerId === playerId) || { playerId, epoch: 0, state: 'ACTIVE' };
}
export function smFence(community) {
  const lifetime = smLifetime(community);
  return community.stationMembershipLifetime === undefined
    ? { stationMembershipLifetime: { $exists: false } }
    : { 'stationMembershipLifetime.version': 1, 'stationMembershipLifetime.revision': lifetime.revision };
}
export function smTransition(community, playerId, state) {
  if (!smId(playerId) || !['ACTIVE', 'LEFT', 'REMOVED', 'BANNED'].includes(state)) throw Error('STATION_TRANSITION_INVALID');
  const lifetime = smLifetime(community), old = smPlayer(community, playerId);
  const row = { playerId, ...(old.canonicalUserId ? { canonicalUserId: old.canonicalUserId } : {}), epoch: old.epoch + 1, state };
  return { version: 1, revision: lifetime.revision + 1, players: [...lifetime.players.filter(p => p.playerId !== playerId), row] };
}
export function smRosterTransition(community, nextMembers, action, targetId, actorId) {
  if (['REMOVE', 'BAN'].includes(action)) {
    return smTransition(community, targetId, action === 'BAN' ? 'BANNED' : actorId === targetId ? 'LEFT' : 'REMOVED');
  }
  if (['UNBAN', 'APPROVE'].includes(action)) return smTransition(community, targetId, 'ACTIVE');
  // Explicit LK join/invite restores only the actually added player, never old operation evidence.
  let next = community;
  for (const row of smRows(nextMembers)) {
    const id = smIdentity(row);
    if (id && !smRows(community.members).some(m => smIdentity(m) === id)) {
      next = { ...next, stationMembershipLifetime: smTransition(next, id, 'ACTIVE') };
    }
  }
  return next.stationMembershipLifetime;
}
export function smAdmissionRequest(body) {
  return smKeys(body, ['contractVersion', 'operationId', 'requestSha256', 'activity', 'stationId']) && body.contractVersion === 1 &&
    smUuid(body.operationId) && smDigest(body.requestSha256) && smId(body.stationId) &&
    smKeys(body.activity, ['kind', 'id']) && body.activity.kind === 'GAME' && smUuid(body.activity.id);
}
export function smConfirmationRequest(body) {
  return smKeys(body, ['contractVersion', 'operationId', 'admissionId', 'admissionBindingSha256', 'confirmation']) && body.contractVersion === 1 &&
    smUuid(body.operationId) && smUuid(body.admissionId) && smDigest(body.admissionBindingSha256) &&
    smKeys(body.confirmation, ['kind', 'generationId', 'activityId']) && body.confirmation.kind === 'GAME_PARTICIPATION' &&
    smUuid(body.confirmation.generationId) && smUuid(body.confirmation.activityId);
}
export const smActor = claims => ({ tenantId: claims.tenant_id, canonicalUserId: claims.sub, playerId: claims.provider_client_id, providerMappingId: claims.provider_mapping_id });
export const smAdmissionKey = (actor, operationId) => 'v1:' + actor.tenantId + ':' + operationId;
export function smAdmissionId(actor, operationId) {
  const hex = smHash('station-membership-admission-id:v1', { tenantId: actor.tenantId, operationId }).slice(7, 39).split('');
  hex[12] = '8'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const h = hex.join(''); return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
export function smAdmissionBinding(actor, request) {
  return { contractVersion: 1, actor, operationId: request.operationId, requestSha256: request.requestSha256, activity: request.activity, stationId: request.stationId };
}
export function smAdmission(communities, actor, request) {
  const binding = smAdmissionBinding(actor, request);
  let reason = communities.length === 0 ? 'STATION_COMMUNITY_MISSING' : communities.length !== 1 ? 'STATION_COMMUNITY_AMBIGUOUS' : 'ELIGIBLE';
  const community = communities.length === 1 ? communities[0] : null;
  let epoch = null, policyRevision = null;
  if (community) {
    if (!smId(community.id) || community.communityType !== 'STATION' || community.archived === true || community.typeSettings?.stationId !== request.stationId ||
      !Number.isSafeInteger(community.typeSettingsRevision) || community.typeSettingsRevision < 1) reason = 'STATION_POLICY_INVALID';
    else {
      const player = smPlayer(community, actor.playerId);
      epoch = player.epoch; policyRevision = community.typeSettingsRevision;
      if (player.canonicalUserId && player.canonicalUserId !== actor.canonicalUserId) reason = 'ACTOR_MAPPING_CONFLICT';
      if (['REMOVED', 'BANNED'].includes(player.state) || smRows(community.bannedMembers).some(m => smIdentity(m) === actor.playerId)) reason = 'MEMBERSHIP_BLOCKED';
      // A phone-only ban cannot be safely excluded without provider/profile reads.
      if (smRows(community.bannedMembers).some(m => !smIdentity(m))) reason = 'BAN_IDENTITY_UNRESOLVED';
    }
  }
  const core = { ...binding, admissionId: smAdmissionId(actor, request.operationId), outcome: reason === 'ELIGIBLE' ? 'ADMITTED' : 'NO_ENROLLMENT',
    communityId: community && smId(community.id) ? community.id : null, policyRevision, membershipEpoch: epoch, reason };
  return { _id: smAdmissionKey(actor, request.operationId), ...core, bindingSha256: smHash('station-membership-admission:v1', core) };
}
export function smValidAdmission(doc, actor, operationId) {
  if (!smObject(doc) || doc._id !== smAdmissionKey(actor, operationId) || !smEqual(doc.actor, actor) || doc.operationId !== operationId) return false;
  const { _id, bindingSha256, ...core } = doc;
  return bindingSha256 === smHash('station-membership-admission:v1', core);
}
export function smClaim(admission, request) {
  return { _id: 'v1:' + admission.actor.tenantId + ':' + encodeURIComponent(admission.communityId) + ':GAME_PARTICIPATION:' + request.confirmation.generationId,
    contractVersion: 1, actor: admission.actor, communityId: admission.communityId, operationId: admission.operationId, admissionId: admission.admissionId,
    admissionBindingSha256: admission.bindingSha256, generationId: request.confirmation.generationId, activityId: request.confirmation.activityId, membershipEpoch: admission.membershipEpoch };
}
export function smConfirmation(communities, admission, claim) {
  if (communities.length !== 1 || communities[0].id !== admission.communityId) return { reason: 'STATION_SELECTOR_CHANGED' };
  const c = communities[0], id = admission.actor.playerId, p = smPlayer(c, id), lifetime = smLifetime(c);
  if (c.archived === true || c.communityType !== 'STATION' || c.typeSettings?.stationId !== admission.stationId || c.typeSettingsRevision !== admission.policyRevision) return { reason: 'STATION_POLICY_CHANGED' };
  if (p.epoch !== admission.membershipEpoch) return { reason: 'MEMBERSHIP_EPOCH_CHANGED' };
  if (['REMOVED', 'BANNED'].includes(p.state) || smRows(c.bannedMembers).some(m => !smIdentity(m) || smIdentity(m) === id)) return { reason: 'MEMBERSHIP_BLOCKED' };
  if (p.canonicalUserId && p.canonicalUserId !== admission.actor.canonicalUserId) return { reason: 'ACTOR_MAPPING_CONFLICT' };
  const proof = { operationId: admission.operationId, admissionId: admission.admissionId, generationId: claim.generationId };
  const members = smRows(c.members), active = members.find(m => smIdentity(m) === id);
  if (active) return { reason: p.state === 'ACTIVE' && smEqual(p.lastApplied || null, proof) ? 'ALREADY_APPLIED' : 'MEMBER_ALREADY_ACTIVE' };
  // A previously applied generation is not a new registration even if a foreign writer dropped the member.
  if (p.lastApplied?.generationId === claim.generationId) return { reason: 'APPLIED_MEMBER_MISSING' };
  const row = { playerId: id, canonicalUserId: admission.actor.canonicalUserId, epoch: p.epoch, state: 'ACTIVE', lastApplied: proof };
  const nextMembers = [...members, { id, name: 'Игрок', role: 'MEMBER', status: 'ACTIVE', joinSource: { type: 'STATION_ADMISSION' } }];
  const filter = { id: c.id, communityType: 'STATION', archived: { $ne: true }, 'typeSettings.stationId': admission.stationId, typeSettingsRevision: admission.policyRevision, ...smFence(c) };
  for (const field of ['members', 'pendingMembers', 'bannedMembers']) filter[field] = Object.hasOwn(c, field) ? c[field] : { $exists: false };
  return { reason: 'APPLY', filter, update: { $set: { members: nextMembers, memberCount: nextMembers.length, membersCount: nextMembers.length,
    pendingMembers: smRows(c.pendingMembers).filter(m => smIdentity(m) !== id),
    pendingCount: smRows(c.pendingMembers).filter(m => smIdentity(m) !== id).length,
    stationMembershipLifetime: { version: 1, revision: lifetime.revision + 1, players: [...lifetime.players.filter(r => r.playerId !== id), row] } } } };
}
