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
