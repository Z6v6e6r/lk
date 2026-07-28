import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommunityJoinRouteData } from "../../src/utils/communityJoinRoute.ts";

const defaultCabinetUrl = "https://padlhub.ru/lk_dev";
const defaultCommunityJoinPath = "/community_join";

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
