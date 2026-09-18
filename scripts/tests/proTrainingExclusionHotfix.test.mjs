// The PRO-training focused generation: the reviewed delivery vehicle for the owner decision of
// 2026-09-18, stacked on the Sirius station-exclusions generation. The hermetic half drives the
// reviewed deltas; the snapshot half proves the candidate against the exact upstream flow.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PRO_TRAINING_CALL_SITE_DELTAS,
  PRO_TRAINING_EXCLUSIONS_PREVIEW_ID,
  PRO_TRAINING_EXCLUSIONS_BOOKING_ID,
  PRO_TRAINING_EXCLUSIONS_TARGET,
  PRO_TRAINING_EXCLUSIONS_UPSTREAM_SHA256,
  PRO_TRAINING_PATCH_MARKER,
  composeProTrainingArtifacts,
  patchProTrainingBookingBody,
  sha256,
} from "../patch_live_lk1_pro_training_exclusions_hotfix.mjs";

const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const UPSTREAM_FLOW = process.env.LK1_PRO_TRAINING_EXCLUSIONS_UPSTREAM_FLOW
  ?? "/private/tmp/station-candidate.flow.json";
const snapshotSkip = fs.existsSync(UPSTREAM_FLOW)
  ? false
  : `upstream flow is absent: ${UPSTREAM_FLOW} (compose the Sirius generation first, or set LK1_PRO_TRAINING_EXCLUSIONS_UPSTREAM_FLOW)`;

const MISMATCH = `      code: "SUBSCRIPTION_BOOKING_EXERCISE_MISMATCH",
    });
  }
`;
/** A body carrying exactly the two reviewed anchors, so the deltas can be driven hermetically. */
const syntheticBody = () => `const resolveCategory = () => "group_training";
const finishError = () => null;
if (ctx.step === "exercise") {
  const exercise = unwrapRecord(msg.payload);
  if (!exercise) {
    return finishError(ctx, 409, "Упражнение Viva не совпало с целью записи", {
${MISMATCH}  const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
  return selectedOwned;
}
`;
const syntheticTarget = (body) => ({
  ...PRO_TRAINING_EXCLUSIONS_TARGET,
  liveBookingFuncSha256: sha256(body),
  // The hermetic body is not the reviewed installed body, so its postimage is not pinned.
  patchedBookingFuncSha256: null,
});

test("the PRO refusal and the module are inserted exactly once, before the contour decisions", () => {
  const body = syntheticBody();
  const patched = patchProTrainingBookingBody(body, syntheticTarget(body));
  assert.equal(patched.split(PRO_TRAINING_PATCH_MARKER).length - 1, 1, "the module is embedded once");
  assert.equal(patched.split("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE").length - 1, 1, "the refusal is inserted once");
  assert.ok(patched.includes('resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)'),
    "the refusal must be scoped to the group-training category");
  assert.ok(patched.indexOf("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE")
    < patched.indexOf("const selectedOwned = findOwnedSubscriptions"), "the refusal precedes the selected instance");
  assert.ok(patched.indexOf(MISMATCH) < patched.indexOf("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE"),
    "the refusal follows the exercise identity check");
  new Function("msg", "node", "env", "global", patched);
  // Never a second application: both markers stop the generation.
  assert.throws(() => patchProTrainingBookingBody(patched, { ...PRO_TRAINING_EXCLUSIONS_TARGET,
    liveBookingFuncSha256: sha256(patched) }), /already carries/);
});

test("the generation refuses a body that is not the reviewed upstream postimage", () => {
  const body = syntheticBody();
  assert.throws(() => patchProTrainingBookingBody(body), /installed preimage drift/);
  const doubled = body.replace(MISMATCH, MISMATCH + MISMATCH);
  assert.throws(() => patchProTrainingBookingBody(doubled, syntheticTarget(doubled)),
    /anchor drift for refuse-pro-training/);
  const anchorRemoved = body.replace('if (ctx.step === "exercise") {\n', "");
  assert.throws(() => patchProTrainingBookingBody(anchorRemoved, syntheticTarget(anchorRemoved)),
    /anchor drift for embed-module/);
});

test("the focused generation and the composed gateway carry the same reviewed refusal", () => {
  const refusal = '"На ПРО-тренировки подписки не действуют: доступна только оплата по полной цене"';
  const code = "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE";
  const hooks = read("../nodered_lk1_hub_nodes/gateway_hooks.js");
  // The composed gateway hook and the focused generation must state one and the same refusal.
  assert.ok(hooks.includes(refusal) && hooks.includes(code), "the composed gateway hook carries the refusal");
  assert.ok(hooks.includes('resolveCategory(exercise) === "group_training" && isProTrainingExercise(exercise)'));
  const applyDelta = PRO_TRAINING_CALL_SITE_DELTAS.find((delta) => delta.id === "refuse-pro-training");
  assert.ok(applyDelta.after.includes(refusal) && applyDelta.after.includes(code),
    "the focused generation inserts the identical refusal");
  assert.ok(applyDelta.after.includes('resolveCategory(exercise) === "group_training"'));
  // The embedded module is the reviewed module, not a local copy.
  const embedDelta = PRO_TRAINING_CALL_SITE_DELTAS.find((delta) => delta.id === "embed-module");
  assert.ok(embedDelta.after.includes(read("../lib/proTrainingExclusion.mjs").split("\n")
    .find((line) => line.startsWith("export const PRO_TRAINING_DIRECTION_IDS")).replace(/^export /, "")));
  assert.equal(PRO_TRAINING_CALL_SITE_DELTAS.length, 2);
  assert.ok(PRO_TRAINING_CALL_SITE_DELTAS.every((delta) => delta.before !== delta.after));
});

test("the generation applies to the reviewed upstream flow as exactly two changed node fields", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  assert.equal(sha256(bytes), PRO_TRAINING_EXCLUSIONS_UPSTREAM_SHA256,
    "the upstream flow must be the reviewed station-exclusions postimage");
  const composed = composeProTrainingArtifacts(bytes);
  assert.equal(composed.addedNodeCount, 0);
  assert.deepEqual(composed.changes.map((row) => ({ id: row.id, fields: row.fields })), [
    { id: PRO_TRAINING_EXCLUSIONS_BOOKING_ID, fields: ["func"] },
    { id: PRO_TRAINING_EXCLUSIONS_PREVIEW_ID, fields: ["func"] },
  ]);
  assert.equal(composed.candidateSha256, "030e39613ca13e143236a3ac7f71b216ad3bffe3635bd805b54bf52a75b20e0b");
  assert.equal(composed.booking.moduleEmbeddedOnce, true);
  assert.equal(composed.booking.refusalBound, true);
  assert.equal(composed.booking.refusalPrecedesContour, true);
  assert.equal(composed.preview.refusalBound, true);
  assert.equal(composed.preview.inertStubAbsent, true, "the preview must not fall back to the inert predicate here");
  assert.equal(composed.preview.initializeUnchanged, true);
  assert.equal(composed.contract.deploymentId, "lk1-pro-training-exclusions");
});
