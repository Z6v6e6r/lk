#!/usr/bin/env node

// Focused Node-RED generation: name the sub-condition behind the two anonymous target
// refusals of the subscription price preview, so the next rule is written from evidence
// instead of a guess.
//
// 2026-09-17 incident: 47 client-visible `PRICE_PREVIEW_GAME_UNRESOLVED` between 15:00
// and 17:00 MSK (baseline 5-15/day) and a steady `GROUP_DISCOUNT_TARGET_UNRESOLVED` /
// `TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED` stream (22 + 8 that day, 10-18/day before) had
// no named cause in the response and no request body in the logs, so the failing
// sub-condition could only be reproduced, never observed. The four refusal sites below
// now answer with `error.details` naming the stage and the observed shape.
//
// The refusal payload carries booleans, counts, enum values, durations and Viva
// type/direction ids only: never an amount, a plan or client name, a phone or a booking
// identity. `final` already renders `error.details` (generation `lk1-event-quotes`), so no
// other node changes.
//
// One node, one field: `lk_subscription_price_preview_20260908_router.func`. The patcher
// proves the accept/reject decision is untouched: the refusal call sites (count and code
// expression of every `return stop(` / `return refuseWith(`) must be identical between the
// installed and the composed body. Nothing is deployed, imported or restarted here, and
// the patcher fails closed unless the supplied preimage is exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewSources, assertCanonicalExports } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const TARGET_DIAGNOSTICS_DEPLOYMENT_ID = "lk1-target-diagnostics";
export const TARGET_DIAGNOSTICS_KIND = "FOCUSED_LK1_TARGET_DIAGNOSTICS_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-17 after
// `lk1-confirmed-replay-guard` (`/root/.node-red/flows.json`, 4804 nodes, sha256
// 2c542977…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const TARGET_DIAGNOSTICS_SOURCE_SHA256 =
  "2c542977e2418956e94d8e232ecc21575cb017430f2431c997a2119b62b59511";
export const TARGET_DIAGNOSTICS_SOURCE_NODE_COUNT = 4804;

export const TARGET_DIAGNOSTICS_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
export const TARGET_DIAGNOSTICS_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const TARGET_DIAGNOSTICS_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

// The installed generation the preview composition must be fed. Measured on the preimage
// above: the free-first-event booking gateway, the free-first-event evaluator, the
// split/join bodies of the split-nominal-share release and the installed allowance block.
export const TARGET_DIAGNOSTICS_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "3920bb21323fd5023cd427b5e8a183f6a70909dafa88a6e39bfe02caf9076fe0",
  evaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// The reviewed postimages of this generation, measured on the preimage above.
export const TARGET_DIAGNOSTICS_TARGET = Object.freeze({
  id: TARGET_DIAGNOSTICS_ROUTER_ID,
  liveFuncSha256: "fc2f252743fdd9e95bd38554441f70fa4b2cee815a4ce0bddbcb67dbabd4bb82",
  patchedFuncSha256: "c316d6e1ced10afaff89078c30d4f47e453eb7abcc2c510575a4f731576d7fa7",
});

// The four stages this generation names, one per refusal site.
export const TARGET_DIAGNOSTICS_STAGES = Object.freeze([
  "event_target", "game_record", "game_metadata", "game_exercise",
]);

