#!/usr/bin/env node

// Focused Node-RED generation: the club co-pay of «Дружба Топократы» becomes chargeable.
//
// Owner decision 2026-09-26 / incident 2026-09-25: a Topokraty training (direction 6233) is
// bookable with the club product 14692232-12be-4218-9fa1-2d5b79b62035 — the free hour is carried
// by the subscription visit and everything above it is billed as a quarter-of-court co-pay with
// the decision's own percent. The contour that priced that rule was generated and then rolled
// back because the *money mandate* it needs was never installed: the live body carried only the
// reviewed `lk1EventPaymentBinding`, while `lk1ClubEventPaymentBinding` / `lk1EventPaymentQuoteBinding`
// (PR #153, already in `scripts/nodered_lk1_hub_nodes/event_payments.js` and called from
// `gateway.js`) were missing from the installed flow. Without them a charged club event fails
// the money readback, so the co-pay could not be collected at all.
//
// This generation stacks on the installed 2026-09-25 rejection/reclaim generation
// (`9d2487a4…`) and changes exactly three fields of three nodes:
//   1. `lk_subscription_booking_router_20260804.func` — the reviewed club money mandate
//      (both functions, inserted verbatim from the reviewed source, plus the five call sites
//      switched to the quote resolver) and the reviewed club contour deltas
//      (`exerciseDirectionId` helper, `directionId` in the server-resolved target, the
//      decision-percent helper and the quote comparison that uses it);
//   2. `lk_subscription_booking_router_20260804.initialize` — the plan-rules writer is
//      replaced by the guarded 7→8 rule transition naming the club product (`planKey`
//      `topocraty`), accepting the empty post-restart context of 147;
//   3. `lk_subscription_managed_policy_20260820.func` — the embedded LK1 copy is replaced by
//      the reviewed evaluator with the club training branch (shared free hour + quarter-of-court
//      co-pay, full price once the hour is unavailable);
// The preview node is deliberately NOT changed. Recomposing it on the patched generation and
// re-applying the 2026-09-25 Topokraty exclusion reproduces the installed body byte for byte
// (`7605df8c…`), so the generation proves that equality instead of rewriting the node: the club
// recomposition result is exactly the reviewed club preview (`272b32b9…`) plus the exclusion
// delta the installed generation already carries. The shared preview sources stay untouched, so
// the frozen candidates of the earlier generations cannot move.
//
// Preparation only: nothing is deployed, imported or restarted here, and the patcher fails
// closed unless the preimage is exactly the reviewed installed flow (`9d2487a4…`).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { eventPaymentRoutesSource } from "./lib/eventPaymentSources.mjs";
import { topokratyExclusionSource } from "./lib/eventPaymentSources.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import {
  TOPOKRATY_REVERT_INITIALIZE_POSTIMAGE_SHA256,
  TOPOKRATY_TARGET as REVIEWED_CLUB_TARGET,
  patchTopokratyEvaluatorBody,
  patchTopokratyGatewayBody,
  patchTopokratyGatewayInitialize,
  patchTopokratyGatewayInitializeRevert,
} from "./patch_live_lk1_topokraty_friendship_hotfix.mjs";

export const TOPOKRATY_COPAY_DEPLOYMENT_ID = "lk1-topokraty-copay";
export const TOPOKRATY_COPAY_KIND = "FOCUSED_LK1_TOPOKRATY_COPAY_V1";

// Reviewed live preimage: the installed 2026-09-25 rejection/reclaim generation.
export const TOPOKRATY_COPAY_UPSTREAM_SHA256 =
  "9d2487a470a86bd0f8d3104aa029b81a6292a738209338740fe3f2d37dc0ed8d";
export const TOPOKRATY_COPAY_SOURCE_NODE_COUNT = 4804;

export const TOPOKRATY_COPAY_GATEWAY_ID = "lk_subscription_booking_router_20260804";
export const TOPOKRATY_COPAY_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";
export const TOPOKRATY_COPAY_PREVIEW_ID = "lk_subscription_price_preview_20260908_router";

