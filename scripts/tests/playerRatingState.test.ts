import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTournamentCompensationEvent,
  buildTournamentRatingEvent,
  buildTournamentStartOverrideEvent,
  replayPlayerRatingEvents,
} from "../../src/services/player-rating/ledger.ts";
import {
  buildCanonicalStateMigrationPlan,
  buildIdentityCrosswalk,
} from "../migrate_player_rating_state.mjs";

test("identity migration promotes phone-only state to an unambiguous client key", () => {
  const crosswalk = buildIdentityCrosswalk({
    visits: [{ clientId: "client-1", phoneNorm: "+7 (900) 000-00-01" }],
  });
  const plan = buildCanonicalStateMigrationPlan([{
    _id: "legacy-row",
    phoneNorm: "79000000001",
    ratingNumeric: 3.25,
    rating: "C",
    lastEventId: "rating_evt:initial",
    lastEventAt: "2026-07-10T10:00:00.000Z",
  }], crosswalk, "2026-07-10T12:00:00.000Z");

  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.states[0]?.playerKey, "client:client-1");
  assert.equal(plan.states[0]?.clientId, "client-1");
  assert.deepEqual(plan.states[0]?.identityAliases, {
    clientIds: ["client-1"],
    phoneNorms: ["79000000001"],
  });
});

test("identity migration reports ambiguous phone mappings", () => {
  const crosswalk = buildIdentityCrosswalk({
    visits: [
      { clientId: "client-1", phoneNorm: "79000000001" },
      { clientId: "client-2", phoneNorm: "79000000001" },
    ],
  });

  assert.equal(crosswalk.byPhone.has("79000000001"), false);
  assert.deepEqual(crosswalk.conflicts, [{
    kind: "PHONE_TO_MULTIPLE_CLIENTS",
    phoneNorm: "79000000001",
    count: 2,
  }]);
  const plan = buildCanonicalStateMigrationPlan([
    { _id: "legacy", phoneNorm: "79000000001", ratingNumeric: 3 },
  ], crosswalk, "2026-07-10T12:00:00.000Z");
  assert.equal(plan.conflicts.length, 1);
});

test("confirmed rating result wins over a membership-only phone alias", () => {
  const crosswalk = buildIdentityCrosswalk({
    communities: [{ members: [
      { id: "legacy-member", phone: "79000000001" },
      { id: "rating-player", phone: "79000000001" },
    ] }],
    results: [{ ratingImpact: [
      { id: "rating-player", phoneNorm: "79000000001", after: 3.2 },
    ] }],
  });

  assert.equal(crosswalk.byPhone.get("79000000001"), "rating-player");
  assert.equal(crosswalk.conflicts.length, 0);
});

test("state replay is deterministic when tournament event arrives after a newer game event", () => {
  const replay = replayPlayerRatingEvents([
    {
      id: "game",
      _id: "game",
      idempotencyKey: "game",
      schemaVersion: 1,
      eventType: "GAME_RESULT_CONFIRMED",
      occurredAt: "2026-07-10T12:10:00.000Z",
      createdAt: "2026-07-10T12:10:00.000Z",
      player: { key: "client:p1", clientId: "p1", phoneNorm: null, name: "P1" },
      actor: {},
      source: {},
      change: { before: 3, delta: 0.1, after: 3.1, gradeBefore: "C", gradeAfter: "C" },
      formula: null,
      projectionIntent: { viva: "NONE" },
    },
    {
      id: "baseline",
      _id: "baseline",
      idempotencyKey: "baseline",
      schemaVersion: 1,
      eventType: "RATING_INITIAL_IMPORTED",
      occurredAt: "2026-07-10T12:00:00.000Z",
      createdAt: "2026-07-10T12:00:00.000Z",
      player: { key: "client:p1", clientId: "p1", phoneNorm: null, name: "P1" },
      actor: {},
      source: {},
      change: { before: null, delta: null, after: 3, gradeBefore: null, gradeAfter: "C" },
      formula: null,
      projectionIntent: { viva: "NONE" },
    },
    {
      id: "tournament",
      _id: "tournament",
      idempotencyKey: "tournament",
      schemaVersion: 1,
      eventType: "TOURNAMENT_RATING_FINALIZED",
      occurredAt: "2026-07-10T12:05:00.000Z",
      createdAt: "2026-07-10T12:15:00.000Z",
      player: { key: "client:p1", clientId: "p1", phoneNorm: null, name: "P1" },
      actor: {},
      source: {},
      change: { before: 3, delta: 0.2, after: 3.2, gradeBefore: "C", gradeAfter: "C" },
      formula: null,
      projectionIntent: { viva: "NONE" },
    },
  ]);

  assert.equal(replay?.ratingNumeric, 3.3);
  assert.equal(replay?.lastEventId, "game");
  assert.equal(replay?.appliedEvents, 2);
});

