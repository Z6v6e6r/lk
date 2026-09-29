const ctx = isObj(msg._communityList) ? msg._communityList : {};
const publicBaseUrl = buildPublicBaseUrl(msg.req);
const rows = toArray(msg.payload).filter((item) => !item?.archived);
const isSummaryMode = ctx.listMode === 'SUMMARY';
if (isSummaryMode && rows.some((item) => [
  item?._summaryMemberCount,
  item?._summaryPendingCount,
  item?._summaryBannedCount,
].some((count) => !Number.isSafeInteger(count) || count < 0))) {
  const errorMsg = withJson(msg, 500, { error: 'COMMUNITY_SUMMARY_COUNT_PROJECTION_MISSING' });
  return [errorMsg, errorMsg];
}
const scopedRows = isSummaryMode
  ? rows.filter((item) => canListCommunityForViewer(item, ctx.clientId, ctx.phone))
  : rows;
const communities = scopedRows
  .map((item) => {
    const normalized = isSummaryMode
      ? normalizeCommunitySummaryForResponse(item, ctx.clientId, ctx.phone, { publicBaseUrl })
      : normalizeCommunityForResponse(item, { publicBaseUrl });
    if (!isSummaryMode) return normalized;
    return Object.assign({}, normalized, {
      memberCount: Number.isFinite(Number(item.memberCount))
        ? Number(item.memberCount)
        : item._summaryMemberCount,
      pendingCount: item._summaryPendingCount,
      bannedCount: item._summaryBannedCount,
    });
  })
  .sort((left, right) => Date.parse(right.createdAt || nowIso) - Date.parse(left.createdAt || nowIso));

msg.statusCode = 200;
msg.headers = jsonHeaders;
msg.payload = {
  communities,
  connections: isSummaryMode ? [] : buildConnections(scopedRows),
  total: communities.length,
};
return [msg, msg];
