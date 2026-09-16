#!/usr/bin/env node

// Focused Node-RED hotfix generation: restore the three event-route helpers the
// released preview body stopped publishing.
//
// Production incident: the 2026-09-15 plan-rules release (flows sha256 95ff37df…)
// rewrote `lk_subscription_price_preview_20260908_router` through
// `previewSources()`, whose root list did not name `identityMoneyOwned`,
// `lk1LifecycleInstant` and `managedExternalEventTypeId`. The closure kept the
// definitions but no longer exported them, so the router's first guard
// (`typeof canonical.identityMoneyOwned !== 'function'`) answered every group
// training and tournament quote with 503 `GROUP_DISCOUNT_BACKEND_NOT_READY` /
// `TOURNAMENT_DISCOUNT_BACKEND_NOT_READY` from 19:06 MSK on.
//
// The generation is exactly one node and one field:
//   * `lk_subscription_price_preview_20260908_router.func` — the same reviewed
//     composition, with the three event-route helpers named as extraction roots.
//     Nothing else in the flow changes; the booking gateway, the evaluator and the
//     plan-rules activation stay exactly as installed.
//
// This is preparation only. It never deploys, imports, restarts or activates
// anything, and it fails closed unless the supplied preimage is exactly the
// reviewed live flow (whole-flow sha256 plus every node body it reads).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalReferences, previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const PREVIEW_EXPORTS_DEPLOYMENT_ID = "lk1-preview-event-helpers";
export const PREVIEW_EXPORTS_KIND = "FOCUSED_LK1_PREVIEW_EVENT_HELPERS_HOTFIX_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-15 after the plan-rules
// release (`/root/.node-red/flows.json`, 4804 nodes, sha256 95ff37df…). A live
// change must never be absorbed silently: it requires a conscious re-review of
// every pin below.
export const PREVIEW_EXPORTS_SOURCE_SHA256 =
  "95ff37dffbb3608321a6d255afe5f5a6b2e833b2ff0471449340fe1965f46c2a";
export const PREVIEW_EXPORTS_SOURCE_NODE_COUNT = 4804;

export const PREVIEW_EXPORTS_NODE_ID = "lk_subscription_price_preview_20260908_router";
export const PREVIEW_EXPORTS_BOOKING_NODE_ID = "lk_subscription_booking_router_20260804";
export const PREVIEW_EXPORTS_EVALUATOR_NODE_ID = "lk_subscription_managed_policy_20260820";

// The three helpers the event route reaches through `canonical.*`, and the marker
// that proves the plan-rules resolver is still reachable after the fix.
export const PREVIEW_EVENT_HELPER_NAMES = Object.freeze(
  ["identityMoneyOwned", "lk1LifecycleInstant", "managedExternalEventTypeId"]);
const PREVIEW_PATCH_MARKER = "canonical.resolveLk1Rule";

export const PREVIEW_EXPORTS_TARGETS = Object.freeze({
  preview: {
    id: PREVIEW_EXPORTS_NODE_ID,
    // sha256 of the exact installed preview body (the broken generation).
    liveFuncSha256: "64f67bad58bd3add870bd3c6012c5f1c9c9256338b23c5a6295cefefc5811856",
    // sha256 of the same composition with the three helpers named as roots.
    patchedFuncSha256: "d2d8b5a495ea01691c5f35a9f80afbffdee543dfeb5c8a9acb23a6c66a663009",
  },
});

// The installed generation the composition must be fed instead of line C's
// reviewed preimage defaults: the booking gateway and evaluator of the plan-rules
// release, the split/join bodies of the split-nominal-share release, and the
// installed allowance block (paid-visit recompute + AUDIT_BINDING).
export const PREVIEW_EXPORTS_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "ed59d29ecb8af6d917e941b2a5d302c8124024a4ce12b450232206088247a88d",
  evaluatorFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "98229c7224fe81c3856071523307514b8df914440c8bf03a159a2e9a5c72fd8b",
});

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
    // A Node-RED function body must stay parseable with the host arguments.
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

/**
 * The exact production defect, stated as a postcondition of the composition: the
 * generated closure publishes every `canonical.*` the router reaches, and the three
 * event-route helpers are callable. Asserted on the generated source, not on a
 * re-derived copy.
 */
export function assertEventHelpersPublished(body, exportedNames) {
  const scope = new Function("global",
    `${body.slice(0, body.indexOf("\nconst pricing"))}\nreturn canonical;`)({ get: () => null });
  for (const name of PREVIEW_EVENT_HELPER_NAMES) {
    if (typeof scope[name] !== "function") {
      throw new Error(`Composed preview does not publish canonical.${name}`);
    }
  }
  const missing = canonicalReferences(body).filter((name) => !exportedNames.includes(name));
  if (missing.length) {
    throw new Error(`Composed preview closure is missing referenced helpers: ${missing.join(", ")}`);
  }
  return scope;
}

