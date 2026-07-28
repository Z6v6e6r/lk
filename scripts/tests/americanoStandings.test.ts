import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAmericanoStandings,
  type AmericanoLabParticipant,
  type AmericanoLabRound,
} from "../../src/components/tournaments/americanoLab.ts";

function createParticipants(): AmericanoLabParticipant[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Игрок ${index + 1}`,
    rating: "4.0",
  }));
}

test("americano standings can rank by total points instead of point diff", () => {
  const participants = createParticipants();
  const round: AmericanoLabRound = {
    id: "round-1",
    index: 1,
    byes: [],
    collapsed: false,
    saved: true,
    quality: {
      score: 100,
      label: "Высокое",
      explanation: "test",
      averageCourtScore: 100,
      minCourtScore: 100,
      byeCount: 0,
    },
    matches: [
      {
        id: "match-1",
        court: "Корт №1",
        courtIndex: 0,
        pair1: participants.slice(0, 2),
        pair2: participants.slice(2, 4),
        score1: 21,
        score2: 20,
        saved: true,
        quality: {
          score: 100,
          label: "Высокое",
          explanation: "test",
          partnerRepeatCount: 0,
          opponentRepeatCount: 0,
          balanceGap: 0,
          courtRepeatPressure: 0,
        },
        summary: {
          pairPower1: 4,
          pairPower2: 4,
          balanceGap: 0,
          partnerRepeatCount: 0,
          opponentRepeatCount: 0,
        },
      },
      {
        id: "match-2",
        court: "Корт №2",
        courtIndex: 1,
        pair1: participants.slice(4, 6),
        pair2: participants.slice(6, 8),
        score1: 12,
        score2: 0,
        saved: true,
        quality: {
          score: 100,
          label: "Высокое",
          explanation: "test",
          partnerRepeatCount: 0,
          opponentRepeatCount: 0,
          balanceGap: 0,
          courtRepeatPressure: 0,
        },
        summary: {
          pairPower1: 4,
          pairPower2: 4,
          balanceGap: 0,
          partnerRepeatCount: 0,
          opponentRepeatCount: 0,
        },
      },
    ],
  };

  const byDiff = buildAmericanoStandings(participants, [round], undefined, {
    sortMode: "point_diff",
  });
  const byPoints = buildAmericanoStandings(participants, [round], undefined, {
    sortMode: "total_points",
  });

  assert.deepEqual(byDiff.rows.slice(0, 2).map((row) => row.id), ["p5", "p6"]);
  assert.deepEqual(byPoints.rows.slice(0, 2).map((row) => row.id), ["p1", "p2"]);
});
