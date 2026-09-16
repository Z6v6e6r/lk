#!/usr/bin/env node

// Focused Node-RED generation: the subscription price preview prices an event for a client who
// owns more than one managed product.
//
// Live defect (2026-09-16, client 79104303190, РА group training): the preview asked Mongo for
// every operation of every product the client owns
//
//   { 'lk1.rule.productId': { $in: ctx.ruleProductIds } }
//
// and then required the whole returned batch to carry the CURRENT subscription's rule product.
// For an account that owns an annual HUB and a plan product at the same time (this client owns
// three HUB instances plus an active РА), the batch legitimately contains both products, so the
// guard rejected it: `503` with the compact 49-byte body `LK1_ALLOWANCE_RECORD_INVALID`
// ("Не удалось проверить скидку по подписке" in the widget). The failure started exactly when the
// РА subscription became active and disappeared for calls whose batch happened to hold a single
// product.
//
// The guard now asserts the batch scope the query actually used (`ctx.ruleProductIds`). The day
// and minute accounting stays per subscription inside the shared usage builder, so a wider batch
// cannot change a decision. One node, one field (`func`). Preparation only: nothing is deployed,
// imported or restarted here, and the patcher fails closed unless the preimage is exactly the
// installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const PREVIEW_MULTI_PRODUCT_DEPLOYMENT_ID = "lk1-preview-multi-product";
export const PREVIEW_MULTI_PRODUCT_KIND = "FOCUSED_LK1_PREVIEW_MULTI_PRODUCT_V1";

// Reviewed live flow: the installed flow after `lk1-free-first-event-v1-create` (4804 nodes,
// sha256 80de9c88…). A live change must never be absorbed silently: it requires a conscious
// re-review of every pin below.
export const PREVIEW_MULTI_PRODUCT_SOURCE_SHA256 =
  "8fce2cebb3703c6cd9575932a000a2330ce61e16c03a50406e3daf11bffeec1e";
export const PREVIEW_MULTI_PRODUCT_SOURCE_NODE_COUNT = 4804;
export const PREVIEW_MULTI_PRODUCT_NODE_ID = "lk_subscription_price_preview_20260908_router";
export const PREVIEW_MULTI_PRODUCT_TARGET = Object.freeze({
  id: PREVIEW_MULTI_PRODUCT_NODE_ID,
  liveFuncSha256: "976ce14ef9d6be1b2c00d818f1048b47a7ef3c61a8dfa6bdbb2a07b2f4c8466d",
  patchedFuncSha256: "6bbae1f64480fa9b22c3ca434157af8ea9447b7b486f2699f445bfb776b97331",
});

export const PREVIEW_MULTI_PRODUCT_DELTAS = Object.freeze([
  { id: "preview-batch-scope-matches-query",
    before: `  if (ctx.operations.some(row => row?.lk1?.rule?.productId !== configured.rule.productId)) return stop('LK1_ALLOWANCE_RECORD_INVALID');`,
    after: `  // The batch is deliberately wider than one product: the query above asks for every product
  // this client owns (\`ctx.ruleProductIds\`), because the shared usage builder scopes the day and
  // minute accounting per subscription. Demanding a single rule product here rejected the whole
  // batch for a client who owns two managed products (HUB + plan), which surfaced as a 503 and
  // "Не удалось проверить скидку по подписке" on every group and tournament form.
  if (ctx.operations.some(row => !ctx.ruleProductIds.includes(String(row?.lk1?.rule?.productId || '').toLowerCase()))) {
    return stop('LK1_ALLOWANCE_RECORD_INVALID');
  }` },
]);

const NODE_MARKERS = Object.freeze([
  "'lk1.rule.productId': { $in: ctx.ruleProductIds }",
  "ctx.ruleProductIds = [...new Set(Object.values(ctx.metadata).map(row => row.productId.toLowerCase()))]",
  "if (ctx.operations.some(row => !ctx.ruleProductIds.includes(String(row?.lk1?.rule?.productId || '').toLowerCase()))) {",
  "const usageMessage = { payload: ctx.operations, _subscriptionBooking: usageContext };",
  "// AUDIT_BINDING_START",
]);
const NODE_ABSENT_MARKERS = Object.freeze([
  "if (ctx.operations.some(row => row?.lk1?.rule?.productId !== configured.rule.productId)) return stop('LK1_ALLOWANCE_RECORD_INVALID');",
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

export function patchPreviewMultiProductBody(source, target = PREVIEW_MULTI_PRODUCT_TARGET) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Preview router installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  let patched = source;
  for (const delta of PREVIEW_MULTI_PRODUCT_DELTAS) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`Preview router anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  for (const marker of NODE_MARKERS) {
    if ((patched.split(marker).length - 1) !== 1) {
      throw new Error(`Patched preview router is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of NODE_ABSENT_MARKERS) {
    if (patched.includes(marker)) throw new Error(`Patched preview router still carries: ${marker}`);
  }
  assertFunctionBody(patched, "Patched preview router body");
  if (sha256(patched) !== target.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${sha256(patched)} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function composePreviewMultiProductArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? PREVIEW_MULTI_PRODUCT_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== PREVIEW_MULTI_PRODUCT_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PREVIEW_MULTI_PRODUCT_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === PREVIEW_MULTI_PRODUCT_NODE_ID),
    PREVIEW_MULTI_PRODUCT_NODE_ID);
  const before = { func: sha256(booking.func), shape: JSON.parse(JSON.stringify({ ...booking, func: null })) };
  booking.func = patchPreviewMultiProductBody(booking.func);
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(before.shape)) {
    throw new Error("Preview router changed a field other than func");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: PREVIEW_MULTI_PRODUCT_NODE_ID, fields: ["func"],
    func: { beforeSha256: before.func, afterSha256: sha256(booking.func) } }];
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: PREVIEW_MULTI_PRODUCT_NODE_ID, fields: ["func"] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes), booking: { id: PREVIEW_MULTI_PRODUCT_NODE_ID,
      otherFieldsUnchanged: true,
      batchScopeMatchesQuery: booking.func.includes("if (ctx.operations.some(row => !ctx.ruleProductIds.includes(String(row?.lk1?.rule?.productId || '').toLowerCase()))) {")
        && !booking.func.includes("row?.lk1?.rule?.productId !== configured.rule.productId"),
      usageBuilderUnchanged: booking.func.includes("// AUDIT_BINDING_START")
        && booking.func.includes("'lk1.rule.productId': { $in: ctx.ruleProductIds }") } };
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
  const built = composePreviewMultiProductArtifacts(liveBytes, PREVIEW_MULTI_PRODUCT_DEPLOYMENT_ID, {
    expectedSourceSha256: PREVIEW_MULTI_PRODUCT_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: PREVIEW_MULTI_PRODUCT_KIND, deploymentId: PREVIEW_MULTI_PRODUCT_DEPLOYMENT_ID,
    targets: { booking: { id: PREVIEW_MULTI_PRODUCT_NODE_ID,
      func: { beforeSha256: PREVIEW_MULTI_PRODUCT_TARGET.liveFuncSha256,
        afterSha256: PREVIEW_MULTI_PRODUCT_TARGET.patchedFuncSha256 } } },
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
