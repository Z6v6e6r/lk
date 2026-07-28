import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildTournamentFinishConfirmationCopy,
  buildTournamentResumeParams,
  getTournamentProgressState,
  isTournamentManuallyFinished,
  isTournamentMarkedFinished,
} from "../../src/components/tournaments/tournamentLifecycle.ts";
import type { TournamentHistoryRecord } from "../../src/utils/apiClient.ts";

function createHistoryRecord(overrides: Partial<TournamentHistoryRecord> = {}): TournamentHistoryRecord {
  return {
    id: "history-1",
    tournamentId: "history-1",
    title: "Test tournament",
    tournamentType: "mexicano",
    targetScore: 21,
    courts: ["Корт №1"],
    participants: [],
    participantsCount: 4,
    maxParticipants: 4,
    minRating: null,
    maxRating: null,
    genderLabel: null,
    girlsOnly: null,
    mixed: null,
    organizer: null,
    params: null,
    rounds: [],
    standings: [],
    summary: null,
    totals: null,
    playerLogs: null,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

test("buildTournamentResumeParams clears finish markers and sets explicit resume intent", () => {
  const params = buildTournamentResumeParams({
    status: "completed",
    finished: true,
    manualFinish: true,
    finishedAt: "2026-06-26T16:32:48.635Z",
    completedAt: "2026-06-26T16:32:48.635Z",
    manualFinishedAt: "2026-06-26T16:32:48.635Z",
  });

  assert.equal(params.status, "in_progress");
  assert.equal(params.state, "in_progress");
  assert.equal(params.tournamentStatus, "in_progress");
  assert.equal(params.finished, false);
  assert.equal(params.manualFinish, false);
  assert.equal(params.finishedAt, null);
  assert.equal(params.completedAt, null);
  assert.equal(params.manualFinishedAt, null);
  assert.equal(params.resumeRequested, true);
});

test("manual finish detection is format-agnostic and requires an explicit manual marker", () => {
  assert.equal(isTournamentManuallyFinished({ manualFinish: true }, null), true);
  assert.equal(isTournamentManuallyFinished({ manualFinish: "true" }, null), true);
  assert.equal(isTournamentManuallyFinished(null, { manualFinish: 1 }), true);
  assert.equal(isTournamentManuallyFinished({
    status: "completed",
    finished: true,
    completedAt: "2026-07-26T10:56:54.734Z",
  }, null), false);
});

test("finish confirmation describes incomplete and complete tournament consequences", () => {
  const incomplete = buildTournamentFinishConfirmationCopy({
    completedMatches: 9,
    totalMatches: 33,
    hasPartiallyCompletedRound: false,
  });
  assert.equal(incomplete.title, "Завершить турнир?");
  assert.equal(incomplete.progress, "Сохранено матчей: 9 из 33.");
  assert.equal(incomplete.warning, "24 матча останутся без результата.");
  assert.match(incomplete.reassurance, /можно будет возобновить/);
  assert.equal(incomplete.confirmLabel, "Да, завершить");

  const partialRound = buildTournamentFinishConfirmationCopy({
    completedMatches: 9,
    totalMatches: 33,
    hasPartiallyCompletedRound: true,
  });
  assert.match(partialRound.warning, /частично заполненные матчи/);

  const complete = buildTournamentFinishConfirmationCopy({
    completedMatches: 33,
    totalMatches: 33,
    hasPartiallyCompletedRound: false,
  });
  assert.match(complete.warning, /ввод результатов будет заблокирован/);
});

test("classic mexicano history remains in progress until explicit finish markers appear", () => {
  const history = createHistoryRecord({
    tournamentType: "mexicano",
    params: {
      tournamentFamily: "mexicano",
      tournamentSubtype: "classic",
      mexicanoMode: "classic",
    },
    rounds: [
      {
        id: "round-1",
        matches: [
          { id: "match-1", score1: 11, score2: 9 },
        ],
      },
      {
        id: "round-2",
        matches: [
          { id: "match-2", score1: 12, score2: 10 },
        ],
      },
    ],
  });

  assert.equal(isTournamentMarkedFinished(history.params, history.summary), false);
  assert.equal(getTournamentProgressState(history), "in_progress");
});

test("classic mexicano ignores stale completed summary when params are explicitly in progress", () => {
  const history = createHistoryRecord({
    tournamentType: "mexicano",
    params: {
      tournamentFamily: "mexicano",
      tournamentSubtype: "classic",
      mexicanoMode: "classic",
      status: "in_progress",
      state: "in_progress",
      tournamentStatus: "in_progress",
      finished: false,
      isFinished: false,
      tournamentFinished: false,
      manualFinish: false,
      finishedAt: null,
      completedAt: null,
      manualFinishedAt: null,
    },
    summary: {
      status: "completed",
      totalRounds: 2,
      completedRounds: 2,
      totalMatches: 6,
      completedMatches: 6,
    },
    rounds: [
      {
        id: "round-1",
        matches: [
          { id: "match-1", score1: 11, score2: 9 },
        ],
      },
      {
        id: "round-2",
        matches: [
          { id: "match-2", score1: 12, score2: 10 },
        ],
      },
    ],
  });

  assert.equal(getTournamentProgressState(history), "in_progress");
});

test("explicit finish markers keep tournament completed", () => {
  const history = createHistoryRecord({
    tournamentType: "mexicano",
    params: {
      tournamentFamily: "mexicano",
      mexicanoMode: "classic",
      status: "completed",
      manualFinish: true,
      finishedAt: "2026-06-26T16:32:48.635Z",
    },
    rounds: [
      {
        id: "round-1",
        matches: [
          { id: "match-1", score1: 11, score2: 9 },
        ],
      },
    ],
    summary: {
      status: "completed",
      manualFinish: true,
      finishedAt: "2026-06-26T16:32:48.635Z",
    },
  });

  assert.equal(isTournamentMarkedFinished(history.params, history.summary), true);
  assert.equal(getTournamentProgressState(history), "completed");
});

test("tournament manager allows manual finish once the bracket is formed", () => {
  const source = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  const startIndex = source.indexOf("const canFinishTournament = useMemo");
  const endIndex = source.indexOf("const tournamentParams", startIndex);
  assert.ok(startIndex > 0);
  assert.ok(endIndex > startIndex);
  const canFinishBlock = source.slice(startIndex, endIndex);

  assert.match(canFinishBlock, /if \(standingsSnapshot\.totalMatches <= 0\) return false;\s*return true;/);
  assert.doesNotMatch(canFinishBlock, /completedMatches === standingsSnapshot\.totalMatches/);
  assert.doesNotMatch(canFinishBlock, /MEXICANO_MIN_ROUNDS_BEFORE_FINISH|minRoundsBeforeFinish|minRounds/);
});

test("tournament manager confirms finish and allows resume for any manually finished format", () => {
  const source = fs.readFileSync("src/components/tournaments/TournamentsPage.tsx", "utf8");
  const resumeStartIndex = source.indexOf("const canResumeTournament =");
  const resumeEndIndex = source.indexOf("const finishConfirmationCopy", resumeStartIndex);
  assert.ok(resumeStartIndex > 0);
  assert.ok(resumeEndIndex > resumeStartIndex);
  const canResumeBlock = source.slice(resumeStartIndex, resumeEndIndex);

  assert.match(canResumeBlock, /isTournamentManuallyFinished\(tournamentParams, null\)/);
  assert.doesNotMatch(canResumeBlock, /isClassicMexicanoTournament/);
  assert.match(source, /setFinishConfirmationOpen\(true\)/);
  assert.match(source, /title=\{finishConfirmationCopy\.title\}/);
  assert.match(source, /finishConfirmationCopy\.confirmLabel/);
});

test("end-of-day tournament scripts keep incomplete completion explicit", () => {
  const finalizerSource = fs.readFileSync("scripts/finalize_tournaments_from_results.mjs", "utf8");
  const vivaRepairSource = fs.readFileSync("scripts/repair_tournament_viva_ratings.mjs", "utf8");

  assert.match(finalizerSource, /--force-incomplete/);
  assert.match(finalizerSource, /unresolvedNotFinished/);
  assert.match(finalizerSource, /force_incomplete/);
  assert.match(vivaRepairSource, /--complete-only/);
  assert.match(vivaRepairSource, /TOURNAMENT_NOT_COMPLETE/);
});
