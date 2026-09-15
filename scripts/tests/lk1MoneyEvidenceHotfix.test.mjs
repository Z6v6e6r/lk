// Focused generation for the money-evidence diagnostics on the event route.
// Pins the reviewed preimages/postimages, the fail-closed preimage gates and the wrapper.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MONEY_EVIDENCE_BOOKING_ID,
  MONEY_EVIDENCE_DELTAS,
  MONEY_EVIDENCE_SOURCE_NODE_COUNT,
  MONEY_EVIDENCE_SOURCE_SHA256,
  MONEY_EVIDENCE_TARGET,
  composeMoneyEvidenceArtifacts,
  patchMoneyEvidenceBookingBody,
  sha256,
} from "../patch_live_lk1_money_evidence_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_SNAPSHOT = process.env.LK1_MONEY_EVIDENCE_LIVE_SNAPSHOT
  ?? "/private/tmp/lk1-evidence-live/source.flow.json";
const snapshotSkip = fs.existsSync(LIVE_SNAPSHOT)
  ? false
  : `live 147 snapshot is absent: ${LIVE_SNAPSHOT} (set LK1_MONEY_EVIDENCE_LIVE_SNAPSHOT)`;

test("the generation pins the installed flow and one node field", () => {
  assert.equal(MONEY_EVIDENCE_SOURCE_NODE_COUNT, 4804);
  assert.match(MONEY_EVIDENCE_SOURCE_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(MONEY_EVIDENCE_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.match(MONEY_EVIDENCE_TARGET.liveFuncSha256, /^[0-9a-f]{64}$/);
  assert.match(MONEY_EVIDENCE_TARGET.patchedFuncSha256, /^[0-9a-f]{64}$/);
  assert.notEqual(MONEY_EVIDENCE_TARGET.liveFuncSha256, MONEY_EVIDENCE_TARGET.patchedFuncSha256);
  assert.equal(MONEY_EVIDENCE_DELTAS.length, 1);
  for (const delta of MONEY_EVIDENCE_DELTAS) assert.ok(delta.before && delta.after, delta.id);
});

test("the delta names the money-evidence state and nothing else", { skip: snapshotSkip }, () => {
  const flow = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  const body = flow.find((node) => node.id === MONEY_EVIDENCE_BOOKING_ID).func;
  const patched = patchMoneyEvidenceBookingBody(body);
  assert.equal(sha256(patched), MONEY_EVIDENCE_TARGET.patchedFuncSha256);
  let reverted = patched;
  for (const delta of [...MONEY_EVIDENCE_DELTAS].reverse()) reverted = reverted.replace(delta.after, () => delta.before);
  assert.equal(reverted, body);
  // The verdict is the same stop: only the reported state was added.
  assert.ok(patched.includes('stage: "money_evidence",'));
  assert.ok(patched.includes('evidencePresent: isObj(ctx.lk1MoneyOwnership),'));
  assert.equal(patched.includes("    if (quote.code) return lk1Stop(ctx, quote.code);"), false);
});

test("the generation refuses any flow that is not the installed one", () => {
  const flow = [{ id: "x", type: "function", func: "", initialize: "", outputs: 1, wires: [[]] }];
  assert.throws(() => composeMoneyEvidenceArtifacts(flow, "probe"), /Live flow preimage drift/);
  if (snapshotSkip) return;
  const drifted = JSON.parse(fs.readFileSync(LIVE_SNAPSHOT, "utf8"));
  drifted.find((node) => node.id === MONEY_EVIDENCE_BOOKING_ID).func += "\n// drift";
  assert.throws(() => composeMoneyEvidenceArtifacts(drifted, "probe"), /Live flow preimage drift/);
});

test("the generation composes exactly the reviewed postimage", { skip: snapshotSkip }, () => {
  const bytes = fs.readFileSync(LIVE_SNAPSHOT);
  const built = composeMoneyEvidenceArtifacts(bytes, "lk1-money-evidence");
  assert.equal(built.changes.length, 1);
  assert.equal(built.changes[0].id, MONEY_EVIDENCE_BOOKING_ID);
  assert.deepEqual(built.changes[0].fields, ["func"]);
  assert.equal(built.changes[0].func.afterSha256, MONEY_EVIDENCE_TARGET.patchedFuncSha256);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.diagnosticsPresent, true);
  assert.equal(built.contract.allowedChanges.length, 1);
  assert.equal((built.contract.allowedAdditions ?? []).length, 0);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  const live = JSON.parse(bytes.toString("utf8"));
  const differing = candidate.filter((node, index) => JSON.stringify(node) !== JSON.stringify(live[index]));
  assert.deepEqual(differing.map((node) => node.id), [MONEY_EVIDENCE_BOOKING_ID]);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(
    path.join(repoRoot, "scripts/deploy_nodered_lk1_money_evidence_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes('NODE_RED_LK1_MONEY_EVIDENCE_DEPLOY:-}" != "CONFIRM_147"'));
  assert.ok(wrapper.includes(`allow_nodes=(${MONEY_EVIDENCE_BOOKING_ID})`));
  assert.ok(wrapper.includes(`"${MONEY_EVIDENCE_BOOKING_ID}:func"`));
  assert.ok(wrapper.includes("expected_changed_nodes=1"));
  assert.ok(wrapper.includes("patch_live_lk1_money_evidence_hotfix.mjs"));
  assert.ok(wrapper.includes("prepare_exact_graph_contract.mjs"));
  assert.equal(wrapper.includes("nodered_reviewed_flow_deploy/prepare_contract.mjs"), false);
  assert.ok(wrapper.includes("value.booking?.diagnosticsPresent !== true"));
  assert.ok(wrapper.includes("rollback --deployment-id"));
  assert.ok(wrapper.includes("sha256sum"));
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-money-evidence:deploy-147"],
    "bash scripts/deploy_nodered_lk1_money_evidence_hotfix_147.sh");
});
