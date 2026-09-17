// Focused generation for the "event already started" preview answer (2026-09-17).
//
// One node, one field: the twelve target conditions of the event route are named, the refusal
// union is unchanged, and a healthy target that already started answers 200 with no quotes.
// The exhaustive decision-equivalence enumeration lives in `lk1TargetDiagnostics.test.mjs`;
// this suite pins the preimage/postimage, the fail-closed gates and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  EVENT_STARTED_BOOKING_ID,
  EVENT_STARTED_DEPLOYMENT_ID,
  EVENT_STARTED_EVALUATOR_ID,
  EVENT_STARTED_INSTALLED_GENERATION,
  EVENT_STARTED_ROUTER_ID,
  EVENT_STARTED_SOURCE_NODE_COUNT,
  EVENT_STARTED_SOURCE_SHA256,
  EVENT_STARTED_TARGET,
  composeLk1EventStartedArtifacts,
  refusalCallSites,
  sha256,
} from "../patch_live_lk1_event_started_unavailable_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_EVENT_STARTED_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-target-fix-live/input/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_EVENT_STARTED_LIVE_SNAPSHOT)`;

test('the generation pins the installed flow and one node field', () => {
  assert.equal(EVENT_STARTED_DEPLOYMENT_ID, "lk1-event-started-unavailable");
  assert.match(EVENT_STARTED_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(EVENT_STARTED_SOURCE_NODE_COUNT, 4804);
  assert.equal(EVENT_STARTED_ROUTER_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(EVENT_STARTED_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(EVENT_STARTED_EVALUATOR_ID, "lk_subscription_managed_policy_20260820");
  assert.match(EVENT_STARTED_TARGET.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(EVENT_STARTED_TARGET.patchedFuncSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(EVENT_STARTED_TARGET.liveFuncSha256, EVENT_STARTED_TARGET.patchedFuncSha256);
  for (const value of Object.values(EVENT_STARTED_INSTALLED_GENERATION)) {
    assert.match(value, /^[0-9a-f]{64}$/);
  }
});

test('the generation refuses any flow that is not the installed one', () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeLk1EventStartedArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === EVENT_STARTED_ROUTER_ID).func += "\n// drift";
  assert.throws(() => composeLk1EventStartedArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test('the generation composes exactly the reviewed postimage', { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1EventStartedArtifacts(bytes, EVENT_STARTED_DEPLOYMENT_ID);
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, EVENT_STARTED_ROUTER_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, EVENT_STARTED_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.refusalSitesUnchanged, true);
  assert.equal(built.preview.startedEventAnswersUnavailable, true);
  assert.equal(built.preview.otherFieldsUnchanged, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);

  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [EVENT_STARTED_ROUTER_ID]);
  assert.equal(sha256(candidate.find((node) => node.id === EVENT_STARTED_BOOKING_ID).func),
    EVENT_STARTED_INSTALLED_GENERATION.bookingFuncSha256);

  const installed = live.find((node) => node.id === EVENT_STARTED_ROUTER_ID).func;
  const composed = candidate.find((node) => node.id === EVENT_STARTED_ROUTER_ID).func;
  // No refusal was added, moved or dropped; the started state is the only new answer.
  assert.deepEqual(refusalCallSites(composed), refusalCallSites(installed));
  assert.equal(installed.includes("const targetHealthy = "), false);
  assert.ok(composed.includes("const targetHealthy = targetChecks.httpOk && targetChecks.resolved"));
  assert.ok(composed.includes("      ctx.quotes = [];\n      ctx.done = true;\n      ctx.statusCode = 200;"));
  // The twelve original conditions survive verbatim as the named checks.
  for (const check of ["httpOk: ok()", "resolved: Boolean(exercise)",
    "idMatch: Boolean(exercise) && String(exercise.id || exercise.exerciseId || '') === ctx.exerciseId",
    "category: Boolean(exercise) && canonical.resolveCategory(exercise) === eventRoute?.category",
    "startsAtParsed: Number.isFinite(start)",
    "startsInFuture: Number.isFinite(start) && start > Date.now(),",
    "durationValid: Number.isSafeInteger(duration) && duration >= 1 && duration <= 720",
    "hasRoom: Boolean(canonical.exerciseRoomId(exercise))",
    "hasStudio: Boolean(exercise && (exercise.studio?.id || exercise.studioId))",
    "hasExternalEventType: Boolean(exercise && canonical.managedExternalEventTypeId(exercise))",
    "notCancelled: !(exercise?.isCancelled === true || exercise?.isCanceled === true)"]) {
    assert.ok(composed.includes(check.replace(/\n\s*/g, ' ')), `missing condition: ${check}`);
  }
});

test('the deploy wrapper keeps the confirmation gate, the pinned commit and rollback', () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_event_started_unavailable_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_EVENT_STARTED_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${EVENT_STARTED_ROUTER_ID})`));
  assert.ok(wrapper.includes(`"${EVENT_STARTED_ROUTER_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_event_started_unavailable_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.match(wrapper, /generation_commit="[0-9a-f]{40}"/);
  assert.ok(wrapper.includes('git merge-base --is-ancestor "$generation_commit" "$local_sha"'));
  assert.ok(wrapper.includes('git ls-remote --heads origin'));
  assert.ok(wrapper.includes("node '$remote_helper' rollback"));
  assert.ok(wrapper.includes("Installed flow readback does not match the candidate"));
});

test('the wrapper is registered as an npm deploy command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-event-started:deploy-147"],
    "bash scripts/deploy_nodered_lk1_event_started_unavailable_147.sh");
});
