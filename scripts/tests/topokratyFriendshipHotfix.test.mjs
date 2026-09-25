// The LK1 «Дружба Топократы» focused generation: the reviewed delivery vehicle for the owner
// decision of 2026-09-26, stacked on the installed plan-rules generation. The hermetic half
// drives the reviewed deltas on synthetic bodies; the snapshot half proves the candidate against
// the exact live flow copied by the operator (skipped when that private flow is absent).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  TOPOKRATY_GATEWAY_ID,
  TOPOKRATY_EVALUATOR_ID,
  TOPOKRATY_PREVIEW_ID,
  TOPOKRATY_TARGET,
  TOPOKRATY_PATCH_MARKER,
  TOPOKRATY_UPSTREAM_SHA256,
  TOPOKRATY_REVERT_UPSTREAM_SHA256,
  buildTopokratyReport,
  composeTopokratyArtifacts,
  composeTopokratyRevertArtifacts,
  patchTopokratyEvaluatorBody,
  patchTopokratyGatewayBody,
  patchTopokratyGatewayInitialize,
  sha256,
} from "../patch_live_lk1_topokraty_friendship_hotfix.mjs";
import {
  LK1_PLAN_RULES_DESIRED,
  LK1_PLAN_RULES_WITH_TOPOKRATY,
  buildPlanRulesTransition,
} from "../lib/lk1PlanRulesTransition.mjs";

const UPSTREAM_FLOW = process.env.LK1_TOPOKRATY_FRIENDSHIP_UPSTREAM_FLOW
  ?? "/private/tmp/padlhub-topokraty-apply-20260925/input/source.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `live flow is absent: ${UPSTREAM_FLOW} (pull it with npm run nodered:modular:pull-147, `
    + "or set LK1_TOPOKRATY_FRIENDSHIP_UPSTREAM_FLOW)";

const EVALUATOR_BRANCH_OPEN =
  'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n'
  + "  return (() => {\n";
const EVALUATOR_BRANCH_CLOSE = "\n})();\n}";

/** A body carrying exactly the four reviewed anchors, so the deltas can be driven hermetically. */
const syntheticGatewayBody = () => `const isObj = value => value;
const lk1Quote = (ctx, exercise, owned) => {
  const target = {
    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),
    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),
  };
  if (ctx.caller === "http") {
    const target = ctx.lk1.target;
    if ((expectedGroup !== undefined && expectedTournament !== undefined)
      || expected.discountPercent !== ctx.lk1.rule[route.discountField]
      || expected.durationMinutes !== target.durationMinutes) {
      return null;
    }
  }
};
`;

const syntheticGatewayTarget = (body) => ({
  ...TOPOKRATY_TARGET,
  liveFuncSha256: sha256(body),
});

/** The installed plan-rules writer block, exactly what the previous generation shipped. */
const installedPlanRulesBlock = () => buildPlanRulesTransition({
  expectedPrior: null,
  desired: LK1_PLAN_RULES_DESIRED,
}).initialize;

const syntheticInitialize = () => `const lk1PolicyKey = "subscriptions_lk1_product_policy";
const lk1PolicyExpectedPrior = null;
${installedPlanRulesBlock()}const lk1StationExclusionsKey = "subscriptions_lk1_station_exclusions";
const lk1DesiredStationExclusions = {"formatVersion":1,"exclusions":[]};
`;

test("the club direction, the decision percent and the target field enter the gateway exactly once", () => {
  const body = syntheticGatewayBody();
  const patched = patchTopokratyGatewayBody(body, syntheticGatewayTarget(body));

  assert.equal(patched.split("const exerciseDirectionId = (exercise) => {").length - 1, 1,
    "the reviewed direction helper is embedded once");
  assert.equal(patched.split("const lk1ExpectedEventDiscountPercent = (decision, route) => (").length - 1, 1,
    "the decision percent helper is embedded once");
  assert.equal(patched.split(TOPOKRATY_PATCH_MARKER).length - 1, 2,
    "the helper declaration and the comparison each name the decision percent once");
  assert.ok(patched.includes("    directionId: exerciseDirectionId(exercise),\n"),
    "the server-resolved target carries the direction");
  assert.ok(patched.includes("expected.discountPercent !== lk1ExpectedEventDiscountPercent(decision, route)"),
    "the client quote is compared against the decision percent");
  assert.ok(!patched.includes("expected.discountPercent !== ctx.lk1.rule[route.discountField]"),
    "the configured-field comparison is replaced, not duplicated");
  // The helper is declared before the quote function that reads it.
  assert.ok(patched.indexOf("const exerciseDirectionId = (exercise) => {")
    < patched.indexOf("const lk1Quote = (ctx, exercise, owned) => {"));
  new Function("msg", "node", "env", "global", patched);

  // Never a second application.
  assert.throws(() => patchTopokratyGatewayBody(patched, syntheticGatewayTarget(patched)),
    /already carries the club decision percent/);
});

test("the gateway generation refuses a body that is not the reviewed installed postimage", () => {
  const body = syntheticGatewayBody();
  assert.throws(() => patchTopokratyGatewayBody(body), /installed preimage drift/);

  const directionAnchorRemoved = body.replace("const lk1Quote = (ctx, exercise, owned) => {", "");
  assert.throws(() => patchTopokratyGatewayBody(directionAnchorRemoved, syntheticGatewayTarget(directionAnchorRemoved)),
    /anchor drift for direction-helper/);

  const targetDoubled = body.replace(
    "    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),\n"
    + "    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),\n",
    "    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),\n"
    + "    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),\n"
    + "    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),\n"
    + "    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),\n");
  assert.throws(() => patchTopokratyGatewayBody(targetDoubled, syntheticGatewayTarget(targetDoubled)),
    /anchor drift for target-direction/);
});

