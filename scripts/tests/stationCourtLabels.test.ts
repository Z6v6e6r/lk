import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("station cards render all court counts in one comma-separated row", () => {
  assert.ok(
    gamesPageSource.includes("formatCourtsLabel(studio.panoramicCourtsCount)"),
    "panoramic courts should keep the pluralized court label",
  );
  assert.ok(
    gamesPageSource.includes("labels.push(`Сингл: ${studio.singleCourtsCount}`)"),
    "single courts should render without a repeated court noun",
  );
  assert.ok(
    gamesPageSource.includes("labels.push(`Открытых кортов: ${studio.outdoorCourtsCount}`)"),
    "outdoor courts should use the requested label without a trailing court noun",
  );
  assert.ok(
    gamesPageSource.includes('return labels.join(", ");'),
    "court labels should be joined into one comma-separated line",
  );
  assert.ok(
    gamesPageSource.includes(
      '<div className="game-card-sub">{formatStationCourtSummary(s)}</div>',
    ),
    "active station cards should render a single court summary row",
  );
});
