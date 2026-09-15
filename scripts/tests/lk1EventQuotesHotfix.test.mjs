// Focused generation for the event-route quote defects that stayed live after the
// 2026-09-15 plan-rules release and the preview event-helpers hotfix. This suite pins
// the reviewed preimages/postimages, the fail-closed preimage gates and the wrapper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EVENT_QUOTES_BOOKING_ANCHOR,
  EVENT_QUOTES_BOOKING_ID,
  EVENT_QUOTES_EVALUATOR_ID,
  EVENT_QUOTES_INSTALLED_GENERATION,
  EVENT_QUOTES_PREVIEW_FINAL_ID,
  EVENT_QUOTES_PREVIEW_ROUTER_ID,
  EVENT_QUOTES_SOURCE_NODE_COUNT,
  EVENT_QUOTES_SOURCE_SHA256,
  EVENT_QUOTES_TARGETS,
  composeLk1EventQuotesArtifacts,
  patchEventQuotesBookingBody,
  sha256,
} from "../patch_live_lk1_event_quotes_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_EVENT_QUOTES_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-event-live/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_EVENT_QUOTES_LIVE_SNAPSHOT)`;

test("the generation pins the installed flow and three node fields", () => {
  assert.match(EVENT_QUOTES_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(EVENT_QUOTES_SOURCE_NODE_COUNT, 4804);
  assert.equal(EVENT_QUOTES_PREVIEW_ROUTER_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(EVENT_QUOTES_PREVIEW_FINAL_ID, "lk_subscription_price_preview_20260908_final");
  assert.equal(EVENT_QUOTES_BOOKING_ID, "lk_subscription_booking_router_20260804");
  for (const [label, target] of Object.entries(EVENT_QUOTES_TARGETS)) {
    assert.match(target.liveFuncSha256, /^[0-9a-f]{64}$/, label);
    assert.match(target.patchedFuncSha256, /^[0-9a-f]{64}$/, label);
    assert.notEqual(target.liveFuncSha256, target.patchedFuncSha256, label);
  }
  assert.deepEqual(Object.keys(EVENT_QUOTES_INSTALLED_GENERATION).sort(),
    ["allowanceBlockSha256", "bookingFuncSha256", "evaluatorFuncSha256", "joinFuncSha256", "splitFuncSha256"]);
  for (const [label, digest] of Object.entries(EVENT_QUOTES_INSTALLED_GENERATION)) {
    assert.match(digest, /^[0-9a-f]{64}$/, label);
  }
  // The booking delta is the response-provenance fix and nothing else.
  assert.equal(EVENT_QUOTES_BOOKING_ANCHOR.before.includes("delete msg.responseUrl;"), false);
  assert.equal(EVENT_QUOTES_BOOKING_ANCHOR.after.includes("delete msg.responseUrl;"), true);
  assert.equal(EVENT_QUOTES_BOOKING_ANCHOR.after.replace("  delete msg.responseUrl;\n", ""),
    EVENT_QUOTES_BOOKING_ANCHOR.before);
});

test("the booking delta refuses any other preimage and stays byte-minimal", () => {
  const synthetic = `${EVENT_QUOTES_BOOKING_ANCHOR.before}\n`;
  assert.throws(() => patchEventQuotesBookingBody(synthetic), /installed preimage drift/);
  if (snapshotSkip) return;
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const body = flow.find((node) => node.id === EVENT_QUOTES_BOOKING_ID).func;
  const patched = patchEventQuotesBookingBody(body);
  assert.equal(sha256(patched), EVENT_QUOTES_TARGETS.booking.patchedFuncSha256);
  // Exactly one insertion, nothing else: reverting the patched anchor reproduces the
  // installed body byte for byte.
  assert.equal(patched.split("delete msg.responseUrl;").length, 2);
  assert.equal(patched.replace(EVENT_QUOTES_BOOKING_ANCHOR.after, EVENT_QUOTES_BOOKING_ANCHOR.before), body);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeLk1EventQuotesArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === EVENT_QUOTES_EVALUATOR_ID).func += "\n// drift";
  assert.throws(() => composeLk1EventQuotesArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the three reviewed postimages", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeLk1EventQuotesArtifacts(bytes, "lk1-event-quotes");
  assert.equal(built.changes.length, 3);
  assert.deepEqual(built.changes.map((change) => change.id).sort(),
    [EVENT_QUOTES_BOOKING_ID, EVENT_QUOTES_PREVIEW_FINAL_ID, EVENT_QUOTES_PREVIEW_ROUTER_ID].sort());
  for (const change of built.changes) assert.deepEqual(change.fields, ["func"]);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.preview.eventHelpersPublished, true);
  assert.equal(built.preview.otherFieldsUnchanged, true);
  assert.equal(built.contract.contractKind, "exact-graph");
  assert.equal(built.contract.allowedChanges.length, 3);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  assert.equal(candidate.length, live.length);
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id).sort(),
    [EVENT_QUOTES_BOOKING_ID, EVENT_QUOTES_PREVIEW_FINAL_ID, EVENT_QUOTES_PREVIEW_ROUTER_ID].sort());
  // The plan-rules activation and the evaluator are untouched.
  const liveBooking = live.find((node) => node.id === EVENT_QUOTES_BOOKING_ID);
  const candidateBooking = candidate.find((node) => node.id === EVENT_QUOTES_BOOKING_ID);
  assert.equal(candidateBooking.initialize, liveBooking.initialize);
  assert.equal(sha256(candidate.find((node) => node.id === EVENT_QUOTES_EVALUATOR_ID).func),
    EVENT_QUOTES_INSTALLED_GENERATION.evaluatorFuncSha256);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_event_quotes_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_EVENT_QUOTES_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes("clean main checkout"));
  assert.ok(wrapper.includes(`allow_nodes=(${EVENT_QUOTES_PREVIEW_ROUTER_ID} ${EVENT_QUOTES_PREVIEW_FINAL_ID} ${EVENT_QUOTES_BOOKING_ID})`));
  for (const id of [EVENT_QUOTES_PREVIEW_ROUTER_ID, EVENT_QUOTES_PREVIEW_FINAL_ID, EVENT_QUOTES_BOOKING_ID]) {
    assert.ok(wrapper.includes(`"${id}:func"`), id);
  }
  assert.ok(wrapper.includes("expected_changed_nodes=3"));
  assert.ok(wrapper.includes("patch_live_lk1_event_quotes_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  assert.ok(wrapper.includes("deploy_reviewed_flow_147_remote.mjs"));
  assert.ok(wrapper.includes("value.preview?.eventHelpersPublished !== true"));
  assert.ok(wrapper.includes('smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"'));
  assert.ok(wrapper.includes('value.currency !== "RUB"'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-event-quotes:deploy-147"],
    "bash scripts/deploy_nodered_lk1_event_quotes_hotfix_147.sh");
});

test("the wrapper stage and backup paths satisfy the reviewed remote contract", () => {
  const helper = fs.readFileSync(
    path.join(repoRoot, "scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs"), "utf8");
  const stageParent = /const STAGE_PARENT = "([^"]+)";/.exec(helper)?.[1];
  const patternLiteral = /const STAGE_PATTERN = \/(.+)\/;/.exec(helper)?.[1];
  const backupDir = /const BACKUP_DIRECTORY = "([^"]+)";/.exec(helper)?.[1];
  assert.ok(stageParent && patternLiteral && backupDir, "remote stage/backup constants");
  const stagePattern = new RegExp(patternLiteral);
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_event_quotes_hotfix_147.sh"), "utf8");
  const stageLine = /^remote_stage="([^"]*)"$/m.exec(wrapper)?.[1];
  const rendered = stageLine.replace("$remote_stamp", "20260915T230000+0300").replace(/\$\$/g, "5150");
  assert.equal(rendered.slice(0, rendered.lastIndexOf("/")), stageParent);
  assert.ok(stagePattern.test(rendered.slice(rendered.lastIndexOf("/") + 1)), rendered);
  assert.ok(wrapper.includes('remote_candidate="$remote_stage/candidate.flow.json"'));
  assert.ok(wrapper.includes('remote_contract="$remote_stage/contract.json"'));
  assert.ok(wrapper.includes(`remote_backup_dir="${backupDir}"`));
  assert.ok(wrapper.includes('remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"'));
  assert.ok(wrapper.includes('remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"'));
});
