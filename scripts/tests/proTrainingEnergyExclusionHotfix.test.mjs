import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  composeProTrainingArtifacts,
  PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET,
  PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_SHA256,
  sha256,
} from "../patch_live_lk1_pro_training_energy_exclusions_hotfix.mjs";

const liveFlow = process.env.LK1_PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_FLOW
  ?? "/private/tmp/pro-energy-flow.json";
const skip = fs.existsSync(liveFlow) ? false : `live flow is absent: ${liveFlow}`;

test("the Energy generation replaces the installed all-subscriptions PRO guard", { skip }, () => {
  const bytes = fs.readFileSync(liveFlow);
  assert.equal(sha256(bytes), PRO_TRAINING_ENERGY_EXCLUSIONS_UPSTREAM_SHA256);
  const built = composeProTrainingArtifacts(bytes);
  assert.equal(built.addedNodeCount, 0);
  assert.deepEqual(built.changes.map(change => ({ id: change.id, fields: change.fields })), [
    { id: "lk_subscription_booking_router_20260804", fields: ["func"] },
    { id: "lk_subscription_price_preview_20260908_router", fields: ["func"] },
  ]);
  assert.equal(built.candidateSha256, "5b030bf1154eb64bb4de22402e0032ae801a093b03a16276db71ca2db848a601");
  const booking = built.flow.find(node => node.id === "lk_subscription_booking_router_20260804").func;
  assert.match(booking, /function isProTrainingEnergyPack\(value\) \{/);
  assert.match(booking, /PRO_TRAINING_ENERGY_PRODUCT_IDS/);
  assert.match(booking, /isProTrainingEnergyPack\(selectedOwned\[0\]\)/);
  assert.doesNotMatch(booking, /resolveCategory\(exercise\) === "group_training" && isProTrainingExercise\(exercise\)\)/);
  assert.equal(sha256(booking), PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedBookingFuncSha256);
  const preview = built.flow.find(node => node.id === "lk_subscription_price_preview_20260908_router").func;
  assert.match(preview, /canonical\.isProTrainingExercise/);
  assert.equal(sha256(preview), PRO_TRAINING_ENERGY_EXCLUSIONS_TARGET.patchedPreviewFuncSha256);
});

test("the Energy deploy package has an explicit confirmation and exact graph allowance", () => {
  const wrapper = fs.readFileSync(new URL("../deploy_nodered_lk1_pro_training_energy_exclusions_147.sh", import.meta.url), "utf8");
  assert.match(wrapper, /NODE_RED_LK1_PRO_TRAINING_ENERGY_EXCLUSIONS_DEPLOY:-\}" != "CONFIRM_147/);
  assert.match(wrapper, /allow_nodes=\(lk_subscription_booking_router_20260804 lk_subscription_price_preview_20260908_router\)/);
  assert.match(wrapper, /patch_live_lk1_pro_training_energy_exclusions_hotfix\.mjs/);
  assert.match(wrapper, /function isProTrainingEnergyPack\(value\) \{/);
  assert.match(wrapper, /PRO_TRAINING_ENERGY_PRODUCT_IDS/);
  assert.match(wrapper, /rollback --deployment-id/);
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-pro-training-energy-exclusions:deploy-147"],
    "bash scripts/deploy_nodered_lk1_pro_training_energy_exclusions_147.sh");
});
