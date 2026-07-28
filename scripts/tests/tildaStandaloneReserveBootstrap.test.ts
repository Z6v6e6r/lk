import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const STANDALONE_TILDA_TEMPLATES = [
  "docs/tilda-game-create.html",
  "docs/tilda-game-create-composite.html",
  "docs/tilda-finde-game.html",
  "docs/tilda-game-join.html",
  "docs/tilda-tournaments.html",
  "docs/tilda-tournament-signup.html",
  "docs/tilda-tournament-subscription.html",
  "docs/tilda-tournament-subscription-sirius.html",
  "docs/tilda-tournament-subscription-referral.html",
];

const RELEASE_FETCH_TEMPLATES = [
  ...STANDALONE_TILDA_TEMPLATES,
  "docs/tilda-game-create-composite-dev-only.html",
  "docs/tilda-finde-game-plus-trainer-dev-only.html",
  "docs/tilda-group-schedule.html",
];

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("standalone Tilda templates preserve reserve runtime base-url context", () => {
  STANDALONE_TILDA_TEMPLATES.forEach((path) => {
    const source = readFile(path);

    assert.match(source, /window\.__LK_BASE_URLS__\s*=\s*assetOrigins\.map\(buildLkBaseUrl\)\.filter\(Boolean\)/);
    assert.match(source, /window\.__LK_API_BASE_URLS__/);
    assert.match(source, /window\.__LK_ACTIVE_BASE_URL__\s*=\s*activeBaseUrl/);
  });
});

test("dev-aware standalone Tilda templates keep strict split origins per channel", () => {
  [
    "docs/tilda-game-create.html",
    "docs/tilda-game-create-composite.html",
    "docs/tilda-finde-game.html",
    "docs/tilda-tournament-subscription.html",
    "docs/tilda-tournament-subscription-sirius.html",
    "docs/tilda-tournament-subscription-referral.html",
  ].forEach((path) => {
    const source = readFile(path);

    assert.match(source, /function resolveAssetOrigins\(channel\)/);
    assert.match(source, /channel === "dev"/);
    assert.match(source, /channel === "dev" && reserveOrigins\.length > 0/);
    assert.match(source, /return primaryOrigin \? \[primaryOrigin\] : reserveOrigins/);
  });
});

test("public find game template opts into game plus trainer cards", () => {
  const source = readFile("docs/tilda-finde-game.html");

  assert.match(source, /publicFindEntry: true/);
  assert.match(source, /includeGamePlusTrainer: true/);
  assert.match(source, /channel === "dev" \? "\/lk\/games-dev\.js" : "\/lk\/games\.js"/);
  assert.match(source, /channel === "dev" \? "\/lk\/release-dev\.json" : "\/lk\/release\.json"/);
});

test("prod-only standalone Tilda templates stay pinned to primary assets", () => {
  [
    "docs/tilda-game-join.html",
    "docs/tilda-tournaments.html",
    "docs/tilda-tournament-signup.html",
  ].forEach((path) => {
    const source = readFile(path);

    assert.match(source, /var assetOrigins = dedupeStrings\(\[normalizeOrigin\(primaryAssetOrigin\)\]\.filter\(Boolean\)\);/);
    assert.doesNotMatch(source, /fallbackAssetOrigins/);
  });
});

test("dev-only composite template stays pinned to reserve dev runtime", () => {
  const source = readFile("docs/tilda-game-create-composite-dev-only.html");

  assert.match(source, /window\.__LK_BASE_URLS__ = \[assetOrigin \+ "\/lk"\]/);
  assert.match(source, /window\.__LK_API_BASE_URLS__ = \[assetOrigin\]/);
  assert.match(source, /\/lk\/release-dev\.json/);
  assert.match(source, /\/lk\/games-dev\.js/);
  assert.doesNotMatch(source, /release\.json/);
  assert.doesNotMatch(source, /\/lk\/games\.js/);
});

test("dev-only find game plus trainer template stays pinned to reserve dev runtime", () => {
  const source = readFile("docs/tilda-finde-game-plus-trainer-dev-only.html");

  assert.match(source, /window\.__LK_BASE_URLS__ = \[assetOrigin \+ "\/lk"\]/);
  assert.match(source, /window\.__LK_API_BASE_URLS__ = \[assetOrigin\]/);
  assert.match(source, /publicFindEntry: true/);
  assert.match(source, /includeGamePlusTrainer: true/);
  assert.match(source, /\/lk\/release-dev\.json/);
  assert.match(source, /\/lk\/games-dev\.js/);
  assert.doesNotMatch(source, /release\.json/);
  assert.doesNotMatch(source, /\/lk\/games\.js/);
});

test("release manifest fetches stay CORS-simple across standalone templates", () => {
  RELEASE_FETCH_TEMPLATES.forEach((path) => {
    const source = readFile(path);

    assert.doesNotMatch(source, /"Cache-Control": "no-cache, no-store, must-revalidate"/);
    assert.doesNotMatch(source, /"Pragma": "no-cache"/);
    assert.doesNotMatch(source, /"Expires": "0"/);
  });
});
