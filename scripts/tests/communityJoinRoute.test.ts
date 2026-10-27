import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommunityJoinRouteData } from "../../src/utils/communityJoinRoute.ts";
import * as communityJoinRoute from "../../src/utils/communityJoinRoute.ts";

const defaultCabinetUrl = "https://padlhub.ru/lk_dev";
const defaultCommunityJoinPath = "/community_join";

test("invitation continuation opens the exact community without re-entering invite flow", () => {
  assert.equal(typeof communityJoinRoute.buildCommunityCabinetUrl, "function");
  const url = new URL(communityJoinRoute.buildCommunityCabinetUrl(
    "https://padlhub.ru/lk_new?authMode=viva&channel=prod",
    "synthetic-community-id",
  ));
  assert.equal(url.pathname, "/lk_new");
  assert.deepEqual([...url.searchParams], [
    ["authMode", "viva"], ["channel", "prod"], ["openCommunity", "synthetic-community-id"],
  ]);
  assert.equal(resolveCommunityJoinRouteData({
    href: url.toString(), defaultCabinetUrl, defaultCommunityJoinPath,
  }).enabled, false);
});

test("community continuation replaces stale selection and URL-encodes the exact identifier", () => {
  const communityId = "community_123_тестовая-команда";
  const url = new URL(communityJoinRoute.buildCommunityCabinetUrl(
    "https://padlhub.ru/lk_new?authMode=viva&openCommunity=old#existing-anchor",
    communityId,
  ));
  assert.deepEqual(url.searchParams.getAll("openCommunity"), [communityId]);
  assert.equal(url.searchParams.get("authMode"), "viva");
  assert.equal(url.hash, "#existing-anchor");
});

test("oauth callback code on cabinet route does not open community invite page", () => {
  const routeData = resolveCommunityJoinRouteData({
    href: "https://padlhub.ru/lk_dev?authMode=viva&code=oauth-code-123&state=oauth-state-456",
    defaultCabinetUrl,
    defaultCommunityJoinPath,
  });

  assert.equal(routeData.enabled, false);
  assert.equal(routeData.inviteCode, null);
  assert.equal(routeData.inviteLink, null);
  assert.equal(routeData.cabinetUrl, defaultCabinetUrl);
});

test("legacy community invite code stays supported on community_join route", () => {
  const routeData = resolveCommunityJoinRouteData({
    href: "https://padlhub.ru/community_join?code=legacy-community-code",
    defaultCabinetUrl,
    defaultCommunityJoinPath,
  });

  assert.equal(routeData.enabled, true);
  assert.equal(routeData.inviteCode, "legacy-community-code");
  assert.equal(routeData.inviteLink, null);
});

test("explicit invite param on cabinet route still opens community invite page", () => {
  const routeData = resolveCommunityJoinRouteData({
    href: "https://padlhub.ru/lk_dev?authMode=viva&invite=community-code-789",
    defaultCabinetUrl,
    defaultCommunityJoinPath,
  });

  assert.equal(routeData.enabled, true);
  assert.equal(routeData.inviteCode, "community-code-789");
});
