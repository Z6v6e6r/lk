#!/usr/bin/env node

// Focused Node-RED generation: «Дружба Топократы» enters the LK1 subscription contour
// with the quarter-of-court co-pay on the club training direction 6233.
//
// Owner decision 2026-09-26 (docs/LK1_TOPOKRATY_FRIENDSHIP_20260926.md): the club product
// `14692232-12be-4218-9fa1-2d5b79b62035` gets the same five numbers as «Дружба», and its
// training direction 6233 additionally charges a quarter of the court price above the free
// hour. The club rule ships as a *stacked* generation on the installed flow, because the
// previous plan-rules generation is already live and refuses to be re-applied: this patcher
// therefore pins the exact current live flow and applies reviewed deltas to its bodies.
//
// Applied to the installed flow (read-only pull from lk-primary-147, 2026-09-25,
// `d6df38f3…`, 4804 nodes). Exactly three nodes / five fields change:
//   1. `lk_subscription_booking_router_20260804.func` — the reviewed `exerciseDirectionId`
//      helper, `directionId` in the server-resolved target and the decision-percent
//      comparison (`lk1ExpectedEventDiscountPercent`), so a client quote is checked against
//      the percent the decision itself fixed (club full price 0 %, the co-pay share, or the
//      configured event discount).
//   2. `lk_subscription_booking_router_20260804.initialize` — the plan-rules writer block is
//      REPLACED (not appended) by the guarded `LK1_PLAN_RULES_DESIRED ->
//      LK1_PLAN_RULES_WITH_TOPOKRATY` transition, so the installed 7-rule payload is the
//      exact prior and a rerun cannot silently rewrite the global back.
//   3. `lk_subscription_managed_policy_20260820.func` — the embedded LK1 copy is replaced by
//      the reviewed evaluator that carries the club training branch (free hour + quarter
//      co-pay, full price when the hour is unavailable).
//   4. `lk_subscription_price_preview_20260908_router.func` — recomposed on the patched
//      generation so the advisory quote and the write path agree.
//
// Preparation only: nothing is deployed, imported, restarted or activated here, and the
// patcher fails closed unless the preimage is exactly the reviewed installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { reviewedEvaluatorBody } from "./patch_live_lk1_plan_rules.mjs";
import {
  LK1_PLAN_RULES_DESIRED,
  LK1_PLAN_RULES_WITH_TOPOKRATY,
  buildTopokratyPlanRulesRevert,
  buildTopokratyPlanRulesTransition,
} from "./lib/lk1PlanRulesTransition.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const TOPOKRATY_DEPLOYMENT_ID = "lk1-topokraty-friendship";
export const TOPOKRATY_KIND = "FOCUSED_LK1_TOPOKRATY_FRIENDSHIP_V1";

// Reviewed live preimage: the read-only 2026-09-25 pull from lk-primary-147, already
// carrying the plan-rules, station-exclusions and PRO-training generations.
export const TOPOKRATY_UPSTREAM_SHA256 =
  "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe";
export const TOPOKRATY_SOURCE_NODE_COUNT = 4804;

export const TOPOKRATY_GATEWAY_ID = "lk_subscription_booking_router_20260804";
export const TOPOKRATY_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";
export const TOPOKRATY_PREVIEW_ID = "lk_subscription_price_preview_20260908_router";

export const TOPOKRATY_TARGET = Object.freeze({
  gatewayId: TOPOKRATY_GATEWAY_ID,
  liveFuncSha256: "a230800da9b144d3f51ff02929e63d0c21e01c2f59e3485091aab5b46d21fae0",
  patchedFuncSha256: "f4ac7aae5623f8c7cbd0ae9206a72b985ad85a8beeba49899242b801767d3cc2",
  liveInitializeSha256: "f373346fc14ba52988c59269b803bb2297a39db24c81ae6d570ecaf6f5d7728a",
  patchedInitializeSha256: "08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602",
  evaluatorId: TOPOKRATY_EVALUATOR_ID,
  liveEvaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
  liveEmbeddedSha256: "f1f65a2050523e6104ee0586e1ad62bb0f6945b0ff1dc1583fd52dcf3a9a0433",
  patchedEvaluatorFuncSha256: "443f2633e92f1aa4ce2f2df85b6e100a216a9cebcbc136a30c4c7a2ec8284a63",
  previewId: TOPOKRATY_PREVIEW_ID,
  livePreviewFuncSha256: "9d99004da35aa4fccc8e32f0c6afd0dbd2f16466502324da4468fe4ab09f2bd9",
  patchedPreviewFuncSha256: "272b32b90409102d9139a55be5887ef19c6443e47ebb816d5fba44d0ed663d7d",
});

