import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

test("cabinet loads tournament history only for an explicitly selected tournament booking", () => {
  assert.match(
    cabinetSource,
    /if \(!selectedTournamentBooking \|\| !isTournamentBookingCandidate\(selectedTournamentBooking\)\) {\s*return;\s*}/,
  );
  assert.match(
    cabinetSource,
    /const missingExerciseIds = collectBookingExerciseIds\(selectedTournamentBooking\)/,
  );
  assert.match(
    cabinetSource,
    /missingExerciseIds\.map\(async \(exerciseId\) => {\s*const result = await apiFetchTournamentHistory\(exerciseId\);/,
  );
});

test("cabinet no longer prefetches tournament history for every booking on the main screen", () => {
  assert.doesNotMatch(cabinetSource, /const tournamentHistorySourceBookings = useMemo\(/);
  assert.doesNotMatch(cabinetSource, /const tournamentExerciseIds = useMemo\(/);
  assert.doesNotMatch(cabinetSource, /tournamentExerciseIds\.map\(async \(exerciseId\) => {\s*const result = await apiFetchTournamentHistory\(exerciseId\);/);
});
