import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import type {
  Exercise,
  ExerciseBooking,
  TournamentHistoryRecord,
} from "../../src/utils/apiClient.ts";
import {
  TOURNAMENT_PARTICIPANT_BUSY_RETRY_MS,
  TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS,
  buildTournamentParticipantRosterFingerprint,
  resolveTournamentParticipantBusyRetryMs,
  resolveTournamentParticipantRefreshDelay,
  resolveVivaLinkedTournamentExerciseId,
  shouldApplyTournamentParticipantRefreshRoster,
} from "../../src/components/tournaments/tournamentParticipantRefresh.ts";

function makeBooking(
  bookingId: string,
  clientId: string,
  rating = "3.5",
): ExerciseBooking {
  return {
    id: bookingId,
    spot: 1,
    rating,
    client: {
      id: clientId,
      firstName: "Игрок",
      lastName: clientId,
    },
  };
}

function makeTournament(id: string, sourceTournamentId?: string): Exercise {
  return {
    id,
    ...(
      sourceTournamentId
        ? { sourceTournamentId }
        : {}
    ),
  } as Exercise;
}

function makeHistory(params: Record<string, unknown>): TournamentHistoryRecord {
  return { params } as TournamentHistoryRecord;
}

test("participant refresh cadence grows from 60s to 120s and caps at 300s", () => {
  assert.equal(
    resolveTournamentParticipantRefreshDelay("initial"),
    TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.active,
  );
  assert.equal(
    resolveTournamentParticipantRefreshDelay("unchanged", 60_000),
    TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.unchanged,
  );
  assert.equal(
    resolveTournamentParticipantRefreshDelay("unchanged", 120_000),
    TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.max,
  );
  assert.equal(
    resolveTournamentParticipantRefreshDelay("unchanged", 300_000),
    TOURNAMENT_PARTICIPANT_REFRESH_INTERVAL_MS.max,
  );
});

test("participant refresh cadence resets on roster change and backs off on error", () => {
  assert.equal(resolveTournamentParticipantRefreshDelay("changed", 300_000), 60_000);
  assert.equal(resolveTournamentParticipantRefreshDelay("error", 60_000), 300_000);
});

