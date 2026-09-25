#!/usr/bin/env node

// Focused Node-RED generation: a clean provider rejection no longer blocks the request id,
// and a Topokraty event leaves the general subscription contour.
//
// Production incident 2026-09-25 (direction 6233 «Топократы тренировка», 120 minutes, 4 000 ₽):
// the LK1 decision granted the free first event of the day (0 ₽) to a subscription the provider
// does not carry for that direction, Viva refused the write with
//
//   HTTP 400 BAD_REQUEST «Абонемент «РА» не действует на этом занятии: другой тип занятия,
//                        другое направление»
//
// and the stored operation stayed FAILED. Because the request id is deterministic
// (`lk-subscription-<hash(clientId|clientSubscriptionId|exerciseId)>`), every later attempt
// replayed that document and the ingress answered an unresolvable pending
// (`LK1_BOOKING_OUTCOME_UNRESOLVED`, «Запись или доплата требуют безопасной сверки») forever:
// neither the subscription, nor the co-pay, nor a one-off could be booked any more.
//
// This generation changes exactly two fields of two nodes:
//   1. `lk_subscription_booking_router_20260804.func`
//      a. the reviewed Topokraty exclusion module plus its refusal in the exercise step —
//         directions 6180/6233 stay outside every non-club subscription, and only the club
//         product «Дружба Топократы» (14692232-12be-4218-9fa1-2d5b79b62035) keeps the
//         subscription path with its quarter-of-court co-pay rule;
//      b. the ingress reclaim — a stored attempt that never reached a booking and whose
//         provider write was cleanly refused (4xx) is handed back to PREPARED under its own
//         id, so the next request is a real new attempt instead of an endless pending.
//   2. `lk_subscription_price_preview_20260908_router.func` — recomposed on the patched
//      generation, so the advisory quote never advertises a benefit the write path refuses.
//
// Preparation only: nothing is deployed, imported or restarted here, and the patcher fails
// closed unless the preimage is exactly the reviewed installed flow (`d6df38f3…`).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { topokratyExclusionSource } from "./lib/eventPaymentSources.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const TOPOKRATY_RECLAIM_DEPLOYMENT_ID = "lk1-topokraty-rejection-reclaim";
export const TOPOKRATY_RECLAIM_KIND = "FOCUSED_LK1_TOPOKRATY_REJECTION_RECLAIM_V1";

// Reviewed live preimage: the read-only 2026-09-25 pull from lk-primary-147, carrying the
// plan-rules, station-exclusions, PRO-training, rejoin and Topokraty-contour generations.
export const TOPOKRATY_RECLAIM_UPSTREAM_SHA256 =
  "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe";
export const TOPOKRATY_RECLAIM_SOURCE_NODE_COUNT = 4804;

export const TOPOKRATY_RECLAIM_GATEWAY_ID = "lk_subscription_booking_router_20260804";
export const TOPOKRATY_RECLAIM_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";
export const TOPOKRATY_RECLAIM_PREVIEW_ID = "lk_subscription_price_preview_20260908_router";

export const TOPOKRATY_RECLAIM_TARGET = Object.freeze({
  gatewayId: TOPOKRATY_RECLAIM_GATEWAY_ID,
  liveFuncSha256: "a230800da9b144d3f51ff02929e63d0c21e01c2f59e3485091aab5b46d21fae0",
  patchedFuncSha256: "8af66369c36b2439133f35ef4b9457d08b5189b6aa73d268bcc254b1a70ff6fc",
  evaluatorId: TOPOKRATY_RECLAIM_EVALUATOR_ID,
  liveEvaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
  previewId: TOPOKRATY_RECLAIM_PREVIEW_ID,
  livePreviewFuncSha256: "9d99004da35aa4fccc8e32f0c6afd0dbd2f16466502324da4468fe4ab09f2bd9",
  patchedPreviewFuncSha256: "7605df8c0f89c68cbf865b490e5437260c5b2cc8495cd2a5127ad04e09d30dab",
});

