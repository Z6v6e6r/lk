import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const flowPatchSource = fs.readFileSync("scripts/patch_nodered_communities_flow.mjs", "utf8");

test("community rating Node-RED flow reads persisted snapshot before live fallback", () => {
  assert.match(flowPatchSource, /const fnRankingSnapshotResponse =/);
  assert.match(flowPatchSource, /community_ranking_find_snapshot_001/);
  assert.match(flowPatchSource, /community_rating_snapshots/);
  assert.match(
    flowPatchSource,
    /\[\['community_ranking_find_snapshot_001'\], \['community_ranking_http_resp_001'\], \['community_ranking_debug_001'\]\]/,
  );
  assert.match(
    flowPatchSource,
    /\[\['community_ranking_http_resp_001'\], \['community_ranking_find_rows_001'\], \['community_ranking_debug_001'\]\]/,
  );
});

test("community rating snapshot query is versioned by tab, period, and calculation version", () => {
  assert.match(flowPatchSource, /const COMMUNITY_RATING_CALCULATION_VERSION = 'community-rating-v1\.3\.0';/);
  assert.match(flowPatchSource, /\(toNum\(gamesNormalized\) \|\| 0\) \* 0\.2/);
  assert.match(flowPatchSource, /\(toNum\(tournamentNormalized\) \|\| 0\) \* 0\.6/);
  assert.match(flowPatchSource, /\(toNum\(activityScore\) \|\| 0\) \* 0\.2/);
  assert.match(flowPatchSource, /tab: normalizeRatingTab\(ctx\.tab\)/);
  assert.match(flowPatchSource, /period: normalizeRatingPeriod\(ctx\.period\)/);
  assert.match(flowPatchSource, /calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION/);
});

test("community rating Node-RED flow keeps only all-time and last-month periods", () => {
  assert.match(flowPatchSource, /normalized === 'all'/);
  assert.match(flowPatchSource, /normalized === '30d'/);
  assert.match(flowPatchSource, /normalized === '7d'/);
  assert.match(flowPatchSource, /normalized === '90d'/);
  assert.doesNotMatch(flowPatchSource, /return '7d'/);
  assert.doesNotMatch(flowPatchSource, /return '90d'/);
  assert.doesNotMatch(flowPatchSource, /period === '7d'/);
  assert.doesNotMatch(flowPatchSource, /period === '90d'/);
});

test("community rating returns degraded 503 instead of semantically different live fallback", () => {
  assert.match(flowPatchSource, /RATING_SNAPSHOT_NOT_READY/);
  assert.match(flowPatchSource, /withJson\(msg, 503/);
  assert.match(flowPatchSource, /calculateCommunityRatingItems/);
  assert.match(flowPatchSource, /communityId: ctx\.communityId,\s*\n\s*archived: \{ \$ne: true \}/);
  assert.match(flowPatchSource, /archived: \{ \$ne: true \},\s*\n\s*\}/);
});

test("community rating live fallback mirrors worker set pairings rules", () => {
  assert.match(flowPatchSource, /resolveGameSetTeams/);
  assert.match(flowPatchSource, /matchResult\?\.setPairings/);
  assert.match(flowPatchSource, /lastKnownTeams/);
  assert.match(flowPatchSource, /resolveGamePlayerPool/);
  assert.match(flowPatchSource, /PENDING_REVIEW/);
  assert.match(flowPatchSource, /NO_RESULT_EXPIRED/);
});

test("community rating live fallback uses finalized tournament guard and phone-aware standings matching", () => {
  assert.match(flowPatchSource, /const isTournamentFinalized =/);
  assert.match(flowPatchSource, /standing\.phone/);
  assert.match(flowPatchSource, /params\?\.manualFinishedAt/);
  assert.match(flowPatchSource, /tournament\?\.status/);
});

test("community rating live fallback queries linked game and tournament documents by both legacy and canonical ids", () => {
  assert.match(flowPatchSource, /\{ id: \{ \$in: gameIds \} \}/);
  assert.match(flowPatchSource, /\{ gameId: \{ \$in: gameIds \} \}/);
  assert.match(flowPatchSource, /\{ tournamentId: \{ \$in: tournamentIds \} \}/);
  assert.match(flowPatchSource, /\{ id: \{ \$in: tournamentIds \} \}/);
  assert.match(flowPatchSource, /\{ exerciseId: \{ \$in: tournamentIds \} \}/);
  assert.match(flowPatchSource, /\{ sourceTournamentId: \{ \$in: tournamentIds \} \}/);
});

test("community tournament post flow preserves nested details and resolves stable tournament link ids", () => {
  assert.match(flowPatchSource, /const resolvePostTournamentLinkId =/);
  assert.match(flowPatchSource, /details: ctx\.details \|\| null/);
  assert.match(flowPatchSource, /publicTournament/);
  assert.match(flowPatchSource, /sourceTournamentSnapshot/);
});

test("community flow functions avoid URL global that Node-RED editor does not type", () => {
  assert.doesNotMatch(flowPatchSource, /\bnew URL\(/);
});
