/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildGameResultBaselineEvent,
  replayPlayerRatingEvents,
} from "../../src/services/player-rating/ledger.ts";
import {
  GameResultRatingError,
  buildGameResultRatingPlan,
  buildGameResultRevertPlan,
  calculateGameResultRating,
} from "../lib/gameResultRating.mjs";
import {
  GAME_RESULT_COLLECTIONS,
  GAME_RESULT_RATING_INDEXES,
  applyRatingImpactToGameRoster,
  buildGameResultJobClaimQuery,
  collectResultPlayers,
  processClaimedGameResultJob,
  shouldRetryGameResultJobFailure,
} from "../game_result_rating_worker.mjs";

function getPath(value: Record<string, any>, path: string) {
  return path.split(".").reduce((current: any, key) => current?.[key], value);
}

function setPath(value: Record<string, any>, path: string, next: unknown) {
  const parts = path.split(".");
  let current = value;
  parts.slice(0, -1).forEach((part) => {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part];
  });
  current[parts.at(-1) as string] = structuredClone(next);
}

function matchesFilter(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return (expected as Record<string, any>[]).some((item) => matchesFilter(doc, item));
    if (key === "$and") return (expected as Record<string, any>[]).every((item) => matchesFilter(doc, item));
    const actual = getPath(doc, key);
    if (expected && typeof expected === "object" && !Array.isArray(expected)) {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$lte" in expected) return actual <= expected.$lte;
      if ("$exists" in expected) return expected.$exists ? actual !== undefined : actual === undefined;
    }
    if (Array.isArray(actual)) return actual.includes(expected);
    return actual === expected;
  });
}

class MemoryCollection {
  docs: Record<string, any>[];

  constructor(docs: Record<string, any>[] = []) {
    this.docs = docs.map((doc) => structuredClone(doc));
  }

  find(filter: Record<string, any>) {
    const rows = this.docs.filter((doc) => matchesFilter(doc, filter));
    return { toArray: async () => rows.map((row) => structuredClone(row)) };
  }

  async findOne(filter: Record<string, any>) {
    const row = this.docs.find((doc) => matchesFilter(doc, filter));
    return row ? structuredClone(row) : null;
  }

  async updateOne(
    filter: Record<string, any>,
    update: Record<string, any>,
    options: { upsert?: boolean } = {},
  ) {
    let row = this.docs.find((doc) => matchesFilter(doc, filter));
    const inserted = !row && options.upsert === true;
    if (!row && inserted) {
      row = {};
      this.docs.push(row);
    }
    if (!row) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    if (inserted) {
      Object.entries(update.$setOnInsert || {}).forEach(([path, value]) => setPath(row!, path, value));
    }
    Object.entries(update.$set || {}).forEach(([path, value]) => setPath(row!, path, value));
    Object.entries(update.$inc || {}).forEach(([path, value]) => {
      setPath(row!, path, Number(getPath(row!, path) || 0) + Number(value));
    });
    return {
      matchedCount: inserted ? 0 : 1,
      modifiedCount: 1,
      upsertedCount: inserted ? 1 : 0,
    };
  }

  async bulkWrite(operations: Array<Record<string, any>>) {
    for (const operation of operations) {
      await this.updateOne(
        operation.updateOne.filter,
        operation.updateOne.update,
        { upsert: operation.updateOne.upsert },
      );
    }
    return { acknowledged: true };
  }
}

class MemoryDb {
  collections = new Map<string, MemoryCollection>();

  collection(name: string) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name) as MemoryCollection;
  }
}

function member(id: string, name: string) {
  return {
    memberKey: `id:${id}`,
    id,
    phoneNorm: `7900000000${id.slice(-1)}`,
    name,
  };
}

const players = [
  member("p1", "A1"),
  member("p2", "A2"),
  member("p3", "B1"),
  member("p4", "B2"),
];