export function composeLk1PreviewExportsArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expectedSourceSha256 = options.expectedSourceSha256 ?? PREVIEW_EXPORTS_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== PREVIEW_EXPORTS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PREVIEW_EXPORTS_SOURCE_NODE_COUNT}`);
  }
  const target = PREVIEW_EXPORTS_TARGETS.preview;
  const generation = PREVIEW_EXPORTS_INSTALLED_GENERATION;
  const preview = assertFunctionNode(flow.find((node) => node.id === target.id), target.id);
  const gateway = assertFunctionNode(flow.find((node) => node.id === PREVIEW_EXPORTS_BOOKING_NODE_ID),
    PREVIEW_EXPORTS_BOOKING_NODE_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === PREVIEW_EXPORTS_EVALUATOR_NODE_ID),
    PREVIEW_EXPORTS_EVALUATOR_NODE_ID);
  for (const [label, actual, expected] of [
    ["Booking gateway", sha256(gateway.func), generation.bookingFuncSha256],
    ["Evaluator", sha256(evaluator.func), generation.evaluatorFuncSha256],
    ["Preview", sha256(preview.func), target.liveFuncSha256],
  ]) {
    if (actual !== expected) throw new Error(`${label} installed preimage drift: ${actual} != ${expected}`);
  }
  if (preview.func.includes(PREVIEW_PATCH_MARKER) === false) {
    throw new Error("Installed preview body cannot reach the shared plan-rules resolver");
  }
  // Everything except `func` must survive the delta byte for byte.
  const previewNodeBefore = JSON.parse(JSON.stringify({ ...preview, func: null }));

  const composed = previewSources(flow, {
    pins: {
      booking: generation.bookingFuncSha256,
      evaluator: generation.evaluatorFuncSha256,
      pricing: generation.splitFuncSha256,
      join: generation.joinFuncSha256,
    },
    installedUsageSha256: generation.allowanceBlockSha256,
  });
  if (!composed.router.includes(PREVIEW_PATCH_MARKER)) {
    throw new Error("Composed preview body cannot reach the shared plan-rules resolver");
  }
  assertEventHelpersPublished(composed.router, composed.exportedNames);
  assertFunctionBody(composed.router, "Composed preview body");
  const composedSha256 = sha256(composed.router);
  if (composedSha256 !== target.patchedFuncSha256) {
    throw new Error(`Preview postimage drift: ${composedSha256} != ${target.patchedFuncSha256}`);
  }

  preview.func = composed.router;
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{
    id: target.id,
    fields: ["func"],
    func: { beforeSha256: target.liveFuncSha256, afterSha256: composedSha256 },
  }];
  const contract = buildExactGraphContract({
    liveBytes: bytes,
    candidateBytes,
    deploymentId,
    allowedChanges: [{ id: target.id, fields: ["func"] }],
    allowedAdditionIds: [],
  });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow,
    candidateBytes,
    contract,
    changes,
    eventHelpers: [...PREVIEW_EVENT_HELPER_NAMES],
    exportedNameCount: composed.exportedNames.length,
    previewNode: {
      id: target.id,
      fields: ["func"],
      initializeUnchanged: preview.initialize === previewNodeBefore.initialize,
      // Every field other than `func` (wires, z, outputs, name, …) is untouched.
      otherFieldsUnchanged: JSON.stringify({ ...preview, func: null }) === JSON.stringify(previewNodeBefore),
      resolverReachable: preview.func.includes(PREVIEW_PATCH_MARKER),
      eventHelpersPublished: [...PREVIEW_EVENT_HELPER_NAMES],
    },
    addedNodeCount: 0,
    sourceSha256,
    candidateSha256: sha256(candidateBytes),
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
  const built = composeLk1PreviewExportsArtifacts(liveBytes, PREVIEW_EXPORTS_DEPLOYMENT_ID, {
    expectedSourceSha256: PREVIEW_EXPORTS_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const outputText = built.candidateBytes.toString("utf8");
  const report = {
    kind: PREVIEW_EXPORTS_KIND,
    deploymentId: PREVIEW_EXPORTS_DEPLOYMENT_ID,
    targets: {
      preview: {
        id: PREVIEW_EXPORTS_TARGETS.preview.id,
        func: { beforeSha256: PREVIEW_EXPORTS_TARGETS.preview.liveFuncSha256,
          afterSha256: PREVIEW_EXPORTS_TARGETS.preview.patchedFuncSha256 },
      },
    },
    installedGeneration: { ...PREVIEW_EXPORTS_INSTALLED_GENERATION },
    eventHelpers: built.eventHelpers,
    installedExportedNameCount: built.exportedNameCount,
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 1,
    addedNodeCount: built.addedNodeCount,
    changes: built.changes,
    previewNode: built.previewNode,
    previewNodeId: PREVIEW_EXPORTS_NODE_ID,
    topologyChanged: false,
    routesChanged: false,
    policyChanged: false,
    deploymentPerformed: false,
    liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
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
