import test from "node:test";
import assert from "node:assert/strict";
import { replayFprRatingTargets, planFprRatingReconciliation } from "../../src/services/player-rating/fprRatingReplay.ts";
import { replayPlayerRatingEvents, type PlayerRatingEventDocument } from "../../src/services/player-rating/ledger.ts";
const at = (n: number) => new Date(Date.UTC(2026, 10, 1, 10, n)).toISOString();
const event = (id: string, minute: number, type: string, domain: string, before: number | null, after: number, source = {}) => ({
  _id: id, id, idempotencyKey: id, schemaVersion: 1, occurredAt: at(minute), createdAt: at(minute), eventType: type,
  player: { key: "id:p", clientId: "p", phoneNorm: null, name: "Synthetic" }, actor: {}, source: { domain, ...source },
  change: { before, after, delta: before == null ? null : Number((after - before).toFixed(5)), gradeBefore: null, gradeAfter: null },
  formula: null, projectionIntent: { viva: "NONE" },
}) as PlayerRatingEventDocument;
const baseline = () => event("baseline", 0, "RATING_INITIAL_IMPORTED", "IMPORT", null, 2);
const award = () => event("fpr", 1, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 2, 2.1,
  { sourceId: "original", fprProtocolId: "protocol", fprFinishedAt: at(1) });

test("historical FPR and later game are retained without changing unrelated earlier history", () => {
  const replay = replayFprRatingTargets([baseline(), award(), event("game", 2, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2, 2.02)]);
  assert.equal(replay!.ratingNumeric, 2.12);
  assert.equal(replay!.frontierAt, new Date(Date.parse(at(2)) + 1).toISOString());
});
test("later ordinary target keeps its absolute level", () => {
  const later = event("ordinary", 3, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 2.02, 2.2);
  assert.equal(replayFprRatingTargets([baseline(), award(), later])!.ratingNumeric, 2.2);
});
test("manual start overrides and subsequent game deltas are preserved", () => {
  const manual = event("manual", 3, "TOURNAMENT_START_RATING_CHANGED", "TOURNAMENT_START", 2, 2.5);
  const game = event("game", 4, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2.5, 2.52);
  assert.equal(replayFprRatingTargets([baseline(), award(), manual, game])!.ratingNumeric, 2.52);
});
test("later real baselines reset prior history, generated FPR frontiers do not hide corrections", () => {
  const real = event("real", 3, "RATING_TOURNAMENT_CANONICAL_RECONCILED", "REPAIR", null, 3);
  assert.equal(replayFprRatingTargets([baseline(), award(), real])!.ratingNumeric, 3);
  const generated = event("generated", 4, "RATING_TOURNAMENT_CANONICAL_RECONCILED", "FPR_RECONCILIATION", null, 2.1, { fprReconciliation: true });
  const reverted = { ...award(), id: "revert", source: { ...award().source, compensatesEventId: "fpr" }, change: { ...award().change, delta: -0.1 } };
  const corrected = event("corrected", 1, "TOURNAMENT_RATING_CORRECTION_APPLIED", "TOURNAMENT", 2, 2.05,
    { sourceId: "original", fprProtocolId: "protocol", fprFinishedAt: at(1), supersedesEventId: "fpr" });
  assert.equal(replayFprRatingTargets([baseline(), award(), generated, reverted, corrected])!.ratingNumeric, 2.05);
});
test("game-result bootstrap is valid and applyToState=false events are ignored", () => {
  const imported = { ...baseline(), eventType: "RATING_BOOTSTRAPPED_FROM_GAME_RESULT" };
  const ignored = event("ignored", 2, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 2, 7, { applyToState: false });
  assert.equal(replayFprRatingTargets([imported, award(), ignored])!.ratingNumeric, 2.1);
});
test("reopening removes its FPR award, retaining later games", () => {
  const reverted = { ...award(), id: "revert", source: { ...award().source, compensatesEventId: "fpr" } };
  const game = event("game", 2, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2, 2.02);
  assert.equal(replayFprRatingTargets([baseline(), award(), reverted, game])!.ratingNumeric, 2.02);
});
test("missing baseline and invalid times fail closed; ordinary-only histories are untouched", () => {
  assert.equal(replayFprRatingTargets([baseline()]), null);
  assert.throws(() => replayFprRatingTargets([award()]), /BASELINE_MISSING/);
  assert.throws(() => replayFprRatingTargets([baseline(), { ...award(), source: { ...award().source, fprFinishedAt: "invalid" } }]), /INVALID_TIME/);
});
test("additive adjustment preserves an unseen concurrent game and is idempotent", () => {
  const history = [baseline(), award(), event("ordinary", 3, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 2.02, 2.2)];
  const planned = planFprRatingReconciliation(history)!;
  assert.equal(planned.delta, -0.08);
  const adjustment = event("adjustment", 5, "FPR_CANONICAL_RECONCILIATION_APPLIED", "FPR_RECONCILIATION", planned.before, planned.after,
    { fprReconciliation: true });
  adjustment.change.delta = planned.delta;
  const concurrent = event("concurrent-game", 4, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2.2, 2.22);
  const result = [...history, concurrent, adjustment];
  assert.equal(replayPlayerRatingEvents(result)!.ratingNumeric, 2.22);
  assert.equal(replayFprRatingTargets(result)!.ratingNumeric, 2.22);
  assert.equal(planFprRatingReconciliation(result), null);
});
test("reconciliation accounts for a clamped raw ledger, rather than leaving latent excess", () => {
  const initial = event("baseline", 0, "RATING_INITIAL_IMPORTED", "IMPORT", null, 7);
  const fpr = event("fpr", 1, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 7, 6.8,
    { sourceId: "original", fprProtocolId: "protocol", fprFinishedAt: at(1) });
  const game = event("game", 2, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 7, 7.3);
  const reset = event("manual", 3, "TOURNAMENT_START_RATING_CHANGED", "TOURNAMENT_START", 7, 6.9);
  const history = [initial, fpr, game, reset];
  const planned = planFprRatingReconciliation(history)!;
  const adjustment = event("adjustment", 4, "FPR_CANONICAL_RECONCILIATION_APPLIED", "FPR_RECONCILIATION", planned.before, planned.after,
    { fprReconciliation: true });
  adjustment.change.delta = planned.delta;
  assert.equal(replayPlayerRatingEvents([...history, adjustment])!.ratingNumeric, 6.9);
});
test("a later game compensation remains after an intervening absolute target", () => {
  const game = event("game", 2, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2.1, 2.12);
  const ordinary = event("ordinary", 3, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 2.12, 2.5);
  const reverted = event("game-revert", 4, "GAME_RESULT_REVERTED", "GAME_RESULT", 2.12, 2.1, { compensatesEventId: "game" });
  assert.equal(replayFprRatingTargets([baseline(), award(), game, ordinary, reverted])!.ratingNumeric, 2.48);
});
test("equal clamped levels still reconcile different raw balances for future games", () => {
  const initial = event("baseline", 0, "RATING_INITIAL_IMPORTED", "IMPORT", null, 1);
  const fpr = event("fpr", 1, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 1, 1.1,
    { sourceId: "original", fprProtocolId: "protocol", fprFinishedAt: at(1) });
  const ordinary = event("ordinary", 2, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 1.3, 1);
  const history = [initial, fpr, ordinary];
  const planned = planFprRatingReconciliation(history)!;
  assert.equal(planned.before, 1);
  assert.equal(planned.after, 1);
  const adjustment = event("adjustment", 3, "FPR_CANONICAL_RECONCILIATION_APPLIED", "FPR_RECONCILIATION", 1, 1, { fprReconciliation: true });
  adjustment.change.delta = planned.delta;
  const future = event("future", 4, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 1, 1.1);
  assert.equal(replayPlayerRatingEvents([...history, adjustment, future])!.ratingNumeric, 1.1);
  assert.equal(planFprRatingReconciliation([...history, adjustment, future]), null);
});
test("reopening preserves raw debt accumulated before the first FPR", () => {
  const debt = event("debt", 0.5, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 2, 0.6);
  const fpr = event("fpr", 1, "TOURNAMENT_RATING_FINALIZED", "TOURNAMENT", 1, 1.1,
    { sourceId: "original", fprProtocolId: "protocol", fprFinishedAt: at(1) });
  const revert = event("revert", 2, "TOURNAMENT_RATING_REVERTED", "TOURNAMENT", 1.1, 1,
    { ...fpr.source, compensatesEventId: "fpr" });
  const future = event("future", 3, "GAME_RESULT_SUBMITTED_APPLIED", "GAME_RESULT", 1, 1.2);
  assert.equal(replayFprRatingTargets([baseline(), debt, fpr, revert, future])!.ratingNumeric, 1);
  assert.equal(planFprRatingReconciliation([baseline(), debt, fpr, revert, future]), null);
});

