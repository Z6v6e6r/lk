const toRows = (value) => Array.isArray(value) ? value : [];
const toTrimmed = (value) => typeof value === 'string' ? value.trim() : '';
const jsonError = (statusCode, code) => Object.assign({}, msg, {
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  payload: { error: code },
});
const exactMemberIds = (member) => ['id', 'clientId', 'userId', 'uuid', 'playerId']
  .map((field) => toTrimmed(member?.[field]))
  .filter(Boolean);

const ctx = msg._communityPlayerRating || {};
const community = toRows(msg.payload)[0];
if (!community) return [null, jsonError(404, 'COMMUNITY_NOT_FOUND')];

// COMMUNITY_TYPED_PLAYER_RATING_ACCESS
if (['STATION','CORPORATE','LEAGUE','EVENT'].includes(community.communityType) && String(community.visibility || '').toUpperCase() === 'CLOSED') {
  const failure = msg._communityPolicyAuthFailure;
  if (failure === 'INVALID' || failure === 'UNAVAILABLE') {
    delete msg._communityPolicyAuthFailure;
    return [null, jsonError(failure === 'INVALID' ? 401 : 503, failure === 'INVALID' ? 'AUTH_TOKEN_INVALID' : 'AUTH_SERVICE_UNAVAILABLE')];
  }
  const actorId = toTrimmed(msg._verifiedCommunityActor?.id);
  if (!actorId || !toRows(community.members).some(row => exactMemberIds(row).includes(actorId))) return [null, jsonError(403, 'COMMUNITY_ACCESS_DENIED')];
}

const member = toRows(community.members).find((item) => exactMemberIds(item).includes(ctx.playerId));
if (!member) return [null, jsonError(404, 'PLAYER_NOT_FOUND_IN_COMMUNITY')];
const snapshotPlayerId = exactMemberIds(member)[0] || ctx.playerId;

msg._communityPlayerRating = Object.assign({}, ctx, {
  communityId: toTrimmed(community.id) || ctx.communityId,
  snapshotPlayerId,
});
msg.payload = {
  communityId: toTrimmed(community.id) || ctx.communityId,
  tab: ctx.tab,
  period: ctx.period,
  calculationVersion: 'community-rating-v1.3.0',
};
return [msg, null];
