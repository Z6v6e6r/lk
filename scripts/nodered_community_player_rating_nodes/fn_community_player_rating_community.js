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
