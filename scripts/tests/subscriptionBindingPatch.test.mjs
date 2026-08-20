import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildFocusedSubscriptionBindingCandidate,
  SUBSCRIPTION_BINDING_LIVE_CONTRACT,
  SUBSCRIPTION_BINDING_TARGETS,
} from "../patch_live_games_subscription_binding.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FN_DIR = path.join(ROOT, "scripts", "nodered_games_nodes");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("subscription binding patch pins six unique reviewed live function nodes", () => {
  assert.deepEqual(SUBSCRIPTION_BINDING_LIVE_CONTRACT, {
    sourceSha256: "2cbb00db7983248b212fcd2fc227795277a4d90b7dd3ace804655829a68f3828",
    nodeCount: 4756,
    httpInputCount: 215,
  });
  assert.equal(SUBSCRIPTION_BINDING_TARGETS.length, 6);
  assert.equal(new Set(SUBSCRIPTION_BINDING_TARGETS.map((target) => target.id)).size, 6);
  for (const target of SUBSCRIPTION_BINDING_TARGETS) {
    assert.match(target.liveSha256, /^[a-f0-9]{64}$/);
    const source = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", "env", source));
  }
  assert.equal(
    SUBSCRIPTION_BINDING_TARGETS.find(({ id }) => id === "e92e68bf3f08a70c").liveSha256,
    "acb2a2eb981f497681d592f257b1c69275da4c9de5307d69654d27980689a149",
  );
  assert.equal(
    SUBSCRIPTION_BINDING_TARGETS.find(({ id }) => id === "8f7bd5b482fe9763").liveSha256,
    "34ba99f50ca025095d464aadd47af0aa1352a1679482f032abc30846b5fa1c80",
  );
});

test("subscription binding builder changes only one selected function body", () => {
  const reviewed = SUBSCRIPTION_BINDING_TARGETS[0];
  const oldSource = "return msg;";
  const source = [{
    id: "synthetic-target",
    type: "function",
    z: "4b91e2a2413688db",
    name: "Synthetic subscription binding target",
    outputs: 1,
    wires: [[]],
    func: oldSource,
    x: 10,
    y: 20,
  }];
  const target = {
    ...reviewed,
    id: "synthetic-target",
    name: "Synthetic subscription binding target",
    outputs: 1,
    liveSha256: sha256(oldSource),
  };
  const result = buildFocusedSubscriptionBindingCandidate(source, [target]);
  assert.equal(source[0].func, oldSource);
  assert.deepEqual(result.changes, [{
    id: "synthetic-target",
    name: "Synthetic subscription binding target",
    changedFields: ["func"],
  }]);
  assert.equal(result.importNodes.length, 1);
  assert.equal(result.flow[0].x, source[0].x);
  assert.equal(result.flow[0].y, source[0].y);
  assert.equal(result.flow[0].func, fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8"));
});

test("subscription binding builder fails closed when the live preimage drifts", () => {
  const reviewed = SUBSCRIPTION_BINDING_TARGETS[0];
  const source = [{
    id: reviewed.id,
    type: "function",
    z: "4b91e2a2413688db",
    name: reviewed.name,
    outputs: reviewed.outputs,
    wires: Array.from({ length: reviewed.outputs }, () => []),
    func: "drifted live function",
  }];
  assert.throws(
    () => buildFocusedSubscriptionBindingCandidate(source, [reviewed]),
    /Live function preimage changed/,
  );
});
