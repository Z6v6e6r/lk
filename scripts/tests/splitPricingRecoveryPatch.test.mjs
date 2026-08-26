import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SPLIT_PRICING_RECOVERY_TARGETS,
  applySplitPricingRecovery,
} from "../patch_live_split_pricing_recovery.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const fixture = () => {
  const liveFunctions = ["return 'join-live';", "return 'router-live';"];
  const targets = SPLIT_PRICING_RECOVERY_TARGETS.map((target, index) => ({
    ...target,
    liveSha256: sha256(liveFunctions[index]),
  }));
  const flow = [
    { id: "4b91e2a2413688db", type: "tab", label: "LK Games", disabled: false },
    ...targets.map((target, index) => ({
      id: target.id,
      type: "function",
      z: "4b91e2a2413688db",
      name: target.name,
      outputs: target.outputs,
      wires: target.wires,
      func: liveFunctions[index],
    })),
  ];
  return { flow, targets };
};

test("split pricing recovery sources stay pinned to the reviewed postimages", () => {
  assert.equal(SPLIT_PRICING_RECOVERY_TARGETS.length, 2);
  for (const target of SPLIT_PRICING_RECOVERY_TARGETS) {
    const source = fs.readFileSync(path.join(SOURCE_DIR, target.fileName), "utf8");
    assert.equal(sha256(source), target.candidateSha256, target.fileName);
    assert.notEqual(target.liveSha256, target.candidateSha256, target.fileName);
  }
});

test("focused candidate changes only the two reviewed function bodies", () => {
  const { flow, targets } = fixture();
  const before = structuredClone(flow);
  const result = applySplitPricingRecovery(flow, targets);
  assert.deepEqual(flow, before);
  assert.deepEqual(result.changes, targets.map((target) => ({
    id: target.id,
    name: target.name,
    changedFields: ["func"],
  })));
  assert.equal(result.importNodes.length, 2);
  assert.deepEqual(result.flow.map((node) => ({ ...node, func: undefined })), before.map((node) => ({ ...node, func: undefined })));
});

test("focused candidate rejects live function and topology drift", () => {
  const first = fixture();
  first.flow[1].func = "return 'drifted';";
  assert.throws(
    () => applySplitPricingRecovery(first.flow, first.targets),
    /live preimage changed/,
  );

  const second = fixture();
  second.flow[2].wires = [[]];
  assert.throws(
    () => applySplitPricingRecovery(second.flow, second.targets),
    /node contract mismatch/,
  );
});
