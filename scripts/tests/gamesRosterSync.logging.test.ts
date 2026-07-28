import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("games roster sync emits lifecycle analytics events", () => {
  assert.match(gamesPageSource, /games_roster_sync_\$\{type\}/);
  assert.match(gamesPageSource, /trackRosterSyncEvent\("started"/);
  assert.match(gamesPageSource, /trackRosterSyncEvent\("applied"/);
  assert.match(gamesPageSource, /trackRosterSyncEvent\("skipped"/);
  assert.match(gamesPageSource, /trackRosterSyncEvent\("failed"/);
});

test("games roster sync uses reconcile helper and does not hard-stop on leaveEvents", () => {
  assert.match(gamesPageSource, /reconcileRosterWithViva\(/);
  assert.match(gamesPageSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.doesNotMatch(gamesPageSource, /if \(detailsLeaveEvents\.length > 0\) return;/);
  assert.doesNotMatch(gamesPageSource, /detailsSourceParticipants\.length >= detailsMaxPlayers/);
});
