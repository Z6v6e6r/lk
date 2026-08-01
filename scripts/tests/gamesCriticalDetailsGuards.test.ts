import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("cabinet organizer cancellation is fail-closed around exact backend cleanup", () => {
  const start = cabinetSource.indexOf("const handleCancelGameBooking = async");
  const end = cabinetSource.indexOf("const handleArchiveGameFromCabinet = async", start);
  assert.ok(start >= 0 && end > start);
  const cancellationSource = cabinetSource.slice(start, end);
  assert.match(cancellationSource, /const cleanupResult = await apiCleanupPadelGameByOrganizer\(gameId,/);
  assert.match(cancellationSource, /intent: "cancel_game"/);
  assert.match(cancellationSource, /refundMethod: action\.refundMethod \?\? undefined,/);
  assert.match(cancellationSource, /cleanupItem\?\.cancelledInLk === true/);
  assert.doesNotMatch(cancellationSource, /apiCancelBooking/);
  assert.doesNotMatch(cancellationSource, /cleanupItems\[0\]/);
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

test("cabinet game relevance ignores historical identity arrays after leave", () => {
  assert.doesNotMatch(cabinetSource, /recordListContainsCabinetIdentity\(game\.allRelatedPhones/);
  assert.doesNotMatch(cabinetSource, /recordListContainsCabinetIdentity\(gameAny\.allRelatedClientIds/);
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
