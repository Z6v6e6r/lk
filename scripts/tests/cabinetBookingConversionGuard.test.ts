import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const bookingsContainerSource = fs.readFileSync("src/components/cabinet/BookingsContainer.tsx", "utf8");
const bookingHistorySource = fs.readFileSync("src/components/cabinet/BookingHistory.tsx", "utf8");
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");

test("cabinet booking lists use shared booking category resolver", () => {
  assert.match(bookingsContainerSource, /resolveCabinetBookingCategory/);
  assert.match(bookingHistorySource, /resolveCabinetBookingCategory/);
  assert.doesNotMatch(bookingsContainerSource, /function getBookingCategory\(/);
  assert.doesNotMatch(bookingHistorySource, /function getBookingCategory\(/);
});

test("cabinet opens create-from-booking flow only for open games and court rentals", () => {
  assert.match(
    cabinetSource,
    /if \(!isExerciseConvertibleToGameFromBooking\(booking\)\) return;/,
  );
  assert.match(
    cabinetSource,
    /if \(resolveExerciseCategoryFromValue\(booking\) !== EXERCISE_CATEGORY_OPEN_GAME\) return null;/,
  );
  assert.match(cabinetSource, /typeId,/);
  assert.match(cabinetSource, /directionId,/);
  assert.match(cabinetSource, /typeName: pickStringFromUnknown\(exercise\.type\?\.name\)/);
});

test("games overlay blocks booking conversion outside open games and court rentals", () => {
  assert.match(gamesPageSource, /resolveExerciseCategoryFromValue\(\{\s*typeId,/s);
  assert.match(gamesPageSource, /isExerciseConvertibleToGameFromBooking\(\{/);
  assert.match(
    gamesPageSource,
    /Из этой брони нельзя создать сборную игру\. Конвертация доступна только для открытой игры или аренды корта\./,
  );
  assert.match(gamesPageSource, /typeId: bookingPreset\.typeId/);
  assert.match(gamesPageSource, /directionId: bookingPreset\.directionId/);
});

test("conversion checks direct Viva evidence before publication and stops on any read or guard failure", () => {
  const handler = gamesPageSource.slice(
    gamesPageSource.indexOf("const handleCreateGameFromBooking ="),
    gamesPageSource.indexOf("const handleCreateGame ="),
  );
  assert.match(handler, /apiFetchBookings\(false, \{ fresh: true \}\)/);
  assert.match(handler, /apiFetchExerciseBookings\(bookingPreset\.exerciseId, \{ fresh: true \}\)/);
  assert.doesNotMatch(handler, /apiFetchTournamentParticipants\(/);
  assert.match(handler, /if \(selfResult\.error \|\| rosterResult\.error\) \{\s*setGameRecordError\(BOOKING_CONVERSION_UNVERIFIED\);\s*return;/);
  assert.match(handler, /if \(!conversionEvidence\.allowed\) \{\s*setGameRecordError\(conversionEvidence\.message\);\s*return;/);
  assert.ok(handler.indexOf("evaluateBookingConversionEvidence({") < handler.indexOf("await apiCreatePadelGameRecord(payload)"));
  assert.match(handler, /const rosterRows = conversionEvidence\.roster/);
  assert.match(handler, /finally \{\s*setCreatingFromBooking\(false\)/);
  const existingBranch = handler.slice(handler.indexOf("if (existing)"), handler.indexOf("let clientId"));
  assert.doesNotMatch(existingBranch, /runPaidGameCommunityMembershipAndPublication/);
  const repairCall = gamesPageSource.indexOf('runPaidGameCommunityMembershipAndPublication(activeGameRecord, "existing_open")');
  const repairEffect = gamesPageSource.slice(gamesPageSource.lastIndexOf("useEffect(() => {", repairCall), repairCall);
  assert.match(repairEffect, /useEffect\(\(\) => \{\s*if \(isBookingPresetMode\) return;/);
});
