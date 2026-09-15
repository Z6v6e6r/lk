#!/usr/bin/env node

// Focused Node-RED generation: the money-evidence refusal on the event route becomes
// self-describing (the deep-validity mandate was covered by lk1-money-validity).
//
// `lk1Stop(ctx, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN")` is what an annual-HUB holder
// sees when the gateway cannot prove the selected instance is valid for the event window
// (status, activation/expiry against the event start and end, hold/freeze, instance and
// owner identity). The refusal carried a bare code, so support could not tell which
// condition failed and the path had no test coverage at all — while the live evidence
// shows the managed money path is exercised (HUB operations confirmed) and the refusal
// itself no longer fires.
//
// Two reviewed deltas on `lk_subscription_booking_router_20260804`:
//   1. `lk1Stop` accepts an additive `observed` object; every existing call site keeps
//      the previous `{ code }` body byte for byte.
//   2. the money-validity conjunction is split into named violations with the same
//      verdict and the same short-circuiting, and the refusal returns
//      `{ stage: "money_evidence", violations, targetWindowKnown }`.
//
// One node, one field (`func`). The plan-rules activation and the other bodies are
// untouched. Preparation only: nothing is deployed, imported or restarted here, and the
// patcher fails closed unless the preimage is exactly the reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const MONEY_EVIDENCE_DEPLOYMENT_ID = "lk1-money-evidence";
export const MONEY_EVIDENCE_KIND = "FOCUSED_LK1_MONEY_EVIDENCE_DIAGNOSTICS_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-16 after
// `lk1-event-tariff-amounts` (4804 nodes, sha256 8f4c48bb\u2026).
export const MONEY_EVIDENCE_SOURCE_SHA256 =
  "2d25429b0c18ee58df23ea42a244b7c29b7b044d38fccf9a946a22c4f564c15a";
export const MONEY_EVIDENCE_SOURCE_NODE_COUNT = 4804;
export const MONEY_EVIDENCE_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const MONEY_EVIDENCE_TARGET = Object.freeze({
  id: MONEY_EVIDENCE_BOOKING_ID,
  liveFuncSha256: "4e8e247ab29c56f05cf12dc4fe4456a9c5aa4f87630a0238ba5c87320c314b44",
  patchedFuncSha256: "40e90a47e8fc549ebc84fb76472b6039dd441cbf472a14d61ae032b0edfd195f",
});

const BOOKING_MARKERS = Object.freeze([
  "observed === undefined ? { code } : { code, observed });",
  'stage: "money_evidence",',
  "evidencePresent: isObj(ctx.lk1MoneyOwnership),",
  "readbackPhase: typeof ctx.lk1MoneyReadbackPhase === \"string\"",
  "selectedOwned: selectedOwned.length,",
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  "    if (quote.code) return lk1Stop(ctx, quote.code);",
]);

export const MONEY_EVIDENCE_DELTAS = Object.freeze([
  { id: "money-evidence-observed-detail",
    before: `    if (quote.code) return lk1Stop(ctx, quote.code);`,
    after: `    if (quote.code) {
      // The money-evidence refusal is the one stop that can mean "the mandate was not
      // proven in this pass" (for example a resumed operation whose readback phase is
      // already recorded). Name the state instead of only the code; the verdict is the
      // same and every other code keeps the previous \`{ code }\` body.
      const observed = quote.code === "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN"
        ? { stage: "money_evidence",
          evidencePresent: isObj(ctx.lk1MoneyOwnership),
          readbackPhase: typeof ctx.lk1MoneyReadbackPhase === "string" ? ctx.lk1MoneyReadbackPhase.slice(0, 32) : null,
          selectedOwned: selectedOwned.length,
          eventCategory: resolveCategory(exercise) }
        : undefined;
      return lk1Stop(ctx, quote.code, observed);
    }` },
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

export function patchMoneyEvidenceBookingBody(source, target = MONEY_EVIDENCE_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of MONEY_EVIDENCE_DELTAS) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`Booking gateway anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  for (const marker of BOOKING_MARKERS) {
    if ((patched.split(marker).length - 1) !== 1) {
      throw new Error(`Patched booking gateway is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of BOOKING_ABSENT_MARKERS) {
    if (patched.includes(marker)) throw new Error(`Patched booking gateway still carries: ${marker}`);
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  if (sha256(patched) !== target.patchedFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${sha256(patched)} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function composeMoneyEvidenceArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? MONEY_EVIDENCE_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== MONEY_EVIDENCE_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${MONEY_EVIDENCE_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === MONEY_EVIDENCE_BOOKING_ID), MONEY_EVIDENCE_BOOKING_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchMoneyEvidenceBookingBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: MONEY_EVIDENCE_BOOKING_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: MONEY_EVIDENCE_BOOKING_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: MONEY_EVIDENCE_BOOKING_ID,
      otherFieldsUnchanged: true, diagnosticsPresent: booking.func.includes('stage: "money_evidence"') } };
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
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeMoneyEvidenceArtifacts(liveBytes, MONEY_EVIDENCE_DEPLOYMENT_ID, {
    expectedSourceSha256: MONEY_EVIDENCE_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: MONEY_EVIDENCE_KIND, deploymentId: MONEY_EVIDENCE_DEPLOYMENT_ID,
    targets: { booking: { id: MONEY_EVIDENCE_BOOKING_ID,
      func: { beforeSha256: MONEY_EVIDENCE_TARGET.liveFuncSha256, afterSha256: MONEY_EVIDENCE_TARGET.patchedFuncSha256 } } },
    sourceSha256: verified.sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 1, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking,
    topologyChanged: false, routesChanged: false, policyChanged: false,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { fail(error.message); }
}
