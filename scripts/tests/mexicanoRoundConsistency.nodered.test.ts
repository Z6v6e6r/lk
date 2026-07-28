import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  appendMexicanoClassicRoundIfReady,
  buildClassicMexicanoMatchSaveResults,
  createMexicanoClassicInitialRound,
} from "../../src/components/tournaments/mexicanoClassic.ts";
import {
  createPairedMexicanoInitialRounds,
  serializeAmericanoRounds,
  type AmericanoLabParticipant,
} from "../../src/components/tournaments/americanoLab.ts";

type TournamentMatchSnapshot = {
  id?: string;
  pair1?: unknown[];
  pair2?: unknown[];
  score1?: number | null;
  score2?: number | null;
  saved?: boolean;
};

type TournamentRoundSnapshot = {
  id?: string;
  matches?: TournamentMatchSnapshot[];
  saved?: boolean;
};

type TournamentStateSnapshot = {
  rounds?: TournamentRoundSnapshot[];
  summary?: {
    status?: unknown;
    finished?: unknown;
    manualFinish?: unknown;
    finishedAt?: unknown;
    completedAt?: unknown;
  };
  params?: {
    status?: unknown;
    finished?: unknown;
    manualFinish?: unknown;
    finishedAt?: unknown;
    completedAt?: unknown;
    manualFinishedAt?: unknown;
    resumeRequested?: unknown;
  };
  error?: string;
};

type NodeRedOutput = {
  statusCode?: number;
  payload: TournamentStateSnapshot;
};

function runNodeRedFunction(file: string, msg: Record<string, unknown>): unknown {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

function asNodeRedOutput(value: unknown): NodeRedOutput {
  return value as NodeRedOutput;
}

function runTournamentUpdateArgsBranch(value: NodeRedOutput): unknown {
  return runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_update_args.js",
    {
      ...value,
      query: (value as { mongoQuery?: unknown }).mongoQuery,
      payload: (value as { mongoUpdate?: unknown }).mongoUpdate,
    },
  );
}

function createParticipants(count: number): AmericanoLabParticipant[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(6 - index * 0.2),
  }));
}

