const ctx = msg._communityMonthly, tournaments = Array.isArray(msg.payload) ? msg.payload : [];
const items = [], seen = new Set();
for (const post of ctx.posts) {
  const id = CommunityMonthly.publicationEventId(post);
  const sources = post.kind === 'GAME' ? ctx.games : post.kind === 'TOURNAMENT' ? tournaments : [];
  const matching = sources.filter(item => [item.id, item.gameId, item.tournamentId, item.exerciseId, item.sourceTournamentId].includes(id));
  if (matching.length > 1) continue; // Ambiguous source IDs cannot authorize signup.
  const item = CommunityMonthly.publicPublishedEvent(post, ctx.nowTs, ctx.scope, matching[0]);
  const key = post.kind + ':' + id;
  if (!item || seen.has(key)) continue;
  seen.add(key); items.push(item);
}
items.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.eventId.localeCompare(b.eventId));
msg.statusCode = 200; msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
msg.payload = { communityId: ctx.communityId, scope: ctx.scope, timeZone: 'Europe/Moscow', updatedAt: new Date(ctx.nowTs).toISOString(), items, hasMore: ctx.hasMore, nextCursor: ctx.nextCursor, scannedPublications: ctx.posts.length };
return msg;