export const TOPOKRATY_COPAY_TARGET = Object.freeze({
  gatewayId: TOPOKRATY_COPAY_GATEWAY_ID,
  liveFuncSha256: "8af66369c36b2439133f35ef4b9457d08b5189b6aa73d268bcc254b1a70ff6fc",
  liveInitializeSha256: "f373346fc14ba52988c59269b803bb2297a39db24c81ae6d570ecaf6f5d7728a",
  evaluatorId: TOPOKRATY_COPAY_EVALUATOR_ID,
  liveEvaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
  previewId: TOPOKRATY_COPAY_PREVIEW_ID,
  livePreviewFuncSha256: "7605df8c0f89c68cbf865b490e5437260c5b2cc8495cd2a5127ad04e09d30dab",
  patchedFuncSha256: "ea704144c296e7c6e44ed1723d7b8ec80170642cb7e7980a5ff1b5bc563b3627",
  patchedInitializeSha256: "08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602",
  patchedEvaluatorFuncSha256: "443f2633e92f1aa4ce2f2df85b6e100a216a9cebcbc136a30c4c7a2ec8284a63",
  patchedPreviewFuncSha256: "PENDING_COMPOSITION",
});

// The installed preview composition pins of this generation: the split/join bodies and the
// allowance block are the installed ones, never the reviewed preimage defaults of another line.
export const TOPOKRATY_COPAY_PREVIEW_INSTALLED = Object.freeze({
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// Present only after this generation.
export const TOPOKRATY_COPAY_PATCH_MARKER = "lk1EventPaymentQuoteBinding";
export const TOPOKRATY_COPAY_CLUB_MARKER = "lk1ClubEventPaymentBinding";

const REVIEWED_EVENT_PAYMENTS = "scripts/nodered_lk1_hub_nodes/event_payments.js";
const CLUB_FRAGMENT_START = "// The club training («Дружба Топократы», direction 6233) spends the free hour";
const CLUB_FRAGMENT_END = "  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);\n";
export const TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256 =
  "e4408e472ec708a8587ad3f343f0bb8c3bcfdaff64a8058903f314d33cf61017";

// The end of the installed legacy binding: the club mandate is inserted right after it, so the
// quote resolver can fall back to the reviewed binding it already knows.
const LEGACY_BINDING_END = `  return {
    productId: target.priceProductId, productType: "SERVICE", baseMinor: base,
    chargeMinor: decision.benefit.finalPriceMinor,
    discountMinor: base - decision.benefit.finalPriceMinor
  };
};
`;

// The five call sites of the installed body that must resolve through the club-aware quote
// binding. The definition itself is deliberately not in this list.
const CALL_SITE_DELTAS = Object.freeze([
  { id: "prepare-event-payment",
    before: `const binding = lk1EventPaymentBinding(ctx);
  const products = lk1PaymentProductRows(msg.payload);`,
    after: `const binding = lk1EventPaymentQuoteBinding(ctx);
  const products = lk1PaymentProductRows(msg.payload);` },
  { id: "checkout",
    before: `if (route && !lk1EventPaymentBinding(ctx)) return lk1Stop(ctx, route.code + "_BINDING_INVALID");`,
    after: `if (route && !lk1EventPaymentQuoteBinding(ctx)) return lk1Stop(ctx, route.code + "_BINDING_INVALID");` },
  { id: "ingress-replay",
    before: `const binding = lk1EventPaymentBinding({
        ...ctx, category: operation.category,`,
    after: `const binding = lk1EventPaymentQuoteBinding({
        ...ctx, category: operation.category,` },
  { id: "payment-products-readback",
    before: `const binding = eventPayment ? lk1EventPaymentBinding(ctx) : null;`,
    after: `const binding = eventPayment ? lk1EventPaymentQuoteBinding(ctx) : null;` },
  { id: "transaction-readback",
    before: `    const binding = lk1EventPaymentBinding(ctx);
    if (!binding || !isObj(intent) || intent.productId !== binding.productId`,
    after: `    const binding = lk1EventPaymentQuoteBinding(ctx);
    if (!binding || !isObj(intent) || intent.productId !== binding.productId` },
]);

// The 2026-09-25 Topokraty exclusion of the preview, re-applied after the recomposition because
// the shared preview sources must stay byte-identical (see the header note).
const PREVIEW_KEY_ANCHOR = `const key = (kind, ...parts) => JSON.stringify([kind, ctx.tenantKey, ...parts]);`;
const PREVIEW_QUOTE_ANCHOR = `  if (!available.length) { quote(id, 'UNAVAILABLE', null, 0, 0, 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE'); continue; }`;
const PREVIEW_EXCLUSION_BLOCK = `  // A Topokraty event is outside every non-club subscription (owner decision 2026-09-26):
  // Viva scopes «РА», «Академия» and «Дружба» to their own directions and refuses a carried
  // write on 6180/6233 with 400 BAD_REQUEST, so the advisory quote must not promise that
  // benefit either. The club product «Дружба Топократы» keeps its own rule and stays quoted
  // (the quarter-of-court co-pay).
  if (eventRoute && eventRoute.category === 'group_training' && isTopokratyExercise(exercise)) {
    const topokratyClubRow = Object.assign({}, canonical.isObj(live) ? live : {},
      { productId: productId || live?.productId });
    if (!isTopokratyClubPack(topokratyClubRow)) {
      quote(id, 'UNAVAILABLE', null, 0, 0, 'TOPOKRATY_SUBSCRIPTION_UNAVAILABLE'); continue;
    }
  }
`;

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
// The candidate this generation publishes; the ordered rollback refuses any other applied flow.
export const TOPOKRATY_COPAY_APPLIED_SHA256 =
  "70b9350fedee6b0ab8555d0a47ebcbeb2c7d43ec7a241e3e7fafa8e40750cbf1";

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

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin === "PENDING_COMPOSITION") return;
  if (sha256(body) !== pin) throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
}

