// The PRO-training focused generation: the reviewed delivery vehicle for the owner decision of
// 2026-09-18, stacked on the Sirius station-exclusions generation. The hermetic half drives the
// reviewed deltas; the snapshot half proves the candidate against the exact upstream flow.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PRO_TRAINING_CALL_SITE_DELTAS,
  buildProTrainingReport,
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
  assert.match(hooks, /resolveCategory\(exercise\) === "group_training"\s*\n\s*&& isProTrainingExercise\(exercise\)\s*\n\s*&& !proTrainingEnergyAllowed/);
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
  assert.equal(composed.candidateSha256, "bcc9fd6b2d2c42da731a8895d8e3b90c2d5f6cfbf0c17f26908ec9a59b935307");
  assert.equal(composed.booking.moduleEmbeddedOnce, true);
  assert.equal(composed.booking.refusalBound, true);
  assert.equal(composed.booking.refusalPrecedesContour, true);
  assert.equal(composed.preview.refusalBound, true);
  assert.equal(composed.preview.inertStubAbsent, true, "the preview must not fall back to the inert predicate here");
  assert.equal(composed.preview.initializeUnchanged, true);
  assert.equal(composed.contract.deploymentId, "lk1-pro-training-exclusions");
});

// The guarded wrapper is the release vehicle: it must keep the confirmation gate, the exact
// two-field allowance, the independent contract, the installed-marker postcheck and rollback,
// and it must accept exactly the report this generation produces.
const WRAPPER = read("../deploy_nodered_lk1_pro_training_exclusions_147.sh");

/** Runs the wrapper's inline `node -e` validator against a report. */
function wrapperReportValidatorAccepts(report) {
  const start = WRAPPER.indexOf("node -e '\n  const value=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));\n  const expected=JSON.parse(process.argv[2]);");
  assert.ok(start >= 0, "the wrapper must validate the generation report");
  const body = WRAPPER.slice(start + "node -e '".length, WRAPPER.indexOf("' \"$candidate_report\"", start));
  const run = new Function("process", "require", body);
  // `node -e '<script>' <report> <fields> <count>`: process.argv[1] is the report path.
  const fakeProcess = { argv: ["node", "report.json",
    '{"lk_subscription_booking_router_20260804":["func"],"lk_subscription_price_preview_20260908_router":["func"]}', "2"],
    exit: (code) => { if (code) throw new Error(`wrapper report validator rejected the report (${code})`); },
    exitCode: 0 };
  const fakeRequire = () => ({ readFileSync: () => JSON.stringify(report) });
  run(fakeProcess, fakeRequire);
}

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  assert.ok(WRAPPER.includes('NODE_RED_LK1_PRO_TRAINING_EXCLUSIONS_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(WRAPPER.includes("clean main checkout"));
  assert.ok(WRAPPER.includes("allow_nodes=(lk_subscription_booking_router_20260804 lk_subscription_price_preview_20260908_router)"));
  assert.ok(WRAPPER.includes('"lk_subscription_booking_router_20260804:func"'));
  assert.ok(WRAPPER.includes('"lk_subscription_price_preview_20260908_router:func"'));
  assert.equal(WRAPPER.includes('"lk_subscription_booking_router_20260804:initialize"'), false,
    "this generation changes no initializer");
  assert.ok(WRAPPER.includes("expected_changed_nodes=2"));
  assert.ok(WRAPPER.includes("patch_live_lk1_pro_training_exclusions_hotfix.mjs"));
  assert.ok(WRAPPER.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(WRAPPER.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(WRAPPER.includes("rollback --deployment-id"));
  assert.ok(WRAPPER.includes("sha256sum"));
  assert.ok(WRAPPER.includes("deploy_reviewed_flow_147_remote.mjs"));
  assert.ok(WRAPPER.includes("value.booking?.refusalPrecedesContour !== true"));
  assert.ok(WRAPPER.includes("value.preview?.inertStubAbsent !== true"));
  assert.ok(WRAPPER.includes('smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"'));
  assert.ok(WRAPPER.includes('value.currency !== "RUB"'));
  // The postcheck proves the installed nodes really carry the reviewed refusal.
  assert.ok(WRAPPER.includes("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE"));
  assert.ok(WRAPPER.includes("function isProTrainingExercise(value) {"));
  assert.ok(WRAPPER.includes("Installed nodes do not carry the reviewed PRO-training refusal"));
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-pro-training-exclusions:deploy-147"],
    "bash scripts/deploy_nodered_lk1_pro_training_exclusions_147.sh");
});

test("the wrapper report contract accepts this generation and rejects drift", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(UPSTREAM_FLOW);
  const built = composeProTrainingArtifacts(bytes);
  const report = buildProTrainingReport({ sourceSha256: sha256(bytes), sourceNodeCount: 4804, built });
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.liveMutationPerformed, false);
  assert.equal(report.changedNodeCount, 2);
  assert.equal(report.addedNodeCount, 0);
  wrapperReportValidatorAccepts(report);
  for (const mutate of [
    (value) => { value.changedNodeCount = 3; },
    (value) => { value.addedNodeCount = 1; },
    (value) => { value.deploymentPerformed = true; },
    (value) => { value.booking.refusalPrecedesContour = false; },
    (value) => { value.preview.inertStubAbsent = false; },
    (value) => { value.changes[0].fields = ["func", "initialize"]; },
  ]) {
    const drifted = JSON.parse(JSON.stringify(report));
    mutate(drifted);
    assert.throws(() => wrapperReportValidatorAccepts(drifted));
  }
});
