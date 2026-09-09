import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

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

function inlineScript(path: string): string {
  const source = readFile(path);
  const match = source.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, `missing inline script: ${path}`);
  return match[1];
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
    "docs/tilda-game-join.html",
    "docs/tilda-game-create.html",
    "docs/tilda-game-create-composite.html",
    "docs/tilda-finde-game.html",
    "docs/tilda-tournament-subscription.html",
    "docs/tilda-tournament-subscription-sirius.html",
    "docs/tilda-tournament-subscription-referral.html",
    "docs/tilda-group-schedule.html",
    "docs/tilda-tournaments.html",
    "docs/tilda-tournament-signup.html",
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

test("group and tournament templates load DEV-only bundles from reserve on explicit dev channel", () => {
  const fixtures = [
    ["docs/tilda-group-schedule.html", "group-schedule"],
    ["docs/tilda-tournaments.html", "tournament-signup"],
    ["docs/tilda-tournament-signup.html", "tournament-signup"],
  ] as const;

  fixtures.forEach(([path, bundle]) => {
    const source = readFile(path);
    assert.match(source, new RegExp(`channel === "dev" \\? "\\/lk\\/${bundle}-dev\\.js"`));
    assert.match(source, /channel === "dev" \? "\/lk\/release-dev\.json" : "\/lk\/release\.json"/);
    assert.match(source, /channel === "dev" \? "https:\/\/padlhub\.ru\/lk_dev" : "https:\/\/padlhub\.ru\/lk_new"/);
    assert.doesNotThrow(() => new Function(inlineScript(path)));
  });
});

test("game join loader selects the requested channel without cross-channel fallback", () => {
  const prefix = inlineScript("docs/tilda-game-join.html").split("    function hideTildaShell()")[0];
  function resolve(query: string, referrer = "") {
    const href = `https://padlhub.ru/game_join${query}`;
    return vm.runInNewContext(`${prefix}return {channel, assetOrigins, scriptPath, releasePath, defaultCabinetUrl}; })();`, {
      URL, window: { location: { href, origin: "https://padlhub.ru" } }, document: { referrer },
    });
  }
  const cases = [
    ["?channel=dev", "", "dev"],
    ["?cabinetUrl=https%3A%2F%2Fpadlhub.ru%2Flk_dev%3FauthMode%3Dviva", "", "dev"],
    ["?returnUrl=%2Flk_dev", "", "dev"],
    ["", "https://padlhub.ru/lk_dev?authMode=viva", "dev"],
    ["?channel=prod&cabinetUrl=%2Flk_dev", "https://padlhub.ru/lk_dev", "prod"],
    ["", "", "prod"],
    ["?channel=unknown&assetOrigin=https%3A%2F%2Fexample.test", "", "prod"],
  ];
  for (const [query, referrer, channel] of cases) {
    const result = resolve(query, referrer);
    const dev = channel === "dev";
    assert.equal(result.channel, channel);
    assert.deepEqual(Array.from(result.assetOrigins), [dev ? "https://lk-reserve.89-108-64-209.sslip.io" : "https://padlhub.su"]);
    assert.equal(result.scriptPath, dev ? "/lk/games-dev.js" : "/lk/games.js");
    assert.equal(result.releasePath, dev ? "/lk/release-dev.json" : "/lk/release.json");
    assert.equal(result.defaultCabinetUrl, dev ? "https://padlhub.ru/lk_dev" : "https://padlhub.ru/lk_new");
  }
  assert.doesNotThrow(() => new Function(inlineScript("docs/tilda-game-join.html")));
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