function applyDeltas(source, deltas, label) {
  let patched = source;
  for (const delta of deltas) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  return patched;
}

/** The reviewed club money mandate, extracted verbatim from the reviewed payment source. */
export function clubMoneyFragment() {
  const source = eventPaymentRoutesSource();
  const start = source.indexOf(CLUB_FRAGMENT_START);
  if (start < 0) throw new Error("Reviewed club money fragment is absent");
  const end = source.indexOf(CLUB_FRAGMENT_END, start);
  if (end < 0) throw new Error("Reviewed club money fragment end is absent");
  const fragment = source.slice(start, end + CLUB_FRAGMENT_END.length);
  if (sha256(fragment) !== TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256) {
    throw new Error(`Club money fragment drift: ${sha256(fragment)} != ${TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256}`);
  }
  return fragment;
}

/** The reviewed booking body of this generation: money mandate plus the club contour. */
export function patchTopokratyCopayBookingBody(source, target = TOPOKRATY_COPAY_TARGET) {
  if (source.includes(TOPOKRATY_COPAY_CLUB_MARKER)) {
    throw new Error("Booking gateway already carries the club money mandate");
  }
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  // 1. The reviewed club contour deltas of the 2026-09-26 decision, reused verbatim through the
  //    reviewed patcher and re-anchored on this preimage by its own uniqueness proofs.
  const withContour = patchTopokratyGatewayBody(source, {
    ...REVIEWED_CLUB_TARGET, liveFuncSha256: target.liveFuncSha256,
  });
  // 2. The money mandate the contour assumed was installed, and the call sites that resolve it.
  const withMoney = applyDeltas(withContour,
    [{ id: "club-money-fragment", before: LEGACY_BINDING_END,
      after: `${LEGACY_BINDING_END}\n${clubMoneyFragment()}` }], "Topokraty co-pay money");
  const patched = applyDeltas(withMoney, CALL_SITE_DELTAS, "Topokraty co-pay call sites");
  if (patched.split("const lk1EventPaymentBinding = (ctx, quote = ctx.lk1) => {").length !== 2) {
    throw new Error("The legacy binding must stay declared exactly once");
  }
  if (patched.split("const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {").length !== 2) {
    throw new Error("The club binding must be embedded exactly once");
  }
  if (patched.split("const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>").length !== 2) {
    throw new Error("The quote resolver must be embedded exactly once");
  }
  // The five installed call sites (four in the gateway body, one in the payment helper) must
  // resolve through the club-aware quote binding; the definition itself carries no call.
  if (patched.split("lk1EventPaymentQuoteBinding(").length - 1 !== 5) {
    throw new Error("Every event-payment call site must resolve through the quote binding");
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  return patched;
}

/** The composed preview of this generation: recomposed, then the 2026-09-25 exclusion re-applied. */
export function patchTopokratyCopayPreviewBody(source) {
  if (source.includes("function isTopokratyExercise(value) {")) {
    throw new Error("Preview body already carries the Topokraty exclusion");
  }
  const moduleSource = topokratyExclusionSource();
  const withModule = applyDeltas(source,
    [{ id: "preview-module", before: PREVIEW_KEY_ANCHOR, after: `${moduleSource}\n${PREVIEW_KEY_ANCHOR}` }],
    "Topokraty co-pay preview module");
  const patched = applyDeltas(withModule,
    [{ id: "preview-refusal", before: PREVIEW_QUOTE_ANCHOR, after: `${PREVIEW_EXCLUSION_BLOCK}${PREVIEW_QUOTE_ANCHOR}` }],
    "Topokraty co-pay preview refusal");
  if (patched.split("function isTopokratyExercise(value) {").length !== 2) {
    throw new Error("The preview must embed the Topokraty module exactly once");
  }
  if (patched.split("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE").length !== 2) {
    throw new Error("The preview refusal must enter the body exactly once");
  }
  assertFunctionBody(patched, "Patched preview body");
  return patched;
}

/** Composes the candidate; fails closed on any preimage, shape, parse or graph mismatch. */
export function composeTopokratyCopayArtifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? TOPOKRATY_COPAY_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow is not a node array");
  if (flow.length !== TOPOKRATY_COPAY_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${TOPOKRATY_COPAY_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_COPAY_GATEWAY_ID), TOPOKRATY_COPAY_GATEWAY_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_COPAY_PREVIEW_ID), TOPOKRATY_COPAY_PREVIEW_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_COPAY_EVALUATOR_ID), TOPOKRATY_COPAY_EVALUATOR_ID);
  if (sha256(evaluator.func) !== TOPOKRATY_COPAY_TARGET.liveEvaluatorFuncSha256) {
    throw new Error(`Evaluator installed preimage drift: ${sha256(evaluator.func)}`);
  }
  if (sha256(preview.func) !== TOPOKRATY_COPAY_TARGET.livePreviewFuncSha256) {
    throw new Error(`Preview installed preimage drift: ${sha256(preview.func)}`);
  }
  if (sha256(booking.initialize) !== TOPOKRATY_COPAY_TARGET.liveInitializeSha256) {
    throw new Error(`Gateway initialize installed preimage drift: ${sha256(booking.initialize)}`);
  }
  const beforeBookingFunc = sha256(booking.func);
  const beforeInitialize = sha256(booking.initialize);
  const beforeEvaluatorFunc = sha256(evaluator.func);
  const beforePreviewFunc = sha256(preview.func);
  const previewShape = JSON.parse(JSON.stringify({ ...preview, func: null }));

  booking.func = patchTopokratyCopayBookingBody(booking.func);
  booking.initialize = patchTopokratyGatewayInitialize(booking.initialize, {
    ...REVIEWED_CLUB_TARGET, liveInitializeSha256: TOPOKRATY_COPAY_TARGET.liveInitializeSha256,
  });
  evaluator.func = patchTopokratyEvaluatorBody(evaluator.func, {
    ...REVIEWED_CLUB_TARGET, liveEvaluatorFuncSha256: TOPOKRATY_COPAY_TARGET.liveEvaluatorFuncSha256,
  });
  if (JSON.stringify({ ...preview, func: null }) !== JSON.stringify(previewShape)) {
    throw new Error("Preview node changed a field other than func");
  }
  assertFunctionBody(booking.func, "Patched booking gateway body");
  assertFunctionBody(booking.initialize, "Patched gateway initialize body");
  assertFunctionBody(evaluator.func, "Patched evaluator body");
  assertFunctionBody(preview.func, "Patched preview body");
  if (options.assertPostimages !== false) {
    assertPostimage(booking.func, options.patchedFuncSha256 ?? TOPOKRATY_COPAY_TARGET.patchedFuncSha256, "Booking");
    assertPostimage(booking.initialize, options.patchedInitializeSha256 ?? TOPOKRATY_COPAY_TARGET.patchedInitializeSha256, "Initialize");
    assertPostimage(evaluator.func, options.patchedEvaluatorFuncSha256 ?? TOPOKRATY_COPAY_TARGET.patchedEvaluatorFuncSha256, "Evaluator");
    if (sha256(preview.func) !== TOPOKRATY_COPAY_TARGET.livePreviewFuncSha256) {
      throw new Error("Preview must stay byte-identical to the installed body");
    }
  }

  // Provenance of the untouched preview: the club recomposition of the patched generation plus
  // the installed exclusion delta has to reproduce the installed body exactly.
  const recomposed = previewSources(flow, {
    pins: {
      booking: sha256(booking.func),
      evaluator: sha256(evaluator.func),
      pricing: options.pricingSha256 ?? TOPOKRATY_COPAY_PREVIEW_INSTALLED.splitFuncSha256,
      join: options.joinSha256 ?? TOPOKRATY_COPAY_PREVIEW_INSTALLED.joinFuncSha256,
    },
    installedUsageSha256: options.installedUsageSha256 ?? TOPOKRATY_COPAY_PREVIEW_INSTALLED.allowanceBlockSha256,
  });
  const recomposedWithExclusion = patchTopokratyCopayPreviewBody(recomposed.router);
  if (recomposedWithExclusion !== preview.func) {
    throw new Error(`Installed preview is not the club recomposition plus the exclusion delta: `
      + `${sha256(recomposedWithExclusion)} != ${sha256(preview.func)}`);
  }
  if (sha256(preview.func) !== beforePreviewFunc) throw new Error("Preview changed while proving provenance");

  const changes = [
    { id: TOPOKRATY_COPAY_GATEWAY_ID, fields: ["func", "initialize"],
      func: { beforeSha256: beforeBookingFunc, afterSha256: sha256(booking.func) },
      initialize: { beforeSha256: beforeInitialize, afterSha256: sha256(booking.initialize) } },
    { id: TOPOKRATY_COPAY_EVALUATOR_ID, fields: ["func"],
      func: { beforeSha256: beforeEvaluatorFunc, afterSha256: sha256(evaluator.func) } },
  ];
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: [...row.fields] }));
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: TOPOKRATY_COPAY_DEPLOYMENT_ID, allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  const quoteCallSites = booking.func.split("lk1EventPaymentQuoteBinding(").length - 1;
  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: {
      id: TOPOKRATY_COPAY_GATEWAY_ID,
      moneyMandateBound: booking.func.includes(TOPOKRATY_COPAY_CLUB_MARKER)
        && booking.func.includes("const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>")
        && quoteCallSites === 5,
      clubContourBound: booking.func.includes("const exerciseDirectionId = (exercise) => {")
        && booking.func.includes("directionId: exerciseDirectionId(exercise),")
        && booking.func.includes("lk1ExpectedEventDiscountPercent(decision, route)"),
      planRulesPayloadReplaced: booking.initialize.includes('"planKey":"topocraty"')
        && booking.initialize.includes("14692232-12be-4218-9fa1-2d5b79b62035"),
      excludedSubscriptionsStillRefused: booking.func.includes("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE"),
      reclaimStillBound: booking.func.includes("lk1ReclaimableAttempt(operation)"),
    },
    evaluator: {
      id: TOPOKRATY_COPAY_EVALUATOR_ID,
      clubBranchBound: evaluator.func.includes("isTopokratyTrainingBenefit")
        && evaluator.func.includes("eventDiscountPercent"),
    },
    preview: {
      id: TOPOKRATY_COPAY_PREVIEW_ID,
      unchanged: true,
      matchesClubRecomposition: recomposedWithExclusion === preview.func,
      topokratyExclusionKept: preview.func.includes("isTopokratyExercise(exercise)")
        && preview.func.includes("isTopokratyClubPack(topokratyClubRow)"),
      proTrainingKept: preview.func.includes("canonical.isProTrainingExercise"),
      resolverReachable: recomposed.router.includes("canonical.resolveLk1Rule"),
      helperCount: recomposed.helperNames.length,
    },
  };
}

