import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertHubLimitLiveBaseline,
  buildFocusedHubLimitCandidate,
  HUB_LIMIT_DEPLOYMENT_ID,
  HUB_LIMIT_LIVE_CONTRACT,
  HUB_LIMIT_TARGETS,
} from "../patch_live_subscription_hub_limit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FN_DIR = path.join(ROOT, "scripts", "nodered_games_nodes");
const TAB_ID = "f9575c8726e29196";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
// Recorded for the exact preimage this generation was reviewed against.
const EXPECTED_CANDIDATE_SHA256 = "aaccf2f066fa866cc7580bdbefaadb5e5e7c6d92e405a4dda36b032674a78470";
const EXPECTED_TARGET_IDS = ["8fdc7076a0c436a2", "c165e43eba668c25", "91dded2dc8cfebe4", "519b6a6ca208e281"];

test("hub limit generation pins the four reviewed live function nodes", () => {
  assert.deepEqual(HUB_LIMIT_LIVE_CONTRACT, {
    sourceSha256: "2ace2b60d0e246e84d5b9a542f6022ea1f7788c945dd855339e0ff0e47c09438",
    nodeCount: 4799,
    httpInputCount: 219,
  });
  assert.equal(HUB_LIMIT_DEPLOYMENT_ID, "subscription-hub-daily-limit-20260911");
  assert.equal(HUB_LIMIT_TARGETS.length, 4);
  assert.deepEqual(HUB_LIMIT_TARGETS.map((target) => target.id).sort(), [...EXPECTED_TARGET_IDS].sort());
  for (const target of HUB_LIMIT_TARGETS) {
    assert.match(target.liveSha256, /^[a-f0-9]{64}$/);
    const source = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    // Every node must read the same configurable global with the same default.
    assert.match(source, /summer_subscription_network_friendship_daily_limit/);
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", "env", source));
  }
});

test("hub limit builder changes only the selected function body", () => {
  const reviewed = HUB_LIMIT_TARGETS[0];
  const oldSource = "return msg;";
  const target = { ...reviewed, id: "synthetic-hub-limit", name: "Synthetic hub limit target", outputs: 1, liveSha256: sha256(oldSource) };
  const source = [{
    id: "synthetic-hub-limit", type: "function", z: TAB_ID, name: target.name,
    outputs: 1, wires: [[]], func: oldSource, x: 10, y: 20,
  }];
  const result = buildFocusedHubLimitCandidate(source, [target]);
  assert.equal(source[0].func, oldSource);
  assert.deepEqual(result.changes, [{ id: "synthetic-hub-limit", name: target.name, fields: ["func"] }]);
  assert.deepEqual(result.contract.allowedChanges.map((change) => change.id), ["synthetic-hub-limit"]);
  assert.deepEqual(result.contract.allowedAdditions, []);
  assert.equal(result.flow[0].x, 10);
  assert.equal(result.flow[0].y, 20);
  assert.equal(result.flow[0].func, fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8"));
});

test("hub limit builder fails closed on preimage, candidate and budget drift", () => {
  const reviewed = HUB_LIMIT_TARGETS[0];
  const node = (func) => ({ id: reviewed.id, type: "function", z: TAB_ID, name: reviewed.name,
    outputs: reviewed.outputs, wires: Array.from({ length: reviewed.outputs }, () => []), func });
  assert.throws(() => buildFocusedHubLimitCandidate([node("drifted")], [reviewed]), /Live function preimage changed/);
  assert.throws(
    () => buildFocusedHubLimitCandidate([node("x")], [{ ...reviewed, liveSha256: sha256("x"), candidateSha256: "0".repeat(64) }]),
    /Candidate source changed/,
  );
  const reviewedSource = fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8");
  assert.throws(
    () => buildFocusedHubLimitCandidate([node(reviewedSource)], [{ ...reviewed, liveSha256: sha256(reviewedSource) }]),
    /Focused change budget mismatch/,
  );
});

test("hub limit generation rejects any live baseline other than the reviewed preimage", () => {
  const source = [{ id: TAB_ID, type: "tab", label: "LK Tournaments" },
    ...Array.from({ length: HUB_LIMIT_LIVE_CONTRACT.httpInputCount },
      (_, index) => ({ id: `synthetic-http-${index}`, type: "http in", method: "get", url: `/synthetic/${index}` }))];
  const baseline = { sourceSha256: HUB_LIMIT_LIVE_CONTRACT.sourceSha256, nodeCount: HUB_LIMIT_LIVE_CONTRACT.nodeCount, source };
  assert.equal(assertHubLimitLiveBaseline(baseline), true);
  assert.throws(() => assertHubLimitLiveBaseline({ ...baseline, sourceSha256: "0".repeat(64) }), /baseline changed/);
  assert.throws(() => assertHubLimitLiveBaseline({ ...baseline, source: [...source, { id: "extra", type: "http in" }] }), /HTTP input count changed/);
});

const fixture = process.env.SUBSCRIPTION_HUB_LIMIT_LIVE_FIXTURE;
test("fresh private preimage composes exactly, keeps topology and reverses structurally", { skip: !fixture }, () => {
  const liveBytes = fs.readFileSync(fixture);
  const built = buildFocusedHubLimitCandidate(liveBytes);
  const before = JSON.parse(liveBytes.toString("utf8"));
  assert.equal(before.length, built.flow.length);
  const changed = new Set(built.changes.map((change) => change.id));
  assert.equal(changed.size, 4);
  for (let index = 0; index < before.length; index += 1) {
    if (!changed.has(before[index].id)) assert.deepEqual(built.flow[index], before[index]);
  }
  assert.equal(built.flow.filter((node) => node.type === "http in").length, HUB_LIMIT_LIVE_CONTRACT.httpInputCount);
  assert.equal(sha256(built.candidateBytes), EXPECTED_CANDIDATE_SHA256);
  const reversed = structuredClone(built.flow);
  for (const change of built.changes) {
    const index = reversed.findIndex((node) => node.id === change.id);
    reversed[index].func = before[index].func;
  }
  assert.deepEqual(reversed, before);
});
