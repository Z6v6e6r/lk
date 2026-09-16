#!/usr/bin/env node

// Focused Node-RED generation: the price preview and the booking gateway agree on the free
// first covered event of the day.
//
// Two live defects of the same rule (2026-09-16):
//
//   1. The preview's embedded usage block is the booking gateway's `lk1_usage_operations` slice,
//      but the closure it runs in never received `LK1_FREE_FIRST_EVENT_PRODUCTS` or
//      `lk1OperationCategory`, and the router never bound the instance identity that carries the
//      proven visit balance. The block therefore reported `covered: false` and the preview kept
//      quoting the configured discount for the first event of the day, while the booking gateway
//      grants it for free. The preview now claims the same day snapshot the gateway proves.
//   2. The widget sends the quote it was shown back as `expectedGroupDiscount` /
//      `expectedTournamentDiscount`, and the gateway compared it against one fixed shape. For a
//      free covered event the decision is `FREE_ENTITLEMENT` at zero, so the widget's full-benefit
//      quote (100% at zero) was refused with `GROUP_DISCOUNT_QUOTE_CHANGED` (39 live 409s,
//      193-byte bodies). The reviewed comparison is left byte-identical and the full-benefit
//      quote is normalized to the reviewed shape first; the amount still has to equal the
//      authoritative decision, so nothing there can raise or lower the charge.
//
// Two nodes, one field each (`func`). Preparation only: nothing is deployed, imported or
// restarted here, and the patcher fails closed unless the preimage is exactly the installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";

export const PREVIEW_FREE_FIRST_EVENT_DEPLOYMENT_ID = "lk1-preview-free-first-event";
export const PREVIEW_FREE_FIRST_EVENT_KIND = "FOCUSED_LK1_PREVIEW_FREE_FIRST_EVENT_V1";

// Reviewed live flow: the installed flow after `lk1-preview-multi-product` (4804 nodes,
// sha256 1d3da756…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256 =
  "1d3da756e70ff4e4ac04008380b05cacdf1af26e2649db34f29ab9d19d52e865";
export const PREVIEW_FREE_FIRST_EVENT_SOURCE_NODE_COUNT = 4804;
export const PREVIEW_FREE_FIRST_EVENT_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID = "lk_subscription_price_preview_20260908_router";
export const PREVIEW_FREE_FIRST_EVENT_TARGETS = Object.freeze({
  booking: Object.freeze({ id: PREVIEW_FREE_FIRST_EVENT_BOOKING_ID,
    liveFuncSha256: "1c4b177b7e652137252917c6de92f039a2f1717252d62f27994ed7f0a4811de1",
    patchedFuncSha256: "2c8bfbe7d1a5873dc85331bf42402c45c0a08de4227630a3450e8a3d770332cd" }),
  preview: Object.freeze({ id: PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID,
    liveFuncSha256: "6bbae1f64480fa9b22c3ca434157af8ea9447b7b486f2699f445bfb776b97331",
    patchedFuncSha256: "fc2f252743fdd9e95bd38554441f70fa4b2cee815a4ce0bddbcb67dbabd4bb82" }),
});
// The composed preview embeds the booking gateway's usage slice verbatim; the slice itself is
// untouched by this generation (the expectation check lives in the policy-decision step).
export const PREVIEW_FREE_FIRST_EVENT_USAGE_BLOCK_SHA256 =
  "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9";
export const PREVIEW_FREE_FIRST_EVENT_CANONICAL_PINS = Object.freeze({
  pricing: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  join: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  evaluator: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
});


export const PREVIEW_FREE_FIRST_EVENT_BOOKING_DELTAS = Object.freeze([
  { id: "free-first-expectation-normalized",
    before: `  const decision = msg._managedSubscriptionPolicyDecision;
  if (!isObj(decision) || decision.eligible !== true || !isObj(decision.benefit)`,
    after: `  const decision = msg._managedSubscriptionPolicyDecision;
  // A visit-covered first event of the day is carried by the plan itself, and the widget quotes it
  // as the full benefit at zero (100% of the base). The reviewed comparison below verifies the
  // configured percentage of a charged quote, so that one shape is normalized to the reviewed
  // shape here. The amount still has to equal the authoritative decision — zero — and no charged
  // expectation is touched, so this cannot raise or lower what the decision already fixed.
  if (isObj(decision) && decision.subscriptionVisitCount === 1
    && decision.benefit?.kind === "FREE_ENTITLEMENT" && decision.benefit.finalPriceMinor === 0) {
    for (const [key, discountField] of [["expectedGroupDiscount", "groupTrainingDiscountPercent"],
      ["expectedTournamentDiscount", "tournamentDiscountPercent"]]) {
      const quote = ctx[key];
      if (isObj(quote) && quote.discountPercent === 100 && quote.amountMinor === 0) {
        ctx[key] = { ...quote, discountPercent: ctx.lk1.rule[discountField] };
      }
    }
  }
  if (!isObj(decision) || decision.eligible !== true || !isObj(decision.benefit)` },
]);

const BOOKING_MARKERS = Object.freeze([
  'ctx[key] = { ...quote, discountPercent: ctx.lk1.rule[discountField] };',
  'if (isObj(quote) && quote.discountPercent === 100 && quote.amountMinor === 0) {',
  '["expectedTournamentDiscount", "tournamentDiscountPercent"]]) {',
  '|| expected.amountMinor !== decision.benefit.finalPriceMinor',
  '|| expected.discountPercent !== ctx.lk1.rule[route.discountField]',
]);

const BOOKING_ABSENT_MARKERS = Object.freeze([
  'const lk1ExpectedDiscountMatches = ',
  '|| !lk1ExpectedDiscountMatches(ctx, route, target, decision, expected)',
]);

