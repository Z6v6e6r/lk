#!/usr/bin/env node

// Focused Node-RED generation: an event that has already started stops answering 503 on the
// subscription price preview.
//
// 2026-09-17, measured on production: every refusal of the chronic `*_TARGET_UNRESOLVED`
// class (10-22 a day) carried `startsInPast: true` with the other eleven target conditions
// green - the cabinet asked for a subscription discount on a tournament or group training
// that had simply begun, and printed "Не удалось проверить скидку по подписке.".
//
// The twelve conditions are now named, the union is unchanged (the step refuses exactly
// where it refused before), and the one state the client can see for itself - a healthy
// target that already started - answers 200 with no quotes: no price is advertised, nothing
// becomes bookable, and the booking gateway keeps its own target-window validation. Every
// other anomaly stays a fail-closed 503 with its `error.details`.
//
// One node, one field: `lk_subscription_price_preview_20260908_router.func`. The patcher
// proves the refusal call sites are unchanged (count and code expression) and that the
// started branch is present; `scripts/tests/lk1TargetDiagnostics.test.mjs` additionally
// enumerates all 4096 combinations of the twelve conditions against the reviewed source and
// asserts the decision is identical to the original conjunction. Nothing is deployed,
// imported or restarted here, and the patcher fails closed unless the supplied preimage is
// exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewSources, assertCanonicalExports } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const EVENT_STARTED_DEPLOYMENT_ID = "lk1-event-started-unavailable";
export const EVENT_STARTED_KIND = "FOCUSED_LK1_EVENT_STARTED_UNAVAILABLE_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-17 after `lk1-target-diagnostics`
// and the parallel `annual-fingerprint-trim-20260917` (`/root/.node-red/flows.json`, 4804
// nodes, sha256 eca9e657…). A live change must never be absorbed silently: it requires a
// conscious re-review of every pin below.
export const EVENT_STARTED_SOURCE_SHA256 =
  "eca9e65708f6a5946c8bb3804cccfe4165ffa6fa9e5c4d8f4e78b2c66f3c233f";
export const EVENT_STARTED_SOURCE_NODE_COUNT = 4804;

export const EVENT_STARTED_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
export const EVENT_STARTED_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const EVENT_STARTED_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

// The installed generation the preview composition must be fed. Measured on the preimage
// above: the free-first-event booking gateway, the free-first-event evaluator, the
// split/join bodies of the split-nominal-share release and the installed allowance block.
export const EVENT_STARTED_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "3920bb21323fd5023cd427b5e8a183f6a70909dafa88a6e39bfe02caf9076fe0",
  evaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// The reviewed postimages of this generation, measured on the preimage above.
export const EVENT_STARTED_TARGET = Object.freeze({
  id: EVENT_STARTED_ROUTER_ID,
  liveFuncSha256: "c316d6e1ced10afaff89078c30d4f47e453eb7abcc2c510575a4f731576d7fa7",
  patchedFuncSha256: "1bd8d443e483512c4817f8c6c4850ebd50fb314482c072a5d18db7ae11d66de4",
});

const ROUTER_MARKERS = Object.freeze([
  "const targetChecks = {",
  "const targetHealthy = targetChecks.httpOk && targetChecks.resolved && targetChecks.idMatch",
  "if (!targetHealthy || !targetChecks.startsInFuture) {",
  "if (targetHealthy) {",
  "      ctx.quotes = [];\n      ctx.done = true;\n      ctx.statusCode = 200;",
  "startsInFuture: Number.isFinite(start) && start > Date.now(),",
  "return refuseWith(eventRoute.error + '_TARGET_UNRESOLVED', {",
]);
// The installed body still carries the single twelve-condition conjunction and has no
// client-visible answer for a started event.
const INSTALLED_ABSENT_MARKERS = Object.freeze([
  "const targetHealthy = ",
  "const targetChecks = {",
]);

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * Every refusal site of a router body as `<code expression>`, sorted. The extraction is
 * deliberately shape-based so it works on both the installed `return stop(code)` form and
 * the composed `return refuseWith(code, { ... })` form.
 */
export function refusalCallSites(body) {
  return body.split("\n")
    // The `refuseWith` definition itself contains `return stop(code)`; it is a helper,
    // not a refusal site.
    .filter((line) => !/=>\s*\{.*return (?:stop|refuseWith)\(/.test(line))
    .map((line) => line.match(/return (?:stop|refuseWith)\((.*?)(?:,\s*\{|\s*\))/))
    .filter(Boolean)
    .map((match) => match[1].trim())
    .sort();
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

export function composeLk1EventStartedArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? EVENT_STARTED_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== EVENT_STARTED_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${EVENT_STARTED_SOURCE_NODE_COUNT}`);
  }
  const generation = EVENT_STARTED_INSTALLED_GENERATION;
  const target = EVENT_STARTED_TARGET;
  const router = assertFunctionNode(flow.find((node) => node.id === target.id), target.id);
  const booking = assertFunctionNode(flow.find((node) => node.id === EVENT_STARTED_BOOKING_ID),
    EVENT_STARTED_BOOKING_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === EVENT_STARTED_EVALUATOR_ID),
    EVENT_STARTED_EVALUATOR_ID);
  for (const [label, actual, pin] of [
    ["Preview router", sha256(router.func), target.liveFuncSha256],
    ["Booking gateway", sha256(booking.func), generation.bookingFuncSha256],
    ["Evaluator", sha256(evaluator.func), generation.evaluatorFuncSha256],
  ]) {
    if (actual !== pin) throw new Error(`${label} installed preimage drift: ${actual} != ${pin}`);
  }
  const installedRefusals = refusalCallSites(router.func);
  if (installedRefusals.length < 4) {
    throw new Error(`Installed preview router exposes ${installedRefusals.length} refusal sites, expected at least 4`);
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
  for (const marker of INSTALLED_ABSENT_MARKERS) {
    if (router.func.includes(marker)) {
      throw new Error(`Installed preview router already carries the diagnostic marker: ${marker}`);
    }
  }
  assertFunctionBody(composed.router, "Composed preview router body");
  // Decision invariance: this generation may not add, move or drop a refusal. The exhaustive
  // combination test in `scripts/tests/lk1TargetDiagnostics.test.mjs` proves the twelve named
  // conditions accept, refuse and answer exactly where the original conjunction did.
  const composedRefusals = refusalCallSites(composed.router);
  if (JSON.stringify(composedRefusals) !== JSON.stringify(installedRefusals)) {
    throw new Error("Refusal sites changed: the generation must not add, move or drop a refusal");
  }
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
      refusalSites: composedRefusals.length, refusalSitesUnchanged: true,
      startedEventAnswersUnavailable: true,
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
  const built = composeLk1EventStartedArtifacts(liveBytes, EVENT_STARTED_DEPLOYMENT_ID, {
    expectedSourceSha256: EVENT_STARTED_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: EVENT_STARTED_KIND,
    deploymentId: EVENT_STARTED_DEPLOYMENT_ID,
    targets: {
      previewRouter: { id: EVENT_STARTED_TARGET.id,
        func: { beforeSha256: EVENT_STARTED_TARGET.liveFuncSha256,
          afterSha256: EVENT_STARTED_TARGET.patchedFuncSha256 } },
    },
    installedGeneration: { ...EVENT_STARTED_INSTALLED_GENERATION },
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