function result(overrides: Record<string, unknown> = {}) {
  return {
    _id: "res-1",
    id: "res-1",
    gameId: "game-1",
    scoreRevision: 1,
    submittedBy: players[0],
    ratingFacts: {
      version: "game-result-rating-facts-v1",
      sets: [{ left: 6, right: 4 }, { left: 4, right: 6 }, { left: 7, right: 5 }],
      effectiveSetPairings: [
        { setIndex: 0, teamA: [players[0], players[1]], teamB: [players[2], players[3]] },
        { setIndex: 1, teamA: [players[0], players[2]], teamB: [players[1], players[3]] },
        { setIndex: 2, teamA: [players[0], players[1]], teamB: [players[2], players[3]] },
      ],
      params: { K: 0.3, D: 3, B: 0.3, minRating: 1, maxRating: 7, round: 5 },
    },
    ratingWork: {
      jobKey: "game-result:res-1:score:1:apply",
      generation: 1,
      applySemantics: "INITIAL_APPLY",
    },
    ...overrides,
  };
}

function ratingRows(values = [3.1, 3.2, 3.3, 3.4]) {
  return players.map((player, index) => ({
    _id: player.id,
    playerKey: `client:${player.id}`,
    clientId: player.id,
    phoneNorm: player.phoneNorm,
    name: player.name,
    ratingNumeric: values[index],
  }));
}

test("game result calculation handles per-set partner changes", () => {
  const calculation = calculateGameResultRating(result(), ratingRows());

  assert.equal(calculation.ratingImpact.length, 4);
  assert.equal(calculation.intermediateResults.length, 3);
  assert.equal(calculation.formula.ratingSource, "player_rating_state_at_worker");
  assert.equal(calculation.ratingImpact.find((item) => item.id === "p2")?.team, null);
  assert.equal(calculation.ratingImpact.every((item) => Number.isFinite(item.after)), true);
});

test("game result apply plan is deterministic and contains four immutable events", () => {
  const nowIso = "2026-07-31T12:00:00.000Z";
  const first = buildGameResultRatingPlan({ result: result(), ratingRows: ratingRows(), nowIso });
  const repeated = buildGameResultRatingPlan({ result: result(), ratingRows: ratingRows(), nowIso });

  assert.equal(first.compensationEvents.length, 0);
  assert.equal(first.applyEvents.length, 4);
  assert.deepEqual(first.eventIds, repeated.eventIds);
  assert.equal(new Set(first.eventIds).size, 4);
  assert.equal(first.applyEvents.every((event) => event.source.domain === "GAME_RESULT"), true);
});

