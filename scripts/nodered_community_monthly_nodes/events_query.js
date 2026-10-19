const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._communityMonthly;
ctx.posts = rows.slice(0, 200); ctx.hasMore = rows.length > 200;
ctx.nextCursor = ctx.hasMore ? CommunityMonthly.text(ctx.posts[ctx.posts.length - 1]?.id) : null;
const ids = [...new Set(ctx.posts.filter(post => post.kind === 'GAME').map(CommunityMonthly.publicationEventId).filter(Boolean))];
msg.payload = [{ $or: [{ id: { $in: ids } }, { gameId: { $in: ids } }] }, { projection: CommunityMonthly.publicEventSourceProjection(['id', 'gameId']) }];
return msg;
