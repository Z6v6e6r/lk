import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("cabinet cancel refreshes authoritative game record before cleanup decision", () => {
  assert.match(cabinetSource, /const linkedGameResult = await apiFetchPadelGameRecord\(gameId\);/);
  assert.match(cabinetSource, /const linkedGame = linkedGameResult\.data\?\.id/);
  assert.match(cabinetSource, /const hasExerciseIds = Boolean\(linkedGame && collectGameExerciseIds\(linkedGame\)\.length > 0\);/);
  assert.match(cabinetSource, /const hasBookingIds = Boolean\(linkedGame && collectGameBookingIds\(linkedGame\)\.length > 0\);/);
});

test("cabinet cancel routes linked split games through organizer cleanup", () => {
  assert.match(cabinetSource, /const cleanupResult = await apiCleanupPadelGameByOrganizer\(gameId,/);
  assert.match(cabinetSource, /intent: "cancel_game"/);
  assert.match(cabinetSource, /refundMethod: action\.refundMethod \?\? undefined,/);
  assert.match(
    cabinetSource,
    /if \(!ok && !cleanupHandled\) {\s*const res = await apiCancelBooking\(bookingId,\s*action\);/,
  );
});

test("games details never treat organizer row as leaveable participant", () => {
  assert.match(gamesPageSource, /const shouldShowCurrentUserLeaveActionInDetails = !isCurrentUserOrganizerOfActiveGame\s*&& !isCurrentUserOrganizerByDetails;/);
  assert.match(gamesPageSource, /if \(source === "ORGANIZER"\) return true;/);
  assert.match(gamesPageSource, /return playersShareRosterIdentity\(detailsOrganizerPayload, player\);/);
});

test("games page removes shared-identity duplicates between participants and waitlist", () => {
  assert.match(gamesPageSource, /return excludePlayersAlreadyInRoster\(sourceWaitlist, detailsParticipants\);/);
  assert.match(gamesPageSource, /const normalizedWaitlist = excludePlayersAlreadyInRoster\(/);
  assert.match(gamesPageSource, /aggregate = aggregates\.find\(\(candidate\) => playersShareRosterIdentity\(candidate\.player, player\)\);/);
});

test("games roster patch drops records that stop matching the current profile", () => {
  assert.match(
    gamesPageSource,
    /const stillRelevantToCurrentProfile = isPadelGameRecordRelevantToIdentity\(\s*recordWithRoster,\s*profilePhone,\s*profileId,\s*\);/,
  );
  assert.match(
    gamesPageSource,
    /if \(!stillRelevantToCurrentProfile\) {\s*notifyGameRecordsUpdated\(\[recordWithRoster\], "games_roster_patch_irrelevant"\);\s*removeGameRecordFromStores\(recordWithRoster\.id\);\s*setGameRecordId\(null\);\s*setStep\("create"\);\s*return true;\s*}/,
  );
});

test("cabinet game relevance keeps leave-event records visible when they still belong to the profile", () => {
  assert.match(
    cabinetSource,
    /if \(recordListContainsCabinetIdentity\(game\.allRelatedPhones, phone, normalizeCabinetIdentityPhone\)\) \{\s*return true;\s*\}/,
  );
  assert.match(
    cabinetSource,
    /if \(recordListContainsCabinetIdentity\(gameAny\.allRelatedClientIds, clientId, normalizeCabinetIdentityId\)\) \{\s*return true;\s*\}/,
  );
  assert.doesNotMatch(cabinetSource, /if \(!hasLeaveEventForCabinetIdentity\(game, clientId, phone\)\)/);
});

test("games details invite action is available for any opened live game card with an invite link", () => {
  assert.match(
    gamesPageSource,
    /const canCurrentUserInviteInDetails = isGamePaid !== false\s*&& !isGameCancelledStatus\(gameRecordStatus\)\s*&& Boolean\(inviteLink\);/,
  );
});

test("match result team picker is unlocked by result editing rights, not only organizer roster rights", () => {
  assert.match(gamesPageSource, /const canEditMatchResultTeamsInDetails = canEditMatchResult;/);
  assert.match(
    gamesPageSource,
    /if \(!canManagePlayersInDetails && !canEditMatchResultTeamsInDetails\) return;/,
  );
  assert.match(
    gamesPageSource,
    /if \(canManagePlayersInDetails \|\| canEditMatchResultTeamsInDetails\) \{/,
  );
  assert.match(
    gamesPageSource,
    /isEditableStartPairing && detailsTeamMenuSlotIndex != null && canEditMatchResultTeamsInDetails/,
  );
});
