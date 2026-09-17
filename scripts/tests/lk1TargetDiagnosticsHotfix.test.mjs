// Focused generation for the subscription preview target diagnostics (2026-09-17
// booking incident). This suite pins the reviewed preimage/postimage, the fail-closed
// gates, the diagnostics-only proof and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TARGET_DIAGNOSTICS_BOOKING_ID,
  TARGET_DIAGNOSTICS_DEPLOYMENT_ID,
  TARGET_DIAGNOSTICS_EVALUATOR_ID,
  TARGET_DIAGNOSTICS_INSTALLED_GENERATION,
  TARGET_DIAGNOSTICS_ROUTER_ID,
  TARGET_DIAGNOSTICS_SOURCE_NODE_COUNT,
  TARGET_DIAGNOSTICS_SOURCE_SHA256,
  TARGET_DIAGNOSTICS_STAGES,
  TARGET_DIAGNOSTICS_TARGET,
  composeLk1TargetDiagnosticsArtifacts,
  refusalCallSites,
  sha256,
  stripTargetDiagnostics,
} from "../patch_live_lk1_target_diagnostics_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_TARGET_DIAGNOSTICS_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-target-diag-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_TARGET_DIAGNOSTICS_LIVE_SNAPSHOT)`;

test("the generation pins the installed flow and one node field", () => {
  assert.equal(TARGET_DIAGNOSTICS_DEPLOYMENT_ID, "lk1-target-diagnostics");
  assert.match(TARGET_DIAGNOSTICS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(TARGET_DIAGNOSTICS_SOURCE_NODE_COUNT, 4804);
  assert.equal(TARGET_DIAGNOSTICS_ROUTER_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(TARGET_DIAGNOSTICS_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(TARGET_DIAGNOSTICS_EVALUATOR_ID, "lk_subscription_managed_policy_20260820");
  assert.match(TARGET_DIAGNOSTICS_TARGET.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(TARGET_DIAGNOSTICS_TARGET.patchedFuncSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(TARGET_DIAGNOSTICS_TARGET.liveFuncSha256, TARGET_DIAGNOSTICS_TARGET.patchedFuncSha256);
  for (const value of Object.values(TARGET_DIAGNOSTICS_INSTALLED_GENERATION)) {
    assert.match(value, /^[0-9a-f]{64}$/);
  }
  assert.deepEqual([...TARGET_DIAGNOSTICS_STAGES],
    ["event_target", "game_record", "game_metadata", "game_exercise"]);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeLk1TargetDiagnosticsArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === TARGET_DIAGNOSTICS_EVALUATOR_ID).func += "\n// drift";
  assert.throws(() => composeLk1TargetDiagnosticsArtifacts(drifted, "probe"), /Live flow preimage drift/);
  const honest = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  honest.find((node) => node.id === TARGET_DIAGNOSTICS_ROUTER_ID).func += "\n// drift";
  assert.throws(() => composeLk1TargetDiagnosticsArtifacts(honest, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1TargetDiagnosticsArtifacts(bytes, TARGET_DIAGNOSTICS_DEPLOYMENT_ID);
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, TARGET_DIAGNOSTICS_ROUTER_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, TARGET_DIAGNOSTICS_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.eventHelpersPublished, true);
  assert.equal(built.preview.otherFieldsUnchanged, true);
  assert.equal(built.preview.refusalSitesUnchanged, true);
  assert.ok(built.preview.refusalSites >= 4);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);

  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [TARGET_DIAGNOSTICS_ROUTER_ID]);
  assert.equal(sha256(candidate.find((node) => node.id === TARGET_DIAGNOSTICS_BOOKING_ID).func),
    TARGET_DIAGNOSTICS_INSTALLED_GENERATION.bookingFuncSha256);

  const installed = live.find((node) => node.id === TARGET_DIAGNOSTICS_ROUTER_ID).func;
  const composed = candidate.find((node) => node.id === TARGET_DIAGNOSTICS_ROUTER_ID).func;
  // Decision invariance: no refusal was added, moved or dropped.
  assert.deepEqual(refusalCallSites(composed), refusalCallSites(installed));
  // Diagnostics-only: with the added details stripped the composed body is the installed one.
  assert.equal(stripTargetDiagnostics(composed), installed);
  for (const stage of TARGET_DIAGNOSTICS_STAGES) {
    assert.equal(composed.split(`stage: '${stage}',`).length - 1, 1, `stage ${stage} must appear once`);
  }
  assert.equal(installed.includes("refuseWith("), false);
});

test("the refusal details never carry an amount, a name or a phone", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1TargetDiagnosticsArtifacts(bytes, TARGET_DIAGNOSTICS_DEPLOYMENT_ID);
  const flow = JSON.parse(built.candidateBytes.toString("utf8"));
  const composed = flow.find((node) => node.id === TARGET_DIAGNOSTICS_ROUTER_ID).func;
  const blocks = composed.split("refuseWith(").slice(1);
  assert.equal(blocks.length, 4);
  for (const block of blocks) {
    const details = block.slice(0, block.indexOf("});"));
    for (const forbidden of ["amount", "Amount", "phone", "customerName", "planKey", "bookingId", "subscriptionName"]) {
      assert.equal(details.includes(forbidden), false, `details must not carry ${forbidden}`);
    }
    assert.match(details, /^[^]*stage: '/);
  }
});

test("the deploy wrapper keeps the confirmation gate, the pinned commit and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_target_diagnostics_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_TARGET_DIAGNOSTICS_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${TARGET_DIAGNOSTICS_ROUTER_ID})`));
  assert.ok(wrapper.includes(`"${TARGET_DIAGNOSTICS_ROUTER_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_target_diagnostics_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.ok(wrapper.includes('deployment_id="lk1-target-diagnostics"'));
  assert.ok(wrapper.includes("refusalSitesUnchanged"));
  // The reviewed source is pinned to one published commit instead of a branch name, and
  // the generation sources must not drift from it.
  assert.match(wrapper, /generation_commit="[0-9a-f]{40}"/);
  assert.ok(wrapper.includes('git merge-base --is-ancestor "$generation_commit" "$local_sha"'));
  assert.ok(wrapper.includes('git diff --quiet "$generation_commit" "$local_sha" -- "${generation_sources[@]}"'));
  assert.ok(wrapper.includes('scripts/patch_live_lk1_target_diagnostics_hotfix.mjs\n'));
  assert.ok(wrapper.includes('git branch -r --contains'));
  assert.ok(wrapper.includes("node '$remote_helper' rollback"));
  assert.ok(wrapper.includes("Installed flow readback does not match the candidate"));
});

test("the wrapper is registered as an npm deploy command", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-target-diagnostics:deploy-147"],
    "bash scripts/deploy_nodered_lk1_target_diagnostics_hotfix_147.sh");
});
