import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const tournamentsPageSource = readFileSync(
  new URL("../../src/components/tournaments/TournamentsPage.tsx", import.meta.url),
  "utf8",
);
const apiClientSource = readFileSync(
  new URL("../../src/utils/apiClient.ts", import.meta.url),
  "utf8",
);

test("tournament creation uses the classic mexicano generator and params", () => {
  assert.match(tournamentsPageSource, /createMexicanoClassicInitialRound\(/);
  assert.match(tournamentsPageSource, /buildMexicanoClassicParams\(/);
  assert.match(tournamentsPageSource, /typeKey !== "mexicano"/);
});

test("match save sends atomic next-round results and requires server layout confirmation", () => {
  assert.match(tournamentsPageSource, /buildClassicMexicanoMatchSaveResults\(/);
  assert.match(tournamentsPageSource, /generatedRoundsPersisted/);
  assert.match(
    tournamentsPageSource,
    /Сервер сохранил результат, но не подтвердил следующий раунд/,
  );
  assert.match(tournamentsPageSource, /rebuildMexicanoClassicFutureRounds\(/);
});

test("results API accepts layout-only next-round entries", () => {
  const resultsContract = apiClientSource.match(
    /export interface AmericanoResultsPayload \{[\s\S]*?\n\}/,
  )?.[0] ?? "";

  assert.match(resultsContract, /score1\?: number/);
  assert.match(resultsContract, /score2\?: number/);
  assert.match(resultsContract, /courtIndex\?: number/);
});
