// Focused generation: the free-first event booking is written through the v1 admin contract
// and the promo РА/Академия instances join the cohort.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { patchMoneyCohortBookingBody } from "../patch_live_lk1_money_cohort_hotfix.mjs";
import { PLAN_FIRST_USE_DELTAS } from "../patch_live_lk1_plan_money_first_use_hotfix.mjs";
import { FREE_FIRST_EVENT_BOOKING_DELTAS, FREE_FIRST_EVENT_EVALUATOR_DELTAS }
  from "../patch_live_lk1_free_first_event_hotfix.mjs";
import {
  FREE_FIRST_EVENT_V1_BOOKING_ID,
  FREE_FIRST_EVENT_V1_DELTAS,
  FREE_FIRST_EVENT_V1_SOURCE_NODE_COUNT,
  FREE_FIRST_EVENT_V1_SOURCE_SHA256,
  FREE_FIRST_EVENT_V1_TARGET,
  composeFreeFirstEventV1Artifacts,
  patchFreeFirstEventV1BookingBody,
  sha256,
} from "../patch_live_lk1_free_first_event_v1_create_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_COHORT_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-cohort-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_COHORT_LIVE_SNAPSHOT)`;

function applyDeltas(source, deltas) {
  let out = source;
  for (const delta of deltas) {
    const occurrences = out.split(delta.before).length - 1;
    assert.equal(occurrences, 1, `anchor drift for ${delta.id}`);
    out = out.replace(delta.before, () => delta.after);
  }
  return out;
}

/** The installed flow after `lk1-free-first-event`, rebuilt from the reviewed chain. */
function installedFlowBytes() {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const booking = flow.find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID);
  booking.func = patchMoneyCohortBookingBody(booking.func);
  booking.func = applyDeltas(booking.func, PLAN_FIRST_USE_DELTAS.slice(0, 4));
  booking.func = applyDeltas(booking.func, FREE_FIRST_EVENT_BOOKING_DELTAS);
  const evaluator = flow.find((node) => node.id === "lk_subscription_managed_policy_20260820");
  const patchedEvaluator = applyDeltas(evaluator.func, FREE_FIRST_EVENT_EVALUATOR_DELTAS);
  evaluator.func = patchedEvaluator;
  flow.find((node) => node.id === "lk_subscription_price_preview_20260908_evaluate").func = patchedEvaluator;
  return Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
}

test("the generation pins the installed flow and one node field", () => {
  assert.equal(FREE_FIRST_EVENT_V1_SOURCE_NODE_COUNT, 4804);
  assert.equal(FREE_FIRST_EVENT_V1_SOURCE_SHA256,
    "1862dd942fe3c59b037bfc36dade4733f51f74fb57c46ff8cb275609f3b5f308");
  assert.equal(FREE_FIRST_EVENT_V1_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(FREE_FIRST_EVENT_V1_TARGET.liveFuncSha256,
    "7bdcde3b5990282f577ac2656275c4fb727e3fa534d79a859f1f1ef7fdbdfa60");
  assert.notEqual(FREE_FIRST_EVENT_V1_TARGET.liveFuncSha256, FREE_FIRST_EVENT_V1_TARGET.patchedFuncSha256);
  assert.equal(FREE_FIRST_EVENT_V1_DELTAS.length, 2);
});

test("the reviewed sources carry the reviewed deltas verbatim", () => {
  const reviewedHub = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/gateway.js"), "utf8");
  const reviewedComposition = fs.readFileSync(path.join(repoRoot, "scripts/patch_live_lk1_hub.mjs"), "utf8");
  // The cohort table travels verbatim in the reviewed gateway; the admin-version condition
  // lives in the reviewed hub composition that builds this body.
  assert.ok(reviewedHub.includes(FREE_FIRST_EVENT_V1_DELTAS[0].after), "reviewed cohort drift");
  assert.ok(reviewedComposition.includes('(ctx.lk1 && payload.paymentType === "SUBSCRIPTION")'),
    "reviewed hub composition drift");
  assert.equal(reviewedComposition.includes(FREE_FIRST_EVENT_V1_DELTAS[1].before), false);
});

test("the deltas apply and revert on the installed body only", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  assert.equal(sha256(bytes), FREE_FIRST_EVENT_V1_SOURCE_SHA256, "installed flow drift");
  const body = JSON.parse(bytes.toString("utf8")).find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID).func;
  const patched = patchFreeFirstEventV1BookingBody(body);
  assert.equal(sha256(patched), FREE_FIRST_EVENT_V1_TARGET.patchedFuncSha256);
  let reverted = patched;
  for (const delta of [...FREE_FIRST_EVENT_V1_DELTAS].reverse()) reverted = reverted.replace(delta.after, () => delta.before);
  assert.equal(reverted, body);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeFreeFirstEventV1Artifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(installedFlowBytes().toString("utf8"));
  drifted.find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID).func += "\n// drift";
  assert.throws(() => composeFreeFirstEventV1Artifacts(Buffer.from(`${JSON.stringify(drifted, null, 2)}\n`), "probe"),
    /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = installedFlowBytes();
  const built = composeFreeFirstEventV1Artifacts(bytes, "lk1-free-first-event-v1-create");
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, FREE_FIRST_EVENT_V1_BOOKING_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, FREE_FIRST_EVENT_V1_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.promoInCohort, true);
  assert.equal(built.booking.managedSubscriptionV1, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [FREE_FIRST_EVENT_V1_BOOKING_ID]);
});

test("the patched body writes a visit-covered managed event through v1",
  { skip: snapshotSkip }, () => {
    const bytes = installedFlowBytes();
    const live = JSON.parse(bytes.toString("utf8")).find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID).func;
    const patched = composeFreeFirstEventV1Artifacts(bytes, "lk1-free-first-event-v1-create")
      .flow.find((node) => node.id === FREE_FIRST_EVENT_V1_BOOKING_ID).func;
    // The installed body keeps the v2 fallback for the free path; the patched one does not.
    const freeCreate = /const adminVersion = ([^;]+);/.exec(patched);
    assert.ok(freeCreate, "admin version anchor missing");
    assert.ok(patched.includes("api/${adminVersion}/exercises"), "create path missing");
    const liveFree = /const adminVersion = ([^;]+);/.exec(live);
    assert.ok(liveFree, "live admin version anchor missing");
    assert.equal(liveFree[1].includes('(ctx.lk1 && payload.paymentType === "SUBSCRIPTION")'), false);
    assert.equal(freeCreate[1].includes('(ctx.lk1 && payload.paymentType === "SUBSCRIPTION")'), true);
    // The cohort now names both promo products.
    for (const productId of ["3b4806f1-6f9a-46df-a7d7-45075b4e7274", "6bda152b-0a9c-4308-82d0-3cd4e6aa680d"]) {
      assert.ok(patched.includes(`"${productId}": Object.freeze([`), productId);
    }
  });

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_free_first_event_v1_create_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_FREE_FIRST_EVENT_V1_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${FREE_FIRST_EVENT_V1_BOOKING_ID})`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_free_first_event_v1_create_hotfix.mjs"));
  assert.ok(wrapper.includes("value.booking?.promoInCohort !== true"));
  assert.ok(wrapper.includes("value.booking?.managedSubscriptionV1 !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-free-first-event-v1-create:deploy-147"],
    "bash scripts/deploy_nodered_lk1_free_first_event_v1_create_hotfix_147.sh");
});
