#!/usr/bin/env node

// Focused Node-RED generation: the money mandate on the direct group-training route
// produces its readback evidence for exactly the cohort `resolveLk1Rule` marks enforced,
// and a `NEW` first-use instance stays bookable.
//
// The plan-rules generation extended the money mandate from the single annual-HUB product
// to every product named by `subscriptions_lk1_plan_rules`, but the two places that decide
// whether the readback proof exists still assumed the HUB product alone:
//
//   1. `identityMoneyOwned` (the production product-identity projection embedded in the
//      booking gateway) rejected every non-HUB product before it looked at the row. A plan
//      product sold inside its `enforceFrom` window therefore produced no proof, while
//      `lk1Quote` kept demanding one — the unsatisfiable pair that refused a live РА
//      subscription bought 2026-09-16 for a group training with
//      `LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN` (`observed.stage: "money_evidence"`,
//      `readbackPhase: "exercise"`, `selectedOwned: 1`).
//   2. the deep validity pass dropped the first-use relaxation when the `lk1-money-validity`
//      generation split its conjunction into named violations. `firstUse` was still computed
//      and never read, so a `NEW` instance without an activation date — the state Viva
//      activates with the booking itself, and the one the frontend offers as
//      `NEW_FIRST_USE_CANDIDATE` — was refused with `status_new`, `activation_unparsed` and
//      `expiry_unparsed`.
//
// Two reviewed deltas on `lk_subscription_booking_router_20260804`:
//   1. the money projection asks the resolver for the cohort (via the embedded `lk1Config`)
//      and accepts the first-use state, keeping the visited-row identity, owner, hold/freeze
//      and event-window proofs untouched;
//   2. the named lifecycle violations are evaluated only for a non-first-use instance,
//      exactly as the pre-diagnostics conjunction did.
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

export const PLAN_FIRST_USE_DEPLOYMENT_ID = "lk1-plan-money-first-use";
export const PLAN_FIRST_USE_KIND = "FOCUSED_LK1_PLAN_MONEY_FIRST_USE_V1";

// Reviewed live flow: the installed flow after `lk1-money-cohort` (4804 nodes, sha256
// ccb9eabb\u2026), reconstructed from the 2026-09-16 08:11 pull whose whole-flow sha is
// dbf43797\u2026. A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const PLAN_FIRST_USE_SOURCE_SHA256 =
  "ccb9eabb9f3bbf4f7013e3cea3bb39677b1e05825c8647614c3efc10eba77b4c";
export const PLAN_FIRST_USE_SOURCE_NODE_COUNT = 4804;
export const PLAN_FIRST_USE_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const PLAN_FIRST_USE_TARGET = Object.freeze({
  id: PLAN_FIRST_USE_BOOKING_ID,
  liveFuncSha256: "967185637bf9c5e4d5e44df899edac86ff431f2f1b719d80bbdceee5fd41f19c",
  patchedFuncSha256: "f43e4c5ef6a5651dffd54a772a7d88028a4eeb0e2063f56ff3340660544c480c",
});

export const PLAN_FIRST_USE_DELTAS = Object.freeze([
  { id: "plan-cohort-money-projection",
    before: `  const p = ctx.lk1ProductIdentity;
  if (normalizeId(p.productId) !== LK1_OVERLAY_HUB_PRODUCT_ID) return [];
  const row = rows[0];
  if (row.status !== 'ACTIVE' || !identitySelected({ content: [row], totalElements: 1 }, ctx)`,
    after: `  const p = ctx.lk1ProductIdentity;
  const row = rows[0];
  // The mandate follows the resolver, never one hardcoded product: \`lk1Quote\` asks for the
  // fresh readback proof of every instance the rules mark enforced, so this projection has
  // to produce it for exactly that cohort. A plan product sold inside its \`enforceFrom\`
  // window was refused here while the quote kept asking; a legacy or unrecognised product
  // still produces no proof and stays outside the contour.
  const projected = [{ ...row, productId: p.productId, name: p.name,
    product: { ...(isObj(row.product) ? row.product : {}), id: p.productId, name: p.name } }];
  const configured = lk1Config(projected);
  if (!configured.matched || configured.legacy === true || configured.code) return [];
  // A \`NEW\` instance without an activation date is the first-use state: Viva writes the
  // activation and expiry with the booking this mandate authorises, so neither can be
  // required before that write. Hold, freeze and the event window are judged below.
  const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(row, null) === 'NEW_FIRST_USE_CANDIDATE';
  if ((!firstUse && row.status !== 'ACTIVE') || !identitySelected({ content: [row], totalElements: 1 }, ctx)` },
  { id: "first-use-lifecycle-violations",
    before: `    const now = Date.now();
    // The verdict is the same conjunction as before, split into named violations so the
    // refusal reports which condition failed. Every branch below maps 1:1 to the previous
    // operand order and short-circuiting: a missing activation/expiry or an unresolved
    // target window still refuses before any instant comparison is evaluated.
    const violations = [];
    if (selected.length !== 1) violations.push("instance_count");
    if (!instanceIds.length) violations.push("instance_id_missing");
    if (instanceIds.some((id) => normalizeId(id) !== normalizeId(ctx.clientSubscriptionId))) {
      violations.push("instance_id_mismatch");
    }
    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");
    if (subscription.status !== "ACTIVE") {
      violations.push(\`status_\${String(subscription.status || "missing").toLowerCase().slice(0, 24)}\`);
    }
    if (activation === null) violations.push("activation_unparsed");
    if (expiry === null) violations.push("expiry_unparsed");
    if (!Number.isFinite(targetStart) || !duration || !Number.isFinite(targetEnd)) {
      violations.push("target_window_unresolved");
    } else {
      if (activation !== null) {
        if (activation > now) violations.push("activation_in_future");
        if (activation > targetStart) violations.push("activation_after_target_start");
      }
      if (expiry !== null) {
        if (expiry < now) violations.push("expired");
        if (expiry < targetEnd) violations.push("expiry_before_target_end");
      }
    }`,
    after: `    const now = Date.now();
    // The verdict is the same conjunction as before, split into named violations so the
    // refusal reports which condition failed. Every branch below maps 1:1 to the previous
    // operand order and short-circuiting: a missing activation/expiry or an unresolved
    // target window still refuses before any instant comparison is evaluated.
    // Identity, hold/freeze and a resolvable event window stay unconditional; a first-use
    // instance is released from the lifecycle checks Viva can only answer after the write.
    const violations = [];
    if (selected.length !== 1) violations.push("instance_count");
    if (!instanceIds.length) violations.push("instance_id_missing");
    if (instanceIds.some((id) => normalizeId(id) !== normalizeId(ctx.clientSubscriptionId))) {
      violations.push("instance_id_mismatch");
    }
    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");
    if (!firstUse) {
      if (subscription.status !== "ACTIVE") {
        violations.push(\`status_\${String(subscription.status || "missing").toLowerCase().slice(0, 24)}\`);
      }
      if (activation === null) violations.push("activation_unparsed");
      if (expiry === null) violations.push("expiry_unparsed");
    }
    if (!Number.isFinite(targetStart) || !duration || !Number.isFinite(targetEnd)) {
      violations.push("target_window_unresolved");
    } else if (!firstUse) {
      if (activation !== null) {
        if (activation > now) violations.push("activation_in_future");
        if (activation > targetStart) violations.push("activation_after_target_start");
      }
      if (expiry !== null) {
        if (expiry < now) violations.push("expired");
        if (expiry < targetEnd) violations.push("expiry_before_target_end");
      }
    }` },
]);

