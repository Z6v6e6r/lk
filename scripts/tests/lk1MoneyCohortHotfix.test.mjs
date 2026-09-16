// Focused generation for the annual-HUB money cohort on the event route.
// Pins the reviewed preimages/postimages, the fail-closed preimage gates, the agreement
// between the patched live body and the reviewed gateway source, and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { hubGatewaySource } from "../lib/eventPaymentSources.mjs";
import {
  MONEY_COHORT_BOOKING_ID,
  MONEY_COHORT_DELTAS,
  MONEY_COHORT_SOURCE_NODE_COUNT,
  MONEY_COHORT_SOURCE_SHA256,
  MONEY_COHORT_TARGET,
  composeMoneyCohortArtifacts,
  patchMoneyCohortBookingBody,
  sha256,
} from "../patch_live_lk1_money_cohort_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_COHORT_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-cohort-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_COHORT_LIVE_SNAPSHOT)`;

// The cohort slice that must read the same in the reviewed source and in the live body.
const COHORT_START = "  // The resolver alone decides the enforced cohort:";
const COHORT_END = "  if (enforced) {";
const cohortSlice = (body) => {
  const start = body.indexOf(COHORT_START);
  assert.notEqual(start, -1, "cohort comment missing");
  const end = body.indexOf(COHORT_END, start);
  assert.notEqual(end, -1, "cohort gate missing");
  return body.slice(start, end + COHORT_END.length);
};

test("the generation pins the installed flow and one node field", () => {
  assert.equal(MONEY_COHORT_SOURCE_NODE_COUNT, 4804);
  assert.match(MONEY_COHORT_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(MONEY_COHORT_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.match(MONEY_COHORT_TARGET.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(MONEY_COHORT_TARGET.patchedFuncSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(MONEY_COHORT_TARGET.liveFuncSha256, MONEY_COHORT_TARGET.patchedFuncSha256);
  assert.equal(MONEY_COHORT_DELTAS.length, 2);
  for (const delta of MONEY_COHORT_DELTAS) assert.ok(delta.before && delta.after, delta.id);
});

test("the deltas drop the sale-date gate and nothing else", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const body = flow.find((node) => node.id === MONEY_COHORT_BOOKING_ID).func;
  const patched = patchMoneyCohortBookingBody(body);
  assert.equal(sha256(patched), MONEY_COHORT_TARGET.patchedFuncSha256);
  let reverted = patched;
  for (const delta of [...MONEY_COHORT_DELTAS].reverse()) reverted = reverted.replace(delta.after, () => delta.before);
  assert.equal(reverted, body);
  // The mandate now covers exactly the resolver cohort: the gate is `enforced` alone.
  assert.equal(patched.includes("  if (enforced) {"), true);
  assert.equal(patched.includes("dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM"), false);
  assert.equal(patched.includes("// The resolver decides the enforced cohort; the date gate below stays only for"), false);
  // Everything else about the proof is untouched.
  assert.equal(patched.includes('return lk1Stop(ctx, "LK1_MONEY_SUBSCRIPTION_VALIDITY_UNPROVEN",'), true);
  assert.equal(patched.includes('violations.push("expiry_before_target_end");'), true);
  // The patched live body must read exactly like the reviewed gateway source.
  assert.equal(cohortSlice(patched), cohortSlice(hubGatewaySource()));
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeMoneyCohortArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === MONEY_COHORT_BOOKING_ID).func += "\n// drift";
  assert.throws(() => composeMoneyCohortArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeMoneyCohortArtifacts(bytes, "lk1-money-cohort");
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, MONEY_COHORT_BOOKING_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, MONEY_COHORT_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.cohortGateRemoved, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [MONEY_COHORT_BOOKING_ID]);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_money_cohort_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_MONEY_COHORT_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${MONEY_COHORT_BOOKING_ID})`));
  assert.ok(wrapper.includes(`"${MONEY_COHORT_BOOKING_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_money_cohort_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("value.booking?.cohortGateRemoved !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-money-cohort:deploy-147"],
    "bash scripts/deploy_nodered_lk1_money_cohort_hotfix_147.sh");
});
