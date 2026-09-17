#!/usr/bin/env node

// Focused Node-RED generation: make the event route (group training and tournament)
// produce a price the cabinet can act on again.
//
// Three reviewed defects, all live after the 2026-09-15 plan-rules release:
//   1. `lk_subscription_price_preview_20260908_router` — the router dropped every
//      out-of-contour subscription from the event batch (empty `quotes: []`, so the
//      cabinet blocked the booking), resolved event ownership with the HUB-only money
//      identity (plan products died with PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED),
//      and mapped every decision blocker except the removed cap blocker to a 503.
//   2. `lk_subscription_price_preview_20260908_final` — render the refusal detail the
//      router records (`error.details`), so a production refusal names its exact
//      sub-condition instead of being guessed.
//   3. `lk_subscription_booking_router_20260804` — `prepareHttp` now drops
//      `msg.responseUrl` before every request. Node-RED sets that field on each reply
//      and both tariff checks compare it with the URL they asked for, so a stale value
//      from the previous step failed them (`LK1_EVENT_TARIFF_UNVERIFIED` on group
//      trainings and tournaments, on the preview *and* on create/join).
//
// The generation is exactly three nodes and three `func` fields; no node is added and
// the plan-rules activation, the evaluator and the split/join bodies stay untouched.
//
// This is preparation only. It never deploys, imports, restarts or activates anything,
// and it fails closed unless the supplied preimage is exactly the reviewed live flow
// (whole-flow sha256 plus every node body it rewrites or reads).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { previewSources, assertCanonicalExports } from "./patch_nodered_subscription_price_preview.mjs";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const EVENT_QUOTES_DEPLOYMENT_ID = "lk1-event-quotes";
export const EVENT_QUOTES_KIND = "FOCUSED_LK1_EVENT_QUOTES_HOTFIX_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-15 after the
// `lk1-preview-event-helpers` hotfix (`/root/.node-red/flows.json`, 4804 nodes,
// sha256 d8bbfe27…). A live change must never be absorbed silently: it requires a
// conscious re-review of every pin below.
export const EVENT_QUOTES_SOURCE_SHA256 =
  "d8bbfe270c449087606cedd2d0cdb640fb50b8f6a0c1db0c0eae90ddb9455db7";
export const EVENT_QUOTES_SOURCE_NODE_COUNT = 4804;

export const EVENT_QUOTES_PREVIEW_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
export const EVENT_QUOTES_PREVIEW_FINAL_ID = "lk_subscription_price_preview_20260908_final";
export const EVENT_QUOTES_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const EVENT_QUOTES_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

// The installed generation the preview composition must be fed: the booking gateway and
// evaluator of the plan-rules release, the split/join bodies of the split-nominal-share
// release and the installed allowance block (paid-visit recompute + AUDIT_BINDING).
export const EVENT_QUOTES_INSTALLED_GENERATION = Object.freeze({
  bookingFuncSha256: "ed59d29ecb8af6d917e941b2a5d302c8124024a4ce12b450232206088247a88d",
  evaluatorFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "98229c7224fe81c3856071523307514b8df914440c8bf03a159a2e9a5c72fd8b",
});

// The reviewed postimages of this generation, measured on the preimage above.
export const EVENT_QUOTES_TARGETS = Object.freeze({
  previewRouter: {
    id: EVENT_QUOTES_PREVIEW_ROUTER_ID,
    liveFuncSha256: "3ac29cf0c5133627a3d5d24954b50e574bb32114b0d681d016972f1cda6464a6",
    // Re-pinned after `lk1-event-diagnostics` and again after `lk1-target-diagnostics`
    // changed the reviewed router source. The generation as deployed on 2026-09-15
    // shipped `9b4f69b5…` (see the incident doc).
    patchedFuncSha256: "1818dc8319144c840c7867b3f8ccce598d38a44d9aa7dc60c5e88a6e945a5d11",
  },
  previewFinal: {
    id: EVENT_QUOTES_PREVIEW_FINAL_ID,
    liveFuncSha256: "5312c42407db4a0cc4e2bff16b9711728522016ae49bd84794db713594cfa676",
    patchedFuncSha256: "7c822e2bb7efa35f8877b66656e367686a930867b6781d7e97ddaa29dba933b8",
  },
  booking: {
    id: EVENT_QUOTES_BOOKING_ID,
    liveFuncSha256: "ed59d29ecb8af6d917e941b2a5d302c8124024a4ce12b450232206088247a88d",
    patchedFuncSha256: "44073942212be41c0726aa0e073181b9796d6f41da022db893557df5174eacc9",
  },
});

// Exactly one reviewed delta on the booking gateway: the stale response provenance.
// The anchor carries `msg.payload = payload;` so it cannot match the managed-runtime
// request preparation (which builds an object payload) or any other emit site.
export const EVENT_QUOTES_BOOKING_ANCHOR = Object.freeze({
  before: "  msg.payload = payload;\n  delete msg.error;\n  delete msg.statusCode;\n  return emit(OUTPUT_HTTP);",
  after: "  msg.payload = payload;\n  delete msg.error;\n  delete msg.responseUrl;\n  delete msg.statusCode;\n  return emit(OUTPUT_HTTP);",
});

