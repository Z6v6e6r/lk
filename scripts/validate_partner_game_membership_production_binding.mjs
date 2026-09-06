#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  buildPartnerV02DeploymentPlan,
  validatePartnerSidecarArtifacts,
  SIDECAR_TEMPLATE_FILES,
} from "./prepare_partner_game_membership_v02_packet.mjs";
import { validateExactGraphContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import {
  buildPartnerGameMembershipApiCandidate,
  buildPartnerGameMembershipApiSidecarCandidate,
  PARTNER_API_FLOW_NODE_IDS,
} from "./patch_partner_game_membership_api_flow.mjs";
import { validatePartnerProductionControls } from "./validate_partner_game_membership_production_controls.mjs";
import { validatePartnerRuntimeEvidence } from "./validate_partner_game_membership_runtime.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{2,127}$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const AUDIENCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{2,127}$/;
const TRANSFER_CHANNELS = new Set(["SSH_HOST_KEY_PINNED", "SOPS_AGE", "HARDWARE_BACKED_SECRET_CHANNEL"]);
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_TEMPLATE_ROOT = path.join(SCRIPT_DIR, "partner_game_membership_sidecar");
const CUSTOM_NODE_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "partner-game-membership-core.mjs",
  "partner-game-membership-mongo.mjs",
  "partner-game-membership-viva.mjs",
  "partner-game-membership-node.cjs",
  "partner-game-membership-node.html",
]);
export const PARTNER_PACKET_FILE_PATHS = Object.freeze([
  "candidate.flow.json",
  "custom-node.release.json",
  "deployment-plan.json",
  "production-controls.contract.json",
  "reviewed-flow.contract.json",
  "source.flow.json",
  "custom-node/package.json",
  "custom-node/package-lock.json",
  "custom-node/partner-game-membership-core.mjs",
  "custom-node/partner-game-membership-mongo.mjs",
  "custom-node/partner-game-membership-node.cjs",
  "custom-node/partner-game-membership-node.html",
  "custom-node/partner-game-membership-viva.mjs",
  "runtime/audit-report.json",
  "runtime/dependency-tree.json",
  "runtime/functional-rehearsal.json",
  "runtime/package.json",
  "runtime/package-lock.json",
  "runtime/runtime-manifest.json",
  "runtime/partner-package/package.json",
  "runtime/partner-package/package-lock.json",
  "runtime/partner-package/partner-game-membership-core.mjs",
  "runtime/partner-package/partner-game-membership-mongo.mjs",
  "runtime/partner-package/partner-game-membership-node.cjs",
  "runtime/partner-package/partner-game-membership-node.html",
  "runtime/partner-package/partner-game-membership-viva.mjs",
  ...SIDECAR_TEMPLATE_FILES.map((name) => `sidecar/${name}`),
]);

