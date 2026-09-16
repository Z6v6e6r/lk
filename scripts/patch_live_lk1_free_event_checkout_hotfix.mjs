#!/usr/bin/env node

// Focused Node-RED generation: the visit-covered first event of the day completes without a
// payment product.
//
// One live defect of the `lk1-free-first-event` generation (observed live 2026-09-16 11:17Z,
// operation `lk-subscription-i1xwvykarmv`, РА, group training 28.09):
//
//   `lk1EventPaymentBinding` described the CHARGED path only: it returned null unless the
//   decision consumed no visit and the final price was exactly `base - base*percent/100`.
//   The free first event consumes one visit and costs nothing, so both payment guards that
//   consume this binding rejected it:
//
//     * `lk1Checkout` stopped with `LK1_GROUP_PAYMENT_BINDING_INVALID` after Viva had already
//       written the booking (the ledger operation was CONFIRMED while the client saw a pending
//       error and the roster showed the booking);
//     * the ingress replay of that CONFIRMED operation stopped with
//       `LK1_PAYMENT_RECONCILIATION_REQUIRED` (291-byte body) on every poll.
//
//   The fix lives inside the binding itself, so the guards that consume it stay byte-identical:
//   a covered first event now yields a well-formed zero-charge binding, and the charged path
//   keeps the exact product/base/charge proof it always had. Both frozen guard regions
//   (`lk1Checkout` opening, replay block) are deliberately left untouched, because the earlier
//   released release packets pin their exact text.
//
// One node, one field (`func`). Preparation only: nothing is deployed, imported or restarted
// here, and the patcher fails closed unless the preimage is exactly the installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const FREE_EVENT_CHECKOUT_DEPLOYMENT_ID = "lk1-free-event-checkout";
export const FREE_EVENT_CHECKOUT_KIND = "FOCUSED_LK1_FREE_EVENT_CHECKOUT_V1";

// Reviewed live flow: the installed flow after `lk1-free-first-event-v1-create` (4804 nodes,
// sha256 80de9c88…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const FREE_EVENT_CHECKOUT_SOURCE_SHA256 =
  "80de9c88893f61b02725a3275fed4b5f8edf4ae294f1e639df7967c049a37aa9";
export const FREE_EVENT_CHECKOUT_SOURCE_NODE_COUNT = 4804;
export const FREE_EVENT_CHECKOUT_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const FREE_EVENT_CHECKOUT_TARGET = Object.freeze({
  id: FREE_EVENT_CHECKOUT_BOOKING_ID,
  liveFuncSha256: "c4d13c3ce9c888884305c21774a46caaab699a545e7b3541b7f9b6f5f279b3d4",
  patchedFuncSha256: "1c4b177b7e652137252917c6de92f039a2f1717252d62f27994ed7f0a4811de1",
});

export const FREE_EVENT_CHECKOUT_DELTAS = Object.freeze([
  { id: "free-event-binding-carries-zero-charge",
    before: `    || !Number.isSafeInteger(percent) || percent < 0 || percent > 100
    || decision?.eligible !== true || decision.subscriptionVisitCount !== 0
    || decision.benefit?.finalPriceMinor !== base - Math.floor(base * percent / 100)) return null;
  return {
    productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
    chargeMinor: decision.benefit.finalPriceMinor,
    discountMinor: base - decision.benefit.finalPriceMinor
  };
}`,
    after: `    || !Number.isSafeInteger(percent) || percent < 0 || percent > 100
    || decision?.eligible !== true) return null;
  // The visit-covered first event of the day costs nothing. It has no payment product to look
  // up, but it is still carried by this binding, so neither the confirm step nor the replay of
  // the durable operation demands a charge the client never owes.
  if (decision.subscriptionVisitCount === 1 && decision.benefit?.kind === "FREE_ENTITLEMENT"
    && decision.benefit.finalPriceMinor === 0) {
    return {
      productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
      chargeMinor: 0, discountMinor: base
    };
  }
  if (decision.subscriptionVisitCount !== 0
    || decision.benefit?.finalPriceMinor !== base - Math.floor(base * percent / 100)) return null;
  return {
    productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
    chargeMinor: decision.benefit.finalPriceMinor,
    discountMinor: base - decision.benefit.finalPriceMinor
  };
}` },
]);

const BOOKING_MARKERS = Object.freeze([
  'if (decision.subscriptionVisitCount === 1 && decision.benefit?.kind === "FREE_ENTITLEMENT"',
  '&& decision.benefit.finalPriceMinor === 0) {',
  'chargeMinor: 0, discountMinor: base',
  'if (route && !lk1EventPaymentBinding(ctx)) return lk1Stop(ctx, route.code + "_BINDING_INVALID");',
  'if (!binding || (amount > 0 && !validIntent)) return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");',
  '|| (ctx.lk1 && payload.paymentType === "SUBSCRIPTION")',
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  '|| decision?.eligible !== true || decision.subscriptionVisitCount !== 0',
  'if (route && ctx.lk1.decision.benefit.finalPriceMinor > 0 && !lk1EventPaymentBinding(ctx))',
  'if (amount > 0 && (!binding || !validIntent)) {',
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

export function patchFreeEventCheckoutBookingBody(source, target = FREE_EVENT_CHECKOUT_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of FREE_EVENT_CHECKOUT_DELTAS) {
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

export function composeFreeEventCheckoutArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? FREE_EVENT_CHECKOUT_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== FREE_EVENT_CHECKOUT_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${FREE_EVENT_CHECKOUT_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === FREE_EVENT_CHECKOUT_BOOKING_ID),
    FREE_EVENT_CHECKOUT_BOOKING_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchFreeEventCheckoutBookingBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Booking gateway changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: FREE_EVENT_CHECKOUT_BOOKING_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: FREE_EVENT_CHECKOUT_BOOKING_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: FREE_EVENT_CHECKOUT_BOOKING_ID,
      otherFieldsUnchanged: true,
      freeEventCarriesZeroChargeBinding: booking.func.includes('if (decision.subscriptionVisitCount === 1 && decision.benefit?.kind === "FREE_ENTITLEMENT"')
        && booking.func.includes('chargeMinor: 0, discountMinor: base'),
      chargedBindingStillExact: booking.func.includes('if (decision.subscriptionVisitCount !== 0')
        && booking.func.includes('chargeMinor: decision.benefit.finalPriceMinor,'),
      chargedPathStillBound: booking.func.includes('return lk1Stop(ctx, route.code + "_BINDING_INVALID");')
        && booking.func.includes('return lk1Stop(ctx, "LK1_PAYMENT_RECONCILIATION_REQUIRED");') } };
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
  const built = composeFreeEventCheckoutArtifacts(liveBytes, FREE_EVENT_CHECKOUT_DEPLOYMENT_ID, {
    expectedSourceSha256: FREE_EVENT_CHECKOUT_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: FREE_EVENT_CHECKOUT_KIND, deploymentId: FREE_EVENT_CHECKOUT_DEPLOYMENT_ID,
    targets: { booking: { id: FREE_EVENT_CHECKOUT_BOOKING_ID,
      func: { beforeSha256: FREE_EVENT_CHECKOUT_TARGET.liveFuncSha256,
        afterSha256: FREE_EVENT_CHECKOUT_TARGET.patchedFuncSha256 } } },
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
