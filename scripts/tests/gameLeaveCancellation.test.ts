import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

test("cabinet organizer remove still uses backend split leave helper", () => {
  const helperStart = gamesPageSource.indexOf("const cancelVivaBookingsForPlayerFromDetails = useCallback");
  const helperEnd = gamesPageSource.indexOf("const buildNextSetPairingsForTeamSlots", helperStart);
  assert.ok(helperStart >= 0, "leave helper should exist");
  assert.ok(helperEnd > helperStart, "leave helper should have a bounded source slice");

  const helperSource = gamesPageSource.slice(helperStart, helperEnd);
  assert.match(helperSource, /apiFetchTournamentParticipants\(exerciseId,\s*\{\s*sanitize:\s*false\s*\}\)/);
  assert.match(helperSource, /extractExerciseBookingRows\(participantsResult\.data\)/);
  assert.match(helperSource, /apiCancelPadelSplitParticipantBookings\(gameRecordId/);
  assert.match(helperSource, /if \(!exerciseId\) \{/);
  assert.match(helperSource, /verificationResult\.error \|\| !verificationResult\.data/);
  assert.match(helperSource, /Viva ещё держит запись игрока, попробуйте повторить позже/);

  const apiHelperStart = apiClientSource.indexOf(
    "export async function apiCancelPadelSplitParticipantBookings",
  );
  const apiHelperEnd = apiClientSource.indexOf(
    "export async function apiCleanupPadelGameByOrganizer",
    apiHelperStart,
  );
  assert.ok(apiHelperStart >= 0);
  assert.ok(apiHelperEnd > apiHelperStart);
  assert.match(apiClientSource.slice(apiHelperStart, apiHelperEnd), /auth:\s*true/);
});

test("cabinet self-remove delegates the whole operation to authenticated server leave", () => {
  const leaveHandlerStart = gamesPageSource.indexOf("const handleLeaveCurrentUserFromDetails = useCallback");
  const leaveHandlerEnd = gamesPageSource.indexOf("const handleSplitJoinCurrentUserFromDetails = useCallback", leaveHandlerStart);
  assert.ok(leaveHandlerStart >= 0, "self leave handler should exist");
  assert.ok(leaveHandlerEnd > leaveHandlerStart, "self leave handler should have a bounded source slice");
  const leaveHandlerSource = gamesPageSource.slice(leaveHandlerStart, leaveHandlerEnd);
  assert.match(leaveHandlerSource, /apiLeavePadelGameAsCurrentUser\(gameRecordId\)/);
  assert.match(leaveHandlerSource, /leaveResult\.data\.state === "RETRY_REQUIRED"/);
  assert.doesNotMatch(leaveHandlerSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(leaveHandlerSource, /patchGameRoster\(/);
  assert.match(
    leaveHandlerSource,
    /pushCabinetFlashNotice\(leaveResult\.data\.message \|\| SELF_REMOVE_SUCCESS_NOTICE\)/,
  );
  assert.match(leaveHandlerSource, /navigateToCabinetFromGamesDetails\(\)/);
});
