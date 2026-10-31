import crypto from 'node:crypto';
import { resolveExerciseCategoryFromValue } from '../../src/utils/exerciseCategory.ts';
import { loadCommunitySchedule } from './communitySchedule.mjs';
import { communityType, parseCommunityTypeSettings } from '../../src/services/community-policy.ts';

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const phone = value => { const n = text(value).replace(/\D/g, ''); return n.length === 10 ? '7' + n : n.length === 11 && n[0] === '8' ? '7' + n.slice(1) : n; };
const first = (...values) => values.map(text).find(Boolean) || '';
const timestamp = value => { const n = Date.parse(text(value)); return Number.isFinite(n) ? n : null; };
const phoneMatch = normalized => {
  const variants = [normalized, ...(normalized.length === 11 && normalized[0] === '7' ? ['8' + normalized.slice(1), normalized.slice(1)] : [])];
  return new RegExp('^\\D*(?:' + variants.map(value => value.split('').join('\\D*')).join('|') + ')\\D*$');
};
const cancelled = value => value?.archived === true || value?.isCancelled === true || value?.isCanceled === true || /CANCEL|FAIL|DELET|DRAFT|WAIT|PENDING/.test(text(value?.status).toUpperCase());
export function communityPolicyEvent(kind, raw) {
  const id = first(raw.id, raw.gameId, raw.tournamentId, raw.exerciseId, raw.visitId);
  const stations = [...new Set([raw.stationId, raw.studioId, raw.booking?.studioId, raw.params?.stationId, raw.params?.studioId, raw.studio?.id, raw.station?.id].map(text).filter(Boolean))];
  const bookingTime = text(raw.booking?.timeFrom);
  const bookingStart = raw.booking?.date && /^\d{2}:\d{2}(:\d{2})?$/.test(bookingTime) ? raw.booking.date + 'T' + bookingTime + (bookingTime.length === 5 ? ':00' : '') + '+03:00' : null;
  const startsAt = first(raw.startsAt, raw.startAt, raw.startedAt, raw.params?.startsAt, raw.params?.startAt, bookingStart, raw.dateTime);
  const createdAt = first(raw.createdAt, raw.updatedAt);
  const participants = [raw.organizer, ...list(raw.participants), ...list(raw.players)].filter(value => value && typeof value === 'object' && !cancelled(value) && value.isWaitlist !== true && value.waiting !== true && value.spot !== 0);
  const confirmed = kind === 'TOURNAMENT' ? participants.filter(value => {
    const capacity = Number(raw.maxParticipants ?? raw.params?.maxParticipants ?? raw.maxClientsCount);
    return value === raw.organizer || (value.isCancelled === false && Number.isInteger(value.spot) && value.spot >= 1 && Number.isFinite(capacity) && value.spot <= capacity);
  }) : participants;
  const players = new Map();
  for (const value of confirmed) {
    const playerId = first(value.clientId, value.id, value.userId);
    if (!playerId || /[.$]/.test(playerId)) continue;
    const level = value.ratingNumeric ?? value.levelScore ?? value.currentLevel;
    players.set(playerId, { id: playerId, name: first(value.name, value.displayName) || 'Игрок', ...(phone(value.phone || value.phoneNorm) ? { phone: phone(value.phone || value.phoneNorm) } : {}), ...(typeof level === 'number' && Number.isFinite(level) ? { levelScore: level } : {}), role: 'MEMBER', status: 'ACTIVE' });
  }
  return { id, kind, raw, startsAt, createdAt, at: timestamp(startsAt) ?? timestamp(createdAt), stationId: stations.length === 1 ? stations[0] : null,
    directionId: first(raw.directionId, raw.params?.directionId, raw.direction?.id, raw.exercise?.direction?.id),
    exerciseTypeId: first(raw.typeId, raw.exerciseTypeId, raw.params?.typeId, raw.type?.id, raw.exercise?.type?.id),
    category: kind === 'TOURNAMENT' ? 'tournament' : kind === 'TRAINING' ? 'group_training' : resolveExerciseCategoryFromValue(raw) || first(raw.category, raw.eventCategory, raw.exerciseCategory), players: [...players.values()], eligible: Boolean(id) && !cancelled(raw) };
}
export function matchesCommunityPolicy(community, event) {
  const type = communityType(community.communityType);
  let config;
  try { config = parseCommunityTypeSettings(type, community.typeSettings); } catch { return false; }
  return matchesValidatedPolicy(community, event, config);
}
function matchesValidatedPolicy(community, event, config) {
  const type = communityType(community.communityType);
  if (!event.eligible || community.archived === true || !['STATION', 'CORPORATE'].includes(type)) return false;
  if (!Number.isSafeInteger(community.typeSettingsRevision) || community.typeSettingsRevision < 1) return false;
  const effective = timestamp(community.typeSettingsEffectiveAt);
  if (effective === null || event.at === null || event.at < effective) return false;
  if (type === 'STATION') return ['GAME', 'TOURNAMENT'].includes(event.kind) && event.stationId === config.stationId;
  return config.directionIds.includes(event.directionId) || config.exerciseTypeIds.includes(event.exerciseTypeId) || config.categories.includes(event.category);
}
function requestsPublicSchedule(community, config) {
  return community.communityType === 'CORPORATE' && community.archived !== true &&
    Number.isSafeInteger(community.typeSettingsRevision) && community.typeSettingsRevision >= 1 &&
    timestamp(community.typeSettingsEffectiveAt) !== null && Boolean(config) &&
    (config.directionIds.length > 0 || config.exerciseTypeIds.length > 0);
}
export function buildStationMembershipMutation(community, event, member, nowIso) {
  if (communityType(community.communityType) !== 'STATION' || !matchesCommunityPolicy(community, event)) return null;
  // Once adopted, a rollback of the feature flag cannot resurrect old scanned registrations.
  if (process.env.LK_STATION_MEMBERSHIP_LIFETIME_ENABLED === 'true' || community.stationMembershipLifetime !== undefined) return null;
  const identity = { $or: [{ id: member.id }, { clientId: member.id }, ...(member.phone ? [{ phone: phoneMatch(member.phone) }, { phoneNorm: phoneMatch(member.phone) }, { phoneNumber: phoneMatch(member.phone) }, { mobile: phoneMatch(member.phone) }] : [])] };
  if (!member.phone && list(community.bannedMembers).some(row => !first(row.id, row.clientId, row.userId, row.uuid) && phone(row.phone || row.phoneNorm || row.mobile))) return null;
  const publicMember = { ...member }; delete publicMember.phone;
  const stored = { ...publicMember, joinedAt: nowIso, joinSource: { type: 'STATION_EVENT', eventKind: event.kind, eventId: event.id, stationId: event.stationId } };
  return {
    filter: { id: community.id, archived: { $ne: true }, communityType: 'STATION', typeSettingsRevision: community.typeSettingsRevision,
      members: { $not: { $elemMatch: identity } }, bannedMembers: { $not: { $elemMatch: identity } } },
    update: [{ $set: {
      members: { $concatArrays: [{ $ifNull: ['$members', []] }, { $literal: [stored] }] },
      pendingMembers: { $filter: { input: { $ifNull: ['$pendingMembers', []] }, as: 'member', cond: { $and: [{ $ne: ['$$member.id', { $literal: member.id }] }, { $ne: ['$$member.clientId', { $literal: member.id }] }, ...(member.phone ? [{ $ne: ['$$member.phone', { $literal: member.phone }] }] : [])] } } },
      memberCount: { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] },
      membersCount: { $add: [{ $size: { $ifNull: ['$members', []] } }, 1] }, updatedAt: nowIso,
    } }],
  };
}
function publicSnapshot(event) {
  return { exerciseId: event.id, direction: { id: event.directionId }, studio: { id: event.stationId, name: first(event.raw.booking?.studioName, event.raw.stationName, event.raw.studio?.name) }, startsAt: event.startsAt, endsAt: event.raw.endsAt, clientsCount: event.raw.clientsCount, maxClientsCount: event.raw.maxClientsCount };
}
export function buildCommunityPolicyPost(community, event, nowIso) {
  const id = 'community-policy:' + [community.id, event.kind, event.id].map(encodeURIComponent).join(':');
  const description = [event.startsAt, first(event.raw.booking?.studioName, event.raw.studio?.name)].filter(Boolean).join(' • ');
  const post = { body: description, _id: id, id, communityId: community.id, kind: event.kind, title: first(event.raw.title, event.raw.name, event.raw.params?.name) || (event.kind === 'GAME' ? 'Игра' : event.kind === 'TOURNAMENT' ? 'Турнир' : 'Тренировка'),
    ...(event.kind === 'GAME' ? { relatedGameId: event.id } : event.kind === 'TOURNAMENT' ? { relatedTournamentId: event.id } : { relatedExerciseId: event.id }),
    startAt: event.startsAt || undefined, publishedAt: nowIso, createdAt: nowIso, createdTs: Date.parse(nowIso), archived: false,
    managedBy: 'community-policy-v1', policyRevision: community.typeSettingsRevision,
    details: { ...(event.kind === 'TOURNAMENT' ? { publicTournament: publicSnapshot(event) } : {}), stationId: event.stationId, directionId: event.directionId, exerciseTypeId: event.exerciseTypeId, category: event.category, startsAt: event.startsAt, endsAt: event.raw.endsAt || event.raw.timeToIso || null, exerciseId: event.id, source: 'COMMUNITY_POLICY' } };
  post.sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify([post.title, post.body, post.startAt, post.details])).digest('hex');
  return post;
}