const fail = (message) => { throw new Error(message); };
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort())) {
    fail(`${label} fields do not match the approved schema`);
  }
};
const requireHash = (value, label) => {
  if (!HASH_PATTERN.test(String(value || ""))) fail(`${label} must be a lowercase SHA-256 digest`);
};
const requireToken = (value, label) => {
  if (!TOKEN_PATTERN.test(String(value || ""))) fail(`${label} must be a non-secret owner or record identifier`);
};
const requireIso = (value, label) => {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function requireCidrs(values, label, { allowEmpty = false, exactHosts = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || new Set(values).size !== values.length) {
    fail(`${label} must be a unique${allowEmpty ? "" : " non-empty"} CIDR list`);
  }
  for (const value of values) {
    const [address, prefix, extra] = String(value).split("/");
    const family = net.isIP(address);
    const parsedPrefix = Number(prefix);
    const maxPrefix = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (extra !== undefined || !family || !Number.isInteger(parsedPrefix) || parsedPrefix < 0 || parsedPrefix > maxPrefix) {
      fail(`${label} contains an invalid CIDR`);
    }
    if (exactHosts && parsedPrefix !== maxPrefix) fail(`${label} must contain exact host CIDRs only`);
  }
}

function listPacketFiles(root, relativeDirectory = "", { expectedOwnerUid, directoryMode }) {
  const directory = path.join(root, relativeDirectory);
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(root, relativePath);
      if (entry.isSymbolicLink()) fail(`Packet contains a symlink: ${relativePath}`);
      if (entry.isDirectory()) {
        const directoryStat = fs.lstatSync(absolutePath);
        if (directoryStat.uid !== expectedOwnerUid
          || (directoryStat.mode & 0o777).toString(8).padStart(4, "0") !== directoryMode) {
          fail(`Packet directory owner or mode is invalid: ${relativePath}`);
        }
        return listPacketFiles(root, relativePath, { expectedOwnerUid, directoryMode });
      }
      const stat = fs.lstatSync(absolutePath);
      if (!entry.isFile() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== expectedOwnerUid) {
        fail(`Packet contains a non-private or non-regular file: ${relativePath}`);
      }
      return [{
        relativePath,
        sha256: sha256(fs.readFileSync(absolutePath)),
        size: stat.size,
        mode: (stat.mode & 0o777).toString(8).padStart(4, "0"),
      }];
    });
}

