import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiSource = fs.readFileSync("src/utils/communityApi.ts", "utf8");
const communitiesSource = fs.readFileSync("src/components/cabinet/CommunitiesSection.tsx", "utf8");
const nodeRedPatchSource = fs.readFileSync("scripts/patch_nodered_communities_flow.mjs", "utf8");
const nodeRedListPrepareSource = fs.readFileSync(
  "scripts/nodered_community_list_nodes/fn_list_prepare_tail.js",
  "utf8",
);

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

test("Node-RED summary mode narrows rows and projects at most the current viewer", () => {
  const listResponseSource = sourceSlice(
    nodeRedPatchSource,
    "const fnListResponse =",
    "const fnGetPrepare =",
  );

  assert.match(nodeRedListPrepareSource, /visibility: \{ \$not: \/\^\\s\*CLOSED\\s\*\$\/i \}/);
  assert.match(nodeRedListPrepareSource, /accessFilters\.push\(\{ members: \{ \$elemMatch: viewerMatch \} \}\)/);
  assert.match(nodeRedListPrepareSource, /accessFilters\.push\(\{ pendingMembers: \{ \$elemMatch: viewerMatch \} \}\)/);
  assert.match(nodeRedListPrepareSource, /msg\.projection = summaryProjection/);
  assert.match(nodeRedListPrepareSource, /summaryProjection\.members = \{ \$elemMatch: viewerMatch \}/);
  assert.match(nodeRedListPrepareSource, /summaryProjection\.pendingMembers = \{ \$elemMatch: viewerMatch \}/);
  assert.doesNotMatch(nodeRedListPrepareSource, /^\s*logo:\s*1,/m);
  assert.doesNotMatch(nodeRedListPrepareSource, /^\s*logoLegacyDataUrl:\s*1,/m);
  assert.match(listResponseSource, /connections: isSummaryMode \? \[\] : buildConnections\(scopedRows\)/);
  assert.match(listResponseSource, /rows\.filter\(\(item\) => canListCommunityForViewer/);
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
  });
  [detailSource, feedSource].forEach((readSource) => {
    assert.match(readSource, /buildCommunityReadGetOptions/);
  });
  assert.match(listSource, /communityListReads\.run/);
  assert.match(listSource, /buildForceFreshCommunityGetOptions/);
  assert.match(listSource, /forceFresh: params\.forceFresh/);
  assert.doesNotMatch(readOptionsSource, /cache:/);
});

test("summary rows retain the legacy logo endpoint fallback without embedding the data URL", () => {
  const logoCandidatesSource = sourceSlice(
    apiSource,
    "export function buildCommunityLogoCandidates",
    "function decodeInviteSegment",
  );

  assert.match(logoCandidatesSource, /community-logo-legacy\/\$\{encodeURIComponent\(community\.id\)\}\/thumb/);
  assert.match(logoCandidatesSource, /community-logo-legacy\/\$\{encodeURIComponent\(community\.id\)\}`/);
});

test("successful community mutations invalidate the browser-memory list cache", () => {
  const mutationSource = sourceSlice(
    apiSource,
    "async function requestCommunityMutation",
    "function buildMemberPayload",
  );

  assert.match(mutationSource, /if \(finalResult\.error === null\)/);
  assert.match(mutationSource, /communityListReads\.clear\(\)/);
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
