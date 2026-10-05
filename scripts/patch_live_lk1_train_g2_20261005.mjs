#!/usr/bin/env node

// Focused generation G2 of the 2026-10-05 LK1 train for server 147.
//
// G2 stacks the reviewed *content* of the train on G1's postimage (`99b5d5b5…`, see
// `patch_live_lk1_train_g1_20261005.mjs`). It is the composition the preparation branch already
// produced as `0da79aa8…` on the raw snapshot, re-derived here because
// G1 changes the booking gateway and its shared allowance block, which the price preview embeds
// byte-for-byte:
//   1. `lk_subscription_managed_policy_20260820.func` — the embedded LK1 evaluator is replaced by
//      the reviewed evaluator (club court-hourly co-pay for directions 6233/6180 plus the Patriots
//      money-validity branch the G1 gateway guard feeds);
//   2. `lk_subscription_price_preview_20260908_evaluate.func` — the same reviewed evaluator;
//   3. `lk_subscription_price_preview_20260908_router.func` — recomposed from the reviewed preview
//      sources over the G1 allowance block, with the reviewed Topokraty module injected (the
//      reviewed router body already carries the exclusion refusal, so only the module is prepended).
//
// Preparation only: nothing is deployed, imported or restarted, and the generation fails closed
// unless the preimage is exactly G1's postimage with the pinned field shas.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { patchTopokratyEvaluatorBody } from "./patch_live_lk1_topokraty_friendship_hotfix.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const LK1_TRAIN_G2_DEPLOYMENT_ID = "lk1-train-g2";
export const LK1_TRAIN_G2_KIND = "FOCUSED_LK1_TRAIN_G2_V1";

// G1's postimage is the reviewed preimage of G2.
export const LK1_TRAIN_G2_UPSTREAM_SHA256 =
  "99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3";
export const LK1_TRAIN_G2_SOURCE_NODE_COUNT = 4815;

export const LK1_TRAIN_G2_NODES = Object.freeze({
  gateway: "lk_subscription_booking_router_20260804",
  evaluator: "lk_subscription_managed_policy_20260820",
  previewEvaluate: "lk_subscription_price_preview_20260908_evaluate",
  previewRouter: "lk_subscription_price_preview_20260908_router",
  pricing: "8f7bd5b482fe9763",
  join: "e92e68bf3f08a70c",
});

export const LK1_TRAIN_G2_TARGET = Object.freeze({
  // G1's postimage fields the preview composition pins.
  gatewayFuncSha256: "7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4",
  usageBlockSha256: "2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813",
  pricingFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  // Installed preimages (unchanged by G1).
  liveEvaluatorFuncSha256: "2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602",
  liveEvaluatorEmbeddedSha256: "ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3",
  livePreviewEvaluateFuncSha256: "2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602",
  livePreviewEvaluateEmbeddedSha256: "ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3",
  livePreviewRouterFuncSha256: "43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70",
  // Composed postimages.
  patchedEvaluatorFuncSha256: "e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1",
  patchedPreviewEvaluateFuncSha256: "e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1",
  patchedPreviewRouterFuncSha256: "0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221",
});

// The composed G2 postimage; the G2 rollback refuses any other applied flow and restores G1's
// candidate (`LK1_TRAIN_G2_UPSTREAM_SHA256`) with a sha readback.
export const LK1_TRAIN_G2_POSTIMAGE_SHA256 =
  "0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin === "PENDING_COMPOSITION") return;
  if (sha256(body) !== pin) throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
}

function usageBlockSha(body) {
  const start = body.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const end = body.indexOf('if (ctx.step === "lk1_policy_decision") {');
  if (start < 0 || end <= start) throw new Error("Usage block is absent from the gateway body");
  return sha256(body.slice(start, end));
}