// Atomic policy claim is the publication authorization point. Preserve bounded
// intents on the community so a crash after claim can finish after a type switch.
async function finishPostIntent(db, communityId, intent) {
  const result = await db.collection('lk_community_feed').updateOne(intent.filter, intent.update, intent.options);
  if (result.acknowledged !== true) throw new Error('COMMUNITY_POLICY_FEED_WRITE_UNACKNOWLEDGED');
  await db.collection('lk_communities').updateOne({ id: communityId }, { $pull: { communityPolicyOutbox: { id: intent.id } } });
  return result;
}
export async function publishCommunityPolicyIntent(db, community, operation) {
  const id = crypto.createHash('sha256').update(JSON.stringify([community.id, community.typeSettingsRevision, operation])).digest('hex');
  const intent = { id, ...operation };
  const claim = await db.collection('lk_communities').updateOne({ id: community.id, archived: { $ne: true }, communityType: community.communityType,
    typeSettingsRevision: community.typeSettingsRevision,
    communityPolicyOutbox: { $not: { $elemMatch: { id } } },
    $expr: { $lt: [{ $size: { $ifNull: ['$communityPolicyOutbox', []] } }, 100] },
  }, { $push: { communityPolicyOutbox: intent } });
  if (claim.matchedCount !== 1) {
    const current = await db.collection('lk_communities').findOne({ id: community.id });
    const approved = list(current?.communityPolicyOutbox).find(row => row.id === id);
    if (!approved) {
      if (current && current.archived !== true && current.communityType === community.communityType && current.typeSettingsRevision === community.typeSettingsRevision) {
        throw new Error(list(current.communityPolicyOutbox).length >= 100 ? 'COMMUNITY_POLICY_OUTBOX_FULL' : 'COMMUNITY_POLICY_CLAIM_CONFLICT');
      }
      return { modifiedCount: 0, upsertedCount: 0 };
    }
    return finishPostIntent(db, community.id, approved);
  }
  return finishPostIntent(db, community.id, intent);
}

