import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const tournamentsPageSource = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");

test("tournaments page hydrates cached tournament history without eager network prefetch for every visible card", () => {
  assert.match(
    tournamentsPageSource,
    /serverVisibleTournaments\.map\(async \(tournament\) => {\s*const tournamentId = String\(tournament\.id\);\s*const cachedHistory = await loadCachedTournamentHistory\(tournamentId\);/,
  );
  assert.doesNotMatch(tournamentsPageSource, /for \(const tournament of serverVisibleTournaments\)/);
});

test("tournaments page keeps live tournament history fetch only for explicit open flow", () => {
  const historyFetchMatches = Array.from(tournamentsPageSource.matchAll(/apiFetchTournamentHistory\(tournamentId\)/g));
  assert.equal(historyFetchMatches.length, 1);
});

test("tournaments page guards explicit history open flow against repeated same-tick opens", () => {
  assert.match(
    tournamentsPageSource,
    /const openingTournamentIdRef = useRef<string \| null>\(null\);/,
  );
  assert.match(
    tournamentsPageSource,
    /if \(openingTournamentId \|\| openingTournamentIdRef\.current\) return;\s*openingTournamentIdRef\.current = tournamentId;/,
  );
  assert.match(
    tournamentsPageSource,
    /if \(openingTournamentIdRef\.current === tournamentId\) {\s*openingTournamentIdRef\.current = null;\s*}/,
  );
});

test("api client dedupes prod tournament history requests and briefly caches empty misses", () => {
  assert.match(
    apiClientSource,
    /const PROD_TOURNAMENT_HISTORY_EMPTY_CACHE_TTL_MS = 15_000;/,
  );
  assert.match(
    apiClientSource,
    /const prodTournamentHistoryInflight = new Map<string, Promise<TournamentHistoryApiResult>>\(\);/,
  );
  assert.match(
    apiClientSource,
    /const prodTournamentHistoryEmptyCache = new Map<string, ProdTournamentHistoryEmptyCacheEntry>\(\);/,
  );
  assert.match(
    apiClientSource,
    /return !result\.error && Array\.isArray\(result\.data\) && result\.data\.length === 0;/,
  );
  assert.match(
    apiClientSource,
    /const cachedEmptyResult = !IS_DEV_RELEASE_CHANNEL\s*\?\s*readProdTournamentHistoryEmptyCache\(normalizedTournamentId\)\s*:\s*null;/,
  );
  assert.match(
    apiClientSource,
    /const inflightRequest = !IS_DEV_RELEASE_CHANNEL\s*\?\s*prodTournamentHistoryInflight\.get\(normalizedTournamentId\)\s*:\s*null;/,
  );
  assert.match(
    apiClientSource,
    /prodTournamentHistoryInflight\.set\(normalizedTournamentId, requestPromise\);/,
  );
  assert.match(
    apiClientSource,
    /writeProdTournamentHistoryEmptyCache\(normalizedTournamentId, result\);/,
  );
});
