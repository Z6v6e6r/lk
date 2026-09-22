#!/usr/bin/env node

// Focused Node-RED generation: PRO trainings allow only an owned Energy 5/25 visit pack.
//
// Owner decision 2026-09-18: «Тренировка ПРО уровень D/D+/C/C+» (directions 5505/5506/5507,
// exercise type 605) and «Игра+Тренер ПРО уровень D/D+/C/C+» (5502/5503/5504, type 847) must
// not receive any managed subscription benefit — no plan discount or free-first-event. An
// owned Energy 5/25 pack may consume one visit on the legacy path; promo codes are untouched.
//
// This generation is applied to the currently installed PRO-guard flow (`bcc9fd6b…`, 4804
// nodes) and changes exactly two fields of two nodes:
//   1. `lk_subscription_booking_router_20260804.func` — replace the embedded exclusion module
//      and replace the all-subscriptions refusal with the owned Energy 5/25 exception.
//   2. `lk_subscription_price_preview_20260908_router.func` — recomposed from the patched
//      generation so the advisory quote and the write path agree.
//
// Preparation only: nothing is deployed, imported or restarted here, and the patcher fails
// closed unless the preimage is exactly the reviewed installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { previewSources } from "./patch_nodered_subscription_price_preview.mjs";
import { proTrainingExclusionSource } from "./lib/eventPaymentSources.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const PRO_TRAINING_ENERGY_EXCLUSIONS_DEPLOYMENT_ID = "lk1-pro-training-energy-exclusions";
export const PRO_TRAINING_ENERGY_EXCLUSIONS_KIND = "FOCUSED_LK1_PRO_TRAINING_ENERGY_EXCLUSIONS_V1";

// Reviewed preimage: the live PRO-exclusion postimage read from lk-primary-147. A fresh pull
// must reproduce this sha and the two node func preimages before any candidate is composed.
export const PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_SHA256 =
  "bcc9fd6b2d2c42da731a8895d8e3b90c2d5f6cfbf0c17f26908ec9a59b935307";
export const PRO_TRAINING_ENERGY_EXCLUSIONS_SOURCE_NODE_COUNT = 4804;
export const PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID = "lk_subscription_price_preview_20260908_router";
export const PRO_TRAINING_ENERGY_EXCLUSIONS_EVALUATOR_ID = "lk_subscription_managed_policy_20260820";

export const PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET = Object.freeze({
  bookingId: PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID,
  // sha256 of the booking body of the reviewed upstream generation (station postimage).
  liveBookingFuncSha256: "0211ba40e79d20a330269777272599e299620de2c295767bbb76677c0fbb2c8c",
  patchedBookingFuncSha256: "864c846f69c4ccbcdd44c7b2f68942b47a4a8f67470cb4cb77caf2e46550567e",
  previewId: PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID,
  livePreviewFuncSha256: "1cdeddc35c885bbf3fb4fbc5e0914c1a2c44809765c2ef020e7ce01823ccc3ff",
  patchedPreviewFuncSha256: "794a6ae1113d970dca6844b16952ec7f9a2d84cd2ed45a6f821b5eb2eabb1e7b",
});

// The installed preview composition pins of this generation: the split/join bodies and the
// allowance block are the installed ones, never the reviewed preimage defaults of another line.
export const PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_INSTALLED = Object.freeze({
  splitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  joinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  allowanceBlockSha256: "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9",
});