// The installed preview composition pins of this generation: the split/join bodies and the
// allowance block are the installed ones, never the reviewed preimage defaults of a line.
export const TOPOKRATY_PREVIEW_INSTALLED = Object.freeze({
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// Reviewed fragments of `scripts/nodered_lk1_hub_nodes/gateway.js`, pinned by sha so a
// change to a reviewed source can never enter the candidate unnoticed.
export const TOPOKRATY_DIRECTION_HELPER_SHA256 =
  "7d694c04f90d8a6382e1bfbe507586bd5663020e3ef45fb7f9890a8f2c293bc7";
export const TOPOKRATY_PERCENT_HELPER_SHA256 =
  "6df43d89a0756750dbe02efc85a00b8002f8c23d2dcb1ade35407c639a5b1588";

// Present only after this generation: the gateway quote comparison and the initialize
// payload. A second run is refused instead of produced.
export const TOPOKRATY_PATCH_MARKER = "lk1ExpectedEventDiscountPercent";

const REVIEWED_GATEWAY_SOURCE = "scripts/nodered_lk1_hub_nodes/gateway.js";

const DIRECTION_HELPER_START =
  "// The Viva direction of the resolved exercise, read through the same aliases";
const DIRECTION_HELPER_END = "  return Number.isInteger(numeric) ? numeric : null;\n};\n";
const PERCENT_HELPER_START =
  "    // The percent the advisory preview quotes for a charged event. It is the percent the";
const PERCENT_HELPER_END = "        : ctx.lk1.rule[route.discountField]);\n";

const DIRECTION_HELPER_ANCHOR = "const lk1Quote = (ctx, exercise, owned) => {";
const TARGET_ANCHOR =
  "    stationId: toStr(exercise.studio?.id || exercise.studioId), roomId: exerciseRoomId(exercise),\n"
  + "    durationMinutes: eventDurationMinutes(exercise), startsAt: eventStartsAt(exercise),\n";
const TARGET_DIRECTION_LINE = "    directionId: exerciseDirectionId(exercise),\n";
const QUOTE_TARGET_ANCHOR =
  "    const target = ctx.lk1.target;\n"
  + "    if ((expectedGroup !== undefined && expectedTournament !== undefined)";
const QUOTE_COMPARE_ANCHOR =
  "      || expected.discountPercent !== ctx.lk1.rule[route.discountField]\n";
const QUOTE_COMPARE_REPLACEMENT =
  "      || expected.discountPercent !== lk1ExpectedEventDiscountPercent(decision, route)\n";

const EVALUATOR_LK1_BRANCH_OPEN =
  'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n'
  + "  return (() => {\n";
const EVALUATOR_LK1_BRANCH_CLOSE = "\n})();\n}";

const PLAN_RULES_BLOCK_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_RULES_BLOCK_END = "const lk1StationExclusionsKey";
const PLAN_RULES_DESIRED_LITERAL = "const lk1DesiredPlanRules = ";
const PLAN_RULES_PRIOR_LITERAL = "const lk1PlanRulesExpectedPrior = ";
const PLAN_RULES_ACCEPTED_PRIORS_LITERAL = "const lk1PlanRulesAcceptedPriors = ";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function reviewedFragment(startMarker, endMarker, pin, label) {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..",
    REVIEWED_GATEWAY_SOURCE), "utf8");
  if (source.split(startMarker).length !== 2) {
    throw new Error(`Reviewed ${label} start anchor drift`);
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Reviewed ${label} end anchor drift`);
  const fragment = source.slice(start, end + endMarker.length);
  if (sha256(fragment) !== pin) {
    throw new Error(`Reviewed ${label} drift: ${sha256(fragment)} != ${pin}`);
  }
  return fragment;
}

function assertFunctionNode(node, id) {
  if (!node) throw new Error(`Node contract mismatch: ${id} is absent`);
  if (node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1
    || node.wires?.length !== node.outputs || typeof node.func !== "string"
    || typeof node.initialize !== "string") {
    throw new Error(`Node contract mismatch: ${id}`);
  }
  return node;
}

function assertFunctionBody(body, label) {
  try {
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

function assertInitializeBody(body, label) {
  try {
    new Function("global", "env", "node", "flow", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED initialize body: ${error.message}`);
  }
}

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin.startsWith("__")) throw new Error(`${label} postimage pin is not set`);
  if (sha256(body) !== pin) {
    throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
  }
}

