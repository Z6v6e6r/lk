import test from "node:test";
import assert from "node:assert/strict";
import { readFprLevelResults, fprLevelExcludedPlayerIds, formatFprLevel, type FprLevelResults } from "../../src/services/player-rating/fprLevelResults.ts";
import { ratingFixture } from "./helpers/fprRatingFixture.ts";
const state = ratingFixture(4, 6);
const snapshot = (): FprLevelResults => ({ version: 1, protocolId: state.tournamentId, protocolRevision: state.revision,
  sourceEventId: state.communityRating!.sourceExerciseId!, calculatedAt: "2026-11-05T12:00:00Z", rootExcludedPlayerIds: [],
  rows: state.players.map((p, i) => ({ id: p.id, status: "applied", before: 2,
    after: i === 0 ? 2 : i === 1 ? 2.00001 : 1.99999, delta: i === 0 ? 0 : i === 1 ? 0.00001 : -0.00001 })) });
test("exact historical event snapshot retains zero and tiny positive/negative changes without current levels", () => {
  const value = snapshot();
  assert.deepEqual(readFprLevelResults(state, value), value);
  assert.equal(formatFprLevel(0, true), "0");
  assert.equal(formatFprLevel(-0, true), "0");
  assert.equal(formatFprLevel(0.00001, true), "+0,00001");
  assert.equal(formatFprLevel(-0.00001, true), "-0,00001");
  assert.equal(formatFprLevel(2.12345), "2,12345");
});
test("wrong event/revision, reopened/test protocols and absent snapshots never show stale levels", () => {
  for (const bad of [null, { ...snapshot(), protocolId: "foreign" }, { ...snapshot(), sourceEventId: "foreign" },
    { ...snapshot(), protocolRevision: state.revision - 1 }, { ...snapshot(), version: 2 }, { ...snapshot(), calculatedAt: "bad" }]) {
    assert.equal(readFprLevelResults(state, bad), null);
  }
  assert.equal(readFprLevelResults({ ...state, status: "in_progress", finishedAt: null }, snapshot()), null);
  assert.equal(readFprLevelResults({ ...state, testMode: true }, snapshot()), null);
});
test("invalid, duplicate, foreign and inconsistent numeric rows fail closed", () => {
  for (const changed of [ { id: "foreign" }, { before: 0 }, { after: 8 }, { delta: Infinity }, { after: NaN }, { delta: 1 }, { delta: "0" }, { status: "unknown" } ]) {
    const value = snapshot(); value.rows[0] = { ...value.rows[0], ...changed } as never;
    assert.equal(readFprLevelResults(state, value), null);
  }
  const duplicate = snapshot(); duplicate.rows[1] = duplicate.rows[0];
  assert.equal(readFprLevelResults(state, duplicate), null);
  assert.equal(readFprLevelResults(state, { ...snapshot(), rows: [] }), null);
});
test("root level exclusion invalidates an older award projection without revealing admin reasons", () => {
  const exclusion = [{ playerId: state.players[0].id, scopes: ["level"], auditId: "synthetic", reason: "private audit", recordedAt: "2026-11-05T12:00:00Z" }];
  const ids = fprLevelExcludedPlayerIds(state, exclusion)!;
  assert.deepEqual(ids, [state.players[0].id]);
  assert.equal(readFprLevelResults(state, snapshot(), ids), null);
  const value = snapshot(); value.rootExcludedPlayerIds = ids; value.rows[0] = { id: ids[0], status: "not_awarded" };
  assert.equal(readFprLevelResults(state, value, ids)?.rows[0].status, "not_awarded");
  assert.equal(JSON.stringify(readFprLevelResults(state, value, ids)).includes("private audit"), false);
  assert.equal(fprLevelExcludedPlayerIds(state, [{ ...exclusion[0], auditId: "" }]), null);
});
test("pending and explicitly not-awarded are distinct from an applied zero", () => {
  const value = snapshot(); value.rows[1] = { id: state.players[1].id, status: "pending" };
  value.rows[2] = { id: state.players[2].id, status: "not_awarded" };
  assert.deepEqual(readFprLevelResults(state, value)?.rows.map(r => r.status), ["applied", "pending", "not_awarded", "applied"]);
});

test("legacy root-only physical event binding is accepted, conflicting bindings are not", () => {
  const rootOnly = { ...state, communityRating: { ...state.communityRating!, sourceExerciseId: null } };
  const value = { ...snapshot(), sourceEventId: "root-only-physical" };
  assert.ok(readFprLevelResults(rootOnly, value, [], "root-only-physical"));
  assert.equal(readFprLevelResults(rootOnly, value), null);
  assert.equal(readFprLevelResults(state, snapshot(), [], "conflicting-physical"), null);
});
