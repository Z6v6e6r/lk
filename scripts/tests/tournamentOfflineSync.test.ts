import test from "node:test";
import assert from "node:assert/strict";
import {
  computeTournamentOfflineRetryDelayMs,
  getTournamentOfflineResultMatchKey,
  getTournamentOfflineResultQueueScope,
  mergeTournamentOfflineResultPayloads,
  shouldQueueTournamentResultError,
} from "../../src/utils/tournamentOfflineSyncPolicy.ts";

test("tournament result retry backoff starts at 10s and caps at 10m", () => {
  assert.equal(computeTournamentOfflineRetryDelayMs(1), 10_000);
  assert.equal(computeTournamentOfflineRetryDelayMs(2), 20_000);
  assert.equal(computeTournamentOfflineRetryDelayMs(6), 320_000);
  assert.equal(computeTournamentOfflineRetryDelayMs(7), 600_000);
  assert.equal(computeTournamentOfflineRetryDelayMs(20), 600_000);
});

test("tournament result sync queues offline and transient server errors only", () => {
  assert.equal(
    shouldQueueTournamentResultError({ status: null, message: "Network error" }),
    true,
  );
  assert.equal(
    shouldQueueTournamentResultError({ status: 429, message: "Too many requests" }),
    true,
  );
  assert.equal(
    shouldQueueTournamentResultError({ status: 503, message: "Service unavailable" }),
    true,
  );
  assert.equal(
    shouldQueueTournamentResultError({ status: 400, message: "Validation failed" }),
    false,
  );
  assert.equal(
    shouldQueueTournamentResultError({ status: 422, message: "ROUND_LAYOUT_REQUIRED" }),
    false,
  );
});

test("tournament offline queue scope is stable per round set", () => {
  const finishScope = getTournamentOfflineResultQueueScope({
    tournamentId: "t-1",
    results: [],
  });
  const roundScope = getTournamentOfflineResultQueueScope({
    tournamentId: "t-1",
    results: [
      { roundId: "round-2", matchId: "match-2" },
      { roundId: "round-1", matchId: "match-1" },
    ],
  });

  assert.equal(finishScope, "finish");
  assert.equal(roundScope, "round:round-1+round-2");
  assert.equal(getTournamentOfflineResultMatchKey("round-1", "match-1"), "round-1::match-1");
});

test("next-round layout stays in the current scored round offline queue job", () => {
  const scope = getTournamentOfflineResultQueueScope({
    tournamentId: "t-1",
    results: [
      {
        roundId: "round-1",
        matchId: "round-1-match-1",
        score1: 14,
        score2: 10,
      },
      {
        roundId: "round-2",
        matchId: "round-2-match-1",
        court: "Court A",
        pair1: ["p1", "p2"],
        pair2: ["p3", "p4"],
      },
    ],
  });

  assert.equal(scope, "round:round-1");
});

test("tournament offline payload merge keeps latest scores and params", () => {
  const merged = mergeTournamentOfflineResultPayloads(
    {
      tournamentId: "t-1",
      results: [
        {
          roundId: "round-1",
          matchId: "match-1",
          score1: 6,
          score2: 4,
          court: "Court A",
          pair1: ["p1"],
          pair2: ["p2"],
        },
      ],
      params: {
        status: "draft",
      },
    },
    {
      tournamentId: "t-1",
      results: [
        {
          roundId: "round-1",
          matchId: "match-1",
          score1: null,
          score2: 5,
          court: "",
          pair1: [],
          pair2: ["p3"],
        },
        {
          roundId: "round-2",
          matchId: "match-2",
          score1: 7,
          score2: 3,
        },
      ],
      params: {
        status: "published",
        source: "mobile",
      },
    },
  );

  assert.equal(merged.tournamentId, "t-1");
  assert.deepEqual(merged.params, {
    status: "published",
    source: "mobile",
  });
  assert.equal(merged.results.length, 2);
  assert.deepEqual(
    merged.results.find((item) => item.roundId === "round-1" && item.matchId === "match-1"),
    {
      roundId: "round-1",
      matchId: "match-1",
      score1: 6,
      score2: 5,
      court: "Court A",
      courtIndex: null,
      pair1: ["p1"],
      pair2: ["p3"],
    },
  );
});

test("tournament offline payload merge keeps existing round layout when latest score omits it", () => {
  const merged = mergeTournamentOfflineResultPayloads(
    {
      tournamentId: "t-1",
      results: [
        {
          roundId: "round-1",
          matchId: "match-1",
          score1: 10,
          score2: 14,
          court: "Court A",
          courtIndex: 0,
          pair1: ["p1", "p2"],
          pair2: ["p3", "p4"],
        },
        {
          roundId: "round-1",
          matchId: "match-2",
          court: "Court B",
          courtIndex: 1,
          pair1: ["p5", "p6"],
          pair2: ["p7", "p8"],
        },
      ],
    },
    {
      tournamentId: "t-1",
      results: [
        {
          roundId: "round-1",
          matchId: "match-1",
          score1: 11,
          score2: 13,
        },
      ],
    },
  );

  assert.deepEqual(
    merged.results.find((item) => item.roundId === "round-1" && item.matchId === "match-1"),
    {
      roundId: "round-1",
      matchId: "match-1",
      score1: 11,
      score2: 13,
      court: "Court A",
      courtIndex: 0,
      pair1: ["p1", "p2"],
      pair2: ["p3", "p4"],
    },
  );
  assert.deepEqual(
    merged.results.find((item) => item.roundId === "round-1" && item.matchId === "match-2"),
    {
      roundId: "round-1",
      matchId: "match-2",
      score1: null,
      score2: null,
      court: "Court B",
      courtIndex: 1,
      pair1: ["p5", "p6"],
      pair2: ["p7", "p8"],
    },
  );
});
