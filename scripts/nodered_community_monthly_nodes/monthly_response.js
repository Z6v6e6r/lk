const ctx = msg._communityMonthly;
const doc = Array.isArray(msg.payload) ? msg.payload[0] : null;
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
if (!doc || doc.schemaVersion !== CommunityMonthly.COMMUNITY_MONTHLY_SCHEMA || doc.communityId !== ctx.communityId || doc.month !== ctx.month || doc.calculationVersion !== CommunityMonthly.COMMUNITY_RATING_CALCULATION_VERSION || !Array.isArray(doc.items)) {
  msg.statusCode = 503; msg.payload = { error: 'MONTHLY_RATING_NOT_READY', communityId: ctx.communityId, month: ctx.month }; return msg;
}
const updatedAtTs = Date.parse(doc.updatedAt);
const stale = !Number.isFinite(updatedAtTs) || ctx.nowTs - updatedAtTs > 16 * 60 * 60 * 1000;
msg.statusCode = 200;
msg.payload = { communityId: ctx.communityId, communityName: ctx.communityName, period: 'calendar_month', month: ctx.month, timeZone: 'Europe/Moscow', from: doc.from, until: doc.until, updatedAt: doc.updatedAt, dataThrough: doc.dataThrough || null, stale, calculationVersion: doc.calculationVersion, columns: CommunityMonthly.COMMUNITY_MONTHLY_COLUMNS, totalMembers: CommunityMonthly.number(doc.totalMembers), activeMembers: CommunityMonthly.number(doc.activeMembers), tournamentsCount: CommunityMonthly.number(doc.tournamentsCount), limit: 20, items: doc.items.slice(0, 20).map(CommunityMonthly.publicRankingRow) };
return msg;
