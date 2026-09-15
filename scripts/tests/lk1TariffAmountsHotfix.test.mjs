// Focused generation for the event tariff amount rule and the preview evaluator.
// Pins the reviewed preimages/postimages, the fail-closed preimage gates and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  TARIFF_AMOUNTS_BOOKING_DELTAS,
  TARIFF_AMOUNTS_BOOKING_ID,
  TARIFF_AMOUNTS_EVALUATE_ID,
  TARIFF_AMOUNTS_EVALUATOR_ID,
  TARIFF_AMOUNTS_INSTALLED_GENERATION,
  TARIFF_AMOUNTS_ROUTER_ID,
  TARIFF_AMOUNTS_SOURCE_NODE_COUNT,
  TARIFF_AMOUNTS_SOURCE_SHA256,
  TARIFF_AMOUNTS_TARGETS,
  composeTariffAmountsArtifacts,
  patchTariffAmountsBookingBody,
  sha256,
} from "../patch_live_lk1_tariff_amounts_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_TARIFF_AMOUNTS_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-tariff-live/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_TARIFF_AMOUNTS_LIVE_SNAPSHOT)`;

test("the generation pins the installed flow and three node fields", () => {
  assert.equal(TARIFF_AMOUNTS_SOURCE_NODE_COUNT, 4804);
  assert.match(TARIFF_AMOUNTS_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  for (const [label, digest] of Object.entries(TARIFF_AMOUNTS_INSTALLED_GENERATION)) {
    assert.match(digest, /^[0-9a-f]{64}$/, label);
  }
  assert.equal(TARIFF_AMOUNTS_ROUTER_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(TARIFF_AMOUNTS_EVALUATE_ID, "lk_subscription_price_preview_20260908_evaluate");
  assert.equal(TARIFF_AMOUNTS_BOOKING_ID, "lk_subscription_booking_router_20260804");
  for (const [label, target] of Object.entries(TARIFF_AMOUNTS_TARGETS)) {
    assert.match(target.liveFuncSha256, /^[0-9a-f]{64}$/, label);
    assert.match(target.patchedFuncSha256, /^[0-9a-f]{64}$/, label);
    assert.notEqual(target.liveFuncSha256, target.patchedFuncSha256, label);
  }
  // The preview evaluator is re-bound to the body the write path already runs.
  assert.equal(TARIFF_AMOUNTS_TARGETS.previewEvaluate.patchedFuncSha256,
    "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed");
  assert.equal(TARIFF_AMOUNTS_BOOKING_DELTAS.length, 3);
  for (const delta of TARIFF_AMOUNTS_BOOKING_DELTAS) assert.ok(delta.before && delta.after, delta.id);
});

test("the booking delta is the paid-price rule and nothing else", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const body = flow.find((node) => node.id === TARIFF_AMOUNTS_BOOKING_ID).func;
  const patched = patchTariffAmountsBookingBody(body);
  assert.equal(sha256(patched), TARIFF_AMOUNTS_TARGETS.booking.patchedFuncSha256);
  // Reverting the three reviewed deltas reproduces the installed body byte for byte.
  let reverted = patched;
  for (const delta of [...TARIFF_AMOUNTS_BOOKING_DELTAS].reverse()) {
    reverted = reverted.replace(delta.after, () => delta.before);
  }
  assert.equal(reverted, body);
  assert.ok(patched.includes("const paidAmounts = [product.cost, product.price, product.amount]"));
  assert.equal(patched.includes("product.amount, product.trialCost].filter"), false);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeTariffAmountsArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === TARIFF_AMOUNTS_EVALUATOR_ID).func += "\n// drift";
  assert.throws(() => composeTariffAmountsArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the three reviewed postimages", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeTariffAmountsArtifacts(bytes, "lk1-event-tariff-amounts");
  assert.deepEqual(built.changes.map((change) => change.id).sort(),
    [TARIFF_AMOUNTS_BOOKING_ID, TARIFF_AMOUNTS_EVALUATE_ID, TARIFF_AMOUNTS_ROUTER_ID].sort());
  for (const change of built.changes) assert.deepEqual(change.fields, ["func"]);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.evaluatorMatchesWritePath, true);
  assert.equal(built.preview.eventHelpersPublished, true);
  assert.equal(built.contract.allowedChanges.length, 3);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id).sort(),
    [TARIFF_AMOUNTS_BOOKING_ID, TARIFF_AMOUNTS_EVALUATE_ID, TARIFF_AMOUNTS_ROUTER_ID].sort());
  // The preview evaluator now carries the write-path body, without the HUB hardcode.
  const evaluate = candidate.find((node) => node.id === TARIFF_AMOUNTS_EVALUATE_ID).func;
  const managed = candidate.find((node) => node.id === TARIFF_AMOUNTS_EVALUATOR_ID).func;
  assert.equal(evaluate, managed);
  assert.ok(evaluate.includes("aboveActiveLimit"));
  assert.equal(evaluate.includes("db7a5250-7369-4f43-8ac5-9111be24bc74"), false);
  const router = candidate.find((node) => node.id === TARIFF_AMOUNTS_ROUTER_ID).func;
  assert.ok(router.includes("const paidFields = ['cost', 'price', 'amount'].filter"));
  assert.ok(router.includes("product_trial_amount"));
  // Every other field of the three nodes survives.
  for (const id of [TARIFF_AMOUNTS_ROUTER_ID, TARIFF_AMOUNTS_EVALUATE_ID, TARIFF_AMOUNTS_BOOKING_ID]) {
    const before = live.find((node) => node.id === id);
    const after = candidate.find((node) => node.id === id);
    assert.equal(JSON.stringify({ ...after, func: null }), JSON.stringify({ ...before, func: null }), id);
  }
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_tariff_amounts_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_EVENT_TARIFF_AMOUNTS_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${TARIFF_AMOUNTS_ROUTER_ID} ${TARIFF_AMOUNTS_EVALUATE_ID} ${TARIFF_AMOUNTS_BOOKING_ID})`));
  for (const id of [TARIFF_AMOUNTS_ROUTER_ID, TARIFF_AMOUNTS_EVALUATE_ID, TARIFF_AMOUNTS_BOOKING_ID]) {
    assert.ok(wrapper.includes(`"${id}:func"`), id);
  }
  assert.ok(wrapper.includes("expected_changed_nodes=3"));
  assert.ok(wrapper.includes("patch_live_lk1_tariff_amounts_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("value.preview?.evaluatorMatchesWritePath !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-event-tariff-amounts:deploy-147"],
    "bash scripts/deploy_nodered_lk1_tariff_amounts_hotfix_147.sh");
});
