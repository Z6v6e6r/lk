import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPartnerGameMembershipApiSidecarCandidate,
  PARTNER_API_FLOW_NODE_IDS,
} from "../patch_partner_game_membership_api_flow.mjs";
import {
  buildPartnerV02DeploymentPlan,
  preparePartnerV02Packet,
} from "../prepare_partner_game_membership_v02_packet.mjs";
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
    repository: { commit: "a".repeat(40), tree: "b".repeat(40), branch: "codex/partner-game-membership-api-v0.2-test" },
  });
  assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
  for (const name of [
    "candidate.flow.json",
    "reviewed-flow.contract.json",
    "custom-node.release.json",
    "production-controls.contract.json",
    "deployment-plan.json",
    "packet.manifest.json",
  ]) assert.equal(fs.statSync(path.join(outDir, name)).mode & 0o777, 0o600);
  const settings = fs.readFileSync(path.join(outDir, "sidecar/settings.cjs"), "utf8");
  const service = fs.readFileSync(path.join(outDir, "sidecar/partner-game-membership-sidecar.service"), "utf8");
  const sidecarRehearsal = JSON.parse(fs.readFileSync(path.join(outDir, "sidecar/sidecar-rehearsal.json"), "utf8"));
  assert.match(settings, /uiHost: "127\.0\.0\.1"/);
  assert.match(settings, /uiPort: 18894/);
  assert.match(settings, /httpAdminRoot: false/);
  assert.match(settings, /autoInstall: false/);
  assert.match(service, /Environment=LK_PARTNER_GAME_API_ENABLED=false/);
  assert.match(service, /Environment=LK_PARTNER_GAME_API_PROVIDER_MODE=disabled/);
  assert.match(service, /IPAddressDeny=any/);
  assert.match(service, /IPAddressAllow=localhost/);
  assert.doesNotMatch(service, /EnvironmentFile=/);
  assert.doesNotMatch(`${settings}\n${service}`, /Bearer |mongodb(?:\+srv)?:\/\//i);
  assert.equal(sidecarRehearsal.networkMode, "none");
  assert.equal(sidecarRehearsal.readback.exactProductionPathLayout, true);
  assert.equal(sidecarRehearsal.readback.emptyUserDirAtStart, true);
  assert.equal(sidecarRehearsal.readback.customNodeRouteLoaded, true);
  assert.equal(sidecarRehearsal.readback.port, 18894);
  assert.equal(sidecarRehearsal.readback.partnerDefaultOffHttpStatus, 503);
  assert.equal(sidecarRehearsal.readback.adminRootHttpStatus, 404);
  assert.equal(sidecarRehearsal.artifacts.settingsSha256, digestFile(path.join(outDir, "sidecar/settings.cjs")));
  assert.equal(sidecarRehearsal.artifacts.serviceUnitSha256, digestFile(path.join(outDir, "sidecar/partner-game-membership-sidecar.service")));
  assert.equal(sidecarRehearsal.artifacts.candidateFlowSha256, digestFile(path.join(outDir, "candidate.flow.json")));
  assert.equal(sidecarRehearsal.productionTouched, false);
  assert.equal(result.contract.allowedChanges.length, 0);
  assert.deepEqual(
    result.contract.allowedAdditions.map(({ id }) => id),
    Object.values(PARTNER_API_FLOW_NODE_IDS).sort(),
  );
  const sharedLiveBytes = fs.readFileSync(fixture.sourcePath);
  const sidecar = buildPartnerGameMembershipApiSidecarCandidate();
  const liveBytes = Buffer.from(`${JSON.stringify(sidecar.sourceFlow, null, 2)}\n`, "utf8");
  assert.equal(fs.readFileSync(path.join(outDir, "source.flow.json")).equals(liveBytes), true);
  const candidateBytes = fs.readFileSync(path.join(outDir, "candidate.flow.json"));
  const liveFlow = JSON.parse(liveBytes.toString("utf8"));
  const candidateFlow = JSON.parse(candidateBytes.toString("utf8"));
  assert.deepEqual(candidateFlow.slice(0, liveFlow.length), liveFlow);
  assert.deepEqual(
    candidateFlow.slice(liveFlow.length).map(({ id }) => id),
    Object.values(PARTNER_API_FLOW_NODE_IDS),
  );
  assert.deepEqual(validateExactGraphContract({ liveBytes, candidateBytes, contract: result.contract }), result.contract);
  assert.equal(result.plan.liveMutationAuthorized, false);
  assert.equal(result.plan.topology, "DEDICATED_LOOPBACK_SIDECAR");
  assert.equal(result.plan.sidecarPort, 18894);
  assert.deepEqual(result.plan.sidecarClosure, result.productionControls.runtime.sidecar);
  assert.equal(result.plan.sharedNodeRedFlowMutationAllowed, false);
  assert.equal(result.plan.liveReadbackSha256, sha256(sharedLiveBytes));
  assert.equal(result.plan.liveReadbackNodeCount, 2);
  assert.equal(result.plan.deploymentPerformed, false);
  assert.equal(result.plan.activationPerformed, false);
  assert.equal(result.plan.vivaContractState, "AWAITING_EXTERNAL_CONFIRMATION");
  assert.equal(result.plan.productionControlsState, "UNBOUND");
  assert.equal(result.plan.runtimeSecurityState, "SECURITY_AUDIT_PASS");
  assert.equal(result.plan.runtimeManifestSha256, result.runtimeEvidence.manifestSha256);
  assert.equal(result.plan.functionalRehearsalScope, "CUSTOM_NODE_LOAD_DEFAULT_OFF_AND_REMOVAL_COMPATIBILITY_ONLY");
  assert.equal(result.plan.productionCustodyState, "UNBOUND");
  assert.equal(result.plan.ingressState, "UNBOUND");
  assert.equal(result.plan.activationState, "BLOCKED");
  assert.equal(
    result.plan.productionControlsSha256,
    digestFile(path.join(outDir, "production-controls.contract.json")),
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outDir, "production-controls.contract.json"), "utf8")),
    result.productionControls,
  );
  const packetManifest = JSON.parse(fs.readFileSync(path.join(outDir, "packet.manifest.json"), "utf8"));
  assert.deepEqual(packetManifest, result.packetManifest);
  assert.equal(packetManifest.state, "COMPLETE_PRIVATE_PACKET");
  assert.equal(packetManifest.deployAuthorized, false);
  assert.equal(packetManifest.activationAuthorized, false);
  assert.equal(packetManifest.files.some(({ relativePath }) => relativePath === "packet.manifest.json"), false);
  for (const file of packetManifest.files) {
    assert.equal(digestFile(path.join(outDir, file.relativePath)), file.sha256);
    assert.equal((fs.statSync(path.join(outDir, file.relativePath)).mode & 0o777).toString(8).padStart(4, "0"), file.mode);
  }
  assert.equal(
    packetManifest.aggregateSha256,
    sha256(Buffer.from(JSON.stringify(packetManifest.files), "utf8")),
  );
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("Idempotency-Key")));
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("runtime audit")));
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("1880") && gate.includes("untouched")));
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("Viva access-token")));
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("strips upstream CORS")));
  assert.ok(result.plan.requiredBeforeDeploy.some((gate) => gate.includes("packet custody")));
  assert.equal(result.plan.rollback.sourceSha256, sha256(liveBytes));
  assert.equal(result.plan.rollback.exactByteRollbackRehearsed, true);
  assert.equal(result.plan.rollback.sharedNodeRedFlowMutationRequired, false);
  assert.equal(result.plan.rollback.sidecarStopAndRouteRemovalRequired, true);
  assert.equal(result.plan.rollback.nodeRedRestartRehearsed, false);
  for (const file of result.release.files) {
    const packaged = path.join(outDir, "custom-node", file.relativePath);
    const runtimePackaged = path.join(outDir, "runtime", "partner-package", file.relativePath);
    assert.equal(fs.statSync(packaged).mode & 0o777, 0o600);
    assert.equal(digestFile(packaged), file.sha256);
    assert.equal(fs.statSync(runtimePackaged).mode & 0o777, 0o600);
    assert.equal(digestFile(runtimePackaged), file.sha256);
  }
  for (const name of [
    "package.json", "package-lock.json", "dependency-tree.json", "audit-report.json",
    "functional-rehearsal.json", "runtime-manifest.json",
  ]) {
    const packaged = path.join(outDir, "runtime", name);
    assert.equal(fs.statSync(packaged).mode & 0o777, 0o600);
    assert.equal(digestFile(packaged), digestFile(new URL(`../partner_game_membership_runtime/${name}`, import.meta.url)));
  }
  assert.ok(result.release.files.some(({ relativePath }) => relativePath === "package-lock.json"));
  assert.throws(() => preparePartnerV02Packet({
    workspace: fixture.workspace,
    outDir,
    repository: { commit: "a".repeat(40), tree: "b".repeat(40), branch: "same" },
  }), /must not already exist/);
});

