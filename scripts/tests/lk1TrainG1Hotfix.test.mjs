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
  reviewedClubBinding,
  reviewedClubCoPayBlock,
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

/** The installed club money mandate: the reviewed binding without the `COURT_HOURLY_COPAY` branch. */
const INSTALLED_CLUB_BINDING = reviewedClubBinding().replace(reviewedClubCoPayBlock(), "");

/** A body carrying exactly the live G1 anchors, so every delta can be driven hermetically. */
const syntheticGatewayBody = () => `const isObj = (value) => Boolean(value);
const finishError = (ctx, status, message, details) => ({ status, message, details });
const resolveCategory = (exercise) => exercise.category;
const isTopokratyExercise = (exercise) => exercise.club === true;
const isTopokratyClubPack = (row) => row.club === true;
const lk1Stop = (ctx, code) => ({ stopped: code });
const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>
  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);
${INSTALLED_CLUB_BINDING}const lk1Quote = (ctx, exercise, owned) => {
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
      ctx.studioId = quote.target.stationId;
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
  assert.equal(occurrences(body, "COURT_HOURLY_COPAY"), 0);
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
    "COURT_HOURLY_COPAY",
  ]) {
    assert.equal(occurrences(patched, marker), 1, marker);
  }
  assert.equal(occurrences(patched, "LK1_COURT_PRICE_UNRESOLVED"), 5);
  // The reviewed continuation replaces the HUB `profile` re-entry with the focused `exercise` step.
  assert.ok(patched.includes('ctx.step = "exercise";\n  msg.payload = exercise;'));
  // The installed money mandate stays declared exactly once, the resolver is not duplicated, and
  // the delivered club binding is the reviewed one byte-for-byte (F1).
  assert.equal(occurrences(patched, "const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>"), 1);
  assert.equal(occurrences(patched, "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {"), 1);
  const patchedClub = patched.slice(
    patched.indexOf("const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {"));
  assert.ok(patchedClub.startsWith(reviewedClubBinding()), "the club binding must be the reviewed one");
  // F2: the dispatch runs after the target's station and room are assigned.
  assert.ok(patched.includes("      ctx.studioId = quote.target.stationId;\n"
    + "      // The club court-hourly co-pay proves its own hour of court for the raw event window"));
  assert.ok(patched.includes("      ctx.roomId = quote.target.roomId;\n"
    + "      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;"));
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
  // A body that already carries the branch is refused instead of double-spliced.
  const alreadyPaid = body.replace("  const percent = decision.eventDiscountPercent;\n",
    `  const percent = decision.eventDiscountPercent;\n${reviewedClubCoPayBlock()}`);
  assert.throws(() => patchLk1TrainG1GatewayBody(alreadyPaid, syntheticTarget(alreadyPaid)),
    /already carries the clubMoneyMandate delta/);
  // A body whose club binding is not the installed shape is refused.
  const tampered = body.replace("const percent = decision.eventDiscountPercent;",
    "const percent = decision.eventDiscountPercent || 0;");
  assert.throws(() => patchLk1TrainG1GatewayBody(tampered, syntheticTarget(tampered)),
    /anchor drift for club-copay: 0/);
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
  // F1: the composed gateway body delivers the reviewed club money mandate, once, in the club binding.
  assert.equal(built.gateway.clubMoneyMandateBound, true);
  assert.equal(occurrences(gateway.func, "COURT_HOURLY_COPAY"), 1);
  assert.ok(gateway.func.slice(gateway.func.indexOf("const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {"))
    .startsWith(reviewedClubBinding()));
  // F2: the dispatch runs after the target's station and room are assigned.
  assert.equal(built.gateway.clubDispatchAfterTargetIdentity, true);
  assert.ok(gateway.func.includes("      ctx.studioId = quote.target.stationId;\n"
    + "      // The club court-hourly co-pay proves its own hour of court for the raw event window"));
  assert.ok(gateway.func.includes("      ctx.roomId = quote.target.roomId;\n"
    + "      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;"));
  assert.equal(occurrences(gateway.func, "ctx.roomId = quote.target.roomId;"), 1);
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

// --- F1/F2 write-path execution -------------------------------------------------------------
//
// The composed G1 fragments are executed in-process against a club-training request, the way the
// payment-safety review did: F1 needs the reviewed club money mandate to resolve, and F2 needs the
// dispatch to see a resolved station/room so the proof (and the second pass) never refuses.

const G1_GATEWAY_ID = "lk_subscription_booking_router_20260804";
const COURT_STATION = "0d5504f6-ea6f-44bb-a9e4-947faf0273ab";
const COURT_ROOM = "7c1f0a2e-2b3c-4d5e-8f90-1234567890ab";
const COURT_CLUB_PRODUCT = "14692232-12be-4218-9fa1-2d5b79b62035";
const COURT_HELPERS_START = "const lk1CourtMasterServices = Object.freeze({";
const COURT_HELPERS_END = "  return total;\n};\n";
const COURT_STEPS_START = "const lk1CourtWindowEndTime = (exercise) => {";
const COURT_STEPS_END = "  return false;\n}\n";
const COURT_DISPATCH_START = "      ctx.studioId = quote.target.stationId;\n";
const COURT_DISPATCH_END = "      delete ctx.lk1CourtExercise;\n";

const RUNTIME_PRELUDE = `  const VIVA_API_BASE = "https://viva.test";
  const toStr = (value) => (value === undefined || value === null ? "" : String(value));
  const isObj = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const lk1Stop = (ctx, code) => ({ stop: code });
  const prepareAdminGet = (ctx, step, url) => ({ adminGet: url, step });
  const isHttpOk = (status) => status === 200;
  const exerciseRoomId = (exercise) => toStr(exercise?.room?.id || exercise?.roomId);
  const eventDurationMinutes = (exercise) => Number(exercise?.durationMinutes);
  const eventStartsAt = (exercise) => toStr(exercise?.timeFrom);
