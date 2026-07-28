import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAmericanoStandings,
  createPairedAmericanoRounds,
  type AmericanoLabParticipant,
  type PairedMexicanoPairAssignment,
} from "../../src/components/tournaments/americanoLab.ts";

function createParticipants(count: number): AmericanoLabParticipant[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: String(7 - (index % 7) * 0.25),
  }));
}

function createCourts(count: number) {
  return Array.from({ length: count }, (_, index) => `Корт №${index + 1}`);
}

function createFixedPairs(pairsCount: number): PairedMexicanoPairAssignment[] {
  return Array.from({ length: pairsCount }, (_, index) => (
    [`p${index * 2 + 1}`, `p${index * 2 + 2}`] satisfies PairedMexicanoPairAssignment
  ));
}

function getPairKey(pair: Array<{ id: string }> | string[]) {
  return pair.map((item) => typeof item === "string" ? item : item.id).sort().join("::");
}

test("paired americano uses N-1 rounds without byes when all fixed pairs fit on courts", () => {
  const pairsCount = 8;
  const participants = createParticipants(pairsCount * 2);
  const courts = createCourts(pairsCount / 2);
  const pairAssignments = createFixedPairs(pairsCount);

  const rounds = createPairedAmericanoRounds(participants, courts, pairAssignments);

  assert.equal(rounds.length, pairsCount - 1);

  const seenMatchups = new Set<string>();
  rounds.forEach((round) => {
    assert.equal(round.matches.length, courts.length, `${round.id}: every court must be used`);
    assert.equal(round.byes.length, 0, `${round.id}: byes are not expected`);

    const usedPairs = new Set<string>();
    round.matches.forEach((match) => {
      const pair1Key = getPairKey(match.pair1);
      const pair2Key = getPairKey(match.pair2);
      const matchupKey = [pair1Key, pair2Key].sort().join("||");

      assert.ok(!usedPairs.has(pair1Key), `${round.id}: ${pair1Key} duplicated inside round`);
      assert.ok(!usedPairs.has(pair2Key), `${round.id}: ${pair2Key} duplicated inside round`);
      assert.ok(!seenMatchups.has(matchupKey), `${round.id}: repeated opponent pair ${matchupKey}`);

      usedPairs.add(pair1Key);
      usedPairs.add(pair2Key);
      seenMatchups.add(matchupKey);
    });

    assert.equal(usedPairs.size, pairsCount, `${round.id}: every fixed pair must play exactly once`);
  });

  assert.equal(seenMatchups.size, (pairsCount * (pairsCount - 1)) / 2);
});

test("paired americano standings assign the same place to both players of a fixed pair", () => {
  const pairsCount = 4;
  const participants = createParticipants(pairsCount * 2);
  const courts = createCourts(pairsCount / 2);
  const pairAssignments = createFixedPairs(pairsCount);
  const pairSeedByKey = new Map(pairAssignments.map((pair, index) => [getPairKey(pair), index]));
  const pairKeyByPlayerId = new Map<string, string>();

  pairAssignments.forEach((pair) => {
    const pairKey = getPairKey(pair);
    pair.forEach((playerId) => pairKeyByPlayerId.set(playerId, pairKey));
  });

  const [round] = createPairedAmericanoRounds(participants, courts, pairAssignments);
  const completedRound = {
    ...round,
    matches: round.matches.map((match) => {
      const pair1Key = getPairKey(match.pair1);
      const pair2Key = getPairKey(match.pair2);
      const pair1Seed = pairSeedByKey.get(pair1Key) ?? Number.MAX_SAFE_INTEGER;
      const pair2Seed = pairSeedByKey.get(pair2Key) ?? Number.MAX_SAFE_INTEGER;
      const pair1Wins = pair1Seed < pair2Seed;
      const loserScore = Math.max(8, 14 - Math.abs(pair1Seed - pair2Seed));

      return {
        ...match,
        score1: pair1Wins ? 21 : loserScore,
        score2: pair1Wins ? loserScore : 21,
        saved: true,
      };
    }),
    saved: true,
  };

  const standings = buildAmericanoStandings(
    participants,
    [completedRound],
    undefined,
    {
      rankByPairs: true,
      pairAssignments,
    },
  );

  pairAssignments.forEach(([leftId, rightId]) => {
    const leftRow = standings.rows.find((row) => row.id === leftId);
    const rightRow = standings.rows.find((row) => row.id === rightId);
    assert.ok(leftRow, `${leftId} must be present in standings`);
    assert.ok(rightRow, `${rightId} must be present in standings`);
    assert.equal(leftRow?.rank, rightRow?.rank, `pair ${leftId}/${rightId} must share one place`);
  });

  for (let index = 0; index < standings.rows.length; index += 2) {
    const leftPairKey = pairKeyByPlayerId.get(standings.rows[index]?.id ?? "");
    const rightPairKey = pairKeyByPlayerId.get(standings.rows[index + 1]?.id ?? "");
    assert.ok(leftPairKey, `row ${index + 1} must belong to a fixed pair`);
    assert.equal(leftPairKey, rightPairKey, `rows ${index + 1} and ${index + 2} must stay grouped by pair`);
  }

  assert.deepEqual(
    Array.from(new Set(standings.rows.map((row) => row.rank))),
    [1, 2, 3, 4],
  );
});
