import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildFocusedSubscriptionReturnCandidate,
  SUBSCRIPTION_RETURN_TARGETS,
} from "../patch_live_games_subscription_return_verification.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FN_DIR = path.join(ROOT, "scripts", "nodered_games_nodes");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("subscription return patch pins 14 unique reviewed live function nodes", () => {
  assert.equal(SUBSCRIPTION_RETURN_TARGETS.length, 14);
  assert.equal(new Set(SUBSCRIPTION_RETURN_TARGETS.map((target) => target.id)).size, 14);
  for (const target of SUBSCRIPTION_RETURN_TARGETS) {
    assert.match(target.liveSha256, /^[a-f0-9]{64}$/);
    const source = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    assert.doesNotThrow(() => new Function("msg", "flow", "global", "node", "env", source));
  }
});

test("focused builder changes only the selected function body", () => {
  const reviewed = SUBSCRIPTION_RETURN_TARGETS[0];
  const oldSource = "return msg;";
  const source = [{
    id: "synthetic-target",
    type: "function",
    z: "4b91e2a2413688db",
    name: "Synthetic subscription return target",
    outputs: 1,
    wires: [[]],
    func: oldSource,
    x: 10,
    y: 20,
  }];
  const target = {
    ...reviewed,
    id: "synthetic-target",
    name: "Synthetic subscription return target",
    outputs: 1,
    liveSha256: sha256(oldSource),
  };
  const result = buildFocusedSubscriptionReturnCandidate(source, [target]);
  assert.equal(source[0].func, oldSource);
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes[0].changedFields, ["func"]);
  assert.equal(result.importNodes.length, 1);
  assert.equal(result.flow[0].id, source[0].id);
  assert.equal(result.flow[0].x, source[0].x);
  assert.equal(result.flow[0].y, source[0].y);
  assert.equal(result.flow[0].func, fs.readFileSync(path.join(FN_DIR, reviewed.fileName), "utf8"));
});

test("focused builder fails closed when the live preimage drifts", () => {
  const reviewed = SUBSCRIPTION_RETURN_TARGETS[0];
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
    () => buildFocusedSubscriptionReturnCandidate(source, [reviewed]),
    /Live function preimage changed/,
  );
});