test("historical ledger-only events do not change canonical player state", () => {
  const baseline = {
    id: "baseline",
    _id: "baseline",
    idempotencyKey: "baseline",
    schemaVersion: 1,
    eventType: "RATING_INITIAL_IMPORTED",
    occurredAt: "2026-07-10T12:00:00.000Z",
    createdAt: "2026-07-10T12:00:00.000Z",
    player: { key: "client:p1", clientId: "p1", phoneNorm: null, name: "P1" },
    actor: {},
    source: {},
    change: { before: null, delta: null, after: 3, gradeBefore: null, gradeAfter: "C" },
    formula: null,
    projectionIntent: { viva: "NONE" },
  };
  const historical = {
    ...baseline,
    id: "historical",
    _id: "historical",
    idempotencyKey: "historical",
    eventType: "TOURNAMENT_RATING_HISTORICAL_BACKFILLED",
    occurredAt: "2026-06-01T12:00:00.000Z",
    createdAt: "2026-07-10T13:00:00.000Z",
    source: { domain: "TOURNAMENT", applyToState: false },
    change: { before: 2.8, delta: 0.2, after: 3, gradeBefore: "D+", gradeAfter: "C" },
  };

  const replay = replayPlayerRatingEvents([baseline, historical]);

  assert.equal(replay?.ratingNumeric, 3);
  assert.equal(replay?.lastEventId, "baseline");
  assert.equal(replay?.appliedEvents, 0);
});

test("tournament canonical reconciliation establishes a new baseline after rating clamp", () => {
  const replay = replayPlayerRatingEvents([
    {
      _id: "baseline",
      id: "baseline",
      idempotencyKey: "baseline",
      schemaVersion: 1,
      eventType: "RATING_INITIAL_IMPORTED",
      occurredAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
      player: { key: "client:1", clientId: "1", phoneNorm: null, name: "Player" },
      actor: {},
      source: { domain: "VIVA" },
      change: { before: null, delta: null, after: 1, gradeBefore: null, gradeAfter: "D" },
      formula: null,
      projectionIntent: { viva: "NONE" },
    },
    {
      _id: "legacy-loss",
      id: "legacy-loss",
      idempotencyKey: "legacy-loss",
      schemaVersion: 1,
      eventType: "TOURNAMENT_RATING_FINALIZED",
      occurredAt: "2026-07-02T00:00:00.000Z",
      createdAt: "2026-07-02T00:00:00.000Z",
      player: { key: "client:1", clientId: "1", phoneNorm: null, name: "Player" },
      actor: {},
      source: { domain: "TOURNAMENT" },
      change: { before: 1, delta: -0.5, after: 1, gradeBefore: "D", gradeAfter: "D" },
      formula: null,
      projectionIntent: { viva: "NONE" },
    },
    {
      _id: "reconciliation",
      id: "reconciliation",
      idempotencyKey: "reconciliation",
      schemaVersion: 1,
      eventType: "RATING_TOURNAMENT_CANONICAL_RECONCILED",
      occurredAt: "2026-07-20T00:00:00.000Z",
      createdAt: "2026-07-20T00:00:00.000Z",
      player: { key: "client:1", clientId: "1", phoneNorm: null, name: "Player" },
      actor: {},
      source: { domain: "RATING_REPAIR", repairVersion: "tournament-canonical-reconciliation-v1.0.8" },
      change: { before: 1, delta: 0.1, after: 1.1, gradeBefore: "D", gradeAfter: "D" },
      formula: null,
      projectionIntent: { viva: "REQUIRED" },
    },
  ]);

  assert.equal(replay?.ratingNumeric, 1.1);
  assert.equal(replay?.baselineEventId, "reconciliation");
  assert.equal(replay?.lastEventId, "reconciliation");
});