function validateExactPacket({
  packetRoot,
  packetManifestBytes,
  binding,
  controls,
  expectedPacketOwnerUid,
  expectedApprovedCommit,
  expectedApprovedTree,
}) {
  if (!path.isAbsolute(String(packetRoot || ""))) fail("Packet root must be an absolute path");
  const normalizedRoot = path.resolve(packetRoot);
  const rootStat = fs.lstatSync(normalizedRoot);
  const effectiveUid = typeof process.getuid === "function" ? process.getuid() : expectedPacketOwnerUid;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(normalizedRoot) !== normalizedRoot
    || rootStat.uid !== expectedPacketOwnerUid
    || effectiveUid !== expectedPacketOwnerUid
    || normalizedRoot !== path.normalize(binding.custody.targetDirectory)
    || (rootStat.mode & 0o777).toString(8).padStart(4, "0") !== controls.custody.directoryMode) {
    fail("Packet root must match the bound target path, current owner, and approved private mode");
  }
  if (!Buffer.isBuffer(packetManifestBytes)) fail("Packet manifest must be supplied as exact bytes");
  if (sha256(packetManifestBytes) !== binding.custody.packetManifestSha256) {
    fail("Packet custody does not reference the exact packet manifest bytes");
  }
  const manifestPath = path.join(normalizedRoot, "packet.manifest.json");
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.nlink !== 1
    || manifestStat.uid !== expectedPacketOwnerUid
    || (manifestStat.mode & 0o777).toString(8).padStart(4, "0") !== controls.custody.fileMode
    || !fs.readFileSync(manifestPath).equals(packetManifestBytes)) {
    fail("Packet manifest on disk differs from the reviewed private bytes or mode");
  }
  const manifest = JSON.parse(packetManifestBytes.toString("utf8"));
  exactKeys(manifest, [
    "formatVersion", "deploymentId", "state", "repository", "productionControlsSha256",
    "customNodeReleaseSha256", "files", "aggregateSha256", "deployAuthorized", "activationAuthorized",
  ], "Packet manifest");
  exactKeys(manifest.repository, ["commit", "tree", "branch"], "Packet repository identity");
  if (manifest.formatVersion !== 1
    || manifest.deploymentId !== controls.deploymentId
    || manifest.state !== "COMPLETE_PRIVATE_PACKET"
    || !COMMIT_PATTERN.test(String(manifest.repository.commit || ""))
    || !COMMIT_PATTERN.test(String(manifest.repository.tree || ""))
    || !TOKEN_PATTERN.test(String(manifest.repository.branch || ""))
    || manifest.repository.commit !== expectedApprovedCommit
    || manifest.repository.tree !== expectedApprovedTree
    || manifest.productionControlsSha256 !== binding.controlsSha256
    || manifest.customNodeReleaseSha256 !== controls.runtime.latestIsolatedRehearsal.customNodeReleaseSha256
    || manifest.deployAuthorized !== false
    || manifest.activationAuthorized !== false) {
    fail("Packet manifest identity or fail-closed state is invalid");
  }
  requireHash(manifest.aggregateSha256, "Packet aggregateSha256");
  if (!Array.isArray(manifest.files)) fail("Packet manifest files must be an array");
  const paths = [];
  for (const file of manifest.files) {
    exactKeys(file, ["relativePath", "sha256", "size", "mode"], "Packet file entry");
    if (typeof file.relativePath !== "string"
      || file.relativePath !== path.posix.normalize(file.relativePath)
      || path.posix.isAbsolute(file.relativePath)
      || file.relativePath.startsWith("../")
      || file.relativePath === "packet.manifest.json") {
      fail("Packet manifest contains an unsafe file path");
    }
    requireHash(file.sha256, `Packet file ${file.relativePath}`);
    if (!Number.isInteger(file.size) || file.size < 0 || file.mode !== controls.custody.fileMode) {
      fail("Packet manifest contains an invalid file size or mode");
    }
    paths.push(file.relativePath);
  }
  if (new Set(paths).size !== paths.length
    || !isDeepStrictEqual([...paths].sort(), [...PARTNER_PACKET_FILE_PATHS].sort())) {
    fail("Packet manifest file closure differs from the approved packet");
  }
  if (sha256(Buffer.from(JSON.stringify(manifest.files), "utf8")) !== manifest.aggregateSha256) {
    fail("Packet manifest aggregate hash mismatch");
  }
  const byPath = (left, right) => left.relativePath.localeCompare(right.relativePath);
  const actualFiles = listPacketFiles(normalizedRoot, "", {
    expectedOwnerUid: expectedPacketOwnerUid,
    directoryMode: controls.custody.directoryMode,
  })
    .filter(({ relativePath }) => relativePath !== "packet.manifest.json")
    .sort(byPath);
  if (!isDeepStrictEqual(actualFiles, [...manifest.files].sort(byPath))) {
    fail("Packet files differ from the exact manifest hashes, sizes, or modes");
  }

  const read = (relativePath) => fs.readFileSync(path.join(normalizedRoot, relativePath));
  const release = JSON.parse(read("custom-node.release.json").toString("utf8"));
  exactKeys(release, [
    "formatVersion", "packageName", "packageVersion", "files", "releaseSha256",
    "installPerformed", "activationPerformed",
  ], "Custom-node release manifest");
  if (release.formatVersion !== 1
    || release.packageName !== "@padlhub/node-red-partner-game-membership-api"
    || release.packageVersion !== "0.2.0"
    || release.installPerformed !== false
    || release.activationPerformed !== false
    || !Array.isArray(release.files)
    || release.files.length !== CUSTOM_NODE_FILES.length) {
    fail("Custom-node release manifest identity is invalid");
  }
  const releaseIdentity = release.files.map((file, index) => {
    exactKeys(file, ["relativePath", "sha256", "size"], "Custom-node release file");
    if (file.relativePath !== CUSTOM_NODE_FILES[index]) fail("Custom-node release file order or closure changed");
    const customBytes = read(path.posix.join("custom-node", file.relativePath));
    const runtimeBytes = read(path.posix.join("runtime/partner-package", file.relativePath));
    if (!customBytes.equals(runtimeBytes)
      || sha256(customBytes) !== file.sha256
      || customBytes.length !== file.size) {
      fail("Custom-node release bytes differ between the packet copies or manifest");
    }
    return file;
  });
  if (sha256(Buffer.from(JSON.stringify(releaseIdentity), "utf8")) !== release.releaseSha256
    || release.releaseSha256 !== manifest.customNodeReleaseSha256) {
    fail("Custom-node release aggregate differs from the packet identity");
  }

  const runtimeEvidence = validatePartnerRuntimeEvidence({
    manifestBytes: read("runtime/runtime-manifest.json"),
    packageJsonBytes: read("runtime/package.json"),
    packageLockBytes: read("runtime/package-lock.json"),
    dependencyTreeBytes: read("runtime/dependency-tree.json"),
    auditReportBytes: read("runtime/audit-report.json"),
    functionalRehearsalBytes: read("runtime/functional-rehearsal.json"),
    customReleaseSha256: release.releaseSha256,
  });
  if (runtimeEvidence.manifestSha256 !== controls.runtime.immutableClosure.runtimeManifestSha256) {
    fail("Packet runtime manifest differs from the production-controls closure");
  }

  const sourceBytes = read("source.flow.json");
  const candidateBytes = read("candidate.flow.json");
  validatePartnerSidecarArtifacts({
    artifacts: Object.fromEntries(SIDECAR_TEMPLATE_FILES.map((name) => [name, read(`sidecar/${name}`)])),
    candidateBytes,
    sidecarControls: controls.runtime.sidecar,
  });
  const sourceFlow = JSON.parse(sourceBytes.toString("utf8"));
  const expectedSidecar = buildPartnerGameMembershipApiSidecarCandidate();
  if (!isDeepStrictEqual(sourceFlow, expectedSidecar.sourceFlow)) {
    fail("Packet source is not the exact dedicated Partner sidecar preimage");
  }
  const expectedCandidate = buildPartnerGameMembershipApiCandidate(sourceFlow);
  const expectedCandidateBytes = Buffer.from(`${JSON.stringify(expectedCandidate.flow, null, 2)}\n`, "utf8");
  if (!candidateBytes.equals(expectedCandidateBytes)
    || !isDeepStrictEqual([...expectedCandidate.addedNodeIds].sort(), Object.values(PARTNER_API_FLOW_NODE_IDS).sort())) {
    fail("Packet candidate is not the exact additions-only Partner patcher output");
  }
  const contract = JSON.parse(read("reviewed-flow.contract.json").toString("utf8"));
  validateExactGraphContract({ liveBytes: sourceBytes, candidateBytes, contract });
  if (!isDeepStrictEqual(contract.allowedChanges, [])
    || !isDeepStrictEqual(contract.allowedAdditions.map(({ id }) => id).sort(), Object.values(PARTNER_API_FLOW_NODE_IDS).sort())) {
    fail("Packet flow contract permits changes outside the exact Partner node allowlist");
  }
  for (const relativePath of SIDECAR_TEMPLATE_FILES) {
    const expected = fs.readFileSync(path.join(SIDECAR_TEMPLATE_ROOT, relativePath));
    if (!read(`sidecar/${relativePath}`).equals(expected)) {
      fail(`Packet sidecar template differs from the reviewed source: ${relativePath}`);
    }
  }
  const plan = JSON.parse(read("deployment-plan.json").toString("utf8"));
  const rebuiltPlan = buildPartnerV02DeploymentPlan({
    repository: manifest.repository,
    verified: { meta: {
      pulledAt: plan.livePulledAt,
      sourceSha256: plan.liveReadbackSha256,
      nodeCount: plan.liveReadbackNodeCount,
    } },
    contract,
    release,
    rollbackRehearsed: true,
    productionControls: controls,
    productionControlsBytes: read("production-controls.contract.json"),
    productionControlsSha256: manifest.productionControlsSha256,
    runtimeEvidence,
  });
  if (!isDeepStrictEqual(plan, rebuiltPlan)) fail("Packet deployment plan differs from its exact controls, runtime, release, or flow contract");
}

