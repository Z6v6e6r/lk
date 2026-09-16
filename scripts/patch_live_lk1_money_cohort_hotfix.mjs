#!/usr/bin/env node

// Focused Node-RED generation: the annual-HUB money mandate covers exactly the cohort the
// resolver marks enforced (the sale-date gate left over from the pre-plan-rules rollout is
// removed from the readback branch).
//
// The plan-rules generation moved the cohort decision to `resolveLk1Rule` and deleted the
// sale-date gate from `lk1Config` and `lk1Quote` — but `lk1-money-cohort` leaves the same
// gate in the branch that produces the money evidence. The consequence was a verdict the
// gateway could not satisfy: for an annual HUB sold before 2026-09-01 the resolver reports
// `legacy: false` (the HUB rule carries no sale-date gate, "the contour is on for every
// sale"), `lk1Quote` therefore requires the readback evidence, and this branch refused to
// produce it. Every create/join on the event route for that cohort ended with
// `LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN` while the price preview still offered the
// discount — the live "cannot create/join a game for the second day" report.
//
// Two reviewed deltas on `lk_subscription_booking_router_20260804`:
//   1. the comment above the cohort verdict now states the invariant the code enforces;
//   2. `if (enforced && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM)` becomes
//      `if (enforced)`.
//
// The verdict for every other cohort is untouched: a legacy instance still produces no
// evidence (the quote returns `{ legacy: true }` before it could ask), and every other
// branch of the deep validation is byte-identical.
//
// One node, one field (`func`). Preparation only: nothing is deployed, imported or
// restarted here, and the patcher fails closed unless the preimage is exactly the reviewed
// live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const MONEY_COHORT_DEPLOYMENT_ID = "lk1-money-cohort";
export const MONEY_COHORT_KIND = "FOCUSED_LK1_MONEY_COHORT_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-16 after
// `lk1-money-evidence` (4804 nodes, sha256 dbf43797\u2026).
export const MONEY_COHORT_SOURCE_SHA256 =
  "dbf43797e1e384c005065d439824e8a51f3476269051e2b624f77fc0fd2a7ac4";
export const MONEY_COHORT_SOURCE_NODE_COUNT = 4804;
export const MONEY_COHORT_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const MONEY_COHORT_TARGET = Object.freeze({
  id: MONEY_COHORT_BOOKING_ID,
  liveFuncSha256: "40e90a47e8fc549ebc84fb76472b6039dd441cbf472a14d61ae032b0edfd195f",
  patchedFuncSha256: "967185637bf9c5e4d5e44df899edac86ff431f2f1b719d80bbdceee5fd41f19c",
});

const COHORT_COMMENT = `  // The resolver alone decides the enforced cohort: the annual HUB rule carries no
  // sale-date gate, while every plan rule enters the contour only from its own
  // \`enforceFrom\`. The money mandate has to cover exactly that cohort. Re-applying the
  // pre-plan-rules sale date here kept the proof unsatisfiable for instances the resolver
  // had just marked enforced (an annual HUB sold before 2026-09-01: the quote requires the
  // readback evidence, this branch refused to produce it), so create/join on the event
  // route was refused with LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN for that whole cohort.
`;

export const MONEY_COHORT_DELTAS = Object.freeze([
  { id: "money-cohort-comment",
    before: `  // The resolver decides the enforced cohort; the date gate below stays only for
  // the HUB money mandate that existed before the plan rules.
  const enforced = configured.matched && !configured.legacy;`,
    after: `${COHORT_COMMENT}  const enforced = configured.matched && !configured.legacy;` },
  { id: "money-cohort-gate",
    before: `  if (enforced && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM) {`,
    after: `  if (enforced) {` },
]);

const BOOKING_MARKERS = Object.freeze([
  "  const enforced = configured.matched && !configured.legacy;",
  "// The resolver alone decides the enforced cohort:",
  "  if (enforced) {",
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  "  if (enforced && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM) {",
  "  // The resolver decides the enforced cohort; the date gate below stays only for",
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

export function patchMoneyCohortBookingBody(source, target = MONEY_COHORT_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of MONEY_COHORT_DELTAS) {
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

export function composeMoneyCohortArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? MONEY_COHORT_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== MONEY_COHORT_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${MONEY_COHORT_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === MONEY_COHORT_BOOKING_ID), MONEY_COHORT_BOOKING_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchMoneyCohortBookingBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: MONEY_COHORT_BOOKING_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: MONEY_COHORT_BOOKING_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: MONEY_COHORT_BOOKING_ID,
      otherFieldsUnchanged: true, cohortGateRemoved: booking.func.includes("  if (enforced) {")
        && !booking.func.includes("dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM") } };
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
  const built = composeMoneyCohortArtifacts(liveBytes, MONEY_COHORT_DEPLOYMENT_ID, {
    expectedSourceSha256: MONEY_COHORT_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: MONEY_COHORT_KIND, deploymentId: MONEY_COHORT_DEPLOYMENT_ID,
    targets: { booking: { id: MONEY_COHORT_BOOKING_ID,
      func: { beforeSha256: MONEY_COHORT_TARGET.liveFuncSha256, afterSha256: MONEY_COHORT_TARGET.patchedFuncSha256 } } },
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