function createCourts(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Корт №${index + 1}`);
}

function participantRefSignature(value: unknown): string {
  if (value && typeof value === "object") {
    const candidate = value as { id?: unknown };
    return String(candidate.id ?? value);
  }
  return String(value);
}

function roundSignature(round: TournamentRoundSnapshot | null | undefined): string {
  const matches = Array.isArray(round?.matches) ? round.matches : [];
  return matches
    .map((match) => {
      const pair1 = Array.isArray(match?.pair1) ? match.pair1.map(participantRefSignature) : [];
      const pair2 = Array.isArray(match?.pair2) ? match.pair2.map(participantRefSignature) : [];
      return `${String(match?.id || "")}:${pair1.join("+")}|${pair2.join("+")}`;
    })
    .join(" ; ");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("classic mexicano: backend does not auto-append next round and accepts FE round layout as source of truth", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const options = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "mexicano",
    totalRounds: 8,
  } as const;

  const initialRounds = createMexicanoClassicInitialRound(participants, courts, options);
  assert.equal(initialRounds.length, 1);

  const scoreByMatchIndex: Array<[number, number]> = [
    [14, 10],
    [14, 10],
    [24, 0],
    [12, 12],
  ];
  const completedRound1 = {
    ...initialRounds[0],
    matches: initialRounds[0].matches.map((match, index) => ({
      ...match,
      score1: scoreByMatchIndex[index][0],
      score2: scoreByMatchIndex[index][1],
      saved: true,
    })),
    saved: true,
  };

  const feRounds = appendMexicanoClassicRoundIfReady(
    participants,
    courts,
    [completedRound1],
    options,
  );
  assert.equal(feRounds.length, 2);
  const feRound2 = feRounds[1];

  const tournamentDoc = {
    tournamentId: "mex-classic-1",
    tournamentType: "mexicano",
    participants,
    courts,
    params: {
      ...options,
      mexicanoMode: "classic",
      byePointsMode: "zero",
    },
    rounds: serializeAmericanoRounds([completedRound1]),
  };

  const backendAfterRound1 = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: tournamentDoc,
      req: { body: { results: [] } },
    },
  ));

  // Regression guard: backend must not auto-generate classic mexicano future rounds.
  assert.equal(Array.isArray(backendAfterRound1.payload.rounds), true);
  assert.equal(backendAfterRound1.payload.rounds.length, 1);
  assert.equal(backendAfterRound1.payload.summary?.status, "in_progress");

  const round2ResultsSeedPayload = feRound2.matches.map((match, index) => ({
    roundId: "round-2",
    matchId: match.id,
    court: match.court,
    courtIndex: match.courtIndex,
    pair1: match.pair1.map((player) => player.id),
    pair2: match.pair2.map((player) => player.id),
    ...(index === 0 ? { score1: 13, score2: 11 } : {}),
  }));

  const backendAfterRound2Seed = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        ...tournamentDoc,
        rounds: backendAfterRound1.payload.rounds,
      },
      req: {
        body: {
          results: round2ResultsSeedPayload,
        },
      },
    },
  ));

  const persistedRound2 = backendAfterRound2Seed.payload.rounds?.find((round) => round.id === "round-2");
  assert.ok(persistedRound2, "round-2 must be created from FE-provided layout");
  assert.equal(roundSignature(persistedRound2), roundSignature(feRound2));
  assert.equal(persistedRound2.matches[0].score1, 13);
  assert.equal(persistedRound2.matches[0].score2, 11);
  assert.equal(backendAfterRound2Seed.payload.summary?.status, "in_progress");
  const mongoArgsMsg = runTournamentUpdateArgsBranch(backendAfterRound2Seed);
  assert.ok(mongoArgsMsg && typeof mongoArgsMsg === "object");
  assert.deepEqual((mongoArgsMsg as { payload?: unknown[] }).payload?.[0], { tournamentId: "mex-classic-1" });
});

test("classic mexicano: final score and generated next-round layout persist in one backend write", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const options = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "mexicano-single-write",
    totalRounds: 8,
  } as const;
  const [initialRound] = createMexicanoClassicInitialRound(participants, courts, options);
  const currentRound = {
    ...initialRound,
    matches: initialRound.matches.map((match, index) => ({
      ...match,
      score1: 14 - index,
      score2: 10 + index,
      saved: index < initialRound.matches.length - 1,
    })),
    saved: false,
  };
  const persistedRound = {
    ...currentRound,
    matches: currentRound.matches.map((match, index) => ({
      ...match,
      score1: index < currentRound.matches.length - 1 ? match.score1 : null,
      score2: index < currentRound.matches.length - 1 ? match.score2 : null,
    })),
  };
  const finalMatch = currentRound.matches[currentRound.matches.length - 1];
  const results = buildClassicMexicanoMatchSaveResults(
    participants,
    courts,
    [currentRound],
    currentRound.id,
    finalMatch.id,
    [persistedRound],
    options,
  );

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        tournamentId: "mex-classic-single-write",
        tournamentType: "mexicano",
        participants,
        courts,
        params: {
          ...options,
          mexicanoMode: "classic",
          byePointsMode: "zero",
        },
        rounds: serializeAmericanoRounds([persistedRound]),
      },
      req: { body: { results } },
    },
  ));

  assert.equal(out.statusCode, undefined);
  assert.equal(out.payload.rounds?.length, 2);
  assert.equal(out.payload.rounds?.[0].matches?.every(
    (match) => match.score1 != null && match.score2 != null,
  ), true);
  const persistedNextRound = out.payload.rounds?.[1];
  assert.equal(persistedNextRound?.id, "round-2");
  assert.equal(persistedNextRound?.matches?.length, courts.length);
  assert.equal(persistedNextRound?.matches?.every(
    (match) => match.score1 == null && match.score2 == null,
  ), true);
  assert.ok(runTournamentUpdateArgsBranch(out));
});

test("classic mexicano: score-only payload cannot create a round or match without layout", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const initialRounds = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "mexicano-score-only-new",
    totalRounds: 8,
  });
  const payload = {
    tournamentId: "mex-classic-score-only-new",
    tournamentType: "mexicano",
    participants,
    courts,
    params: {
      mexicanoMode: "classic",
      totalRounds: 8,
      byePointsMode: "zero",
    },
    rounds: serializeAmericanoRounds(initialRounds),
  };

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload,
      req: {
        body: {
          results: [
            {
              roundId: "round-2",
              matchId: "round-2-match-1",
              score1: 14,
              score2: 11,
            },
          ],
        },
      },
    },
  ));

  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, "ROUND_LAYOUT_REQUIRED");
  assert.equal(payload.rounds.length, 1);
  assert.equal(payload.rounds.some((round) => round.id === "round-2"), false);
  assert.equal(runTournamentUpdateArgsBranch(out), null);
});

test("classic mexicano: score-only update works for an existing match with valid layout", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const initialRounds = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "mexicano-score-only-existing",
    totalRounds: 8,
  });
  const serializedRounds = serializeAmericanoRounds(initialRounds);
  const beforeSignature = roundSignature(serializedRounds[0]);

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        tournamentId: "mex-classic-score-only-existing",
        tournamentType: "mexicano",
        participants,
        courts,
        params: {
          mexicanoMode: "classic",
          totalRounds: 8,
          byePointsMode: "zero",
        },
        rounds: serializedRounds,
      },
      req: {
        body: {
          results: [
            {
              roundId: "round-1",
              matchId: serializedRounds[0].matches[0].id,
              score1: 14,
              score2: 11,
            },
          ],
        },
      },
    },
  ));

  const match = out.payload.rounds[0].matches[0];
  assert.equal(roundSignature(out.payload.rounds[0]), beforeSignature);
  assert.equal(match.score1, 14);
  assert.equal(match.score2, 11);
});

test("classic mexicano: partial layout rejects scores and layout atomically", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const initialRounds = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "mexicano-partial-layout",
    totalRounds: 8,
  });
  const serializedRounds = serializeAmericanoRounds(initialRounds);
  const originalRounds = clone(serializedRounds);
  const targetMatch = serializedRounds[0].matches[0];

  const payload = {
    tournamentId: "mex-classic-partial-layout",
    tournamentType: "mexicano",
    participants,
    courts,
    params: {
      mexicanoMode: "classic",
      totalRounds: 8,
      byePointsMode: "zero",
    },
    rounds: serializedRounds,
  };

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload,
      req: {
        body: {
          results: [
            {
              roundId: "round-1",
              matchId: targetMatch.id,
              pair1: ["p1", "p2"],
              score1: 14,
              score2: 11,
            },
          ],
        },
      },
    },
  ));

  assert.equal(out.statusCode, 422);
  assert.equal(out.payload.error, "INVALID_ROUND_LAYOUT");
  const match = payload.rounds[0].matches[0];
  assert.deepEqual(match.pair1, originalRounds[0].matches[0].pair1);
  assert.deepEqual(match.pair2, originalRounds[0].matches[0].pair2);
  assert.equal(match.score1, originalRounds[0].matches[0].score1);
  assert.equal(match.score2, originalRounds[0].matches[0].score2);
});

test("classic mexicano: explicit resume request clears manual finish markers", () => {
  const participants = createParticipants(12);
  const courts = createCourts(3);
  const options = {
    firstRoundMode: "equal_pairs",
    tableSortMode: "point_diff",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "resume-mexicano",
    totalRounds: 8,
  } as const;

  const initialRounds = createMexicanoClassicInitialRound(participants, courts, options);
  const completedRound1 = {
    ...initialRounds[0],
    matches: initialRounds[0].matches.map((match, index) => ({
      ...match,
      score1: 10 + index,
      score2: 8 + index,
      saved: true,
    })),
    saved: true,
  };

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        tournamentId: "mex-classic-resume",
        tournamentType: "mexicano",
        participants,
        courts,
        params: {
          ...options,
          mexicanoMode: "classic",
          status: "completed",
          finished: true,
          manualFinish: true,
          finishedAt: "2026-06-26T16:32:48.635Z",
          completedAt: "2026-06-26T16:32:48.635Z",
        },
        summary: {
          status: "completed",
          finished: true,
          manualFinish: true,
          finishedAt: "2026-06-26T16:32:48.635Z",
          completedAt: "2026-06-26T16:32:48.635Z",
        },
        rounds: serializeAmericanoRounds([completedRound1]),
      },
      req: {
        body: {
          results: [],
          params: {
            status: "in_progress",
            finished: false,
            manualFinish: false,
            finishedAt: null,
            completedAt: null,
            manualFinishedAt: null,
            resumeRequested: true,
          },
        },
      },
    },
  ));

  assert.equal(out.payload.params.status, "in_progress");
  assert.equal(out.payload.params.finished, false);
  assert.equal(out.payload.params.manualFinish, false);
  assert.equal(out.payload.params.finishedAt, null);
  assert.equal(out.payload.params.completedAt, null);
  assert.equal("resumeRequested" in out.payload.params, false);
  assert.equal(out.payload.summary?.status, "in_progress");
  assert.equal(out.payload.summary?.finished, false);
  assert.equal("finishedAt" in (out.payload.summary || {}), false);
});

test("classic americano: explicit resume request clears manual finish markers without changing rounds", () => {
  const participants = createParticipants(4);
  const courts = createCourts(1);
  const serializedRounds = [
    {
      id: "round-1",
      index: 1,
      byes: [],
      matches: [
        {
          id: "round-1-match-1",
          court: courts[0],
          courtIndex: 0,
          pair1: [participants[0].id, participants[1].id],
          pair2: [participants[2].id, participants[3].id],
          score1: 21,
          score2: 18,
        },
      ],
    },
  ];

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        tournamentId: "americano-classic-resume",
        tournamentType: "americano_classic",
        participants,
        courts,
        params: {
          status: "completed",
          finished: true,
          manualFinish: true,
          finishedAt: "2026-07-26T10:56:54.734Z",
          completedAt: "2026-07-26T10:56:54.734Z",
        },
        summary: {
          status: "completed",
          finished: true,
          manualFinish: true,
          totalRounds: 1,
          completedRounds: 1,
          totalMatches: 1,
          completedMatches: 1,
          finishedAt: "2026-07-26T10:56:54.734Z",
          completedAt: "2026-07-26T10:56:54.734Z",
        },
        rounds: serializedRounds,
      },
      req: {
        body: {
          results: [],
          params: {
            status: "in_progress",
            state: "in_progress",
            tournamentStatus: "in_progress",
            finished: false,
            manualFinish: false,
            finishedAt: null,
            completedAt: null,
            manualFinishedAt: null,
            resumeRequested: true,
          },
        },
      },
    },
  ));

  assert.equal(out.payload.params?.status, "in_progress");
  assert.equal(out.payload.params?.finished, false);
  assert.equal(out.payload.params?.manualFinish, false);
  assert.equal(out.payload.params?.finishedAt, null);
  assert.equal(out.payload.params?.completedAt, null);
  assert.equal(out.payload.summary?.status, "in_progress");
  assert.equal(out.payload.summary?.finished, false);
  assert.deepEqual(out.payload.rounds, serializedRounds);
});

test("paired mexicano: backend still auto-appends next round", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const pairAssignments: Array<[string, string]> = [
    ["p1", "p2"],
    ["p3", "p4"],
    ["p5", "p6"],
    ["p7", "p8"],
  ];

  const initialRounds = createPairedMexicanoInitialRounds(participants, courts, pairAssignments);
  assert.equal(initialRounds.length, 1);

  const completedRound1 = {
    ...initialRounds[0],
    matches: initialRounds[0].matches.map((match, index) => ({
      ...match,
      score1: index === 0 ? 24 : 17,
      score2: index === 0 ? 12 : 7,
      saved: true,
    })),
    saved: true,
  };

  const out = asNodeRedOutput(runNodeRedFunction(
    "scripts/nodered_games_nodes/fn_tournament_recalculate.js",
    {
      payload: {
        tournamentId: "mex-paired-1",
        tournamentType: "paired_mexicano",
        participants,
        courts,
        params: {
          mexicanoMode: "paired",
          totalRounds: 3,
          pairAssignments,
        },
        rounds: serializeAmericanoRounds([completedRound1]),
      },
      req: { body: { results: [] } },
    },
  ));

  assert.equal(Array.isArray(out.payload.rounds), true);
  assert.equal(out.payload.rounds.length, 2);
  assert.equal(out.payload.rounds[1].id, "round-2");
  assert.equal(out.payload.rounds[1].matches.length, 2);
});