/** Local projections only; never books, purchases, changes provider state or enrolls corporate members. */
export async function processCommunityPolicies(db, { sinceIso, nowIso, dryRun = true, maxEvents = 10000, loadSchedule = loadCommunitySchedule }) {
  const communities = await db.collection('lk_communities').find({ archived: { $ne: true }, $or: [{ communityType: { $in: ['STATION', 'CORPORATE'] } }, { 'communityPolicyOutbox.0': { $exists: true } }] }).limit(1001).toArray();
  if (communities.length > 1000) throw new Error('COMMUNITY_POLICY_COMMUNITY_LIMIT');
  const counts = { communities: communities.length, events: 0, memberships: 0, posts: 0, invalidPolicies: 0,
    scheduleRequested: false, scheduleAttempted: false, scheduleEvents: 0, scheduleUnavailable: false, affectedCommunityIds: [] };
  if (!communities.length) return counts;
  const policies = new Map();
  for (const community of communities) {
    try { policies.set(community, parseCommunityTypeSettings(community.communityType, community.typeSettings)); }
    catch { /* Invalid policies may still have previously authorized recovery intents. */ }
  }
  const events = [];
  // Future scheduled records are revisited when a community is first configured.
  const changed = { $or: [...['createdAt', 'updatedAt', 'startsAt', 'startAt'].map(key => ({ [key]: { $gte: sinceIso } })), { 'booking.date': { $gte: sinceIso.slice(0, 10) } }, { 'params.date': { $gte: sinceIso.slice(0, 10) } }] };
  for (const [collection, kind] of [['lk_games', 'GAME'], ['tournaments', 'TOURNAMENT'], ['lk_training_visits', 'TRAINING']]) {
    const rows = await db.collection(collection).find(changed).limit(maxEvents + 1).toArray();
    if (rows.length > maxEvents) throw new Error('COMMUNITY_POLICY_EVENT_LIMIT');
    events.push(...rows.map(row => communityPolicyEvent(kind, row)));
  }
  const localEvents = [...events];
  counts.scheduleRequested = communities.some(community => requestsPublicSchedule(community, policies.get(community)));
  if (counts.scheduleRequested) {
    counts.scheduleAttempted = true;
    try {
      const schedule = await loadSchedule({ nowIso });
      events.push(...schedule.map(raw => communityPolicyEvent(raw.kind, raw)));
      counts.scheduleEvents = schedule.length;
    } catch { counts.scheduleUnavailable = true; }
  }
  counts.events = events.length;
  for (const community of communities) {
    let affected = false;
    if (!dryRun) for (const pending of list(community.communityPolicyOutbox)) {
      const result = await finishPostIntent(db, community.id, pending);
      affected ||= result.modifiedCount > 0 || result.upsertedCount > 0;
    }
    const policy = policies.get(community);
    if (!policy) { counts.invalidPolicies++; continue; }
    // A different corporate policy must not make a local-only community consume
    // provider events. Recovery intents above retain their original authority.
    const selectedEvents = requestsPublicSchedule(community, policy) ? events : localEvents;
    for (const event of selectedEvents) {
      if (!event.eligible && event.id && !dryRun) {
        const key = 'community-policy:' + [community.id, event.kind, event.id].map(encodeURIComponent).join(':');
        const result = await db.collection('lk_community_feed').updateOne({ _id: key, communityId: community.id, managedBy: 'community-policy-v1', archived: { $ne: true } }, { $set: { archived: true, updatedAt: nowIso, archiveReason: 'SOURCE_CANCELLED' } });
        if (result.acknowledged !== true) throw new Error('COMMUNITY_POLICY_CANCEL_WRITE_UNACKNOWLEDGED');
        affected ||= result.modifiedCount > 0;
        continue;
      }
      if (!matchesValidatedPolicy(community, event, policy)) continue;
      if (community.communityType === 'STATION') for (const member of event.players) {
        const mutation = buildStationMembershipMutation(community, event, member, nowIso);
        if (!mutation) continue;
        if (dryRun) { counts.memberships++; continue; }
        const result = await db.collection('lk_communities').updateOne(mutation.filter, mutation.update);
        if (result.acknowledged !== true) throw new Error('COMMUNITY_POLICY_MEMBERSHIP_WRITE_UNACKNOWLEDGED');
        counts.memberships += result.modifiedCount; affected ||= result.modifiedCount > 0;
      }
      const link = event.kind === 'GAME' ? { relatedGameId: event.id } : event.kind === 'TOURNAMENT' ? { relatedTournamentId: event.id } : { relatedExerciseId: event.id };
      const existing = await db.collection('lk_community_feed').findOne({ communityId: community.id, kind: event.kind, ...link }, { projection: { _id: 1, managedBy: 1, archived: 1, sourceFingerprint: 1 } });
      const post = buildCommunityPolicyPost(community, event, nowIso);
      if (existing) {
        // Refresh our own active card, preserving manual posts and moderation.
        if (existing.managedBy === 'community-policy-v1' && existing.archived !== true && existing.sourceFingerprint !== post.sourceFingerprint && !dryRun) {
          const result = await publishCommunityPolicyIntent(db, community, { filter: { _id: existing._id, managedBy: 'community-policy-v1', archived: { $ne: true }, sourceFingerprint: existing.sourceFingerprint ?? { $exists: false } }, update: { $set: { title: post.title, body: post.body, startAt: post.startAt, details: post.details, sourceFingerprint: post.sourceFingerprint, policyRevision: community.typeSettingsRevision, updatedAt: nowIso } }, options: {} });
          affected ||= result.modifiedCount > 0;
        }
        continue;
      }
      if (dryRun) { counts.posts++; continue; }
      const result = await publishCommunityPolicyIntent(db, community, { filter: { _id: post._id }, update: { $setOnInsert: post }, options: { upsert: true } });
      counts.posts += result.upsertedCount; affected ||= result.upsertedCount > 0;
    }
    if (affected) counts.affectedCommunityIds.push(community.id);
  }
  return counts;
}
