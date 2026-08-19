import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

function assertLegacyVivaBootstrapAbsent(source: string) {
  assert.doesNotMatch(source, /supadb\.vivacrm\.ru\/storage\/v1\/object\/public\/widgets/);
  assert.doesNotMatch(source, /var vivaUrl/);
  assert.doesNotMatch(source, /function mountVivaScript\(\)/);
  assert.doesNotMatch(source, /padlhub-viva-widget/);
  assert.doesNotMatch(source, /viva\.load_failed/);
}

test("tilda loader does not mount the legacy Viva group trainings widget", () => {
  const source = readFile("docs/tilda-loader.html");

  assertLegacyVivaBootstrapAbsent(source);
  assert.doesNotMatch(source, /#9Rzqf/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.doesNotMatch(source, /currentOriginBase/);
});

test("deploy README keeps the legacy Viva bootstrap out of the Tilda snippet", () => {
  const source = readFile("docs/README_DEPLOY.md");

  assertLegacyVivaBootstrapAbsent(source);
  assert.match(source, /Групповые тренировки\s+открываются на `https:\/\/padlhub\.ru\/group`/);
  assert.match(source, /серверный `\/lk\/subscription-bookings`/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.match(source, /npm run deploy:all/);
  assert.match(source, /tournament-subscription-referral\.js/);
});
