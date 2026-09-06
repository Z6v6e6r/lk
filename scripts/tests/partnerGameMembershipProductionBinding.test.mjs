import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { PARTNER_API_FLOW_NODE_IDS } from "../patch_partner_game_membership_api_flow.mjs";
import { preparePartnerV02Packet } from "../prepare_partner_game_membership_v02_packet.mjs";
import { validatePartnerProductionBinding } from "../validate_partner_game_membership_production_binding.mjs";

const controlsBytes = fs.readFileSync(new URL("../partner_game_membership_production_controls.json", import.meta.url));
const controls = JSON.parse(controlsBytes.toString("utf8"));
const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
// Anchor the synthetic clock to the checked evidence, not a historical wall-clock date.
const capturedAt = new Date(Math.max(
  Date.parse(controls.runtime.immutableClosure.auditCapturedAt),
  Date.parse(controls.runtime.immutableClosure.functionalRehearsalCapturedAt),
) + 5 * 60_000).toISOString();
const now = Date.parse(capturedAt);
const hostIdentityBytes = Buffer.from("fixture-machine-identity\n", "utf8");
const actualHostname = "fixture-host";
const roots = [];
test.after(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function packetFixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "partner-binding-packet-"));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const workspace = path.join(root, "workspace");
  const input = path.join(workspace, "input");
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
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
    sourceSha256: digest(fs.readFileSync(sourcePath)),
    nodeCount: source.length,
  }, null, 2)}\n`, { mode: 0o600 });
  const packetRoot = path.join(root, "packet");
  preparePartnerV02Packet({
    workspace,
    outDir: packetRoot,
    repository: { commit: "1".repeat(40), tree: "2".repeat(40), branch: "codex/partner-binding-fixture" },
  });
  const manifestBytes = fs.readFileSync(path.join(packetRoot, "packet.manifest.json"));
  return { root: packetRoot, manifestBytes, manifestSha256: digest(manifestBytes) };
}

function resealPacketFile(packet, relativePath, mutate) {
  const filePath = path.join(packet.root, relativePath);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
  const manifestPath = path.join(packet.root, "packet.manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = manifest.files.find((file) => file.relativePath === relativePath);
  entry.sha256 = digest(bytes);
  entry.size = bytes.length;
  manifest.aggregateSha256 = digest(Buffer.from(JSON.stringify(manifest.files), "utf8"));
  packet.manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  packet.manifestSha256 = digest(packet.manifestBytes);
  fs.writeFileSync(manifestPath, packet.manifestBytes, { mode: 0o600 });
  fs.chmodSync(manifestPath, 0o600);
}

function validBinding(packet) {
  return {
    formatVersion: 1,
    deploymentId: "partner-game-membership-api-v02",
    environment: "PRODUCTION",
    state: "DECLARED_EVIDENCE_UNVERIFIED",
    controlsSha256: digest(controlsBytes),
    capturedAt,
    runtime: {
      verificationState: "SECURITY_AUDIT_PASS_RUNTIME_DECLARED_UNVERIFIED",
      runtimeManifestSha256: controls.runtime.immutableClosure.runtimeManifestSha256,
      packageJsonSha256: controls.runtime.immutableClosure.packageJsonSha256,
      packageLockSha256: controls.runtime.immutableClosure.packageLockSha256,
      dependencyTreeSha256: controls.runtime.immutableClosure.dependencyTreeSha256,
      auditReportSha256: controls.runtime.immutableClosure.auditReportSha256,
      functionalRehearsalSha256: controls.runtime.immutableClosure.functionalRehearsalSha256,
      functionalRehearsalCapturedAt: controls.runtime.immutableClosure.functionalRehearsalCapturedAt,
      auditCapturedAt: controls.runtime.immutableClosure.auditCapturedAt,
      platform: "linux",
      architecture: "x64",
      nodeVersion: "22.23.2",
      nodeRedVersion: "5.0.6",
      criticalAffectedPackages: 0,
      highAffectedPackages: 0,
      moderateAffectedPackages: 7,
      lowAffectedPackages: 0,
      partnerReachableHighPackages: [],
      decisionRecord: "SEC-2026-09-04-01",
      owner: "role:security-reviewer",
    },
    ingress: {
      verificationState: "DECLARED_EVIDENCE_UNVERIFIED",
      exactHost: "partner-api.example.test",
      expectedAudience: "padlhub-partner-game-production",
      configPath: "/etc/caddy/partner-api.caddy",
      configSha256: "5".repeat(64),
      owner: "role:ingress-owner",
      approvedAt: "2026-09-04T11:00:00.000Z",
      rehearsedAt: "2026-09-04T12:35:00.000Z",
      readbackSha256: "6".repeat(64),
      minimumTlsVersion: "TLSv1.2",
      clientIdentity: "MTLS",
      clientCertificateSpkiSha256: "7".repeat(64),
      clientCaBundleSha256: "8".repeat(64),
      allowedSourceCidrs: [],
      trustedProxyCidrs: ["127.0.0.1/32", "::1/128"],
      trustedProxyHopCount: 1,
      socketPeerCidrs: ["127.0.0.1/32", "::1/128"],
      stripInboundForwardedHeaders: true,
      overwriteForwardedHeadersFromSocketPeer: true,
      negativeReadback: {
        wrongHostRejected: true,
        wrongSniRejected: true,
        sharedHostRoutes404: true,
        directNodeRedConnectionRefused: true,
        editorAdminUnavailable: true,
        optionsRejected: true,
        queryRejected: true,
        upstreamCorsHidden: true,
      },
    },
    custody: {
      packetManifestSha256: packet.manifestSha256,
      allowedPacketRecipients: ["role:release-owner"],
      transferChannel: "SSH_HOST_KEY_PINNED",
      targetHostAlias: "lk-primary-147",
      targetHostname: actualHostname,
      targetHostIdentitySha256: digest(hostIdentityBytes),
      targetDirectory: packet.root,
      directoryMode: "0700",
      fileMode: "0600",
      retentionUntil: new Date(now + 7 * 24 * 60 * 60_000).toISOString(),
      custodyOwner: "role:release-owner",
      deletionOwner: "role:release-owner",
      incidentOwner: "role:security-owner",
      symlinksAllowed: false,
    },
    identitySeparation: {
      testAudience: "padlhub-partner-game-test",
      productionAudience: "padlhub-partner-game-production",
      testClientIdSha256: "a".repeat(64),
      productionClientIdSha256: "b".repeat(64),
      testHmacKeyFingerprintSha256: "c".repeat(64),
      productionHmacKeyFingerprintSha256: "d".repeat(64),
      testCertificateSpkiSha256: "e".repeat(64),
      productionCertificateSpkiSha256: "7".repeat(64),
    },
    activation: {
      deployAuthorized: false,
      ingressMutationAuthorized: false,
      secretProvisioningAuthorized: false,
      flowImportAuthorized: false,
      nodeRedRestartAuthorized: false,
      globalApiEnabled: false,
      vivaMutationsEnabled: false,
    },
  };
}

const validate = (binding, packet) => validatePartnerProductionBinding({
  controls,
  controlsBytes,
  binding,
  packetRoot: packet.root,
  packetManifestBytes: packet.manifestBytes,
  now,
  expectedPacketOwnerUid: typeof process.getuid === "function" ? process.getuid() : 0,
  hostIdentityBytes,
  actualHostname,
  actualPlatform: "linux",
  actualArchitecture: "x64",
  expectedApprovedCommit: "1".repeat(40),
  expectedApprovedTree: "2".repeat(40),
});

test("private production binding lints declarations while verifying exact packet and host custody", () => {
  const packet = packetFixture();
  assert.equal(validate(validBinding(packet), packet), true);
});

test("private production binding rejects any deploy-review readiness claim", () => {
  const packet = packetFixture();
  const overclaim = validBinding(packet);
  overclaim.state = "READY_FOR_DEPLOY_REVIEW";
  assert.throws(() => validate(overclaim, packet), /fail-closed declaration state/);

  const runtimeOverclaim = validBinding(packet);
  runtimeOverclaim.runtime.verificationState = "VERIFIED";
  assert.throws(() => validate(runtimeOverclaim, packet), /must remain unverified/);

  const ingressOverclaim = validBinding(packet);
  ingressOverclaim.ingress.verificationState = "VERIFIED";
  assert.throws(() => validate(ingressOverclaim, packet), /must remain unverified/);
});

test("private production binding rejects controls drift and stale audit evidence", () => {
  const packet = packetFixture();
  const wrongControls = validBinding(packet);
  wrongControls.controlsSha256 = "0".repeat(64);
  assert.throws(() => validate(wrongControls, packet), /exact production-controls bytes/);

  const stale = validBinding(packet);
  stale.runtime.auditCapturedAt = new Date(now - 25 * 60 * 60_000).toISOString();
  assert.throws(() => validate(stale, packet), /audit is stale/);

  const closureDrift = validBinding(packet);
  closureDrift.runtime.packageLockSha256 = "0".repeat(64);
  assert.throws(() => validate(closureDrift, packet), /runtime audit policy/);

  const architectureDrift = validBinding(packet);
  architectureDrift.runtime.architecture = "arm64";
  assert.throws(() => validate(architectureDrift, packet), /runtime audit policy/);

  const futureRehearsal = validBinding(packet);
  futureRehearsal.runtime.functionalRehearsalCapturedAt = new Date(now + 5 * 60_000).toISOString();
  assert.throws(() => validate(futureRehearsal, packet), /functional rehearsal is newer/);
});

test("private production binding rejects ingress bypass, spoofable source identity, and incomplete negative readback", () => {
  const packet = packetFixture();
  for (const mutate of [
    (binding) => { binding.ingress.clientIdentity = "CIDR"; },
    (binding) => { binding.ingress.trustedProxyCidrs = []; },
    (binding) => { binding.ingress.socketPeerCidrs = []; },
    (binding) => { binding.ingress.trustedProxyCidrs = ["0.0.0.0/0"]; },
    (binding) => { binding.ingress.socketPeerCidrs = ["127.0.0.1/0"]; },
    (binding) => { binding.ingress.allowedSourceCidrs = ["0.0.0.0/0"]; },
    (binding) => { binding.ingress.stripInboundForwardedHeaders = false; },
    (binding) => { binding.ingress.negativeReadback.sharedHostRoutes404 = false; },
    (binding) => { binding.ingress.negativeReadback.directNodeRedConnectionRefused = false; },
  ]) {
    const binding = validBinding(packet);
    mutate(binding);
    assert.throws(() => validate(binding, packet));
  }
});

test("private production binding rejects reused test identities, secrets, and activation authorization", () => {
  const packet = packetFixture();
  const reused = validBinding(packet);
  reused.identitySeparation.productionHmacKeyFingerprintSha256 = reused.identitySeparation.testHmacKeyFingerprintSha256;
  assert.throws(() => validate(reused, packet), /cryptographically distinct/);

  const audienceReuse = validBinding(packet);
  audienceReuse.identitySeparation.testAudience = audienceReuse.identitySeparation.productionAudience;
  assert.throws(() => validate(audienceReuse, packet), /audiences must be explicit/);

  const certificateMismatch = validBinding(packet);
  certificateMismatch.identitySeparation.productionCertificateSpkiSha256 = "f".repeat(64);
  assert.throws(() => validate(certificateMismatch, packet), /must match the exact ingress/);

  const secret = validBinding(packet);
  secret.runtime.decisionRecord = "Bearer exposed-token";
  assert.throws(() => validate(secret, packet), /identifier|credential-shaped/);

  const activated = validBinding(packet);
  activated.activation.deployAuthorized = true;
  assert.throws(() => validate(activated, packet), /cannot authorize/);
});

test("private production binding verifies exact packet manifest bytes, aggregate, files, and modes", () => {
  const packet = packetFixture();
  const wrongManifest = validBinding(packet);
  wrongManifest.custody.packetManifestSha256 = "9".repeat(64);
  assert.throws(() => validate(wrongManifest, packet), /exact packet manifest bytes/);

  const firstFile = JSON.parse(packet.manifestBytes.toString("utf8")).files[0].relativePath;
  fs.appendFileSync(path.join(packet.root, firstFile), "drift");
  assert.throws(() => validate(validBinding(packet), packet), /files differ/);

  const modePacket = packetFixture();
  fs.chmodSync(path.join(modePacket.root, "custom-node"), 0o755);
  assert.throws(() => validate(validBinding(modePacket), modePacket), /directory owner or mode/);
});

test("private production binding rejects packet path or host identity substitution", () => {
  const packet = packetFixture();
  const wrongPath = validBinding(packet);
  wrongPath.custody.targetDirectory = path.dirname(packet.root);
  assert.throws(() => validate(wrongPath, packet), /bound target path/);

  const wrongHost = validBinding(packet);
  wrongHost.custody.targetHostIdentitySha256 = "0".repeat(64);
  assert.throws(() => validate(wrongHost, packet), /current target host identity/);
});

test("private production binding requires an out-of-band exact approved commit and tree", () => {
  const packet = packetFixture();
  const binding = validBinding(packet);
  assert.throws(() => validatePartnerProductionBinding({
    controls,
    controlsBytes,
    binding,
    packetRoot: packet.root,
    packetManifestBytes: packet.manifestBytes,
    now,
    expectedPacketOwnerUid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostIdentityBytes,
    actualHostname,
    actualPlatform: "linux",
    actualArchitecture: "x64",
    expectedApprovedCommit: "3".repeat(40),
    expectedApprovedTree: "2".repeat(40),
  }), /identity or fail-closed state/);
  assert.throws(() => validatePartnerProductionBinding({
    controls,
    controlsBytes,
    binding,
    packetRoot: packet.root,
    packetManifestBytes: packet.manifestBytes,
    now,
    expectedPacketOwnerUid: typeof process.getuid === "function" ? process.getuid() : 0,
    hostIdentityBytes,
    actualHostname,
    actualPlatform: "linux",
    actualArchitecture: "x64",
  }), /out-of-band approved commit and tree/);
});

test("private production binding rejects a self-consistent but semantically altered packet", () => {
  const packet = packetFixture();
  resealPacketFile(packet, "deployment-plan.json", (plan) => {
    plan.deploymentPerformed = true;
  });
  assert.throws(() => validate(validBinding(packet), packet), /deployment plan differs/);
});

test("private production binding rejects a resealed sidecar service or settings mutation", () => {
  for (const relativePath of [
    "sidecar/settings.cjs",
    "sidecar/partner-game-membership-sidecar.service",
    "sidecar/guarded-sidecar-rehearsal.json",
    "sidecar/settings-runtime.cjs",
    "sidecar/settings-guarded.cjs",
    "sidecar/guarded-startup.cjs",
    "sidecar/raw-request-guard.cjs",
    "sidecar/raw-audit.cjs",
    "sidecar/guarded-runtime-policy.json",
  ]) {
    const packet = packetFixture();
    const filePath = path.join(packet.root, relativePath);
    fs.appendFileSync(filePath, "\n# drift\n");
    const manifest = JSON.parse(packet.manifestBytes.toString("utf8"));
    const entry = manifest.files.find((file) => file.relativePath === relativePath);
    const bytes = fs.readFileSync(filePath);
    entry.sha256 = digest(bytes);
    entry.size = bytes.length;
    manifest.aggregateSha256 = digest(Buffer.from(JSON.stringify(manifest.files), "utf8"));
    packet.manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    packet.manifestSha256 = digest(packet.manifestBytes);
    fs.writeFileSync(path.join(packet.root, "packet.manifest.json"), packet.manifestBytes, { mode: 0o600 });
    assert.throws(() => validate(validBinding(packet), packet), /sidecar bytes differ from the immutable production-controls closure/);
  }
});

test("private production binding rejects a self-consistent candidate outside the exact patcher allowlist", () => {
  const packet = packetFixture();
  const sourceBytes = fs.readFileSync(path.join(packet.root, "source.flow.json"));
  resealPacketFile(packet, "candidate.flow.json", (candidate) => {
    candidate.push({ id: "unauthorized-node", type: "function", z: "lk-games-tab", name: "rogue", func: "return msg;", wires: [[]] });
  });
  const candidateBytes = fs.readFileSync(path.join(packet.root, "candidate.flow.json"));
  const contract = buildExactGraphContract({
    liveBytes: sourceBytes,
    candidateBytes,
    deploymentId: controls.deploymentId,
    allowedChanges: [],
    allowedAdditionIds: [...Object.values(PARTNER_API_FLOW_NODE_IDS), "unauthorized-node"],
  });
  resealPacketFile(packet, "reviewed-flow.contract.json", (existing) => {
    Object.keys(existing).forEach((key) => delete existing[key]);
    Object.assign(existing, contract);
  });
  resealPacketFile(packet, "deployment-plan.json", (plan) => {
    plan.candidateSha256 = contract.candidateSha256;
    plan.candidateNodeCount = contract.candidateNodeCount;
    plan.addedNodeCount = contract.allowedAdditions.length;
    plan.rollback.candidateSha256 = contract.candidateSha256;
  });
  assert.throws(() => validate(validBinding(packet), packet), /sidecar bytes differ from the immutable production-controls closure/);
});