`;

function sliceFragment(body, startAnchor, endAnchor) {
  const start = body.indexOf(startAnchor);
  assert.ok(start >= 0, `missing anchor: ${startAnchor}`);
  const end = body.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end >= 0, `missing end anchor: ${endAnchor}`);
  return body.slice(start, end + endAnchor.length);
}

function composedG1GatewayFunc() {
  const built = composeLk1TrainG1Artifacts(fs.readFileSync(UPSTREAM_FLOW));
  return built.flow.find((node) => node.id === G1_GATEWAY_ID).func;
}

/** Runs the composed court steps and the exactly-shipped dispatch region of the G1 body. */
function composedCourtRuntime(body) {
  const helpers = sliceFragment(body, COURT_HELPERS_START, COURT_HELPERS_END);
  const steps = sliceFragment(body, COURT_STEPS_START, COURT_STEPS_END);
  const dispatchStart = body.indexOf(COURT_DISPATCH_START);
  assert.ok(dispatchStart >= 0, "missing composed dispatch anchor");
  const dispatchEnd = body.indexOf(COURT_DISPATCH_END, dispatchStart);
  assert.ok(dispatchEnd >= 0, "missing composed dispatch end");
  const dispatch = body.slice(dispatchStart, dispatchEnd + COURT_DISPATCH_END.length);
  const factory = new Function("global", `
${RUNTIME_PRELUDE}${helpers}
  return (ctx, msg, quote, exercise) => {
${steps}${dispatch}    return { step: ctx.step, proof: ctx.lk1TariffProof ?? null,
      service: ctx.lk1CourtService ?? null };
  };
`);
  return factory({ get: () => undefined });
}

/** Exposes the composed court functions alone, to drive the pre-fix (null station/room) order. */
function composedCourtFunctions(body) {
  const helpers = sliceFragment(body, COURT_HELPERS_START, COURT_HELPERS_END);
  const steps = sliceFragment(body, COURT_STEPS_START, COURT_STEPS_END);
  const factory = new Function("global", `
${RUNTIME_PRELUDE}${helpers}
  const ctx = { step: "__idle__" };
  const msg = {};
