// G1 of the 2026-10-05 LK1 train (server 147): the focused generation that re-anchors the reviewed
// court-window proof, the #174 open_game club gate and the Patriots money-only guard on the live
// 4815-node body, and replaces the plan-rules writer with the `patriots` transition.
//
// The hermetic half drives the reviewed deltas on a synthetic body that carries exactly the live
// anchors; the snapshot half proves the candidate against the read-only 147 flow (skipped when that
// private snapshot is absent).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256,
  LK1_TRAIN_G1_POSTIMAGE_SHA256,
  LK1_TRAIN_G1_PREIMAGE_NODE_SHA256,
  LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256,
  LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256,
  LK1_TRAIN_G1_TARGET,
  LK1_TRAIN_G1_UPSTREAM_SHA256,
  buildLk1TrainG1Report,
  buildLk1TrainG1RevertReport,
  composeLk1TrainG1Artifacts,
  composeLk1TrainG1RevertArtifacts,
  patchLk1TrainG1GatewayBody,
  patchLk1TrainG1GatewayInitialize,
  sha256,
  usageBlockSha,
} from "../patch_live_lk1_train_g1_20261005.mjs";
import {
  LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS,
  LK1_PLAN_RULES_WITH_PATRIOTS,
  buildPatriotsPlanRulesTransition,
} from "../lib/lk1PlanRulesTransition.mjs";

const UPSTREAM_FLOW = process.env.LK1_TRAIN_147_UPSTREAM_FLOW
  ?? "/private/tmp/lk1-train-147-prep/input/source.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `live 147 snapshot is absent: ${UPSTREAM_FLOW} (pull it read-only with `
    + "npm run nodered:modular:pull-147, or set LK1_TRAIN_147_UPSTREAM_FLOW)";

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const LIVE_CLUB_GATE = `  // A Topokraty event is outside every non-club subscription. Viva scopes a sold plan to its
  // own directions and exercise types, so carrying «РА», «Академия» or «Дружба» to direction
  // 6180/6233 is refused by the provider with 400 BAD_REQUEST after the contour has already
  // promised the benefit. The club product «Дружба Топократы» keeps its own plan rule (the
  // quarter-of-court co-pay) and is therefore the only owned row allowed here; every other
  // attempt is refused before the write and the event stays bookable as a one-off.
  if (resolveCategory(exercise) === "group_training"
    && isTopokratyExercise(exercise)
    && !(selectedOwned.length === 1 && isTopokratyClubPack(selectedOwned[0]))) {
    return finishError(ctx, 409,
      "На тренировки Топократов общие подписки не действуют: доступна разовая оплата или клубная подписка «Дружба Топократы»", {
        code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
      });
  }
`;

const USAGE_GAME_MINUTES_BLOCK = `    const minutes = operation.lk1.decision.gameMinutes;
    if (minutes) {
      if (minutes.localDate !== ctx.serviceDate || !Number.isSafeInteger(minutes.freeMinutes)
        || minutes.freeMinutes < 0) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
      used += minutes.freeMinutes;
    }
`;

const USAGE_CLUB_FREE_ANCHOR =
  "          if (!Number.isSafeInteger(free) || free !== duration || free > ctx.lk1.rule.freeGameMinutesPerDay\n";