// The installed preview composition pins of this generation: the split/join bodies and the
// allowance block are the installed ones, never the reviewed preimage defaults of another line.
export const TOPOKRATY_RECLAIM_PREVIEW_INSTALLED = Object.freeze({
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

// Present only after this generation. A second run is refused instead of produced.
export const TOPOKRATY_RECLAIM_PATCH_MARKER = "lk1ReclaimableAttempt";
export const TOPOKRATY_EXCLUSION_PATCH_MARKER = "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE";

const REVIEWED_GATEWAY_SOURCE = "scripts/nodered_lk1_hub_nodes/gateway.js";
const REVIEWED_HOOKS_SOURCE = "scripts/nodered_lk1_hub_nodes/gateway_hooks.js";

// The PRO refusal of the installed body: the Topokraty refusal is inserted right after it, so
// both exclusions live in the same reviewed step and keep the same ordering guarantees.
const PRO_GUARD_ANCHOR = `  const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
  const proTrainingEnergyAllowed = selectedOwned.length === 1
    && isProTrainingEnergyPack(selectedOwned[0]);
  if (resolveCategory(exercise) === "group_training"
    && isProTrainingExercise(exercise)
    && !proTrainingEnergyAllowed) {
    return finishError(ctx, 409, "На ПРО-тренировки подписки не действуют: доступна только оплата по полной цене", {
      code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE",
    });
  }
`;

const TOPOKRATY_GUARD = `  // A Topokraty event is outside every non-club subscription. Viva scopes a sold plan to its
  // own directions and exercise types, so carrying «РА», «Академия» or «Дружба» to direction
  // 6180/6233 is refused by the provider with 400 BAD_REQUEST after the contour has already
  // promised the benefit. The club product «Дружба Топократы» keeps its own plan rule (the
  // quarter-of-court co-pay) and is therefore the only owned row allowed here; every other
  // attempt is refused before the write and the event stays bookable as a one-off.
  if (resolveCategory(exercise) === "group_training"
    && isTopokratyExercise(exercise)
    && !(selectedOwned.length === 1 && isTopokratyClubPack(selectedOwned[0]))) {
    return finishError(ctx, 409,
      "На тренировки Топократов общие подписки не действуют: доступна разовая оплата или клубная подписка «Дружба Топократы»", {
        code: "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
      });
  }
`;

const EXERCISE_STEP_ANCHOR = `if (ctx.step === "exercise") {
  if (!isHttpOk(msg.statusCode)) {`;

// The ingress lookup of the installed body. The reviewed source file no longer carries this
// text verbatim (the installed generation was composed from several stacked deltas), so the
// fragment is pinned by the live body itself: this anchor, its occurrence count and the preimage
// sha of the whole function body.
const INGRESS_STEP_ANCHOR = `if (ctx.step === "lk1_ingress_operation_find") {
  // Pure retry lookup, never the mutating operation_find/checkout continuation.`;

const RECLAIM_HELPER = `// A stored attempt whose provider write was cleanly refused, or that never reached the
// provider at all, is terminal and unambiguous. The request id is deterministic
// (clientId|subscription|exercise), so without this reclaim a single refusal would make the
// exercise permanently unbookable for that client: every retry replays the same document and
// the ingress answers an unresolvable pending (production incident 2026-09-25, direction 6233
// «Топократы тренировка»: Viva refused «Абонемент «РА» не действует на этом занятии: другой тип
// занятия, другое направление», and neither the subscription, the co-pay nor a one-off could be
// booked afterwards).
// Portable on purpose: this fragment is composed both with and without the hook helpers, so it
// brings its own two readers instead of relying on isObj/toStr.
const lk1ReclaimIsRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lk1ReclaimText = (value) => (typeof value === "string" && value.trim()) ? value.trim()
  : (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
const LK1_RECLAIM_ATTEMPT_CAP = 5;
const lk1ReclaimableAttempt = (operation) => {
  if (!lk1ReclaimIsRecord(operation)) return false;
  // A bounded number of restarts: an attempt that keeps failing on unchanged conditions must
  // not be replayed forever.
  if ((Number(operation.attempts) || 0) >= LK1_RECLAIM_ATTEMPT_CAP) return false;
  // An attempt that ever reached a booking, an accepted provider write or a money leg is never
  // replayed: its outcome is not ours to repeat.
  if (lk1ReclaimText(operation.bookingId) || lk1ReclaimText(operation.upstreamBookingId)) return false;
  if (lk1ReclaimText(operation.acceptedAt) || lk1ReclaimText(operation.correlationId)) return false;
  if (lk1ReclaimText(operation.lk1?.createAttemptedAt) || lk1ReclaimText(operation.lk1?.bookingAttemptedAt)) return false;
  if (lk1ReclaimText(operation.lk1?.transactionAttemptedAt) || lk1ReclaimText(operation.lk1?.transactionId)
    || lk1ReclaimIsRecord(operation.lk1?.transactionIntent) || lk1ReclaimIsRecord(operation.lk1?.checkout)
    || lk1ReclaimIsRecord(operation.lk1?.visitJob)) return false;
  if (operation.state === "FAILED") {
    const failure = operation.failure;
    if (!lk1ReclaimIsRecord(failure)) return false;
    const status = Number(failure.statusCode);
    // Only an explicit provider refusal (4xx) is a clean verdict. A 5xx or a transport failure
    // leaves the outcome unknown and keeps the existing reconciliation path.
    if (!Number.isInteger(status) || status < 400 || status >= 500) return false;
    return Boolean(lk1ReclaimText(operation.upstreamAttemptedAt) && lk1ReclaimText(operation.failedAt));
  }
  // Nothing was ever attempted: the document only reserved the deterministic id.
  return operation.state === "PREPARED" && !lk1ReclaimText(operation.upstreamAttemptedAt);
};
`;

const UNRESOLVED_STOP = `    if (operation.state !== "CONFIRMED" || typeof operation.bookingId !== "string" || !operation.bookingId.trim()
      || typeof operation.exerciseId !== "string" || !operation.exerciseId.trim()
      || operation.exerciseId.startsWith("preflight:") || quote.target.eventId !== operation.exerciseId) {
      return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
    }
`;

const RECLAIM_BRANCH = `    // The refusal is terminal, so the stored attempt is handed back to PREPARED under its own
    // id: the failure is kept for audit, the attempt counter is incremented, and the request
    // continues as a real new attempt instead of an unresolvable pending claim.
    if (ctx.caller !== "split_create_readonly_preflight" && lk1ReclaimableAttempt(operation)) {
      const reclaimedAt = new Date().toISOString();
      const reclaimQuery = {
        // The ingress path proves the document id but never sets ctx.operationKey, so the
        // validated _id of the found document is what the compare-and-set fences on.
        _id: operation._id, operationId: ctx.operationId, actorClientId: ctx.actorClientId,
        state: operation.state, bookingId: { $in: [null, ""] }, upstreamBookingId: { $in: [null, ""] },
        ...(Number.isSafeInteger(operation.attempts) ? { attempts: operation.attempts } : {}),
      };
      return prepareMongoUpdate(ctx, "lk1_ingress_reclaim", reclaimQuery, {
        $set: {
          state: "PREPARED", updatedAt: reclaimedAt, reclaimedAt,
          previousFailure: operation.failure || null, previousFailureAt: lk1ReclaimText(operation.failedAt) || null,
        },
        $unset: { failedAt: "", upstreamAttemptedAt: "", leaseUntil: "", pendingUntil: "", failure: "" },
        $inc: { attempts: 1, reclaimCount: 1 },
      });
    }
`;

const ORPHAN_HELPER_ANCHOR = `const releaseConfirmedOrphan = (ctx, bound) => {`;

// The advisory preview's own two anchors. The shared preview sources are deliberately left
// byte-identical to the installed generation: recomposing them would move the frozen candidate
// of an already-reviewed generation (and with it the ordered rollback contract of the club
// contour), so the exclusion enters the composed preview body as this generation's own delta.
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

const RECLAIM_STEP = `if (ctx.step === "lk1_ingress_reclaim") {
  if (msg.error || lk1MongoMatched(msg.payload) !== 1 || msg.payload.modifiedCount !== 1) {
    // Another request owns this attempt now: never overwrite it, and report the same
    // reconciliation stop the replay used before this generation.
    return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED");
  }
  // The claim is handed back: continue as a fresh attempt of the same deterministic id.
  delete ctx.lk1IngressReplay;
  ctx.step = "lk1_profile_continue";
}

`;

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

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin.startsWith("__") || pin === "PENDING_COMPOSITION") return;
  if (sha256(body) !== pin) {
    throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
  }
}

