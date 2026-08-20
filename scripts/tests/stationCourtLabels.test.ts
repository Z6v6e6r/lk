import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("station cards use the requested court count labels", () => {
  assert.ok(
    gamesPageSource.includes("formatCourtsLabel(s.panoramicCourtsCount)"),
    "panoramic courts should keep the pluralized court label",
  );
  assert.ok(
    /Сингл:\s*\{s\.singleCourtsCount\}/.test(gamesPageSource),
    "single courts should render without a repeated court noun",
  );
  assert.ok(
    /Открытых кортов:\s*\{s\.outdoorCourtsCount\}/.test(gamesPageSource),
    "outdoor courts should use the requested label without a trailing court noun",
  );
  assert.equal(
    /formatCourtCountLabel\("Сингл",\s*s\.singleCourtsCount\)/.test(gamesPageSource),
    false,
  );
  assert.equal(
    /formatCourtCountLabel\("Открытых",\s*s\.outdoorCourtsCount\)/.test(gamesPageSource),
    false,
  );
});