/** A body carrying exactly the live G1 anchors, so every delta can be driven hermetically. */
const syntheticGatewayBody = () => `const isObj = (value) => Boolean(value);
const finishError = (ctx, status, message, details) => ({ status, message, details });
const resolveCategory = (exercise) => exercise.category;
const isTopokratyExercise = (exercise) => exercise.club === true;
const isTopokratyClubPack = (row) => row.club === true;
const lk1Stop = (ctx, code) => ({ stopped: code });
const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>
  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);
const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {
  return null;
};
const lk1Quote = (ctx, exercise, owned) => {
  const target = { stationId: "s" };
  const proof = ctx.lk1TariffProof;
  target.basePriceMinor = proof.amountMinor;
  if (proof.kind === "EVENT_ONE_TIME") target.priceProductId = proof.productId;
};
if (ctx.step === "exercise") {
  const selectedOwned = [];
  const exercise = {};
  const productRule = { matched: true, legacy: false };
${LIVE_CLUB_GATE}  if (productRule.matched && !productRule.legacy) {
    const quote = { target: {} };
    const selectedRule = lk1Config(selectedOwned);
  const enforcedRule = selectedRule.matched && !selectedRule.legacy;
  let ruleConfigured = false;
  if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"
    && (selectedOwned.length === 0 || enforcedRule)) {
    return { readback: true };
  }
    if (!quote.legacy) {
      ctx.lk1 = quote;
      return { find: true };
    }
  }
}
if (ctx.step === "lk1_operation_find") {
  return { find: true };
}
if (ctx.step === "lk1_usage_operations") {
  for (const operation of []) {
${USAGE_GAME_MINUTES_BLOCK}  }
  for (const booking of []) {
    const decision = {};
    const free = 0;
    const duration = 0;
    const coveredId = null;
    if (coveredId) {
${USAGE_CLUB_FREE_ANCHOR}            || (operation.lk1.target?.durationMinutes !== undefined && operation.lk1.target.durationMinutes !== duration)) {
        return lk1Stop(ctx, "LK1_ALLOWANCE_BINDING_INVALID");
      }
    }
  }
}
if (ctx.step === "lk1_policy_decision") {
  return true;
}
`;

const syntheticTarget = (body) => ({ ...LK1_TRAIN_G1_TARGET, liveFuncSha256: sha256(body),
  patchedFuncSha256: "PENDING_COMPOSITION" });

const syntheticInitialize = (writer) => `const lk1PolicyKey = "subscriptions_lk1_product_policy";
${writer}const lk1StationExclusionsKey = "subscriptions_lk1_station_exclusions";
const lk1DesiredStationExclusions = {"formatVersion":1,"exclusions":[]};
`;

/** The installed nine-rule writer, exactly what the live 2026-10-05 initialize carries. */
const installedNineRuleWriter = () => {
  const transition = buildPatriotsPlanRulesTransition();
  // `buildPatriotsPlanRulesTransition().initialize` already carries the reviewed prior; the
  // installed writer is the same shape with the friendship-two-hours prior as its only accepted row.
  return transition.initialize.replace(JSON.stringify(LK1_PLAN_RULES_WITH_PATRIOTS),
    JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS));
};

test("G1 embeds the reviewed court window, gate, Patriots guard and allowance deltas exactly once", () => {
  const body = syntheticGatewayBody();
  assert.equal(body.includes("const lk1CourtMasterServices = Object.freeze({"), false);
  const patched = patchLk1TrainG1GatewayBody(body, syntheticTarget(body));
  for (const marker of [
    "const lk1CourtMasterServices = Object.freeze({",
    "return startLk1CourtWindowFetch(ctx);",
    'if (ctx.step === "lk1_court_window") {',
    "target.hourlyCourtPriceMinor = hourlyCourtPriceMinor;",
    '["group_training", "open_game"].includes(resolveCategory(exercise))',
    "const patriotsMoneyOnlyIdentity = ctx.caller === \"http\"",
    "operation.lk1.decision.courtMinutes",
    "const freeCeiling = clubFreeVisit ? duration : ctx.lk1.rule.freeGameMinutesPerDay;",
  ]) {
    assert.equal(occurrences(patched, marker), 1, marker);
  }
  assert.equal(occurrences(patched, "LK1_COURT_PRICE_UNRESOLVED"), 5);
  // The reviewed continuation replaces the HUB `profile` re-entry with the focused `exercise` step.
  assert.ok(patched.includes('ctx.step = "exercise";\n  msg.payload = exercise;'));
  // The installed money mandate is untouched: the resolver declaration and its call site are
  // already in the live body and none is added.
  assert.equal(occurrences(patched, "const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>"), 1);
  assert.equal(occurrences(patched, "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {"), 1);
  // A second run refuses instead of producing a double delta.
  assert.throws(() => patchLk1TrainG1GatewayBody(patched, syntheticTarget(patched)),
    /already carries the courtHelpers delta/);
});

