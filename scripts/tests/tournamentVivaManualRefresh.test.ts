import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const apiSource = fs.readFileSync("src/utils/tournamentSignupApi.ts", "utf8");
const pageSource = fs.readFileSync(
  "src/components/tournaments/TournamentsPage.tsx",
  "utf8",
);

test("manual Viva refresh is one authenticated non-fallback day mutation", () => {
  const functionSource = apiSource.match(
    /export async function apiRefreshTournamentMechanicsFromViva\([\s\S]*?\n\}/,
  )?.[0];

  assert.ok(functionSource, "manual refresh API helper must exist");
  assert.match(functionSource, /['"]\/tournaments\/snapshot\/refresh-day['"]/);
  assert.match(functionSource, /method:\s*['"]POST['"]/);
  assert.match(functionSource, /auth:\s*true/);
  assert.match(functionSource, /allowFallback:\s*false/);
  assert.match(functionSource, /JSON\.stringify\(\{\s*date\s*\}\)/);
});

test("organizer button applies the direct Viva response only for the selected day", () => {
  const handlerSource = pageSource.match(
    /const handleVivaRefresh = useCallback\(async \(\) => \{([\s\S]*?)\n\s{2}\}, \[canHostTournaments/,
  )?.[1];

  assert.ok(handlerSource, "manual refresh handler must exist");
  assert.match(handlerSource, /apiRefreshTournamentMechanicsFromViva\(requestedDate\)/);
  assert.match(
    handlerSource,
    /const requestGeneration = scheduleRequestGenerationRef\.current \+ 1;[\s\S]*scheduleRequestGenerationRef\.current = requestGeneration/,
  );
  assert.match(
    handlerSource,
    /scheduleRequestGenerationRef\.current !== requestGeneration/,
  );
  assert.match(
    handlerSource,
    /catch \(refreshError\) \{\s*if \(\s*selectedDateKeyRef\.current !== requestedDate\s*\|\| scheduleRequestGenerationRef\.current !== requestGeneration\s*\) \{\s*return;\s*\}/,
  );
  assert.match(handlerSource, /buildTournamentMechanicsFallbackExercises\(result\.data\.tournaments\)/);
  assert.match(handlerSource, /setItems\(freshExercises\)/);
  assert.doesNotMatch(handlerSource, /apiFetchExercisesByVisibleDate/);
  assert.match(pageSource, /\{canHostTournaments && \(/);
  assert.match(pageSource, /Обновить из Viva/);
  assert.match(pageSource, /Только выбранный день/);
  assert.match(pageSource, /disabled=\{vivaRefreshPending \|\| loading\}/);
});

test("manual Viva refresh invalidates an older automatic load for the same day", () => {
  const autoLoadSource = pageSource.match(
    /useEffect\(\(\) => \{\s*let alive = true;\s*const requestGeneration = scheduleRequestGenerationRef\.current \+ 1;([\s\S]*?)\n\s{2}\}, \[includePastTournaments/,
  )?.[1];

  assert.ok(autoLoadSource, "automatic day load must own a request generation");
  assert.match(autoLoadSource, /const isCurrentRequest = \(\) => \(/);
  assert.equal((autoLoadSource.match(/if \(!isCurrentRequest\(\)\) return;/g) || []).length >= 4, true);
  assert.match(autoLoadSource, /if \(!isCurrentRequest\(\) \|\| appliedFreshItems \|\| !cachedItems\) return;/);
});