test("correction-time plan compensates the old result and preserves later deltas", () => {
  const firstAt = "2026-07-31T10:00:00.000Z";
  const laterAt = "2026-07-31T11:00:00.000Z";
  const correctionAt = "2026-07-31T12:00:00.000Z";
  const firstPlan = buildGameResultRatingPlan({ result: result(), ratingRows: ratingRows(), nowIso: firstAt });
  const laterDeltas = new Map([
    ["p1", 0.05],
    ["p2", 0.04],
    ["p3", -0.05],
    ["p4", -0.04],
  ]);
  const currentRows = ratingRows().map((row) => {
    const firstImpact = firstPlan.ratingImpact.find((item) => item.id === row.clientId);
    return {
      ...row,
      ratingNumeric: Number(firstImpact?.after || row.ratingNumeric) + Number(laterDeltas.get(row.clientId) || 0),
    };
  });
  const correctedResult = result({
    _id: "res-2",
    id: "res-2",
    scoreRevision: 2,
    supersedesResultId: "res-1",
    lineageRootResultId: "res-1",
    ratingFacts: {
      ...(result().ratingFacts as Record<string, unknown>),
      sets: [{ left: 4, right: 6 }, { left: 6, right: 4 }, { left: 5, right: 7 }],
    },
    ratingWork: {
      jobKey: "game-result:res-2:score:2:apply",
      generation: 1,
      applySemantics: "CORRECTION_TIME",
    },
  });
  const correctionPlan = buildGameResultRatingPlan({
    result: correctedResult,
    ratingRows: currentRows,
    previousEvents: firstPlan.applyEvents,
    nowIso: correctionAt,
  });

  assert.equal(correctionPlan.compensationEvents.length, 4);
  assert.equal(correctionPlan.applyEvents.length, 4);
  assert.equal(correctionPlan.compensationEvents.every((event) => Boolean(event.source.compensatesEventId)), true);
  assert.equal(correctionPlan.applyEvents.every((event) => Boolean(event.source.supersedesEventId)), true);

  for (const player of players) {
    const initial = ratingRows().find((row) => row.clientId === player.id)?.ratingNumeric as number;
    const firstEvent = firstPlan.applyEvents.find((event) => event.player.clientId === player.id);
    const compensation = correctionPlan.compensationEvents.find((event) => event.player.clientId === player.id);
    const corrected = correctionPlan.applyEvents.find((event) => event.player.clientId === player.id);
    assert.ok(firstEvent && compensation && corrected);
    const baseline = buildGameResultBaselineEvent({
      resultId: "res-1",
      occurredAt: "2026-07-31T09:59:59.000Z",
      player,
      ratingNumeric: initial,
    });
    assert.ok(baseline);
    const laterDelta = Number(laterDeltas.get(player.id) || 0);
    const laterEvent = {
      ...firstEvent,
      _id: `later:${player.id}`,
      id: `later:${player.id}`,
      idempotencyKey: `later:${player.id}`,
      eventType: "GAME_RESULT_SUBMITTED_APPLIED",
      occurredAt: laterAt,
      source: { domain: "GAME_RESULT", resultId: "later-game" },
      change: {
        ...firstEvent.change,
        before: firstEvent.change.after,
        delta: laterDelta,
        after: Number(firstEvent.change.after) + laterDelta,
      },
    };
    const replay = replayPlayerRatingEvents([baseline, firstEvent, laterEvent, compensation, corrected]);
    const expected = Number((initial + laterDelta + Number(corrected.change.delta)).toFixed(5));
    assert.equal(replay?.ratingNumeric, expected);
  }
});

test("revert plan is deterministic and compensates an applied result exactly once", () => {
  const appliedAt = "2026-07-31T10:00:00.000Z";
  const revertedAt = "2026-07-31T12:00:00.000Z";
  const applyPlan = buildGameResultRatingPlan({ result: result(), ratingRows: ratingRows(), nowIso: appliedAt });
  const currentRows = ratingRows().map((row) => ({
    ...row,
    ratingNumeric: applyPlan.ratingImpact.find((item) => item.id === row.clientId)?.after,
  }));
  const first = buildGameResultRevertPlan({
    result: result(),
    ratingRows: currentRows,
    appliedEvents: applyPlan.applyEvents,
    nowIso: revertedAt,
  });
  const repeated = buildGameResultRevertPlan({
    result: result(),
    ratingRows: currentRows,
    appliedEvents: applyPlan.applyEvents,
    nowIso: revertedAt,
  });

  assert.equal(first.compensationEvents.length, 4);
  assert.deepEqual(first.eventIds, repeated.eventIds);
  assert.equal(new Set(first.eventIds).size, 4);
  for (const player of players) {
    const initial = ratingRows().find((row) => row.clientId === player.id)?.ratingNumeric as number;
    const baseline = buildGameResultBaselineEvent({
      resultId: "res-1",
      occurredAt: "2026-07-31T09:59:59.000Z",
      player,
      ratingNumeric: initial,
    });
    const applied = applyPlan.applyEvents.find((event) => event.player.clientId === player.id);
    const compensation = first.compensationEvents.find((event) => event.player.clientId === player.id);
    assert.ok(baseline && applied && compensation);
    assert.equal(replayPlayerRatingEvents([baseline, applied, compensation])?.ratingNumeric, initial);
  }
});

