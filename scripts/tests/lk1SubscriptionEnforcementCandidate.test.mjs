import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  buildLk1EnforcementCandidate,
  LK1_ENFORCEMENT_CONTRACT,
} from "../prepare_lk1_subscription_enforcement_candidate.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function syntheticContract() {
  const flow = [
    { id: "games", type: "tab", label: "LK Games", disabled: false },
    { id: "tournaments", type: "tab", label: "LK Tournaments", disabled: false },
    { id: "a", type: "function", z: "games", name: "A", func: "return msg;\n", wires: [["b"]] },
    { id: "b", type: "function", z: "tournaments", name: "B", func: "return msg;\n", wires: [] },
  ];
  const sources = new Map([
    ["a.js", "msg.a = true;\nreturn msg;\n"],
    ["b.js", "msg.b = true;\nreturn msg;\n"],
  ]);
  const contract = {
    sourceSha256: "source-sha",
    nodeCount: flow.length,
    targets: [
      { id: "a", tabLabel: "LK Games", name: "A", sourceFile: "a.js", preimageSha256: sha256(flow[2].func), candidateSha256: sha256(sources.get("a.js")) },
      { id: "b", tabLabel: "LK Tournaments", name: "B", sourceFile: "b.js", preimageSha256: sha256(flow[3].func), candidateSha256: sha256(sources.get("b.js")) },
    ],
  };
  return { flow, contract, sources };
}

test("unified LK1 candidate changes only exact function bodies and preserves topology", () => {
  const { flow, contract, sources } = syntheticContract();
  const beforeTopology = flow.map((node) => ({ id: node.id, z: node.z, wires: node.wires }));
  const result = buildLk1EnforcementCandidate(
    structuredClone(flow),
    contract.sourceSha256,
    contract,
    (sourceFile) => sources.get(sourceFile),
  );
  assert.deepEqual(result.changedNodes.map((node) => node.id), ["a", "b"]);
  assert.deepEqual(
    result.candidate.map((node) => ({ id: node.id, z: node.z, wires: node.wires })),
    beforeTopology,
  );
});

test("unified LK1 candidate fails closed on source, preimage, or enabled-tab drift", () => {
  const { flow, contract, sources } = syntheticContract();
  const build = (candidate, sourceSha = contract.sourceSha256) => buildLk1EnforcementCandidate(
    candidate,
    sourceSha,
    contract,
    (sourceFile) => sources.get(sourceFile),
  );
  assert.throws(() => build(structuredClone(flow), "drift"), /live source SHA mismatch/);
  const functionDrift = structuredClone(flow);
  functionDrift[2].func = "return null;\n";
  assert.throws(() => build(functionDrift), /preimage mismatch/);
  const disabledTab = structuredClone(flow);
  disabledTab[0].disabled = true;
  assert.throws(() => build(disabledTab), /enabled-tab mismatch/);
});

test("unified LK1 contract pins every tracked candidate source", () => {
  assert.equal(LK1_ENFORCEMENT_CONTRACT.targets.length, 5);
  for (const target of LK1_ENFORCEMENT_CONTRACT.targets) {
    assert.equal(sha256(fs.readFileSync(target.sourceFile)), target.candidateSha256, target.id);
  }
});
