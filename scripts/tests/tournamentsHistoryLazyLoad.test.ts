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

test("api client dedupes and briefly caches every successful prod tournament history response", () => {
  assert.match(
    apiClientSource,
    /const PROD_TOURNAMENT_HISTORY_CACHE_TTL_MS = 10_000;/,
  );
  assert.match(
    apiClientSource,
    /const prodTournamentHistoryInflight = new Map<string, Promise<TournamentHistoryApiResult>>\(\);/,
  );
  assert.match(
    apiClientSource,
    /const prodTournamentHistoryCache = new Map<string, ProdTournamentHistoryCacheEntry>\(\);/,
  );
  assert.match(
    apiClientSource,
    /return !result\.error && Array\.isArray\(result\.data\);/,
  );
  assert.match(
    apiClientSource,
    /const cachedResult = !IS_DEV_RELEASE_CHANNEL\s*\?\s*readProdTournamentHistoryCache\(normalizedTournamentId\)\s*:\s*null;/,
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
    /writeProdTournamentHistoryCache\(normalizedTournamentId, result\);/,
  );
});