test("revert before apply is a successful no-op and corrected result can proceed", () => {
  const reverted = buildGameResultRevertPlan({
    result: result(),
    ratingRows: ratingRows(),
    appliedEvents: [],
    nowIso: "2026-07-31T12:00:00.000Z",
  });
  assert.equal(reverted.cancelledBeforeApply, true);
  assert.deepEqual(reverted.eventIds, []);

  const corrected = result({
    _id: "res-2",
    id: "res-2",
    scoreRevision: 2,
    supersedesResultId: "res-1",
    ratingWork: {
      jobKey: "game-result:res-2:score:2:apply",
      generation: 1,
      applySemantics: "CORRECTION_TIME",
    },
  });
  const correctedPlan = buildGameResultRatingPlan({
    result: corrected,
    ratingRows: ratingRows(),
    previousEvents: [],
    predecessorReverted: true,
    nowIso: "2026-07-31T12:01:00.000Z",
  });
  assert.equal(correctedPlan.predecessorAlreadyReverted, true);
  assert.equal(correctedPlan.compensationEvents.length, 0);
  assert.equal(correctedPlan.applyEvents.length, 4);
});

test("job claim query only selects due active v2 work", () => {
  const query = buildGameResultJobClaimQuery(Date.parse("2026-07-31T12:00:00.000Z"));

  assert.equal(query.resultModelVersion, 2);
  assert.equal(query["ratingWork.executionMode"], "ACTIVE");
  assert.deepEqual(query["ratingWork.desiredState"].$in, ["APPLIED", "REVERTED"]);
  assert.deepEqual(query["ratingWork.status"].$in, ["QUEUED", "RETRYABLE", "RUNNING", "PREPARED"]);
  assert.equal(GAME_RESULT_RATING_INDEXES.some((index) => index.options.name === "game_result_rating_work_due"), true);
  assert.equal(GAME_RESULT_RATING_INDEXES.some((index) => index.options.name === "rating_event_game_result_partition"), true);
});

test("scheduled wrapper isolates game-result worker failures from canonical rating runs", () => {
  const wrapperSource = fs.readFileSync(
    new URL("../run_rating_worker_147.mjs", import.meta.url),
    "utf8",
  );

  const gameResultRun = wrapperSource.indexOf("gameResults = runNode([");
  const isolatedFailure = wrapperSource.indexOf('reason: "GAME_RESULT_RATING_WORKER_FAILED"');
  const canonicalRun = wrapperSource.indexOf('path.join(rootDir, "scripts/rating_worker.mjs")');
  assert.ok(gameResultRun >= 0);
  assert.ok(isolatedFailure > gameResultRun);
  assert.ok(canonicalRun > isolatedFailure);
  assert.match(
    wrapperSource.slice(isolatedFailure, canonicalRun),
    /if \(!gameResultsOnly\)[\s\S]*continuing scheduled canonical rating run/,
  );
});

test("worker retries transient infrastructure errors but blocks permanent rating facts", () => {
  assert.equal(shouldRetryGameResultJobFailure(new Error("temporary mongo failure"), 1, 8), true);
  assert.equal(
    shouldRetryGameResultJobFailure(
      new GameResultRatingError("INVALID_RATING_FACTS", "invalid result"),
      1,
      8,
    ),
    false,
  );
  assert.equal(
    shouldRetryGameResultJobFailure(
      new GameResultRatingError("RATING_STATE_INCOMPLETE", "missing state", null, true),
      1,
      8,
    ),
    true,
  );
  assert.equal(shouldRetryGameResultJobFailure(new Error("still failing"), 8, 8), false);
});

