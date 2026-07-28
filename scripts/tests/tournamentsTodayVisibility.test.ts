import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const tournamentsPageSource = fs.readFileSync(
  "src/components/tournaments/TournamentsPage.tsx",
  "utf8",
);

test("loads the full selected day for tournament mechanics, including elapsed tournaments", () => {
  const sourceLoader = tournamentsPageSource.match(
    /async function fetchTournamentMechanicsSourceItems\(dateKey: string\) \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(sourceLoader, "tournament mechanics source loader must exist");
  assert.match(
    sourceLoader,
    /apiFetchTournamentMechanicsSourceList\(\{ from: dateKey, to: dateKey \}\)/,
  );
  assert.doesNotMatch(
    sourceLoader,
    /apiFetchTournamentMechanicsSourceList\(\{ date: dateKey \}\)/,
  );
});
