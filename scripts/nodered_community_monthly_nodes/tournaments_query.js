const ctx = msg._communityMonthly;
ctx.games = Array.isArray(msg.payload) ? msg.payload : [];
const ids = [...new Set(ctx.posts.filter(post => post.kind === 'TOURNAMENT').map(CommunityMonthly.publicationEventId).filter(Boolean))];
msg.payload = [{ $or: ['tournamentId', 'id', 'exerciseId', 'sourceTournamentId'].map(key => ({ [key]: { $in: ids } })) }, { projection: CommunityMonthly.publicEventSourceProjection(['tournamentId', 'id', 'exerciseId', 'sourceTournamentId']) }];
return msg;