test("result player collection and game roster projection are identity-safe", () => {
  assert.equal(collectResultPlayers(result()).length, 4);
  const projected = applyRatingImpactToGameRoster(
    players.map((player) => ({ id: player.id, phone: player.phoneNorm, ratingNumeric: 3 })),
    [{ id: "p1", phoneNorm: players[0].phoneNorm, after: 3.25, gradeAfter: "C" }],
  );

  assert.equal(projected[0].ratingNumeric, 3.25);
  assert.equal(projected[1].ratingNumeric, 3);
});

test("worker apply, crash retry, and dispute revert remain idempotent end to end", async () => {
  const db = new MemoryDb();
  const queuedResult = result({
    resultModelVersion: 2,
    ratingEnabled: true,
    status: "PENDING_REVIEW",
    lifecycleState: "PENDING_REVIEW",
    ratingEvent: { id: "rate-res-1", status: "PENDING_CONFIRMATION" },
    ratingWork: {
      executionMode: "ACTIVE",
      jobKey: "game-result:res-1:score:1:apply",
      generation: 1,
      desiredState: "APPLIED",
      status: "RUNNING",
      applySemantics: "INITIAL_APPLY",
      attempts: 1,
      leaseOwner: "worker-1",
    },
  });
  db.collections.set(GAME_RESULT_COLLECTIONS.results, new MemoryCollection([queuedResult]));
  db.collections.set("player_rating_state", new MemoryCollection(ratingRows()));
  db.collections.set(GAME_RESULT_COLLECTIONS.games, new MemoryCollection([{
    _id: "game-1",
    id: "game-1",
    participants: players,
    waitlist: [],
  }]));

  const first = await processClaimedGameResultJob(db as any, {
    result: structuredClone(queuedResult),
    owner: "worker-1",
    nowIso: "2026-07-31T12:00:00.000Z",
  });
  assert.equal(first.status, "APPLIED");
  assert.equal(db.collection("rating_events").docs.length, 8);
  const appliedRatings = db.collection("player_rating_state").docs
    .map((row) => row.ratingNumeric)
    .sort();

  const storedAfterApply = db.collection(GAME_RESULT_COLLECTIONS.results).docs[0];
  storedAfterApply.ratingWork.status = "RUNNING";
  storedAfterApply.ratingWork.leaseOwner = "worker-2";
  storedAfterApply.ratingWork.leaseUntil = null;
  storedAfterApply.ratingWork.leaseUntilTs = null;
  const repeated = await processClaimedGameResultJob(db as any, {
    result: structuredClone(storedAfterApply),
    owner: "worker-2",
    nowIso: "2026-07-31T12:01:00.000Z",
  });
  assert.equal(repeated.status, "APPLIED");
  assert.equal(db.collection("rating_events").docs.length, 8);
  assert.deepEqual(
    db.collection("player_rating_state").docs.map((row) => row.ratingNumeric).sort(),
    appliedRatings,
  );

  const storedForRevert = db.collection(GAME_RESULT_COLLECTIONS.results).docs[0];
  storedForRevert.ratingWork = {
    ...storedForRevert.ratingWork,
    generation: 2,
    desiredState: "REVERTED",
    status: "RUNNING",
    jobKey: "game-result:res-1:score:1:revert:2",
    preparedPlan: null,
    attempts: 1,
    leaseOwner: "worker-3",
  };
  const reverted = await processClaimedGameResultJob(db as any, {
    result: structuredClone(storedForRevert),
    owner: "worker-3",
    nowIso: "2026-07-31T12:02:00.000Z",
  });
  assert.equal(reverted.status, "REVERTED");
  assert.equal(db.collection("rating_events").docs.length, 12);
  assert.deepEqual(
    db.collection("player_rating_state").docs.map((row) => row.ratingNumeric).sort(),
    ratingRows().map((row) => row.ratingNumeric).sort(),
  );
  assert.equal(
    db.collection(GAME_RESULT_COLLECTIONS.results).docs[0].ratingWork.status,
    "REVERTED",
  );
});
