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

function assertUtf8DeclarationBeforeRoot(source: string) {
  const rootIndex = source.indexOf('<div id="root"></div>');
  assert.notEqual(rootIndex, -1, "Expected tilda snippet to contain <div id=\"root\"></div>");
  const prefix = source.slice(0, rootIndex);
  assert.match(prefix, /<meta charset="utf-8">/i);
}

function assertBundleScriptCharsetUtf8(source: string) {
  const regex =
    /function appendBundleScript\(version, candidateBaseUrls, releaseUrl, errors\)[\s\S]*?script\.charset\s*=\s*"utf-8";\s*script\.src\s*=\s*bundleUrl;/;
  assert.ok(
    regex.test(source),
    "Expected bundle script element to set charset utf-8 before src assignment"
  );
}

function assertBundleUrlHasCharsetParam(source: string) {
  const functionStart = source.indexOf("function buildBundleUrl(baseUrl, version)");
  assert.notEqual(functionStart, -1, "Expected buildBundleUrl function to exist");

  const nextFunctionIndex = source.indexOf("function rotateBaseUrls", functionStart);
  const functionBody = nextFunctionIndex === -1 ? source.slice(functionStart) : source.slice(functionStart, nextFunctionIndex);

  assert.match(functionBody, /"&charset=utf-8"\)/);
  assert.match(functionBody, /\?charset=utf-8"\)/);
}

function assertSnippetBundleScriptCharsetUtf8(source: string) {
  const anchor = "Bootstrap ЛК не подключает legacy Viva-виджет `#9Rzqf`.";
  const scopedSource = source.includes(anchor) ? source.slice(source.indexOf(anchor)) : source;

  const regex =
    /function appendBundleScript\(version, candidateBaseUrls, releaseUrl, errors\)[\s\S]*?script\.charset\s*=\s*"utf-8";\s*script\.src\s*=\s*bundleUrl;/;
  assert.ok(
    regex.test(scopedSource),
    "Expected bundle script element to set charset utf-8 before src assignment"
  );
}

test("tilda loader does not mount the legacy Viva group trainings widget", () => {
  const source = readFile("docs/tilda-loader.html");

  assertLegacyVivaBootstrapAbsent(source);
  assertUtf8DeclarationBeforeRoot(source);
  assertBundleScriptCharsetUtf8(source);
  assertBundleUrlHasCharsetParam(source);
  assert.doesNotMatch(source, /#9Rzqf/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.doesNotMatch(source, /currentOriginBase/);
});

test("deploy README keeps the legacy Viva bootstrap out of the Tilda snippet", () => {
  const source = readFile("docs/README_DEPLOY.md");

  assertLegacyVivaBootstrapAbsent(source);
  assertUtf8DeclarationBeforeRoot(source);
  assertSnippetBundleScriptCharsetUtf8(source);
  assertBundleUrlHasCharsetParam(source);
  assert.match(source, /Групповые тренировки\s+открываются на `https:\/\/padlhub\.ru\/group`/);
  assert.match(source, /серверный `\/lk\/subscription-bookings`/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.match(source, /npm run deploy:all/);
  assert.match(source, /tournament-subscription-referral\.js/);
});
