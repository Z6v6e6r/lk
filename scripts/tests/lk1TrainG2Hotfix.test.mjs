// G2 of the 2026-10-05 LK1 train (server 147): the reviewed content stacked on G1's postimage —
// the evaluator (club court-hourly co-pay + Patriots money validity) in both the booking and the
// preview evaluator, and the preview router recomposed over G1's allowance block.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  LK1_TRAIN_G1_POSTIMAGE_SHA256,
  composeLk1TrainG1Artifacts,
} from "../patch_live_lk1_train_g1_20261005.mjs";
import {
  LK1_TRAIN_G2_POSTIMAGE_SHA256,
  LK1_TRAIN_G2_TARGET,
  buildLk1TrainG2Report,
  composeLk1TrainG2Artifacts,
  sha256,
} from "../patch_live_lk1_train_g2_20261005.mjs";

const UPSTREAM_FLOW = process.env.LK1_TRAIN_147_UPSTREAM_FLOW
  ?? "/private/tmp/lk1-train-147-prep/input/source.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `live 147 snapshot is absent: ${UPSTREAM_FLOW} (pull it read-only with `
    + "npm run nodered:modular:pull-147, or set LK1_TRAIN_147_UPSTREAM_FLOW)";

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const g1Bytes = () => composeLk1TrainG1Artifacts(fs.readFileSync(UPSTREAM_FLOW)).candidateBytes;

test("G2 composes on G1's postimage with exactly the three declared content nodes", { skip: snapshotSkip }, () => {
  const built = composeLk1TrainG2Artifacts(g1Bytes());
  assert.equal(built.sourceSha256, LK1_TRAIN_G1_POSTIMAGE_SHA256);
  assert.equal(built.candidateSha256, LK1_TRAIN_G2_POSTIMAGE_SHA256);
  assert.equal(built.flow.length, 4815);
  assert.deepEqual(built.changes.map((row) => [row.id, row.fields.join(",")]), [
    ["lk_subscription_managed_policy_20260820", "func"],
    ["lk_subscription_price_preview_20260908_evaluate", "func"],
    ["lk_subscription_price_preview_20260908_router", "func"],
  ]);
  assert.equal(built.changes[0].func.afterSha256, LK1_TRAIN_G2_TARGET.patchedEvaluatorFuncSha256);
  assert.equal(built.changes[1].func.afterSha256, LK1_TRAIN_G2_TARGET.patchedPreviewEvaluateFuncSha256);
  assert.equal(built.changes[2].func.afterSha256, LK1_TRAIN_G2_TARGET.patchedPreviewRouterFuncSha256);
  assert.equal(built.contract.allowedChanges.length, 3);
  assert.deepEqual(built.contract.allowedChanges.map((row) => row.fields), [["func"], ["func"], ["func"]]);
  assert.equal(built.contract.allowedAdditions.length, 0);
  // Every unchanged node stays byte-identical: the contract proves it.
  assert.equal(built.contract.candidateNodeCount, built.contract.sourceNodeCount);
});

test("G2 embeds the reviewed court-hourly and Patriots evaluator in both event paths", { skip: snapshotSkip }, () => {
  const built = composeLk1TrainG2Artifacts(g1Bytes());
  for (const id of ["lk_subscription_managed_policy_20260820",
    "lk_subscription_price_preview_20260908_evaluate"]) {
    const node = built.flow.find((row) => row.id === id);
    assert.ok(occurrences(node.func, "COURT_HOURLY_COPAY") >= 1, id);
    assert.ok(node.func.includes("LK1_COURT_PRICE_UNRESOLVED"), id);
    assert.ok(node.func.includes("PATRIOTS_FRIENDSHIP_PRODUCT_ID"), id);
    assert.ok(node.func.includes("isTopokratyTrainingBenefit"), id);
    assert.ok(node.func.includes("isTopokratyGameBenefit"), id);
  }
  // The three cases the acceptance quotes depend on: 2 h -> one paid hour, 3 h -> two, and the
  // club game. The reviewed constants are pinned by the evaluator source, not by this test.
  const evaluator = built.flow.find((row) => row.id === "lk_subscription_managed_policy_20260820").func;
  assert.ok(evaluator.includes("const TOPOKRATY_COURT_HOUR_PAY_DIVISOR = 4;"));
  assert.ok(evaluator.includes("const TOPOKRATY_GAME_FREE_VISIT_MINUTES = 90;"));
  assert.ok(evaluator.includes("const TOPOKRATY_TRAINING_DIRECTION_IDS = [6233];"));
  assert.ok(evaluator.includes("const TOPOKRATY_GAME_DIRECTION_IDS = [6180];"));
});

test("G2 recomposes the preview router over G1's allowance block and keeps the exclusion", { skip: snapshotSkip }, () => {
  const built = composeLk1TrainG2Artifacts(g1Bytes());
  const router = built.flow.find((row) => row.id === "lk_subscription_price_preview_20260908_router").func;
  assert.equal(occurrences(router, "function isTopokratyExercise(value) {"), 1);
  assert.equal(occurrences(router, "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE"), 1);
  assert.equal(occurrences(router, "isTopokratyClubPack(topokratyClubRow)"), 1);
  assert.equal(occurrences(router, "if (ctx.step === 'courtWindow') {"), 1);
  assert.equal(occurrences(router, "COURT_HOURLY_COPAY"), 1);
  assert.ok(router.includes("canonical.isProTrainingExercise"));
  assert.ok(router.includes("canonical.resolveLk1Rule"));
  // The preview embeds G1's booking allowance block byte-for-byte (the composer refuses otherwise).
  const gateway = built.flow.find((row) => row.id === "lk_subscription_booking_router_20260804").func;
  const start = 'if (ctx.step === "lk1_usage_operations") {';
  const end = 'if (ctx.step === "lk1_policy_decision") {';
  const gatewayUsage = gateway.slice(gateway.indexOf(start), gateway.indexOf(end));
  assert.equal(sha256(gatewayUsage), LK1_TRAIN_G2_TARGET.usageBlockSha256);
  assert.ok(router.includes("COURT_HOURLY_COPAY"));
});

test("G2 fails closed on a preimage that is not G1's postimage", { skip: snapshotSkip }, () => {
  const raw = fs.readFileSync(UPSTREAM_FLOW);
  assert.throws(() => composeLk1TrainG2Artifacts(raw), /G1 postimage drift/);
  const g1 = g1Bytes();
  const drifted = Buffer.from(`${g1.toString("utf8").trimEnd()} \n`);
  assert.throws(() => composeLk1TrainG2Artifacts(drifted), /G1 postimage drift/);
});

test("the G2 report shape declares the three content nodes and no policy activation", { skip: snapshotSkip }, () => {
  const built = composeLk1TrainG2Artifacts(g1Bytes());
  const report = buildLk1TrainG2Report({ sourceSha256: LK1_TRAIN_G1_POSTIMAGE_SHA256,
    sourceNodeCount: built.flow.length, built });
  assert.equal(report.expectedChangedNodeCount, 3);
  assert.equal(report.changedNodeCount, 3);
  assert.equal(report.addedNodeCount, 0);
  assert.equal(report.planRulesActivation, null);
  assert.equal(report.upstreamFlowSha256, LK1_TRAIN_G1_POSTIMAGE_SHA256);
  assert.equal(report.candidateSha256, LK1_TRAIN_G2_POSTIMAGE_SHA256);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.liveMutationPerformed, false);
});