const OLD_MODULE_START = "const PRO_TRAINING_DIRECTION_IDS =";
const OLD_MODULE_END = 'if (ctx.step === "exercise") {\n';
const OLD_GUARD = `  // A PRO training is outside the contour on both paths: the managed quote would grant a
  // discount (up to the free first event of the day) and the legacy path would consume a
  // visit, so the refusal precedes every subscription decision. The category guard keeps the
  // token rule away from an open game or a tournament that merely carries «ПРО» in its title.
  if (resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)) {
    return finishError(ctx, 409, "На ПРО-тренировки подписки не действуют: доступна только оплата по полной цене", {
      code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE",
    });
  }
  // The selected instance is resolved first: it carries the product identity and the
  // sale date of the concrete subscription, not of a sibling the client also owns.
  const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
`;
const NEW_GUARD = `  // A PRO training is outside the managed subscription contour. The one explicit
  // exception is an owned Energy 5/25 visit pack: it consumes one visit at the
  // ordinary visit-pack rate, without a monetary discount or free-first-event rule.
  // Resolve the actor-owned row before the guard so a client cannot turn an arbitrary
  // product into an Energy exception by changing only the request payload.
  const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
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
export const PRO_TRAINING_PATCH_MARKER = "function isProTrainingEnergyPack(value) {";

// Every change of this generation, with anchors that exist exactly once in the reviewed
// installed body (`3920bb21…`), which `assertPreimage` proves before any of them is applied.
export const PRO_TRAINING_ENERGY_CALL_SITE_DELTAS = Object.freeze([
  { id: "replace-refuse-pro-training", before: OLD_GUARD, after: NEW_GUARD },
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

function assertPostimage(body, pin, label) {
  if (typeof pin !== "string" || pin.startsWith("__")) throw new Error(`${label} postimage pin is not set`);
  if (sha256(body) !== pin) {
    throw new Error(`${label} postimage drift: ${sha256(body)} != ${pin}`);
  }
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

// The reviewed booking body: the PRO module embedded once plus the refusal in the exercise step.
export function patchProTrainingEnergyBookingBody(source, target = PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET) {
  if (source.includes(PRO_TRAINING_PATCH_MARKER)) {
    throw new Error("Booking gateway already carries the PRO-training predicate");
  }
  if (sha256(source) !== target.liveBookingFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveBookingFuncSha256}`);
  }
  const moduleStart = source.indexOf(OLD_MODULE_START);
  const moduleEnd = source.indexOf(OLD_MODULE_END, moduleStart);
  if (moduleStart < 0 || moduleEnd <= moduleStart
    || source.indexOf(OLD_MODULE_START, moduleStart + 1) >= 0) {
    throw new Error("PRO-training Energy booking module anchor drift");
  }
  const withModule = `${source.slice(0, moduleStart)}${proTrainingExclusionSource()}\n${source.slice(moduleEnd)}`;
  const patched = applyDeltas(withModule, PRO_TRAINING_ENERGY_CALL_SITE_DELTAS, "PRO-training Energy booking");
  if (patched.split(PRO_TRAINING_PATCH_MARKER).length !== 2) {
    throw new Error("The PRO-training module must be embedded exactly once");
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  return patched;
}

/**
 * Composes the candidate: the installed flow with the booking body patched and the preview
 * node recomposed on top of it. Fails closed on any preimage, node-count, shape, parse,
 * postimage or graph mismatch.
 */
