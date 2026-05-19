import test from "node:test";
import assert from "node:assert/strict";
import {
  appendMexicanoClassicRoundIfReady,
  buildMexicanoClassicParams,
  createMexicanoClassicInitialRound,
  rebuildMexicanoClassicFutureRounds,
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

test("partner and opponent history is tracked via penalty minimization", () => {
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
  assert.equal(uniquePartnerSets.size, 6, "4 players * 3 rounds should produce 6 unique partner slots");
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

test("pair replacement reason is logged when avoiding repeated partners", () => {
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
    explanation.includes("замена выполнена из-за повтора партнера")
      || explanation.includes("замена выполнена из-за повтора соперника"),
    "replacement reason for repeated partner/opponent must be present",
  );
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