const ROUTER_MARKERS = Object.freeze([
  "const refuseWith = (code, details) => { ctx.errorDetails = details; return stop(code); };",
  "stage: 'event_target',",
  "stage: 'game_record',",
  "stage: 'game_metadata',",
  "stage: 'game_exercise',",
  // The sub-conditions that make a production refusal self-explaining.
  "externalEventTypeId: (exercise && canonical.managedExternalEventTypeId(exercise)) || null,",
  "startsInPast: Number.isFinite(start) ? start <= Date.now() : null,",
  "storedDurationMinutes: Number.isFinite(storedDuration) ? storedDuration : null,",
  "availableClientSubscriptions: Boolean(exercise) && Array.isArray(exercise.availableClientSubscriptions),",
]);
// The installed body carries neither the helper nor any stage name.
const INSTALLED_ABSENT_MARKERS = Object.freeze([
  "refuseWith(",
  ...TARGET_DIAGNOSTICS_STAGES.map((stage) => `stage: '${stage}',`),
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

// Every refusal site this generation adds detail to, by its first argument. All four
// sites (group/tournament target and the three game stages) use one of these two.
const TARGET_DIAGNOSTICS_REFUSAL_CODES = Object.freeze([
  "eventRoute.error + '_TARGET_UNRESOLVED'",
  "'PRICE_PREVIEW_GAME_UNRESOLVED'",
]);

/**
 * The composed body with this generation's additive details removed. The result must be
 * byte-identical to the installed body: that is the proof that the generation only
 * describes refusals that already happened and changes no condition, branch or code.
 */
export function stripTargetDiagnostics(body) {
  let out = body.replace(
    /\n\/\/ Additive diagnostics:[\s\S]*?const refuseWith = \(code, details\) => \{ ctx\.errorDetails = details; return stop\(code\); \};\n/,
    "\n");
  for (const code of TARGET_DIAGNOSTICS_REFUSAL_CODES) {
    const prefix = `refuseWith(${code}, {`;
    for (let at = out.indexOf(prefix); at !== -1; at = out.indexOf(prefix, at)) {
      const braceStart = at + prefix.length - 1;
      let depth = 0;
      let index = braceStart;
      for (; index < out.length; index += 1) {
        if (out[index] === "{") depth += 1;
        else if (out[index] === "}") { depth -= 1; if (depth === 0) break; }
      }
      if (depth !== 0) throw new Error("Diagnostic details block is not balanced");
      const endParen = out.indexOf(");", index);
      if (endParen === -1) throw new Error("Diagnostic details block has no call terminator");
      out = `${out.slice(0, at)}stop(${code});${out.slice(endParen + 2)}`;
    }
  }
  return out;
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

export function composeLk1TargetDiagnosticsArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? TARGET_DIAGNOSTICS_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== TARGET_DIAGNOSTICS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${TARGET_DIAGNOSTICS_SOURCE_NODE_COUNT}`);
  }
  const generation = TARGET_DIAGNOSTICS_INSTALLED_GENERATION;
  const target = TARGET_DIAGNOSTICS_TARGET;
  const router = assertFunctionNode(flow.find((node) => node.id === target.id), target.id);
  const booking = assertFunctionNode(flow.find((node) => node.id === TARGET_DIAGNOSTICS_BOOKING_ID),
    TARGET_DIAGNOSTICS_BOOKING_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === TARGET_DIAGNOSTICS_EVALUATOR_ID),
    TARGET_DIAGNOSTICS_EVALUATOR_ID);
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
  // Decision invariance: the diagnostics may only attach detail to refusals that already
  // existed. A new, moved or dropped refusal site fails the generation.
  const composedRefusals = refusalCallSites(composed.router);
  if (JSON.stringify(composedRefusals) !== JSON.stringify(installedRefusals)) {
    throw new Error("Refusal sites changed: the generation must not add, move or drop a refusal");
  }
  const digest = sha256(composed.router);
  if (digest !== target.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  // Diagnostics-only proof: with the added details stripped, the composed body must be
  // byte-identical to the installed generation.
  if (stripTargetDiagnostics(composed.router) !== router.func) {
    throw new Error("Composed preview router is not diagnostics-only: the stripped body differs from the installed one");
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
      diagnosticStages: [...TARGET_DIAGNOSTICS_STAGES],
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
  const built = composeLk1TargetDiagnosticsArtifacts(liveBytes, TARGET_DIAGNOSTICS_DEPLOYMENT_ID, {
    expectedSourceSha256: TARGET_DIAGNOSTICS_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: TARGET_DIAGNOSTICS_KIND,
    deploymentId: TARGET_DIAGNOSTICS_DEPLOYMENT_ID,
    targets: {
      previewRouter: { id: TARGET_DIAGNOSTICS_TARGET.id,
        func: { beforeSha256: TARGET_DIAGNOSTICS_TARGET.liveFuncSha256,
          afterSha256: TARGET_DIAGNOSTICS_TARGET.patchedFuncSha256 } },
    },
    installedGeneration: { ...TARGET_DIAGNOSTICS_INSTALLED_GENERATION },
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