export function composeProTrainingArtifacts(rawSource, options = {}) {
  const bytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  const sourceSha256 = sha256(bytes);
  const expectedSourceSha256 = options.sourceSha256 ?? PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_SHA256;
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow)) throw new Error("Live flow is not a node array");
  if (flow.length !== PRO_TRAINING_ENERGY_EXCLUSIONS_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PRO_TRAINING_ENERGY_EXCLUSIONS_SOURCE_NODE_COUNT}`);
  }
  const booking = assertFunctionNode(flow.find((node) => node.id === PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID),
    PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID);
  const preview = assertFunctionNode(flow.find((node) => node.id === PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID),
    PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID);
  const evaluator = assertFunctionNode(flow.find((node) => node.id === PRO_TRAINING_ENERGY_EXCLUSIONS_EVALUATOR_ID),
    PRO_TRAINING_ENERGY_EXCLUSIONS_EVALUATOR_ID);
  if (sha256(preview.func) !== PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.livePreviewFuncSha256) {
    throw new Error(`Preview installed preimage drift: ${sha256(preview.func)}`);
  }
  const beforeBookingFunc = sha256(booking.func);
  const beforePreviewFunc = sha256(preview.func);
  const previewShape = JSON.parse(JSON.stringify({ ...preview, func: null }));
  booking.func = patchProTrainingEnergyBookingBody(booking.func);
  // The preview composes on the patched generation: its booking pin is the patched body, and
  // the split/join/allowance pins are the installed ones. The optional predicate the preview
  // router calls is embedded only because this body carries the refusal.
  const composed = previewSources(flow, {
    pins: {
      booking: sha256(booking.func),
      evaluator: sha256(evaluator.func),
      pricing: options.pricingSha256 ?? PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_INSTALLED.splitFuncSha256,
      join: options.joinSha256 ?? PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_INSTALLED.joinFuncSha256,
    },
    installedUsageSha256: options.installedUsageSha256
      ?? PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_INSTALLED.allowanceBlockSha256,
  });
  preview.func = composed.router;
  if (JSON.stringify({ ...preview, func: null }) !== JSON.stringify(previewShape)) {
    throw new Error("Preview node changed a field other than func");
  }
  if (!composed.router.includes("canonical.isProTrainingExercise")
    || composed.router.includes("const isProTrainingExercise = () => false;")) {
    throw new Error("The preview must carry the reviewed PRO-training predicate, not the inert stub");
  }
  assertFunctionBody(booking.func, "Patched booking gateway body");
  assertFunctionBody(preview.func, "Composed preview body");
  if (options.assertPostimages !== false) {
    assertPostimage(booking.func, PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedBookingFuncSha256, "Booking");
    assertPostimage(preview.func, PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedPreviewFuncSha256, "Preview");
  }

  const changes = [
    { id: PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID, fields: ["func"],
      func: { beforeSha256: beforeBookingFunc, afterSha256: sha256(booking.func) } },
    { id: PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID, fields: ["func"],
      func: { beforeSha256: beforePreviewFunc, afterSha256: sha256(preview.func) } },
  ];
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: [...row.fields] }));
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes,
    deploymentId: PRO_TRAINING_ENERGY_EXCLUSIONS_DEPLOYMENT_ID, allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });

  return {
    flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: {
      id: PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID,
      moduleEmbeddedOnce: booking.func.split(PRO_TRAINING_PATCH_MARKER).length === 2,
      refusalBound: booking.func.includes("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE")
        && booking.func.includes('resolveCategory(exercise) === "group_training"'),
      refusalPrecedesContour: booking.func.indexOf("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE")
        < booking.func.indexOf("const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);"),
    },
    preview: {
      id: PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID,
      initializeUnchanged: preview.initialize === "",
      refusalBound: composed.router.includes("canonical.isProTrainingExercise"),
      inertStubAbsent: !composed.router.includes("const isProTrainingExercise = () => false;"),
      helperCount: composed.helperNames.length,
    },
  };
}

/** The deployment report the guarded wrapper validates; one shape for the CLI and its test. */
export function buildProTrainingReport({ sourceSha256, sourceNodeCount, built }) {
  return {
    kind: PRO_TRAINING_ENERGY_EXCLUSIONS_KIND, deploymentId: PRO_TRAINING_ENERGY_EXCLUSIONS_DEPLOYMENT_ID,
    targets: {
      booking: { id: PRO_TRAINING_ENERGY_EXCLUSIONS_BOOKING_ID,
        func: { beforeSha256: PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.liveBookingFuncSha256,
          afterSha256: PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedBookingFuncSha256 } },
      preview: { id: PRO_TRAINING_ENERGY_EXCLUSIONS_PREVIEW_ID,
        func: { beforeSha256: PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.livePreviewFuncSha256,
          afterSha256: PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedPreviewFuncSha256 } },
    },
    upstreamFlowSha256: PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_SHA256,
    sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 2, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, preview: built.preview,
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
  const built = composeProTrainingArtifacts(liveBytes);
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition"); return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = buildProTrainingReport({ sourceSha256: verified.sourceSha256,
    sourceNodeCount: verified.nodeCount, built });
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(`PRO training exclusion generation failed: ${error.message}`);
  }
}
