import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConfirmationToken,
  buildRepairEvent,
  replayLedgerDeltas,
  replayTournamentCanonicalTargets,
} from "../repair_tournament_canonical_ratings.mjs";

test("tournament canonical replay uses ratingAfter as target for Dmitry regression", () => {
  const events = [
    {
      _id: "baseline",
      id: "baseline",
      eventType: "RATING_INITIAL_IMPORTED",
      occurredAt: "2026-07-01T00:00:00.000Z",
      source: { domain: "VIVA" },
      change: { after: 2.15778 },
    },
    {
      _id: "tournament",
      id: "tournament",
      eventType: "TOURNAMENT_RATING_FINALIZED",
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { domain: "TOURNAMENT" },
      change: { before: 3.358, delta: 0.23838, after: 3.59638 },
    },
  ];

  assert.deepEqual(replayTournamentCanonicalTargets(events), {
    ratingNumeric: 3.59638,
    rating: "C+",
    baselineEventId: "baseline",
    lastSourceEventId: "tournament",
    lastSourceEventAt: "2026-07-02T00:00:00.000Z",
    tournamentTargets: 1,
    deltaEvents: 0,
  });
  assert.equal(replayLedgerDeltas(events), 2.39616);
});

test("events after a tournament target continue to apply their delta", () => {
  const replay = replayTournamentCanonicalTargets([
    {
      id: "baseline",
      eventType: "RATING_BOOTSTRAPPED_FROM_VIVA",
      occurredAt: "2026-07-01T00:00:00.000Z",
      source: { domain: "VIVA" },
      change: { after: 2 },
    },
    {
      id: "tournament",
      eventType: "TOURNAMENT_RATING_FINALIZED",
      occurredAt: "2026-07-02T00:00:00.000Z",
      source: { domain: "TOURNAMENT" },
      change: { delta: 0.1, after: 3.5 },
    },
    {
      id: "game",
      eventType: "GAME_RATING_CHANGED",
      occurredAt: "2026-07-03T00:00:00.000Z",
      source: { domain: "GAME_RESULT" },
      change: { delta: -0.125 },
    },
  ]);

  assert.equal(replay?.ratingNumeric, 3.375);
  assert.equal(replay?.rating, "C");
});

test("repair event is append-only reconciliation and token is deterministic", () => {
  const row = {
    repairEventId: "repair-1",
    playerKey: "client:1",
    clientId: "1",
    phoneNorm: "79197295279",
    name: "Dmitry",
    currentRating: 2.39616,
    desiredRating: 3.59638,
    currentGrade: "D",
    desiredGrade: "C+",
    delta: 1.20022,
    expectedLastEventId: "old-event",
    sourceFrontierHash: "frontier",
    sourceEventCount: 2,
    tournamentTargets: 1,
    latestSourceEventId: "tournament",
  };
  const token = buildConfirmationToken([row]);
  assert.equal(token, buildConfirmationToken([row]));
  assert.match(token, /^REPAIR_[A-F0-9]{20}$/);
  const event = buildRepairEvent(row, "2026-07-20T00:00:00.000Z");
  assert.equal(event.change.before, 2.39616);
  assert.equal(event.change.delta, 1.20022);
  assert.equal(event.change.after, 3.59638);
  assert.equal(event.source.applyToState, true);
  assert.equal(event.projectionIntent.viva, "REQUIRED");
});