test("G1 refuses a body whose live anchors drifted", () => {
  const body = syntheticGatewayBody();
  assert.throws(() => patchLk1TrainG1GatewayBody(body, { ...syntheticTarget(body),
    liveFuncSha256: "0".repeat(64) }), /installed preimage drift/);
  const missingGate = body.replace(LIVE_CLUB_GATE, "  // gate removed\n");
  assert.throws(() => patchLk1TrainG1GatewayBody(missingGate, syntheticTarget(missingGate)),
    /anchor drift for club-gate: 0/);
  const missingUsage = body.replace(USAGE_GAME_MINUTES_BLOCK, "");
  assert.throws(() => patchLk1TrainG1GatewayBody(missingUsage, syntheticTarget(missingUsage)),
    /anchor drift for usage-court-minutes: 0/);
});

test("G1 replaces the plan-rules writer with the guarded Patriots transition and can revert it", () => {
  const installed = syntheticInitialize(installedNineRuleWriter());
  const target = { ...LK1_TRAIN_G1_TARGET, liveInitializeSha256: sha256(installed),
    patchedInitializeSha256: "PENDING_COMPOSITION" };
  const patched = patchLk1TrainG1GatewayInitialize(installed, target);
  assert.equal(occurrences(patched, '"planKey":"patriots"'), 1);
  assert.ok(patched.includes(JSON.stringify(LK1_PLAN_RULES_WITH_PATRIOTS)));
  assert.equal(occurrences(patched, '"planKey":"topocraty"'), 2);
  // A different installed payload is refused: the exact nine-rule prior is the only accepted input.
  const otherPrior = syntheticInitialize(installedNineRuleWriter()
    .replace(JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS), "null"));
  assert.throws(() => patchLk1TrainG1GatewayInitialize(otherPrior,
    { ...LK1_TRAIN_G1_TARGET, liveInitializeSha256: sha256(otherPrior) }),
  /not the reviewed nine-rule prior/);
  // A second run refuses.
  assert.throws(() => patchLk1TrainG1GatewayInitialize(patched,
    { ...LK1_TRAIN_G1_TARGET, liveInitializeSha256: sha256(patched),
      patchedInitializeSha256: "PENDING_COMPOSITION" }),
  /already carries the Patriots plan rule/);
});

test("the G1 report shape names the gateway fields, the node count and the policy change", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(UPSTREAM_FLOW, "utf8"));
  const gateway = flow.find((node) => node.id === "lk_subscription_booking_router_20260804");
  const before = { func: sha256(gateway.func), initialize: sha256(gateway.initialize) };
  const built = { flow, changes: [{ id: "lk_subscription_booking_router_20260804", fields: ["func", "initialize"],
    func: { beforeSha256: before.func, afterSha256: "a" }, initialize: { beforeSha256: before.initialize, afterSha256: "b" } }],
  candidateSha256: "c", gateway: {} };
  const report = buildLk1TrainG1Report({ sourceSha256: LK1_TRAIN_G1_UPSTREAM_SHA256,
    sourceNodeCount: flow.length, built });
  assert.equal(report.expectedChangedNodeCount, 1);
  assert.equal(report.changedNodeCount, 1);
  assert.equal(report.addedNodeCount, 0);
  assert.equal(report.planRulesActivation.expectedPriorRuleCount, 9);
  assert.equal(report.planRulesActivation.desiredRuleCount, 10);
  assert.equal(report.planRulesActivation.patriotsProductId, "37ab3713-4431-4815-96ba-d7ece76a9241");
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.liveMutationPerformed, false);
  const revert = buildLk1TrainG1RevertReport({ sourceSha256: LK1_TRAIN_G1_POSTIMAGE_SHA256,
    sourceNodeCount: flow.length, built: { flow,
      changes: [{ id: "lk_subscription_booking_router_20260804", fields: ["initialize"],
        initialize: { beforeSha256: "a", afterSha256: "b" } }],
      candidateSha256: "d" } });
  assert.equal(revert.mode, "revert");
  assert.equal(revert.planRulesActivation.orderedRollbackStep, 1);
  assert.equal(revert.planRulesActivation.desiredRuleCount, 9);
});