/**
 * The ordered rollback of this generation. The club plan-rules global must go back to the
 * installed 7-rule payload *before* the flow is restored: restoring the preimage flow alone
 * would leave the writer with the club prior while its resolver has no club branch, and a
 * direction-6233 training would then be priced at the ordinary 50 %. This composes the
 * intermediate candidate — the applied flow with only its plan-rules writer reverted — which the
 * reviewed helper proves before the restore step.
 */
export function composeTopokratyCopayRevertArtifacts(rawSource) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== TOPOKRATY_COPAY_APPLIED_SHA256) {
    throw new Error(`Applied co-pay flow preimage drift: ${sourceSha256} != ${TOPOKRATY_COPAY_APPLIED_SHA256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  const gateway = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_COPAY_GATEWAY_ID), TOPOKRATY_COPAY_GATEWAY_ID);
  const before = sha256(gateway.initialize);
  gateway.initialize = patchTopokratyGatewayInitializeRevert(gateway.initialize);
  if (sha256(gateway.initialize) !== TOPOKRATY_REVERT_INITIALIZE_POSTIMAGE_SHA256) {
    throw new Error(`Reverted gateway initialize drift: ${sha256(gateway.initialize)}`);
  }
  const changes = [
    { id: TOPOKRATY_COPAY_GATEWAY_ID, fields: ["initialize"],
      initialize: { beforeSha256: before, afterSha256: sha256(gateway.initialize) } },
  ];
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: `${TOPOKRATY_COPAY_DEPLOYMENT_ID}-revert`,
    allowedChanges: changes.map((row) => ({ id: row.id, fields: [...row.fields] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return { flow, candidateBytes, contract, changes, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    initialize: { beforeSha256: before, afterSha256: sha256(gateway.initialize) } };
}

/** The ordered-rollback report the guarded wrapper validates. */
export function buildTopokratyCopayRevertReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: TOPOKRATY_COPAY_KIND, deploymentId: TOPOKRATY_COPAY_DEPLOYMENT_ID,
    mode: "revert",
    targets: { booking: { id: TOPOKRATY_COPAY_GATEWAY_ID,
      initialize: { beforeSha256: built.initialize.beforeSha256, afterSha256: built.initialize.afterSha256 } } },
    upstreamFlowSha256: TOPOKRATY_COPAY_APPLIED_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 1, addedNodeCount: 0,
    changes: built.changes,
    planRulesActivation: { key: "subscriptions_lk1_plan_rules", expectedPriorRuleCount: 8,
      desiredRuleCount: 7, clubProductId: "14692232-12be-4218-9fa1-2d5b79b62035", orderedRollbackStep: 1 },
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
}

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildTopokratyCopayReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: TOPOKRATY_COPAY_KIND, deploymentId: TOPOKRATY_COPAY_DEPLOYMENT_ID,
    targets: {
      booking: { id: TOPOKRATY_COPAY_GATEWAY_ID,
        func: { beforeSha256: TOPOKRATY_COPAY_TARGET.liveFuncSha256, afterSha256: built.changes[0].func.afterSha256 },
        initialize: { beforeSha256: TOPOKRATY_COPAY_TARGET.liveInitializeSha256,
          afterSha256: built.changes[0].initialize.afterSha256 } },
      evaluator: { id: TOPOKRATY_COPAY_EVALUATOR_ID,
        func: { beforeSha256: TOPOKRATY_COPAY_TARGET.liveEvaluatorFuncSha256,
          afterSha256: built.changes[1].func.afterSha256 } },
      preview: { id: TOPOKRATY_COPAY_PREVIEW_ID, unchanged: true,
        func: { beforeSha256: TOPOKRATY_COPAY_TARGET.livePreviewFuncSha256,
          afterSha256: TOPOKRATY_COPAY_TARGET.livePreviewFuncSha256 } },
    },
    upstreamFlowSha256: TOPOKRATY_COPAY_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 2, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, evaluator: built.evaluator, preview: built.preview,
    planRulesActivation: { key: "subscriptions_lk1_plan_rules", expectedPriorRuleCount: 7, desiredRuleCount: 8,
      clubProductId: "14692232-12be-4218-9fa1-2d5b79b62035" },
    clubTrainingDirection: 6233,
    topologyChanged: false, routesChanged: false, policyChanged: true,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
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
  const usage = "Usage: --mode generation --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>";
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--mode", "--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail(usage); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
  }
  if (!["generation", "revert"].includes(values["--mode"])) { fail(`${usage}\n--mode must be generation or revert`); return; }
  if (Object.keys(values).length !== 4) { fail(usage); return; }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = values["--mode"] === "revert"
    ? composeTopokratyCopayRevertArtifacts(liveBytes)
    : composeTopokratyCopayArtifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = values["--mode"] === "revert"
    ? buildTopokratyCopayRevertReport({ sourceSha256: verified.sourceSha256,
      sourceNodeCount: verified.nodeCount, built })
    : buildTopokratyCopayReport({ sourceSha256: verified.sourceSha256,
      sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`Topokraty co-pay generation failed: ${error.message}`);
  }
}
