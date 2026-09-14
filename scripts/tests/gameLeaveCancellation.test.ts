import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const gamesEntrySource = fs.readFileSync("src/games.tsx", "utf8");
const selfLeavePreviewSource = fs.readFileSync("dev/self-leave-preview.html", "utf8");
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
  assert.match(gamesPageSource, /selfLeavePreview\?\.request \?\? apiLeavePadelGameAsCurrentUser/);
  assert.match(leaveHandlerSource, /leaveCurrentUserRequest\(gameRecordId\)/);
  assert.doesNotMatch(leaveHandlerSource, /SELF_REMOVE_RETRY_DELAYS_MS|await delay/);
  assert.equal((leaveHandlerSource.match(/await leaveCurrentUserRequest\(gameRecordId\)/g) || []).length, 1);
  assert.match(leaveHandlerSource, /observeGameLeave\(/);
  assert.match(leaveHandlerSource, /setUpdatingGameRoster\(false\)/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(SELF_REMOVE_START_NOTICE\)/);
  assert.doesNotMatch(leaveHandlerSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(leaveHandlerSource, /patchGameRoster\(/);
  assert.match(leaveHandlerSource, /pushCabinetFlashNotice\(finalMessage\)/);
  assert.match(leaveHandlerSource, /navigateToCabinetFromGamesDetails\(\)/);
});

test("completed self leave still verifies fresh membership before success", () => {
  const leaveHandlerStart = gamesPageSource.indexOf("const handleLeaveCurrentUserFromDetails = useCallback");
  const leaveHandlerEnd = gamesPageSource.indexOf("const handleSplitJoinCurrentUserFromDetails = useCallback", leaveHandlerStart);
  const leaveHandlerSource = gamesPageSource.slice(leaveHandlerStart, leaveHandlerEnd);
  // The unresolved branch must refresh the game, exit when the player is already gone and
  // otherwise clear the disabled "leaving" state with the real server message.
  assert.match(leaveHandlerSource, /const refreshed = await apiFetchPadelGameRecord\(gameRecordId\)/);
  assert.match(leaveHandlerSource, /upsertGameRecordInStores\(refreshedRecord, \{ communityMode: "if_exists" \}\)/);
  assert.match(leaveHandlerSource, /\.some\(\(player\) => isCurrentUserPlayer\(player\)\)/);
  assert.match(leaveHandlerSource, /finalMessage = SELF_REMOVE_SUCCESS_NOTICE/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(null\)/);
  assert.match(leaveHandlerSource, /setGameRosterError\(SELF_REMOVE_PENDING_NOTICE\)/);
  assert.doesNotMatch(leaveHandlerSource, /if \(!finalMessage\) \{\s*setLeavePendingMessage\(SELF_REMOVE_PENDING_NOTICE\);\s*return;\s*\}/);
});

test("self leave renders an in-roster pending spinner and keeps the background state visible", () => {
  assert.match(gamesPageSource, /SELF_REMOVE_START_NOTICE/);
  assert.match(gamesPageSource, /Отправляем запрос на выход из игры/);
  assert.match(gamesPageSource, /details-roster-leave-spinner/);
  assert.match(gamesPageSource, /game-empty details-roster-leave-status/);
  assert.match(
    gamesPageSource,
    /details-roster-leave-status[\s\S]*details-roster-leave-spinner[\s\S]*leavePendingMessage/,
  );
  assert.match(gamesPageSource, /isCurrentUserLeaving \? "Покидает игру"/);
  assert.match(gamesPageSource, /Можно вернуться к другим играм/);
});

test("self leave browser preview is loopback-only and cannot call the real leave API", () => {
  assert.match(gamesEntrySource, /\["127\.0\.0\.1", "localhost", "::1"\]\.includes\(window\.location\.hostname\)/);
  assert.match(gamesEntrySource, /searchParams\.get\("leavePreview"\) === "1"/);
  assert.match(gamesEntrySource, /state: "IN_PROGRESS"/);
  assert.match(gamesEntrySource, /state: "DONE"/);
  assert.match(gamesEntrySource, /selfLeavePreview=\{selfLeavePreview\}/);
  assert.doesNotMatch(gamesEntrySource, /apiLeavePadelGameAsCurrentUser/);
  assert.doesNotMatch(gamesEntrySource, /Viva/);
  assert.match(gamesPageSource, /typeof window !== "undefined" && !isSelfLeavePreviewMode/);
  assert.match(selfLeavePreviewSource, /openGameId: "dev-self-leave-preview"/);
});