const BOOKING_MARKERS = Object.freeze([
  "const configured = lk1Config(projected);",
  "if (!configured.matched || configured.legacy === true || configured.code) return [];",
  "if ((!firstUse && row.status !== 'ACTIVE') || !identitySelected({ content: [row], totalElements: 1 }, ctx)",
  "    if (!firstUse) {",
  "    } else if (!firstUse) {",
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  "  if (normalizeId(p.productId) !== LK1_OVERLAY_HUB_PRODUCT_ID) return [];",
  `    if (subscription.status !== "ACTIVE") {
      violations.push(\`status_\${String(subscription.status || "missing").toLowerCase().slice(0, 24)}\`);
    }
    if (activation === null) violations.push("activation_unparsed");
    if (expiry === null) violations.push("expiry_unparsed");`,
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

export function patchPlanFirstUseBookingBody(source, target = PLAN_FIRST_USE_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of PLAN_FIRST_USE_DELTAS) {
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
  // Two first-use verdicts, one per scope, and no third: the projection judges the freshly
  // read row, the deep validity pass judges the same row against the event window.
  const firstUseVerdicts = [
    "const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(row, null) === 'NEW_FIRST_USE_CANDIDATE';",
    'const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(subscription, eventDate(exercise)) === "NEW_FIRST_USE_CANDIDATE";',
  ];
  for (const verdict of firstUseVerdicts) {
    if ((patched.split(verdict).length - 1) !== 1) {
      throw new Error(`Patched booking gateway must keep exactly one reviewed first-use verdict: ${verdict}`);
    }
  }
  if ((patched.split("const firstUse = ").length - 1) !== firstUseVerdicts.length) {
    throw new Error("Patched booking gateway must not declare an unreviewed first-use verdict");
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  if (sha256(patched) !== target.patchedFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${sha256(patched)} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function composePlanFirstUseArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? PLAN_FIRST_USE_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== PLAN_FIRST_USE_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PLAN_FIRST_USE_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === PLAN_FIRST_USE_BOOKING_ID), PLAN_FIRST_USE_BOOKING_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchPlanFirstUseBookingBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: PLAN_FIRST_USE_BOOKING_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: PLAN_FIRST_USE_BOOKING_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: PLAN_FIRST_USE_BOOKING_ID,
      otherFieldsUnchanged: true,
      planProjectionResolverBound: booking.func.includes("const configured = lk1Config(projected);")
        && !booking.func.includes("  if (normalizeId(p.productId) !== LK1_OVERLAY_HUB_PRODUCT_ID) return [];"),
      firstUseGuarded: booking.func.includes("    if (!firstUse) {")
        && booking.func.includes("    } else if (!firstUse) {") } };
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
  const built = composePlanFirstUseArtifacts(liveBytes, PLAN_FIRST_USE_DEPLOYMENT_ID, {
    expectedSourceSha256: PLAN_FIRST_USE_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: PLAN_FIRST_USE_KIND, deploymentId: PLAN_FIRST_USE_DEPLOYMENT_ID,
    targets: { booking: { id: PLAN_FIRST_USE_BOOKING_ID,
      func: { beforeSha256: PLAN_FIRST_USE_TARGET.liveFuncSha256, afterSha256: PLAN_FIRST_USE_TARGET.patchedFuncSha256 } } },
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
