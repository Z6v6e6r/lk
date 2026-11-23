import test from "node:test";
import assert from "node:assert/strict";
import {
  PLAYER_RATING_BANDS,
  ratingGradeFromNumeric,
  ratingSublevelFromNumeric,
  ratingSublevelsForBand,
  buildGameResultBaselineEvent,
  buildTournamentCompensationEvent,
  buildTournamentRatingEvent,
  buildTournamentStartOverrideEvent,
  replayPlayerRatingEvents,
} from "../../src/services/player-rating/ledger.ts";
import {
  buildCanonicalStateMigrationPlan,
  buildIdentityCrosswalk,
} from "../migrate_player_rating_state.mjs";

test("player rating grades match the scale at every boundary", () => {
  const cases = [
    [1, "D"], [1.99999, "D"], [2, "D+"], [2.3, "D+"], [2.99999, "D+"],
    [3, "C"], [3.49999, "C"], [3.5, "C+"], [3.99999, "C+"], [4, "B"],
    [4.69999, "B"], [4.7, "B+"], [5.49999, "B+"], [5.5, "A"], [7, "A"],
  ] as const;
  for (const [value, grade] of cases) assert.equal(ratingGradeFromNumeric(value), grade, String(value));
  assert.equal(ratingGradeFromNumeric("4,7"), "B+");
  assert.equal(ratingGradeFromNumeric(4.699999), "B+");
});

test("each player rating band has four equal sublevels with consistent boundary ownership", () => {
  for (const band of PLAYER_RATING_BANDS) {
    const steps = ratingSublevelsForBand(band);
    assert.equal(steps.length, 4);
    assert.equal(steps[0].min, band.min);
    assert.equal(steps[3].max, band.max);
    for (const [offset, step] of steps.entries()) {
      assert.equal(step.index, offset + 1);
      assert.equal(step.min, offset === 0 ? band.min : steps[offset - 1].max);
      assert.ok(Math.abs((step.max - step.min) - (band.max - band.min) / 4) < 1e-12);
      assert.equal(ratingSublevelFromNumeric(step.min).label, step.label);
      assert.equal(ratingSublevelFromNumeric(step.max - 0.00001).label, step.label);
    }
  }

  const dPlus = PLAYER_RATING_BANDS.find((band) => band.grade === "D+");
  assert.ok(dPlus);
  assert.deepEqual(ratingSublevelsForBand(dPlus).map(({label, min, max}) => [label, min, max]), [
    ["D+", 2, 2.25], ["D1+", 2.25, 2.5], ["D2+", 2.5, 2.75], ["D3+", 2.75, 3],
  ]);
  assert.equal(ratingSublevelFromNumeric(3.125).label, "C1");
  assert.equal(ratingSublevelFromNumeric(4.175).label, "B1");
  assert.equal(ratingSublevelFromNumeric(7).index, 4);
});

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
    gradeBefore: "D+",
    gradeAfter: "C+",
  });
  assert.equal(event.source.kind, "TOURNAMENT");
  assert.equal(event.source.eventId, event.source.tournamentId);
  assert.deepEqual(event.source.resultRef, { id: event.source.tournamentId, revision: event.source.sourceRevision });
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
    gradeBefore: "D+",
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

test("tournament compensation derives labels from the original numbers and preserves the original event", () => {
  const first = buildTournamentRatingEvent({
    tournamentId: "legacy-tournament",
    finishedAt: "2026-07-10T12:00:00.000Z",
    standing: { id: "p1", name: "P1", ratingBefore: 2.3, ratingDelta: 0.1, ratingAfter: 2.4 },
  });
  assert.ok(first);
  const oldEvent = { ...first, change: { ...first.change, gradeBefore: "D", gradeAfter: "D" } };
  const compensation = buildTournamentCompensationEvent({
    event: oldEvent,
    occurredAt: "2026-07-10T12:30:00.000Z",
    reason: "ANNULLED",
  });

  assert.deepEqual(compensation?.change, {
    before: 2.4, delta: -0.1, after: 2.3, gradeBefore: "D+", gradeAfter: "D+",
  });
  assert.equal(oldEvent.change.gradeAfter, "D");
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


test("CUP manual target resets any underlying clamp drift and later game deltas still apply", () => {
  const player = { key: "client:synthetic", clientId: "synthetic", name: "Synthetic", phoneNorm: null };
  const start = {
    _id: "synthetic-baseline", id: "synthetic-baseline", idempotencyKey: "synthetic-baseline",
    schemaVersion: 1, eventType: "RATING_INITIAL_ASSIGNED",
    occurredAt: "2026-11-19T00:00:00.000Z", createdAt: "2026-11-19T00:00:00.000Z",
    player, actor: {}, source: { domain: "ONBOARDING" },
    change: { before: null, delta: null, after: 7, gradeBefore: null, gradeAfter: "A" },
    formula: null, projectionIntent: { viva: "NONE_CUP_ONLY" },
  };
  const previousGame = { ...start, id: "first-game", eventType: "GAME_RESULT_SUBMITTED_APPLIED",
    occurredAt: "2026-11-19T00:00:01.000Z", change: { ...start.change, delta: 0.4 } };
  const manual = { ...start, id: "cup-change", eventType: "RATING_MANUALLY_CHANGED",
    occurredAt: "2026-11-19T00:00:02.000Z", source: { domain: "ADMIN_MANUAL", kind: "ADMIN_MANUAL" },
    change: { before: 7, delta: -1, after: 6, gradeBefore: "A", gradeAfter: "A" } };
  const laterGame = { ...previousGame, id: "later-game", occurredAt: "2026-11-19T00:00:03.000Z",
    change: { ...previousGame.change, delta: 0.1 } };
  assert.equal(replayPlayerRatingEvents([start, previousGame, manual])?.ratingNumeric, 6);
  assert.equal(replayPlayerRatingEvents([laterGame, manual, previousGame, start])?.ratingNumeric, 6.1);
  assert.equal(replayPlayerRatingEvents([start, previousGame, { ...manual, source: { domain: "CUP_ADMIN" } }])?.ratingNumeric, 6.4);
});

test("CUP letter alignment records the event without replacing a numeric result", () => {
  const baseline = buildGameResultBaselineEvent({
    resultId: "baseline", occurredAt: "2026-11-23T00:00:00.000Z",
    player: { id: "synthetic" }, ratingNumeric: 2.1,
  });
  assert.ok(baseline);
  const lateResult = {
    ...baseline, id: "late-result", eventType: "GAME_RESULT_SUBMITTED_APPLIED",
    occurredAt: "2026-11-23T01:00:00.000Z",
    change: { before: 2.1, delta: 0.1, after: 2.2, gradeBefore: "D", gradeAfter: "D" },
  };
  const alignment = {
    ...lateResult, id: "alignment", eventType: "RATING_MANUALLY_CHANGED",
    occurredAt: "2026-11-23T02:00:00.000Z",
    source: { kind: "ADMIN_MANUAL", expectedLastEventId: baseline.id,
      gradeAlignment: { previousGrade: "D", previousEventId: baseline.id, clientId: "synthetic" } },
    change: { before: 2.1, delta: 0, after: 2.1, gradeBefore: "D", gradeAfter: "D+" },
  };
  const replay = replayPlayerRatingEvents([alignment, baseline, lateResult]);
  assert.equal(replay?.ratingNumeric, 2.2);
  assert.equal(replay?.rating, "D+");
  assert.equal(replay?.lastEventId, alignment.id);
});
