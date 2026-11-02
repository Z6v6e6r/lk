import { smKeys, smId, smUuid, smDigest, smSequence, smHash, smMongoIdentity, smEqual, smIdentity, smReadPosition } from './stationMembershipLifetime.mjs';
import { stationStreamEnvelope } from './stationMessageStream.mjs';
import { committedProof, requestKey } from './stationMessageProof.mjs';

export const NF_VERSION = 'station-notifications.v1';
export const NF_NAMESPACE = 'iSkq6G'; // Same installed owner namespace as message request keys, never a canonical tenant alias.
export const NF_BUDGET_MS = 10000;
export const NF_MAX_TIME_MS = 3000;
export const NF_INDEX = 'station_notification_publications_v1';
export const nfIndexProposal = { name: NF_INDEX, key: { communityId: 1, streamId: 1, sequence: 1 }, collation: { locale: 'simple' }, partialFilterExpression: { stationMessageOwner: 1, recordType: 'MESSAGE', state: 'COMMITTED', archived: false } };
const nfFail = () => { throw Error('STATION_NOTIFICATION_UNAVAILABLE'); };
const nfUuid = x => smUuid(x) && x.length === 36;
const nfSafeId = x => smId(x) && !/[\r\n]/.test(x);
const nfSeq = x => typeof x === 'number' && smSequence(x);
export const nfPath = mode => '/lk/internal/station-notifications/v1/' + mode;
export const nfBodyHash = body => smHash('station-notification-body:v1', body);
const nfFactValid = x => smKeys(x, ['messageId','sequence','authorPlayerId','proofHash']) && nfUuid(x.messageId) && nfSeq(x.sequence) && x.sequence > 0 && nfSafeId(x.authorPlayerId) && smDigest(x.proofHash);
const nfRecipientValid = x => smKeys(x, ['playerId','membershipEpoch','baselineSequence','readThroughSequence']) && nfSafeId(x.playerId) && [x.membershipEpoch,x.baselineSequence,x.readThroughSequence].every(nfSeq) && x.baselineSequence <= x.readThroughSequence;
export function nfRequest(mode, body) {
  const common = ['contractVersion','requestId','communityId','streamId','incarnationHash'];
  const extras = mode === 'publications' ? ['afterSequence','throughSequence','limit'] : mode === 'recipients' ? ['fact','afterPlayerId','limit'] : mode === 'eligibility' ? ['fact','recipient'] : null;
  if (!extras || !smKeys(body, [...common,...extras]) || body.contractVersion !== 1 || !nfUuid(body.requestId) || !nfSafeId(body.communityId) || !nfUuid(body.streamId) || !smDigest(body.incarnationHash)) return false;
  if (mode === 'publications') return nfSeq(body.afterSequence) && (body.throughSequence === null || nfSeq(body.throughSequence) && body.throughSequence >= body.afterSequence) && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 50;
  if (!nfFactValid(body.fact)) return false;
  return mode === 'recipients' ? (body.afterPlayerId === null || nfSafeId(body.afterPlayerId)) && Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 50 : nfRecipientValid(body.recipient);
}
// Operator readiness can derive these from an explicitly supplied adopted row. No discovery, DDL or adoption.
export function nfReadiness(community) {
  if (!community || community.communityType !== 'STATION' || community.archived === true || !nfSafeId(community.id) || !smMongoIdentity(community)) nfFail();
  const stream = stationStreamEnvelope(community), lifetime = community.stationMembershipLifetime;
  if (!Array.isArray(community.members) || !Array.isArray(community.bannedMembers) || community.members.some(m => !nfSafeId(smIdentity(m))) || community.bannedMembers.some(m => !nfSafeId(smIdentity(m))) || new Set(community.members.map(smIdentity)).size !== community.members.length) nfFail();
  return { ownerNamespace: NF_NAMESPACE, communityId: community.id, incarnationHash: smHash('station-notification-incarnation:v1', { ownerNamespace: NF_NAMESPACE, communityId: community.id, identity: smMongoIdentity(community) }), streamId: stream.streamId, publishedSequence: stream.publishedSequence, lifetime };
}
function nfBound(community, request) {
  const s = nfReadiness(community);
  if (s.communityId !== request.communityId || s.incarnationHash !== request.incarnationHash || s.streamId !== request.streamId) nfFail();
  return s;
}
export function nfFact(community, document) {
  return nfFactAtSnapshot(community, document, nfReadiness(community));
}
function nfFactAtSnapshot(community, document, s) {
  if (!document || !nfUuid(document.requestId) || !nfSafeId(document.actorId) || !committedProof({ key: requestKey(document.actorId, document.requestId), requestId: document.requestId, actorId: document.actorId, communityId: s.communityId }, document) || document.recordType !== 'MESSAGE' || document.streamId !== s.streamId || !smEqual(document.communityIdentity, smMongoIdentity(community)) || document.sequence > s.publishedSequence) nfFail();
  const fact = { messageId: document.id, sequence: document.sequence, authorPlayerId: document.actorId };
  return { ...fact, proofHash: smHash('station-notification-fact:v1', { ownerNamespace: NF_NAMESPACE, communityId: s.communityId, incarnationHash: s.incarnationHash, streamId: s.streamId, ...fact, requestHash: document.requestHash }) };
}
function nfEligible(community, fact, player, original) {
  if (!player || player.state !== 'ACTIVE' || player.playerId === fact.authorPlayerId || !community.members.some(m => smIdentity(m) === player.playerId && (!m.status || m.status === 'ACTIVE')) || community.bannedMembers.some(m => smIdentity(m) === player.playerId)) return null;
  const position = smReadPosition(community, player);
  if (fact.sequence <= position.baselineSequence || fact.sequence <= position.readThroughSequence) return null;
  if (original && (player.playerId !== original.playerId || player.epoch !== original.membershipEpoch || position.baselineSequence !== original.baselineSequence || position.readThroughSequence < original.readThroughSequence)) return null;
  return { playerId: player.playerId, membershipEpoch: player.epoch, baselineSequence: position.baselineSequence, readThroughSequence: position.readThroughSequence };
}
const nfReadOptions = () => ({ maxTimeMS: NF_MAX_TIME_MS, readPreference: 'primary', readConcern: { level: 'majority' } });
const nfOp = (ctx, step, store, args) => { ctx.step = step; return { ctx, store, method: 'aggregate', args }; };
const nfCommunity = (ctx, step) => nfOp(ctx, step, 'lk_communities', [[{ $match: { id: ctx.request.communityId } }, { $limit: 2 }], { ...nfReadOptions(), allowDiskUse: false }]);
export const nfError = (requestId, status = 503, code = 'STATION_NOTIFICATION_UNAVAILABLE') => ({ status, body: { contract: NF_VERSION, requestId: nfUuid(requestId) ? requestId : null, error: code } });
export function beginStationNotificationFeed(mode, request, { nowMs = Date.now(), expiresAtMs } = {}) {
  if (!nfRequest(mode, request) || !Number.isSafeInteger(nowMs) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= nowMs) throw Error('STATION_NOTIFICATION_REQUEST_INVALID');
  return nfCommunity({ mode, request, deadlineMs: Math.min(nowMs + NF_BUDGET_MS, expiresAtMs), expiresAtMs }, 'community');
}
function nfMessageRead(ctx) {
  const r = ctx.request, publications = ctx.mode === 'publications';
  const match = { communityId: r.communityId, stationMessageOwner: 1, recordType: 'MESSAGE', streamId: r.streamId, state: 'COMMITTED', archived: false, sequence: publications ? { $gt: r.afterSequence, $lte: ctx.throughSequence } : r.fact.sequence };
  return nfOp(ctx, 'messages', 'lk_community_chat_messages', [[{ $match: match }, { $sort: { sequence: 1 } }, { $limit: publications ? r.limit + 1 : 2 }, { $match: { $expr: { $lte: [{ $bsonSize: '$$ROOT' }, 65536] } } }], { ...nfReadOptions(), hint: NF_INDEX, collation: { locale: 'simple' }, allowDiskUse: false }]);
}
export function advanceStationNotificationFeed(ctx, rows, error = false, nowMs = Date.now()) {
  try {
    if (error || !Array.isArray(rows) || nowMs >= ctx.deadlineMs) nfFail();
    const r = ctx.request;
    if (ctx.step === 'community') {
      if (rows.length !== 1) nfFail();
      const c = rows[0], s = nfBound(c, r);
      ctx.community = c; ctx.snapshot = s;
      if (ctx.mode === 'publications') {
        ctx.throughSequence = r.throughSequence ?? s.publishedSequence;
        if (r.afterSequence > ctx.throughSequence || ctx.throughSequence > s.publishedSequence) nfFail();
      } else if (r.fact.sequence > s.publishedSequence) nfFail();
      return nfMessageRead(ctx);
    }
    if (ctx.step === 'messages') {
      const count = ctx.mode === 'publications' ? Math.min(r.limit + 1, ctx.throughSequence - r.afterSequence) : 1;
      if (rows.length !== count) nfFail();
      const facts = rows.map(d => nfFactAtSnapshot(ctx.community, d, ctx.snapshot));
      if (new Set(facts.map(f => f.messageId)).size !== facts.length || facts.some((f,i) => f.sequence !== (ctx.mode === 'publications' ? r.afterSequence + i + 1 : r.fact.sequence))) nfFail();
      if (ctx.mode !== 'publications' && !smEqual(facts[0], r.fact)) nfFail();
      ctx.facts = facts; ctx.events = rows.map(d => d.stationMessageEvent);
      if (ctx.mode === 'recipients') {
        const players = ctx.snapshot.lifetime.players.filter(p => r.afterPlayerId === null || p.playerId > r.afterPlayerId).sort((a,b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0);
        const scanned = players.slice(0, r.limit);
        ctx.nextPlayer = players.length > r.limit ? scanned.at(-1).playerId : null;
        ctx.recipients = scanned.map(p => nfEligible(ctx.community, r.fact, p)).filter(Boolean);
      }
      return nfOp(ctx, 'events', 'lk_community_events', [[{ $match: { _id: { $in: ctx.events.map(e => e._id) } } }, { $limit: count + 1 }, { $match: { $expr: { $lte: [{ $bsonSize: '$$ROOT' }, 65536] } } }], { ...nfReadOptions(), allowDiskUse: false }]);
    }
    if (ctx.step === 'events') {
      if (rows.length !== ctx.events.length || new Set(rows.map(e => e._id)).size !== rows.length || ctx.events.some(event => !rows.some(row => smEqual(event, row)))) nfFail();
      delete ctx.events; delete ctx.community; delete ctx.snapshot;
      return nfCommunity(ctx, 'final');
    }
    if (ctx.step !== 'final' || rows.length !== 1) nfFail();
    const community = rows[0], s = nfBound(community, r);
    if (ctx.facts.some(f => f.sequence > s.publishedSequence)) nfFail();
    const common = { contract: NF_VERSION, requestId: r.requestId, ownerNamespace: NF_NAMESPACE, communityId: r.communityId, incarnationHash: r.incarnationHash, streamId: r.streamId, checkedAtMs: nowMs, validUntilMs: Math.min(nowMs + 5000, ctx.deadlineMs) };
    let result;
    if (ctx.mode === 'publications') {
      if (ctx.throughSequence > s.publishedSequence) nfFail();
      const items = ctx.facts.slice(0, r.limit), next = r.afterSequence + items.length;
      result = { ...common, throughSequence: ctx.throughSequence, items, nextAfterSequence: next < ctx.throughSequence ? next : null, complete: next === ctx.throughSequence };
    } else if (ctx.mode === 'recipients') {
      // Retain the original epoch/baseline. Later lower read progress can still be unread;
      // a new epoch or read covering the message shrinks the page, never adds a recipient.
      const items = ctx.recipients.map(original => nfEligible(community, r.fact, s.lifetime.players.find(p => p.playerId === original.playerId), original)).filter(Boolean);
      result = { ...common, fact: r.fact, items, nextAfterPlayerId: ctx.nextPlayer, complete: ctx.nextPlayer === null };
    } else {
      const eligible = nfEligible(community, r.fact, s.lifetime.players.find(p => p.playerId === r.recipient.playerId), r.recipient);
      result = { ...common, fact: r.fact, recipient: r.recipient, outcome: eligible ? 'ALLOW' : 'DENY', ...(eligible ? { currentReadThroughSequence: eligible.readThroughSequence } : {}) };
    }
    return { response: { status: 200, body: result } };
  } catch { return { response: nfError(ctx?.request?.requestId) }; }
}
export async function runStationNotificationFeed(db, operation, { before, now = Date.now } = {}) {
  let next = operation;
  for (let i = 0; i < 5; i++) {
    if (next.response) return next;
    // Closed descriptor dispatch: even a malformed descriptor cannot become a write.
    if (next.method !== 'aggregate' || !['lk_communities','lk_community_chat_messages','lk_community_events'].includes(next.store)) return { response: nfError(next.ctx?.request?.requestId) };
    await before?.(next);
    let rows, failed = false;
    try { rows = await db.collection(next.store).aggregate(...next.args).toArray(); } catch { failed = true; }
    next = advanceStationNotificationFeed(next.ctx, rows, failed, now());
  }
  return { response: nfError(next.ctx?.request?.requestId) };
}

// Source-only operator preflight, fed explicit read-only row/listIndexes results.
// The observed frontier is NOT an authorized import floor or persisted checkpoint.
export function stationNotificationReadiness(community, indexes) {
  const s = nfReadiness(community);
  const matches = Array.isArray(indexes) ? indexes.filter(i => i.name === NF_INDEX) : [];
  const i = matches[0];
  if (matches.length !== 1 || JSON.stringify(i.key) !== JSON.stringify(nfIndexProposal.key) || !smEqual(i.partialFilterExpression, nfIndexProposal.partialFilterExpression) || (i.collation !== undefined && !smEqual(i.collation, { locale: 'simple' })) || (i.unique !== undefined && i.unique !== false) || (i.sparse !== undefined && i.sparse !== false) || (i.hidden !== undefined && i.hidden !== false) || i.expireAfterSeconds !== undefined) nfFail();
  return { contract: NF_VERSION, ownerNamespace: s.ownerNamespace, communityId: s.communityId, incarnationHash: s.incarnationHash, streamId: s.streamId, observedPublishedSequence: s.publishedSequence, index: NF_INDEX, initialReplayFloor: 'EXPLICIT_ACTIVATION_INPUT_REQUIRED' };
}