test("tournament event targets ratingAfter when tournament before differs from canonical state", () => {
  const event = buildTournamentRatingEvent({
    tournamentId: "da1d6879-26c7-4763-a313-c4bb6445f937",
    finishedAt: "2026-07-18T09:27:30.864Z",
    standing: {
      id: "1b516b57-5617-44d0-a547-cc15dc2e6f42",
      name: "Дмитрий Захаров",
      ratingBefore: 3.358,
      ratingDelta: 0.23838,
      ratingAfter: 3.59638,
    },
    phoneNorm: "79197295279",
    canonicalBefore: 2.15778,
  });

  assert.ok(event);
  assert.deepEqual(event.change, {
    before: 2.15778,
    delta: 1.4386,
    after: 3.59638,
    gradeBefore: "D",
    gradeAfter: "C+",
  });
  assert.deepEqual(event.source.tournamentRatingSnapshot, {
    before: 3.358,
    delta: 0.23838,
    after: 3.59638,
  });

  const baseline = {
    ...event,
    id: "baseline",
    _id: "baseline",
    idempotencyKey: "baseline",
    eventType: "RATING_INITIAL_IMPORTED",
    occurredAt: "2026-07-10T10:28:23.905Z",
    source: { domain: "INITIAL_IMPORT" },
    change: { before: null, delta: null, after: 2.15778, gradeBefore: null, gradeAfter: "D+" },
  };
  const replay = replayPlayerRatingEvents([baseline, event]);

  assert.equal(replay?.ratingNumeric, 3.59638);
  assert.equal(replay?.rating, "C+");
  assert.equal(replay?.lastEventId, event.id);
});

test("tournament start override becomes canonical before the final tournament delta", () => {
  const startOverride = buildTournamentStartOverrideEvent({
    tournamentId: "tournament-1",
    canonicalBefore: 2.15778,
    phoneNorm: "79197295279",
    createdAt: "2026-07-20T09:00:01.000Z",
    startChange: {
      eventId: "rating_evt:tournament_start:tournament-1:client-1:1",
      occurredAt: "2026-07-20T09:00:00.000Z",
      player: {
        participantId: "client-1",
        clientId: "client-1",
        name: "Дмитрий",
        phone: "79197295279",
      },
      changedBy: {
        id: "organizer-1",
        name: "Организатор",
        phone: "79000000001",
      },
      source: { reason: "MANUAL_OVERRIDE" },
      change: { before: 2.15778, after: 3.358 },
    },
  });
  assert.ok(startOverride);
  assert.equal(startOverride.eventType, "TOURNAMENT_START_RATING_CHANGED");
  assert.equal(startOverride.source.domain, "TOURNAMENT_START");
  assert.deepEqual(startOverride.change, {
    before: 2.15778,
    delta: 1.20022,
    after: 3.358,
    gradeBefore: "D",
    gradeAfter: "C",
  });
  assert.deepEqual(startOverride.actor, {
    type: "ADMIN",
    id: "organizer-1",
    name: "Организатор",
    phoneNorm: "79000000001",
  });

  const finalEvent = buildTournamentRatingEvent({
    tournamentId: "tournament-1",
    finishedAt: "2026-07-20T12:00:00.000Z",
    canonicalBefore: 3.358,
    phoneNorm: "79197295279",
    standing: {
      id: "client-1",
      name: "Дмитрий",
      ratingBefore: 3.358,
      ratingDelta: 0.23838,
      ratingAfter: 3.59638,
    },
  });
  assert.ok(finalEvent);

  const baseline = {
    ...startOverride,
    _id: "baseline",
    id: "baseline",
    idempotencyKey: "baseline",
    eventType: "RATING_INITIAL_IMPORTED",
    occurredAt: "2026-07-10T00:00:00.000Z",
    source: { domain: "INITIAL_IMPORT" },
    change: { before: null, delta: null, after: 2.15778, gradeBefore: null, gradeAfter: "D" },
  };
  const replay = replayPlayerRatingEvents([baseline, startOverride, finalEvent]);

  assert.equal(replay?.ratingNumeric, 3.59638);
  assert.equal(replay?.lastEventId, finalEvent.id);
});

