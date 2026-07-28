import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiSource = fs.readFileSync("src/utils/communityApi.ts", "utf8");
const communitiesSource = fs.readFileSync("src/components/cabinet/CommunitiesSection.tsx", "utf8");
const nodeRedPatchSource = fs.readFileSync("scripts/patch_nodered_communities_flow.mjs", "utf8");

function sourceSlice(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("community list always requests the summary projection", () => {
  const listSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunities",
    "export async function apiFetchCommunity(",
  );
  const initialListLoad = sourceSlice(
    communitiesSource,
    "const loadCommunities = async () => {",
    "void loadCommunities();",
  );

  assert.match(listSource, /query\.set\("view", "summary"\)/);
  assert.match(initialListLoad, /view: "summary"/);
  assert.doesNotMatch(listSource, /maybeAppendCacheBuster/);
});

test("Node-RED summary mode projects at most the current viewer instead of full rosters", () => {
  const listPrepareSource = sourceSlice(
    nodeRedPatchSource,
    "const fnListPrepare =",
    "const fnListResponse =",
  );
  const listResponseSource = sourceSlice(
    nodeRedPatchSource,
    "const fnListResponse =",
    "const fnGetPrepare =",
  );

  assert.match(listPrepareSource, /msg\.payload = listQuery/);
  assert.match(listPrepareSource, /msg\.projection = summaryProjection/);
  assert.doesNotMatch(listPrepareSource, /msg\.payload = \[listQuery/);
  assert.match(listPrepareSource, /summaryProjection\.members = \{ \$elemMatch: viewerMatch \}/);
  assert.match(listPrepareSource, /summaryProjection\.pendingMembers = \{ \$elemMatch: viewerMatch \}/);
  assert.match(listResponseSource, /connections: isSummaryMode \? \[\] : buildConnections\(scopedRows\)/);
});

test("ordinary community reads reuse stable URLs", () => {
  const readOptionsSource = sourceSlice(
    apiSource,
    "function buildCommunityReadGetOptions",
    "function buildForceFreshCommunityGetOptions",
  );
  const listSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunities",
    "export async function apiFetchCommunity(",
  );
  const detailSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunity(",
    "export async function apiCreateCommunity(",
  );
  const feedSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunityFeed(",
    "export async function apiCreateCommunityFeedPost(",
  );
  const threadSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunityPostThread(",
    "export async function apiCreateCommunityPostComment(",
  );
  const chatSource = sourceSlice(
    apiSource,
    "export async function apiFetchCommunityChatMessages(",
    "export async function apiCreateCommunityChatMessage(",
  );
  const rankingStart = apiSource.indexOf("export async function apiFetchCommunityRanking(");
  assert.notEqual(rankingStart, -1, "missing community ranking reader");
  const rankingSource = apiSource.slice(rankingStart);

  [listSource, detailSource, feedSource, threadSource, chatSource, rankingSource].forEach((readSource) => {
    assert.doesNotMatch(readSource, /maybeAppendCacheBuster/);
    assert.doesNotMatch(readSource, /query\.set\("_ts"/);
  });
  [listSource, detailSource, feedSource].forEach((readSource) => {
    assert.match(readSource, /params\.forceFresh[\s\S]*appendForceFreshCacheBuster/);
    assert.match(readSource, /buildCommunityReadGetOptions/);
  });
  assert.doesNotMatch(readOptionsSource, /cache:/);
});

test("full community and feed load only after opening a detail and are reused afterwards", () => {
  const detailLoad = sourceSlice(
    communitiesSource,
    "if (!selectedCommunityId) {",
    "const refreshCommunityFeedPage = useCallback",
  );

  assert.match(detailLoad, /const shouldLoadMembers = !selectedCommunitySnapshot\.membersLoaded/);
  assert.match(detailLoad, /const shouldLoadFeed = !isSelectedCommunityFeedLoaded/);
  assert.match(detailLoad, /if \(!shouldLoadMembers && !shouldLoadFeed\)/);
  assert.match(detailLoad, /apiFetchCommunity\(communityId, \{[\s\S]*phone: profile\.phone,[\s\S]*clientId: profile\.id,[\s\S]*\}\)/);
  assert.match(detailLoad, /loadInitialCommunityFeed\(communityId\)/);
  assert.doesNotMatch(detailLoad, /forceFresh: true/);
});

test("only explicit forceFresh keeps cache busting for post-mutation refreshes", () => {
  const cacheBusterSource = sourceSlice(
    apiSource,
    "function appendForceFreshCacheBuster",
    "function buildCommunityGetOptions",
  );
  const forceFreshOptionsSource = sourceSlice(
    apiSource,
    "function buildForceFreshCommunityGetOptions",
    "export async function apiFetchCommunities",
  );
  const autopublishRefreshSource = sourceSlice(
    communitiesSource,
    "createdGames.forEach((game) => {",
    "const loadCommunityChatMessages = useCallback",
  );

  assert.match(cacheBusterSource, /query\.set\("_ts", String\(Date\.now\(\)\)\)/);
  assert.match(forceFreshOptionsSource, /cache: "no-store"/);
  assert.doesNotMatch(autopublishRefreshSource, /forceFresh: true/);
  assert.match(autopublishRefreshSource, /refreshCommunityFeedPage\(communityId\)/);
});