test("v0.2 packet is never published partially when generation fails before atomic rename", () => {
  const fixture = verifiedWorkspace();
  const outDir = path.join(fixture.root, "failed-pilot-packet");
  assert.throws(() => preparePartnerV02Packet({
    workspace: fixture.workspace,
    outDir,
    repository: { commit: "a".repeat(40), tree: "b".repeat(40), branch: "codex/partner-atomic-packet-test" },
    testHooks: {
      beforeAtomicPublish() {
        throw new Error("injected pre-publish failure");
      },
    },
  }), /injected pre-publish failure/);
  assert.equal(fs.existsSync(outDir), false);
  assert.deepEqual(
    fs.readdirSync(fixture.root).filter((name) => name.startsWith(".failed-pilot-packet.tmp-")),
    [],
  );
});

test("v0.2 deployment plan rejects production-controls byte/hash or runtime-release drift", () => {
  const productionControlsBytes = fs.readFileSync(new URL("../partner_game_membership_production_controls.json", import.meta.url));
  const productionControls = JSON.parse(productionControlsBytes.toString("utf8"));
  const base = {
    repository: { commit: "a".repeat(40), tree: "b".repeat(40), branch: "codex/partner-controls-test" },
    verified: { meta: {
      pulledAt: "2026-09-03T14:00:00.000Z",
      sourceSha256: "1".repeat(64),
      nodeCount: 4762,
    } },
    contract: {
      sourceSha256: "b".repeat(64),
      candidateSha256: "c".repeat(64),
      sourceNodeCount: 1,
      candidateNodeCount: 8,
      httpInputCount: 3,
      allowedChanges: [],
      allowedAdditions: Array.from({ length: 7 }, () => ({})),
    },
    release: { releaseSha256: productionControls.runtime.latestIsolatedRehearsal.customNodeReleaseSha256 },
    rollbackRehearsed: true,
    productionControls,
    productionControlsBytes,
    productionControlsSha256: sha256(productionControlsBytes),
    runtimeEvidence: {
      manifestSha256: productionControls.runtime.immutableClosure.runtimeManifestSha256,
      manifest: {
        closure: {
          customNodeReleaseSha256: productionControls.runtime.latestIsolatedRehearsal.customNodeReleaseSha256,
          packageLockSha256: productionControls.runtime.immutableClosure.packageLockSha256,
          dependencyTreeSha256: productionControls.runtime.immutableClosure.dependencyTreeSha256,
          auditReportSha256: productionControls.runtime.immutableClosure.auditReportSha256,
          functionalRehearsalSha256: productionControls.runtime.immutableClosure.functionalRehearsalSha256,
        },
      },
      functionalRehearsal: {
        capturedAt: productionControls.runtime.immutableClosure.functionalRehearsalCapturedAt,
        evidenceScope: productionControls.runtime.latestIsolatedRehearsal.evidenceScope,
      },
    },
  };
  assert.throws(() => buildPartnerV02DeploymentPlan({
    ...base,
    productionControlsSha256: "d".repeat(64),
  }), /exact production-controls identity/);
  assert.throws(() => buildPartnerV02DeploymentPlan({
    ...base,
    release: { releaseSha256: "e".repeat(64) },
  }), /lacks matching runtime rehearsal evidence/);
  assert.throws(() => buildPartnerV02DeploymentPlan({
    ...base,
    runtimeEvidence: { ...base.runtimeEvidence, manifestSha256: "f".repeat(64) },
  }), /runtime evidence differs/);
});