${steps}  return { startLk1CourtWindowFetch, lk1CourtWindowNeeded, lk1CourtWindowStoreProof };
`);
  return factory({ get: () => undefined });
}

test("the composed G1 club mandate resolves the co-pay and the dispatch proves a non-null station/room",
  { skip: snapshotSkip }, () => {
    const body = composedG1GatewayFunc();
    const runtime = composedCourtRuntime(body);
    const exercise = { id: "ex-1", timeFrom: "2026-10-06T10:00:00", timeTo: "2026-10-06T12:00:00",
      durationMinutes: 120, studio: { id: COURT_STATION }, room: { id: COURT_ROOM } };
    const quote = { target: { stationId: COURT_STATION, roomId: COURT_ROOM,
      category: "GROUP_TRAINING", directionId: 6233, basePriceMinor: 400000 } };
    const ctx = { caller: "http", actorClientId: "client-1", step: "exercise",
      lk1: { rule: { productId: COURT_CLUB_PRODUCT }, target: quote.target },
      lk1TariffProof: { kind: "EVENT_ONE_TIME", amountMinor: 400000 } };

    // Pass 1 — the dispatch must build the master-service URL from the target's station and room.
    const first = runtime(ctx, { statusCode: 200 }, quote, exercise);
    assert.equal(first.step, "lk1_court_window");
    assert.equal(Object.hasOwn(first, "stop"), false);
    assert.ok(first.adminGet.includes(`/studios/${COURT_STATION}/rooms/${COURT_ROOM}/`), first.adminGet);

    // Pass 2 — the reviewed response handler stores a proof binding the same station and room, the
    // continuation re-enters `exercise`, and the second dispatch pass neither re-fetches nor refuses.
    const second = runtime(ctx, { statusCode: 200, payload: { total: 6000 } }, quote, exercise);
    assert.equal(second.step, "exercise");
    assert.equal(Object.hasOwn(second, "stop"), false);
    assert.equal(second.proof.stationId, COURT_STATION);
    assert.equal(second.proof.roomId, COURT_ROOM);
    assert.equal(second.proof.windowTotalMinor, 600000);

    // The pre-fix order (dispatch before the target identity is assigned) refuses with the null
    // station/room proof — the F2 defect this relocation closes.
    const legacy = composedCourtFunctions(body);
    const legacyCtx = { caller: "http", actorClientId: "client-1",
      lk1: ctx.lk1, lk1TariffProof: ctx.lk1TariffProof, lk1CourtExercise: exercise };
    assert.deepEqual(legacy.startLk1CourtWindowFetch(legacyCtx),
      { stop: "LK1_COURT_PRICE_UNRESOLVED" });

    // F1 — the composed club binding resolves the reviewed `COURT_HOURLY_COPAY` shape and refuses a
    // charge it cannot reproduce from the decision's own numbers.
    const clubStart = body.indexOf("const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {");
    const clubEnd = body.indexOf("\n};\n", clubStart);
    const bindingFactory = new Function("lk1EventPaymentRoute",
      `${body.slice(clubStart, clubEnd + "\n};\n".length)}
      return lk1ClubEventPaymentBinding;`);
    const binding = bindingFactory(() => ({ sourceCategory: "group_training", category: "GROUP_TRAINING" }));
    const bindingTarget = { category: "GROUP_TRAINING", eventId: "ex-1", stationId: COURT_STATION,
      priceProductId: "price-product-1", basePriceMinor: 400000 };
    const bindingCtx = { caller: "http", category: "group_training", exerciseId: "ex-1",
      studioId: COURT_STATION, lk1: {} };
    const paid = binding(bindingCtx, { target: bindingTarget, decision: { eligible: true,
      subscriptionVisitCount: 1, eventDiscountPercent: 0,
      benefit: { kind: "COURT_HOURLY_COPAY", finalPriceMinor: 150000,
        partialPriceCalculation: { hourlyCourtPriceMinor: 600000, perHourMinor: 150000, chargeableHours: 1 } } } });
    assert.deepEqual(paid, { productId: "price-product-1", productType: "SERVICE",
      baseMinor: 400000, chargeMinor: 150000, discountMinor: 250000 });
    // The same decision with a charge the branch cannot reproduce must refuse, not mis-charge.
    const refused = binding(bindingCtx, { target: bindingTarget, decision: { eligible: true,
      subscriptionVisitCount: 1, eventDiscountPercent: 0,
      benefit: { kind: "COURT_HOURLY_COPAY", finalPriceMinor: 50000,
        partialPriceCalculation: { hourlyCourtPriceMinor: 600000, perHourMinor: 150000, chargeableHours: 1 } } } });
    assert.equal(refused, null);
  });
