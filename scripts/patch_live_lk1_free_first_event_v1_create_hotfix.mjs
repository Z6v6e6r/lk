#!/usr/bin/env node

// Focused Node-RED generation: the free-first event booking is written through the v1 admin
// contract, and the promo РА/Академия instances join the cohort.
//
// Two live defects of the `lk1-free-first-event` generation:
//
//   1. A visit-covered managed event booking fell to the v2 admin route, because the existing
//      condition only sent OPEN-GAME-style ON_PLACE carriers to v1. Viva answers a
//      subscription-covered v2 create without the booking id the durable operation has to
//      record, so `LK1_BOOKING_OUTCOME_UNKNOWN` stopped the saga after Viva had already
//      written the booking: the client saw a pending error while the roster showed the
//      booking, and the operation stayed PENDING_CONFIRMATION (six live group/tournament
//      attempts within ten minutes). Every other managed event booking (ON_PLACE carriers,
//      the split game path) already used v1.
//   2. The owner added the promo variants of РА and Академия to the same rule (owner decision
//      2026-09-16): promo РА covers group training and tournaments, promo Академия group
//      training only.
//
// One node, one field (`func`). Preparation only: nothing is deployed, imported or restarted
// here, and the patcher fails closed unless the preimage is exactly the installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const FREE_FIRST_EVENT_V1_DEPLOYMENT_ID = "lk1-free-first-event-v1-create";
export const FREE_FIRST_EVENT_V1_KIND = "FOCUSED_LK1_FREE_FIRST_EVENT_V1_CREATE_V1";

// Reviewed live flow: the installed flow after `lk1-free-first-event` (4804 nodes,
// sha256 1862dd94…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const FREE_FIRST_EVENT_V1_SOURCE_SHA256 =
  "1862dd942fe3c59b037bfc36dade4733f51f74fb57c46ff8cb275609f3b5f308";
export const FREE_FIRST_EVENT_V1_SOURCE_NODE_COUNT = 4804;
export const FREE_FIRST_EVENT_V1_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const FREE_FIRST_EVENT_V1_TARGET = Object.freeze({
  id: FREE_FIRST_EVENT_V1_BOOKING_ID,
  liveFuncSha256: "7bdcde3b5990282f577ac2656275c4fb727e3fa534d79a859f1f1ef7fdbdfa60",
  patchedFuncSha256: "c4d13c3ce9c888884305c21774a46caaab699a545e7b3541b7f9b6f5f279b3d4",
});

export const FREE_FIRST_EVENT_V1_DELTAS = Object.freeze([
  { id: "free-first-event-promo-cohort",
    before: `const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({
  "b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),
  "9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),
});`,
    after: `const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({
  // РА and Академия, including their promo variants (owner decision 2026-09-16).
  "b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),
  "3b4806f1-6f9a-46df-a7d7-45075b4e7274": Object.freeze(["group_training", "tournament"]),
  "9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),
  "6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),
});` },
  { id: "managed-subscription-booking-v1",
    before: `  const adminVersion = ctx.caller === "split" || (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";`,
    after: `  // Every managed booking uses the v1 admin contract, whichever way it is paid: the v2
  // route answers a subscription-covered create without the booking id the durable operation
  // has to record, which left the free first event PENDING while Viva had already written the
  // booking.
  const adminVersion = ctx.caller === "split" || (ctx.lk1 && payload.paymentType === "SUBSCRIPTION")
    || (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";` },
]);

const BOOKING_MARKERS = Object.freeze([
  '"3b4806f1-6f9a-46df-a7d7-45075b4e7274": Object.freeze(["group_training", "tournament"]),',
  '"6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"]),',
  '|| (ctx.lk1 && payload.paymentType === "SUBSCRIPTION")',
  '|| (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";',
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  `const adminVersion = ctx.caller === "split" || (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";`,
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

export function patchFreeFirstEventV1BookingBody(source, target = FREE_FIRST_EVENT_V1_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of FREE_FIRST_EVENT_V1_DELTAS) {
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

export function composeFreeFirstEventV1Artifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? FREE_FIRST_EVENT_V1_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== FREE_FIRST_EVENT_V1_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${FREE_FIRST_EVENT_V1_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID),
    FREE_FIRST_EVENT_V1_BOOKING_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchFreeFirstEventV1BookingBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: FREE_FIRST_EVENT_V1_BOOKING_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: FREE_FIRST_EVENT_V1_BOOKING_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: FREE_FIRST_EVENT_V1_BOOKING_ID,
      otherFieldsUnchanged: true,
      promoInCohort: booking.func.includes('"3b4806f1-6f9a-46df-a7d7-45075b4e7274": Object.freeze(["group_training", "tournament"])')
        && booking.func.includes('"6bda152b-0a9c-4308-82d0-3cd4e6aa680d": Object.freeze(["group_training"])'),
      managedSubscriptionV1: booking.func.includes('|| (ctx.lk1 && payload.paymentType === "SUBSCRIPTION")')
        && !booking.func.includes('const adminVersion = ctx.caller === "split" || (lk1EventMoneyBooking(ctx) && payload.paymentType === "ON_PLACE") ? "v1" : "v2";') } };
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
  const built = composeFreeFirstEventV1Artifacts(liveBytes, FREE_FIRST_EVENT_V1_DEPLOYMENT_ID, {
    expectedSourceSha256: FREE_FIRST_EVENT_V1_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: FREE_FIRST_EVENT_V1_KIND, deploymentId: FREE_FIRST_EVENT_V1_DEPLOYMENT_ID,
    targets: { booking: { id: FREE_FIRST_EVENT_V1_BOOKING_ID,
      func: { beforeSha256: FREE_FIRST_EVENT_V1_TARGET.liveFuncSha256,
        afterSha256: FREE_FIRST_EVENT_V1_TARGET.patchedFuncSha256 } } },
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
