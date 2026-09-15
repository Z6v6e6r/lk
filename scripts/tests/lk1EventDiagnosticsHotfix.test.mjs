// Focused generation for the event-route refusal diagnostics. This suite pins the
// reviewed preimage/postimage, the fail-closed preimage gates and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVENT_DIAGNOSTICS_BOOKING_ID,
  EVENT_DIAGNOSTICS_EVALUATOR_ID,
  EVENT_DIAGNOSTICS_INSTALLED_GENERATION,
  EVENT_DIAGNOSTICS_ROUTER_ID,
  EVENT_DIAGNOSTICS_SOURCE_NODE_COUNT,
  EVENT_DIAGNOSTICS_SOURCE_SHA256,
  EVENT_DIAGNOSTICS_TARGET,
  composeLk1EventDiagnosticsArtifacts,
  sha256,
} from "../patch_live_lk1_event_diagnostics_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_EVENT_DIAGNOSTICS_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-diag-live/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_EVENT_DIAGNOSTICS_LIVE_SNAPSHOT)`;

test("the generation pins the installed flow and one node field", () => {
  assert.match(EVENT_DIAGNOSTICS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(EVENT_DIAGNOSTICS_SOURCE_NODE_COUNT, 4804);
  assert.equal(EVENT_DIAGNOSTICS_ROUTER_ID, "lk_subscription_price_preview_20260908_router");
  assert.match(EVENT_DIAGNOSTICS_TARGET.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(EVENT_DIAGNOSTICS_TARGET.patchedFuncSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(EVENT_DIAGNOSTICS_TARGET.liveFuncSha256, EVENT_DIAGNOSTICS_TARGET.patchedFuncSha256);
  assert.match(EVENT_DIAGNOSTICS_INSTALLED_GENERATION.bookingFuncSha256, /^[0-9a-f]{64}$/);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeLk1EventDiagnosticsArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === EVENT_DIAGNOSTICS_EVALUATOR_ID).func += "\n// drift";
  assert.throws(() => composeLk1EventDiagnosticsArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1EventDiagnosticsArtifacts(bytes, "lk1-event-diagnostics");
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, EVENT_DIAGNOSTICS_ROUTER_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, EVENT_DIAGNOSTICS_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.eventHelpersPublished, true);
  assert.equal(built.preview.otherFieldsUnchanged, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [EVENT_DIAGNOSTICS_ROUTER_ID]);
  assert.equal(sha256(candidate.find((node) => node.id === EVENT_DIAGNOSTICS_BOOKING_ID).func),
    EVENT_DIAGNOSTICS_INSTALLED_GENERATION.bookingFuncSha256);
  // The diagnostics name the refusal shape but never an amount.
  const router = candidate.find((node) => node.id === EVENT_DIAGNOSTICS_ROUTER_ID).func;
  assert.ok(router.includes("amountFields, amountDistinct"));
  assert.ok(router.includes("amountsZero"));
  assert.ok(router.includes("stage: 'decision_blockers'"));
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_event_diagnostics_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_EVENT_DIAGNOSTICS_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${EVENT_DIAGNOSTICS_ROUTER_ID})`));
  assert.ok(wrapper.includes(`"${EVENT_DIAGNOSTICS_ROUTER_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_event_diagnostics_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-event-diagnostics:deploy-147"],
    "bash scripts/deploy_nodered_lk1_event_diagnostics_hotfix_147.sh");
});
