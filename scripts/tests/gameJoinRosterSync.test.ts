import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gameJoinPageSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("game join page syncs split roster with live Viva participants", () => {
  assert.match(gameJoinPageSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.match(gameJoinPageSource, /reconcileRosterWithViva\(/);
  assert.match(gameJoinPageSource, /const splitPaymentGame = isSplitPaymentGame\(game\)/);
  assert.match(gameJoinPageSource, /shouldSkipRecentSplitGameRosterSync\(/);
  assert.match(gameJoinPageSource, /useEffect\(\(\) => \{\s*if \(!game \|\| !profile\) return;/);
});

test("game join leave flow resolves Viva cancellation targets before patching roster", () => {
  assert.match(gameJoinPageSource, /resolveLeaveBookingTargetsForProfile\(/);
  assert.match(gameJoinPageSource, /vivaBookingMatchesProfile\(/);
  assert.match(gameJoinPageSource, /apiCancelPadelSelfRemovalBookings\(bookingIds\)/);
  assert.match(gameJoinPageSource, /else if \(lookupError\) \{/);
  assert.match(gameJoinPageSource, /if \(exerciseId\) \{/);
  assert.match(gameJoinPageSource, /verificationResult\.error \|\| !verificationResult\.data/);
  assert.match(gameJoinPageSource, /Viva ещё держит запись игрока, попробуйте повторить позже/);
  assert.match(gameJoinPageSource, /selfRemovalAuditLog/);
  assert.match(gameJoinPageSource, /lastSelfRemovalAuditAt/);
  assert.match(gameJoinPageSource, /pushCabinetFlashNotice\(SELF_REMOVE_SUCCESS_NOTICE\)/);
  assert.doesNotMatch(gameJoinPageSource, /Не удалось проверить Viva exerciseId для leave/);
});
