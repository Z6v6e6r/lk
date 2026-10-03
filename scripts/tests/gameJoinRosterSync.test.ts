import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Source-level contract for the invite/join page, which keeps its own roster
// projection and its own join/decline entry points. The leave decision itself was
// moved to the durable server saga: this page only calls the leaf endpoint and
// reacts to its state, so the assertions below track that contract.
const gameJoinPageSource = fs.readFileSync("src/components/games/GameJoinPage.tsx", "utf8");

test("game join page syncs split roster with live Viva participants", () => {
  assert.match(gameJoinPageSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.match(gameJoinPageSource, /reconcileRosterWithViva\(/);
  assert.match(gameJoinPageSource, /const splitPaymentGame = isSplitPaymentGame\(game\)/);
  assert.match(gameJoinPageSource, /shouldSkipRecentSplitGameRosterSync\(/);
  assert.match(gameJoinPageSource, /const nextWaitlist = excludePlayersAlreadyInRoster\(/);
  assert.match(gameJoinPageSource, /waitlistChanged = !arePlayersEqualByIdentity\(/);
  assert.match(gameJoinPageSource, /waitlistChanged \? \{ waitlist: nextWaitlist \} : \{\}/);
  assert.match(
    gameJoinPageSource,
    /useEffect\(\(\) => \{\s*if \(subscriptionUsageShadowEnabled\) return;\s*if \(!game \|\| !profile\) return;/,
  );
});

test("game join leave decision uses the durable leave saga and surfaces every state", () => {
  assert.match(gameJoinPageSource, /apiLeavePadelGameAsCurrentUser\(actualGame\.id\)/);
  // A failed request surfaces the server message instead of a silent no-op.
  assert.match(gameJoinPageSource, /setDecisionError\(leaveResult\.error\?\.message \|\| "Не удалось покинуть игру"\)/);
  // Pending work is reported as pending, never as success.
  assert.match(
    gameJoinPageSource,
    /leaveResult\.data\.state === "RETRY_REQUIRED" \|\| leaveResult\.data\.state === "IN_PROGRESS"/,
  );
  assert.match(gameJoinPageSource, /pushCabinetFlashNotice\(leaveResult\.data\.message \|\| SELF_REMOVE_PENDING_NOTICE\)/);
  // Anything that is not DONE keeps the player on the page with an explanation.
  assert.match(gameJoinPageSource, /if \(leaveResult\.data\.state !== "DONE"\) \{/);
  // The authoritative record is re-read before the success path completes.
  assert.match(gameJoinPageSource, /apiFetchPadelGameRecord\(actualGame\.id\)/);
  assert.match(gameJoinPageSource, /decisionError && \(/);
});

test("game join page does not carry the removed client-side cancellation ladder", () => {
  // These helpers belonged to the pre-saga flow and exist nowhere in the tree.
  for (const removed of [
    "resolveLeaveBookingTargetsForProfile",
    "vivaBookingMatchesProfile",
    "apiCancelPadelSelfRemovalBookings",
    "selfRemovalAuditLog",
    "lastSelfRemovalAuditAt",
    "Не удалось проверить Viva exerciseId для leave",
  ]) {
    assert.equal(
      gameJoinPageSource.includes(removed),
      false,
      `${removed} reappeared in GameJoinPage`,
    );
  }
});
