import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

test("game details checks Viva exercise before hiding cancelled booking matches", () => {
  assert.match(gamesPageSource, /const cancelledByBookings = strictMatchedBookings\.length > 0/);
  assert.match(gamesPageSource, /apiFetchExerciseById\(exerciseId\)/);
  assert.match(gamesPageSource, /resolveExerciseCancellationState\(exerciseResult\.data\)/);
  assert.match(gamesPageSource, /cancelledByBookings && lookup\.exerciseIds\.length === 0/);
});

test("cabinet cancelled booking sync uses exact ids and Viva exercise guard", () => {
  const resolverMatch = cabinetSource.match(
    /const resolveCancelledGameForBooking = useCallback\([\s\S]*?return null;\n\s{2}}, \[gameByBookingId, gameByExerciseId, gameByPaymentRef\]\);/,
  );
  assert.ok(resolverMatch);
  assert.doesNotMatch(resolverMatch[0], /buildBookingSlot(?:Id|Loose)?Key/);
  assert.match(cabinetSource, /resolveGameExerciseCancellationState\(game\)/);
  assert.match(cabinetSource, /if \(exerciseState !== "cancelled"\) continue;/);
});
