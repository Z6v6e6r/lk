const toRows = (value) => Array.isArray(value) ? value : [];
const toTrimmed = (value) => typeof value === 'string' ? value.trim() : '';
const toNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const json = (statusCode, payload) => Object.assign({}, msg, {
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  payload,
});

const ctx = msg._communityPlayerRating || {};
const snapshot = toRows(msg.payload)[0];
if (!snapshot || (!Array.isArray(snapshot.rows) && !Array.isArray(snapshot.items))) {
  return json(503, {
    error: 'RATING_SNAPSHOT_NOT_READY',
    communityId: ctx.communityId,
    playerId: ctx.playerId,
    tab: ctx.tab,
    period: ctx.period,
  });
}

const acceptableIds = [ctx.playerId, ctx.snapshotPlayerId].map(toTrimmed).filter(Boolean);
const item = toRows(snapshot.rows || snapshot.items).find((row) => (
  acceptableIds.includes(toTrimmed(row?.playerId))
  || acceptableIds.map((id) => `id:${id}`).includes(toTrimmed(row?.playerKey))
));
if (!item) {
  return json(503, {
    error: 'PLAYER_RATING_NOT_READY',
    communityId: ctx.communityId,
    playerId: ctx.playerId,
    tab: ctx.tab,
    period: ctx.period,
  });
}

return json(200, {
  communityId: ctx.communityId,
  playerId: ctx.playerId,
  tab: toTrimmed(snapshot.tab) || ctx.tab,
  period: toTrimmed(snapshot.period) || ctx.period,
  updatedAt: toTrimmed(snapshot.updatedAt) || null,
  dataThrough: toTrimmed(snapshot.dataThrough) || null,
  sourceVersion: toTrimmed(snapshot.sourceVersion) || null,
  calculationVersion: toTrimmed(snapshot.calculationVersion) || 'community-rating-v1.3.0',
  rating: {
    rank: Math.max(1, Math.floor(toNumber(item.rank, 1))),
    currentLevel: toNumber(item.currentLevel),
    levelDelta: toNumber(item.levelDelta),
    lastRatingDelta: item.lastRatingDelta == null ? null : toNumber(item.lastRatingDelta),
    lastRatingChangedAt: toTrimmed(item.lastRatingChangedAt) || null,
    gamesPlayed: Math.max(0, Math.floor(toNumber(item.gamesPlayed))),
    gamesWon: Math.max(0, Math.floor(toNumber(item.gamesWon))),
    gamesLost: Math.max(0, Math.floor(toNumber(item.gamesLost))),
    winRate: toNumber(item.winRate),
    tournamentsPlayed: Math.max(0, Math.floor(toNumber(item.tournamentsPlayed))),
    bestPlace: item.bestPlace == null ? null : Math.max(1, Math.floor(toNumber(item.bestPlace, 1))),
    visitsAttended: Math.max(0, Math.floor(toNumber(item.visitsAttended))),
    gamesScore: toNumber(item.gamesScore),
    tournamentScore: toNumber(item.tournamentScore),
    activityScore: toNumber(item.activityScore),
    overallScore: toNumber(item.overallScore),
    totalEventsPlayed: Math.max(0, Math.floor(toNumber(item.totalEventsPlayed))),
    lastActivityAt: toTrimmed(item.lastActivityAt) || null,
    badges: toRows(item.badges).filter((badge) => typeof badge === 'string'),
  },
});