test("the plan-rules writer is replaced, not appended: 7 installed rules become 8", () => {
  const initialize = syntheticInitialize();
  const patched = patchTopokratyGatewayInitialize(initialize,
    { ...TOPOKRATY_TARGET, liveInitializeSha256: sha256(initialize) });

  assert.equal(patched.split('const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";').length - 1, 1,
    "the writer exists exactly once after the replacement");
  assert.equal(patched.split('"planKey":"topocraty"').length - 1, 1, "the club rule enters once");
  assert.ok(!patched.includes("const lk1PlanRulesExpectedPrior = null;"),
    "the installed payload becomes the exact prior instead of null");
  const desiredIndex = patched.indexOf("const lk1DesiredPlanRules = ");
  const desired = JSON.parse(patched.slice(desiredIndex + "const lk1DesiredPlanRules = ".length).split(";\n")[0]);
  assert.deepEqual(desired, LK1_PLAN_RULES_WITH_TOPOKRATY, "the desired payload is the club payload");
  assert.equal(desired.rules.length, LK1_PLAN_RULES_DESIRED.rules.length + 1);
  assert.ok(patched.includes("const lk1StationExclusionsKey"), "the following writer stays in place");
  new Function("global", "env", "node", "flow", patched);

  // Never a second application, and never on a foreign payload.
  assert.throws(() => patchTopokratyGatewayInitialize(patched,
    { ...TOPOKRATY_TARGET, liveInitializeSha256: sha256(patched) }), /already carries the club plan rule/);
  const foreign = syntheticInitialize().replace('"planKey":"friendship"', '"planKey":"foreign"');
  assert.throws(() => patchTopokratyGatewayInitialize(foreign,
    { ...TOPOKRATY_TARGET, liveInitializeSha256: sha256(foreign) }),
  /installed plan-rules payload is not the reviewed prior|installed preimage drift/);
});

test("the evaluator generation swaps the embedded LK1 copy for the reviewed club body", async () => {
  const { reviewedEvaluatorBody } = await import("../patch_live_lk1_plan_rules.mjs");
  const reviewed = reviewedEvaluatorBody();
  const embedded = "const lk1Old = true;\n";
  const source = `const head = 1;\n${EVALUATOR_BRANCH_OPEN}${embedded}${EVALUATOR_BRANCH_CLOSE}\nconst tail = 2;\n`;
  const patched = patchTopokratyEvaluatorBody(source, {
    ...TOPOKRATY_TARGET,
    liveEvaluatorFuncSha256: sha256(source),
    liveEmbeddedSha256: sha256(embedded),
  });
  assert.ok(patched.includes(reviewed), "the reviewed evaluator body is embedded");
  assert.ok(!patched.includes(embedded), "the previous embedded copy is gone");
  assert.ok(patched.includes("isTopokratyTrainingBenefit"), "the club branch is present");
  assert.ok(patched.startsWith("const head = 1;\n") && patched.endsWith("const tail = 2;\n"),
    "the surrounding branch envelope stays untouched");
  new Function("msg", "node", "env", "global", patched);

  assert.throws(() => patchTopokratyEvaluatorBody(patched, {
    ...TOPOKRATY_TARGET, liveEvaluatorFuncSha256: sha256(patched),
  }), /already embedded|installed preimage drift/);
});

test("the generation composes the live flow into exactly three changed nodes", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  assert.equal(sha256(bytes), TOPOKRATY_UPSTREAM_SHA256, "the upstream flow must be the reviewed pull");
  const composed = composeTopokratyArtifacts(bytes);
  assert.equal(composed.candidateSha256,
    "d39a14893e18e8c48000dc8e844f3d1725f3793068c95f85529d549577d80311",
    "the candidate is the reviewed one");
  assert.equal(composed.changes.length, 3);
  assert.deepEqual(composed.changes.map((change) => change.id).sort(),
    [TOPOKRATY_GATEWAY_ID, TOPOKRATY_EVALUATOR_ID, TOPOKRATY_PREVIEW_ID].sort());
  const gateway = composed.changes.find((change) => change.id === TOPOKRATY_GATEWAY_ID);
  assert.deepEqual(gateway.fields, ["func", "initialize"]);
  assert.equal(composed.addedNodeCount, 0);
  assert.equal(composed.flow.length, 4804);
  const report = buildTopokratyReport({ sourceSha256: composed.sourceSha256, sourceNodeCount: 4804, built: composed });
  assert.equal(report.changedNodeCount, 3);
  assert.equal(report.expectedChangedNodeCount, 3);
  assert.equal(report.planRulesActivation.expectedPriorRuleCount, 7);
  assert.equal(report.planRulesActivation.desiredRuleCount, 8);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.liveMutationPerformed, false);

  // The ordered rollback step restores the installed payload from the club prior.
  const revert = composeTopokratyRevertArtifacts(composed.candidateBytes);
  assert.equal(revert.sourceSha256, TOPOKRATY_REVERT_UPSTREAM_SHA256);
  assert.equal(revert.changes.length, 1);
  assert.deepEqual(revert.changes[0].fields, ["initialize"]);
});
