const ctx = msg._communityMonthly;
const community = Array.isArray(msg.payload) ? msg.payload[0] : null;
const error = (status, code) => Object.assign({}, msg, { statusCode: status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, payload: { error: code } });
if (Array.isArray(msg.payload) && msg.payload.length > 1) return [null, error(409, 'AMBIGUOUS_COMMUNITY_ID')];
if (!community) return [null, error(404, 'COMMUNITY_NOT_FOUND')];
// Public endpoints never authorize a private community using caller-supplied identity.
if (CommunityMonthly.text(community.visibility).toUpperCase() !== 'OPEN') return [null, error(403, 'COMMUNITY_NOT_PUBLIC')];
ctx.communityName = CommunityMonthly.text(community.name);
if (ctx.route === 'monthly') {
  const window = CommunityMonthly.communityMonthWindow(ctx.nowTs);
  ctx.month = window.month;
  msg.payload = [{ _id: CommunityMonthly.monthlyReportId(ctx.communityId, window.month) }, { limit: 1 }];
} else {
  msg.payload = [{ communityId: ctx.communityId, archived: { $ne: true }, kind: { $in: ['GAME', 'TOURNAMENT', 'TRAINING', 'GROUP_TRAINING', 'EXERCISE', 'EVENT'] }, ...(ctx.cursor ? { id: { $gt: ctx.cursor } } : {}) }, { sort: { id: 1 }, limit: 201 }];
}
return [msg, null];