/** Composes the G2 candidate on G1's postimage; fails closed on any preimage, shape or graph drift. */
export function composeLk1TrainG2Artifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? LK1_TRAIN_G2_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`G1 postimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("G1 postimage is not a node array");
  if (flow.length !== LK1_TRAIN_G2_SOURCE_NODE_COUNT) {
    throw new Error(`G1 postimage node count drift: ${flow.length} != ${LK1_TRAIN_G2_SOURCE_NODE_COUNT}`);
  }
  const gateway = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G2_NODES.gateway),
    LK1_TRAIN_G2_NODES.gateway);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G2_NODES.evaluator),
    LK1_TRAIN_G2_NODES.evaluator);
  const previewEvaluate = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G2_NODES.previewEvaluate),
    LK1_TRAIN_G2_NODES.previewEvaluate);
  const previewRouter = assertFunctionNode(flow.find((node) => node.id === LK1_TRAIN_G2_NODES.previewRouter),
    LK1_TRAIN_G2_NODES.previewRouter);
  if (sha256(gateway.func) !== LK1_TRAIN_G2_TARGET.gatewayFuncSha256) {
    throw new Error("G2 must stack on the pinned G1 gateway body");
  }
  if (usageBlockSha(gateway.func) !== LK1_TRAIN_G2_TARGET.usageBlockSha256) {
    throw new Error("G2 must stack on the pinned G1 allowance block");
  }
  const target = options.assertPostimages === false
    ? { ...LK1_TRAIN_G2_TARGET, patchedPreviewRouterFuncSha256: "PENDING_COMPOSITION" }
    : LK1_TRAIN_G2_TARGET;
  const before = {
    evaluator: sha256(evaluator.func),
    previewEvaluate: sha256(previewEvaluate.func),
    previewRouter: sha256(previewRouter.func),
  };
  const evaluatorShape = JSON.parse(JSON.stringify({ ...evaluator, func: null }));
  const previewEvaluateShape = JSON.parse(JSON.stringify({ ...previewEvaluate, func: null }));
  const previewRouterShape = JSON.parse(JSON.stringify({ ...previewRouter, func: null }));
  evaluator.func = patchTopokratyEvaluatorBody(evaluator.func, {
    liveEvaluatorFuncSha256: target.liveEvaluatorFuncSha256,
    liveEmbeddedSha256: target.liveEvaluatorEmbeddedSha256,
  });
  previewEvaluate.func = patchTopokratyEvaluatorBody(previewEvaluate.func, {
    liveEvaluatorFuncSha256: target.livePreviewEvaluateFuncSha256,
    liveEmbeddedSha256: target.livePreviewEvaluateEmbeddedSha256,
  });
  assertPostimage(evaluator.func, target.patchedEvaluatorFuncSha256, "G2 evaluator");
  assertPostimage(previewEvaluate.func, target.patchedPreviewEvaluateFuncSha256, "G2 preview evaluate");
  const composed = previewSources(flow, {
    pins: {
      booking: sha256(gateway.func),
      evaluator: sha256(evaluator.func),
      pricing: target.pricingFuncSha256,
      join: target.joinFuncSha256,
    },
    installedUsageSha256: target.usageBlockSha256,
  });
  if (!composed.router.includes("canonical.resolveLk1Rule")) {
    throw new Error("Composed preview body cannot reach the shared plan-rules resolver");
  }
  if (!composed.router.includes("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE")) {
    throw new Error("Composed preview body lost the reviewed Topokraty exclusion");
  }
  // The reviewed preview sources already carry the Topokraty module inside the helper closure
  // (the exclusion refusal calls `isTopokratyExercise`/`isTopokratyClubPack`), so the recomposed
  // router is the composed body verbatim: no module is prepended twice.
  previewRouter.func = composed.router;
  if (previewRouter.func.split("function isTopokratyExercise(value) {").length !== 2
    || previewRouter.func.split("function isTopokratyClubPack(").length !== 2) {
    throw new Error("The Topokraty module must enter the preview exactly once");
  }
  if (previewRouter.func.split("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE").length !== 2) {
    throw new Error("The Topokraty refusal must enter the preview exactly once");
  }
  if (JSON.stringify({ ...evaluator, func: null }) !== JSON.stringify(evaluatorShape)
    || JSON.stringify({ ...previewEvaluate, func: null }) !== JSON.stringify(previewEvaluateShape)
    || JSON.stringify({ ...previewRouter, func: null }) !== JSON.stringify(previewRouterShape)) {
    throw new Error("A G2 node changed a field other than func");
  }
  assertFunctionBody(evaluator.func, "G2 evaluator");
  assertFunctionBody(previewEvaluate.func, "G2 preview evaluate");
  assertFunctionBody(previewRouter.func, "G2 preview router");
  assertPostimage(previewRouter.func, target.patchedPreviewRouterFuncSha256, "G2 preview router");
  const changes = [
    { id: LK1_TRAIN_G2_NODES.evaluator, fields: ["func"],
      func: { beforeSha256: before.evaluator, afterSha256: sha256(evaluator.func) } },
    { id: LK1_TRAIN_G2_NODES.previewEvaluate, fields: ["func"],
      func: { beforeSha256: before.previewEvaluate, afterSha256: sha256(previewEvaluate.func) } },
    { id: LK1_TRAIN_G2_NODES.previewRouter, fields: ["func"],
      func: { beforeSha256: before.previewRouter, afterSha256: sha256(previewRouter.func) } },
  ];
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: LK1_TRAIN_G2_DEPLOYMENT_ID,
    allowedChanges: changes.map((row) => ({ id: row.id, fields: [...row.fields] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    evaluator: {
      id: LK1_TRAIN_G2_NODES.evaluator,
      courtBranchBound: evaluator.func.includes("COURT_HOURLY_COPAY"),
      courtRefusalBound: evaluator.func.includes("LK1_COURT_PRICE_UNRESOLVED"),
      patriotsBranchBound: evaluator.func.includes("PATRIOTS_FRIENDSHIP_PRODUCT_ID"),
    },
    preview: {
      id: LK1_TRAIN_G2_NODES.previewRouter,
      courtWindowStepBound: previewRouter.func.includes("if (ctx.step === 'courtWindow') {"),
      courtQuoteBound: previewRouter.func.includes("COURT_HOURLY_COPAY"),
      topokratyExclusionKept: previewRouter.func.includes("isTopokratyClubPack(topokratyClubRow)"),
      proTrainingKept: previewRouter.func.includes("canonical.isProTrainingExercise"),
      resolverReachable: composed.router.includes("canonical.resolveLk1Rule"),
      helperCount: composed.helperNames.length,
    },
  };
}

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildLk1TrainG2Report({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: LK1_TRAIN_G2_KIND, deploymentId: LK1_TRAIN_G2_DEPLOYMENT_ID,
    targets: {
      evaluator: { id: LK1_TRAIN_G2_NODES.evaluator,
        func: { beforeSha256: LK1_TRAIN_G2_TARGET.liveEvaluatorFuncSha256,
          afterSha256: built.changes[0].func.afterSha256 } },
      previewEvaluate: { id: LK1_TRAIN_G2_NODES.previewEvaluate,
        func: { beforeSha256: LK1_TRAIN_G2_TARGET.livePreviewEvaluateFuncSha256,
          afterSha256: built.changes[1].func.afterSha256 } },
      previewRouter: { id: LK1_TRAIN_G2_NODES.previewRouter,
        func: { beforeSha256: LK1_TRAIN_G2_TARGET.livePreviewRouterFuncSha256,
          afterSha256: built.changes[2].func.afterSha256 } },
    },
    upstreamFlowSha256: LK1_TRAIN_G2_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 3, addedNodeCount: 0,
    changes: built.changes, evaluator: built.evaluator, preview: built.preview,
    gatewayPostimageSha256: LK1_TRAIN_G2_TARGET.gatewayFuncSha256,
    usageBlockSha256: LK1_TRAIN_G2_TARGET.usageBlockSha256,
    planRulesActivation: null,
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
}

// --- CLI --------------------------------------------------------------------

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
  const usage = "Usage: --workspace <g1-postimage-workspace> --output <candidate.json> --report <report.json>";
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail(usage); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) { fail(usage); return; }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeLk1TrainG2Artifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("G1 postimage changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = buildLk1TrainG2Report({ sourceSha256: verified.sourceSha256,
    sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`LK1 train G2 generation failed: ${error.message}`);
  }
}