const PREVIEW_MARKERS = Object.freeze([
  'LK1_FREE_FIRST_EVENT_PRODUCTS, lk1OperationCategory } = canonical;',
  'lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,',
  "    category: eventRoute ? eventRoute.category : 'open_game',",
  "const freeCovered = decision.subscriptionVisitCount === 1",
  'ctx.groupDiscountPercent = 100;',
  "quote(ctx.currentId, 'AVAILABLE', 0, 0, ctx.target.durationMinutes);",
]);
const PREVIEW_ABSENT_MARKERS = Object.freeze([
  "if (decision.subscriptionVisitCount !== 0 || (!Number.isSafeInteger(ctx.groupDiscountPercent) || ctx.groupDiscountPercent < 0 || ctx.groupDiscountPercent > 100)\n        || decision.benefit.finalPriceMinor !== ctx.basePriceMinor",
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

export function patchPreviewFreeFirstEventBookingBody(source,
  target = PREVIEW_FREE_FIRST_EVENT_TARGETS.booking) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of PREVIEW_FREE_FIRST_EVENT_BOOKING_DELTAS) {
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

export function composePreviewFreeFirstEventArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== PREVIEW_FREE_FIRST_EVENT_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PREVIEW_FREE_FIRST_EVENT_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === PREVIEW_FREE_FIRST_EVENT_BOOKING_ID),
    PREVIEW_FREE_FIRST_EVENT_BOOKING_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID),
    PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID);
  const before = {
    booking: { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) },
    preview: { func: sha256(preview.func), shape: JSON.parse(JSON.stringify({ ...preview, func: null })) },
  };
  booking.func = patchPreviewFreeFirstEventBookingBody(booking.func);
  // The preview is composed from the *patched* booking body: its canonical closure and its usage
  // slice are extracted from that node, so the composed body must see this generation's booking.
  const composed = previewSources(flow, {
    pins: { booking: sha256(booking.func), ...PREVIEW_FREE_FIRST_EVENT_CANONICAL_PINS },
    installedUsageSha256: PREVIEW_FREE_FIRST_EVENT_USAGE_BLOCK_SHA256,
  });
  preview.func = composed.router;
  for (const marker of PREVIEW_MARKERS) {
    if ((preview.func.split(marker).length - 1) < 1) {
      throw new Error(`Composed preview is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of PREVIEW_ABSENT_MARKERS) {
    if (preview.func.includes(marker)) throw new Error(`Composed preview still carries: ${marker}`);
  }
  if (sha256(preview.func) !== PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${sha256(preview.func)} != ${PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.patchedFuncSha256}`);
  }
  assertFunctionBody(preview.func, "Composed preview router body");
  for (const [id, snapshot] of [["booking", before.booking], ["preview", before.preview]]) {
    const node = flow.find((row) => row.id === (id === "booking" ? PREVIEW_FREE_FIRST_EVENT_BOOKING_ID : PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID));
    if (JSON.stringify({ ...node, func: null }) !== JSON.stringify(snapshot.shape)) {
      throw new Error(`${id} node changed a field other than func`);
    }
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const allowedChanges = [
    { id: PREVIEW_FREE_FIRST_EVENT_BOOKING_ID, fields: ["func"] },
    { id: PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID, fields: ["func"] },
  ];
  const changes = [
    { id: PREVIEW_FREE_FIRST_EVENT_BOOKING_ID, fields: ["func"],
      func: { beforeSha256: before.booking.func, afterSha256: sha256(booking.func) } },
    { id: PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID, fields: ["func"],
      func: { beforeSha256: before.preview.func, afterSha256: sha256(preview.func) } },
  ];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: { id: PREVIEW_FREE_FIRST_EVENT_BOOKING_ID, otherFieldsUnchanged: true,
      freeFirstExpectationNormalized: booking.func.includes('if (isObj(quote) && quote.discountPercent === 100 && quote.amountMinor === 0) {')
        && booking.func.includes('ctx[key] = { ...quote, discountPercent: ctx.lk1.rule[discountField] };'),
      reviewedExpectationUntouched: booking.func.includes('|| expected.amountMinor !== decision.benefit.finalPriceMinor')
        && booking.func.includes('|| expected.discountPercent !== ctx.lk1.rule[route.discountField]') },
    preview: { id: PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID, otherFieldsUnchanged: true,
      daySnapshotClaimed: preview.func.includes('LK1_FREE_FIRST_EVENT_PRODUCTS, lk1OperationCategory } = canonical;')
        && preview.func.includes('lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,'),
      freeQuoteEmitted: preview.func.includes('ctx.groupDiscountPercent = 100;')
        && preview.func.includes("quote(ctx.currentId, 'AVAILABLE', 0, 0, ctx.target.durationMinutes);") } };
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
  if (verified.sourceSha256 !== PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256) {
    fail(`Live source drift: ${verified.sourceSha256} != ${PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256}`); return;
  }
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composePreviewFreeFirstEventArtifacts(liveBytes, PREVIEW_FREE_FIRST_EVENT_DEPLOYMENT_ID, {
    expectedSourceSha256: PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: PREVIEW_FREE_FIRST_EVENT_KIND, deploymentId: PREVIEW_FREE_FIRST_EVENT_DEPLOYMENT_ID,
    targets: { booking: { id: PREVIEW_FREE_FIRST_EVENT_BOOKING_ID,
      func: { beforeSha256: PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.liveFuncSha256,
        afterSha256: PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.patchedFuncSha256 } },
    preview: { id: PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID,
      func: { beforeSha256: PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.liveFuncSha256,
        afterSha256: PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.patchedFuncSha256 } } },
    sourceSha256: verified.sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 2, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, preview: built.preview,
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
