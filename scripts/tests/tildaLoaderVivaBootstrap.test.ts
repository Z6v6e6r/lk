import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const VIVA_URL = "https://supadb.vivacrm.ru/storage/v1/object/public/widgets/d5685aa2-221b-439e-8bec-c6fda0846bc3.js";

function readFile(path: string): string {
  return fs.readFileSync(path, "utf8");
}

test("tilda loader mounts the Viva group trainings widget", () => {
  const source = readFile("docs/tilda-loader.html");

  assert.match(source, new RegExp(`var vivaUrl = "${VIVA_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(source, /function mountVivaScript\(\)/);
  assert.match(source, /mountVivaScript\(\);\s*\n\s*function tryNext/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.doesNotMatch(source, /currentOriginBase/);
});

test("deploy README keeps the Viva bootstrap in the Tilda snippet", () => {
  const source = readFile("docs/README_DEPLOY.md");

  assert.match(source, new RegExp(`var vivaUrl = "${VIVA_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(source, /function mountVivaScript\(\)/);
  assert.match(source, /mountVivaScript\(\);\s*\n\s*function tryNext/);
  assert.match(source, /if \(location\.pathname\.indexOf\("\/lk_dev"\) !== -1\) return "dev"/);
  assert.match(source, /channel === "dev" && fallbacks\.length > 0/);
  assert.match(source, /npm run deploy:all/);
  assert.match(source, /tournament-subscription-referral\.js/);
});
