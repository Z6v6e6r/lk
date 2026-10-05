// Re-derive every pin the 2026-10-05 LK1 train touches, from the read-only 147 snapshot and the
// reviewed working-tree sources. Writes `pin-derivation.json` next to this tool.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const SNAPSHOT = process.argv[2] ?? "/private/tmp/lk1-train-147-prep/input/source.flow.json";

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const field = (flow, id, name) => {
  const node = flow.find((row) => row.id === id);
  if (!node) throw new Error(`node absent: ${id}`);
  return sha(node[name] ?? "");
};
const usageBlock = (body) => {
  const start = body.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const end = body.indexOf('if (ctx.step === "lk1_policy_decision") {');
  return sha(body.slice(start, end));
};
const occ = (haystack, needle) => haystack.split(needle).length - 1;

const bytes = fs.readFileSync(SNAPSHOT);
const flow = JSON.parse(bytes.toString("utf8"));
const byId = new Map(flow.map((row) => [row.id, row]));
const gateway = byId.get("lk_subscription_booking_router_20260804").func;
const initialize = byId.get("lk_subscription_booking_router_20260804").initialize;
const evaluator = byId.get("lk_subscription_managed_policy_20260820").func;
const previewRouter = byId.get("lk_subscription_price_preview_20260908_router").func;

const {
  LK1_TRAIN_G1_CONTINUATION_SHA256, LK1_TRAIN_G1_COURT_QUOTE_BLOCK_SHA256,
  LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256,
  LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256, LK1_TRAIN_G1_POSTIMAGE_SHA256,
  LK1_TRAIN_G1_PREIMAGE_NODE_SHA256, LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256,
  LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256, LK1_TRAIN_G1_REVIEWED_CLUB_GATE_SHA256,
  LK1_TRAIN_G1_REVIEWED_GATEWAY_SHA256, LK1_TRAIN_G1_REVIEWED_HOOKS_SHA256,
  LK1_TRAIN_G1_REVIEWED_PATRIOTS_GUARD_SHA256, LK1_TRAIN_G1_TARGET,
  LK1_TRAIN_G1_USAGE_CLUB_FREE_SHA256, LK1_TRAIN_G1_USAGE_COURT_MINUTES_SHA256,
  LK1_TRAIN_G1_UPSTREAM_SHA256, composeLk1TrainG1Artifacts,
} = await import(path.join(ROOT, "scripts/patch_live_lk1_train_g1_20261005.mjs"));
const {
  LK1_TRAIN_G2_POSTIMAGE_SHA256, LK1_TRAIN_G2_TARGET, composeLk1TrainG2Artifacts,
} = await import(path.join(ROOT, "scripts/patch_live_lk1_train_g2_20261005.mjs"));

const g1 = composeLk1TrainG1Artifacts(bytes);
const g2 = composeLk1TrainG2Artifacts(g1.candidateBytes);

