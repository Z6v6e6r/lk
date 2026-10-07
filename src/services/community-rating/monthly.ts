import { buildCommunityRatingSnapshot } from "./aggregates.ts";
import { COMMUNITY_RATING_CALCULATION_VERSION } from "./contract.ts";
import { extractCommunityRatingFacts, extractCommunityRatingMemberSeeds } from "./facts.ts";
import type { CommunityRatingSourceData } from "./recalculation.ts";
import { COMMUNITY_MONTHLY_SCHEMA, COMMUNITY_MONTHLY_COLUMNS, communityMonthWindow, monthlyReportId, publishedEventStartTs, publicRankingRow } from "./monthlyContract.ts";

export function buildCommunityMonthlyReport(source: CommunityRatingSourceData, nowTs = Date.now()) {
  const communityId = String(source.community.id || "").trim();
  if (!communityId) throw new Error("COMMUNITY_ID_REQUIRED");
  const window = communityMonthWindow(nowTs), updatedAt = new Date(nowTs).toISOString();
  const feedPosts = source.feedPosts.filter(post => {
    const kind = String(post.kind || post.type || "").toUpperCase();
    const gameId = String(post.relatedGameId || post.gameId || "");
    const games = kind === "GAME" ? source.games.filter(game => game.id === gameId || game.gameId === gameId) : [];
    if (games.length > 1) return false;
    const at = publishedEventStartTs(post, games[0]);
    // The scheduled event month remains authoritative after a late administrative close.
    return at != null && at >= window.fromTs && at < window.untilTs && at <= nowTs;
  });
  const factById = new Map(extractCommunityRatingFacts({ ...source, feedPosts, collectedAt: updatedAt }).map(fact => [fact.id, fact]));
  const facts = [...factById.values()].filter(fact => fact.occurredAtTs <= nowTs && (fact.eventType !== "visit" || (fact.occurredAtTs >= window.fromTs && fact.occurredAtTs < window.untilTs)));
  const members = extractCommunityRatingMemberSeeds(source);
  const snapshot = buildCommunityRatingSnapshot({ communityId, facts, members, period: "all", tab: "overall", nowTs, updatedAt });
  return {
    _id: monthlyReportId(communityId, window.month), schemaVersion: COMMUNITY_MONTHLY_SCHEMA,
    communityId, communityName: String(source.community.name || "Сообщество"), period: "calendar_month", month: window.month,
    timeZone: window.timeZone, from: window.from, until: window.until, updatedAt, dataThrough: snapshot.dataThrough,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION, columns: COMMUNITY_MONTHLY_COLUMNS,
    totalMembers: snapshot.rows.length, activeMembers: snapshot.rows.filter(row => row.totalEventsPlayed > 0).length,
    tournamentsCount: new Set(facts.filter(fact => fact.eventType === "tournament").map(fact => fact.eventId)).size,
    limit: 20, items: snapshot.rows.slice(0, 20).map(publicRankingRow),
  };
}