test('verified equal-time order wins over IDs and survives compensation/correction lineage', () => {
  const first=event('z-earlier',1,'TOURNAMENT_RATING_FINALIZED','TOURNAMENT',2,2.5,
    {sourceId:'earlier',fprProtocolId:'earlier-protocol',fprFinishedAt:at(1)});
  const last=event('a-later',1,'TOURNAMENT_RATING_CORRECTION_APPLIED','TOURNAMENT',2.5,2.3,
    {sourceId:'later',fprProtocolId:'later-protocol',fprFinishedAt:at(1),fprOrderedAfterSourceIds:['earlier']});
  assert.equal(replayFprRatingTargets([baseline(),first,last])!.ratingNumeric,2.3);
  const game=event('game',2,'GAME_RESULT_SUBMITTED_APPLIED','GAME_RESULT',2.3,2.32);
  assert.equal(replayFprRatingTargets([baseline(),last,game,first])!.ratingNumeric,2.32);
  const cycle={...first,source:{...first.source,fprOrderedAfterSourceIds:['later']}};
  assert.throws(()=>replayFprRatingTargets([baseline(),last,cycle]),/ORDER_CYCLE/);
  const mixed=event('mixed',1,'GAME_RESULT_SUBMITTED_APPLIED','GAME_RESULT',2,2.1);
  assert.throws(()=>replayFprRatingTargets([baseline(),first,last,mixed]),/ORDER_MIXED/);
});