const result = {
  provenance: {
    host: "lk-primary-147", remotePath: "/root/.node-red/flows.json",
    transport: "ssh -o BatchMode=yes root@lk-primary-147 'cat /root/.node-red/flows.json'",
    localReadOnlyCopy: SNAPSHOT, sourceSha256: sha(bytes), nodeCount: flow.length,
    remoteSha256Reverified20261005: "7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1",
  },
  live: {
    flowSha256: sha(bytes), nodeCount: flow.length,
    gatewayFunc: field(flow, "lk_subscription_booking_router_20260804", "func"),
    gatewayInitialize: field(flow, "lk_subscription_booking_router_20260804", "initialize"),
    gatewayNode: sha(JSON.stringify(byId.get("lk_subscription_booking_router_20260804"))),
    evaluatorFunc: field(flow, "lk_subscription_managed_policy_20260820", "func"),
    previewRouterFunc: field(flow, "lk_subscription_price_preview_20260908_router", "func"),
    previewEvaluateFunc: field(flow, "lk_subscription_price_preview_20260908_evaluate", "func"),
    pricingFunc: field(flow, "8f7bd5b482fe9763", "func"),
    joinFunc: field(flow, "e92e68bf3f08a70c", "func"),
    usageBlock: usageBlock(gateway),
    planRules: JSON.parse(initialize.slice(initialize.indexOf("const lk1DesiredPlanRules = ")
      + "const lk1DesiredPlanRules = ".length).split(";\n")[0]),
  },
  reviewedSource: {
    "scripts/nodered_lk1_hub_nodes/gateway.js": sha(read("scripts/nodered_lk1_hub_nodes/gateway.js")),
    "scripts/nodered_lk1_hub_nodes/gateway_hooks.js": sha(read("scripts/nodered_lk1_hub_nodes/gateway_hooks.js")),
    "scripts/nodered_lk1_hub_nodes/evaluator.js": sha(read("scripts/nodered_lk1_hub_nodes/evaluator.js")),
    "scripts/nodered_lk1_hub_nodes/event_payments.js": sha(read("scripts/nodered_lk1_hub_nodes/event_payments.js")),
    "scripts/nodered_subscription_price_preview_nodes/router.js": sha(read("scripts/nodered_subscription_price_preview_nodes/router.js")),
    "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js": sha(read("scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js")),
    "scripts/lib/eventPaymentSources.mjs": sha(read("scripts/lib/eventPaymentSources.mjs")),
    "scripts/lib/lk1PlanRulesTransition.mjs": sha(read("scripts/lib/lk1PlanRulesTransition.mjs")),
  },
  markers: {
    clubMoneyMandate: occ(gateway, "lk1ClubEventPaymentBinding"),
    clubMoneyMandateBranch: occ(gateway, "COURT_HOURLY_COPAY"),
    quoteBindingCallSites: occ(gateway, "lk1EventPaymentQuoteBinding("),
    reclaim: occ(gateway, "lk1ReclaimableAttempt"),
    topokratyGateGroupTrainingOnly: occ(gateway, "resolveCategory(exercise) === \"group_training\""),
    topokratyGateOpenGame: occ(gateway, "[\"group_training\", \"open_game\"].includes(resolveCategory(exercise))"),
    courtWindowHelpers: occ(gateway, "lk1CourtMasterServices"),
    hourlyCourtPriceMinor: occ(gateway, "hourlyCourtPriceMinor"),
    courtMinutes: occ(gateway, "operation.lk1.decision.courtMinutes"),
    patriotsMoneyValidity: occ(gateway, "patriotsMoneyOnlyIdentity"),
    planRulesPatriots: occ(initialize, "\"planKey\":\"patriots\""),
    evaluatorCourtBranch: occ(evaluator, "COURT_HOURLY_COPAY"),
    previewCourtQuote: occ(previewRouter, "COURT_HOURLY_COPAY"),
    hubStepsMarker: occ(gateway, "// HUB_STEPS"),
  },
  anchorUniqueness: {
    gatewayLiveFuncSha256: [occ(gateway, LK1_TRAIN_G1_TARGET.liveFuncSha256)],
    profileContinueAssignment: occ(gateway, 'ctx.step = "lk1_profile_continue";'),
    profileContinueHandler: occ(gateway, 'if (ctx.step === "lk1_profile_continue") {'),
    operationFindHandler: occ(gateway, 'if (ctx.step === "lk1_operation_find") {'),
    exerciseHandler: occ(gateway, 'if (ctx.step === "exercise") {'),
    quoteAssignment: occ(gateway, "      ctx.lk1 = quote;"),
    enforcedRuleAnchor: occ(gateway, "  const enforcedRule = selectedRule.matched && !selectedRule.legacy;\n"),
    courtQuoteAnchor: occ(gateway, "  target.basePriceMinor = proof.amountMinor;\n  if (proof.kind === \"EVENT_ONE_TIME\") target.priceProductId = proof.productId;\n"),
    usageGameMinutesAnchor: occ(gateway, "    const minutes = operation.lk1.decision.gameMinutes;"),
    usageClubFreeAnchor: occ(gateway, "          if (!Number.isSafeInteger(free) || free !== duration || free > ctx.lk1.rule.freeGameMinutesPerDay\n"),
  },
  g1: {
    upstreamFlowSha256: LK1_TRAIN_G1_UPSTREAM_SHA256,
    candidateSha256: LK1_TRAIN_G1_POSTIMAGE_SHA256,
    preimageNodeSha256: LK1_TRAIN_G1_PREIMAGE_NODE_SHA256,
    postimageNodeSha256: LK1_TRAIN_G1_POSTIMAGE_NODE_SHA256,
    gatewayFunc: { before: LK1_TRAIN_G1_TARGET.liveFuncSha256, after: LK1_TRAIN_G1_TARGET.patchedFuncSha256 },
    gatewayInitialize: { before: LK1_TRAIN_G1_TARGET.liveInitializeSha256, after: LK1_TRAIN_G1_TARGET.patchedInitializeSha256 },
    usageBlock: { before: usageBlock(gateway), after: g1.gateway.usageBlockSha256 },
    revertCandidateSha256: LK1_TRAIN_G1_REVERT_POSTIMAGE_SHA256,
    revertInitializeSha256: LK1_TRAIN_G1_REVERT_INITIALIZE_SHA256,
    reviewedFragmentPins: {
      gateway: LK1_TRAIN_G1_REVIEWED_GATEWAY_SHA256, hooks: LK1_TRAIN_G1_REVIEWED_HOOKS_SHA256,
      courtQuoteBlock: LK1_TRAIN_G1_COURT_QUOTE_BLOCK_SHA256,
      usageCourtMinutes: LK1_TRAIN_G1_USAGE_COURT_MINUTES_SHA256,
      usageClubFree: LK1_TRAIN_G1_USAGE_CLUB_FREE_SHA256,
      clubGate: LK1_TRAIN_G1_REVIEWED_CLUB_GATE_SHA256,
      patriotsGuard: LK1_TRAIN_G1_REVIEWED_PATRIOTS_GUARD_SHA256,
      clubMoneyMandateBranch: LK1_TRAIN_G1_CLUB_COPAY_BLOCK_SHA256,
      continuation: LK1_TRAIN_G1_CONTINUATION_SHA256,
    },
  },
  g2: {
    upstreamFlowSha256: LK1_TRAIN_G1_POSTIMAGE_SHA256,
    candidateSha256: LK1_TRAIN_G2_POSTIMAGE_SHA256,
    compositionCandidateSha256: g2.candidateSha256,
    evaluator: { before: LK1_TRAIN_G2_TARGET.liveEvaluatorFuncSha256, node: LK1_TRAIN_G2_TARGET.patchedEvaluatorFuncSha256 },
    previewEvaluate: { before: LK1_TRAIN_G2_TARGET.livePreviewEvaluateFuncSha256, node: LK1_TRAIN_G2_TARGET.patchedPreviewEvaluateFuncSha256 },
    previewRouter: { before: LK1_TRAIN_G2_TARGET.livePreviewRouterFuncSha256, node: LK1_TRAIN_G2_TARGET.patchedPreviewRouterFuncSha256 },
    g1GatewayFunc: LK1_TRAIN_G2_TARGET.gatewayFuncSha256,
    g1UsageBlock: LK1_TRAIN_G2_TARGET.usageBlockSha256,
    pricingFunc: LK1_TRAIN_G2_TARGET.pricingFuncSha256,
    joinFunc: LK1_TRAIN_G2_TARGET.joinFuncSha256,
  },
  crossGeneration: {
    note: "Pins of the other focused generations after the 2026-10-05 body. `derived` means the "
      + "value is proven from the snapshot or the reviewed sources; `not-derivable` means the "
      + "generation refuses on this snapshot and re-pinning without re-authoring would leave a "
      + "fail-closed but misleading patcher (preparation-branch finding, unchanged).",
    hubPreimages: {
      split: { value: field(flow, "8f7bd5b482fe9763", "func"), state: "derived (unchanged)" },
      gateway: { value: field(flow, "lk_subscription_booking_router_20260804", "func"), state: "derived" },
      finalize: { value: field(flow, "lk_subscription_booking_finalize_20260804", "func"), state: "derived" },
      evaluator: { value: field(flow, "lk_subscription_managed_policy_20260820", "func"), state: "derived" },
      note: "composeHubFlow still refuses: the 2026-10-05 body is not the HUB body.",
    },
    previewCanonicalSourceSha256: {
      booking: { value: field(flow, "lk_subscription_booking_router_20260804", "func"), state: "derived" },
      evaluator: { value: field(flow, "lk_subscription_managed_policy_20260820", "func"), state: "derived" },
      pricing: { value: field(flow, "8f7bd5b482fe9763", "func"), state: "derived (unchanged)" },
      join: { value: field(flow, "e92e68bf3f08a70c", "func"), state: "derived (unchanged)" },
    },
    topic: {
      topokratyCopayApplied: { value: null, state: "not-derivable: the co-pay generation refuses on this snapshot" },
      planRulesTargetsPatched: { value: null, state: "not-derivable: the plan-rules gateway body is already patched" },
      eventQuotesPreviewFinalPatched: { value: sha(read("scripts/nodered_subscription_price_preview_nodes/final.js")), state: "derived (equals the reviewed final.js)" },
      patriotsReviewedSourceRepin: {
        value: { gateway: LK1_TRAIN_G1_REVIEWED_GATEWAY_SHA256, hooks: LK1_TRAIN_G1_REVIEWED_HOOKS_SHA256,
          evaluator: sha(read("scripts/nodered_lk1_hub_nodes/evaluator.js")) },
        state: "derived and committed (owner decision 2026-10-05)",
      },
      patriotsPostimageGatewayInitialize: { value: LK1_TRAIN_G1_TARGET.patchedInitializeSha256,
        state: "derived: identical to G1's initialize postimage" },
    },
  },
};
fs.writeFileSync(path.join(HERE, "..", "pin-derivation.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ wrote: path.join(HERE, "..", "pin-derivation.json"),
  g1: result.g1.candidateSha256, g2: result.g2.candidateSha256 }, null, 2));