export function validatePartnerProductionBinding({
  controls,
  controlsBytes,
  binding,
  packetRoot,
  packetManifestBytes,
  now = Date.now(),
  expectedPacketOwnerUid = 0,
  hostIdentityBytes,
  actualHostname = os.hostname(),
  actualPlatform = process.platform,
  actualArchitecture = process.arch,
  expectedApprovedCommit,
  expectedApprovedTree,
}) {
  validatePartnerProductionControls(controls);
  if (!COMMIT_PATTERN.test(String(expectedApprovedCommit || ""))
    || !COMMIT_PATTERN.test(String(expectedApprovedTree || ""))) {
    fail("Production binding requires out-of-band approved commit and tree identities");
  }
  if (!Buffer.isBuffer(controlsBytes)
    || sha256(controlsBytes) !== binding?.controlsSha256
    || !isDeepStrictEqual(JSON.parse(controlsBytes.toString("utf8")), controls)) {
    fail("Production binding does not reference the exact production-controls bytes");
  }
  exactKeys(binding, [
    "formatVersion", "deploymentId", "environment", "state", "controlsSha256", "capturedAt",
    "runtime", "ingress", "custody", "identitySeparation", "activation",
  ], "Partner production binding");
  if (binding.formatVersion !== 1
    || binding.deploymentId !== controls.deploymentId
    || binding.environment !== "PRODUCTION"
    || binding.state !== "DECLARED_EVIDENCE_UNVERIFIED") {
    fail("Production binding identity or fail-closed declaration state is invalid");
  }
  requireIso(binding.capturedAt, "Binding capturedAt");
  const capturedTime = Date.parse(binding.capturedAt);
  if (capturedTime > now + 5 * 60 * 1000 || now - capturedTime > 24 * 60 * 60 * 1000) {
    fail("Production binding evidence is stale or from the future");
  }

  exactKeys(binding.runtime, [
    "verificationState", "runtimeManifestSha256", "packageJsonSha256", "packageLockSha256", "dependencyTreeSha256", "auditReportSha256",
    "functionalRehearsalSha256", "functionalRehearsalCapturedAt", "auditCapturedAt",
    "platform", "architecture", "nodeVersion", "nodeRedVersion", "criticalAffectedPackages",
    "highAffectedPackages", "moderateAffectedPackages", "lowAffectedPackages",
    "partnerReachableHighPackages", "decisionRecord", "owner",
  ], "Runtime binding");
  if (binding.runtime.verificationState !== "SECURITY_AUDIT_PASS_RUNTIME_DECLARED_UNVERIFIED") {
    fail("Runtime binding must remain unverified until the exact target runtime is independently checked");
  }
  for (const field of [
    "runtimeManifestSha256", "packageJsonSha256", "packageLockSha256", "dependencyTreeSha256",
    "auditReportSha256", "functionalRehearsalSha256",
  ]) {
    requireHash(binding.runtime[field], `Runtime ${field}`);
  }
  requireIso(binding.runtime.auditCapturedAt, "Runtime auditCapturedAt");
  requireIso(binding.runtime.functionalRehearsalCapturedAt, "Runtime functionalRehearsalCapturedAt");
  if (Date.parse(binding.runtime.auditCapturedAt) > capturedTime
    || capturedTime - Date.parse(binding.runtime.auditCapturedAt) > controls.runtime.auditPolicy.maxAgeHours * 60 * 60 * 1000) {
    fail("Runtime audit is stale or newer than the binding snapshot");
  }
  if (Date.parse(binding.runtime.functionalRehearsalCapturedAt) > capturedTime) {
    fail("Runtime functional rehearsal is newer than the binding snapshot");
  }
  const closure = controls.runtime.immutableClosure;
  const rehearsalCounts = controls.runtime.latestIsolatedRehearsal.auditAffectedPackages;
  if (binding.runtime.runtimeManifestSha256 !== closure.runtimeManifestSha256
    || binding.runtime.packageJsonSha256 !== closure.packageJsonSha256
    || binding.runtime.packageLockSha256 !== closure.packageLockSha256
    || binding.runtime.dependencyTreeSha256 !== closure.dependencyTreeSha256
    || binding.runtime.auditReportSha256 !== closure.auditReportSha256
    || binding.runtime.functionalRehearsalSha256 !== closure.functionalRehearsalSha256
    || binding.runtime.functionalRehearsalCapturedAt !== closure.functionalRehearsalCapturedAt
    || binding.runtime.auditCapturedAt !== closure.auditCapturedAt
    || binding.runtime.platform !== "linux"
    || binding.runtime.architecture !== "x64"
    || binding.runtime.platform !== actualPlatform
    || binding.runtime.architecture !== actualArchitecture
    || binding.runtime.nodeVersion !== controls.runtime.requiredNodeVersion
    || binding.runtime.nodeRedVersion !== controls.runtime.minimumRehearsedNodeRedVersion
    || binding.runtime.criticalAffectedPackages !== rehearsalCounts.critical
    || binding.runtime.highAffectedPackages !== rehearsalCounts.high
    || binding.runtime.moderateAffectedPackages !== rehearsalCounts.moderate
    || binding.runtime.lowAffectedPackages !== rehearsalCounts.low
    || ![binding.runtime.highAffectedPackages, binding.runtime.moderateAffectedPackages, binding.runtime.lowAffectedPackages]
      .every((value) => Number.isInteger(value) && value >= 0)
    || !Array.isArray(binding.runtime.partnerReachableHighPackages)
    || binding.runtime.partnerReachableHighPackages.length !== controls.runtime.auditPolicy.highReachablePackages) {
    fail("Runtime binding does not satisfy the pinned runtime audit policy");
  }
  requireToken(binding.runtime.decisionRecord, "Runtime decisionRecord");
  requireToken(binding.runtime.owner, "Runtime owner");

  exactKeys(binding.ingress, [
    "verificationState", "exactHost", "expectedAudience", "configPath", "configSha256", "owner", "approvedAt",
    "rehearsedAt", "readbackSha256", "minimumTlsVersion", "clientIdentity",
    "clientCertificateSpkiSha256", "clientCaBundleSha256", "allowedSourceCidrs",
    "trustedProxyCidrs", "trustedProxyHopCount", "socketPeerCidrs", "stripInboundForwardedHeaders",
    "overwriteForwardedHeadersFromSocketPeer", "negativeReadback",
  ], "Ingress binding");
  if (binding.ingress.verificationState !== "DECLARED_EVIDENCE_UNVERIFIED") {
    fail("Ingress binding must remain unverified until live artifacts and probes are checked");
  }
  if (!HOST_PATTERN.test(String(binding.ingress.exactHost || ""))) fail("Ingress exactHost must be an exact DNS hostname");
  if (!AUDIENCE_PATTERN.test(String(binding.ingress.expectedAudience || ""))) fail("Ingress expectedAudience is invalid");
  if (!path.isAbsolute(String(binding.ingress.configPath || "")) || binding.ingress.configPath === "/") {
    fail("Ingress configPath must be a narrow absolute path");
  }
  for (const field of ["configSha256", "readbackSha256", "clientCertificateSpkiSha256", "clientCaBundleSha256"]) {
    requireHash(binding.ingress[field], `Ingress ${field}`);
  }
  requireToken(binding.ingress.owner, "Ingress owner");
  requireIso(binding.ingress.approvedAt, "Ingress approvedAt");
  requireIso(binding.ingress.rehearsedAt, "Ingress rehearsedAt");
  if (Date.parse(binding.ingress.approvedAt) > capturedTime || Date.parse(binding.ingress.rehearsedAt) > capturedTime) {
    fail("Ingress approval or rehearsal is newer than the binding snapshot");
  }
  requireCidrs(binding.ingress.allowedSourceCidrs, "Ingress allowedSourceCidrs", { allowEmpty: true, exactHosts: true });
  requireCidrs(binding.ingress.trustedProxyCidrs, "Ingress trustedProxyCidrs");
  requireCidrs(binding.ingress.socketPeerCidrs, "Ingress socketPeerCidrs");
  if (binding.ingress.minimumTlsVersion !== controls.ingress.transport.minimumTlsVersion
    || binding.ingress.clientIdentity !== "MTLS"
    || !isDeepStrictEqual(binding.ingress.trustedProxyCidrs, ["127.0.0.1/32", "::1/128"])
    || !isDeepStrictEqual(binding.ingress.socketPeerCidrs, ["127.0.0.1/32", "::1/128"])
    || !Number.isInteger(binding.ingress.trustedProxyHopCount)
    || binding.ingress.trustedProxyHopCount < 1
    || binding.ingress.trustedProxyHopCount > 3
    || binding.ingress.stripInboundForwardedHeaders !== true
    || binding.ingress.overwriteForwardedHeadersFromSocketPeer !== true) {
    fail("Ingress transport identity or trusted-proxy policy is weakened");
  }
  exactKeys(binding.ingress.negativeReadback, [
    "wrongHostRejected", "wrongSniRejected", "sharedHostRoutes404", "directNodeRedConnectionRefused",
    "editorAdminUnavailable", "optionsRejected", "queryRejected", "upstreamCorsHidden",
  ], "Ingress negative readback");
  if (Object.values(binding.ingress.negativeReadback).some((value) => value !== true)) {
    fail("Ingress negative readback matrix is incomplete");
  }

  exactKeys(binding.custody, [
    "packetManifestSha256", "allowedPacketRecipients", "transferChannel", "targetHostAlias",
    "targetHostname", "targetHostIdentitySha256", "targetDirectory", "directoryMode", "fileMode", "retentionUntil", "custodyOwner",
    "deletionOwner", "incidentOwner", "symlinksAllowed",
  ], "Packet custody binding");
  requireHash(binding.custody.packetManifestSha256, "Custody packetManifestSha256");
  if (!Array.isArray(binding.custody.allowedPacketRecipients)
    || binding.custody.allowedPacketRecipients.length === 0
    || new Set(binding.custody.allowedPacketRecipients).size !== binding.custody.allowedPacketRecipients.length) {
    fail("Packet custody requires unique named recipients");
  }
  binding.custody.allowedPacketRecipients.forEach((value) => requireToken(value, "Packet recipient"));
  if (!TRANSFER_CHANNELS.has(binding.custody.transferChannel)) fail("Packet transfer channel is not approved");
  requireToken(binding.custody.targetHostAlias, "Packet targetHostAlias");
  requireToken(binding.custody.targetHostname, "Packet targetHostname");
  requireHash(binding.custody.targetHostIdentitySha256, "Packet targetHostIdentitySha256");
  let resolvedHostIdentityBytes = hostIdentityBytes;
  if (resolvedHostIdentityBytes === undefined) {
    try {
      resolvedHostIdentityBytes = fs.readFileSync("/etc/machine-id");
    } catch {
      fail("Target host machine identity is unavailable");
    }
  }
  if (!Buffer.isBuffer(resolvedHostIdentityBytes)
    || binding.custody.targetHostname !== actualHostname
    || binding.custody.targetHostIdentitySha256 !== sha256(resolvedHostIdentityBytes)) {
    fail("Packet custody does not match the current target host identity");
  }
  if (!path.isAbsolute(String(binding.custody.targetDirectory || ""))
    || ["/", "/root", "/tmp", "/private/tmp"].includes(path.normalize(binding.custody.targetDirectory))) {
    fail("Packet targetDirectory must be a narrow absolute directory");
  }
  if (binding.custody.directoryMode !== controls.custody.directoryMode
    || binding.custody.fileMode !== controls.custody.fileMode
    || binding.custody.symlinksAllowed !== false) {
    fail("Packet filesystem custody is weakened");
  }
  requireIso(binding.custody.retentionUntil, "Packet retentionUntil");
  if (Date.parse(binding.custody.retentionUntil) <= capturedTime) fail("Packet retention must expire after capture");
  for (const field of ["custodyOwner", "deletionOwner", "incidentOwner"]) {
    requireToken(binding.custody[field], `Packet ${field}`);
  }
  validateExactPacket({
    packetRoot,
    packetManifestBytes,
    binding,
    controls,
    expectedPacketOwnerUid,
    expectedApprovedCommit,
    expectedApprovedTree,
  });

  exactKeys(binding.identitySeparation, [
    "testAudience", "productionAudience", "testClientIdSha256", "productionClientIdSha256",
    "testHmacKeyFingerprintSha256", "productionHmacKeyFingerprintSha256",
    "testCertificateSpkiSha256", "productionCertificateSpkiSha256",
  ], "Identity separation");
  if (!AUDIENCE_PATTERN.test(binding.identitySeparation.testAudience)
    || !AUDIENCE_PATTERN.test(binding.identitySeparation.productionAudience)
    || binding.identitySeparation.productionAudience !== binding.ingress.expectedAudience
    || binding.identitySeparation.productionAudience === binding.identitySeparation.testAudience) {
    fail("Test and production audiences must be explicit, distinct, and bound to ingress");
  }
  for (const field of [
    "testClientIdSha256", "productionClientIdSha256", "testHmacKeyFingerprintSha256",
    "productionHmacKeyFingerprintSha256", "testCertificateSpkiSha256", "productionCertificateSpkiSha256",
  ]) requireHash(binding.identitySeparation[field], `Identity ${field}`);
  for (const [testField, productionField] of [
    ["testClientIdSha256", "productionClientIdSha256"],
    ["testHmacKeyFingerprintSha256", "productionHmacKeyFingerprintSha256"],
    ["testCertificateSpkiSha256", "productionCertificateSpkiSha256"],
  ]) {
    if (binding.identitySeparation[testField] === binding.identitySeparation[productionField]) {
      fail("Test and production identities must be cryptographically distinct");
    }
  }
  if (binding.identitySeparation.productionCertificateSpkiSha256 !== binding.ingress.clientCertificateSpkiSha256) {
    fail("Production certificate identity must match the exact ingress mTLS certificate");
  }

  exactKeys(binding.activation, [
    "deployAuthorized", "ingressMutationAuthorized", "secretProvisioningAuthorized", "flowImportAuthorized",
    "nodeRedRestartAuthorized", "globalApiEnabled", "vivaMutationsEnabled",
  ], "Binding activation boundary");
  if (Object.values(binding.activation).some((value) => value !== false)) {
    fail("Production binding cannot authorize deploy or activation");
  }

  const serialized = JSON.stringify(binding);
  if (/mongodb(?:\+srv)?:\/\/|-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|(?:password|secret|token)\s*[=:]\s*[^,}\s]+/i.test(serialized)) {
    fail("Production binding contains a credential-shaped value");
  }
  return true;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) args[argv[index]] = argv[index + 1];
  if (!args["--binding"] || !args["--packet-root"]
    || !args["--expected-approved-commit"] || !args["--expected-approved-tree"]) {
    throw new Error("Usage: --binding /absolute/private-binding.json --packet-root /absolute/private-packet --expected-approved-commit 40hex --expected-approved-tree 40hex");
  }
  if (!path.isAbsolute(args["--binding"]) || !path.isAbsolute(args["--packet-root"])) {
    throw new Error("Private binding and packet root paths must be absolute");
  }
  return args;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const controlsPath = new URL("./partner_game_membership_production_controls.json", import.meta.url);
    const controlsBytes = fs.readFileSync(controlsPath);
    const controls = JSON.parse(controlsBytes.toString("utf8"));
    const binding = JSON.parse(fs.readFileSync(args["--binding"], "utf8"));
    const packetRoot = path.resolve(args["--packet-root"]);
    const packetManifestBytes = fs.readFileSync(path.join(packetRoot, "packet.manifest.json"));
    validatePartnerProductionBinding({
      controls,
      controlsBytes,
      binding,
      packetRoot,
      packetManifestBytes,
      expectedApprovedCommit: args["--expected-approved-commit"],
      expectedApprovedTree: args["--expected-approved-tree"],
    });
    process.stdout.write("PARTNER_PRODUCTION_BINDING=DECLARED_EVIDENCE_UNVERIFIED_NOT_AUTHORIZED\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