test("tournament correction produces immutable compensation and new revision", () => {
  const first = buildTournamentRatingEvent({
    tournamentId: "t1",
    finishedAt: "2026-07-10T12:00:00.000Z",
    standing: { id: "p1", name: "P1", ratingBefore: 3, ratingDelta: 0.2, ratingAfter: 3.2 },
  });
  assert.ok(first);
  const compensation = buildTournamentCompensationEvent({
    event: first,
    occurredAt: "2026-07-10T12:30:00.000Z",
    reason: "CORRECTED",
  });
  const corrected = buildTournamentRatingEvent({
    tournamentId: "t1",
    finishedAt: "2026-07-10T12:30:01.000Z",
    occurredAt: "2026-07-10T12:30:02.000Z",
    standing: { id: "p1", name: "P1", ratingBefore: 3, ratingDelta: 0.1, ratingAfter: 3.1 },
    canonicalBefore: first.change.before,
    previousEventId: first.id,
  });
  const baseline = {
    ...first,
    _id: "baseline",
    id: "baseline",
    idempotencyKey: "baseline",
    eventType: "RATING_INITIAL_IMPORTED",
    occurredAt: "2026-07-10T11:59:59.000Z",
    source: { domain: "INITIAL_IMPORT" },
    change: {
      before: null,
      delta: null,
      after: 3,
      gradeBefore: null,
      gradeAfter: "C",
    },
  };
  const replay = replayPlayerRatingEvents([baseline, first, compensation, corrected]);

  assert.equal(compensation?.change.delta, -0.2);
  assert.equal(compensation?.source.compensatesEventId, first.id);
  assert.equal(corrected?.change.delta, 0.1);
  assert.notEqual(corrected?.id, first.id);
  assert.equal(corrected?.source.supersedesEventId, first.id);
  assert.equal(corrected?.occurredAt, "2026-07-10T12:30:02.000Z");
  assert.equal(replay?.ratingNumeric, 3.1);
});

test("reapplying a prior tournament standings revision after a correction has a new idempotency key", () => {
  const first = buildTournamentRatingEvent({
    tournamentId: "t1",
    finishedAt: "2026-07-10T12:00:00.000Z",
    standing: { id: "p1", name: "P1", ratingBefore: 3, ratingDelta: 0.2, ratingAfter: 3.2 },
  });
  const restored = buildTournamentRatingEvent({
    tournamentId: "t1",
    finishedAt: "2026-07-10T12:00:00.000Z",
    standing: { id: "p1", name: "P1", ratingBefore: 3, ratingDelta: 0.2, ratingAfter: 3.2 },
    previousEventId: "rating_evt:tournament:obsolete_revision",
  });

  assert.ok(first);
  assert.ok(restored);
  assert.notEqual(restored?.id, first?.id);
  assert.equal(restored?.source.sourceRevision, first?.source.sourceRevision);
});