test("busy participant refresh retries through the shared cache after the inflight TTL", () => {
  assert.equal(TOURNAMENT_PARTICIPANT_BUSY_RETRY_MS, 30_000);
  assert.equal(resolveTournamentParticipantBusyRetryMs({ retryAfterMs: 18_250 }), 18_250);
  assert.equal(resolveTournamentParticipantBusyRetryMs({ retryAfterMs: 200 }), 1_000);
  assert.equal(resolveTournamentParticipantBusyRetryMs({ retryAfterMs: 120_000 }), 60_000);
  assert.equal(resolveTournamentParticipantBusyRetryMs({}), 30_000);

  const source = fs.readFileSync(
    "src/components/tournaments/TournamentsPage.tsx",
    "utf8",
  );
  assert.match(
    source,
    /if \(result\.status === 429\)[\s\S]*scheduleRefresh\(resolveTournamentParticipantBusyRetryMs\(result\.error\?\.raw\)\);/,
  );
  assert.match(
    source,
    /const loadParticipants = useCallback[\s\S]*if \(result\.status === 429\)[\s\S]*participantAutoScheduleRef\.current\([\s\S]*resolveTournamentParticipantBusyRetryMs\(result\.error\?\.raw\)/,
  );
  assert.match(
    source,
    /setParticipantLoadNotice\(null\);\s*setParticipants\(\[\]\);/,
  );
  assert.match(
    source,
    /!participantLoadNotice && participants\.length === 0/,
  );
});

test("manual refresh replaces the visible roster only with a confirmed server snapshot", () => {
  assert.equal(shouldApplyTournamentParticipantRefreshRoster("refreshed", null), true);
  assert.equal(
    shouldApplyTournamentParticipantRefreshRoster("stale_if_error", "2026-08-04T14:00:00.000Z"),
    true,
  );
  assert.equal(shouldApplyTournamentParticipantRefreshRoster("stale_if_error", null), false);
  assert.equal(shouldApplyTournamentParticipantRefreshRoster("overload", null), false);
  assert.equal(shouldApplyTournamentParticipantRefreshRoster("unavailable", null), false);

  const source = fs.readFileSync(
    "src/components/tournaments/TournamentsPage.tsx",
    "utf8",
  );
  assert.match(
    source,
    /if \(applyReturnedParticipants\) \{\s*setParticipants\(nextParticipants\);\s*\}/,
  );
  assert.match(
    source,
    /const retryAfterMs = Math\.max\(0, result\.data\.retryAfterMs \?\? 0\);[\s\S]*retryBlocked: retryAfterMs > 0/,
  );
});

test("participant roster fingerprint is order-independent and detects relevant changes", () => {
  const first = makeBooking("booking-1", "client-1");
  const second = makeBooking("booking-2", "client-2");

  assert.equal(
    buildTournamentParticipantRosterFingerprint([first, second]),
    buildTournamentParticipantRosterFingerprint([second, first]),
  );
  assert.notEqual(
    buildTournamentParticipantRosterFingerprint([first, second]),
    buildTournamentParticipantRosterFingerprint([first, makeBooking("booking-2", "client-2", "4.0")]),
  );
  assert.notEqual(
    buildTournamentParticipantRosterFingerprint([first, second]),
    buildTournamentParticipantRosterFingerprint([first]),
  );
});

test("only Viva-linked tournaments resolve an exercise id", () => {
  const vivaExerciseOne = "8fae2b19-baa4-4eb9-98b8-93c9f988f425";
  const vivaExerciseTwo = "92051094-9db6-4cfd-a400-b9ad360d0a4b";
  assert.equal(
    resolveVivaLinkedTournamentExerciseId(
      makeTournament("manual-1", "manual-1"),
      makeHistory({ manualTournament: true, syncStatus: "pending_viva" }),
    ),
    null,
  );
  assert.equal(
    resolveVivaLinkedTournamentExerciseId(
      makeTournament("manual-tournament-1", vivaExerciseOne),
      makeHistory({ manualTournament: true, syncStatus: "synced_viva" }),
    ),
    null,
  );
  assert.equal(
    resolveVivaLinkedTournamentExerciseId(makeTournament("manual-tournament-without-history"), null),
    null,
  );
  assert.equal(
    resolveVivaLinkedTournamentExerciseId(makeTournament("local-document", vivaExerciseOne), null),
    vivaExerciseOne,
  );
  assert.equal(
    resolveVivaLinkedTournamentExerciseId(makeTournament(vivaExerciseTwo), null),
    vivaExerciseTwo,
  );
});

test("modal polling is scoped, abortable, idle-aware and does not block background refresh", () => {
  const source = fs.readFileSync(
    "src/components/tournaments/TournamentsPage.tsx",
    "utf8",
  );
  const runRefreshSource = source.match(
    /async function runRefresh\(initialLoad: boolean\) \{([\s\S]*?)\n {4}\}/,
  )?.[1] ?? "";

  assert.match(source, /if \(!isOpen \|\| !participantExerciseId \|\| rosterMode !== "bookings"\)/);
  assert.match(
    source,
    /apiFetchTournamentParticipants\(activeParticipantExerciseId, \{\s*retries: 0,\s*signal: controller\.signal,/,
  );
  assert.match(source, /activeController\?\.abort\(\);/);
  assert.match(source, /window\.clearTimeout\(timerId\);/);
  assert.match(source, /window\.addEventListener\(LK_IDLE_DATA_STALE_EVENT_NAME, stopRefreshCycle\);/);
  assert.match(source, /void loadParticipants\(participantExerciseId\);/);
  assert.doesNotMatch(source, /void loadParticipants\(tournamentId\);/);
  assert.match(runRefreshSource, /if \(initialLoad\) \{\s*setLoading\(true\);/);
  assert.doesNotMatch(runRefreshSource, /setLoading\(true\);[\s\S]*setLoading\(true\);/);
});

test("manual participant refresh is authenticated, observable and retry-free", () => {
  const apiSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const pageSource = fs.readFileSync(
    "src/components/tournaments/TournamentsPage.tsx",
    "utf8",
  );

  assert.match(
    apiSource,
    /\/lk\/tournaments\/participants\/refresh\?exerciseId=\$\{encodeURIComponent\(normalizedExerciseId\)\}/,
  );
  assert.match(apiSource, /body: JSON\.stringify\(\{ exerciseId: normalizedExerciseId \}\)/);
  assert.match(apiSource, /method: "POST",\s*auth: true,\s*retries: 0,/);
  assert.match(pageSource, /"Обновить участников"/);
  assert.match(
    pageSource,
    /participantExerciseId && canRefreshParticipantsFromViva &&/,
  );
  assert.match(
    pageSource,
    /canRefreshParticipantsFromViva=\{canHostTournaments\}/,
  );
  assert.match(
    pageSource,
    /result\.data\.retryAfterMs[\s\S]*retryBlocked: retryAfterMs > 0/,
  );
  assert.match(
    pageSource,
    /participantRefreshState\.retryBlocked === true/,
  );
  assert.match(
    pageSource,
    /reason === "in_progress"[\s\S]*participantAutoRunRef\.current\?\.\(\)/,
  );
  assert.match(
    pageSource,
    /!participantExerciseId\s*\|\| !canRefreshParticipantsFromViva\s*\|\| rosterMode !== "bookings"[\s\S]*apiRefreshTournamentParticipants\(requestedExerciseId/,
  );
});