function assertReviewedSource(text, label) {
  if (!text.includes("//") || text.length < 200) throw new Error(`${label} reviewed fragment is too small`);
  return text;
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

// The reviewed fragments of this generation, exported so a test can prove that the composed
// live body and the reviewed gateway source carry exactly the same reviewed text.
export const TOPOKRATY_RECLAIM_FRAGMENTS = Object.freeze({
  helper: RECLAIM_HELPER, branch: RECLAIM_BRANCH, step: RECLAIM_STEP, guard: TOPOKRATY_GUARD,
  previewBlock: PREVIEW_EXCLUSION_BLOCK,
});

/** Every change of this generation, in application order. */
export function buildTopokratyReclaimDeltas() {
  const moduleSource = assertReviewedSource(topokratyExclusionSource(), "Topokraty exclusion module");
  return [
    { id: "topokraty-module", before: EXERCISE_STEP_ANCHOR,
      after: `${moduleSource}\n${EXERCISE_STEP_ANCHOR}` },
    { id: "topokraty-refusal", before: PRO_GUARD_ANCHOR,
      after: `${PRO_GUARD_ANCHOR}${TOPOKRATY_GUARD}` },
    { id: "ingress-reclaim-helper", before: INGRESS_STEP_ANCHOR,
      after: `${RECLAIM_HELPER}\n${INGRESS_STEP_ANCHOR}` },
    { id: "ingress-reclaim-branch", before: UNRESOLVED_STOP,
      after: `${RECLAIM_BRANCH}${UNRESOLVED_STOP}` },
    { id: "ingress-reclaim-step", before: ORPHAN_HELPER_ANCHOR,
      after: `${RECLAIM_STEP}${ORPHAN_HELPER_ANCHOR}` },
  ];
}

/** Every preview change of this generation, in application order. */
export function buildTopokratyReclaimPreviewDeltas() {
  const moduleSource = assertReviewedSource(topokratyExclusionSource(), "Topokraty exclusion module");
  return [
    { id: "preview-module", before: PREVIEW_KEY_ANCHOR, after: `${moduleSource}\n${PREVIEW_KEY_ANCHOR}` },
    { id: "preview-refusal", before: PREVIEW_QUOTE_ANCHOR, after: `${PREVIEW_EXCLUSION_BLOCK}${PREVIEW_QUOTE_ANCHOR}` },
  ];
}

/** The composed preview body of this generation. */
export function patchTopokratyReclaimPreviewBody(source) {
  if (source.includes(TOPOKRATY_EXCLUSION_PATCH_MARKER) || source.includes("function isTopokratyExercise(value) {")) {
    throw new Error("Preview body already carries this generation");
  }
  const patched = applyDeltas(source, buildTopokratyReclaimPreviewDeltas(), "Topokraty preview");
  if (patched.split("function isTopokratyExercise(value) {").length !== 2) {
    throw new Error("The preview must embed the Topokraty module exactly once");
  }
  if (patched.split(TOPOKRATY_EXCLUSION_PATCH_MARKER).length !== 2) {
    throw new Error("The preview refusal must enter the body exactly once");
  }
  if (patched.split("if (eventRoute && eventRoute.category === 'group_training' && isTopokratyExercise(exercise))").length !== 2) {
    throw new Error("The preview Topokraty guard must enter the body exactly once");
  }
  assertFunctionBody(patched, "Patched preview body");
  return patched;
}

/** The reviewed booking body of this generation. */
export function patchTopokratyReclaimBookingBody(source, target = TOPOKRATY_RECLAIM_TARGET) {
  if (source.includes(TOPOKRATY_RECLAIM_PATCH_MARKER) || source.includes(TOPOKRATY_EXCLUSION_PATCH_MARKER)) {
    throw new Error("Booking gateway already carries this generation");
  }
  if (sha256(source) !== target.liveFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveFuncSha256}`);
  }
  const patched = applyDeltas(source, buildTopokratyReclaimDeltas(), "Topokraty reclaim booking");
  if (patched.split("function isTopokratyExercise(value) {").length !== 2) {
    throw new Error("The Topokraty exclusion module must be embedded exactly once");
  }
  if (patched.split(TOPOKRATY_EXCLUSION_PATCH_MARKER).length !== 2) {
    throw new Error("The Topokraty refusal must enter the body exactly once");
  }
  if (patched.split("const lk1ReclaimableAttempt = (operation) => {").length !== 2) {
    throw new Error("The reclaim predicate must be embedded exactly once");
  }
  if (patched.split('ctx.step === "lk1_ingress_reclaim"').length !== 2) {
    throw new Error("The reclaim step must be embedded exactly once");
  }
  if (patched.split('prepareMongoUpdate(ctx, "lk1_ingress_reclaim"').length !== 2) {
    throw new Error("The reclaim write must be embedded exactly once");
  }
  // The refusal and the reclaim must precede every subscription money path of this body.
  const refusalIndex = patched.indexOf(TOPOKRATY_EXCLUSION_PATCH_MARKER);
  const moneyIndex = patched.indexOf('prepareUserGet(ctx, "lk1_money_owned_subscriptions"');
  if (moneyIndex < 0 || refusalIndex > moneyIndex) {
    throw new Error("The Topokraty refusal must precede the money readback");
  }
  const reclaimIndex = patched.indexOf("lk1ReclaimableAttempt(operation)");
  const unresolvedIndex = patched.indexOf('return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED")');
  if (reclaimIndex < 0 || unresolvedIndex < 0 || reclaimIndex > unresolvedIndex) {
    throw new Error("The reclaim branch must precede the unresolvable replay stop");
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  return patched;
}

/**
 * Composes the candidate: the installed flow with the booking body patched and the preview node
 * recomposed on top of it. Fails closed on any preimage, node-count, shape, parse, postimage or
 * graph mismatch.
 */
export function composeTopokratyReclaimArtifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? TOPOKRATY_RECLAIM_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow is not a node array");
  if (flow.length !== TOPOKRATY_RECLAIM_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${TOPOKRATY_RECLAIM_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_RECLAIM_GATEWAY_ID),
    TOPOKRATY_RECLAIM_GATEWAY_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_RECLAIM_PREVIEW_ID),
    TOPOKRATY_RECLAIM_PREVIEW_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === TOPOKRATY_RECLAIM_EVALUATOR_ID),
    TOPOKRATY_RECLAIM_EVALUATOR_ID);
  if (sha256(evaluator.func) !== TOPOKRATY_RECLAIM_TARGET.liveEvaluatorFuncSha256) {
    throw new Error(`Evaluator installed preimage drift: ${sha256(evaluator.func)}`);
  }
  if (sha256(preview.func) !== TOPOKRATY_RECLAIM_TARGET.livePreviewFuncSha256) {
    throw new Error(`Preview installed preimage drift: ${sha256(preview.func)}`);
  }
  const beforeBookingFunc = sha256(booking.func);
  const beforePreviewFunc = sha256(preview.func);
  const previewShape = JSON.parse(JSON.stringify({ ...preview, func: null }));
  booking.func = patchTopokratyReclaimBookingBody(booking.func);
  // The preview composes on the patched generation: its booking pin is the patched body, and the
  // split/join/allowance pins are the installed ones. The optional predicates the preview router
  // calls are embedded only because this body carries the refusals.
  const composed = previewSources(flow, {
    pins: {
      booking: sha256(booking.func),
      evaluator: sha256(evaluator.func),
      pricing: options.pricingSha256 ?? TOPOKRATY_RECLAIM_PREVIEW_INSTALLED.splitFuncSha256,
      join: options.joinSha256 ?? TOPOKRATY_RECLAIM_PREVIEW_INSTALLED.joinFuncSha256,
    },
    installedUsageSha256: options.installedUsageSha256
      ?? TOPOKRATY_RECLAIM_PREVIEW_INSTALLED.allowanceBlockSha256,
  });
  preview.func = patchTopokratyReclaimPreviewBody(composed.router);
  if (JSON.stringify({ ...preview, func: null }) !== JSON.stringify(previewShape)) {
    throw new Error("Preview node changed a field other than func");
  }
  if (!preview.func.includes("isTopokratyClubPack(")
    || preview.func.includes("canonical.isTopokratyExercise")) {
    throw new Error("The preview must call the reviewed Topokraty predicate directly");
  }
  if (!composed.router.includes("canonical.isProTrainingExercise")
    || composed.router.includes("const isProTrainingExercise = () => false;")) {
    throw new Error("The preview must keep the reviewed PRO-training predicate");
  }
  assertFunctionBody(booking.func, "Patched booking gateway body");
  assertFunctionBody(preview.func, "Composed preview body");
  if (options.assertPostimages !== false) {
    assertPostimage(booking.func, options.patchedBookingFuncSha256 ?? TOPOKRATY_RECLAIM_TARGET.patchedFuncSha256, "Booking");
    assertPostimage(preview.func, options.patchedPreviewFuncSha256 ?? TOPOKRATY_RECLAIM_TARGET.patchedPreviewFuncSha256, "Preview");
  }

  const changes = [
    { id: TOPOKRATY_RECLAIM_GATEWAY_ID, fields: ["func"],
      func: { beforeSha256: beforeBookingFunc, afterSha256: sha256(booking.func) } },
    { id: TOPOKRATY_RECLAIM_PREVIEW_ID, fields: ["func"],
      func: { beforeSha256: beforePreviewFunc, afterSha256: sha256(preview.func) } },
  ];
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: [...row.fields] }));
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: TOPOKRATY_RECLAIM_DEPLOYMENT_ID, allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: {
      id: TOPOKRATY_RECLAIM_GATEWAY_ID,
      moduleEmbeddedOnce: booking.func.split("function isTopokratyExercise(value) {").length === 2,
      refusalBound: booking.func.includes(TOPOKRATY_EXCLUSION_PATCH_MARKER)
        && booking.func.includes('resolveCategory(exercise) === "group_training"'),
      reclaimBound: booking.func.includes("lk1ReclaimableAttempt(operation)")
        && booking.func.includes('prepareMongoUpdate(ctx, "lk1_ingress_reclaim"'),
      reclaimPrecedesStop: booking.func.indexOf("lk1ReclaimableAttempt(operation)")
        < booking.func.indexOf('return lk1Stop(ctx, "LK1_BOOKING_OUTCOME_UNRESOLVED")'),
    },
    preview: {
      id: TOPOKRATY_RECLAIM_PREVIEW_ID,
      initializeUnchanged: preview.initialize === "",
      topokratyBound: preview.func.includes("isTopokratyExercise(exercise)")
        && preview.func.includes("isTopokratyClubPack(topokratyClubRow)"),
      proTrainingKept: preview.func.includes("canonical.isProTrainingExercise"),
      sharedPreviewSourcesUnchanged: !composed.router.includes("isTopokratyExercise(exercise)"),
      helperCount: composed.helperNames.length,
    },
  };
}

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildTopokratyReclaimReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: TOPOKRATY_RECLAIM_KIND, deploymentId: TOPOKRATY_RECLAIM_DEPLOYMENT_ID,
    targets: {
      booking: { id: TOPOKRATY_RECLAIM_GATEWAY_ID,
        func: { beforeSha256: TOPOKRATY_RECLAIM_TARGET.liveFuncSha256,
          afterSha256: built.changes[0].func.afterSha256 } },
      preview: { id: TOPOKRATY_RECLAIM_PREVIEW_ID,
        func: { beforeSha256: TOPOKRATY_RECLAIM_TARGET.livePreviewFuncSha256,
          afterSha256: built.changes[1].func.afterSha256 } },
    },
    upstreamFlowSha256: TOPOKRATY_RECLAIM_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 2, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, preview: built.preview,
    reviewedGatewaySource: REVIEWED_GATEWAY_SOURCE, reviewedHooksSource: REVIEWED_HOOKS_SOURCE,
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
  if (values["--mode"] !== "generation") { fail(`${usage}\n--mode must be generation`); return; }
  if (Object.keys(values).length !== 4) { fail(usage); return; }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeTopokratyReclaimArtifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = buildTopokratyReclaimReport({ sourceSha256: verified.sourceSha256,
    sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`Topokraty rejection/reclaim generation failed: ${error.message}`);
  }
}
