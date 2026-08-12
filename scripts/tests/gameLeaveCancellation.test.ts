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
  assert.match(leaveHandlerSource, /SELF_REMOVE_RETRY_DELAYS_MS\.length/);
  assert.match(leaveHandlerSource, /await delay\(retryDelayMs\)/);
  assert.match(leaveHandlerSource, /\["VIVA_UNVERIFIED", "IN_PROGRESS", "RETRY_REQUIRED"\]\.includes\(state\)/);
  assert.match(leaveHandlerSource, /transientStatus === 408/);
  assert.match(leaveHandlerSource, /transientStatus >= 500/);
  assert.match(leaveHandlerSource, /leaveResult\.data\.state === "RETRY_REQUIRED" \|\| leaveResult\.data\.state === "IN_PROGRESS"/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(leaveResult\.data\.message \|\| SELF_REMOVE_PENDING_NOTICE\)/);
  assert.match(leaveHandlerSource, /setLeavePendingMessage\(SELF_REMOVE_START_NOTICE\)/);
  assert.doesNotMatch(leaveHandlerSource, /apiCancelPadelSelfRemovalBookings/);
  assert.doesNotMatch(leaveHandlerSource, /patchGameRoster\(/);
  assert.match(leaveHandlerSource, /pushCabinetFlashNotice\(finalMessage\)/);
  assert.match(leaveHandlerSource, /navigateToCabinetFromGamesDetails\(\)/);
});

test("self leave renders an in-roster pending spinner and keeps the background state visible", () => {
  assert.match(gamesPageSource, /SELF_REMOVE_START_NOTICE/);
  assert.match(gamesPageSource, /Ждём подтверждения отмены и освобождения места/);
  assert.match(gamesPageSource, /details-roster-leave-spinner/);
  assert.match(gamesPageSource, /isCurrentUserLeaving \? "Покидает игру"/);
  assert.match(gamesPageSource, /если закрыть её, повтор продолжится в фоне/);
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
