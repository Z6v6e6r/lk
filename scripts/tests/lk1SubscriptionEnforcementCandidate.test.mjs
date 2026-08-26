import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  buildLk1EnforcementCandidate,
  LK1_ENFORCEMENT_CONTRACT,
  validateUnifiedCandidateSummary,
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
  assert.equal(
    LK1_ENFORCEMENT_CONTRACT.sourceSha256,
    "14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350",
  );
  assert.equal(LK1_ENFORCEMENT_CONTRACT.targets.length, 5);
  for (const target of LK1_ENFORCEMENT_CONTRACT.targets) {
    assert.equal(sha256(fs.readFileSync(target.sourceFile)), target.candidateSha256, target.id);
  }
  assert.equal(LK1_ENFORCEMENT_CONTRACT.composedSources.length, 8);
  for (const source of LK1_ENFORCEMENT_CONTRACT.composedSources) {
    assert.equal(sha256(fs.readFileSync(source.sourceFile)), source.candidateSha256, source.id);
  }
});

test("reviewed unified composition contract pins digest, inventory, ACK order and recovery", () => {
  const summary = {
    sourceSha256: LK1_ENFORCEMENT_CONTRACT.sourceSha256,
    candidateSha256: LK1_ENFORCEMENT_CONTRACT.candidateSha256,
    candidateNodeCount: 4812,
    httpRouteCount: 215,
    tabCount: 55,
    changedNodeCount: 104,
    changedExistingNodeCount: 54,
    addedNodeCount: 50,
    writerCount: 7,
    brokenWires: 0,
    brokenLinks: 0,
    splitPricingMutationCount: 0,
    createAckOrder: [
      "lk_game_create_revision_ack_20260826",
      "lk_game_payment_confirm_write_ack_20260826",
      "lk_game_payment_confirm_write_readback_20260826",
    ],
    cleanupAckOrder: [
      "lk_split_cleanup_revision_ack_20260826",
      "lk_split_cleanup_write_ack_20260826",
      "lk_split_cleanup_write_readback_20260826",
    ],
    cleanupRecoveryNode: "lk_split_cleanup_revision_recovery_write_20260826",
  };
  assert.equal(validateUnifiedCandidateSummary(summary), true);
  for (const drift of [
    { candidateSha256: "drift" },
    { changedNodeCount: 105 },
    { brokenWires: 1 },
    { createAckOrder: [...summary.createAckOrder].reverse() },
    { cleanupRecoveryNode: "wrong" },
  ]) {
    assert.throws(
      () => validateUnifiedCandidateSummary({ ...summary, ...drift }),
      /reviewed candidate contract mismatch/,
    );
  }
});

test("unified ACK sources require tenant/revision readback and durable cleanup recovery", () => {
  const create = fs.readFileSync("scripts/nodered_games_nodes/fn_create.js", "utf8");
  const confirmAck = fs.readFileSync("scripts/nodered_games_nodes/fn_game_confirm_write_ack.js", "utf8");
  const cleanup = fs.readFileSync("scripts/nodered_games_nodes/fn_split_cleanup_router.js", "utf8");
  const cleanupAck = fs.readFileSync("scripts/nodered_games_nodes/fn_split_cleanup_write_ack.js", "utf8");
  const cleanupRevisionAck = fs.readFileSync(
    "scripts/nodered_legacy_command_prerequisite_nodes/fn_cleanup_revision_ack.js",
    "utf8",
  );

  assert.match(create, /body\.expectedRevision/);
  assert.doesNotMatch(create, /body\.revision/);
  assert.match(create, /tenantKey,\n {2}id: gameId,\n {2}revision:/);
  assert.match(create, /\$inc: \{ revision: 1 \}/);
  assert.match(confirmAck, /tenantKey: ctx\.tenantKey, id: ctx\.gameId, revision: ctx\.expectedNextRevision/);
  assert.match(confirmAck, /Number\(record\.revision\) === Number\(ctx\.expectedNextRevision\)/);
  assert.match(cleanup, /tenantKey: ctx\.sourceTenantKey/);
  assert.match(cleanup, /revision: ctx\.sourceRevision/);
  assert.match(cleanup, /_splitCleanupRevisionDeferred/);
  assert.match(cleanupAck, /return \[null, null, null, msg\]/);
  assert.match(cleanupRevisionAck, /_legacyCleanupRecovery/);
});