test("G1 composes against the read-only 147 snapshot with the pinned postimages", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  assert.equal(sha256(bytes), LK1_TRAIN_G1_UPSTREAM_SHA256);
  const built = composeLk1TrainG1Artifacts(bytes);
  assert.equal(built.candidateSha256, LK1_TRAIN_G1_POSTIMAGE_SHA256);
  assert.equal(built.changes.length, 1);
  assert.deepEqual(built.changes[0].fields, ["func", "initialize"]);
  assert.equal(built.changes[0].func.afterSha256, LK1_TRAIN_G1_TARGET.patchedFuncSha256);
  assert.equal(built.changes[0].initialize.afterSha256, LK1_TRAIN_G1_TARGET.patchedInitializeSha256);
  assert.equal(built.gateway.usageBlockBeforeSha256, "a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1");
  assert.equal(built.gateway.usageBlockSha256, "2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813");
  assert.equal(built.flow.length, 4815);
  // The plan-rules payload is the ten-rule Patriots set, and every nine-rule row survives.
  const gateway = built.flow.find((node) => node.id === "lk_subscription_booking_router_20260804");
  assert.ok(gateway.initialize.includes(JSON.stringify(LK1_PLAN_RULES_WITH_PATRIOTS)));
  assert.equal(occurrences(gateway.initialize, '"planKey":"friendship_two_hours"'), 2);
  assert.equal(occurrences(gateway.initialize, '"planKey":"topocraty"'), 2);
  assert.equal(occurrences(gateway.initialize, '"planKey":"patriots"'), 1);
  // The contract allows exactly the declared change and nothing else.
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal(built.contract.allowedChanges[0].id, "lk_subscription_booking_router_20260804");
  assert.deepEqual(built.contract.allowedChanges[0].fields, ["func", "initialize"]);
  assert.equal(built.contract.allowedChanges[0].sourceNodeSha256, LK1_TRAIN_G1_PREIMAGE_NODE_SHA256);
  assert.equal(built.contract.allowedChanges[0].candidateNodeSha256, LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256);
  assert.equal(built.contract.allowedAdditions.length, 0);
  // A drifted preimage refuses before any other guard runs.
  const drifted = Buffer.from(`${bytes.toString("utf8").trimEnd()} \n`);
  assert.throws(() => composeLk1TrainG1Artifacts(drifted), /Live flow preimage drift/);
});

test("the G1 ordered rollback restores the installed nine-rule payload on the pinned postimage",
  { skip: snapshotSkip }, () => {
    const bytes = fs.readFileSync(UPSTREAM_FLOW);
    const applied = composeLk1TrainG1Artifacts(bytes).candidateBytes;
    const reverted = composeLk1TrainG1RevertArtifacts(applied);
    assert.equal(reverted.candidateSha256, LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256);
    assert.equal(reverted.changes.length, 1);
    assert.deepEqual(reverted.changes[0].fields, ["initialize"]);
    assert.equal(reverted.changes[0].initialize.afterSha256, LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256);
    const gateway = reverted.flow.find((node) => node.id === "lk_subscription_booking_router_20260804");
    assert.equal(occurrences(gateway.initialize, '"planKey":"patriots"'), 1);
    assert.ok(gateway.initialize.includes(JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS)));
    // The rollback refuses any flow other than G1's postimage.
    assert.throws(() => composeLk1TrainG1RevertArtifacts(bytes), /G1 applied flow preimage drift/);
    // The usage block moves with the gateway body, which is why G2 pins it.
    assert.equal(usageBlockSha(gateway.func), "2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813");
  });
