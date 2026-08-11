const toTrimmed = (value) => typeof value === 'string' ? value.trim() : '';
const normalizeTab = (value) => {
  const normalized = toTrimmed(value).toLowerCase();
  return ['overall', 'dynamics', 'games', 'tournaments'].includes(normalized) ? normalized : 'overall';
};
const normalizePeriod = (value) => toTrimmed(value).toLowerCase() === '30d' ? '30d' : 'all';
const jsonError = (statusCode, code) => Object.assign({}, msg, {
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  payload: { error: code },
});

const communityId = toTrimmed(msg.req?.params?.communityId);
const playerId = toTrimmed(msg.req?.params?.playerId);
if (!communityId || !playerId) {
  return [null, jsonError(400, 'COMMUNITY_ID_AND_PLAYER_ID_REQUIRED')];
}

msg._communityPlayerRating = {
  communityId,
  playerId,
  tab: normalizeTab(msg.req?.query?.tab),
  period: normalizePeriod(msg.req?.query?.period),
};
msg.payload = { id: communityId, archived: { $ne: true } };
return [msg, null];