// Markers that prove the reviewed router/final sources really are what this generation
// ships. They are absent from the installed bodies and present exactly once after.
const ROUTER_MARKERS = Object.freeze([
  "const LIMIT_DECISION_BLOCKERS = ",
  "const UNAVAILABLE_DECISION_BLOCKERS = ",
  "ctx.managedIds = ctx.requestedIds.filter",
  "delete msg.responseUrl;",
  "tariffRefusal('product_amount'",
]);
const ROUTER_ABSENT_MARKERS = Object.freeze([
  // The dropped cohort filter and the HUB-only event ownership are what shipped before.
  "ctx.requestedIds = ctx.requestedIds.filter(id => ctx.rules[id].matched && !ctx.rules[id].legacy);",
  "const owned = eventRoute ? canonical.identityMoneyOwned(bound, available) : canonical.identityOwned(bound, available, exercise);",
  "if (decision.blockers?.length === 1 && decision.blockers[0].code === 'ACTIVE_SERVICES_LIMIT_REACHED')",
]);
const FINAL_MARKERS = Object.freeze(["...(ctx.errorDetails ? { details: ctx.errorDetails } : {})"]);

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

function assertMarkers(body, present, absent, label) {
  for (const marker of present) {
    if ((body.split(marker).length - 1) !== 1) {
      throw new Error(`${label} is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of absent) {
    if (body.includes(marker)) throw new Error(`${label} still carries the superseded body: ${marker}`);
  }
}

export function patchEventQuotesBookingBody(source, target = EVENT_QUOTES_TARGETS.booking) {
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  const { before, after } = EVENT_QUOTES_BOOKING_ANCHOR;
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(`Booking gateway request-preparation anchor drift: ${occurrences} occurrences`);
  }
  const patched = source.replace(before, () => after);
  assertFunctionBody(patched, "Patched booking gateway body");
  if (sha256(patched) !== target.patchedFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${sha256(patched)} != ${target.patchedFuncSha256}`);
  }
  return patched;
}

export function composeEventQuotesPreviewRouter(flow, target = EVENT_QUOTES_TARGETS.previewRouter) {
  const generation = EVENT_QUOTES_INSTALLED_GENERATION;
  const preview = flow.find((node) => node.id === target.id);
  const booking = flow.find((node) => node.id === EVENT_QUOTES_BOOKING_ID);
  const evaluator = flow.find((node) => node.id === EVENT_QUOTES_EVALUATOR_ID);
  assertFunctionNode(preview, target.id);
  assertFunctionNode(booking, EVENT_QUOTES_BOOKING_ID);
  assertFunctionNode(evaluator, EVENT_QUOTES_EVALUATOR_ID);
  if (sha256(preview.func) !== target.liveFuncSha256) {
    throw new Error(`Preview router installed preimage drift: ${sha256(preview.func)} != ${target.liveFuncSha256}`);
  }
  for (const [label, node, expected] of [
    ["booking", booking, generation.bookingFuncSha256],
    ["evaluator", evaluator, generation.evaluatorFuncSha256],
  ]) {
    if (sha256(node.func) !== expected) {
      throw new Error(`Preview ${label} pin mismatch: ${sha256(node.func)} != ${expected}`);
    }
  }
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
  assertFunctionBody(composed.router, "Composed preview router body");
  assertMarkers(composed.router, ROUTER_MARKERS, ROUTER_ABSENT_MARKERS, "Composed preview router");
  const digest = sha256(composed.router);
  if (digest !== target.patchedFuncSha256) {
    throw new Error(`Preview router postimage drift: ${digest} != ${target.patchedFuncSha256}`);
  }
  return composed;
}

export function composeLk1EventQuotesArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expectedSourceSha256 = options.expectedSourceSha256 ?? EVENT_QUOTES_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (flow.length !== EVENT_QUOTES_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${EVENT_QUOTES_SOURCE_NODE_COUNT}`);
  }
  const previewRouter = assertFunctionNode(flow.find((node) => node.id === EVENT_QUOTES_PREVIEW_ROUTER_ID),
    EVENT_QUOTES_PREVIEW_ROUTER_ID);
  const previewFinal = assertFunctionNode(flow.find((node) => node.id === EVENT_QUOTES_PREVIEW_FINAL_ID),
    EVENT_QUOTES_PREVIEW_FINAL_ID);
  const booking = assertFunctionNode(flow.find((node) => node.id === EVENT_QUOTES_BOOKING_ID), EVENT_QUOTES_BOOKING_ID);
  // Everything except `func` must survive each delta byte for byte.
  const unchanged = (node) => JSON.parse(JSON.stringify({ ...node, func: null }));
  const routerBefore = unchanged(previewRouter);
  const finalBefore = unchanged(previewFinal);
  const bookingBefore = unchanged(booking);
  const beforeRouter = sha256(previewRouter.func);
  const beforeFinal = sha256(previewFinal.func);
  const beforeBooking = sha256(booking.func);

  const composed = composeEventQuotesPreviewRouter(flow);
  const finalSource = options.finalSource
    ?? fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)),
      "nodered_subscription_price_preview_nodes", "final.js"), "utf8");
  if (sha256(finalSource) !== EVENT_QUOTES_TARGETS.previewFinal.patchedFuncSha256) {
    throw new Error(`Preview final source drift: ${sha256(finalSource)} != `
      + EVENT_QUOTES_TARGETS.previewFinal.patchedFuncSha256);
  }
  assertMarkers(finalSource, FINAL_MARKERS, [], "Preview final source");
  assertFunctionBody(finalSource, "Preview final body");

  previewRouter.func = composed.router;
  previewFinal.func = finalSource;
  booking.func = patchEventQuotesBookingBody(booking.func);

  for (const [node, before, target, label] of [
    [previewRouter, routerBefore, EVENT_QUOTES_TARGETS.previewRouter, "preview router"],
    [previewFinal, finalBefore, EVENT_QUOTES_TARGETS.previewFinal, "preview final"],
  ]) {
    if (JSON.stringify({ ...node, func: null }) !== JSON.stringify(before)) {
      throw new Error(`Preview ${label} changed a field other than func`);
    }
    if (sha256(node.func) !== target.patchedFuncSha256) {
      throw new Error(`Preview ${label} postimage drift`);
    }
  }
  if (JSON.stringify({ ...booking, func: null }) !== JSON.stringify(bookingBefore)) {
    throw new Error("Booking gateway changed a field other than func");
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [
    { id: EVENT_QUOTES_PREVIEW_ROUTER_ID, fields: ["func"],
      func: { beforeSha256: beforeRouter, afterSha256: sha256(previewRouter.func) } },
    { id: EVENT_QUOTES_PREVIEW_FINAL_ID, fields: ["func"],
      func: { beforeSha256: beforeFinal, afterSha256: sha256(previewFinal.func) } },
    { id: EVENT_QUOTES_BOOKING_ID, fields: ["func"],
      func: { beforeSha256: beforeBooking, afterSha256: sha256(booking.func) } },
  ];
  const allowedChanges = changes.map((change) => ({ id: change.id, fields: change.fields }));
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId, allowedChanges,
    allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow,
    candidateBytes,
    contract,
    changes,
    addedNodeCount: 0,
    sourceSha256,
    candidateSha256: sha256(candidateBytes),
    preview: {
      routerId: EVENT_QUOTES_PREVIEW_ROUTER_ID,
      finalId: EVENT_QUOTES_PREVIEW_FINAL_ID,
      exportedNameCount: composed.exportedNames.length,
      eventHelpersPublished: ["identityMoneyOwned", "lk1LifecycleInstant", "managedExternalEventTypeId"]
        .every((name) => composed.exportedNames.includes(name)),
      otherFieldsUnchanged: true,
    },
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
  const built = composeLk1EventQuotesArtifacts(liveBytes, EVENT_QUOTES_DEPLOYMENT_ID, {
    expectedSourceSha256: EVENT_QUOTES_SOURCE_SHA256,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const report = {
    kind: EVENT_QUOTES_KIND,
    deploymentId: EVENT_QUOTES_DEPLOYMENT_ID,
    targets: {
      previewRouter: { id: EVENT_QUOTES_PREVIEW_ROUTER_ID,
        func: { beforeSha256: EVENT_QUOTES_TARGETS.previewRouter.liveFuncSha256,
          afterSha256: EVENT_QUOTES_TARGETS.previewRouter.patchedFuncSha256 } },
      previewFinal: { id: EVENT_QUOTES_PREVIEW_FINAL_ID,
        func: { beforeSha256: EVENT_QUOTES_TARGETS.previewFinal.liveFuncSha256,
          afterSha256: EVENT_QUOTES_TARGETS.previewFinal.patchedFuncSha256 } },
      booking: { id: EVENT_QUOTES_BOOKING_ID,
        func: { beforeSha256: EVENT_QUOTES_TARGETS.booking.liveFuncSha256,
          afterSha256: EVENT_QUOTES_TARGETS.booking.patchedFuncSha256 } },
    },
    installedGeneration: { ...EVENT_QUOTES_INSTALLED_GENERATION },
    sourceSha256: verified.sourceSha256,
    candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 3,
    addedNodeCount: built.addedNodeCount,
    changes: built.changes,
    preview: built.preview,
    topologyChanged: false,
    routesChanged: false,
    policyChanged: false,
    deploymentPerformed: false,
    liveMutationPerformed: false,
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
