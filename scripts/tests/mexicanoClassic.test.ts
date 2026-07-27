import test from "node:test";
import assert from "node:assert/strict";
import {
  appendMexicanoClassicRoundIfReady,
  buildClassicMexicanoMatchSaveResults,
  buildClassicMexicanoRoundSaveResults,
  buildMexicanoClassicParams,
  createMexicanoClassicInitialRound,
  getClassicMexicanoPayloadStructuralScore,
  isClassicMexicanoRoundLayoutComplete,
  isClassicMexicanoRoundValidlyCompleted,
  rebuildMexicanoClassicFutureRounds,
  shouldPreferClassicMexicanoCachedSnapshot,
  shouldPreferClassicMexicanoSnapshot,
  type MexicanoClassicOptions,
} from "../../src/components/tournaments/mexicanoClassic.ts";
import type { AmericanoLabParticipant, AmericanoLabRound } from "../../src/components/tournaments/americanoLab.ts";

function createParticipants(count: number): AmericanoLabParticipant[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(7 - (index % 7) * 0.3),
  }));
}

function createCourts(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Корт №${index + 1}`);
}

function markRoundAsCompleted(round: AmericanoLabRound, targetScore = 24) {
  return {
    ...round,
    matches: round.matches.map((match, matchIndex) => {
      const delta = ((round.index + matchIndex * 2) % 9) + 7;
      const score1 = Math.min(targetScore - 1, delta);
      const score2 = targetScore - score1;
      return {
        ...match,
        score1,
        score2,
        saved: true,
      };
    }),
    saved: true,
  } satisfies AmericanoLabRound;
}

function completeAndAppend(
  participants: AmericanoLabParticipant[],
  courts: string[],
  rounds: AmericanoLabRound[],
  options?: MexicanoClassicOptions,
) {
  const nextRounds = [...rounds];
  const lastIndex = nextRounds.length - 1;
  nextRounds[lastIndex] = markRoundAsCompleted(nextRounds[lastIndex]);
  return appendMexicanoClassicRoundIfReady(participants, courts, nextRounds, options);
}

function assertNoDuplicatePlayersInRound(round: AmericanoLabRound) {
  const used = new Set<string>();
  round.matches.forEach((match) => {
    const ids = [
      ...match.pair1.map((player) => player.id),
      ...match.pair2.map((player) => player.id),
    ];
    assert.equal(ids.length, 4, `match ${match.id} must contain exactly 4 players`);
    const unique = new Set(ids);
    assert.equal(unique.size, 4, `match ${match.id} must contain unique players`);
    ids.forEach((id) => {
      assert.ok(!used.has(id), `player ${id} appears in multiple matches of round ${round.id}`);
      used.add(id);
    });
  });
}

function getPartnerKeys(round: AmericanoLabRound) {
  return round.matches.flatMap((match) => [
    [...match.pair1.map((player) => player.id)].sort().join("::"),
    [...match.pair2.map((player) => player.id)].sort().join("::"),
  ]);
}

test("classic mexicano supports tournament sizes 4..32 (multiples of 4)", () => {
  [4, 8, 12, 16, 20, 24, 28, 32].forEach((playersCount) => {
    const participants = createParticipants(playersCount);
    const courts = createCourts(playersCount / 4);
    const options = {
      totalRounds: 4,
      firstRoundMode: "by_level",
      byeMode: "strict",
      seed: `seed-${playersCount}`,
    } satisfies MexicanoClassicOptions;

    let rounds = createMexicanoClassicInitialRound(participants, courts, options);
    assert.equal(rounds.length, 1, `players=${playersCount}: expected first round only`);
    assert.equal(rounds[0].matches.length, courts.length, `players=${playersCount}: matches per round`);
    assert.equal(rounds[0].byes.length, 0, `players=${playersCount}: no byes expected`);
    assertNoDuplicatePlayersInRound(rounds[0]);

    for (let step = 0; step < options.totalRounds - 1; step += 1) {
      rounds = completeAndAppend(participants, courts, rounds, options);
      const lastRound = rounds[rounds.length - 1];
      assertNoDuplicatePlayersInRound(lastRound);
      assert.equal(lastRound.matches.length, courts.length, `players=${playersCount}: full courts each round`);
    }

    assert.equal(rounds.length, options.totalRounds, `players=${playersCount}: total rounds reached`);
  });
});

test("rotating_bye works for non-multiple-of-4 sizes", () => {
  [5, 6, 7, 9, 10, 11, 13].forEach((playersCount) => {
    const participants = createParticipants(playersCount);
    const courts = createCourts(Math.max(1, Math.floor(playersCount / 4)));
    const options = {
      totalRounds: 6,
      firstRoundMode: "random",
      byeMode: "rotating_bye",
      seed: `odd-${playersCount}`,
    } satisfies MexicanoClassicOptions;

    let rounds = createMexicanoClassicInitialRound(participants, courts, options);
    assert.ok(rounds.length >= 1, `players=${playersCount}: first round exists`);

    for (let step = 0; step < options.totalRounds - 1; step += 1) {
      rounds = completeAndAppend(participants, courts, rounds, options);
    }

    assert.equal(rounds.length, options.totalRounds, `players=${playersCount}: total rounds reached`);

    const byeByRound = rounds.map((round) => new Set(round.byes.map((player) => player.id)));
    const expectedByeCount = Math.max(0, playersCount - courts.length * 4);
    byeByRound.forEach((byeSet, roundIndex) => {
      assert.equal(byeSet.size, expectedByeCount, `players=${playersCount}: bye count in round ${roundIndex + 1}`);
    });

    participants.forEach((participant) => {
      for (let roundIndex = 1; roundIndex < byeByRound.length; roundIndex += 1) {
        const prevBye = byeByRound[roundIndex - 1].has(participant.id);
        const nextBye = byeByRound[roundIndex].has(participant.id);
        assert.ok(!(prevBye && nextBye), `players=${playersCount}: ${participant.id} has consecutive byes`);
      }
    });
  });
});

test("deterministic tie handling keeps schedule stable", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const options = {
    totalRounds: 3,
    firstRoundMode: "random",
    byeMode: "rotating_bye",
    seed: "ties-seed",
  } satisfies MexicanoClassicOptions;

  const initialRounds = createMexicanoClassicInitialRound(participants, courts, options);
  const completedRound = {
    ...initialRounds[0],
    matches: initialRounds[0].matches.map((match) => ({
      ...match,
      score1: 12,
      score2: 12,
      saved: true,
    })),
    saved: true,
  } satisfies AmericanoLabRound;

  const stateA = appendMexicanoClassicRoundIfReady(participants, courts, [completedRound], options);
  const stateB = appendMexicanoClassicRoundIfReady(participants, courts, [completedRound], options);

  assert.equal(stateA.length, 2);
  assert.equal(stateB.length, 2);
  assert.deepEqual(
    stateA[1].matches.map((match) => ({ pair1: match.pair1.map((p) => p.id), pair2: match.pair2.map((p) => p.id) })),
    stateB[1].matches.map((match) => ({ pair1: match.pair1.map((p) => p.id), pair2: match.pair2.map((p) => p.id) })),
  );
});

test("editing previous round score rebuilds future rounds", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const options = {
    totalRounds: 4,
    firstRoundMode: "random",
    byeMode: "rotating_bye",
    seed: "rebuild-seed",
  } satisfies MexicanoClassicOptions;

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  rounds = completeAndAppend(participants, courts, rounds, options);
  rounds = completeAndAppend(participants, courts, rounds, options);

  const beforeRebuild = rounds.map((round) => ({
    id: round.id,
    pairs: round.matches.map((match) => [
      [...match.pair1.map((player) => player.id)].sort().join("::"),
      [...match.pair2.map((player) => player.id)].sort().join("::"),
    ].sort().join("|")),
  }));

  const editedRounds = [...rounds];
  const firstRound = editedRounds[0];
  editedRounds[0] = {
    ...firstRound,
    matches: firstRound.matches.map((match, index) => index === 0
      ? {
          ...match,
          score1: 20,
          score2: 4,
          saved: true,
        }
      : match),
  };

  const rebuilt = rebuildMexicanoClassicFutureRounds(participants, courts, editedRounds, 1, options);
  assert.equal(rebuilt.length, 2, "after score correction engine should rebuild nearest future round");
  assert.equal(rebuilt[0].matches[0].score1, 20);
  assert.equal(rebuilt[0].matches[0].score2, 4);

  const afterRebuild = rebuilt.map((round) => ({
    id: round.id,
    pairs: round.matches.map((match) => [
      [...match.pair1.map((player) => player.id)].sort().join("::"),
      [...match.pair2.map((player) => player.id)].sort().join("::"),
    ].sort().join("|")),
  }));

  assert.notDeepEqual(afterRebuild, beforeRebuild);
});

test("strict classic mexicano keeps deterministic partner pool for 4 players", () => {
  const participants = createParticipants(4);
  const courts = createCourts(1);
  const options = {
    totalRounds: 3,
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "history-seed",
  } satisfies MexicanoClassicOptions;

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  rounds = completeAndAppend(participants, courts, rounds, options);
  rounds = completeAndAppend(participants, courts, rounds, options);

  assert.equal(rounds.length, options.totalRounds);

  const partnerSets = rounds.flatMap((round) => getPartnerKeys(round));
  const uniquePartnerSets = new Set(partnerSets);
  assert.equal(
    uniquePartnerSets.size,
    4,
    "3 rounds with 4 players should stay deterministic and produce 4 unique partner slots",
  );
});

test("classic mexicano is not hard-limited by totalRounds and can continue after round 5", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const options = {
    totalRounds: 5,
    firstRoundMode: "random",
    byeMode: "strict",
    seed: "continue-after-five",
  } satisfies MexicanoClassicOptions;

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  assert.equal(rounds.length, 1);

  for (let step = 0; step < 6; step += 1) {
    rounds = completeAndAppend(participants, courts, rounds, options);
  }

  assert.ok(rounds.length >= 7, "engine should keep adding rounds after 5 completed rounds");
});

test("classic mexicano never uses forbidden 1+2 vs 3+4 pairing", () => {
  const participants = createParticipants(4);
  const courts = createCourts(1);
  const options = {
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "forbidden-scheme",
  } satisfies MexicanoClassicOptions;

  const rounds = createMexicanoClassicInitialRound(participants, courts, options);
  assert.equal(rounds.length, 1);
  const match = rounds[0].matches[0];
  const pairKeys = new Set([
    [...match.pair1.map((player) => player.id)].sort().join("::"),
    [...match.pair2.map((player) => player.id)].sort().join("::"),
  ]);
  assert.ok(
    !(pairKeys.has("p1::p2") && pairKeys.has("p3::p4")),
    "pairing 1+2 vs 3+4 must be forbidden",
  );
  assert.ok(
    match.quality.explanation.includes("схема: 1+3 vs 2+4")
      || match.quality.explanation.includes("схема: 1+4 vs 2+3"),
    "only allowed classic/balance schemes must be used",
  );
});

test("quality explanation includes scheme and repeat diagnostics", () => {
  const participants: AmericanoLabParticipant[] = [
    { id: "p1", name: "Игрок 1", rating: "3.0" },
    { id: "p2", name: "Игрок 2", rating: "3.0" },
    { id: "p3", name: "Игрок 3", rating: "3.0" },
    { id: "p4", name: "Игрок 4", rating: "3.0" },
  ];
  const courts = createCourts(1);
  const options = {
    totalRounds: 6,
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "replacement-reason",
  } satisfies MexicanoClassicOptions;

  const firstRound = createMexicanoClassicInitialRound(participants, courts, options)[0];
  const completedFirstRound = {
    ...firstRound,
    matches: firstRound.matches.map((match) => ({
      ...match,
      score1: 12,
      score2: 12,
      saved: true,
    })),
    saved: true,
  } satisfies AmericanoLabRound;

  const rounds = appendMexicanoClassicRoundIfReady(participants, courts, [completedFirstRound], options);
  assert.equal(rounds.length, 2);
  const explanation = rounds[1].matches[0].quality.explanation;
  assert.ok(
    explanation.includes("схема: "),
    "quality explanation should include pairing scheme",
  );
  assert.ok(
    explanation.includes("повторы партнеров:")
      || explanation.includes("партнеры без повторов"),
    "quality explanation should include partner repeat diagnostics",
  );
  assert.ok(
    explanation.includes("повторы соперников:")
      || explanation.includes("соперники без повторов"),
    "quality explanation should include opponent repeat diagnostics",
  );
});

test("classic mexicano scored rounds require full layout to be validly completed", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const [round] = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "layout-guard",
  });
  const completedRound = markRoundAsCompleted(round);
  const layoutlessRound = {
    ...completedRound,
    matches: completedRound.matches.map((match) => ({
      ...match,
      court: "",
      courtIndex: null as unknown as number,
      pair1: [],
      pair2: [],
    })),
  };

  assert.equal(isClassicMexicanoRoundLayoutComplete(completedRound), true);
  assert.equal(isClassicMexicanoRoundValidlyCompleted(completedRound), true);
  assert.equal(isClassicMexicanoRoundLayoutComplete(layoutlessRound), false);
  assert.equal(isClassicMexicanoRoundValidlyCompleted(layoutlessRound), false);

  const overfilledPairRound = {
    ...completedRound,
    matches: completedRound.matches.map((match, index) => index === 0
      ? {
          ...match,
          pair1: [...match.pair1, participants[4]],
        }
      : match),
  };
  assert.equal(isClassicMexicanoRoundLayoutComplete(overfilledPairRound), false);
  assert.equal(isClassicMexicanoRoundValidlyCompleted(overfilledPairRound), false);
});

test("classic mexicano snapshot preference rejects structurally worse candidate without pending sync", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const [round] = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "snapshot-guard",
  });
  const completedRound = markRoundAsCompleted(round);
  const fullPayload = {
    tournamentType: "mexicano",
    rounds: [completedRound],
  };
  const worsePayload = {
    tournamentType: "mexicano",
    rounds: [
      {
        ...completedRound,
        matches: completedRound.matches.map((match) => ({
          ...match,
          court: "",
          pair1: [],
          pair2: [],
        })),
      },
    ],
  };

  assert.ok(getClassicMexicanoPayloadStructuralScore(fullPayload) > getClassicMexicanoPayloadStructuralScore(worsePayload));
  assert.equal(shouldPreferClassicMexicanoSnapshot(worsePayload, fullPayload), false);
  assert.equal(shouldPreferClassicMexicanoSnapshot(worsePayload, fullPayload, { hasPendingSync: true }), true);
});

test("classic mexicano cached snapshot does not beat current layout without pending sync", () => {
  const participants = createParticipants(8);
  const courts = createCourts(2);
  const [round] = createMexicanoClassicInitialRound(participants, courts, {
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "cached-snapshot-guard",
  });
  const completedRound = markRoundAsCompleted(round);
  const fullPayload = {
    tournamentType: "mexicano",
    rounds: [completedRound],
  };
  const layoutlessPayload = {
    tournamentType: "mexicano",
    rounds: [
      {
        ...completedRound,
        matches: completedRound.matches.map((match) => ({
          ...match,
          court: "",
          courtIndex: null,
          pair1: [],
          pair2: [],
        })),
      },
    ],
  };

  assert.equal(
    shouldPreferClassicMexicanoCachedSnapshot(layoutlessPayload, fullPayload, {
      candidateUpdatedAt: 200,
      currentUpdatedAt: 100,
    }),
    false,
  );
  assert.equal(
    shouldPreferClassicMexicanoCachedSnapshot(fullPayload, layoutlessPayload, {
      candidateUpdatedAt: 100,
      currentUpdatedAt: 200,
    }),
    true,
  );
  assert.equal(
    shouldPreferClassicMexicanoCachedSnapshot(layoutlessPayload, fullPayload, {
      hasPendingSync: true,
      candidateUpdatedAt: 200,
      currentUpdatedAt: 100,
    }),
    true,
  );
});

test("classic mexicano first save of frontend-created round sends full layout after round 5", () => {
  const participants = createParticipants(12);
  const courts = createCourts(3);
  const options: MexicanoClassicOptions = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "round-save-layout-after-five",
    totalRounds: 8,
  };

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  while (rounds.filter((round) => round.saved).length < 5) {
    rounds = completeAndAppend(participants, courts, rounds, options);
  }

  const nextRound = rounds.find((round) => !round.saved);
  assert.ok(nextRound, "frontend should create the next unsaved round after 5 completed rounds");

  const targetMatch = nextRound.matches[0];
  const roundWithOneScore = {
    ...nextRound,
    matches: nextRound.matches.map((match, index) => index === 0
      ? {
          ...match,
          score1: 14,
          score2: 10,
          saved: false,
        }
      : match),
  };
  const results = buildClassicMexicanoRoundSaveResults(roundWithOneScore, targetMatch.id, null);

  assert.equal(results.length, nextRound.matches.length);
  results.forEach((result) => {
    assert.equal(result.roundId, nextRound.id);
    assert.equal(typeof result.court, "string");
    assert.equal(typeof result.courtIndex, "number");
    assert.equal(result.pair1?.length, 2);
    assert.equal(result.pair2?.length, 2);
  });

  const scoredResults = results.filter((result) => result.score1 != null || result.score2 != null);
  assert.deepEqual(scoredResults, [
    {
      roundId: nextRound.id,
      matchId: targetMatch.id,
      court: targetMatch.court,
      courtIndex: targetMatch.courtIndex,
      pair1: targetMatch.pair1.map((player) => player.id),
      pair2: targetMatch.pair2.map((player) => player.id),
      score1: 14,
      score2: 10,
    },
  ]);
});

test("classic mexicano first save still sends full layout when draft round was only cached locally", () => {
  const participants = createParticipants(12);
  const courts = createCourts(3);
  const options: MexicanoClassicOptions = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "round-save-layout-cached-draft",
    totalRounds: 8,
  };

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  while (rounds.filter((round) => round.saved).length < 5) {
    rounds = completeAndAppend(participants, courts, rounds, options);
  }

  const nextRound = rounds.find((round) => !round.saved);
  assert.ok(nextRound, "frontend should keep the next draft round locally before first server save");

  const targetMatch = nextRound.matches[1];
  const roundWithOneScore = {
    ...nextRound,
    matches: nextRound.matches.map((match, index) => index === 1
      ? {
          ...match,
          score1: 16,
          score2: 8,
          saved: false,
        }
      : match),
  };
  const locallyCachedPersistedRound = {
    ...nextRound,
    matches: nextRound.matches.map((match) => ({
      id: match.id,
      court: match.court,
      courtIndex: match.courtIndex,
      pair1: match.pair1.map((player) => player.id),
      pair2: match.pair2.map((player) => player.id),
      score1: null,
      score2: null,
    })),
  };
  const results = buildClassicMexicanoRoundSaveResults(
    roundWithOneScore,
    targetMatch.id,
    locallyCachedPersistedRound,
  );

  assert.equal(results.length, nextRound.matches.length);
  const savedMatch = results.find((result) => result.matchId === targetMatch.id);
  assert.deepEqual(savedMatch, {
    roundId: nextRound.id,
    matchId: targetMatch.id,
    court: targetMatch.court,
    courtIndex: targetMatch.courtIndex,
    pair1: targetMatch.pair1.map((player) => player.id),
    pair2: targetMatch.pair2.map((player) => player.id),
    score1: 16,
    score2: 8,
  });
});

test("classic mexicano partial round save keeps sending full layout until the whole round is persisted", () => {
  const participants = createParticipants(12);
  const courts = createCourts(3);
  const options: MexicanoClassicOptions = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "round-save-layout-partial-round",
    totalRounds: 8,
  };

  let rounds = createMexicanoClassicInitialRound(participants, courts, options);
  while (rounds.filter((round) => round.saved).length < 5) {
    rounds = completeAndAppend(participants, courts, rounds, options);
  }

  const nextRound = rounds.find((round) => !round.saved);
  assert.ok(nextRound, "frontend should expose a partially persisted round for continued saving");

  const targetMatch = nextRound.matches[2];
  const roundWithTwoSavedMatches = {
    ...nextRound,
    matches: nextRound.matches.map((match, index) => {
      if (index === 0) {
        return {
          ...match,
          score1: 15,
          score2: 9,
          saved: true,
        };
      }
      if (index === 2) {
        return {
          ...match,
          score1: 13,
          score2: 11,
          saved: false,
        };
      }
      return match;
    }),
  };
  const partiallyPersistedRound = {
    ...nextRound,
    matches: nextRound.matches.map((match, index) => ({
      id: match.id,
      court: match.court,
      courtIndex: match.courtIndex,
      pair1: match.pair1.map((player) => player.id),
      pair2: match.pair2.map((player) => player.id),
      score1: index === 0 ? 15 : null,
      score2: index === 0 ? 9 : null,
    })),
  };
  const results = buildClassicMexicanoRoundSaveResults(
    roundWithTwoSavedMatches,
    targetMatch.id,
    partiallyPersistedRound,
  );

  assert.equal(results.length, nextRound.matches.length);
  assert.deepEqual(
    results.find((result) => result.matchId === nextRound.matches[0].id),
    {
      roundId: nextRound.id,
      matchId: nextRound.matches[0].id,
      court: nextRound.matches[0].court,
      courtIndex: nextRound.matches[0].courtIndex,
      pair1: nextRound.matches[0].pair1.map((player) => player.id),
      pair2: nextRound.matches[0].pair2.map((player) => player.id),
      score1: 15,
      score2: 9,
    },
  );
  assert.deepEqual(
    results.find((result) => result.matchId === targetMatch.id),
    {
      roundId: nextRound.id,
      matchId: targetMatch.id,
      court: targetMatch.court,
      courtIndex: targetMatch.courtIndex,
      pair1: targetMatch.pair1.map((player) => player.id),
      pair2: targetMatch.pair2.map((player) => player.id),
      score1: 13,
      score2: 11,
    },
  );
});

test("classic mexicano final match save publishes the next round layout in the same payload", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const options: MexicanoClassicOptions = {
    firstRoundMode: "by_level",
    tableSortMode: "total_points",
    winnerSortMode: "point_diff",
    byeMode: "rotating_bye",
    seed: "publish-next-round-layout",
    totalRounds: 8,
  };
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
  const targetMatch = currentRound.matches[currentRound.matches.length - 1];

  const results = buildClassicMexicanoMatchSaveResults(
    participants,
    courts,
    [currentRound],
    currentRound.id,
    targetMatch.id,
    [persistedRound],
    options,
  );

  const currentRoundResults = results.filter((result) => result.roundId === currentRound.id);
  const nextRoundResults = results.filter((result) => result.roundId === "round-2");
  assert.equal(currentRoundResults.length, currentRound.matches.length);
  assert.equal(
    currentRoundResults.filter((result) => result.score1 != null && result.score2 != null).length,
    currentRound.matches.length,
  );
  assert.equal(nextRoundResults.length, courts.length);
  nextRoundResults.forEach((result) => {
    assert.equal(result.score1, undefined);
    assert.equal(result.score2, undefined);
    assert.equal(result.pair1?.length, 2);
    assert.equal(result.pair2?.length, 2);
  });
});

test("classic mexicano does not publish the next layout before the current round is fully saved", () => {
  const participants = createParticipants(16);
  const courts = createCourts(4);
  const options: MexicanoClassicOptions = {
    firstRoundMode: "by_level",
    byeMode: "strict",
    seed: "keep-current-round-only",
  };
  const [initialRound] = createMexicanoClassicInitialRound(participants, courts, options);
  const currentRound = {
    ...initialRound,
    matches: initialRound.matches.map((match, index) => ({
      ...match,
      score1: index < 2 ? 14 : null,
      score2: index < 2 ? 10 : null,
      saved: index === 0,
    })),
    saved: false,
  };

  const results = buildClassicMexicanoMatchSaveResults(
    participants,
    courts,
    [currentRound],
    currentRound.id,
    currentRound.matches[1].id,
    [currentRound],
    options,
  );

  assert.ok(results.length > 0);
  assert.equal(results.some((result) => result.roundId === "round-2"), false);
});

test("mexicano params helper exposes expected defaults", () => {
  const params = buildMexicanoClassicParams(10, {
    seed: "params-seed",
    byeMode: "rotating_bye",
    firstRoundMode: "random",
  });
  assert.equal(params.mexicanoMode, "classic");
  assert.equal(params.byeMode, "rotating_bye");
  assert.equal(params.firstRoundMode, "random");
  assert.equal(params.byePointsMode, "zero");
  assert.equal(typeof params.totalRounds, "number");
  assert.ok(params.totalRounds >= 1);
});
