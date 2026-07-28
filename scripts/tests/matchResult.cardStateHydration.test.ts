import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const cabinetSource = fs.readFileSync("src/components/cabinet/Cabinet.tsx", "utf8");

test("api client preserves top-level result lifecycle fields on game normalization", () => {
  assert.match(apiClientSource, /const resultStatus =[\s\S]*pickString\(payload, \["resultStatus"\]\)/);
  assert.match(apiClientSource, /const resultLifecycleState =[\s\S]*pickString\(payload, \["resultLifecycleState"\]\)/);
  assert.match(apiClientSource, /const resultId =[\s\S]*pickString\(payload, \["resultId"\]\)/);
  assert.match(apiClientSource, /const lastResultAt =[\s\S]*pickString\(payload, \["lastResultAt"\]\)/);
  assert.match(apiClientSource, /resultStatus: resultStatus \?\? null,/);
  assert.match(apiClientSource, /resultLifecycleState: resultLifecycleState \?\? null,/);
  assert.match(apiClientSource, /resultId: resultId \?\? null,/);
  assert.match(apiClientSource, /lastResultAt: lastResultAt \?\? null,/);
});

test("games page falls back to normalized game result state when metadata matchResult is absent", () => {
  assert.match(gamesPageSource, /function buildFallbackMatchResultFromGameRecord\(/);
  assert.match(
    gamesPageSource,
    /const rawMatchResult = isRecordObject\(detailsMetadata\.matchResult\)\s*\?\s*detailsMetadata\.matchResult\s*:\s*buildFallbackMatchResultFromGameRecord\(activeGameRecord\);/,
  );
  assert.match(gamesPageSource, /function mergeMatchResultWithSessionDraft\(/);
  assert.match(
    gamesPageSource,
    /const draftMatchResult = mergeMatchResultWithSessionDraft\(rawMatchResult, sessionDraftMatchResult\);/,
  );
});

test("result action normalization preserves explicit NO_RESULT state and can read matchResult from normalized game metadata", () => {
  assert.match(
    apiClientSource,
    /const status = normalizePadelGameResultStatus\(\s*data\.status\s*\?\?\s*data\.state\s*\?\?\s*data\.lifecycleState/,
  );
  assert.match(
    gamesPageSource,
    /const gameMatchResult = isRecordObject\(response\.game\?\.metadata\?\.matchResult\)/,
  );
  assert.match(
    gamesPageSource,
    /if \(!raw\) \{\s*if \(!status\) return null;\s*return \{\s*status,/,
  );
});

test("game record merges preserve existing matchResult while incoming metadata is partial", () => {
  assert.match(gamesPageSource, /function mergePadelGameMetadata\(/);
  assert.match(
    gamesPageSource,
    /!isRecordObject\(incomingMetadata\.matchResult\) && isRecordObject\(currentMetadata\.matchResult\)/,
  );
  assert.match(
    apiClientSource,
    /!isRecord\(incomingMetadata\.matchResult\) && isRecord\(currentMetadata\.matchResult\)/,
  );
});

test("cabinet result prompt hides the enter-result CTA when top-level lifecycle already has a pending result", () => {
  assert.match(
    cabinetSource,
    /const topLevelStatus = String\(game\.resultLifecycleState \?\? game\.resultStatus \?\? ""\)\.trim\(\);/,
  );
  assert.match(
    cabinetSource,
    /return Boolean\(topLevelStatus \|\| game\.resultId \|\| game\.lastResultAt\);/,
  );
});