function applyDeltas(source, deltas, label) {
  let patched = source;
  for (const delta of deltas) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  return patched;
}

function extractEmbeddedEvaluator(source, target = TOPOKRATY_TARGET) {
  if (source.split(EVALUATOR_LK1_BRANCH_OPEN).length !== 2) {
    throw new Error("Evaluator LK1 branch preimage drift");
  }
  const start = source.indexOf(EVALUATOR_LK1_BRANCH_OPEN) + EVALUATOR_LK1_BRANCH_OPEN.length;
  const end = source.indexOf(EVALUATOR_LK1_BRANCH_CLOSE, start);
  if (end < 0) throw new Error("Evaluator LK1 branch end drift");
  const embedded = source.slice(start, end);
  if (sha256(embedded) !== target.liveEmbeddedSha256) {
    throw new Error(`Evaluator embedded body drift: ${sha256(embedded)} != ${target.liveEmbeddedSha256}`);
  }
  return { embedded, start, end };
}

/** The gateway body of this generation: direction id in the target plus the decision percent. */
export function patchTopokratyGatewayBody(source, target = TOPOKRATY_TARGET) {
  if (source.includes(TOPOKRATY_PATCH_MARKER)) {
    throw new Error("Booking gateway already carries the club decision percent");
  }
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  const directionHelper = reviewedFragment(DIRECTION_HELPER_START, DIRECTION_HELPER_END,
    TOPOKRATY_DIRECTION_HELPER_SHA256, "direction helper");
  const percentHelper = reviewedFragment(PERCENT_HELPER_START, PERCENT_HELPER_END,
    TOPOKRATY_PERCENT_HELPER_SHA256, "decision percent helper");
  const deltas = [
    { id: "direction-helper", before: DIRECTION_HELPER_ANCHOR,
      after: `${directionHelper}${DIRECTION_HELPER_ANCHOR}` },
    { id: "target-direction", before: TARGET_ANCHOR,
      after: TARGET_ANCHOR.replace("    durationMinutes:",
        `${TARGET_DIRECTION_LINE}    durationMinutes:`) },
    { id: "decision-percent-helper", before: QUOTE_TARGET_ANCHOR,
      after: `    const target = ctx.lk1.target;\n${percentHelper}    if ((expectedGroup !== undefined && expectedTournament !== undefined)` },
    { id: "decision-percent-compare", before: QUOTE_COMPARE_ANCHOR,
      after: QUOTE_COMPARE_REPLACEMENT },
  ];
  const patched = applyDeltas(source, deltas, "Topokraty booking");
  if (patched.split("const exerciseDirectionId = (exercise) => {").length !== 2) {
    throw new Error("The reviewed direction helper must be embedded exactly once");
  }
  if (patched.split("const lk1ExpectedEventDiscountPercent = (decision, route) => (").length !== 2) {
    throw new Error("The decision percent helper must be embedded exactly once");
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  return patched;
}

/** The gateway initialize of this generation: the plan-rules writer is replaced. */
export function patchTopokratyGatewayInitialize(source, target = TOPOKRATY_TARGET) {
  if (source.includes('"planKey":"topocraty"')) {
    throw new Error("Gateway initialize already carries the club plan rule");
  }
  if (sha256(source) !== target.liveInitializeSha256) {
    throw new Error(`Gateway initialize installed preimage drift: ${sha256(source)} != ${target.liveInitializeSha256}`);
  }
  const start = source.indexOf(PLAN_RULES_BLOCK_START);
  const end = source.indexOf(PLAN_RULES_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) throw new Error("Gateway initialize plan-rules block drift");
  const block = source.slice(start, end);
  if (block.split(PLAN_RULES_BLOCK_START).length !== 2) {
    throw new Error("Gateway initialize plan-rules block is not unique");
  }
  const desiredIndex = block.indexOf(PLAN_RULES_DESIRED_LITERAL);
  const priorIndex = block.indexOf(PLAN_RULES_PRIOR_LITERAL);
  if (desiredIndex < 0 || priorIndex < 0) {
    throw new Error("Gateway initialize plan-rules payload anchors are absent");
  }
  const installedDesired = JSON.parse(block.slice(desiredIndex + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(installedDesired) !== JSON.stringify(LK1_PLAN_RULES_DESIRED)) {
    throw new Error("Gateway initialize installed plan-rules payload is not the reviewed prior");
  }
  const transition = buildTopokratyPlanRulesTransition();
  const patched = `${source.slice(0, start)}${transition.initialize}${source.slice(end)}`;
  if (patched.split('"planKey":"topocraty"').length !== 2) {
    throw new Error("The club plan rule must enter the initialize exactly once");
  }
  if (patched.split(PLAN_RULES_BLOCK_START).length !== 2) {
    throw new Error("The plan-rules writer must be replaced exactly once");
  }
  assertInitializeBody(patched, "Patched gateway initialize body");
  return patched;
}

/** The evaluator body of this generation: the embedded LK1 copy is replaced. */
export function patchTopokratyEvaluatorBody(source, target = TOPOKRATY_TARGET) {
  const reviewed = reviewedEvaluatorBody();
  if (source.includes(reviewed)) {
    throw new Error("Reviewed evaluator body is already embedded in the live body");
  }
  if (sha256(source) !== target.liveEvaluatorFuncSha256) {
    throw new Error(`Evaluator installed preimage drift: ${sha256(source)} != ${target.liveEvaluatorFuncSha256}`);
  }
  const { start, end } = extractEmbeddedEvaluator(source, target);
  const patched = source.slice(0, start) + reviewed + source.slice(end);
  assertFunctionBody(patched, "Patched evaluator body");
  return patched;
}

/**
 * Composes the candidate: the installed flow with the gateway (func + initialize), the
 * evaluator and the recomposed preview. Fails closed on any preimage, node-count, shape,
 * parse, postimage or graph mismatch.
 */
export function composeTopokratyArtifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? TOPOKRATY_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow is not a node array");
  if (flow.length !== TOPOKRATY_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${TOPOKRATY_SOURCE_NODE_COUNT}`);
  }
  const gateway = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_GATEWAY_ID), TOPOKRATY_GATEWAY_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_EVALUATOR_ID), TOPOKRATY_EVALUATOR_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_PREVIEW_ID), TOPOKRATY_PREVIEW_ID);

  const before = {
    gatewayFunc: sha256(gateway.func),
    gatewayInitialize: sha256(gateway.initialize),
    evaluatorFunc: sha256(evaluator.func),
    previewFunc: sha256(preview.func),
  };
  const gatewayShape = JSON.parse(JSON.stringify({ ...gateway, func: null, initialize: null }));
  const previewShape = JSON.parse(JSON.stringify({ ...preview, func: null }));
  const evaluatorShape = JSON.parse(JSON.stringify({ ...evaluator, func: null }));

  gateway.func = patchTopokratyGatewayBody(gateway.func);
  gateway.initialize = patchTopokratyGatewayInitialize(gateway.initialize);
  evaluator.func = patchTopokratyEvaluatorBody(evaluator.func);

  const composed = previewSources(flow, {
    pins: {
      booking: sha256(gateway.func),
      evaluator: sha256(evaluator.func),
      pricing: options.pricingSha256 ?? TOPOKRATY_PREVIEW_INSTALLED.splitFuncSha256,
      join: options.joinSha256 ?? TOPOKRATY_PREVIEW_INSTALLED.joinFuncSha256,
    },
    installedUsageSha256: options.installedUsageSha256
      ?? TOPOKRATY_PREVIEW_INSTALLED.allowanceBlockSha256,
  });
  preview.func = composed.router;

  if (JSON.stringify({ ...gateway, func: null, initialize: null }) !== JSON.stringify(gatewayShape)
    || JSON.stringify({ ...preview, func: null }) !== JSON.stringify(previewShape)
    || JSON.stringify({ ...evaluator, func: null }) !== JSON.stringify(evaluatorShape)) {
    throw new Error("A generation node changed a field other than func/initialize");
  }
  if (!composed.router.includes("canonical.resolveLk1Rule")) {
    throw new Error("Composed preview body cannot reach the shared plan-rules resolver");
  }
  assertFunctionBody(gateway.func, "Patched booking gateway body");
  assertInitializeBody(gateway.initialize, "Patched booking gateway initialize body");
  assertFunctionBody(evaluator.func, "Patched evaluator body");
  assertFunctionBody(preview.func, "Composed preview body");
  if (options.assertPostimages !== false) {
    assertPostimage(gateway.func, TOPOKRATY_TARGET.patchedFuncSha256, "Booking");
    assertPostimage(gateway.initialize, TOPOKRATY_TARGET.patchedInitializeSha256, "Booking initialize");
    assertPostimage(evaluator.func, TOPOKRATY_TARGET.patchedEvaluatorFuncSha256, "Evaluator");
    assertPostimage(preview.func, TOPOKRATY_TARGET.patchedPreviewFuncSha256, "Preview");
  }

  const changes = [
    { id: TOPOKRATY_GATEWAY_ID, fields: ["func", "initialize"],
      func: { beforeSha256: before.gatewayFunc, afterSha256: sha256(gateway.func) },
      initialize: { beforeSha256: before.gatewayInitialize, afterSha256: sha256(gateway.initialize) } },
    { id: TOPOKRATY_EVALUATOR_ID, fields: ["func"],
      func: { beforeSha256: before.evaluatorFunc, afterSha256: sha256(evaluator.func) } },
    { id: TOPOKRATY_PREVIEW_ID, fields: ["func"],
      func: { beforeSha256: before.previewFunc, afterSha256: sha256(preview.func) } },
  ];
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: [...row.fields] }));
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: TOPOKRATY_DEPLOYMENT_ID, allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    gateway: {
      id: TOPOKRATY_GATEWAY_ID,
      directionHelperEmbeddedOnce: gateway.func.split("const exerciseDirectionId = (exercise) => {").length === 2,
      targetDirectionBound: gateway.func.includes(TARGET_DIRECTION_LINE),
      decisionPercentBound: gateway.func.includes("lk1ExpectedEventDiscountPercent(decision, route)"),
      planRulesPayloadReplaced: gateway.initialize.includes('"planKey":"topocraty"')
        && !gateway.initialize.includes('const lk1PlanRulesExpectedPrior = null;'),
      acceptsEmptyPrior: gateway.initialize.includes("const lk1PlanRulesAcceptedPriors = [null,"),
    },
    evaluator: {
      id: TOPOKRATY_EVALUATOR_ID,
      clubBranchBound: evaluator.func.includes("isTopokratyTrainingBenefit")
        && evaluator.func.includes("eventDiscountPercent"),
    },
    preview: {
      id: TOPOKRATY_PREVIEW_ID,
      initializeUnchanged: preview.initialize === "",
      resolverReachable: composed.router.includes("canonical.resolveLk1Rule"),
      helperCount: composed.helperNames.length,
    },
  };
}

/**
 * The ordered rollback of this release: the plan-rules global goes back to the installed
 * 7-rule payload FIRST, and only then the resolver generation is rolled back. The reverse
 * order would leave the global naming the club product while the restored evaluator has no
 * club branch, and a direction-6233 training would be priced at the ordinary 50 %.
 *
 * The revert candidate keeps the club resolver generation and only replaces the plan-rules
 * writer with the guarded `LK1_PLAN_RULES_WITH_TOPOKRATY -> LK1_PLAN_RULES_DESIRED` block.
 */
export const TOPOKRATY_REVERT_UPSTREAM_SHA256 =
  "68debf146be1fcad65a6fd17fc38113d7f97158b0607c16cdd6887bb356043b5";
export const TOPOKRATY_REVERT_GATEWAY_INITIALIZE_SHA256 =
  "08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602";
export const TOPOKRATY_REVERT_INITIALIZE_POSTIMAGE_SHA256 =
  "5d93ae8a62ad8c2e4a9892b77730c8cbbd3858e92e4172e0d3e6bdc949133da5";

/** Replaces the club plan-rules writer with the guarded revert writer. */
export function patchTopokratyGatewayInitializeRevert(source, target = TOPOKRATY_TARGET) {
  if (sha256(source) !== TOPOKRATY_REVERT_GATEWAY_INITIALIZE_SHA256) {
    throw new Error(`Gateway initialize revert preimage drift: ${sha256(source)}`);
  }
  const start = source.indexOf(PLAN_RULES_BLOCK_START);
  const end = source.indexOf(PLAN_RULES_BLOCK_END);
  if (start < 0 || end < 0 || end <= start) throw new Error("Gateway initialize plan-rules block drift");
  const block = source.slice(start, end);
  const desiredIndex = block.indexOf(PLAN_RULES_DESIRED_LITERAL);
  if (desiredIndex < 0) throw new Error("Gateway initialize revert payload anchor is absent");
  const installedDesired = JSON.parse(block.slice(desiredIndex + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(installedDesired) !== JSON.stringify(LK1_PLAN_RULES_WITH_TOPOKRATY)) {
    throw new Error("Gateway initialize does not carry the club plan-rules payload");
  }
  const revert = buildTopokratyPlanRulesRevert();
  const patched = `${source.slice(0, start)}${revert.initialize}${source.slice(end)}`;
  // The guarded revert keeps the club payload as an accepted PRIOR and writes the installed
  // 7-rule payload back. The empty prior is accepted too: 147 keeps its context in memory, so
  // the restart that publishes this candidate clears the global before the writer runs.
  const patchedStart = patched.indexOf(PLAN_RULES_BLOCK_START);
  const patchedEnd = patched.indexOf(PLAN_RULES_BLOCK_END);
  if (patchedStart < 0 || patchedEnd <= patchedStart) throw new Error("Reverted plan-rules block drift");
  const patchedBlock = patched.slice(patchedStart, patchedEnd);
  const revertDesiredIndex = patchedBlock.indexOf(PLAN_RULES_DESIRED_LITERAL);
  const revertPriorsIndex = patchedBlock.indexOf(PLAN_RULES_ACCEPTED_PRIORS_LITERAL);
  if (revertDesiredIndex < 0 || revertPriorsIndex < 0) {
    throw new Error("Reverted gateway initialize payload anchors are absent");
  }
  const revertDesired = JSON.parse(patchedBlock.slice(revertDesiredIndex + PLAN_RULES_DESIRED_LITERAL.length)
    .split(";\n")[0]);
  const revertPriors = JSON.parse(patchedBlock.slice(revertPriorsIndex + PLAN_RULES_ACCEPTED_PRIORS_LITERAL.length)
    .split(";\n")[0]);
  if (JSON.stringify(revertDesired) !== JSON.stringify(LK1_PLAN_RULES_DESIRED)
    || JSON.stringify(revertPriors) !== JSON.stringify([null, LK1_PLAN_RULES_WITH_TOPOKRATY])) {
    throw new Error("The revert writer must restore the installed payload from the club prior");
  }
  assertInitializeBody(patched, "Reverted gateway initialize body");
  void target;
  return patched;
}

/** Composes the revert candidate: only the gateway initialize changes. */
export function composeTopokratyRevertArtifacts(rawSource) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== TOPOKRATY_REVERT_UPSTREAM_SHA256) {
    throw new Error(`Applied flow preimage drift: ${sourceSha256} != ${TOPOKRATY_REVERT_UPSTREAM_SHA256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  const gateway = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_GATEWAY_ID), TOPOKRATY_GATEWAY_ID);
  const before = sha256(gateway.initialize);
  gateway.initialize = patchTopokratyGatewayInitializeRevert(gateway.initialize);
  assertPostimage(gateway.initialize, TOPOKRATY_REVERT_INITIALIZE_POSTIMAGE_SHA256, "Reverted gateway initialize");
  const changes = [
    { id: TOPOKRATY_GATEWAY_ID, fields: ["initialize"],
      initialize: { beforeSha256: before, afterSha256: sha256(gateway.initialize) } },
  ];
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: `${TOPOKRATY_DEPLOYMENT_ID}-revert`,
    allowedChanges: changes.map((row) => ({ id: row.id, fields: [...row.fields] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, sourceSha256, candidateSha256: sha256(candidateBytes) };
}

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildTopokratyReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: TOPOKRATY_KIND, deploymentId: TOPOKRATY_DEPLOYMENT_ID,
    targets: {
      gateway: { id: TOPOKRATY_GATEWAY_ID,
        func: { beforeSha256: TOPOKRATY_TARGET.liveFuncSha256, afterSha256: TOPOKRATY_TARGET.patchedFuncSha256 },
        initialize: { beforeSha256: TOPOKRATY_TARGET.liveInitializeSha256,
          afterSha256: TOPOKRATY_TARGET.patchedInitializeSha256 } },
      evaluator: { id: TOPOKRATY_EVALUATOR_ID,
        func: { beforeSha256: TOPOKRATY_TARGET.liveEvaluatorFuncSha256,
          afterSha256: TOPOKRATY_TARGET.patchedEvaluatorFuncSha256 } },
      preview: { id: TOPOKRATY_PREVIEW_ID,
        func: { beforeSha256: TOPOKRATY_TARGET.livePreviewFuncSha256,
          afterSha256: TOPOKRATY_TARGET.patchedPreviewFuncSha256 } },
    },
    planRulesActivation: {
      key: "subscriptions_lk1_plan_rules",
      expectedPriorRuleCount: LK1_PLAN_RULES_DESIRED.rules.length,
      desiredRuleCount: LK1_PLAN_RULES_WITH_TOPOKRATY.rules.length,
      clubProductId: "14692232-12be-4218-9fa1-2d5b79b62035",
      writerReplaced: true,
    },
    upstreamFlowSha256: TOPOKRATY_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 3, addedNodeCount: built.addedNodeCount,
    changes: built.changes, gateway: built.gateway, evaluator: built.evaluator, preview: built.preview,
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
}

function fail(message) { console.error(message); process.exitCode = 1; }

function prepareTargets(workspace, requested) {
  const canonical = (value) => {
    if (!path.isAbsolute(value)) throw new Error("Output paths must be absolute");
    if (path.resolve(value) !== value) throw new Error("Output paths must be canonical");
    if (fs.existsSync(value)) throw new Error(`Refusing to overwrite output: ${value}`);
    if (value === workspace || value.startsWith(`${workspace}${path.sep}`)) {
      throw new Error("Outputs must stay outside the live workspace");
    }
    return value;
  };
  return requested.map(canonical);
}

function main(args) {
  const values = {};
  let mode = "generation";
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--mode") {
      mode = String(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --mode <generation|revert> --workspace <fresh-live-workspace> "
        + "--output <candidate.json> --report <report.json>"); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
    index += 1;
  }
  if (Object.keys(values).length !== 3 || !["generation", "revert"].includes(mode)) {
    fail("Usage: --mode <generation|revert> --workspace <fresh-live-workspace> "
      + "--output <candidate.json> --report <report.json>"); return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = mode === "revert"
    ? composeTopokratyRevertArtifacts(liveBytes)
    : composeTopokratyArtifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = mode === "revert"
    ? {
      kind: `${TOPOKRATY_KIND}_REVERT`, deploymentId: `${TOPOKRATY_DEPLOYMENT_ID}-revert`,
      targets: built.changes, upstreamFlowSha256: TOPOKRATY_REVERT_UPSTREAM_SHA256,
      sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
      sourceNodeCount: verified.nodeCount, candidateNodeCount: built.flow.length,
      changedNodeCount: built.changes.length, expectedChangedNodeCount: 1, addedNodeCount: 0,
      changes: built.changes,
      planRulesActivation: {
        key: "subscriptions_lk1_plan_rules",
        expectedPriorRuleCount: LK1_PLAN_RULES_WITH_TOPOKRATY.rules.length,
        desiredRuleCount: LK1_PLAN_RULES_DESIRED.rules.length,
        writerReplaced: true,
        orderedRollbackStep: 1,
      },
      topologyChanged: false, routesChanged: false, policyChanged: true,
      deploymentPerformed: false, liveMutationPerformed: false,
    }
    : buildTopokratyReport({ sourceSha256: verified.sourceSha256,
      sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`Topokraty friendship generation failed: ${error.message}`);
  }
}
