#!/usr/bin/env node

// Focused Node-RED generation: name the two event-route refusals that are still
// producing 503s, so the final rule can be written from evidence instead of a guess.
//
// After `lk1-event-quotes` the refusals are no longer anonymous, and two of them need
// one more field of evidence each:
//   * `LK1_EVENT_TARIFF_UNVERIFIED` refuses with `stage: "product_amount"` — the Viva
//     one-times DTO carries several amount fields and the current rule requires all of
//     them to be equal. The refusal now names *which* fields are present, how many
//     distinct values they carry and how many of them are zero; no amount itself is
//     copied into the response.
//   * `PRICE_PREVIEW_DECISION_UNRESOLVED` now names the evaluator blocker codes that
//     the preview does not map.
//
// One node, one field: `lk_subscription_price_preview_20260908_router.func`. The accept
// and reject decisions are unchanged; only the refusal detail grows. Nothing is
// deployed, imported or restarted here, and the patcher fails closed unless the supplied
// preimage is exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewSources, assertCanonicalExports } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const EVENT_DIAGNOSTICS_DEPLOYMENT_ID = "lk1-event-diagnostics";
export const EVENT_DIAGNOSTICS_KIND = "FOCUSED_LK1_EVENT_DIAGNOSTICS_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-15 after `lk1-event-quotes`
// (4804 nodes, sha256 1e4224ea…).
export const EVENT_DIAGNOSTICS_SOURCE_SHA256 =
  "1e4224ea7ef6857a64011ae8ba84fe82837ef1285a7e88961a32f60919d69266";
export const EVENT_DIAGNOSTICS_SOURCE_NODE_COUNT = 4804;

export const EVENT_DIAGNOSTICS_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
export const EVENT_DIAGNOSTICS_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const EVENT_DIAGNOSTICS_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

export const EVENT_DIAGNOSTICS_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "44073942212be41c0726aa0e073181b9796d6f41da022db893557df5174eacc9",
  evaluatorFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "98229c7224fe81c3856071523307514b8df914440c8bf03a159a2e9a5c72fd8b",
});

export const EVENT_DIAGNOSTICS_TARGET = Object.freeze({
  id: EVENT_DIAGNOSTICS_ROUTER_ID,
  liveFuncSha256: "9b4f69b5bd613d7e6072068c49d6d3e80f2ef8b7896846b522d1a615950c07fa",
  patchedFuncSha256: "6bbae1f64480fa9b22c3ca434157af8ea9447b7b486f2699f445bfb776b97331",
});

const ROUTER_MARKERS = Object.freeze([
  "paidFields, paidDistinct",
  "paidZero",
  "tariffRefusal('product_trial_amount'",
  "ctx.errorDetails = { stage: 'decision_blockers',",
  "tariffRefusal('product_amount'",
  "const UNAVAILABLE_DECISION_BLOCKERS = ",
]);
// The superseded refusal shapes this generation replaces.
const ROUTER_ABSENT_MARKERS = Object.freeze([
  "const amounts = [product.cost, product.price, product.amount, product.trialCost].filter((amount) => amount !== undefined);",
  "else return stop('PRICE_PREVIEW_DECISION_UNRESOLVED');",
]);

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

export function composeLk1EventDiagnosticsArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? EVENT_DIAGNOSTICS_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== EVENT_DIAGNOSTICS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${EVENT_DIAGNOSTICS_SOURCE_NODE_COUNT}`);
  }
  const generation = EVENT_DIAGNOSTICS_INSTALLED_GENERATION;
  const target = EVENT_DIAGNOSTICS_TARGET;
  const router = assertFunctionNode(flow.find((node) => node.id === target.id), target.id);
  const booking = assertFunctionNode(flow.find((node) => node.id === EVENT_DIAGNOSTICS_BOOKING_ID),
    EVENT_DIAGNOSTICS_BOOKING_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === EVENT_DIAGNOSTICS_EVALUATOR_ID),
    EVENT_DIAGNOSTICS_EVALUATOR_ID);
  for (const [label, actual, pin] of [
    ["Preview router", sha256(router.func), target.liveFuncSha256],
    ["Booking gateway", sha256(booking.func), generation.bookingFuncSha256],
    ["Evaluator", sha256(evaluator.func), generation.evaluatorFuncSha256],
  ]) {
    if (actual !== pin) throw new Error(`${label} installed preimage drift: ${actual} != ${pin}`);
  }
  const routerBefore = JSON.parse(JSON.stringify({ ...router, func: null }));

  const composed = previewSources(flow, {
    pins: {
      booking: generation.bookingFuncSha256,
      evaluator: generation.evaluatorFuncSha256,
      pricing: generation.splitFuncSha256,
      join: generation.joinFuncSha256,
    },
    installedUsageSha256: generation.allowanceBlockSha256,
  });
  assertCanonicalExports(composed.router, composed.exportedNames);
  for (const marker of ROUTER_MARKERS) {
    if ((composed.router.split(marker).length - 1) !== 1) {
      throw new Error(`Composed preview router is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of ROUTER_ABSENT_MARKERS) {
    if (composed.router.includes(marker)) {
      throw new Error(`Composed preview router still carries the superseded refusal: ${marker}`);
    }
  }
  assertFunctionBody(composed.router, "Composed preview router body");
  const digest = sha256(composed.router);
  if (digest !== target.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  router.func = composed.router;
  if (JSON.stringify({ ...router, func: null }) !== JSON.stringify(routerBefore)) {
    throw new Error("Preview router changed a field other than func");
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: target.id, fields: ["func"],
    func: { beforeSha256: target.liveFuncSha256, afterSha256: digest } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: target.id, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    preview: { routerId: target.id, exportedNameCount: composed.exportedNames.length,
      eventHelpersPublished: ["identityMoneyOwned", "lk1LifecycleInstant", "managedExternalEventTypeId"]
        .every((name) => composed.exportedNames.includes(name)),
      otherFieldsUnchanged: true },
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

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
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
      return;
    }
    if (values[key] !== undefined) {
      fail(`Duplicate argument: ${key}`);
      return;
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
    return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeLk1EventDiagnosticsArtifacts(liveBytes, EVENT_DIAGNOSTICS_DEPLOYMENT_ID, {
    expectedSourceSha256: EVENT_DIAGNOSTICS_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: EVENT_DIAGNOSTICS_KIND,
    deploymentId: EVENT_DIAGNOSTICS_DEPLOYMENT_ID,
    targets: {
      previewRouter: { id: EVENT_DIAGNOSTICS_TARGET.id,
        func: { beforeSha256: EVENT_DIAGNOSTICS_TARGET.liveFuncSha256,
          afterSha256: EVENT_DIAGNOSTICS_TARGET.patchedFuncSha256 } },
    },
    installedGeneration: { ...EVENT_DIAGNOSTICS_INSTALLED_GENERATION },
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 1,
    addedNodeCount: built.addedNodeCount,
    changes: built.changes,
    preview: built.preview,
    topologyChanged: false, routesChanged: false, policyChanged: false,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
