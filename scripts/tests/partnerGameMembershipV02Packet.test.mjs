import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PARTNER_API_FLOW_NODE_IDS } from "../patch_partner_game_membership_api_flow.mjs";
import { preparePartnerV02Packet } from "../prepare_partner_game_membership_v02_packet.mjs";
import { sha256, validateExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const roots = [];
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const digestFile = (filePath) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

function verifiedWorkspace() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-v02-packet-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const source = [
    { id: "lk-games-tab", type: "tab", label: "LK Games" },
    { id: "existing-route", type: "http in", z: "lk-games-tab", method: "get", url: "/lk/games", wires: [[]] },
  ];
  const sourcePath = path.join(input, "source.flow.json");
  const metaPath = path.join(input, "source.flow.meta.json");
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: "live-147",
    sourceHost: "lk-primary-147",
    sourceUser: "root",
    sourcePort: "22",
    remoteFlowPath: "/root/.node-red/flows.json",
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: digestFile(sourcePath),
    nodeCount: source.length,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, sourcePath };
}

test("v0.2 packet pins additions-only routes, package bytes, rollback identity, and every live gate", () => {
  const fixture = verifiedWorkspace();
  const outDir = path.join(fixture.root, "pilot-packet");
  const result = preparePartnerV02Packet({
    workspace: fixture.workspace,
    outDir,
    repository: { commit: "a".repeat(40), branch: "codex/partner-game-membership-api-v0.2-test" },
  });
  assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
  for (const name of [
    "candidate.flow.json",
    "reviewed-flow.contract.json",
    "custom-node.release.json",
    "deployment-plan.json",
  ]) assert.equal(fs.statSync(path.join(outDir, name)).mode & 0o777, 0o600);
  assert.equal(result.contract.allowedChanges.length, 0);
  assert.deepEqual(
    result.contract.allowedAdditions.map(({ id }) => id),
    Object.values(PARTNER_API_FLOW_NODE_IDS).sort(),
  );
  const liveBytes = fs.readFileSync(fixture.sourcePath);
  const candidateBytes = fs.readFileSync(path.join(outDir, "candidate.flow.json"));
  assert.deepEqual(validateExactGraphContract({ liveBytes, candidateBytes, contract: result.contract }), result.contract);
  assert.equal(result.plan.liveMutationAuthorized, false);
  assert.equal(result.plan.deploymentPerformed, false);
  assert.equal(result.plan.activationPerformed, false);
  assert.equal(result.plan.vivaContractState, "AWAITING_EXTERNAL_CONFIRMATION");
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("Idempotency-Key")));
  assert.equal(result.plan.rollback.sourceSha256, sha256(liveBytes));
  assert.equal(result.plan.rollback.exactByteRollbackRehearsed, true);
  assert.equal(result.plan.rollback.nodeRedRestartRehearsed, false);
  for (const file of result.release.files) {
    const packaged = path.join(outDir, "custom-node", file.relativePath);
    assert.equal(fs.statSync(packaged).mode & 0o777, 0o600);
    assert.equal(digestFile(packaged), file.sha256);
  }
  assert.ok(result.release.files.some(({ relativePath }) => relativePath === "package-lock.json"));
  assert.throws(() => preparePartnerV02Packet({
    workspace: fixture.workspace,
    outDir,
    repository: { commit: "a".repeat(40), branch: "same" },
  }), /must not already exist/);
});
